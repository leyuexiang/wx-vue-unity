import { cloneDeep } from 'lodash-es'
import type * as THREE from '@/types/legacyObjectPort'
import type BaseWidgetConfig from '@/packages/components/BaseWidgetConfig'
import { getChartPanelSchema } from '@/packages/components/Chart/shared/chartConfigMeta'
import { sanitizeChartStyleOption } from '@/packages/components/Chart/shared/chartStyleOption'
import { normalizeTreemapNodeValue } from '@/packages/components/Chart/shared/treemapTheme'
import {
  buildTableWidgetRuntimeOption,
  inferTableDataConfigFromOption,
  isTableWidgetKeyName,
} from '@/packages/components/Widget/shared/tableRuntime'
import { normalizeGoviewIconName } from '@/packages/components/Widget/Icon/iconCatalog'
import { createGoviewIconDataConfig } from '@/packages/components/Widget/Icon/iconRuntime'
import { inferWidgetDataConfigFromOption } from './widgetDataInference'
import { useSceneStore, useSceneWidgetStore } from '@/stores/sceneEditStore'
import type { DataPanelConfig } from '@/types/threeScene'
import {
  type AjaxRequestConfig,
  createEmptyDataConfig,
  DATA_CONFIG_VERSION,
  getDatasetFieldNames,
  isChartBindingRule,
  type PublicRequestConfig,
  type RequestGlobalConfig,
  type ComponentDataConfig,
  getDataConfigRequests,
  createDataConfigRequestItem,
  renameDataConfigRequests,
  syncDataConfigRequestMirror,
  DATA_REQUEST_ITEM_LIMIT,
} from '@/types/data-config'
import {
  composeChartTargetRows,
  resolveChartDimensionTargetField,
  resolveChartMeasureTargetField,
} from './multiRequestProtocol'
import { getPublicRequests, getRequestGlobalConfig } from './dataRequestHelpers'
import {
  createEmptyRequestParams,
  executeComponentRequestByType,
  transformRequestPayloadToRows,
  type DataRequestRuntimeContext,
} from './dataRequestExecution'
import {
  buildLegacyDataPanelConfigList,
  upgradeLegacyDataPanelConfigList,
} from './dataConfigLegacyAdapters'
import {
  applyWidgetBindings,
  normalizeBooleanValue,
  resolveComponentData,
} from './dataConfigRuntimeBindings'
import {
  inferChartDataConfigFromComponent as inferChartDataConfigFromComponentByOption,
  normalizeStaticChartEditorPayload as normalizeStaticChartEditorPayloadByChartFamily,
} from './chartDataInference'
import { buildChartRuntimeOption } from './chartRuntimeOptions'
import { buildComponentMappedDataFieldOptions } from './componentMappedData'
export {
  appendDataRequestItem,
  composeChartTargetRows,
  getDuplicateTargetFields,
  getAllTargetFields,
  getOccupiedDataConfigTargetFields,
  getOccupiedTargetFieldsBefore,
  getRequestTargetFields,
  isTargetFieldAvailable,
  mergeChartRequestSnapshots as mergeChartRequestSnapshotsByRequests,
  normalizeDataRequestItems,
  removeDataRequestItem,
  resolveChartDimensionTargetField,
  resolveChartMeasureTargetField,
} from './multiRequestProtocol'

export {
  findDatasetByConfig,
  findPublicRequestByConfig,
  getDatasets,
  getPublicRequests,
  getRequestGlobalConfig,
  mergeAjaxRequestWithGlobalConfig,
} from './dataRequestHelpers'
export {
  createEmptyRequestParams,
  customizeHttpRequest,
  executeRequestConfig,
  type DataRequestRuntimeContext,
  extractResult,
  intervalUnitHandle,
  newFunctionHandle,
  resolveDefaultRequestDataPayload,
  resolveRequestPayload,
  transformRequestPayloadToRows,
  translateStr,
} from './dataRequestExecution'
export {
  assertEmbeddedDataRequestUrl,
  getEmbeddedDataRequestHeaders,
  getEmbeddedSceneId,
} from './dataRequestSecurity'
export {
  buildLegacyDataPanelConfigList,
  upgradeLegacyDataPanelConfigList,
} from './dataConfigLegacyAdapters'
export {
  applyObjectBindings,
  applyWidgetBindings,
  createMarkingInstances,
  resolveComponentData,
} from './dataConfigRuntimeBindings'
export {
  buildChartEditorContent,
  inferChartPreviewContentFromComponent,
} from './chartDataInference'
export { applyChartData, buildChartDataset, buildChartRuntimeOption } from './chartRuntimeOptions'
export {
  buildComponentMappedDataFieldOptions,
  resolveComponentMappedDataRow,
} from './componentMappedData'
export {
  createEmptyDataConfig,
  createEmptyRequestGlobalConfig,
  getDatasetFieldNames,
  isChartBindingRule,
  isMarkingBindingRule,
  isObjectBindingRule,
  isWidgetBindingRule,
  MARKING_INSTANCE_LIMIT_DEFAULT,
  DATA_REQUEST_ITEM_LIMIT,
  getDataConfigRequests,
  createDataConfigRequestItem,
  renameDataConfigRequests,
  syncDataConfigRequestMirror,
  mergeChartRequestSnapshots,
  createStaticDataRequestItem,
  CHART_AUTO_MEASURE_FIELD_LIMIT,
} from '@/types/data-config'

