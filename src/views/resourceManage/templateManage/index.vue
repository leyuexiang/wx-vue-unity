<template>
  <!--
    模板页同时声明通用模板类与模型页几何类：后者只复用已验收的顶部、筛选和卡片尺寸规则，
    不复用任何模型业务状态。这样亮暗主题始终共用一套结构，模板字段仍完整隔离在本组件内。
  -->
  <div class="manage-page manage-theme manage-list-page manage-model-page manage-template-page">
    <ManagePageTopBar
      title="模板管理"
      breadcrumb="资源管理/模板管理"
      :tabs="templateTabs"
      :active-tab="activeTemplateType"
      tab-label="模板类型"
      @tab-change="selectTemplateType"
    >
      <template #actions>
        <!-- 本轮未接入新增接口和文件上传，保留设计位置但禁用，避免出现没有持久化能力的伪操作。 -->
        <el-tooltip content="新增模板功能暂未开放" placement="bottom">
          <span>
            <el-button
              class="manage-model-page__add-button"
              type="primary"
              title="新增模板功能暂未开放"
              disabled
            >
              <img
                class="manage-model-page__add-icon"
                :src="modelAddPlus"
                alt=""
                aria-hidden="true"
              />
              <span class="manage-model-page__add-label">新增模板</span>
            </el-button>
          </span>
        </el-tooltip>
      </template>

      <ManageFilterBar
        class="manage-template-page__filter-panel"
        label="模板筛选"
        actions-class="manage-model-page__filter-actions"
      >
        <div class="manage-filter-bar__field">
          <label for="manage-template-name">模板名称：</label>
          <el-input
            id="manage-template-name"
            v-model="draftFilters.search"
            placeholder="输入模板名称"
            clearable
            suffix-icon="Search"
            @keyup.enter="applyFilters"
          />
        </div>
        <div class="manage-filter-bar__field">
          <label for="manage-template-status">状态：</label>
          <el-select
            id="manage-template-status"
            v-model="draftFilters.status"
            popper-class="manage-dropdown-popper manage-select-popper"
            :options="statusOptions"
          />
        </div>
        <template #actions>
          <el-button class="manage-model-page__query-button" type="primary" @click="applyFilters">
            查询
          </el-button>
          <el-button class="manage-model-page__reset-button" @click="resetFilters">重置</el-button>
        </template>
      </ManageFilterBar>
    </ManagePageTopBar>

    <!-- Figma 中间白底容器承载分类导航、卡片滚动区和独立锚定的分页栏。 -->
    <section v-loading="listLoading" class="manage-resource-content-panel" :aria-busy="listLoading">
      <nav class="manage-model-page__categories" aria-label="模板分类">
        <button
          v-for="category in categoryNavigation"
          :key="category.value"
          class="manage-model-page__category"
          :class="{ 'is-active': selectedCategory === category.value }"
          type="button"
          :aria-pressed="selectedCategory === category.value"
          @click="selectCategory(category.value)"
        >
          {{ category.label }}
        </button>
      </nav>

      <ResourceLayout
        :list="list"
        :total="total"
        :current-page="pagination.page"
        :page-size="pagination.size"
        variant="template"
        cover-fit="cover"
        :selectable="false"
        :empty-description="listError || '没有匹配的数据'"
        @paginationChange="handlePaginationChange"
      >
        <template #media-extra="slotProps">
          <!-- 后端明确返回 ONLINE/OFFLINE 时才绘制状态角标，未知状态保持中性占位而不误导用户。 -->
          <span class="manage-model-card__status" :class="getStatusClass(slotProps.record)">
            {{ slotProps.record.statusLabel }}
          </span>
        </template>

        <template #content="slotProps">
          <div class="manage-resource-card__body">
            <!-- 名称、描述、分类和时间严格共用场景卡片的信息层级，固定高度不会随接口字段缺失改变。 -->
            <div class="manage-model-card__information">
              <div class="manage-grid-card__title text-ellipsis" :title="slotProps.record.name">
                {{ slotProps.record.name }}
              </div>
              <div
                class="manage-model-card__description text-ellipsis"
                :title="slotProps.record.description"
              >
                {{ slotProps.record.description }}
              </div>
              <div
                class="manage-model-card__meta text-ellipsis"
                :title="`${slotProps.record.category}·${formatTemplateDateTime(slotProps.record.updateTime)}`"
              >
                <span class="manage-model-card__meta-category">{{
                  slotProps.record.category
                }}</span>
                <span class="manage-model-card__meta-separator" aria-hidden="true">·</span>
                <time class="mono-text">{{
                  formatTemplateDateTime(slotProps.record.updateTime)
                }}</time>
              </div>
            </div>

            <div class="manage-model-card__footer">
              <!-- 快照模板进入独立场景创建流程；旧文件型模板继续保留禁用状态。 -->
              <el-button
                v-if="String(slotProps.record.templateSceneId ?? '').trim()"
                class="manage-model-card__edit manage-scene-card__enter"
                title="从模板创建场景"
                :loading="isOperationPending(slotProps.record.id)"
                @click.stop.prevent="createSceneFromTemplate(slotProps.record)"
              >
                创建场景
              </el-button>
              <el-tooltip v-else content="模板进入功能暂未开放" placement="top">
                <span>
                  <el-button
                    class="manage-model-card__edit manage-scene-card__enter"
                    title="模板进入功能暂未开放"
                    disabled
                  >
                    进入
                  </el-button>
                </span>
              </el-tooltip>

              <div class="manage-model-card__actions">
                <!-- 编辑必须先读取详情，避免列表记录缺少 templateFileId 时覆盖原模板文件绑定。 -->
                <el-button
                  circle
                  class="manage-model-card__more"
                  title="编辑模板"
                  aria-label="编辑模板"
                  :disabled="Boolean(slotProps.record.templateSceneId) || isOperationPending(slotProps.record.id)"
                  @click.stop.prevent="openTemplateEditDialog(slotProps.record)"
                >
                  <img
                    class="manage-scene-card__action-icon"
                    :src="manageCardActionIcons.write"
                    alt=""
                    aria-hidden="true"
                  />
                </el-button>

                <!-- 上下线有真实接口，直接放在场景同位按钮，避免把关键状态变化藏进更多菜单。 -->
                <el-button
                  circle
                  class="manage-model-card__more"
                  :loading="isOperationPending(slotProps.record.id)"
                  :title="getStatusActionTitle(slotProps.record)"
                  :aria-label="getStatusActionTitle(slotProps.record)"
                  @click.stop.prevent="toggleTemplateStatus(slotProps.record)"
                >
                  <img
                    class="manage-scene-card__action-icon"
                    :src="
                      slotProps.record.status === 'ONLINE'
                        ? manageCardActionIcons.send
                        : manageCardActionIcons.publish
                    "
                    alt=""
                    aria-hidden="true"
                  />
                </el-button>

                <el-dropdown
                  trigger="click"
                  placement="bottom-end"
                  popper-class="manage-dropdown-popper manage-card-menu-popper"
                >
                  <span class="outline-none" @click.stop>
                    <el-button
                      circle
                      icon="MoreFilled"
                      class="manage-model-card__more"
                      title="更多操作"
                      aria-label="更多操作"
                      :loading="isOperationPending(slotProps.record.id)"
                    />
                  </span>
                  <template #dropdown>
                    <el-dropdown-menu>
                      <!-- 原设计的复制接口尚未提供，禁用项保留菜单顺序并说明原因。 -->
                      <el-dropdown-item disabled title="复制接口暂未提供">复制</el-dropdown-item>
                      <el-dropdown-item
                        class="manage-card-menu-popper__danger"
                        :disabled="isOperationPending(slotProps.record.id)"
                        @click.stop="removeTemplate(slotProps.record)"
                      >
                        删除
                      </el-dropdown-item>
                    </el-dropdown-menu>
                  </template>
                </el-dropdown>
              </div>
            </div>
          </div>
        </template>
      </ResourceLayout>
    </section>

    <!--
      模板编辑弹窗独立于列表渲染。仅向其传递字典选项和当前卡片的编号、已解析封面地址，
      模板文件、资源归属等完整可保存字段由弹窗内部详情请求获得，避免列表状态被耦合污染。
    -->
    <EditDialog
      v-model:visible="templateEditVisible"
      :edit-record="templateEditRecord"
      :categories="activeCategories"
      @update-list="refreshTemplateListAfterEdit"
    />
  </div>
