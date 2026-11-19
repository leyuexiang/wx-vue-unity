<template>
  <div class="manage-page manage-theme manage-list-page manage-model-page">
    <ManagePageTopBar
      title="模型管理"
      breadcrumb="资源管理/模型管理"
      :tabs="resourceTabs"
      :active-tab="activeTab"
      tab-label="模型资源范围"
      @tab-change="selectResourceTab"
    >
      <!-- 新增操作由模型页持有，避免共享顶部栏持有弹窗或其他资源页面的业务状态。 -->
      <template #actions>
        <el-button
          class="manage-model-page__add-button"
          type="primary"
          title="新增模型"
          @click="openAddDialog"
        >
          <!-- Figma 节点 2155:17915 的 16px 加号已本地化，避免生产环境依赖临时设计资源地址。 -->
          <img class="manage-model-page__add-icon" :src="modelAddPlus" alt="" aria-hidden="true" />
          <span class="manage-model-page__add-label">新增模型</span>
        </el-button>
      </template>

      <ManageFilterBar
        class="manage-model-page__filter-panel"
        label="模型筛选"
        actions-class="manage-model-page__filter-actions"
      >
        <div
          class="manage-filter-bar__field manage-model-page__filter-field manage-model-page__filter-field--name"
        >
          <!-- Figma 使用 12px/22px 标签行；字段语义仍按真实接口保留为模型名称。 -->
          <label for="manage-model-name">模型名称：</label>
          <el-input
            id="manage-model-name"
            v-model="draftFilters.search"
            placeholder="输入模型名称"
            clearable
            suffix-icon="Search"
          />
        </div>
        <div class="manage-filter-bar__field manage-model-page__filter-field">
          <!-- 状态值直接映射阶段三接口的 ONLINE/OFFLINE 枚举，全部项转换为缺省参数。 -->
          <label for="manage-model-status">状态：</label>
          <el-select
            id="manage-model-status"
            v-model="draftFilters.status"
            popper-class="manage-dropdown-popper manage-select-popper"
            :options="statusOptions"
          />
        </div>
        <div class="manage-filter-bar__field manage-model-page__filter-field">
          <!-- 付费值直接映射阶段三接口的 PAID/FREE 枚举，全部项转换为缺省参数。 -->
          <label for="manage-model-paid">是否付费：</label>
          <el-select
            id="manage-model-paid"
            v-model="draftFilters.paid"
            popper-class="manage-dropdown-popper manage-select-popper"
            :options="paidOptions"
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

    <!-- Figma 节点 2143:10396 的白底容器统一包裹分类栏和卡片网格，模型页与其他管理子页共用。 -->
    <section class="manage-resource-content-panel">
      <nav class="manage-model-page__categories" aria-label="模型分类">
        <button
          v-for="category in categoryNavigation"
          :key="category.value"
          class="manage-model-page__category"
          :class="{ 'is-active': draftFilters.category === category.value }"
          type="button"
          :aria-pressed="draftFilters.category === category.value"
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
      variant="model"
      cover-fit="contain"
      media-padding="12px"
      media-interactive
      :selectable="false"
      :empty-description="listError || '没有匹配的数据'"
      @paginationChange="handlePaginationChange"
      @mediaClick="handleMediaPreview"
    >
      <template #media-extra="slotProps">
        <!-- 阶段三分页响应提供 statusName；缺失时由适配层显示占位符，不伪造业务状态。 -->
        <span
          class="manage-model-card__status"
          :class="getStatusClass(slotProps.record)"
        >
          {{ slotProps.record.statusLabel }}
        </span>
      </template>

      <template #content="slotProps">
        <div class="manage-resource-card__body">
          <!--
            信息层级对应 Figma 亮色 2143:10417 与暗色 2155:17997：名称、描述、
            分类与更新时间、价格/付费、编辑和更多操作。缺失字段均来自展示适配层的统一占位值。
          -->
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
              :title="`${slotProps.record.category}·${formatResourceDateTime(slotProps.record.updateTime)}`"
            >
              <span class="manage-model-card__meta-category">{{ slotProps.record.category }}</span>
              <span class="manage-model-card__meta-separator" aria-hidden="true">·</span>
              <time class="mono-text">{{
                formatResourceDateTime(slotProps.record.updateTime)
              }}</time>
            </div>
          </div>

          <div class="manage-model-card__footer">
            <span
              class="manage-model-card__payment"
              :class="`manage-model-card__payment--${slotProps.record.paymentTone}`"
            >
              {{ slotProps.record.paymentLabel }}
            </span>

            <div class="manage-model-card__actions">
              <el-button
                v-if="getCardCapabilities(slotProps.record).canEdit"
                class="manage-model-card__edit"
                @click.stop.prevent="handleOperate(OperateEnum.Edit, slotProps.record)"
              >
                编辑
              </el-button>
              <!--
                菜单使用点击触发，避免指针从固定卡片移向浮层时意外关闭；浮层传送到页面根部，
                不受卡片和网格滚动容器的 overflow 裁切。
              -->
              <el-dropdown
                trigger="click"
                placement="bottom-end"
                :popper-class="getCardMenuPopperClass(slotProps.record)"
                :disabled="!getCardCapabilities(slotProps.record).canOpenMore"
              >
                <span class="outline-none" @click.stop>
                  <el-button
                    circle
                    icon="MoreFilled"
                    class="manage-model-card__more"
                    title="更多操作"
                    aria-label="更多操作"
                    :disabled="!getCardCapabilities(slotProps.record).canOpenMore"
                  />
                </span>
                <template v-if="getCardCapabilities(slotProps.record).canOpenMore" #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item
                      v-if="getCardCapabilities(slotProps.record).canToggleStatus"
                      @click.stop="handleOperate(OperateEnum.ToggleStatus, slotProps.record)"
                    >
                      {{ getStatusActionLabel(slotProps.record) }}
                    </el-dropdown-item>
                    <el-dropdown-item
                      class="manage-card-menu-popper__danger"
                      @click.stop="handleOperate(OperateEnum.Delete, slotProps.record)"
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

    <AddDialog
      v-model:visible="addDialogVisible"
      :originCategories="originCategories"
      :categories="categories"
      :editRecord="editRecord"
      @updateList="getList"
    />

    <PreviewDialog
      v-model:visible="previewDialogVisible"
      class="manage-dialog"
      :path="previewPath"
      :resource-id="previewManagedResourceId"
      :source-error="previewError"
      :record="previewRecord"
      :can-edit="previewRecord ? getCardCapabilities(previewRecord).canEdit : false"
      @update:visible="previewDialogVisible = $event"
      @retry="retryModelPreview"
      @edit="handlePreviewEdit"
    />
  </div>