export type {
  ComponentDataBindingRule,
  ComponentDataConfig,
  AjaxRequestConfig,
  DataBindingValueType,
  DataExtractor,
  DatasetRequestConfig,
  MarkingBindingTargetPath,
  MarkingGenerationRule,
  MarkingInstanceBuildResult,
  ObjectBindingRule,
  ObjectBindingTargetPath,
  PublicRequestConfig,
  PublicRequestReferenceConfig,
  RequestGlobalConfig,
  RequestHttpMethod,
  RequestIntervalUnit,
  RequestBodyType,
  RequestContentType,
  ComponentDataRequestItem,
  DataRequestConfig,
  WidgetBindingRule,
  WidgetBindingTargetPath,
} from '@/types/data-config'
export type { ChartBindingRule } from '@/types/data-config'

type AdapterCacheEntry = {
  key: string
  value: ComponentDataConfig | null
}

const adapterCache = new Map<string, AdapterCacheEntry>()
// 回放会用新部件快照替换组件，同编号的新对象不能命中旧配置。
const widgetConfigCache = new WeakMap<BaseWidgetConfig, { version: number; value: ComponentDataConfig | null }>()

const getWidgetSelectionKey = (widgetId: string) => `widget:${widgetId}`
const getMeshSelectionKey = (uuid: string) => `mesh:${uuid}`

const getSelectionKey = () => {
  const sceneStore = useSceneStore()
  const widgetStore = useSceneWidgetStore()
  const widgetId = widgetStore.currentWidgetsIds?.[0]

  if (widgetId) return getWidgetSelectionKey(widgetId)
  if (sceneStore.currentTransformMaterialUuid) {
    return getMeshSelectionKey(sceneStore.currentTransformMaterialUuid)
  }
  return null
}

/**
 * 图表运行时专用的数据解析：
 * - 普通分类图继续走统一二维表协议
 * - 仪表盘、雷达图、桑基图在静态模式下直接使用右侧原始编辑内容再归一化
 * 这样可以避免通用 `resolveComponentData()` 把特殊图表结构抹平成空数组或错误表结构。
 */
const resolveChartRuntimeSource = (
  component: BaseWidgetConfig,
  dataConfig: ComponentDataConfig,
) => {
  const chartSchema = getChartPanelSchema(component.info.keyName)

  if (dataConfig.request.type === 'static') {
    const rawStaticPayload = (dataConfig.request.config as { data?: unknown }).data

    if (chartSchema.family === 'gauge' || chartSchema.family === 'radar') {
      const normalizedChartPayload = normalizeStaticChartEditorPayload(
        component,
        rawStaticPayload,
        dataConfig,
      )
      return {
        dimensions: normalizedChartPayload.dimensions,
        source: normalizedChartPayload.source,
        raw: rawStaticPayload,
      }
    }

    if (chartSchema.family === 'sankey') {
      return {
        dimensions: dataConfig.dataset.dimensions,
        source: dataConfig.dataset.source,
        raw: rawStaticPayload,
      }
    }
  }

  // 非静态模式优先使用当前已经同步到配置里的数据，避免再次走通用解析丢失图表专属结构。
  if (Array.isArray(dataConfig.dataset.source) && dataConfig.dataset.source.length > 0) {
    return {
      dimensions: dataConfig.dataset.dimensions,
      source: dataConfig.dataset.source,
      raw: dataConfig.dataset.source,
    }
  }

  const resolved = resolveComponentData(dataConfig)
  return {
    dimensions: resolved.dimensions,
    source: resolved.source,
    raw: resolved.source,
  }
}

/**
 * 为仍保留在本文件中的图表推导链路提供一个最小行标准化入口。
 *
 * 请求执行链路已经迁移到独立模块，这里只保留“不带过滤器时的行归一化”薄包装，
 * 避免在继续拆分图表推导逻辑前引入额外回归。
 */
const normalizeResponseRows = (payload: unknown, resultPath?: string) =>
  transformRequestPayloadToRows(payload, resultPath)

/**
 * 对外保留旧的图表静态数据归一化入口。
 *
 * 新拆分模块内部通过依赖注入复用统一行标准化逻辑，
 * 但外部调用点仍然沿用历史三参签名，避免本轮拆分扩大改动范围。
 */
export const normalizeStaticChartEditorPayload = (
  component: BaseWidgetConfig,
  payload: unknown,
  currentConfig?: ComponentDataConfig | null,
) =>
  normalizeStaticChartEditorPayloadByChartFamily(
    component,
    payload,
    normalizeResponseRows,
    currentConfig,
  )

/**
 * 从当前图表组件的 chartOption 里反推一份可编辑的数据协议。
 * 这里的作用不是替代用户显式配置，而是保证首次打开“数据”面板时，
 * 右侧能直接展示当前图表实际正在使用的数据结构和默认映射。
 */
export const inferChartDataConfigFromComponent = (
  component: BaseWidgetConfig,
): ComponentDataConfig | null => {
  return inferChartDataConfigFromComponentByOption(component, normalizeResponseRows)
}