</template>

<script setup lang="ts">
import ResourceLayout from '../layout/index.vue'
import modelAddPlus from '@/assets/images/manage/model-add-plus.svg'
import manageCardPublishIcon from '@/assets/icons/manage-card-publish.svg'
import manageCardSendIcon from '@/assets/icons/manage-card-send.svg'
import manageCardWriteIcon from '@/assets/icons/manage-card-write.svg'
import manageCardPublishLightIcon from '@/assets/icons/manage-card-publish-light.svg'
import manageCardSendLightIcon from '@/assets/icons/manage-card-send-light.svg'
import manageCardWriteLightIcon from '@/assets/icons/manage-card-write-light.svg'
import { to, toData } from '@/utils/asyncHandler'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useRouter } from 'vue-router'
import {
  openManageDeleteConfirm,
  openManageResourceStatusConfirm,
} from '../../manageShared/confirm'
import { getDim3dOssFileById } from '@/servers/manual/dim3d/api/oss'
import {
  createDim3dTemplateCategoryLabelMap,
  getDim3dTemplateCategoryDictionary,
  getDim3dTemplateCategoryLabel,
} from '@/servers/manual/dim3d/api/dictionary'
import {
  changeDim3dTemplateStatus,
  changeDim3dSceneTemplateStatus,
  pageDim3dTemplate,
  removeDim3dTemplate,
  removeDim3dSceneTemplate,
  type Dim3dTemplatePageVo,
  type Dim3dTemplateStatus,
  type Dim3dTemplateType,
} from '@/servers/manual/dim3d/api/template'
import {
  createDim3dSceneClientKey,
  createDim3dSceneFromTemplate,
} from '@/servers/manual/dim3d/api/scene'
import ManageFilterBar from '../../manageShared/ManageFilterBar.vue'
import ManagePageTopBar from '../../manageShared/ManagePageTopBar.vue'
import { useManageTheme } from '../../manageShared/manageTheme'
import EditDialog from './EditDialog.vue'
import { DEFAULT_TEMPLATE_TYPE, TEMPLATE_TYPE_OPTIONS } from './config'
import {
  createTemplateListRequestParams,
  getTemplatePageAfterDeletion,
  isTemplateBusinessId,
  type TemplateListFilterState,
} from './templateState'

