import type {
  AjaxRequestConfig,
  AdapterRequestConfig,
  ChartBindingRule,
  ComponentDataConfig,
  PublicRequestConfig,
} from '@/types/data-config'
import { CHART_AUTO_MEASURE_FIELD_LIMIT, isChartBindingRule } from '@/types/data-config'
import { getChartPanelSchema } from '@/packages/components/Chart/shared/chartConfigMeta'
import { createUuid } from '@/utils/uuid'

/**
 * 创建动态请求的最小默认配置。
 * 这里抽成纯函数，避免右侧面板组件在每次重建默认值时重复携带整段模板对象定义。
 */
export function createEmptyAjaxRequest(): AjaxRequestConfig {
  return {
    requestHttpType: 'GET',
    /**
     * 局部请求默认不再写死自己的轮询值。
     * 这里改为 null，明确表达“跟随场景级全局请求配置”。
     * 如果用户想对单个请求单独覆盖，再在目标配置区显式填写即可。
     */
    requestInterval: null,
    requestIntervalUnit: 'second',
    requestOriginUrl: '',
    requestUrl: '',
    requestContentType: 'default',
    requestParamsBodyType: 'none',
    requestHeaders: {},
    requestQuery: {},
    requestBody: '',
    requestParams: {
      Params: {},
      Header: {},
      Body: {
        'form-data': {},
        'x-www-form-urlencoded': {},
        json: '',
        xml: '',
      },
    },
    requestSQLContent: { sql: '' },
    /**
     * 新建请求默认不再写死结果提取路径。
     * 面板已经去掉该输入项，新配置统一建议在自定义过滤器里完成提取和转换。
     */
    resultPath: '',
    useAuth: true,
  }
}

/** 创建扩展数据源默认配置，具体适配器配置在面板选择后补齐。 */
export function createEmptyAdapterRequest(): AdapterRequestConfig {
  return { adapterId: '', config: {} }
}

/**
 * 创建公共接口草稿。
 * 公共接口在动态请求基础上补充唯一标识和名称，保持两类配置结构一致。
 */
export function createEmptyPublicRequest(): PublicRequestConfig {
  return {
    // 公共请求在保存前可能被多次编辑，这里提前生成稳定 id，便于弹窗草稿与列表项复用同一标识。
    id: createUuid(),
    name: '',
    ...createEmptyAjaxRequest(),
  }
}

/**
 * 根据图表类型推断默认数据形态。
 * 饼环图和矩形树图更适合 name-value，其余分类图维持 category-value。
 */
export function inferChartDataShape(chartKeyName: string): ChartBindingRule['chartDataShape'] {
  return /pie|donut|treemap/i.test(chartKeyName) ? 'name-value' : 'category-value'
}

export interface ChartMappingTargetFields {
  /** 图表组件内部的维度目标字段。 */
  dimensionField: string
  /** 图表组件内部的度量目标字段，数量与当前映射行保持一致。 */
  measureFields: string[]
}

/**
 * 按图表家族生成组件真实需要的目标字段。
 *
 * 目标字段与接口返回字段属于两个独立概念：
 * - 左侧目标字段说明组件需要 `product`、`name`、`value` 等什么数据；
 * - 右侧来源字段由用户从接口结果中选择。
 *
 * 这里按需要的度量数量一次生成数组，避免模板渲染时逐行判断图表类型。
 */
export function createChartMappingTargetFields(
  chartKeyName: string,
  measureCount = 1,
): ChartMappingTargetFields {
  const schema = getChartPanelSchema(chartKeyName)
  // 自动映射只允许落入协议公开的两个度量槽位，不能按接口字段数量动态扩容。
  const safeMeasureCount = Math.min(CHART_AUTO_MEASURE_FIELD_LIMIT, Math.max(1, measureCount))

  if (schema.family === 'pie' || schema.family === 'gauge' || schema.family === 'treemap') {
    return {
      dimensionField: 'name',
      measureFields: Array.from({ length: safeMeasureCount }, (_, index) =>
        index === 0 ? 'value' : `value${index + 1}`,
      ),
    }
  }

  if (schema.family === 'radar') {
    return {
      dimensionField: 'indicator',
      measureFields: Array.from({ length: safeMeasureCount }, (_, index) => `data${index + 1}`),
    }
  }

  if (schema.family === 'sankey') {
    const sankeyFields = ['target', 'value']
    return {
      dimensionField: 'source',
      measureFields: Array.from(
        { length: safeMeasureCount },
        (_, index) => sankeyFields[index] || `data${index + 1}`,
      ),
    }
  }

  return {
    dimensionField: 'product',
    measureFields: Array.from({ length: safeMeasureCount }, (_, index) => `data${index + 1}`),
  }
}