/**
 * 当图表已有 dataConfig 但缺少映射或缺少默认数据时，
 * 用当前图表 option 反推出的结果做“补齐”而不是“硬覆盖”。
 * 这样既能保留用户已经改过的请求类型、过滤器和数据源引用，
 * 又能保证右侧面板首次打开时能识别出当前图表的维度/度量字段。
 */
const mergeChartConfigWithInferred = (
  existing: ComponentDataConfig | null | undefined,
  inferred: ComponentDataConfig | null,
) => {
  const normalizedExisting = normalizeDataConfig(existing)
  if (!inferred) return normalizedExisting
  if (!normalizedExisting) return normalizeDataConfig(inferred)

  const next = cloneDeep(normalizedExisting)
  const inferredRule = inferred.bindings.find(isChartBindingRule)
  const currentRule = next.bindings.find(isChartBindingRule)

  /**
   * 旧版图表规则只保存来源字段，无法区分“组件需要的字段”和“接口提供的字段”。
   * 这里利用组件原始模板推导出的规则一次性补齐目标元数据；仅补空值，不覆盖新场景已经保存的目标定义。
   */
  if (currentRule && inferredRule) {
    // 显式空目标代表用户删除自动维度，不能被模板推导当作缺失值重新补回。
    if (currentRule.targetDimensionField === undefined) {
      currentRule.targetDimensionField =
        inferredRule.targetDimensionField || inferredRule.dimensionField
    }
    currentRule.targetMeasureFields = currentRule.measureFields.map(
      (_, index) => {
        const hasCurrentTarget =
          Array.isArray(currentRule.targetMeasureFields) &&
          index < currentRule.targetMeasureFields.length
        // 人工空白行和已删除自动行都使用显式空目标，保留它们而不回退到模板 dataN。
        if (hasCurrentTarget) return currentRule.targetMeasureFields?.[index] || ''
        return (
          inferredRule.targetMeasureFields?.[index] ||
          inferredRule.measureFields[index] ||
          `data${index + 1}`
        )
      },
    )
  }

  const lacksChartBinding =
    !currentRule ||
    !currentRule.dimensionField ||
    currentRule.measureFields.length === 0 ||
    currentRule.measureFields.every((field) => !field)

  if (lacksChartBinding && inferredRule) {
    next.bindings = [cloneDeep(inferredRule)]
  }

  const hasDatasetSource = Array.isArray(next.dataset.source) && next.dataset.source.length > 0
  const hasDatasetDimensions =
    Array.isArray(next.dataset.dimensions) && next.dataset.dimensions.length > 0
  const staticRequestData = (next.request.config as { data?: unknown })?.data
  const hasStaticRequestData = Array.isArray(staticRequestData) && staticRequestData.length > 0

  // 仅在当前配置本身没有可展示数据时，回填图表当前展示的数据。
  if (!hasDatasetSource && inferred.dataset.source.length > 0) {
    next.dataset.source = cloneDeep(inferred.dataset.source)
  }
  if (!hasDatasetDimensions && inferred.dataset.dimensions.length > 0) {
    next.dataset.dimensions = [...inferred.dataset.dimensions]
  }
  if (next.request.type === 'static' && !hasStaticRequestData) {
    next.request.config = {
      data: cloneDeep(inferred.dataset.source),
    }
  }

  return normalizeDataConfig(next)
}

const hasBindingSource = (binding: ComponentDataConfig['bindings'][number]) => {
  if (isChartBindingRule(binding)) {
    return Boolean(binding.dimensionField || binding.measureFields.some(Boolean))
  }

  return Boolean(binding.sourceField)
}

/**
 * 普通部件与表格部件的默认数据补齐。
 *
 * 这里只在静态配置没有任何可展示数据时回填组件 option 里的默认数据，
 * 避免覆盖用户已经配置好的接口、数据集、字段映射或自定义静态内容。
 */
const mergeDataConfigWithInferredDefaults = (
  existing: ComponentDataConfig | null | undefined,
  inferred: ComponentDataConfig | null,
) => {
  const normalizedExisting = normalizeDataConfig(existing)
  if (!inferred) return normalizedExisting
  if (!normalizedExisting) return normalizeDataConfig(inferred)
  if (normalizedExisting.request.type !== 'static') return normalizedExisting

  const next = cloneDeep(normalizedExisting)
  const staticRequestData = (next.request.config as { data?: unknown })?.data
  const hasStaticRequestData = Array.isArray(staticRequestData)
    ? staticRequestData.length > 0
    : staticRequestData !== undefined && staticRequestData !== null
  const hasDatasetSource = Array.isArray(next.dataset.source) && next.dataset.source.length > 0
  const hasDatasetDimensions =
    Array.isArray(next.dataset.dimensions) && next.dataset.dimensions.length > 0
  const hasBindings = next.bindings.some(hasBindingSource)

  if (!hasDatasetSource && inferred.dataset.source.length > 0) {
    next.dataset.source = cloneDeep(inferred.dataset.source)
  }
  if (!hasDatasetDimensions && inferred.dataset.dimensions.length > 0) {
    next.dataset.dimensions = [...inferred.dataset.dimensions]
  }
  if (!hasStaticRequestData && inferred.dataset.source.length > 0) {
    next.request.config = {
      data: cloneDeep(inferred.dataset.source),
    }
  }
  if (!hasBindings && inferred.bindings.length > 0) {
    next.bindings = cloneDeep(inferred.bindings)
  }

  return normalizeDataConfig(next)
}