const statusOptions = [
  { label: '全部', value: 'all' },
  { label: '已上线', value: 'ONLINE' },
  { label: '已下线', value: 'OFFLINE' },
]

/** 页面缓存最多保存 200 张已解析封面，防止长时间翻页时地址映射无限增长。 */
const MAX_CACHED_COVER_URLS = 200
/** 分类数量请求分批执行，避免字典项较多时同时发起过量分页请求。 */
const CATEGORY_TOTAL_CONCURRENCY = 4

/**
 * 后端偶发缺失主键时生成稳定的仅渲染回退键。回退键永不参与删除、上下线等写操作，
 * 因此刷新前后不引入随机 DOM 键，也不会把本地索引误发给服务端。
 */
const createStableTemplateKey = (item: Dim3dTemplatePageVo, index: number) => {
  const businessKey = [
    item.templateName,
    item.templateType,
    item.category,
    item.coverImageId,
    item.updateTime,
  ]
    .map((value) => String(value ?? '').trim())
    .join('|')
  return businessKey.split('|').join('').length > 0
    ? `template-missing-${encodeURIComponent(businessKey)}`
    : `template-missing-${index}`
}

/** Figma 卡片元信息使用固定格式，避免依赖浏览器语言设置导致中英文日期样式漂移。 */
const formatTemplateDateTime = (value?: string) => {
  if (!value) return '--'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  const hours = `${date.getHours()}`.padStart(2, '0')
  const minutes = `${date.getMinutes()}`.padStart(2, '0')
  const seconds = `${date.getSeconds()}`.padStart(2, '0')
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
}