/**
 * 创建图表映射的默认绑定。
 * 保持默认维度、度量和数据形态的初始化口径统一，避免组件内多处散落重复结构。
 */
export function createDefaultChartRule(chartKeyName: string): ChartBindingRule {
  const targetFields = createChartMappingTargetFields(chartKeyName)
  return {
    kind: 'chart',
    targetDimensionField: targetFields.dimensionField,
    targetMeasureFields: targetFields.measureFields,
    // 默认规则来自组件结构识别；用户删除后由请求级删除记录阻止它再次自动生成。
    targetMeasureFieldOrigins: targetFields.measureFields.map(() => 'inferred'),
    dimensionField: '',
    measureFields: [''],
    seriesMode: 'single',
    chartDataShape: inferChartDataShape(chartKeyName),
    useDataset: true,
  }
}

/** 将字段名规整后写入集合，避免空格或重复记录影响自动补齐判断。 */
const getDeletedAutoMappingTargetSet = (config: ComponentDataConfig) =>
  new Set((config.deletedAutoMappingTargets || []).map((field) => field.trim()).filter(Boolean))

/**
 * 根据当前图表规模返回未删除且未被前序请求占用的默认度量目标。
 *
 * 已删除字段和前序请求占用字段都只会消耗固定槽位，不能扩展候选范围生成新的 `dataN`。
 */
const getAvailableDefaultMeasureTargets = (
  chartKeyName: string,
  measureCount: number,
  deletedTargets: Set<string>,
  occupiedTargets: ReadonlySet<string>,
) =>
  createChartMappingTargetFields(
    // 前序请求只会消耗固定槽位；即使槽位全部占用，也不能通过增加 measureCount 生成 data3。
    chartKeyName,
    Math.max(CHART_AUTO_MEASURE_FIELD_LIMIT, measureCount),
  ).measureFields.filter((target) => !deletedTargets.has(target) && !occupiedTargets.has(target))

/**
 * 清理图表规则中已被用户删除或已被前序请求占用的自动目标。
 *
 * 删除记录按“组件目标字段”保存，前序占用字段则由调用方每次传入；两种情况都不能只清空
 * 来源字段，否则字段刷新后会重新生成冲突映射。这里同步维护目标、来源和来源标记的索引关系。
 */
const removeUnavailableAutoMappings = (
  config: ComponentDataConfig,
  binding: ChartBindingRule,
  chartKeyName: string,
  occupiedTargets: ReadonlySet<string>,
) => {
  const deletedTargets = getDeletedAutoMappingTargetSet(config)
  const unavailableTargets = new Set([...deletedTargets, ...occupiedTargets])
  // 清理时必须拿到完整合法槽位集合，不能按当前只剩一行而误把 data2 判定为非法。
  const fallbackTargets = createChartMappingTargetFields(
    chartKeyName,
    CHART_AUTO_MEASURE_FIELD_LIMIT,
  )
  const origins = binding.measureFields.map(
    (_, index) => binding.targetMeasureFieldOrigins?.[index] || 'inferred',
  )
  const retained = binding.measureFields.flatMap((sourceField, index) => {
    /**
     * 数组内的显式空字符串表示本轮补齐已无可用目标，不能再回退到默认字段；
     * 否则删除 `data1` 后会把空位重新解释成另一个 `data2`，造成目标重复覆盖。
     */
    const hasExplicitTarget =
      Array.isArray(binding.targetMeasureFields) && index < binding.targetMeasureFields.length
    const targetField = hasExplicitTarget
      ? binding.targetMeasureFields?.[index]?.trim() || ''
      : fallbackTargets.measureFields[index] || ''
    /**
     * 手工新增的空目标行是有效草稿，必须保留；自动行没有目标则代表已被删除或前序请求占用，
     * 应整体移除，避免后续自动补齐重新写入相同字段。
     */
    if (!targetField) {
      return origins[index] === 'manual'
        ? [{ sourceField, targetField, origin: origins[index] }]
        : []
    }
    // 自动映射没有来源字段时不构成真实绑定，必须整行移除，避免空数据请求无意义占用目标槽位。
    if (origins[index] === 'inferred' && !sourceField.trim()) return []
    // 自动目标超出固定槽位时视为无效历史自动映射；人工自定义目标不受此清理影响。
    if (
      origins[index] === 'inferred' &&
      (!fallbackTargets.measureFields.includes(targetField) || unavailableTargets.has(targetField))
    ) {
      return []
    }
    return [{ sourceField, targetField, origin: origins[index] }]
  })

  const dimensionTarget = binding.targetDimensionField?.trim() || fallbackTargets.dimensionField
  if (unavailableTargets.has(dimensionTarget) || !binding.dimensionField.trim()) {
    // 维度来源为空时与度量来源为空保持同一规则：自动映射整行移除，不保留悬空目标字段。
    binding.targetDimensionField = ''
    binding.dimensionField = ''
  }
  binding.measureFields = retained.map((item) => item.sourceField)
  binding.targetMeasureFields = retained.map((item) => item.targetField)
  binding.targetMeasureFieldOrigins = retained.map((item) => item.origin)
}