const getSceneObjectByUuid = (uuid?: string | null) => {
  const sceneStore = useSceneStore()
  if (!uuid || !sceneStore.sceneApi?.scene) return null
  return sceneStore.sceneApi.scene.getObjectByProperty('uuid', uuid) as THREE.Object3D | null
}

/**
 * 修复首次集成矩形树图时生成的静态字段协议。
 *
 * 旧配置把真实的 `name/value` 数据改名为 `product/data1`，但组件目标仍是 `name/value`，
 * 造成面板来源字段与数据内容不一致。这里只迁移特征完全匹配的静态配置，不触碰用户主动
 * 使用 `product/data1` 的动态接口或其它图表，避免扩大兼容修复范围。
 */
export const migrateLegacyTreemapStaticDataConfig = (
  component: BaseWidgetConfig,
  dataConfig: ComponentDataConfig | null,
) => {
  if (!dataConfig || getChartPanelSchema(component.info.keyName).family !== 'treemap') {
    return dataConfig
  }

  const next = cloneDeep(dataConfig)
  let migrated = false
  getDataConfigRequests(next).forEach((requestItem) => {
    const binding = requestItem.bindings.find(isChartBindingRule)
    const isLegacyDefaultMapping =
      requestItem.request.type === 'static' &&
      binding?.dimensionField === 'product' &&
      binding.measureFields[0] === 'data1' &&
      binding.targetDimensionField === 'name' &&
      binding.targetMeasureFields?.[0] === 'value' &&
      requestItem.dataset.dimensions.includes('product') &&
      requestItem.dataset.dimensions.includes('data1')
    if (!binding || !isLegacyDefaultMapping) return

    const migrateRows = (payload: unknown) => {
      if (!Array.isArray(payload)) return payload
      return payload.map((row) => {
        if (!row || typeof row !== 'object') return row
        if (!('product' in row) && !('data1' in row)) return cloneDeep(row)
        const { product, data1, ...remaining } = row as Record<string, unknown>
        return { ...remaining, name: product ?? '', value: normalizeTreemapNodeValue(data1) }
      })
    }

    requestItem.dataset.dimensions = requestItem.dataset.dimensions.map((field) =>
      field === 'product' ? 'name' : field === 'data1' ? 'value' : field,
    )
    requestItem.dataset.source = migrateRows(requestItem.dataset.source) as Record<
      string,
      unknown
    >[]
    ;(requestItem.request.config as { data?: unknown }).data = migrateRows(
      (requestItem.request.config as { data?: unknown }).data,
    )
    binding.dimensionField = 'name'
    binding.measureFields = ['value']
    binding.chartDataShape = 'name-value'
    binding.seriesMode = 'single'
    migrated = true
  })

  if (migrated) syncDataConfigRequestMirror(next)
  return next
}

/**
 * 读取组件数据配置并按面板规则补齐可推导的默认数据。
 * 面板和交互执行器共用此入口；直接读取传入实例，不依赖选中态缓存，也不写回组件。
 * 图表从图表配置推导数据，普通控件从当前属性推导静态字段。
 */
export const getWidgetDataConfig = (component: BaseWidgetConfig) => {
  if (component.info.packageName === 'Chart') {
    const inferred = inferChartDataConfigFromComponent(component)
    const normalizedExisting = normalizeDataConfig(component.dataConfig || null)
    const migratedExisting = migrateLegacyTreemapStaticDataConfig(component, normalizedExisting)
    return mergeChartConfigWithInferred(migratedExisting, inferred)
  }

  if (component.info.packageName === 'Widget' && isTableWidgetKeyName(component.info.keyName)) {
    const normalizedExisting = normalizeDataConfig(component.dataConfig || null)

    /**
     * 表格部件的新实例没有 dataConfig，但 option 里已经带了默认表格数据。
     * 这里像图表一样反推一份静态数据配置，让右侧数据面板首次打开就能展示默认数据内容。
     */
    const inferred = inferTableDataConfigFromOption(
      component.info.keyName,
      (component.option || {}) as Record<string, unknown>,
    )
    return mergeDataConfigWithInferredDefaults(normalizedExisting, inferred)
  }

  if (component.info.packageName === 'Widget' && component.info.keyName === 'VIcon') {
    const normalizedExisting = normalizeDataConfig(component.dataConfig || null)

    /**
     * 兼容旧场景或异常数据：图标部件即便缺少 dataConfig，
     * 也能从 option.value / option.dataset 反推一份默认静态数据。
     */
    const option = (component.option || {}) as Record<string, unknown>
    const inferred = createGoviewIconDataConfig(
      normalizeGoviewIconName(option.value || option.dataset),
    )
    return mergeDataConfigWithInferredDefaults(normalizedExisting, inferred)
  }

  const inferred = inferWidgetDataConfigFromOption(
    component.info.packageName,
    component.info.keyName,
    (component.option || {}) as Record<string, unknown>,
  )
  return mergeDataConfigWithInferredDefaults(component.dataConfig || null, inferred)
}