</template>

<script setup lang="ts">
import ResourceLayout from '../layout/index.vue'
import { to, toData } from '@/utils/asyncHandler'
import { concatMinioUrl } from '@/utils/utils'
import { ElMessage } from 'element-plus'
import AddDialog from './AddDialog.vue'
import modelAddPlus from '@/assets/images/manage/model-add-plus.svg'
import PreviewDialog from './preview/PreviewDialog.vue'
import { openManageDeleteConfirm, openManageModelStatusConfirm } from '../../manageShared/confirm'
import ManageFilterBar from '../../manageShared/ManageFilterBar.vue'
import ManagePageTopBar from '../../manageShared/ManagePageTopBar.vue'
import {
  getDim3dModelInfo,
  pageDim3dModel,
  removeDim3dModel,
  changeDim3dModelStatus,
  type Dim3dModelPageParams,
  type Dim3dModelPageVo,
} from '@/servers/manual/dim3d/api/model'
import { getDim3dOssFileById } from '@/servers/manual/dim3d/api/oss'
import {
  getDim3dModelFileAccess,
} from '@/servers/manual/dim3d/api/resource'
import {
  createDim3dModelCategoryLabelMap,
  getDim3dModelCategoryDictionary,
  getDim3dModelCategoryLabel,
} from '@/servers/manual/dim3d/api/dictionary'
import {
  createResourceCategoryTotalRequestParams,
  RESOURCE_SCOPE_TABS,
  toDim3dResourceBelong,
  type ResourceScopeValue,
} from '../resourceScope'
import {
  canUseResourceCardAction,
  getCurrentManagementCapabilities,
  resolveResourceCardCapabilities,
} from '@/auth/capabilities'

enum OperateEnum {
  Preview = 'Preview',
  ToggleStatus = 'ToggleStatus',
  Edit = 'Edit',
  Delete = 'Delete',
}

