<template>
  <div class="manage-page manage-theme manage-list-page manage-icon-page">
    <ManagePageTopBar
      title="图片管理"
      breadcrumb="资源管理/图片管理"
      :tabs="resourceTabs"
      :active-tab="activeTab"
      tab-label="图片资源范围"
      @tab-change="selectResourceTab"
    >
      <template #actions>
        <!-- 图片管理仅保留单条新增入口。 -->
        <el-button
          class="manage-toolbar-button"
          type="primary"
          icon="Plus"
          title="新增图片"
          @click="openAddDialog"
        >
          新增图片
        </el-button>
      </template>

      <!--
        Figma 节点 2380:2998 的筛选区只包含图片名称、状态和两个操作按钮。
        分类筛选移动到下方分类导航，避免四个字段换行后破坏设计稿的 94px 固定高度。
      -->
      <ManageFilterBar
        class="manage-icon-page__filter-panel"
        label="图片筛选"
        actions-class="manage-icon-page__filter-actions"
      >
        <div class="manage-filter-bar__field">
          <label for="manage-icon-name">图片名称：</label>
          <el-input
            id="manage-icon-name"
            v-model="search"
            placeholder="搜索名称"
            clearable
            suffix-icon="Search"
          />
        </div>

        <div class="manage-filter-bar__field">
          <label for="manage-icon-status">状态：</label>
          <el-select
            id="manage-icon-status"
            v-model="selectedStatus"
            popper-class="manage-dropdown-popper manage-select-popper"
            :options="statusOptions"
          />
        </div>

        <template #actions>
          <!-- 查询仅提交已填写的草稿条件，避免输入时触发高频列表请求。 -->
          <el-button class="manage-icon-page__query-button" type="primary" @click="applyFilters">
            查询
          </el-button>
          <el-button class="manage-icon-page__reset-button" @click="resetFilters">重置</el-button>
        </template>
      </ManageFilterBar>
    </ManagePageTopBar>

    <!-- 模型、图标、场景页都使用 Figma 中间区域的白底容器；图标页内部直接放卡片网格。 -->
    <section class="manage-resource-content-panel">
      <!--
        分类导航对应 Figma 节点 2380:3032：分类项和总数直接复用模型页的可滚动轨道，
        但点击只提交真实 dictValue，避免把展示名称或本地索引当作接口分类编码。
      -->
      <nav class="manage-model-page__categories" aria-label="图片分类">
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

      <!-- 图标与模型共用 Figma 的 12px 媒体内边距；图片卡片关闭整卡选择，仅保留封面预览。 -->
      <ResourceLayout
        :list="list"
        :total="total"
        :current-page="pagination.page"
        :page-size="pagination.size"
        variant="icon"
        cover-fit="contain"
        media-padding="12px"
        media-interactive
        :selectable="false"
        @paginationChange="handlePaginationChange"
        @mediaClick="handleMediaPreview"
      >
        <template #media-extra="slotProps">
          <span
            v-if="slotProps.record.statusLabel !== '--'"
            class="manage-model-card__status"
            :class="getStatusClass(slotProps.record)"
          >
            {{ slotProps.record.statusLabel }}
          </span>
        </template>

        <template #content="slotProps">
          <div class="manage-resource-card__body">
            <!--
            图标卡片沿用模型卡片的信息层级：名称、描述、分类与更新时间均位于媒体区下方，
            这样卡片几何与 Figma 节点 2143:13268 保持一致，业务差异只保留图标的操作项。
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
                <span class="manage-model-card__meta-category">{{
                  slotProps.record.category
                }}</span>
                <span class="manage-model-card__meta-separator" aria-hidden="true">·</span>
                <time class="mono-text">{{
                  formatResourceDateTime(slotProps.record.updateTime)
                }}</time>
              </div>
            </div>

            <div class="manage-model-card__footer">
              <el-button
                v-if="getCardCapabilities(slotProps.record).canEdit"
                class="manage-model-card__edit"
                @click.stop.prevent="handleOperate(OperateEnum.Edit, slotProps.record)"
              >
                编辑
              </el-button>
              <div class="manage-model-card__actions">
                <!--
                图片卡片更多菜单由当前资源能力决定上下线和删除是否显示；点击事件在按钮和菜单层阻断，
                不会触发封面预览。
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
                    <!-- 单卡更多菜单只保留状态切换和删除。 -->
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
      class="manage-dialog"
      :originCategories="originCategories"
      :categories="categories"
      :editRecord="editRecord"
      @updateList="refreshAfterSave"
    />

    <PreviewDialog
      v-model:visible="previewDialogVisible"
      class="manage-dialog"
      :path="previewPath"
      :record="previewRecord"
      :can-edit="previewRecord ? getCardCapabilities(previewRecord).canEdit : false"
      @edit="handlePreviewEdit"
      @update:visible="previewDialogVisible = $event"
    />
  </div>