/**
 * 显式读取二维画布部件的数据配置。
 *
 * 这条链路只按 widgetId 查找 `component.dataConfig`，
 * 不再回退到当前三维选中对象，避免二维数据面板误写 `mesh.userData`。
 */
export const getWidgetDataConfigById = (widgetId?: string | null): ComponentDataConfig | null => {
  if (!widgetId) return null

  const store = useSceneWidgetStore()
  const widget = store.getWidgetById(widgetId)
  if (!widget) return null

  const version = store.widgetRenderVersionMap?.[widgetId] ?? 0
  const cached = widgetConfigCache.get(widget.component)
  if (cached?.version === version) return cloneDeep(cached.value)

  const normalized = getWidgetDataConfig(widget.component)
  widgetConfigCache.set(widget.component, { version, value: normalized })
  return cloneDeep(normalized)
}

/**
 * 显式写回二维画布部件的数据配置。
 *
 * 保存目标固定为 `component.dataConfig`，并通过 WidgetCommand 记录历史；
 * 图表与普通控件都会在同步运行时 option 后递增自身渲染版本，确保画布的按部件缓存及时失效。
 * 版本更新只影响当前部件，不会触发其它部件重新构建运行时配置。
 */
export const setWidgetDataConfigById = (
  widgetId: string | null | undefined,
  dataConfig: ComponentDataConfig | null,
) => {
  if (!widgetId) return

  const widgetStore = useSceneWidgetStore()
  const widget = widgetStore.getWidgetById(widgetId)
  if (!widget) return

  const normalized = normalizeDataConfig(dataConfig)

  widgetStore.runWidgetHistoryChange('更新部件数据配置', [widget.id], () => {
    widget.component.dataConfig = normalized || undefined
    syncWidgetOptionFromDataConfig(widget.component)

    /**
     * 普通控件的数据绑定会用新对象替换 `component.option`。画布为避免拖拽时反复深拷贝，
     * 会按部件编号和渲染版本缓存旧 option；因此数据保存后必须主动递增当前部件版本，
     * 否则文字、输入框等控件仍会渲染保存前的旧对象。这里只刷新当前编号，保留增量渲染性能。
     */
    widgetStore.bumpWidgetRenderVersion(widget.id)
  })
  invalidateSelectedDataConfigCache(getWidgetSelectionKey(widget.id))
}

/**
 * 显式读取三维场景对象的数据配置。
 *
 * 这条链路只按 Three 对象 uuid 访问 `mesh.userData`，
 * 不再回退到当前二维部件，保证三维图片、标注、打点等对象仍走原协议。
 */
export const getSceneObjectDataConfigByUuid = (
  uuid?: string | null,
): ComponentDataConfig | null => {
  if (!uuid) return null

  const selectionKey = getMeshSelectionKey(uuid)
  const cached = adapterCache.get(selectionKey)
  if (cached) return cloneDeep(cached.value)

  const mesh = getSceneObjectByUuid(uuid)
  if (!mesh) return null

  const existing = (mesh.userData.dataConfig as ComponentDataConfig | undefined) || null
  const upgraded =
    existing ||
    upgradeLegacyDataPanelConfigList(
      mesh.userData.datasetConfigList as DataPanelConfig[] | undefined,
      mesh.userData.type as string | undefined,
    )
  const normalized = upgraded ? normalizeDataConfig(upgraded) : null
  adapterCache.set(selectionKey, { key: selectionKey, value: normalized })
  return cloneDeep(normalized)
}

/**
 * 显式写回三维场景对象的数据配置。
 *
 * 保存目标固定为 `mesh.userData.dataConfig` 和兼容旧协议的 `datasetConfigList`，
 * 不再尝试读取或修改二维部件配置。
 */
export const setSceneObjectDataConfigByUuid = (
  uuid: string | null | undefined,
  dataConfig: ComponentDataConfig | null,
) => {
  if (!uuid) return

  const mesh = getSceneObjectByUuid(uuid)
  if (!mesh) return

  const normalized = normalizeDataConfig(dataConfig)
  mesh.userData.dataConfig = normalized
  mesh.userData.datasetConfigList = buildLegacyDataPanelConfigList(normalized)
  invalidateSelectedDataConfigCache(getMeshSelectionKey(uuid))
}

/**
 * 让当前选中目标的数据配置缓存失效。
 *
 * 右侧数据面板会对“当前选中对象/部件”的标准化结果做短暂缓存，
 * 当保存、切换请求类型或外部直接改写配置后，需要主动清掉这份缓存，
 * 避免后续读取仍然命中旧快照。
 *
 * @param key 显式指定要失效的缓存键；不传时自动使用当前选中项对应的键。
 */
export const invalidateSelectedDataConfigCache = (key?: string | null) => {
  const targetKey = key || getSelectionKey()
  if (!targetKey) return
  if (targetKey.startsWith('widget:')) {
    const widget = useSceneWidgetStore().getWidgetById(targetKey.slice('widget:'.length))
    if (widget) widgetConfigCache.delete(widget.component)
    return
  }
  adapterCache.delete(targetKey)
}