defineOptions({ name: 'TemplateManage' })

const { theme: manageTheme } = useManageTheme()
const router = useRouter()

/**
 * 模板页与场景页共用卡片操作图标：暗色主题选用已校准镂空颜色的亮色 SVG，
 * 不能使用 CSS 滤镜反色，否则下线图标的擦除线会错误显示为黑色实线。
 */
const manageCardActionIcons = computed(() =>
  manageTheme.value === 'dark'
    ? {
        write: manageCardWriteLightIcon,
        publish: manageCardPublishLightIcon,
        send: manageCardSendLightIcon,
      }
    : {
        write: manageCardWriteIcon,
        publish: manageCardPublishIcon,
        send: manageCardSendIcon,
      },
)

const activeTemplateType = ref<Dim3dTemplateType>(DEFAULT_TEMPLATE_TYPE)
/** 固定页签无需进入响应式系统，避免为不会变化的配置创建代理和更新依赖。 */
const templateTabs = TEMPLATE_TYPE_OPTIONS
const draftFilters = reactive<Omit<TemplateListFilterState, 'category' | 'templateType'>>({
  search: '',
  status: 'all',
})
const appliedFilters = reactive<Omit<TemplateListFilterState, 'category' | 'templateType'>>({
  search: '',
  status: 'all',
})
const selectedCategory = ref('')
const pagination = reactive({ page: 1, size: 10 })
const originList = ref<Dim3dTemplatePageVo[]>([])
const total = ref(0)
const allCategoryTotal = ref(0)
const listError = ref('')
const listLoading = ref(false)
/** 编辑弹窗只保存当前卡片的最小打开上下文，详情和保存状态由子组件隔离管理。 */
const templateEditVisible = ref(false)
const templateEditRecord = ref<{ id: string; imgPath?: string }>()

type TemplateCategoryOption = { value: string; label: string }

/**
 * 行业方案和展厅模板分别缓存自己的分类编码、中文名称和统计结果，避免切换页签时复用
 * 错误字典。Map 按模板类型索引，只有当前类型的数据会暴露给筛选器和卡片。
 */
const categoriesByTemplateType = ref(new Map<Dim3dTemplateType, TemplateCategoryOption[]>())
const categoryLabelsByTemplateType = ref(new Map<Dim3dTemplateType, Map<string, string>>())
const activeCategories = computed(
  () => categoriesByTemplateType.value.get(activeTemplateType.value) || [],
)
const activeCategoryLabels = computed(
  () => categoryLabelsByTemplateType.value.get(activeTemplateType.value) || EMPTY_CATEGORY_LABELS,
)
const EMPTY_CATEGORY_LABELS = new Map<string, string>()
const categoryDictionaryRequests = new Map<Dim3dTemplateType, Promise<void>>()
const categoryDictionaryRequestIds = new Map<Dim3dTemplateType, number>()
/** 分类统计与当前模板类型绑定，类型切换时整张 Map 原子替换，避免旧类型数量闪回。 */
const categoryTotals = ref(new Map<string, number>())
/** 已解析的 OSS 封面地址按编号缓存；仅在当前请求仍有效时提交到响应式状态。 */
const coverUrlByOssId = ref(new Map<string, string>())
/** 同一资源写操作执行期间锁定对应卡片，阻止双击造成重复状态切换或重复删除。 */
const pendingOperationIds = ref(new Set<string>())

const list = computed(() =>
  originList.value.map((item, index) => {
    const id =
      item.id !== undefined && item.id !== null
        ? String(item.id)
        : createStableTemplateKey(item, index)
    const coverImageId = String(item.coverImageId ?? '').trim()
    const category =
      getDim3dTemplateCategoryLabel(activeCategoryLabels.value, item.category, item.categoryName) ||
      '--'
    const statusLabel =
      item.statusName?.trim() ||
      (item.status === 'ONLINE' ? '已上线' : item.status === 'OFFLINE' ? '已下线' : '--')

    return {
      ...item,
      id,
      name: item.templateName?.trim() || '--',
      description: item.templateDesc?.trim() || '--',
      category,
      updateTime: item.updateTime || '',
      imgPath: coverImageId ? coverUrlByOssId.value.get(coverImageId) || '' : '',
      statusLabel,
    }
  }),
)

