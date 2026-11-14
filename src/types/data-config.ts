import type { DataPanelConfig, Dataset, DatasetProperty } from './threeScene'

export const DATA_CONFIG_VERSION = 2
/** 单个数据请求的最大数量，静态请求也计入该上限。 */
export const DATA_REQUEST_ITEM_LIMIT = 5
/**
 * 图表自动映射可使用的度量槽位数量。
 *
 * `data1`、`data2` 是当前图表数据协议公开的固定目标字段；请求数量只代表数据来源数量，
 * 不能因为来源增加就继续虚构 `data3`、`data4` 等组件并不消费的字段。人工自定义目标仍由
 * 用户显式控制，不在这个自动槽位上限内强行删除。
 */
export const CHART_AUTO_MEASURE_FIELD_LIMIT = 2
export const MARKING_INSTANCE_LIMIT_DEFAULT = 2000

export type DataRequestType = 'static' | 'dataset' | 'ajax' | 'public' | 'adapter'
export type DataBindingValueType = 'boolean' | 'number' | 'vector3' | 'euler' | 'string'
export type ObjectBindingTargetPath = 'visible' | 'position' | 'rotation' | 'scale'
export type MarkingBindingTargetPath = 'position' | 'rotation' | 'scale' | 'visible'
/**
 * 二维组件允许接收的数据目标属性。
 * `total` 与 `pageSize` 仅供分页器使用；其它组件仍由数据面板按组件类型限制可见目标。
 */
export type WidgetBindingTargetPath = 'visible' | 'value' | 'options' | 'total' | 'pageSize'
export type ChartSeriesMode = 'single' | 'multi'
export type ChartDataShape = 'category-value' | 'name-value'
/** 图表目标字段的创建来源：自动识别字段不可改名但可删除，人工字段允许改名和删除。 */
export type ChartMappingFieldOrigin = 'inferred' | 'manual'
export type RequestHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
export type RequestIntervalUnit = 'second' | 'minute' | 'hour' | 'day'
export type RequestBodyType = 'none' | 'json' | 'xml' | 'form-data' | 'x-www-form-urlencoded'
export type RequestContentType = 'default' | 'sql'

export type ThreeMapDatasetRole = 'province' | 'flight' | 'point'
export type ThreeMapTargetField =
  | 'provinceName'
  | 'value'
  | 'label'
  | 'labelEn'
  | 'color'
  | 'visible'
  | 'popup'
  | 'infoTitle'
  | 'infoContent'
  | 'infoLevel'
  | 'id'
  | 'name'
  | 'sourceProvince'
  | 'sourceLongitude'
  | 'sourceLatitude'
  | 'targetProvince'
  | 'targetLongitude'
  | 'targetLatitude'
  | 'arcHeight'
  | 'width'
  | 'speed'
  | 'longitude'
  | 'latitude'
  | 'level'
  | 'size'
  | 'icon'

/** 中国 3D 地图使用固定目标协议，区别于普通三维对象只保存的任意自定义路径。 */
export interface ThreeMapBindingRule {
  kind: 'three-map'
  datasetRole: ThreeMapDatasetRole
  sourceField: string
  targetField: ThreeMapTargetField
  valueType: 'string' | 'number' | 'boolean' | 'color'
}

export interface DataExtractor {
  resultPath?: string
}

export interface StaticRequestConfig {
  data: unknown
}

export interface DatasetRequestConfig {
  datasetProperty: DatasetProperty | null
}

export interface AjaxRequestConfig {
  requestHttpType: RequestHttpMethod
  requestInterval: number | null
  requestIntervalUnit: RequestIntervalUnit
  requestOriginUrl: string
  /** 地址支持 ${params.id} 引用查询参数同名字段；发送时编码替换，不重复追加该查询参数。 */
  requestUrl: string
  requestName?: string
  requestContentType: RequestContentType
  requestParamsBodyType: RequestBodyType
  requestHeaders?: Record<string, string>
  requestQuery?: Record<string, string>
  requestBody?: string
  requestParams: {
    Params: Record<string, string>
    Header: Record<string, string>
    Body: {
      'form-data': Record<string, string>
      'x-www-form-urlencoded': Record<string, string>
      json: string
      xml: string
    }
  }
  requestSQLContent: { sql: string }
  resultPath?: string
  useAuth?: boolean
}