/**
 * 获取当前选中对象或部件的标准化数据配置。
 *
 * 读取顺序为：缓存 -> 当前 widget -> 当前 mesh -> 历史协议升级。
 * 返回值始终是深拷贝，调用方可以安全编辑，不会直接污染缓存或宿主对象。
 *
 * @returns 当前选中目标可编辑的数据配置；若当前没有有效选中项则返回 `null`。
 */
export const getSelectedDataConfig = (): ComponentDataConfig | null => {
  const selectionKey = getSelectionKey()
  if (!selectionKey) return null

  if (selectionKey.startsWith('widget:')) {
    return getWidgetDataConfigById(selectionKey.slice('widget:'.length))
  }

  return getSceneObjectDataConfigByUuid(selectionKey.slice('mesh:'.length))
}

/**
 * 将当前选中对象或控件的数据配置写回真实宿主。
 *
 * 这里统一处理标准化、缓存失效以及 widget 运行时 option 同步，
 * 避免不同入口重复拼写同一套保存逻辑。
 */
export const setSelectedDataConfig = (dataConfig: ComponentDataConfig | null) => {
  const selectionKey = getSelectionKey()
  if (!selectionKey) return

  if (selectionKey.startsWith('widget:')) {
    setWidgetDataConfigById(selectionKey.slice('widget:'.length), dataConfig)
    return
  }

  setSceneObjectDataConfigByUuid(selectionKey.slice('mesh:'.length), dataConfig)
}

/**
 * 把任意来源的数据配置整理成当前版本的标准结构。
 *
 * 这个入口同时服务历史场景升级、右侧表单保存和运行时读取，
 * 目标是让后续链路只面对一套稳定协议。
 */
export const normalizeDataConfig = (
  dataConfig: ComponentDataConfig | null | undefined,
): ComponentDataConfig | null => {
  if (!dataConfig) return null

  const normalized = cloneDeep(dataConfig)
  normalized.version = DATA_CONFIG_VERSION
  normalized.dataset ||= { dimensions: [], source: [] }
  normalized.bindings ||= []
  normalized.extractor ||= {}

  // 多请求配置统一收敛为最多五项，并让旧镜像字段继续指向首项。
  const requestItems = getDataConfigRequests(normalized)
    .slice(0, DATA_REQUEST_ITEM_LIMIT)
    .map((item, index) =>
      createDataConfigRequestItem({
        ...item,
        name: `请求${index + 1}`,
        request: item.request || normalized.request,
        dataset: item.dataset || normalized.dataset,
        bindings: item.bindings || normalized.bindings,
      }),
    )
  normalized.requests = requestItems.length > 0 ? requestItems : [createDataConfigRequestItem()]
  syncDataConfigRequestMirror(normalized)

  // 逐项补全 AjaxRequestConfig，避免第二个及后续请求缺少默认参数。
  normalized.requests.forEach((item) => {
    if (item.request.type !== 'ajax') return
    const cfg = item.request.config as AjaxRequestConfig
    cfg.requestContentType ||= 'default'
    cfg.requestParamsBodyType ||= 'none'
    cfg.requestParams ||= createEmptyRequestParams()
    cfg.requestSQLContent ||= { sql: '' }
    // 旧 requestBody 字符串迁移到 requestParams.Body.json
    if (cfg.requestBody && !cfg.requestParams.Body.json) {
      cfg.requestParams.Body.json = cfg.requestBody
      if (!cfg.requestParamsBodyType || cfg.requestParamsBodyType === 'none') {
        cfg.requestParamsBodyType = 'json'
      }
    }
    cfg.requestIntervalUnit ||= 'second'
  })

  // 兼容旧 PublicRequestConfig
  if (normalized.request.type === 'public') {
    // PublicRequestReferenceConfig 不需要补字段
  }

  return normalized
}

/**
 * 执行一次组件数据请求，并把结果统一标准化成二维表。
 *
 * 当请求类型本身不需要远程调用时，会自动回退到本地解析链路，
 * 保证调用方始终收到同一结构。
 */
export const executeComponentDataRequest = async (
  dataConfig: ComponentDataConfig | null | undefined,
  publicRequests: PublicRequestConfig[] = getPublicRequests(),
  globalConfig: RequestGlobalConfig = getRequestGlobalConfig(),
  runtimeContext?: DataRequestRuntimeContext,
) => {
  const results = await executeComponentDataRequests(dataConfig, publicRequests, globalConfig, runtimeContext)
  const source = results.reduce<Record<string, unknown>[]>((rows, result) => {
    result.source.forEach((row: Record<string, unknown>, index: number) => {
      rows[index] = { ...(rows[index] || {}), ...row }
    })
    return rows
  }, [])
  const dimensions = Array.from(new Set(results.flatMap((result) => result.dimensions)))
  /**
   * 单请求保留接口原始响应形态，确保数据面板再次编辑过滤器时，`data` 与 `res` 参数和首次
   * 请求执行完全一致；只有真正的多请求才返回逐请求原始值数组，避免单请求被无端包成二维数组。
   */
  const raw = results.length === 1 ? results[0].raw : results.map((result) => result.raw)
  return { dimensions, source, raw }
}