</template>

<script setup lang="ts">
import ResourceLayout from '../layout/index.vue'
import CoverModel from '@/assets/images/cover/model.png'
import { to, toData } from '@/utils/asyncHandler'
import { ElMessage } from 'element-plus'
import AddDialog from './AddDialog.vue'
import PreviewDialog from './preview/PreviewDialog.vue'
import {
  openManageDeleteConfirm,
  openManageResourceStatusConfirm,
} from '../../manageShared/confirm'
import { getDim3dOssFileById } from '@/servers/manual/dim3d/api/oss'
import {
  createDim3dIconCategoryLabelMap,
  getDim3dIconCategoryDictionary,
  getDim3dIconCategoryLabel,
} from '@/servers/manual/dim3d/api/dictionary'
import {
  changeDim3dIconStatus,
  getDim3dIconInfo,
  pageDim3dIcon,
  removeDim3dIcon,
  type Dim3dIconPageParams,
  type Dim3dIconPageVo,
} from '@/servers/manual/dim3d/api/icon'
import ManageFilterBar from '../../manageShared/ManageFilterBar.vue'
import ManagePageTopBar from '../../manageShared/ManagePageTopBar.vue'
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
  Edit = 'Edit',
  ToggleStatus = 'ToggleStatus',
  Delete = 'Delete',
}

const statusOptions = [
  { label: '全部', value: 'all' },
  { label: '上线', value: 'ONLINE' },
  { label: '下线', value: 'OFFLINE' },
]

/**
 * 图标编号缺失时使用已有业务字段构造确定性渲染键，禁止随机键导致刷新后选择态漂移。
 * 该键只服务卡片渲染；删除和编辑仍校验真实 id。
 */
const createStableIconKey = (item: Dim3dIconPageVo, index: number) => {
  const businessParts = [
    item.id,
    item.iconName,
    item.iconFileId,
    item.category,
    item.updateTime,
  ].map((value) => String(value ?? '').trim())
  const businessKey = businessParts.join('|')
  if (businessKey.split('|').join('').length > 0) {
    return `icon-${encodeURIComponent(businessKey)}`
  }

  // 所有可识别字段均缺失时只能保留列表索引，业务动作会由各自的真实字段校验阻断。
  return `icon-missing-${index}`
}

const formatList = (list?: Dim3dIconPageVo[]) => {
  if (!list) return []
  return list.map((item, index) => ({
    ...item,
    id:
      item.id !== undefined && item.id !== null
        ? item.id.toString()
        : createStableIconKey(item, index),
    name: item.iconName?.trim() || '--',
    imgPath: item.iconFileId ? iconUrlByOssId.value.get(String(item.iconFileId))?.url || '' : '',
    updateTime: item.updateTime || '',
    // 正式字典的 dictLabel 是唯一分类展示来源；dictValue 只参与筛选和接口提交。
    category:
      getDim3dIconCategoryLabel(categoryLabelByValue.value, item.category, item.categoryName) ||
      '--',
    // Figma 卡片第二行展示图标描述；接口缺失描述时使用统一占位，避免卡片高度随数据变化。
    description: item.iconDesc?.trim() || '--',
    // 阶段四列表接口返回的是 status/statusName；卡片只展示接口提供的状态，
    // 缺失时使用统一占位，避免模板访问未声明字段导致类型检查失败。
    statusLabel:
      item.statusName ||
      (item.status === 'ONLINE' ? '已上线' : item.status === 'OFFLINE' ? '已下线' : '--'),
  }))
}