/** Figma 筛选下拉的展示选项，值直接对应新模型分页接口的枚举。 */
const statusOptions = [
  { label: '全部', value: 'all' },
  { label: '上线', value: 'ONLINE' },
  { label: '下线', value: 'OFFLINE' },
]
const paidOptions = [
  { label: '全部', value: 'all' },
  { label: '付费', value: 'PAID' },
  { label: '免费', value: 'FREE' },
]

/**
 * 新模型分页接口允许这些字段缺失；统一占位只用于展示，不回写接口对象，也不参与查询参数。
 */
const MODEL_CARD_FIELD_PLACEHOLDER = '--'

/**
 * 接口正常返回数字编号；异常缺失时用业务字段生成确定性键，仅用于卡片渲染和选择态。
 * 该键不冒充后端编号，所有需要调用接口的动作仍会通过 resourceId 做数值校验。
 */
const createStableResourceKey = (item: Dim3dModelPageVo, index: number) => {
  const businessParts = [item.id, item.modelName, item.category, item.updateTime].map((value) =>
    String(value ?? '').trim(),
  )
  const businessKey = businessParts.join('|')
  if (businessKey.split('|').join('').length > 0) {
    return `resource-${encodeURIComponent(businessKey)}`
  }

  // 所有业务字段都为空时无法构造真正的业务键；索引只作为不可操作异常记录的最后兜底，
  // 避免 Vue 使用随机 key 造成刷新后选中态漂移，同时由 resourceId 校验阻断接口动作。
  return `resource-missing-${index}`
}

const formatList = (list?: Dim3dModelPageVo[]) => {
  if (!list) return []
  return list.map((item, index) => {
    const resourceId = item.id
    const legacyItem = item as Dim3dModelPageVo & {
      bannerAddress?: string
      artResRelativePath?: string
      artResName?: string
    }
    const legacyBannerAddress = legacyItem.bannerAddress || ''
    const legacyResourcePath = legacyItem.artResRelativePath || ''
    // 付费模型按 Figma 显示价格并使用橙色；免费模型显示免费并保留绿色语义色。
    const numericPrice = Number(item.priceYuan)
    const hasPrice = item.priceYuan !== undefined &&
      item.priceYuan !== null &&
      Number.isFinite(numericPrice)
    const isPaid = item.isPaid === 'PAID' ||
      (item.isPaid === undefined &&
        (hasPrice ||
          /付费|paid/i.test(String(item.isPaidName || ''))))
    const paymentLabel = isPaid
      ? hasPrice
        ? `¥${String(Number(numericPrice.toFixed(2))).replace(/\.0+$/, '')}`
        : MODEL_CARD_FIELD_PLACEHOLDER
      : item.isPaid === 'FREE' || item.isPaidName
        ? item.isPaidName || '免费'
        : MODEL_CARD_FIELD_PLACEHOLDER
    return {
      ...item,
      id:
        resourceId !== undefined && resourceId !== null
          ? resourceId.toString()
          : createStableResourceKey(item, index),
      resourceId,
      name: item.modelName?.trim() || MODEL_CARD_FIELD_PLACEHOLDER,
      // 新接口返回封面文件编号；真实地址必须由 OSS 查询接口返回，旧 bannerAddress 继续兼容。
      imgPath: item.coverImageId && coverUrlByOssId.value.get(String(item.coverImageId))
        ? coverUrlByOssId.value.get(String(item.coverImageId)) || ''
        : legacyBannerAddress
          ? concatMinioUrl(legacyBannerAddress)
          : '',
      resPath: legacyResourcePath,
      artResRelativePath: legacyResourcePath,
      bannerAddress: legacyBannerAddress,
      artResName: legacyItem.artResName || '',
      updateTime: item.updateTime || '',
      // 分类展示必须优先使用真实字典的 dictLabel；category 仅保留为筛选编码，不能直接展示。
      category:
        getDim3dModelCategoryLabel(
          categoryLabelByValue.value,
          item.category,
          item.categoryName,
        ) || MODEL_CARD_FIELD_PLACEHOLDER,
      description: item.modelDesc?.trim() || MODEL_CARD_FIELD_PLACEHOLDER,
      paymentLabel,
      paymentTone: isPaid ? 'paid' : 'free',
      // 后端缺少展示名称时按正式状态枚举补齐文案，保证标签颜色和文字始终一致。
      statusLabel:
        item.statusName?.trim() ||
        (item.status === 'ONLINE' ? '已上线' : item.status === 'OFFLINE' ? '已下线' : MODEL_CARD_FIELD_PLACEHOLDER),
    }
  })
}