/**
 * 独立执行组件内的每个请求项。
 * 静态与数据集请求只读取本地配置，动态和公共接口才进入网络请求执行器。
 */
export const executeComponentDataRequests = async (
  dataConfig: ComponentDataConfig | null | undefined,
  publicRequests: PublicRequestConfig[] = getPublicRequests(),
  globalConfig: RequestGlobalConfig = getRequestGlobalConfig(),
  runtimeContext?: DataRequestRuntimeContext,
) => {
  if (!dataConfig) return []
  const normalized = normalizeDataConfig(dataConfig)
  if (!normalized) return []
  const requests = getDataConfigRequests(normalized)
  return Promise.all(
    requests.map(async (item) => {
      const itemConfig: ComponentDataConfig = {
        ...normalized,
        request: item.request,
        extractor: item.extractor,
        dataset: item.dataset,
        bindings: item.bindings,
        filterFn: item.filterFn,
        requests: [item],
      }
      const requestResult = await executeComponentRequestByType(
        itemConfig,
        publicRequests,
        globalConfig,
        runtimeContext,
      )
      if (requestResult) return requestResult
      const resolved = resolveComponentData(itemConfig)
      return { dimensions: resolved.dimensions, source: resolved.source, raw: resolved.source }
    }),
  )
}

/**
 * 根据组件当前的数据配置构建运行时 option。
 *
 * 图表会按图表族重写 `chartOption` 中的数据部分；
 * 普通控件则把当前首条记录映射到运行时字段，保证渲染层始终消费最新结果。
 *
 * @param component 目标组件配置。
 * @returns 已融合数据映射结果的运行时 option；若没有数据配置则返回原始 option 副本。
 */
export const buildWidgetRuntimeOption = (component: BaseWidgetConfig) => {
  const baseOption = cloneDeep(component.option || {})
  // 逐条翻页映射仅作为详情事件的数据来源，不能把业务字段写入按钮外观或分页适配配置。
  if (component.info.keyName === 'VRecordPagination') return baseOption
  if (component.info.packageName !== 'Chart') {
    const dataConfig = normalizeDataConfig(component.dataConfig)
    if (!dataConfig) return baseOption

    const resolved = resolveComponentData(dataConfig)
    const requestItems = getDataConfigRequests(dataConfig)
    /**
     * 单请求时根镜像与首项共享引用，可以直接回写解析结果；多请求时必须保留每项自己的
     * 数据快照，不能把合并后的总行写回请求1，否则请求1的来源会被后续请求覆盖。
     */
    if (requestItems.length <= 1) {
      dataConfig.dataset.dimensions = resolved.dimensions
      dataConfig.dataset.source = resolved.source
    }

    if (component.info.packageName === 'Widget' && isTableWidgetKeyName(component.info.keyName)) {
      /**
       * 表格部件和普通输入控件不同，需要消费整份二维数据。
       * 这里直接按 dataConfig 的标准结果重建 dataset/header，避免只把首行映射到 value。
       */
      return buildTableWidgetRuntimeOption(
        component.info.keyName,
        baseOption,
        resolved.source,
        resolved.dimensions,
        dataConfig.bindings
          .filter((binding): binding is Extract<typeof binding, { kind: 'widget' }> => binding.kind === 'widget')
          .map((binding) => ({ targetPath: binding.targetPath, sourceField: binding.sourceField })),
      )
    }

    /**
     * 控件统一按首条记录消费。
     * 这样它和图表一样都走 widget 体系，但不会误用 3D 对象的变换映射。
     */
    const draftComponent = {
      ...component,
      option: cloneDeep(baseOption),
    } as BaseWidgetConfig

    if (requestItems.length > 1) {
      /**
       * 多请求的来源字段允许同名，但目标字段由面板保证全局唯一。
       * 因此必须让每条映射读取所属请求的数据，而非读取已合并的总行；否则后序请求的
       * 同名来源字段会覆盖前序值，导致属性映射看似保存成功却在运行时取错数据。
       */
      requestItems.forEach((item) => {
        const rows = item.dataset.source || []
        applyWidgetBindings(draftComponent, item.bindings, rows[0] || null, rows)
      })
    } else {
      applyWidgetBindings(
        draftComponent,
        dataConfig.bindings,
        resolved.source[0] || null,
        resolved.source || [],
      )
    }
    return draftComponent.option
  }

  const dataConfig = normalizeDataConfig(component.dataConfig)
  if (!dataConfig) return baseOption

  const requestItems = getDataConfigRequests(dataConfig)
  const chartRules = requestItems.flatMap((item) => item.bindings.filter(isChartBindingRule))
  const chartRule = chartRules[0] || dataConfig.bindings.find(isChartBindingRule)
  if (!chartRule || chartRule.useDataset === false) return baseOption

  const runtimeResolved =
    requestItems.length > 1
      ? {
          dimensions: Array.from(
            new Set(
              chartRules
                .flatMap((rule) => [
                  // 显式空目标代表用户删除或暂存的映射，不能再回退为来源字段。
                  resolveChartDimensionTargetField(rule),
                  ...rule.measureFields.map((_, index) =>
                    resolveChartMeasureTargetField(rule, index),
                  ),
                ])
                .filter(Boolean),
            ),
          ),
          source: composeChartTargetRows(
            requestItems.map((item) => ({
              rows: item.dataset.source || [],
              bindings: item.bindings,
            })),
          ),
          raw: requestItems.map((item) => item.dataset.source || []),
        }
      : resolveChartRuntimeSource(component, dataConfig)
  if (requestItems.length <= 1 && runtimeResolved.dimensions.length > 0) {
    dataConfig.dataset.dimensions = runtimeResolved.dimensions
  }
  if (requestItems.length <= 1) {
    dataConfig.dataset.source = runtimeResolved.source
  }

  const mergedChartRule =
    chartRules.length > 1
      ? (() => {
          /**
           * 多请求快照已经按组件目标字段生成（例如 product/data1/data2），
           * 因而运行时图表规则也必须改用目标字段作为“来源”读取，不能继续使用
           * 各请求接口里的 category/value 等原始字段名，否则合成后的行数据无法命中。
           */
          const targetDimensionField = chartRules
            .map((rule) => resolveChartDimensionTargetField(rule))
            .find(Boolean)
          const targetMeasureFields = chartRules.flatMap((rule) =>
            rule.measureFields
              .map((_, index) => resolveChartMeasureTargetField(rule, index))
              .filter(Boolean),
          )
          return {
            ...chartRule,
            dimensionField: targetDimensionField || '',
            measureFields: targetMeasureFields,
            targetDimensionField: targetDimensionField || '',
            targetMeasureFields,
          }
        })()
      : chartRule
  /**
   * 多请求图表的根级 dataConfig 仍镜像请求1，不能把合成数据回写进去。
   * 这里创建仅供本次渲染使用的轻量快照，让图表构建读取 product/dataN 等目标字段，
   * 同时保持每个请求自身的 dataset.source 不被其它请求覆盖。
   */
  const runtimeDataConfig =
    requestItems.length > 1
      ? {
          ...dataConfig,
          dataset: {
            dimensions: runtimeResolved.dimensions,
            source: runtimeResolved.source,
          },
        }
      : dataConfig
  return buildChartRuntimeOption(
    component,
    baseOption,
    runtimeDataConfig,
    mergedChartRule,
    runtimeResolved,
  )
}