/**
 * 场景级全局请求配置。
 *
 * 这份配置不再挂在某一个控件/图表的请求对象上，而是作为整个场景共享的默认值：
 * - requestOriginUrl：统一的前置 URL
 * - requestInterval / requestIntervalUnit：统一的默认轮询间隔
 * - requestParams.Header：统一注入到所有动态请求 / 公共接口的 Header
 *
 * 具体到单个请求时，局部配置仍然可以覆盖这些默认值。
 */
export interface RequestGlobalConfig {
  requestOriginUrl: string
  requestInterval: number | null
  requestIntervalUnit: RequestIntervalUnit
  requestParams: {
    Header: Record<string, string>
  }
}

export interface PublicRequestConfig extends AjaxRequestConfig {
  id: string
  name: string
}

export interface PublicRequestReferenceConfig {
  publicRequestId: string | null
}

/** 扩展数据源适配器配置；具体字段由 adapterId 对应的适配器校验。 */
export interface AdapterRequestConfig {
  adapterId: string
  config: unknown
}

/** 每个请求项都使用同一套请求配置联合类型。 */
export type DataRequestConfig =
  | StaticRequestConfig
  | DatasetRequestConfig
  | AjaxRequestConfig
  | PublicRequestReferenceConfig
  | AdapterRequestConfig

export interface ObjectBindingRule {
  kind: 'object'
  targetPath: ObjectBindingTargetPath
  sourceField: string
  valueType: DataBindingValueType
}

/**
 * 三维对象的人工扩展映射。
 *
 * 用户可在属性面板中录入任意目标字段，以便先保存业务数据语义，再由后续运行时能力按需消费。
 * `object` 规则仍只承载当前 Three 运行时已支持的四个属性；两类规则分开建模，避免未知字段被
 * 错误地写入 Object3D，也避免降低已有运行时映射的类型约束。
 */
export interface CustomObjectBindingRule {
  kind: 'object-custom'
  /** 人工行的稳定标识，用于目标字段改名后仍能精确更新和删除当前行。 */
  id: string
  /** 用户输入的目标字段；允许为空，以稳定保留刚新增但尚未填写的编辑行。 */
  targetPath: string
  /** 统一数据集中的来源字段；允许为空，等待用户稍后手动选择。 */
  sourceField: string
  /** 自定义字段本期只持久化，不参与 Three 运行时值转换。 */
  valueType: 'string'
}

export interface ChartBindingRule {
  kind: 'chart'
  /**
   * 图表组件内部需要接收的维度字段名称，仅用于描述映射目标。
   *
   * 例如柱状图的 `product`、饼图的 `name`。该字段不会用于读取接口返回值，
   * 因而不能与下面的 `dimensionField` 共用，否则用户更换接口字段后会丢失目标语义。
   */
  targetDimensionField?: string
  /**
   * 图表组件内部需要接收的度量字段名称，顺序与 `measureFields` 一一对应。
   *
   * 该数组只记录“组件需要什么”，真正从接口读取哪些字段仍由 `measureFields` 保存。
   * 使用可选字段保持旧场景兼容；加载旧数据时由图表类型和原始模板自动补齐。
   */
  targetMeasureFields?: string[]
  /**
   * 每个目标度量字段的创建来源，顺序与目标字段、来源字段数组一一对应。
   * 新建场景会完整写入该数组；缺失标记的运行中数据按自动识别项保护。
   */
  targetMeasureFieldOrigins?: ChartMappingFieldOrigin[]
  /** 接口或数据集中的维度来源字段。 */
  dimensionField: string
  /** 接口或数据集中的度量来源字段。 */
  measureFields: string[]
  seriesMode: ChartSeriesMode
  chartDataShape: ChartDataShape
  useDataset?: boolean
}