export type TemplateCardRecord = (typeof list.value)[number]

/** 模板分类标签及数量由分类字典驱动，字典失败时仅保留“全部”以确保查询仍可使用。 */
const categoryNavigation = computed(() => [
  { label: `全部（${allCategoryTotal.value}）`, value: '' },
  ...activeCategories.value.map((category) => ({
    label: `${category.label}（${categoryTotals.value.get(category.value) ?? 0}）`,
    value: category.value,
  })),
])

/** 请求序号让快速筛选、翻页或切换类型时仅最后一次响应能刷新页面。 */
const latestListRequestId = ref(0)
const inFlightListRequests = new Map<string, ReturnType<typeof createTemplateListRequest>>()
let latestCategoryTotalRequestId = 0

/** 将当前已提交筛选、分类和页签集中映射为接口参数，页面内没有其他路径可拼装查询。 */
const buildListRequestParams = () =>
  createTemplateListRequestParams({
    pageNum: pagination.page,
    pageSize: pagination.size,
    search: appliedFilters.search,
    status: appliedFilters.status,
    category: selectedCategory.value,
    templateType: activeTemplateType.value,
  })

/** 每个相同参数键只保留一条进行中的请求，结束即释放，既去重又不缓存过期列表数据。 */
const createTemplateListRequest = (params: ReturnType<typeof buildListRequestParams>) =>
  to(pageDim3dTemplate(params, { suppressNotFoundNotification: true }))

/** 从接口错误中提取面向用户的准确提示，业务 401/403 不会再显示为普通空态。 */
const getTemplateListErrorMessage = (error: Error) => {
  const status = Number(
    (error as Error & { code?: number; status?: number }).status ||
      (error as Error & { code?: number }).code,
  )
  if (status === 401) return '当前登录已过期，请重新登录'
  if (status === 403) return '模板列表接口禁止访问，请联系管理员'
  return error.message || '模板列表加载失败，请稍后重试'
}

/**
 * 获取当前页模板。网络乱序、重复请求和鉴权失败均在此处收敛，卡片层只消费已确认的标准数据。
 */
const getList = async () => {
  const requestId = ++latestListRequestId.value
  const params = buildListRequestParams()
  const requestKey = JSON.stringify(params)
  let request = inFlightListRequests.get(requestKey)

  if (!request) {
    request = createTemplateListRequest(params)
    inFlightListRequests.set(requestKey, request)
    void request.finally(() => {
      if (inFlightListRequests.get(requestKey) === request) inFlightListRequests.delete(requestKey)
    })
  }

  listLoading.value = true
  const [error, response] = await request
  if (requestId !== latestListRequestId.value) return
  listLoading.value = false

  if (error) {
    total.value = 0
    originList.value = []
    listError.value = getTemplateListErrorMessage(error)
    ElMessage.error(listError.value)
    return
  }

  listError.value = ''
  total.value = Number(response?.total) || 0
  // 仅无名称、状态、分类条件的响应表示当前类型的“全部”数量，不能被局部筛选结果覆盖。
  if (!params.templateName && !params.status && !params.category) {
    allCategoryTotal.value = total.value
  }
  originList.value = response?.rows || []
  void resolveCoverUrls(originList.value, requestId)
}

/**
 * 封面地址按当前页唯一 OSS 编号查询。单项失败返回空结果，不中断其他封面或模板卡片首屏显示；
 * 写入 Map 时实施上限淘汰，避免用户长期翻页造成内存持续累积。
 */
