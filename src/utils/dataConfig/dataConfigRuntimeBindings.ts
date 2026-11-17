import { cloneDeep, set } from 'lodash-es'
import type * as THREE from '@/types/legacyObjectPort'
import type BaseWidgetConfig from '@/packages/components/BaseWidgetConfig'
import {
  type ChartBindingRule,
  type ComponentDataBindingRule,
  type ComponentDataConfig,
  isObjectBindingRule,
  isMarkingBindingRule,
  isWidgetBindingRule,
  MARKING_INSTANCE_LIMIT_DEFAULT,
  type MarkingGenerationRule,
  type MarkingInstanceBuildResult,
  type PublicRequestConfig,
  type PublicRequestReferenceConfig,
  type DatasetRequestConfig,
  getDataConfigRequests,
} from '@/types/data-config'
import type { Dataset } from '@/types/threeScene'
import {
  findDatasetByConfig,
  findPublicRequestByConfig,
  getDatasets,
  getPublicRequests,
} from './dataRequestHelpers'
import { extractResult } from './dataRequestExecution'
import { getDataSourceAdapter } from './dataSourceAdapters'
import { appLogger } from '@/utils/logger'
import { isDatasetValueWidgetKeyName } from './widgetDataInference'
import { applyMarketImageValue } from '@/packages/components/Widget/Image/imageSource'
import { applyPageFrameBindings } from '@/packages/components/Widget/VPageMenu/pageFrameDataBindings'
export { applyPageFrameBindings } from '@/packages/components/Widget/VPageMenu/pageFrameDataBindings'

const toNumber = (value: unknown) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * 把多种来源的向量表达统一成 `{ x, y, z }`。
 *
 * 这里兼容数组、JSON 字符串、逗号分隔字符串和普通对象，
 * 让运行时绑定层不需要关心右侧面板或旧场景数据的历史格式差异。
 */
const normalizeVectorValue = (value: unknown) => {
  if (Array.isArray(value)) {
    return {
      x: toNumber(value[0]),
      y: toNumber(value[1]),
      z: toNumber(value[2]),
    }
  }

  if (typeof value === 'string') {
    const cleaned = value.trim()
    if (cleaned.startsWith('{')) {
      try {
        const parsed = JSON.parse(cleaned)
        return {
          x: toNumber(parsed.x),
          y: toNumber(parsed.y),
          z: toNumber(parsed.z),
        }
      } catch (error) {
        // 向量解析失败时回退到零向量，日志记录原始值便于排查数据绑定格式。
        appLogger.warn('DataConfigRuntimeBindings', '解析向量字符串失败', value, error)
      }
    }

    const parts = cleaned.split(',').map((item) => item.trim())
    if (parts.length >= 3) {
      return {
        x: toNumber(parts[0]),
        y: toNumber(parts[1]),
        z: toNumber(parts[2]),
      }
    }
  }

  if (value && typeof value === 'object') {
    const vector = value as Record<string, unknown>
    return {
      x: toNumber(vector.x),
      y: toNumber(vector.y),
      z: toNumber(vector.z),
    }
  }

  return { x: 0, y: 0, z: 0 }
}

/**
 * 把历史字符串布尔值统一规整成真正的布尔值。
 *
 * 旧请求和静态 JSON 里可能出现 `"true"`、`"1"`、`"yes"` 这类值，
 * 绑定层统一在这里处理，避免可见性和开关控件在运行时表现不一致。
 */
export const normalizeBooleanValue = (value: unknown) => {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase()
    if (['true', '1', 'yes'].includes(lowered)) return true
    if (['false', '0', 'no'].includes(lowered)) return false
  }
  return Boolean(value)
}

/**
 * 把控件列表型输入统一归整成 `{ label, value }[]`。
 *
 * 这样标签、轮播、分页等部件不需要分别兼容字符串数组、对象数组和逗号分隔文本。
 */