export interface MarkingGenerationRule {
  kind: 'marking'
  /** 实例内置属性或用户新增的自定义实例字段。 */
  targetPath: string
  sourceField: string
  valueType: DataBindingValueType
  required?: boolean
  /** 自定义映射行的稳定编号；内置固定目标不设置。 */
  id?: string
}

/**
 * 控件与图表同属 widget 体系，但当前右侧“属性映射”只对控件暴露值语义：
 * - value: 控制输入值 / 选中值
 * - options: 控制下拉选项列表
 * - total / pageSize: 分页器的总条数 / 每页条数
 *
 * 这里仍保留 `visible` 类型声明，用于兼容旧场景中已经保存过的控件显隐绑定，
 * 避免历史配置在加载时直接失效。
 */
export interface WidgetBindingRule {
  kind: 'widget'
  /** 部件内置属性或用户新增的自定义部件字段。 */
  targetPath: string
  sourceField: string
  valueType: DataBindingValueType
  /** 自定义映射行的稳定编号；内置固定目标不设置。 */
  id?: string
}

export type ComponentDataBindingRule =
  | ObjectBindingRule
  | CustomObjectBindingRule
  | ChartBindingRule
  | MarkingGenerationRule
  | WidgetBindingRule
  | ThreeMapBindingRule

/**
 * 组件内的一条独立请求配置。
 * 请求项拥有自己的数据集、过滤器和映射，避免多个来源互相覆盖。
 */
export interface ComponentDataRequestItem {
  /** 持久化稳定编号；删除或排序不会改变该值。 */
  id: string
  /** 面板显示名称按顺序生成，首项固定为“请求1”。 */
  name: string
  /** 仅控制面板展示，不参与数据保存和运行时计算。 */
  collapsed?: boolean
  request: {
    type: DataRequestType
    config: DataRequestConfig
  }
  extractor?: DataExtractor
  dataset: {
    dimensions: string[]
    source: Record<string, unknown>[]
  }
  bindings: ComponentDataBindingRule[]
  filterFn?: string
  /** 地图角色独立于字段映射保存，允许先选择飞线或点位，再逐项绑定来源字段。 */
  threeMapRole?: ThreeMapDatasetRole
  /** 地图多请求按角色合并或替换；普通组件缺失时继续沿用 merge。 */
  mergeMode?: 'merge' | 'replace'
  /** 自动映射项被用户删除后的目标字段，刷新字段时不得再次生成。 */
  deletedAutoMappingTargets?: string[]
}

export interface ComponentDataConfig {
  version: number
  /** 当前编辑请求选择的地图角色；旧配置缺失时从映射规则推断。 */
  threeMapRole?: ThreeMapDatasetRole
  /** 地图请求项在面板编辑期间的角色合并策略；持久化时进入对应 requests 项。 */
  mergeMode?: 'merge' | 'replace'
  /** 多请求协议；未提供时由标准化函数按单请求字段生成一项。 */
  requests?: ComponentDataRequestItem[]
  request: {
    type: DataRequestType
    config: DataRequestConfig
  }
  extractor?: DataExtractor
  dataset: {
    dimensions: string[]
    source: Record<string, unknown>[]
  }
  bindings: ComponentDataBindingRule[]
  filterFn?: string
  /** 早期面板实现可能把自动映射删除记录暂存于根配置，读取时同样保留。 */
  deletedAutoMappingTargets?: string[]
}

export interface MarkingInstanceBuildResult<T = Record<string, unknown>> {
  instances: T[]
  truncated: boolean
  total: number
}

export const isChartBindingRule = (rule: ComponentDataBindingRule): rule is ChartBindingRule =>
  rule.kind === 'chart'

export const isObjectBindingRule = (rule: ComponentDataBindingRule): rule is ObjectBindingRule =>
  rule.kind === 'object'