/** Figma 卡片元信息使用完整日期时间；手动补零保证不同浏览器语言环境输出一致。 */
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

/** 状态颜色只接受明确的上下线枚举，未知状态不误用成功或警示颜色。 */
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

defineOptions({ name: 'IconManage' })

const originCategories = ref<DimensionsApi.ResourceType[]>([])
/** 图标接口分类编码到中文名称的只读映射；字典刷新后会同步驱动卡片重新计算。 */
const categoryLabelByValue = ref(new Map<string, string>())
const originList = ref<Dim3dIconPageVo[]>([])
const total = ref(0)
/** 未按分类限制时的总数单独保存，防止分类切换后把“全部”标签显示成当前分类数量。 */
const allCategoryTotal = ref(0)
/** 分类数量按 dictValue 缓存；只读取分页 total，不改写当前列表。 */
const categoryTotals = ref(new Map<string, number>())
/** 资源归属快速切换时仅提交最后一轮分类统计，防止网络乱序导致数量回退。 */
let latestCategoryTotalRequestId = 0
const pagination = reactive({ page: 1, size: 10 })

/** 图片页使用共享资源归属配置，页签值会映射为真实接口的 resourceBelong。 */
const activeTab = ref<ResourceScopeValue>('all')
const resourceTabs = RESOURCE_SCOPE_TABS

const selectResourceTab = (value: string) => {
  if (!resourceTabs.some((tab) => tab.value === value) || activeTab.value === value) return
  activeTab.value = value as ResourceScopeValue
  pagination.page = 1
  void getList()
  void loadCategoryTotals(originCategories.value)
}

const search = ref('')
/** 图标分类筛选使用后端 category 编码；全部值为空，不发送伪造枚举。 */
const selectedCategory = ref('')
const selectedStatus = ref<'all' | 'ONLINE' | 'OFFLINE'>('all')
/**
 * 输入框和下拉框只维护草稿值；请求参数读取此对象，从而严格匹配 Figma 的“查询”交互。
 * 分类导航属于即时筛选入口，点击后仍立即请求，和模型页的分类行为保持一致。
 */
const appliedFilters = reactive({
  search: '',
  status: 'all' as 'all' | 'ONLINE' | 'OFFLINE',
})

const addDialogVisible = ref(false)

const editRecord = ref<TransferListItem>()
const previewDialogVisible = ref(false)
const previewPath = ref('')
/** 图片预览与编辑共用当前卡片记录，关闭预览不丢失编辑所需的真实资源编号。 */
const previewRecord = ref<TransferListItem>()

const categories = computed(() => {
  return originCategories.value
    .filter((item) => item.id !== void 0)
    .map((item) => ({
      label: item.typeName,
      value: item.id!,
    }))
})
/** 分类导航文案和数量与 Figma 一致；无效字典项不会生成无法查询的按钮。 */
const categoryNavigation = computed(() => [
  { label: `全部（${allCategoryTotal.value}）`, value: '' },
  ...originCategories.value
    .filter((item) => item.typeCode && item.typeName)
    .map((item) => ({
      label: `${item.typeName}（${categoryTotals.value.get(item.typeCode!) ?? 0}）`,
      value: item.typeCode!,
    })),
])
const list = computed(() => formatList(originList.value))

/**
 * 图片卡片与模型卡片共用同一资源能力计算，归属只读取后端 resourceBelong 字段。
 * 模板和事件处理器共用该结果，避免只隐藏菜单而保留可调用的前端操作。
 */
const managementCapabilities = getCurrentManagementCapabilities()
const getCardCapabilities = (record: TransferListItem) =>
  resolveResourceCardCapabilities(managementCapabilities, record.resourceBelong)

/** 租户我的资源只有删除项，使用单项浮层高度；运营端双项菜单保持原尺寸。 */
const getCardMenuPopperClass = (record: TransferListItem) =>
  getCardCapabilities(record).canToggleStatus
    ? 'manage-dropdown-popper manage-card-menu-popper'
    : 'manage-dropdown-popper manage-card-menu-popper manage-card-menu-popper--compact'