/**
 * 补齐当前图表规则中缺失的自动目标字段。
 *
 * 人工新增行保留空目标，自动行只从“未删除且未被前序请求占用”的候选里取值；通过已分配集合
 * 防止同一请求内出现两个来源落到同一目标字段。
 */
const fillMissingChartMeasureTargets = (
  binding: ChartBindingRule,
  chartKeyName: string,
  deletedTargets: Set<string>,
  occupiedTargets: ReadonlySet<string>,
  previousOrigins: ChartBindingRule['targetMeasureFieldOrigins'],
) => {
  const availableTargets = getAvailableDefaultMeasureTargets(
    chartKeyName,
    binding.measureFields.length,
    deletedTargets,
    occupiedTargets,
  )
  const assignedTargets = new Set<string>()
  binding.targetMeasureFields = binding.measureFields.map((_, index) => {
    const currentTarget = binding.targetMeasureFields?.[index]?.trim() || ''
    const origin =
      binding.targetMeasureFieldOrigins?.[index] || previousOrigins?.[index] || 'inferred'
    if (currentTarget) {
      assignedTargets.add(currentTarget)
      return currentTarget
    }
    // 空白人工行只表达待编辑意图，自动刷新不得擅自分配目标字段。
    if (origin === 'manual') return ''
    const nextTarget = availableTargets.find((target) => !assignedTargets.has(target)) || ''
    if (nextTarget) assignedTargets.add(nextTarget)
    return nextTarget
  })
  binding.targetMeasureFieldOrigins = binding.measureFields.map(
    (_, index) =>
      binding.targetMeasureFieldOrigins?.[index] || previousOrigins?.[index] || 'inferred',
  )
}

/**
 * 图表映射自动识别。
 * 仅在维度字段或度量字段缺失时补齐，不覆盖用户已经手工配置好的映射。
 */