export const isThreeMapBindingRule = (
  rule: ComponentDataBindingRule,
): rule is ThreeMapBindingRule => rule.kind === 'three-map'

/** 判断是否为仅保存、不直接驱动 Three 运行时的人工三维扩展映射。 */
export const isCustomObjectBindingRule = (
  rule: ComponentDataBindingRule,
): rule is CustomObjectBindingRule => rule.kind === 'object-custom'

export const isMarkingBindingRule = (
  rule: ComponentDataBindingRule,
): rule is MarkingGenerationRule => rule.kind === 'marking'

export const isWidgetBindingRule = (rule: ComponentDataBindingRule): rule is WidgetBindingRule =>
  rule.kind === 'widget'

/**
 * 创建带默认“请求1”的空配置。
 * `exampleData` 用于传入组件原始示例数据；不传时仍得到空静态表，且不会触发网络请求。
 */
export const createEmptyDataConfig = (exampleData: unknown = []): ComponentDataConfig => {
  const source = Array.isArray(exampleData)
    ? exampleData.map((row) =>
        row && typeof row === 'object' && !Array.isArray(row)
          ? { ...(row as Record<string, unknown>) }
          : { value: row },
      )
    : exampleData && typeof exampleData === 'object'
      ? [{ ...(exampleData as Record<string, unknown>) }]
      : exampleData === undefined || exampleData === null
        ? []
        : [{ value: exampleData }]
  const dimensions = source[0] ? Object.keys(source[0]) : []
  const firstRequest: ComponentDataRequestItem = {
    id: 'request-1',
    name: '请求1',
    collapsed: false,
    request: { type: 'static', config: { data: source } },
    extractor: { resultPath: '' },
    dataset: { dimensions, source },
    bindings: [],
    filterFn: '',
    deletedAutoMappingTargets: [],
  }

  // 首项镜像字段供尚未迁移的调用点读取；新链路使用 requests。
  const config: ComponentDataConfig = {
    version: DATA_CONFIG_VERSION,
    requests: [firstRequest],
    request: firstRequest.request,
    extractor: firstRequest.extractor,
    dataset: firstRequest.dataset,
    bindings: firstRequest.bindings,
    filterFn: firstRequest.filterFn,
  }

  /**
   * 新协议以 requests 为唯一数据源，但保留根级镜像的可写兼容入口。
   * 使用访问器让旧调用点直接替换 `config.dataset` 或 `config.bindings` 时同步更新请求1，
   * 避免同一份内存配置出现两套不一致的数据；序列化后仍由 requests 作为权威来源。
   */
  const resolveFirstRequest = () => config.requests?.[0] || firstRequest
  Object.defineProperties(config, {
    request: {
      configurable: true,
      enumerable: true,
      get: () => resolveFirstRequest().request,
      set: (value: ComponentDataConfig['request']) => {
        resolveFirstRequest().request = value
      },
    },
    extractor: {
      configurable: true,
      enumerable: true,
      get: () => resolveFirstRequest().extractor,
      set: (value: ComponentDataConfig['extractor']) => {
        resolveFirstRequest().extractor = value
      },
    },
    dataset: {
      configurable: true,
      enumerable: true,
      get: () => resolveFirstRequest().dataset,
      set: (value: ComponentDataConfig['dataset']) => {
        resolveFirstRequest().dataset = value
      },
    },
    bindings: {
      configurable: true,
      enumerable: true,
      get: () => resolveFirstRequest().bindings,
      set: (value: ComponentDataConfig['bindings']) => {
        resolveFirstRequest().bindings = value
      },
    },
    filterFn: {
      configurable: true,
      enumerable: true,
      get: () => resolveFirstRequest().filterFn,
      set: (value: ComponentDataConfig['filterFn']) => {
        resolveFirstRequest().filterFn = value
      },
    },
  })

  return config
}