/** 签名地址只缓存当前页，在服务端十分钟有效期前刷新，避免无限累积及持有过期地址。 */
const iconUrlByOssId = ref(new Map<string, { url: string; expiresAt: number }>())

/** 仅查询当前页缺失的 OSS 编号；缺失文件保留占位图，不拼接猜测地址。 */
const resolveIconUrls = async (rows: Dim3dIconPageVo[], requestId: number) => {
  const pageIds = new Set(rows.map((row) => String(row.iconFileId ?? '').trim()).filter(Boolean))
  const now = Date.now()
  const next = new Map([...iconUrlByOssId.value].filter(([id, value]) => pageIds.has(id) && value.expiresAt > now))
  const ids = [
    ...new Set(
      rows
        .map((row) => String(row.iconFileId ?? '').trim())
        .filter((id) => id && !next.has(id)),
    ),
  ]
  if (!ids.length) {
    if (requestId === latestRequestId.value) iconUrlByOssId.value = next
    return
  }

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
  if (requestId !== latestRequestId.value) return
  results.forEach((result) => {
    if (result) next.set(result.id, { url: result.url, expiresAt: Date.now() + 9 * 60 * 1000 })
  })
  iconUrlByOssId.value = next
}
onBeforeMount(() => {
  // 分类和首屏列表并行请求，避免把列表首载延迟到防抖计时器，也杜绝首载与首次翻页竞态重复查询。
  void Promise.all([getCategories(), getList()])
})

const getCategories = async () => {
  const [err, data] = await toData(getDim3dIconCategoryDictionary())

  if (err) {
    categoryLabelByValue.value = new Map()
    originCategories.value = []
  } else {
    const dictionaryItems = Array.isArray(data) ? data : []
    categoryLabelByValue.value = createDim3dIconCategoryLabelMap(dictionaryItems)
    // 弹窗内部仍使用稳定的本地数字键，真正筛选和提交始终读取 typeCode 中的 dictValue。
    // dictCode 缺失或非数字时使用负索引，避免伪造业务编码或把数组位置提交给后端。
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
    // 数量请求仅使用每类 1 条记录，响应体最小；失败项显示 0，不阻塞主列表首屏。
    void loadCategoryTotals(originCategories.value)
  }
}

/**
 * 分类数量使用与列表相同的分页接口读取 total。全部及各分类请求都携带当前资源归属，
 * 且每项只请求一条记录；请求序号确保快速切换页签时只提交最后一轮统计结果。
 */