/**
 * 控件显隐由绑定后的 option.visible 决定；未配置时默认为显示。
 * 图表也允许复用这个字段，避免结构层再做 packageName 分支。
 */
export const isWidgetVisible = (component: BaseWidgetConfig) => {
  const runtimeOption = buildWidgetRuntimeOption(component) as Record<string, unknown>
  if (!('visible' in runtimeOption)) return true
  return normalizeBooleanValue(runtimeOption.visible)
}

/**
 * 图表保存数据配置后，只清理持久化 `chartOption` 中残留的数据字段。
 *
 * 新边界要求 `chartOption` 是样式模板，真实数据主副本固定在 `component.dataConfig`：
 * - 默认拖入图表仍可先在 `chartOption` 里带示例数据，方便首次渲染和数据面板反推；
 * - 一旦数据面板保存成功，就把历史示例数据从样式模板中剥离；
 * - 渲染时再由 `buildWidgetRuntimeOption()` 临时把样式模板和 `dataConfig` 组合成运行时 option。
 */
const syncChartStyleOptionAfterDataConfig = (component: BaseWidgetConfig) => {
  if (component.info.packageName !== 'Chart') return
  if (!component.dataConfig) return

  const currentOption = cloneDeep((component.option || {}) as Record<string, unknown>)
  component.option = {
    ...currentOption,
    chartOption: sanitizeChartStyleOption(currentOption.chartOption),
  }
}

/**
 * widget 保存数据配置后的持久化同步入口。
 *
 * 图表和普通控件的持久化规则不同：
 * - 图表：只保留样式模板，真实数据不反写到 `chartOption`，避免基础面板和样式 JSON 再暴露数据；
 * - 控件：同步完整运行时 option，确保 `value / options / visible` 与当前映射结果一致。
 */
export const syncWidgetOptionFromDataConfig = (component: BaseWidgetConfig) => {
  if (!component.dataConfig) return

  if (component.info.packageName === 'Chart') {
    syncChartStyleOptionAfterDataConfig(component)
    return
  }

  const nextOption = buildWidgetRuntimeOption(component) as Record<string, unknown>
  component.option = cloneDeep(nextOption)
}

/**
 * 根据当前数据配置提取可供绑定面板使用的字段列表。
 *
 * 当调用方没有传入配置时，会回退到一份空配置，
 * 保证字段提取链路始终返回稳定数组，而不是在 UI 层反复判空。
 *
 * @param dataConfig 当前组件的数据配置。
 * @returns 去重后的字段名列表，供下拉框、条件规则和映射面板复用。
 */
export const buildDataConfigFieldOptions = (dataConfig: ComponentDataConfig | null | undefined) =>
  buildComponentMappedDataFieldOptions(normalizeDataConfig(dataConfig) || createEmptyDataConfig())