/** Figma 使用完整日期时间；手动补零可保持不同浏览器和系统语言下的输出稳定。 */
const formatResourceDateTime = (value?: string) => {
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

/** Figma 下线标签使用红色警示语义；未知状态保留待确认样式，避免误判业务状态。 */
const getStatusClass = (record: TransferListItem) => {
  if (record.status === 'ONLINE' || /上线|online/i.test(String(record.statusLabel))) {
    return 'is-online'
  }
  if (record.status === 'OFFLINE' || /下线|offline/i.test(String(record.statusLabel))) {
    return 'is-offline'
  }
  return 'is-pending'
}

export type TransferListItem = ReturnType<typeof formatList>[0]

defineOptions({ name: 'ModelManage' })

const originCategories = ref<DimensionsApi.ResourceType[]>([])
const originList = ref<Dim3dModelPageVo[]>([])
/** 真实分类字典的 dictValue -> dictLabel 映射，列表卡片和预览详情共用中文名称。 */
const categoryLabelByValue = ref(new Map<string, string>())
/**
 * 列表请求失败时使用独立错误文案，避免把鉴权失败渲染成“没有匹配的数据”。
 * 只有成功响应且 total/rows 为空时，ResourceLayout 才显示正常空状态。
 */
const listError = ref('')
/** OSS 查询结果按编号缓存，避免同一封面在分页和刷新过程中重复请求。 */
const coverUrlByOssId = ref(new Map<string, string>())
const total = ref(0)
/**
 * “全部”标签显示的是未按分类限制时接口返回的总数，不能复用当前列表 total。
 * 分类筛选后 total 会变成当前分类数量；单独保存该值可避免标签在切换分类时显示错误计数。
 */
const allCategoryTotal = ref(0)
/** 分类总数按分类编码缓存；统计请求不会改写当前卡片列表。 */
const categoryTotals = ref(new Map<string, number>())
/** 快速切换资源归属时只允许最新一轮统计写回，避免慢响应覆盖当前页签数量。 */
let latestCategoryTotalRequestId = 0
const pagination = reactive({ page: 1, size: 10 })

/**
 * 草稿筛选只绑定表单，用户点击“查询”前不会触发接口请求；这样输入过程不会产生
 * 高频请求，也避免旧响应覆盖用户刚提交的新条件。
 */
const activeTab = ref<ResourceScopeValue>('all')
/** 三项页签由资源管理共享配置提供，模型页只持有当前选中状态。 */
const resourceTabs = RESOURCE_SCOPE_TABS
const MODEL_CATEGORY_ALL = ''
const draftFilters = reactive({
  search: '',
  category: MODEL_CATEGORY_ALL,
  sort: -1,
  status: 'all',
  paid: 'all',
  resourceBelong: 'all',
})
const appliedFilters = reactive({
  search: '',
  category: MODEL_CATEGORY_ALL,
  sort: -1,
  status: 'all',
  paid: 'all',
  resourceBelong: 'all',
})

const addDialogVisible = ref(false)

const editRecord = ref<TransferListItem>()
const previewDialogVisible = ref(false)
const previewPath = ref('')
const previewManagedResourceId = ref<string>()
// 来源解析错误交给弹窗展示，并允许在原入口重新查询资源。
const previewError = ref('')
const previewRecord = ref<TransferListItem>()
const previewRequestId = ref(0)

const categories = computed(() => {
  return originCategories.value
    .filter((item) => item.id !== void 0)
    .map((item) => ({
      label: item.typeName,
      value: item.id!,
    }))
})

/** 分类选项只来自真实接口；空名称分类不渲染，避免页面生成无法追溯的业务文案。 */
const categoryOptions = computed(() => [
  { label: `全部（${allCategoryTotal.value}）`, value: MODEL_CATEGORY_ALL },
  ...originCategories.value
    .filter((category) => category.typeCode?.trim() && category.typeName.trim())
    .map((category) => ({
      label: `${category.typeName}（${categoryTotals.value.get(category.typeCode!) ?? 0}）`,
      value: category.typeCode!,
    })),
])
const categoryNavigation = computed(() => categoryOptions.value)

const list = computed(() => formatList(originList.value))

/**
 * 模型卡片统一从后端返回的 resourceBelong 计算操作能力；不使用名称或当前页签猜测归属。
 * 同一函数同时被模板和动作处理器调用，确保按钮状态与接口调用前置校验保持一致。
 */
const managementCapabilities = getCurrentManagementCapabilities()
const getCardCapabilities = (record: TransferListItem) =>
  resolveResourceCardCapabilities(managementCapabilities, record.resourceBelong)

/** 租户我的资源只有删除项，使用单项浮层高度；运营端双项菜单保持原尺寸。 */
const getCardMenuPopperClass = (record: TransferListItem) =>
  getCardCapabilities(record).canToggleStatus
    ? 'manage-dropdown-popper manage-card-menu-popper'
    : 'manage-dropdown-popper manage-card-menu-popper manage-card-menu-popper--compact'

/** 按列表返回的封面编号查询真实访问地址，严格按 ossId 匹配，不根据文件名猜测地址。 */
const resolveCoverUrls = async (rows: Dim3dModelPageVo[], requestId: number) => {
  const ids = [
    ...new Set(
      rows
        .map((item) => String(item.coverImageId ?? '').trim())
        .filter((id) => id && !coverUrlByOssId.value.has(id)),
    ),
  ]
  if (!ids.length) return

  const results = await Promise.all(
    ids.map(async (id) => {
      const [error, response] = await to(
        getDim3dOssFileById(id, { suppressNotFoundNotification: true }),
      )
      if (error || !response?.data?.length) return null
      const file = response.data.find((item) => String(item.ossId ?? '') === id)
      return file?.url ? { id, url: file.url } : null
    }),
  )
  if (requestId !== latestRequestId.value) return
  const next = new Map(coverUrlByOssId.value)
  results.forEach((result) => {
    if (result) next.set(result.id, result.url)
  })
  coverUrlByOssId.value = next
}

onBeforeMount(() => {
  void initializePage()
})

const initializePage = async () => {
  await getCategories()
  await getList()
}

const getCategories = async () => {
  const [err, data] = await toData(getDim3dModelCategoryDictionary())

  if (err) {
    categoryLabelByValue.value = new Map()
    originCategories.value = []
  } else {
    const dictionaryItems = Array.isArray(data) ? data : []
    categoryLabelByValue.value = createDim3dModelCategoryLabelMap(dictionaryItems)
    // 字典值用于接口筛选和表单提交，字典标签用于分类导航、卡片和表单选项展示。
    // dictCode 缺失时使用负索引作为本地选项键，不影响真正提交的 dictValue。
    originCategories.value = dictionaryItems
      .filter((item) => item.dictLabel?.trim() && item.dictValue?.trim())
      .map((item, index) => {
        const numericCode = Number(item.dictCode)
        return {
          id: Number.isFinite(numericCode) ? numericCode : -(index + 1),
          typeCode: item.dictValue!.trim(),
          typeName: item.dictLabel!.trim(),
        }
      })
    void loadCategoryTotals(originCategories.value)
  }
}

/**
 * 分类数量使用同一分页接口的 total 字段获取，每项只取 1 条记录以减少响应体；
 * “全部”和各分类都携带当前资源归属，页签切换后统计会与卡片列表保持一致。
 * 请求并行执行，失败项显示 0；请求序号阻止快速切换时的旧响应覆盖新页签。
 */
const loadCategoryTotals = async (categories: DimensionsApi.ResourceType[]) => {
  const requestId = ++latestCategoryTotalRequestId
  const scope = activeTab.value
  const validCategories = categories.filter((category) => category.typeCode?.trim())
  const [allResult, ...categoryResults] = await Promise.all([
    to(
      pageDim3dModel(createResourceCategoryTotalRequestParams(scope), {
        suppressNotFoundNotification: true,
      }),
    ),
    ...validCategories.map((category) =>
      to(
        pageDim3dModel(createResourceCategoryTotalRequestParams(scope, category.typeCode), {
          suppressNotFoundNotification: true,
        }),
      ),
    ),
  ])

  if (requestId !== latestCategoryTotalRequestId || scope !== activeTab.value) return

  const [allError, allResponse] = allResult
  allCategoryTotal.value = allError ? 0 : Number(allResponse?.total) || 0
  const entries = validCategories.map((category, index) => {
    const [error, response] = categoryResults[index]!
    return [category.typeCode!, error ? 0 : Number(response?.total) || 0] as const
  })
  categoryTotals.value = new Map(entries)
}

// 请求序列号只递增，不创建额外定时器；它是处理接口乱序响应的轻量并发保护。
const latestRequestId = ref(0)

/**
 * 筛选、页签、分类和分页都只通过这一处生成新接口参数，保证页面状态与请求参数一一对应。
 * UI 的“全部”值会被转换成 undefined，避免向后端发送无效的伪枚举值。
 */
const buildListRequestParams = (): Dim3dModelPageParams => ({
  pageNum: pagination.page,
  pageSize: pagination.size,
  modelName: appliedFilters.search || void 0,
  resourceBelong: toDim3dResourceBelong(appliedFilters.resourceBelong as ResourceScopeValue),
  status:
    appliedFilters.status === 'ONLINE' || appliedFilters.status === 'OFFLINE'
      ? appliedFilters.status
      : undefined,
  isPaid:
    appliedFilters.paid === 'PAID' || appliedFilters.paid === 'FREE'
      ? appliedFilters.paid
      : undefined,
  category: appliedFilters.category || void 0,
  orderByColumn: appliedFilters.sort === -1 ? void 0 : 'updateTime',
  isAsc: appliedFilters.sort === 1 ? 'asc' : appliedFilters.sort === 2 ? 'desc' : void 0,
})

/**
 * 阶段三模型分页接口尚未部署时，404 只表示当前环境暂无模型数据；请求级策略会跳过
 * 全局错误通知，页面仍按空结果渲染 0 个卡片，不调用旧列表接口或伪造数据。
 */
const createListRequest = (params: Dim3dModelPageParams) =>
  to(pageDim3dModel(params, { suppressNotFoundNotification: true }))

/**
 * 相同查询条件在请求尚未结束时共用同一个 Promise，避免双击查询、重复分页点击产生
 * 完全一致的网络请求。Map 只保存进行中的请求，并在结束后立即删除，既不缓存旧数据，
 * 也不会长期持有响应对象。
 */
const inFlightListRequests = new Map<string, ReturnType<typeof createListRequest>>()

const getList = async () => {
  const requestId = ++latestRequestId.value
  const params = buildListRequestParams()
  const requestKey = JSON.stringify(params)
  let request = inFlightListRequests.get(requestKey)

  if (!request) {
    request = createListRequest(params)
    inFlightListRequests.set(requestKey, request)
    void request.finally(() => {
      // 仅删除自身登记的 Promise，避免极端时序误删同键的后续新请求。
      if (inFlightListRequests.get(requestKey) === request) {
        inFlightListRequests.delete(requestKey)
      }
    })
  }

  const [err, data] = await request

  // 快速切换条件时只允许最后一次请求提交结果，防止网络乱序造成页面回退。
  if (requestId !== latestRequestId.value) return

  if (err) {
    const requestError = err as { code?: unknown; status?: unknown; message?: unknown }
    const errorCode = Number(requestError.status ?? requestError.code)
    const isAuthorizationError = errorCode === 401 || errorCode === 403
    listError.value = isAuthorizationError
      ? errorCode === 401
        ? '当前登录已过期，请重新登录'
        : '模型列表接口禁止访问，请联系管理员'
      : '模型列表加载失败，请稍后重试'
    // 阶段三请求使用独立临时令牌，不能触发管理端的自动登录跳转；
    // 401 需要把后端原始提示直接弹出，用户才能明确知道是登录过期而非列表为空。
    if (errorCode === 401) {
      ElMessage.error('当前登录已过期，请重新登录')
    }
    total.value = 0
    originList.value = []
  } else {
    listError.value = ''
    const responseTotal = data?.total || 0
    total.value = responseTotal
    // 无分类和顶部查询条件时，列表 total 可立即更新当前资源归属下的“全部”计数；
    // 独立统计请求随后会以相同归属校准全部及各分类数量。
    if (
      params.category === void 0 &&
      params.status === void 0 &&
      params.isPaid === void 0 &&
      !params.modelName
    ) {
      allCategoryTotal.value = responseTotal
    }
    originList.value = data?.rows || []
    // 列表先展示结构和占位图，再异步解析封面地址，避免 OSS 查询阻塞分页首屏。
    void resolveCoverUrls(originList.value, requestId)
  }
}

const handlePaginationChange = (data: { page: number; size: number }) => {
  // Element Plus 可能在受控属性回写时重复派发同值事件；同值不应再次请求接口。
  if (pagination.page === data.page && pagination.size === data.size) return
  pagination.page = data.page
  pagination.size = data.size
  void getList()
}

/** 提交当前草稿筛选，并将页码复位到第一页；一次交互只发出一次请求。 */
const applyFilters = () => {
  appliedFilters.search = draftFilters.search.trim()
  appliedFilters.category = draftFilters.category
  appliedFilters.sort = draftFilters.sort
  appliedFilters.status = draftFilters.status
  appliedFilters.paid = draftFilters.paid
  appliedFilters.resourceBelong = activeTab.value
  pagination.page = 1
  void getList()
}

/** 重置表单、页签和已应用条件，保持真实接口默认参数。 */
const resetFilters = () => {
  const resourceScopeChanged = activeTab.value !== 'all'
  activeTab.value = 'all'
  draftFilters.search = ''
  draftFilters.category = MODEL_CATEGORY_ALL
  draftFilters.sort = -1
  draftFilters.status = 'all'
  draftFilters.paid = 'all'
  draftFilters.resourceBelong = 'all'
  appliedFilters.search = ''
  appliedFilters.category = MODEL_CATEGORY_ALL
  appliedFilters.sort = -1
  appliedFilters.status = 'all'
  appliedFilters.paid = 'all'
  appliedFilters.resourceBelong = 'all'
  pagination.page = 1
  void getList()
  if (resourceScopeChanged) void loadCategoryTotals(originCategories.value)
}

/**
 * 页签值映射为接口资源归属；切换后并行刷新卡片列表和分类统计，两类请求互不阻塞。
 */
const selectResourceTab = (value: string) => {
  if (!resourceTabs.some((tab) => tab.value === value) || activeTab.value === value) return
  activeTab.value = value as ResourceScopeValue
  draftFilters.resourceBelong = activeTab.value
  appliedFilters.resourceBelong = activeTab.value
  pagination.page = 1
  void getList()
  void loadCategoryTotals(originCategories.value)
}

const selectCategory = (value: string) => {
  if (draftFilters.category === value && appliedFilters.category === value) return
  draftFilters.category = value
  appliedFilters.category = value
  pagination.page = 1
  void getList()
}

const openAddDialog = () => {
  editRecord.value = void 0
  addDialogVisible.value = true
}

/**
 * 预览中的编辑操作沿用资源管理已有的编辑弹窗和数据模型。
 * 先关闭网页播放器预览以释放画布资源，再传递当前记录打开编辑，避免两个弹窗叠加后遮挡操作区。
 */
const handlePreviewEdit = () => {
  if (!previewRecord.value) return
  previewDialogVisible.value = false
  editRecord.value = previewRecord.value
  addDialogVisible.value = true
}

/** 阶段三主键按字符串传输，不能转换成数字，否则大整数会丢失精度。 */
const getResourceStringId = (record: TransferListItem) => {
  const value = String(record.resourceId ?? '').trim()
  if (!value || value.startsWith('resource-')) return undefined
  return value
}

/**
 * 读取目录详情及服务端的文件访问方式。受管编号交给播放器加载，历史文件使用授权返回的原路径。
 */
const openModelPreview = async (record: TransferListItem) => {
  const requestId = ++previewRequestId.value
  previewRecord.value = record
  previewDialogVisible.value = true
  previewError.value = ''
  previewManagedResourceId.value = undefined
  // 等文件访问方式确认后再加载，避免重复下载或加载竞争。
  previewPath.value = ''

  const resourceId = getResourceStringId(record)
  if (!resourceId) {
    previewError.value = '当前模型缺少有效编号，暂不可预览'
    return
  }

  const [error, response] = await to(getDim3dModelInfo(resourceId))
  if (requestId !== previewRequestId.value || !previewDialogVisible.value) return
  if (error || response?.code !== 200) {
    previewError.value = response?.msg || '模型详情获取失败，请重新加载'
    return
  }

  const detail = response.data
  if (detail?.id !== resourceId) {
    previewError.value = '模型详情与当前记录不一致，请重新加载'
    return
  }
  const modelFileId = String(detail?.resourceId ?? detail?.modelFileId ?? '').trim()
  if (!modelFileId) {
    previewError.value = '模型详情未返回可预览资源'
    return
  }

  // 访问方式只取服务端的授权结果。引擎按稳定编号读取受管修订及文件。
  const [currentError, file] = await to(getDim3dModelFileAccess(modelFileId))
  if (requestId !== previewRequestId.value || !previewDialogVisible.value) return
  if (currentError || !file) {
    previewError.value = currentError?.message || '模型文件访问方式读取失败，请重新加载'
    return
  }
  if (file.accessMode === 'MANAGED') previewManagedResourceId.value = file.id
  else previewPath.value = file.url
}

/** 来源失败时沿用同一资源查询入口，递增请求编号会自动忽略上次迟到响应。 */
const retryModelPreview = () => {
  if (previewRecord.value) void openModelPreview(previewRecord.value)
}

/**
 * 卡片“更多”菜单只提供当前状态的反向操作：上线模型显示“下线”，下线模型显示“上线”。
 * 状态未知时不猜测后端动作，使用占位文案并在执行时给出提示，避免误触发状态接口。
 */
const getStatusActionLabel = (record: TransferListItem) => {
  if (record.status === 'ONLINE') return '下线'
  if (record.status === 'OFFLINE') return '上线'
  return '--'
}

const toggleModelStatus = async (record: TransferListItem) => {
  if (!canUseResourceCardAction(getCardCapabilities(record), 'toggleStatus')) {
    ElMessage.warning('当前模型不可切换状态')
    return
  }
  const resourceId = getResourceStringId(record)
  const targetStatus =
    record.status === 'ONLINE' ? 'OFFLINE' : record.status === 'OFFLINE' ? 'ONLINE' : undefined
  if (!resourceId || !targetStatus) {
    ElMessage.warning('当前模型缺少有效状态或编号，暂不能切换上下线')
    return
  }

  // 状态接口会立即改变所有用户的可见范围，必须在发起请求前展示对应语义色的二次确认框。
  try {
    await openManageModelStatusConfirm(targetStatus, record.name)
  } catch {
    // 用户取消或关闭确认框不属于请求失败，不显示错误提示，也不调用后端接口。
    return
  }

  const [error] = await to(changeDim3dModelStatus(targetStatus, resourceId))
  if (error) {
    ElMessage.error(error.message || `${targetStatus === 'ONLINE' ? '上线' : '下线'}模型失败，请稍后重试`)
    return
  }
  await getList()
}

const OperateActionMap = {
  [OperateEnum.Preview]: (record: TransferListItem) => {
    void openModelPreview(record)
  },
  [OperateEnum.ToggleStatus]: (record: TransferListItem) => {
    void toggleModelStatus(record)
  },
  [OperateEnum.Edit]: (record: TransferListItem) => {
    if (!getCardCapabilities(record).canEdit) {
      ElMessage.warning('当前模型不可编辑')
      return
    }
    editRecord.value = record
    addDialogVisible.value = true
  },
  [OperateEnum.Delete]: (record: TransferListItem) => {
    if (!canUseResourceCardAction(getCardCapabilities(record), 'delete')) {
      ElMessage.warning('当前模型不可删除')
      return
    }
    const resourceId = String(record.resourceId || '').trim()
    if (!resourceId || resourceId.startsWith('resource-')) {
      ElMessage.warning('当前资源缺少有效编号，暂不可删除')
      return
    }
    openManageDeleteConfirm('模型', record.name).then(async () => {
      // 删除同样等待目录事务的空成功回执，再刷新列表。
      const [err] = await to(removeDim3dModel(resourceId))
      if (err) {
        ElMessage.error('模型删除失败，请稍后重试')
        return
      }
      await getList()
    })
  },
}

const handleOperate = (action: OperateEnum, record: TransferListItem) => {
  OperateActionMap[action]?.(record)
}

/**
 * 封面点击固定复用模型现有预览入口。模型网格已关闭整卡多选，
 * 因此封面和卡片空白区都不会生成选择状态。
 */
const handleMediaPreview = (record: TransferListItem) => {
  handleOperate(OperateEnum.Preview, record)
}

</script>