const resolveCoverUrls = async (rows: Dim3dTemplatePageVo[], requestId: number) => {
  const ids = [
    ...new Set(
      rows
        .map((row) => String(row.coverImageId ?? '').trim())
        .filter((id) => id && !coverUrlByOssId.value.has(id)),
    ),
  ]
  if (!ids.length) return

  const results = await Promise.all(
    ids.map(async (id) => {
      const [error, files] = await toData(
        getDim3dOssFileById(id, { suppressNotFoundNotification: true }),
      )
      if (error || !files?.length) return null
      const file = files.find((item) => String(item.ossId ?? '') === id)
      return file?.url ? { id, url: file.url } : null
    }),
  )
  if (requestId !== latestListRequestId.value) return

  const next = new Map(coverUrlByOssId.value)
  results.forEach((result) => {
    if (!result) return
    next.delete(result.id)
    next.set(result.id, result.url)
  })
  while (next.size > MAX_CACHED_COVER_URLS) {
    const oldestId = next.keys().next().value
    if (!oldestId) break
    next.delete(oldestId)
  }
  coverUrlByOssId.value = next
}

/**
 * 分类总数使用最小 pageSize=1 的真实分页请求。请求按固定并发度分批，避免分类字典扩容后
 * 一次性创建大量连接；只接收当前类型最新一轮的结果，慢请求不会覆盖后续页签数量。
 */
const loadCategoryTotals = async () => {
  const requestId = ++latestCategoryTotalRequestId
  const templateType = activeTemplateType.value
  const entries: Array<readonly [string, number]> = []
  const categories = activeCategories.value

  for (let start = 0; start < categories.length; start += CATEGORY_TOTAL_CONCURRENCY) {
    const currentBatch = categories.slice(start, start + CATEGORY_TOTAL_CONCURRENCY)
    const batchEntries = await Promise.all(
      currentBatch.map(async (category) => {
        const [error, response] = await to(
          pageDim3dTemplate(
            { templateType, category: category.value, pageNum: 1, pageSize: 1, includeSnapshots: true },
            { suppressNotFoundNotification: true },
          ),
        )
        return [category.value, error ? 0 : Number(response?.total) || 0] as const
      }),
    )
    entries.push(...batchEntries)
  }

  if (requestId !== latestCategoryTotalRequestId || templateType !== activeTemplateType.value)
    return
  categoryTotals.value = new Map(entries)
}

/**
 * 按当前模板类型读取专属分类字典，并按类型缓存；类型切换时只更新当前类型数据，避免
 * 行业方案分类残留到展厅模板查询和编辑弹窗。
 */
const getCategories = async (templateType: Dim3dTemplateType = activeTemplateType.value) => {
  const cachedCategories = categoriesByTemplateType.value.get(templateType)
  if (cachedCategories) {
    if (templateType === activeTemplateType.value) void loadCategoryTotals()
    return
  }

  let request = categoryDictionaryRequests.get(templateType)
  if (!request) {
    const requestId = (categoryDictionaryRequestIds.get(templateType) || 0) + 1
    categoryDictionaryRequestIds.set(templateType, requestId)
    request = (async () => {
      const [categoryError, categoryData] = await toData(
        getDim3dTemplateCategoryDictionary(templateType, {
          suppressNotFoundNotification: true,
        }),
      )
      if (categoryDictionaryRequestIds.get(templateType) !== requestId) return

      if (!categoryError && Array.isArray(categoryData)) {
        const categories = categoryData
          .map((item) => ({
            value: String(item.dictValue ?? '').trim(),
            label: String(item.dictLabel ?? '').trim(),
          }))
          .filter((item) => item.value && item.label)
        categoriesByTemplateType.value = new Map(categoriesByTemplateType.value).set(
          templateType,
          categories,
        )
        categoryLabelsByTemplateType.value = new Map(categoryLabelsByTemplateType.value).set(
          templateType,
          createDim3dTemplateCategoryLabelMap(categoryData),
        )
      } else {
        categoriesByTemplateType.value = new Map(categoriesByTemplateType.value).set(
          templateType,
          [],
        )
        categoryLabelsByTemplateType.value = new Map(categoryLabelsByTemplateType.value).set(
          templateType,
          new Map(),
        )
      }
    })()
    categoryDictionaryRequests.set(templateType, request)
    void request
      .then(
        () => undefined,
        () => undefined,
      )
      .then(() => {
        if (categoryDictionaryRequests.get(templateType) === request) {
          categoryDictionaryRequests.delete(templateType)
        }
      })
  }

  await request
  if (templateType === activeTemplateType.value) void loadCategoryTotals()
}