/** 从旧镜像字段生成请求项，供新面板和运行时统一读取。 */
export const getDataConfigRequests = (
  config: ComponentDataConfig | null | undefined,
): ComponentDataRequestItem[] => {
  if (!config) return []
  if (Array.isArray(config.requests) && config.requests.length > 0) {
    /**
     * `requests` 是新协议的权威数据源。配置从后端读取或经过深拷贝后，首项与根级镜像
     * 必然失去对象引用关系；若再用引用相等性判断，会把已更新的 requests[0] 错误替换成
     * 旧根镜像，造成面板编辑、远程回写和保存结果互相覆盖。根级字段仅由同步函数维护。
     */
    return config.requests
  }
  return [
    {
      id: 'request-1',
      name: '请求1',
      collapsed: false,
      request: config.request,
      extractor: config.extractor,
      dataset: config.dataset,
      bindings: config.bindings,
      threeMapRole: config.threeMapRole,
      mergeMode: config.mergeMode,
       filterFn: config.filterFn,
       deletedAutoMappingTargets: config.deletedAutoMappingTargets,
     },
   ]
}

/** 将请求项同步回旧镜像字段，减少未升级调用点的改动面。 */
export const syncDataConfigRequestMirror = (config: ComponentDataConfig) => {
  const first = getDataConfigRequests(config)[0]
  if (!first) return config
  config.request = first.request
  config.extractor = first.extractor
  config.dataset = first.dataset
  config.bindings = first.bindings
  config.threeMapRole = first.threeMapRole
  config.mergeMode = first.mergeMode
  config.filterFn = first.filterFn
  config.deletedAutoMappingTargets = first.deletedAutoMappingTargets
  return config
}

// request-1 由默认静态项占用，后续人工添加从 request-2 开始，避免首项编号重复。
let generatedRequestId = 2

/** 创建下一个请求项；稳定 id 只在创建时分配，删除请求不会复用已存在的编号。 */
export const createDataConfigRequestItem = (
  source?: Partial<ComponentDataRequestItem>,
): ComponentDataRequestItem => ({
  id: source?.id || `request-${generatedRequestId++}`,
  name: source?.name || '请求1',
  collapsed: source?.collapsed ?? false,
  request: source?.request || { type: 'static', config: { data: [] } },
  extractor: source?.extractor || { resultPath: '' },
  dataset: source?.dataset || { dimensions: [], source: [] },
  bindings: source?.bindings || [],
  threeMapRole: source?.threeMapRole,
  mergeMode: source?.mergeMode,
  filterFn: source?.filterFn,
  deletedAutoMappingTargets: source?.deletedAutoMappingTargets || [],
})

/** 创建默认静态请求项；示例数据会同时写入请求内容和二维数据集。 */
export const createStaticDataRequestItem = (
  exampleData: unknown = [],
  id = 'request-1',
): ComponentDataRequestItem => {
  const source = Array.isArray(exampleData)
    ? exampleData.map((row) =>
        row && typeof row === 'object' && !Array.isArray(row)
          ? { ...(row as Record<string, unknown>) }
          : { value: row },
      )
    : exampleData && typeof exampleData === 'object'
      ? [{ ...(exampleData as Record<string, unknown>) }]
      : exampleData === undefined || exampleData === null
        ? []
        : [{ value: exampleData }]
  const dimensions = source[0] ? Object.keys(source[0]) : []
  return {
    id,
    name: '请求1',
    collapsed: false,
    request: { type: 'static', config: { data: source } },
    extractor: { resultPath: '' },
    dataset: { dimensions, source },
    bindings: [],
    filterFn: '',
    deletedAutoMappingTargets: [],
  }
}

/** 删除请求后按界面顺序生成名称；稳定 id 保持不变。 */
export const renameDataConfigRequests = (requests: ComponentDataRequestItem[]) =>
  requests.map((item, index) => ({ ...item, name: `请求${index + 1}` }))