const normalizeWidgetOptionsValue = (value: unknown) => {
  if (Array.isArray(value)) {
    return value
      .filter((item) => item !== null && item !== undefined)
      .map((item, index) => {
        if (typeof item === 'object') {
          const option = item as Record<string, unknown>
          const label = option.label ?? option.name ?? option.value ?? `选项${index + 1}`
          const optionValue = option.value ?? option.id ?? option.label ?? `option-${index + 1}`
          return {
            label: String(label),
            value: optionValue,
          }
        }

        return {
          label: String(item),
          value: item,
        }
      })
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return normalizeWidgetOptionsValue(parsed)
    } catch {
      return value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => ({ label: item, value: item }))
    }
  }

  return []
}

const normalizeRowsAsWidgetOptions = (
  rows: Record<string, unknown>[],
  sourceField: string,
) =>
  rows.reduce<Array<{ label: string; value: unknown }>>((result, item, index) => {
    const optionValue = item[sourceField] ?? item.value ?? item.id ?? item.label
    if (optionValue === null || optionValue === undefined) return result

    const label = item.label ?? item.name ?? item.title ?? optionValue ?? `选项${index + 1}`
    result.push({
      label: String(label),
      value: optionValue,
    })
    return result
  }, [])

/**
 * 按当前请求类型解析组件数据，但不主动发请求。
 *
 * 返回值统一收敛成二维表结构，便于对象绑定、widget 绑定和图表运行时复用。
 */
export const resolveComponentData = (
  dataConfig: ComponentDataConfig | null | undefined,
  datasets: Dataset[] = getDatasets(),
  publicRequests: PublicRequestConfig[] = getPublicRequests(),
): {
  dimensions: string[]
  source: Record<string, unknown>[]
  meta: Record<string, unknown>
} => {
  if (!dataConfig) {
    return {
      dimensions: [] as string[],
      source: [] as Record<string, unknown>[],
      meta: {},
    }
  }

  // 多请求普通部件按行号合并各请求的已解析数据；每个请求仍先独立解析和过滤，
  // 这里只负责把不同来源的字段组合成控件可消费的统一快照。
  const requestItems = getDataConfigRequests(dataConfig)
  if (requestItems.length > 1) {
    const results: Array<{
      dimensions: string[]
      source: Record<string, unknown>[]
      meta: Record<string, unknown>
    }> = requestItems.map((item) =>
      resolveComponentData(
        {
          ...dataConfig,
          request: item.request,
          extractor: item.extractor,
          dataset: item.dataset,
          bindings: item.bindings,
          filterFn: item.filterFn,
          requests: [item],
        },
        datasets,
        publicRequests,
      ),
    )
    const source = results.reduce<Record<string, unknown>[]>((rows, result) => {
      result.source.forEach((row: Record<string, unknown>, index: number) => {
        rows[index] = { ...(rows[index] || {}), ...row }
      })
      return rows
    }, [])
    return {
      dimensions: Array.from(new Set(results.flatMap((result) => result.dimensions))),
      source,
      meta: { requestType: 'multi' },
    }
  }

  if (dataConfig.request.type === 'static') {
    const staticData = (dataConfig.request.config as { data?: unknown }).data
    const extracted = extractResult(staticData, dataConfig.extractor?.resultPath)
    const source = Array.isArray(extracted)
      ? extracted.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
      : []
    const dimensions = dataConfig.dataset.dimensions.length
      ? dataConfig.dataset.dimensions
      : source[0]
        ? Object.keys(source[0])
        : []
    return {
      dimensions,
      source,
      meta: {
        requestType: 'static',
      },
    }
  }

  if (dataConfig.request.type === 'dataset') {
    const requestConfig = dataConfig.request.config as DatasetRequestConfig
    const dataset = findDatasetByConfig(datasets, requestConfig)
    return {
      dimensions: dataConfig.dataset.dimensions,
      source: Array.isArray(dataConfig.dataset.source) ? dataConfig.dataset.source : [],
      meta: {
        requestType: 'dataset',
        dataset,
        datasetProperty: requestConfig.datasetProperty,
      },
    }
  }

  if (dataConfig.request.type === 'public') {
    const requestConfig = dataConfig.request.config as PublicRequestReferenceConfig
    const publicRequest = findPublicRequestByConfig(publicRequests, requestConfig)
    return {
      dimensions: dataConfig.dataset.dimensions,
      source: Array.isArray(dataConfig.dataset.source) ? dataConfig.dataset.source : [],
      meta: {
        requestType: 'public',
        publicRequest,
      },
    }
  }

  if (dataConfig.request.type === 'adapter') {
    const requestConfig = dataConfig.request.config as { adapterId?: unknown }
    const adapterId = typeof requestConfig.adapterId === 'string' ? requestConfig.adapterId : ''
    const adapter = getDataSourceAdapter(adapterId)
    return {
      dimensions: adapter?.dimensions ? [...adapter.dimensions] : dataConfig.dataset.dimensions,
      source: Array.isArray(dataConfig.dataset.source) ? dataConfig.dataset.source : [],
      meta: { requestType: 'adapter', adapterId },
    }
  }

  return {
    dimensions: dataConfig.dataset.dimensions,
    source: Array.isArray(dataConfig.dataset.source) ? dataConfig.dataset.source : [],
    meta: {
      requestType: 'ajax',
    },
  }
}