/** 首载时分类字典与列表互不依赖，允许并行；分类数量异步补齐，不阻塞首屏卡片。 */
onBeforeMount(() => {
  void Promise.all([getCategories(), getList()])
})

/** 切换类型后重置分类和页码，且只发起一轮列表及一轮当前类型分类统计。 */
const selectTemplateType = (value: string) => {
  if (
    !TEMPLATE_TYPE_OPTIONS.some((type) => type.value === value) ||
    activeTemplateType.value === value
  )
    return
  activeTemplateType.value = value as Dim3dTemplateType
  selectedCategory.value = ''
  categoryTotals.value = new Map()
  allCategoryTotal.value = 0
  pagination.page = 1
  void getCategories(activeTemplateType.value)
  void getList()
}

/** 分类导航属于即时筛选入口，点击后立即提交真实 dictValue；重复点击不产生网络请求。 */
const selectCategory = (value: string) => {
  if (selectedCategory.value === value) return
  selectedCategory.value = value
  pagination.page = 1
  void getList()
}

/** 查询仅提交顶部草稿筛选，避免用户每次输入都创建列表请求。 */
const applyFilters = () => {
  appliedFilters.search = draftFilters.search.trim()
  appliedFilters.status = draftFilters.status
  pagination.page = 1
  void getList()
}

/** 重置回默认行业方案、全部分类和全部状态，并同步刷新该类型的分类总数。 */
const resetFilters = () => {
  activeTemplateType.value = DEFAULT_TEMPLATE_TYPE
  draftFilters.search = ''
  draftFilters.status = 'all'
  appliedFilters.search = ''
  appliedFilters.status = 'all'
  selectedCategory.value = ''
  categoryTotals.value = new Map()
  allCategoryTotal.value = 0
  pagination.page = 1
  void getCategories(activeTemplateType.value)
  void getList()
}

/** 共享分页栏采用受控值；同值事件直接忽略，保证每次翻页只触发一条列表请求。 */
const handlePaginationChange = (value: { page: number; size: number }) => {
  if (pagination.page === value.page && pagination.size === value.size) return
  pagination.page = value.page
  pagination.size = value.size
  void getList()
}

/** 状态样式只接受明确枚举或后端同义中文，未知状态使用中性样式，不误标为已上线。 */
const getStatusClass = (record: TemplateCardRecord) => {
  if (record.status === 'ONLINE' || /上线|online/i.test(record.statusLabel)) return 'is-online'
  if (record.status === 'OFFLINE' || /下线|offline/i.test(record.statusLabel)) return 'is-offline'
  return 'is-pending'
}

/** 状态图标的可访问文案与二次确认保持同一反向动作，状态缺失时明确提示而不是猜测。 */
const getStatusActionTitle = (record: TemplateCardRecord) => {
  if (record.status === 'ONLINE') return '下线模板'
  if (record.status === 'OFFLINE') return '上线模板'
  return '当前模板状态未知'
}

const isOperationPending = (id: string) => pendingOperationIds.value.has(id)

/** 从在线快照模板创建独立场景，创建成功后回到场景管理页读取新实例。 */
const createSceneFromTemplate = async (record: TemplateCardRecord) => {
  const templateSceneId = String(record.templateSceneId ?? '').trim()
  if (!templateSceneId || isOperationPending(record.id)) {
    ElMessage.warning('当前模板缺少有效场景编号或操作正在进行，请稍后重试')
    return
  }

  let name = ''
  try {
    const result = await ElMessageBox.prompt('请输入新场景名称', '从模板创建场景', {
      inputValue: `${record.name}实例`,
      inputPlaceholder: '场景名称',
      inputValidator: (value) => (value.trim() ? true : '场景名称不能为空'),
      confirmButtonText: '创建',
      cancelButtonText: '取消',
    })
    name = result.value.trim()
  } catch {
    return
  }

  setOperationPending(record.id, true)
  try {
    const response = await createDim3dSceneFromTemplate({
      templateSceneId,
      requestId: `tpl6-${createDim3dSceneClientKey()}`,
      name,
      sceneDesc: record.description === '--' ? undefined : record.description,
    })
    const sceneId = String(response.data?.sceneId ?? '').trim()
    if (!sceneId) throw new Error(response.msg || '接口未返回新场景编号')
    ElMessage.success('场景创建成功')
    await router.push({ name: 'sceneManage' })
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '从模板创建场景失败，请稍后重试')
  } finally {
    setOperationPending(record.id, false)
  }
}