export function autoFillChartMapping(
  config: ComponentDataConfig,
  fields: string[],
  chartKeyName: string,
  occupiedTargets: ReadonlySet<string> = new Set(),
) {
  const binding = config.bindings.find(isChartBindingRule)
  if (!binding) return

  // 先清理已删除和前序请求占用的自动项，避免字段刷新后重新产生同名目标。
  removeUnavailableAutoMappings(config, binding, chartKeyName, occupiedTargets)
  const deletedTargets = getDeletedAutoMappingTargetSet(config)
  if (fields.length === 0) return

  /**
   * 保存自动识别与人工新增的行类型。字段刷新只增补自动项，不会把人工项改成必要字段。
   * 新建场景会完整写入来源数组；运行中缺失的位置按自动识别项保护。
   */
  const previousOrigins = binding.measureFields.map(
    (_, index) => binding.targetMeasureFieldOrigins?.[index] || 'inferred',
  )

  /**
   * 首次自动识别与后续新增字段补齐都走这里。
   * 不能只在“完全为空”时才处理，否则静态数据新增 data4 这类字段后，映射不会自动补齐。
   */
  const needsAutoFill =
    binding.measureFields.length === 0 || binding.measureFields.every((field) => !field)

  const schema = getChartPanelSchema(chartKeyName)
  const defaultTargetFields = createChartMappingTargetFields(
    chartKeyName,
    binding.measureFields.length,
  )
  const canUseDimensionTarget =
    !deletedTargets.has(defaultTargetFields.dimensionField) &&
    !occupiedTargets.has(defaultTargetFields.dimensionField)
  if (schema.flags.pieLike || schema.family === 'pie' || schema.family === 'treemap') {
    if (needsAutoFill) {
      // 维度目标被前序请求占用或被用户删除时，来源字段也不再保留，避免形成不可见的半映射。
      binding.dimensionField = canUseDimensionTarget ? fields[0] || '' : ''
      binding.measureFields = [fields[1] || fields[0] || '']
    }
    binding.chartDataShape = 'name-value'
    binding.seriesMode = 'single'
    const targetFields = createChartMappingTargetFields(chartKeyName, binding.measureFields.length)
    if (canUseDimensionTarget) {
      binding.targetDimensionField ||= targetFields.dimensionField
    }
    fillMissingChartMeasureTargets(
      binding,
      chartKeyName,
      deletedTargets,
      occupiedTargets,
      previousOrigins,
    )
    removeUnavailableAutoMappings(config, binding, chartKeyName, occupiedTargets)
    return
  }

  if (
    canUseDimensionTarget &&
    (!binding.dimensionField || !fields.includes(binding.dimensionField))
  ) {
    binding.dimensionField = fields[0] || ''
  }
  if (!canUseDimensionTarget) binding.dimensionField = ''

  /**
   * 分类图的来源字段最多自动绑定到两个组件度量槽位。
   * 其余接口字段仍保留在数据内容中，但不会被猜测成图表的第三个系列。
   */
  // 即使维度目标不可用，也用首个来源字段排除分类列，避免把分类文本错误识别成度量值。
  const dimensionSourceForMeasure = binding.dimensionField || fields[0] || ''
  const candidateMeasureFields = fields
    .filter((field) => field && field !== dimensionSourceForMeasure)
    .slice(0, CHART_AUTO_MEASURE_FIELD_LIMIT)
  if (needsAutoFill) {
    binding.measureFields =
      candidateMeasureFields.length > 0 ? candidateMeasureFields : [fields[1] || fields[0] || '']
  } else if (schema.supports.legend) {
    /**
     * “已有有效映射 + 空字符串”表示用户刚点击了“添加数据项”，空字符串是待编辑槽位，
     * 不能再用 `filter(Boolean)` 清理，否则保存或字段刷新后新增行会立即消失。
     *
     * 没有待编辑槽位时仍执行增量字段合并，保证接口新增字段可以被多系列图表自动识别；
     * 存在待编辑槽位时保持用户当前数组，等待其通过下拉框显式选择来源字段。
     */
    const hasPendingUserSlot = binding.measureFields.some((field) => !field)
    if (!hasPendingUserSlot) {
      const mergedMeasureFields = [...binding.measureFields]
      const mergedOrigins = [...previousOrigins]
      candidateMeasureFields.forEach((field) => {
        if (
          mergedMeasureFields.length < CHART_AUTO_MEASURE_FIELD_LIMIT &&
          !mergedMeasureFields.includes(field)
        ) {
          mergedMeasureFields.push(field)
          // 接口字段刷新自动补出的映射仍标记为自动识别项；用户可删除但不能改名。
          mergedOrigins.push('inferred')
        }
      })
      binding.measureFields =
        mergedMeasureFields.length > 0 ? mergedMeasureFields : [fields[1] || fields[0] || '']
      binding.targetMeasureFieldOrigins = mergedOrigins
    }
  } else if (binding.measureFields.length === 0 || !binding.measureFields[0]) {
    binding.measureFields = [fields[1] || fields[0] || '']
  }

  binding.chartDataShape = 'category-value'
  binding.seriesMode = binding.measureFields.filter(Boolean).length > 1 ? 'multi' : 'single'

  /**
   * 来源字段数量可能在接口测试后增加，因此只补齐缺失的目标行，不覆盖已经保存的目标名称。
   * 目标数组与来源数组保持同索引关系，后续增删映射时可以常数时间定位对应字段。
   */
  const targetFields = createChartMappingTargetFields(chartKeyName, binding.measureFields.length)
  if (canUseDimensionTarget) {
    binding.targetDimensionField ||= targetFields.dimensionField
  }
  fillMissingChartMeasureTargets(
    binding,
    chartKeyName,
    deletedTargets,
    occupiedTargets,
    previousOrigins,
  )
  // 字段合并结束后再次规整，覆盖本轮自动识别新生成的同名目标字段。
  removeUnavailableAutoMappings(config, binding, chartKeyName, occupiedTargets)
}