const loadCategoryTotals = async (categories: DimensionsApi.ResourceType[]) => {
  const requestId = ++latestCategoryTotalRequestId
  const scope = activeTab.value
  const validCategories = categories.filter((category) => category.typeCode?.trim())
  const [allResult, ...categoryResults] = await Promise.all([
    to(
      pageDim3dIcon(createResourceCategoryTotalRequestParams(scope), {
        suppressNotFoundNotification: true,
      }),
    ),
    ...validCategories.map((category) =>
      // 图标分页接口直接返回业务分页对象，沿用主列表的 to 包装，避免误按 { data } 结构解包。
      to(
        pageDim3dIcon(createResourceCategoryTotalRequestParams(scope, category.typeCode), {
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

// 请求序号只递增且不启动定时器；快速翻页时仅允许最后一次请求提交界面状态。
const latestRequestId = ref(0)

/** 将页面的全部筛选项转换为阶段四图标接口字段，不再发送旧接口参数。 */
const buildListRequestParams = (): Dim3dIconPageParams => ({
  pageNum: pagination.page,
  pageSize: pagination.size,
  iconName: appliedFilters.search || void 0,
  category: selectedCategory.value || void 0,
  status: appliedFilters.status === 'all' ? void 0 : appliedFilters.status,
  resourceBelong: toDim3dResourceBelong(activeTab.value),
})

const createListRequest = (params: Dim3dIconPageParams) =>
  to(pageDim3dIcon(params, { suppressNotFoundNotification: true }))
const inFlightListRequests = new Map<string, ReturnType<typeof createListRequest>>()

/**
 * 阶段三网关可能以 HTTP 200 返回业务 401；列表页必须明确提示登录过期，
 * 不能把鉴权失败伪装成正常的 0 条数据。其他错误保留服务端消息，缺失时才使用通用文案。
 */
const getIconListErrorMessage = (error: Error) => {
  const status = (error as Error & { code?: number; status?: number }).code
  if (status === 401) return '当前登录已过期，请重新登录'
  return error.message || '图片列表获取失败，请稍后重试'
}

const getList = async () => {
  const requestId = ++latestRequestId.value
  const params = buildListRequestParams()
  const requestKey = JSON.stringify(params)
  let request = inFlightListRequests.get(requestKey)

  if (!request) {
    request = createListRequest(params)
    inFlightListRequests.set(requestKey, request)
    void request.finally(() => {
      // 进行中的请求结束即释放；只删除自身，避免误删同键的后续请求。
      if (inFlightListRequests.get(requestKey) === request) {
        inFlightListRequests.delete(requestKey)
      }
    })
  }

  const [err, data] = await request

  // 过期响应不再写入列表，防止慢请求把用户已经切换到的新页数据覆盖掉。
  if (requestId !== latestRequestId.value) return

  if (err) {
    total.value = 0
    originList.value = []
    ElMessage.error(getIconListErrorMessage(err))
  } else {
    const responseTotal = data?.total || 0
    total.value = responseTotal
    // 无分类和顶部查询条件时，列表 total 可立即更新当前资源归属下的“全部”数量；
    // 独立统计请求随后会以相同归属补齐各分类数量。
    if (params.category === void 0 && params.status === void 0 && !params.iconName) {
      allCategoryTotal.value = responseTotal
    }
    originList.value = data?.rows || []
    void resolveIconUrls(originList.value, requestId)
  }
}

/** 保存后回到首屏，并同步刷新各分类数量，继续使用当前筛选和真实文件编号。 */
const refreshAfterSave = async () => {
  pagination.page = 1
  iconUrlByOssId.value.clear()
  await Promise.all([getList(), loadCategoryTotals(originCategories.value)])
}

onBeforeUnmount(() => {
  // 已离开的页面不接收迟到的列表、统计或签名结果，释放当前页持有的缓存。
  latestRequestId.value++
  latestCategoryTotalRequestId++
  inFlightListRequests.clear()
  iconUrlByOssId.value.clear()
})

const handlePaginationChange = (data: { page: number; size: number }) => {
  // 受控属性回写可能再次携带相同值；同值直接返回，保证一次分页交互只发出一次列表请求。
  if (pagination.page === data.page && pagination.size === data.size) return
  pagination.page = data.page
  pagination.size = data.size
  void getList()
}

/** 提交草稿筛选并复位页码；一轮点击只触发一次列表请求。 */
const applyFilters = () => {
  appliedFilters.search = search.value.trim()
  appliedFilters.status = selectedStatus.value
  pagination.page = 1
  void getList()
}

/**
 * 重置需同步草稿、已提交条件、分类和资源范围，再由唯一的 getList 发起请求。
 * 不调用 selectCategory，避免 reset 过程中产生两次接口请求。
 */
const resetFilters = () => {
  const resourceScopeChanged = activeTab.value !== 'all'
  activeTab.value = 'all'
  search.value = ''
  selectedStatus.value = 'all'
  selectedCategory.value = ''
  appliedFilters.search = ''
  appliedFilters.status = 'all'
  pagination.page = 1
  void getList()
  if (resourceScopeChanged) void loadCategoryTotals(originCategories.value)
}

/** 分类是卡片区的即时导航；同值点击不重复请求。 */
const selectCategory = (value: string) => {
  if (selectedCategory.value === value) return
  selectedCategory.value = value
  pagination.page = 1
  void getList()
}

const OperateActionMap = {
  [OperateEnum.Preview]: async (record: TransferListItem) => {
    // 预览弹窗同时展示分类、状态和更新时间，先保存完整记录，避免重复请求详情接口。
    previewRecord.value = record
    previewDialogVisible.value = true
    // 卡片和预览共用同一占位图；OSS 地址缺失时不把空路径传给图片组件，避免破损图片。
    previewPath.value = record.imgPath || CoverModel
    if (!record.iconFileId) return
    // 页面长时间停留后预览仍重新签发，过期签名不会成为永久图片地址。
    const [error, files] = await toData(getDim3dOssFileById(String(record.iconFileId)))
    if (!previewDialogVisible.value || previewRecord.value?.id !== record.id) return
    const file = files?.find((item) => String(item.ossId) === String(record.iconFileId))
    if (error || !file?.url) {
      previewPath.value = CoverModel
      ElMessage.error(error?.message || '图片读取失败，请重新加载')
      return
    }
    previewPath.value = file.url
  },
  [OperateEnum.Edit]: async (record: TransferListItem) => {
    if (!getCardCapabilities(record).canEdit) {
      return ElMessage.warning('当前图片不可编辑')
    }
    if (!record.id || String(record.id).startsWith('icon-')) {
      return ElMessage.warning('当前图片缺少有效编号，暂不能编辑')
    }
    const [error, response] = await to(getDim3dIconInfo(String(record.id)))
    if (error || !response?.data) return ElMessage.error('图片详情获取失败，请稍后重试')
    editRecord.value = { ...record, ...response.data, id: String(response.data.id || record.id) }
    addDialogVisible.value = true
  },
  [OperateEnum.ToggleStatus]: async (record: TransferListItem) => {
    if (!canUseResourceCardAction(getCardCapabilities(record), 'toggleStatus')) {
      return ElMessage.warning('当前图片不可切换状态')
    }
    if (!record.id || String(record.id).startsWith('icon-')) {
      return ElMessage.warning('当前图片缺少有效编号，暂不能切换上下线')
    }
    const targetStatus =
      record.status === 'ONLINE' ? 'OFFLINE' : record.status === 'OFFLINE' ? 'ONLINE' : undefined
    if (!targetStatus) return ElMessage.warning('当前图片状态未知，暂不能切换上下线')
    try {
      await openManageResourceStatusConfirm(targetStatus, '图片', record.name)
    } catch {
      return
    }
    const [error] = await to(changeDim3dIconStatus(targetStatus, String(record.id)))
    if (error) return ElMessage.error('图片状态更新失败，请稍后重试')
    void getList()
  },
  [OperateEnum.Delete]: (record: TransferListItem) => {
    if (!canUseResourceCardAction(getCardCapabilities(record), 'delete')) {
      return ElMessage.warning('当前图片不可删除')
    }
    openManageDeleteConfirm('资源', record.name).then(async () => {
      if (!record.id || String(record.id).startsWith('icon-')) {
        ElMessage.error('未获取到有效图片编号')
        return
      }
      const [error] = await to(removeDim3dIcon(String(record.id)))
      if (error) return ElMessage.error('图片删除失败，请稍后重试')
      void getList()
    })
  },
}

/** 更多菜单只显示当前状态的反向动作；未知状态不猜测业务操作。 */
const getStatusActionLabel = (record: TransferListItem) => {
  if (record.status === 'ONLINE') return '下线'
  if (record.status === 'OFFLINE') return '上线'
  return '--'
}

const handleOperate = (action: OperateEnum, record: TransferListItem) => {
  OperateActionMap[action]?.(record)
}

/**
 * 封面点击沿用图片管理页既有预览弹窗。页面已关闭整卡选择，
 * 这里仅处理业务预览，避免复制路径转换或弹窗状态逻辑。
 */
const handleMediaPreview = (record: TransferListItem) => {
  handleOperate(OperateEnum.Preview, record)
}

/** 图片管理只允许单条新增，由独立入口直接打开空白表单。 */
const openAddDialog = () => {
  editRecord.value = void 0
  addDialogVisible.value = true
}

/**
 * 图片预览底部的编辑操作复用卡片编辑处理器：先关闭预览，再请求详情并打开新增/编辑弹窗。
 * 这样不会叠加两个弹窗，也不复制详情查询与有效编号校验逻辑。
 */
const handlePreviewEdit = () => {
  const record = previewRecord.value
  if (!record) return
  previewDialogVisible.value = false
  handleOperate(OperateEnum.Edit, record)
}

</script>