/**
 * 编辑入口只接受真实业务编号；列表缺主键时生成的渲染回退键绝不能用于详情或编辑请求。
 * 已解析的封面地址一并传入，弹窗会优先复用，避免重复请求同一 OSS 资源。
 */
const openTemplateEditDialog = (record: TemplateCardRecord) => {
  if (String(record.templateSceneId ?? '').trim()) {
    ElMessage.info('场景快照模板暂不支持编辑模板文件字段')
    return
  }
  if (!isTemplateBusinessId(record.id)) {
    ElMessage.warning('当前模板缺少有效编号，无法编辑')
    return
  }
  templateEditRecord.value = { id: record.id, imgPath: record.imgPath }
  templateEditVisible.value = true
}

/** 编辑成功后保持现有筛选与页码，仅精确刷新当前列表页，不重新请求无关字典或分类统计。 */
const refreshTemplateListAfterEdit = () => {
  void getList()
}

/**
 * 单项写操作共享锁定集合。复制 Set 后再赋值触发 Vue 更新，同时不原地修改响应式集合，
 * 让按钮 loading、下拉禁用和异步请求的状态保持一致。
 */
const setOperationPending = (id: string, pending: boolean) => {
  const next = new Set(pendingOperationIds.value)
  if (pending) next.add(id)
  else next.delete(id)
  pendingOperationIds.value = next
}

/** 上下线必须先确认、再调用真实状态接口，未知编号或状态均不会发出请求。 */
const toggleTemplateStatus = async (record: TemplateCardRecord) => {
  if (!isTemplateBusinessId(record.id) || isOperationPending(record.id)) {
    ElMessage.warning('当前模板缺少有效编号或操作正在进行，请稍后重试')
    return
  }
  const targetStatus: Dim3dTemplateStatus | undefined =
    record.status === 'ONLINE' ? 'OFFLINE' : record.status === 'OFFLINE' ? 'ONLINE' : undefined
  if (!targetStatus) {
    ElMessage.warning('当前模板状态未知，暂不能切换上下线')
    return
  }

  try {
    await openManageResourceStatusConfirm(targetStatus, '模板', record.name)
  } catch {
    return
  }

  setOperationPending(record.id, true)
  const [error] = await to(
    String(record.templateSceneId ?? '').trim()
      ? changeDim3dSceneTemplateStatus(targetStatus, record.id)
      : changeDim3dTemplateStatus(targetStatus, record.id),
  )
  setOperationPending(record.id, false)
  if (error) {
    ElMessage.error(`${targetStatus === 'ONLINE' ? '上线' : '下线'}模板失败，请稍后重试`)
    return
  }
  await getList()
}

/** 删除使用共享二次确认；当前页最后一项成功删除后自动回退，避免保留一张空白末页。 */
const removeTemplate = async (record: TemplateCardRecord) => {
  if (!isTemplateBusinessId(record.id) || isOperationPending(record.id)) {
    ElMessage.warning('当前模板缺少有效编号或操作正在进行，请稍后重试')
    return
  }

  try {
    await openManageDeleteConfirm('模板', record.name)
  } catch {
    return
  }

  setOperationPending(record.id, true)
  const [error] = await to(
    String(record.templateSceneId ?? '').trim()
      ? removeDim3dSceneTemplate(record.id)
      : removeDim3dTemplate(record.id),
  )
  setOperationPending(record.id, false)
  if (error) {
    ElMessage.error('模板删除失败，请稍后重试')
    return
  }

  pagination.page = getTemplatePageAfterDeletion(pagination.page, list.value.length)
  await getList()
}
</script>