/** 获取同一组件内已被前序请求占用的非空目标字段。 */
export const getOccupiedDataConfigTargetFields = (
  requests: ComponentDataRequestItem[],
  currentIndex = requests.length,
) => {
  const occupied = new Set<string>()
  requests.slice(0, currentIndex).forEach((request) => {
    request.bindings.forEach((binding) => {
      const target = isChartBindingRule(binding)
        ? binding.targetDimensionField === undefined
          ? binding.dimensionField || ''
          : binding.targetDimensionField
        : 'targetPath' in binding
          ? String(binding.targetPath || '')
          : ''
      if (target.trim()) occupied.add(target.trim())
      if (isChartBindingRule(binding)) {
        binding.measureFields.forEach((field, index) => {
          // 显式空目标是用户删除或暂存的空行，不回退为来源字段，避免错误占用全局目标名。
          const hasExplicitTarget =
            Array.isArray(binding.targetMeasureFields) && index < binding.targetMeasureFields.length
          const target = hasExplicitTarget
            ? binding.targetMeasureFields?.[index] || ''
            : field
          if (target?.trim()) occupied.add(target.trim())
        })
      }
    })
  })
  return occupied
}

/**
 * 将多个请求的映射结果按行号合成图表目标字段快照，缺失值保持为空。
 * 原始响应始终隔离，避免字段同名时发生隐式覆盖。
 */
export const mergeChartRequestSnapshots = (
  snapshots: Array<{ rows: Record<string, unknown>[]; bindings: ComponentDataBindingRule[] }>,
) => {
  const maxRows = snapshots.reduce((max, item) => Math.max(max, item.rows.length), 0)
  const result = Array.from({ length: maxRows }, () => ({}) as Record<string, unknown>)
  snapshots.forEach(({ rows, bindings }) => {
    const chartRules = bindings.filter(isChartBindingRule)
    chartRules.forEach((rule) => {
      for (let index = 0; index < maxRows; index += 1) {
        const row = rows[index]
        // 显式空目标表示该映射已删除或仍是人工占位，不能回退到来源字段参与运行时合成。
        const hasExplicitDimensionTarget = rule.targetDimensionField !== undefined
        const targetDimension = hasExplicitDimensionTarget
          ? rule.targetDimensionField || ''
          : rule.dimensionField
        if (targetDimension) result[index][targetDimension] = row?.[rule.dimensionField] ?? ''
        rule.measureFields.forEach((sourceField, measureIndex) => {
          const hasExplicitTarget =
            Array.isArray(rule.targetMeasureFields) && measureIndex < rule.targetMeasureFields.length
          // 显式空目标不得在兼容合成中回退成来源字段，避免已删除字段重新参与运行时覆盖。
          const target = hasExplicitTarget
            ? rule.targetMeasureFields?.[measureIndex] || ''
            : sourceField
          if (target) result[index][target] = row?.[sourceField] ?? ''
        })
      }
    })
  })
  return result
}

/**
 * 统一的场景级请求全局默认值。
 * 右侧“全局公共配置”、动态请求执行、公共接口执行都复用这份结构，
 * 避免再出现“弹窗里叫全局，实际上只保存在当前对象里”的分裂状态。
 */
export const createEmptyRequestGlobalConfig = (): RequestGlobalConfig => ({
  requestOriginUrl: '',
  requestInterval: 0,
  requestIntervalUnit: 'second',
  requestParams: {
    Header: {},
  },
})

export const getDatasetFieldNames = (dataConfig: ComponentDataConfig) => {
  if (dataConfig.dataset.dimensions.length > 0) {
    return dataConfig.dataset.dimensions
  }

  const firstRow = dataConfig.dataset.source[0]
  return firstRow ? Object.keys(firstRow) : []
}

export const findDatasetByLegacyPanelConfig = (
  datasets: Dataset[],
  panelConfigs: DataPanelConfig[],
) => {
  const firstConfig = panelConfigs[0]
  if (!firstConfig) return null

  const matchedById = datasets.find((item) =>
    item.dataSourceList.some(
      (source) => source.dataSourceId === firstConfig.datasetProperty.dataSourceId,
    ),
  )

  if (matchedById) return matchedById

  return datasets.find((item) => item.name === firstConfig.datasetProperty.datasetName) || null
}