/**
 * 将首条记录按绑定规则应用到 Three.js 对象属性上。
 *
 * 这里只负责非 widget 场景对象的可见性、位移、旋转和缩放映射。
 */
export const applyObjectBindings = (
  target: THREE.Object3D,
  bindings: ComponentDataBindingRule[],
  row: Record<string, unknown> | null | undefined,
) => {
  if (!target || !row) return

  bindings.forEach((binding) => {
    if (!isObjectBindingRule(binding)) return
    if (!(binding.sourceField in row)) {
      appLogger.warn('DataConfigRuntimeBindings', '对象绑定缺少来源字段', binding.sourceField)
      return
    }

    const rawValue = row[binding.sourceField]
    switch (binding.targetPath) {
      case 'visible':
        target.visible = normalizeBooleanValue(rawValue)
        break
      case 'position': {
        const vector = normalizeVectorValue(rawValue)
        target.position.set(vector.x, vector.y, vector.z)
        break
      }
      case 'rotation': {
        const vector = normalizeVectorValue(rawValue)
        target.rotation.set(vector.x, vector.y, vector.z)
        break
      }
      case 'scale': {
        const vector = normalizeVectorValue(rawValue)
        target.scale.set(vector.x, vector.y, vector.z)
        break
      }
    }
  })
}

/**
 * 控件运行时绑定只改 widget.option，不触碰 attr。
 *
 * 这样控件和图表共用 widget 渲染层，但保留 DOM 部件自身的字段语义。
 */
export const applyWidgetBindings = (
  component: BaseWidgetConfig,
  bindings: ComponentDataBindingRule[],
  row: Record<string, unknown> | null | undefined,
  rows: Record<string, unknown>[] = [],
) => {
  if (!component || !row) return

  if (component.info.keyName === 'VPageMenu') {
    applyPageFrameBindings(component, bindings, row, rows)
    return
  }

  const nextOption = cloneDeep((component.option || {}) as Record<string, unknown>)
  /**
   * 这些迁移过来的“部件”沿用旧项目字段语义，实际渲染读的是 option.dataset：
   * - 数字计数器
   * - 数字翻牌
   * - 倒计时
   * - GoView 图标
   *
   * 但当前右侧“数据”面板的 widget 通用映射口径仍然是 targetPath=value。
   * 如果这里只写 nextOption.value，映射状态会显示成功，组件却完全不更新。
   *
   * 因此这里做一层最小兼容：保留通用 value 字段，同时把 value 镜像到 dataset，
   * 让旧字段语义的部件也能直接消费当前数据映射结果。
   */
  const shouldMirrorValueToDataset =
    isDatasetValueWidgetKeyName(component.info.keyName)

  bindings.forEach((binding) => {
    if (!isWidgetBindingRule(binding)) return
    if (!(binding.sourceField in row)) {
      appLogger.warn('DataConfigRuntimeBindings', '部件绑定缺少来源字段', binding.sourceField)
      return
    }

    const rawValue = row[binding.sourceField]
    switch (binding.targetPath) {
      case 'visible':
        nextOption.visible = normalizeBooleanValue(rawValue)
        break
      case 'value':
        /** 市场图片的映射值是稳定编号，必须同步资源引用，不能直接把编号交给图片地址属性。 */
        if (component.info.keyName === 'VImage' && nextOption.sourceType === 'resource-market') {
          applyMarketImageValue(nextOption, rawValue)
          break
        }
        nextOption.value = rawValue
        if (shouldMirrorValueToDataset) {
          nextOption.dataset = rawValue
        }
        /**
         * 直线进度条属性面板和渲染层读的是 percentage，
         * 右侧数据面板的通用映射口径仍是 value。
         * 绑定成功后把 value 同步成 0–100 的百分比，避免面板显示已映射但轨道不更新。
         */
        if (component.info.keyName === 'VProgressBar') {
          const parsed = Number(String(rawValue ?? '').replace(/%/g, '').trim())
          nextOption.percentage = Number.isFinite(parsed) ? parsed : 0
        }
        break
      case 'total':
      case 'pageSize':
        /**
         * 总条数和每页条数默认只属于分页器；测验另外允许把 total 作为题库一致性校验字段。
         * 其它组件即使误配同名目标也不会因此修改样式或业务属性。
         */
        if (
          component.info.keyName === 'VInputsPagination' ||
          (component.info.keyName === 'VQuiz' && binding.targetPath === 'total')
        ) {
          nextOption[binding.targetPath] = rawValue
        }
        break
      case 'options': {
        /**
         * 列表型部件不能只盯着第一行数据。
         * 如果当前字段本身不是一个数组/对象，而数据源却有多行，
         * 就把同字段在整份数据里的值聚合成 options，供标签/轮播/词云这类组件消费。
         */
        const hasCollectionShape =
          Array.isArray(rawValue) || (rawValue !== null && typeof rawValue === 'object')
        const aggregatedValues =
          hasCollectionShape || rows.length <= 1
            ? rawValue
            : normalizeRowsAsWidgetOptions(rows, binding.sourceField)

        nextOption.options = normalizeWidgetOptionsValue(aggregatedValues)
        break
      }
      default:
        /**
         * 用户手动新增的自定义目标字段没有固定运行时分支，按路径写入部件 option。
         * 内置 value/options/分页字段仍走上面的专用转换，避免破坏原有类型归一化逻辑。
         */
        if (binding.targetPath.trim()) {
          set(nextOption, binding.targetPath, rawValue)
        }
        break
    }
  })

  component.option = nextOption
}

/**
 * 根据打点规则把多行数据转换成实例描述列表。
 *
 * 这里不直接创建 Three.js 对象，只负责字段映射、位置规则校验和最大实例数截断。
 */
export const createMarkingInstances = (
  rows: Record<string, unknown>[],
  rules: Array<MarkingGenerationRule | ComponentDataBindingRule | ChartBindingRule>,
  maxCount = MARKING_INSTANCE_LIMIT_DEFAULT,
): MarkingInstanceBuildResult<Record<string, unknown>> => {
  const normalizedRules = rules.filter(isMarkingBindingRule)
  const positionRule = normalizedRules.find((item) => item.targetPath === 'position' && item.sourceField)
  if (!positionRule) {
    throw new Error('Marking generation requires a position binding.')
  }

  const total = rows.length
  const sliced = rows.slice(0, maxCount)
  const instances = sliced.map((row) => {
    const instance: Record<string, unknown> = {}
    normalizedRules.forEach((rule) => {
      if (!(rule.sourceField in row)) {
        appLogger.warn('DataConfigRuntimeBindings', '打点绑定缺少来源字段', rule.sourceField)
        return
      }
      instance[rule.targetPath] = row[rule.sourceField]
    })
    return instance
  })

  return {
    instances,
    truncated: total > maxCount,
    total,
  }
}
