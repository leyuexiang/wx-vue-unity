import { useSceneWidgetStore, type WidgetConfig } from '@/stores/sceneEditStore'
import type { Dataset } from '@/types/threeScene'
import {
  applyChartData,
  applyWidgetBindings,
  buildChartDataset,
  type ComponentDataConfig,
  type PublicRequestConfig,
  type RequestGlobalConfig,
  type RequestIntervalUnit,
  createEmptyRequestGlobalConfig,
  executeComponentDataRequest,
  isChartBindingRule,
  normalizeDataConfig,
  resolveComponentData,
  getDataConfigRequests,
  composeChartTargetRows,
  type DataRequestRuntimeContext,
} from '@/utils/dataConfig'
import { inferWidgetDataConfigFromOption } from '@/utils/dataConfig/widgetDataInference'
import type { DatasetFieldDetailContent } from '@/utils/renderScene/scenePreviewDatasetHelpers'
import { matchesPreviewDatasetDataConfig } from '@/utils/renderScene/scenePreviewDatasetHelpers'
import {
  normalizePreviewRemoteRows,
  resolvePreviewRemoteInterval,
} from '@/utils/renderScene/scenePreviewRemoteHelpers'
import { validateQuizPayload } from '@/packages/components/Widget/Quiz/quizUtils'

export type WidgetPreviewRemoteEntry = {
  kind: 'widget'
  target: WidgetConfig
  intervalSeconds: number | null
  intervalUnit: RequestIntervalUnit | null
  requestType: 'ajax' | 'public' | 'adapter'
  publicRequestId?: string | null
  requestId: string
}

export type WidgetPreviewRemoteExecutionResult = {
  kind: 'widget'
  target: WidgetConfig
  dataConfig: ComponentDataConfig
  dimensions: string[]
  source: Record<string, unknown>[]
  /** 执行结果所属的稳定请求编号，用于合并回完整配置时精确定位请求项。 */
  requestId: string
}

type WidgetDataRuntimeServiceOptions = {
  getDatasets: () => Dataset[]
  getPublicRequests: () => PublicRequestConfig[]
  getRequestGlobalConfig: () => RequestGlobalConfig
  getRuntimeContext?: () => DataRequestRuntimeContext
}

/**
 * 二维部件数据目标适配服务。
 *
 * 该服务只处理画布二维部件：
 * - 收集远程请求目标；
 * - 回写静态、接口、数据集结果；
 * - 复用现有图表和普通控件数据绑定工具。
 *
 * 请求的轮询、公共接口合并和生命周期由 SceneDataPollingRuntime 统一管理；本服务只保留二维目标
 * 的配置读取、请求执行及结果映射，不创建任何定时器，因此编辑态与发布态可以复用同一调度器。
 */
export class WidgetDataRuntimeService {
  constructor(private readonly options: WidgetDataRuntimeServiceOptions) {}

  /** 增量协调时由调用方判断输入是否变化；纯远程组件不得重放静态回填覆盖当前数据。 */
  applyStaticDataConfigs(
    shouldApply?: (widget: WidgetConfig, config: ComponentDataConfig) => boolean,
  ) {
    this.getWidgets().forEach((widget) => {
      // 浏览记录由按需运行时管理，不把静态示例或首行属性写回成对按钮配置。
      if (widget.component.info.keyName === 'VRecordPagination') return
      const dataConfig = this.resolveWidgetDataConfig(widget)
      if (!dataConfig) return
      if (shouldApply && !shouldApply(widget, dataConfig)) return
      if (
        !getDataConfigRequests(dataConfig).some(
          (item) => item.request.type === 'static' || item.request.type === 'dataset',
        )
      )
        return
      getDataConfigRequests(dataConfig).forEach((item) => {
        if (item.request.type !== 'static' && item.request.type !== 'dataset') return
        const itemConfig = {
          ...dataConfig,
          request: item.request,
          extractor: item.extractor,
          dataset: item.dataset,
          bindings: item.bindings,
          filterFn: item.filterFn,
          requests: [item],
        }
        const resolved = resolveComponentData(itemConfig)
        item.dataset.source = resolved.source
        item.dataset.dimensions = resolved.dimensions
      })
      this.applyWidgetDataConfig(
        widget,
        dataConfig,
        dataConfig.dataset.source,
        dataConfig.dataset.dimensions,
      )
    })
  }

  collectRemoteEntries(): WidgetPreviewRemoteEntry[] {
    const publicRequests = this.options.getPublicRequests()
    const globalConfig = this.options.getRequestGlobalConfig() || createEmptyRequestGlobalConfig()

    return this.getWidgets().reduce<WidgetPreviewRemoteEntry[]>((entries, widget) => {
      const dataConfig = this.resolveWidgetDataConfig(widget)
      if (!dataConfig) return entries
      const requestItems = getDataConfigRequests(dataConfig)
      const remoteItems = requestItems.filter((item) =>
        // 扩展数据源进入同一请求收集流程，持续订阅由场景调度器接管。
        ['ajax', 'public', 'adapter'].includes(item.request.type),
      )
      /** 测验协议要求一次响应包含完整题库，故一个实例只执行首个远程请求项。 */
      const executableItems =
        widget.component.info.keyName === 'VQuiz' ? remoteItems.slice(0, 1) : remoteItems
      executableItems.forEach((item) => {
        const itemConfig = {
          ...dataConfig,
          request: item.request,
          extractor: item.extractor,
          dataset: item.dataset,
          bindings: item.bindings,
          filterFn: item.filterFn,
          requests: [item],
        }
        const { seconds, unit } = resolvePreviewRemoteInterval(
          itemConfig,
          publicRequests,
          globalConfig,
        )
        const publicRequestId =
          item.request.type === 'public'
            ? (item.request.config as { publicRequestId?: string | null }).publicRequestId
            : null
        entries.push({
          kind: 'widget',
          target: widget,
          intervalSeconds: seconds,
          intervalUnit: unit,
          requestType: item.request.type as 'ajax' | 'public' | 'adapter',
          publicRequestId,
          requestId: item.id,
        })
      })
      return entries
    }, [])
  }

  getDataConfigForEntry(entry: WidgetPreviewRemoteEntry): ComponentDataConfig | null {
    const dataConfig = this.resolveWidgetDataConfig(entry.target)
    const item =
      dataConfig &&
      getDataConfigRequests(dataConfig).find((request) => request.id === entry.requestId)
    return item
      ? {
          ...dataConfig,
          request: item.request,
          extractor: item.extractor,
          dataset: item.dataset,
          bindings: item.bindings,
          filterFn: item.filterFn,
          requests: [item],
        }
      : dataConfig
  }

  applyRemoteResult(entry: WidgetPreviewRemoteEntry, data: unknown) {
    const dataConfig = this.resolveWidgetDataConfig(entry.target)
    if (!dataConfig) return
    const item = getDataConfigRequests(dataConfig).find((request) => request.id === entry.requestId)
    if (!item) return

    const normalizedRows = normalizePreviewRemoteRows(data)
    item.dataset.source = normalizedRows.source
    item.dataset.dimensions = normalizedRows.dimensions
    this.applyWidgetDataConfig(
      entry.target,
      dataConfig,
      normalizedRows.source,
      normalizedRows.dimensions,
    )
  }

  /** 调度器以有效完整题库判断测验是否已取得首份数据。 */
  isQuizLoaded(widget: WidgetConfig) {
    if (widget.component.info.keyName !== 'VQuiz') return false
    const option = widget.component.option as {
      quizId?: unknown
      title?: unknown
      total?: unknown
      questions?: unknown
    }
    return validateQuizPayload(option).valid
  }

  async executeRemoteEntry(
    entry: WidgetPreviewRemoteEntry,
    /** 交互覆盖只影响本次和后续运行时请求，不写回编辑配置，避免触发全场景调度重建。 */
    requestOverride?: ComponentDataConfig,
  ): Promise<WidgetPreviewRemoteExecutionResult | null> {
    const dataConfig = requestOverride ?? this.getDataConfigForEntry(entry)
    if (!dataConfig) return null

    const result = await executeComponentDataRequest(
      dataConfig,
      this.options.getPublicRequests(),
      this.options.getRequestGlobalConfig() || createEmptyRequestGlobalConfig(),
      this.options.getRuntimeContext?.(),
    )
    return {
      kind: 'widget',
      target: entry.target,
      dataConfig,
      dimensions: result.dimensions,
      source: result.source,
      requestId: entry.requestId,
    }
  }

  applyRemoteExecutionResult(executionResult: WidgetPreviewRemoteExecutionResult) {
    const dataConfig = this.resolveWidgetDataConfig(executionResult.target)
    if (!dataConfig) return
    const item = getDataConfigRequests(dataConfig).find(
      (request) => request.id === executionResult.requestId,
    )
    if (!item) return

    // 远程执行返回的是单请求临时配置；回写前重新读取完整配置，只更新对应请求项。
    item.dataset.source = executionResult.source
    item.dataset.dimensions = executionResult.dimensions
    this.applyWidgetDataConfig(
      executionResult.target,
      dataConfig,
      executionResult.source,
      executionResult.dimensions,
    )
  }

  applyDatasetFieldDetailContent(dataset: Dataset, result: DatasetFieldDetailContent) {
    this.getWidgets().forEach((widget) => {
      const dataConfig = this.resolveWidgetDataConfig(widget)
      if (!dataConfig) return
      getDataConfigRequests(dataConfig).forEach((item) => {
        if (item.request.type !== 'dataset') return
        const itemConfig = {
          ...dataConfig,
          request: item.request,
          extractor: item.extractor,
          dataset: item.dataset,
          bindings: item.bindings,
          filterFn: item.filterFn,
          requests: [item],
        }
        if (!matchesPreviewDatasetDataConfig(itemConfig, dataset)) return
        const resolved = resolveComponentData(itemConfig)
        const source = result.data || []
        const dimensions =
          resolved.dimensions.length > 0 ? resolved.dimensions : result.fields || []
        item.dataset.source = source
        item.dataset.dimensions = dimensions
        this.applyWidgetDataConfig(widget, dataConfig, source, dimensions)
      })
    })
  }

  /**
   * 二维目标列表只在服务内部读取。
   * 旧 scenePreviewModules 只调用服务方法，不再直接认识 widgets 字段。
   */
  private getWidgets() {
    return useSceneWidgetStore().totalWidgets || []
  }

  private resolveWidgetDataConfig(widget: WidgetConfig) {
    const configured = normalizeDataConfig(widget.component.dataConfig)
    if (configured || widget.component.info.keyName !== 'VQuiz') return configured

    /** 仅无持久数据配置的测验复用面板推导的静态示例，保证预览有题且不覆盖用户配置的数据源。 */
    return inferWidgetDataConfigFromOption(
      widget.component.info.packageName,
      widget.component.info.keyName,
      widget.component.option as Record<string, unknown>,
    )
  }

  private applyWidgetDataConfig(
    widget: WidgetConfig,
    dataConfig: ComponentDataConfig,
    source: Record<string, unknown>[],
    dimensions: string[],
  ) {
    const requestItems = getDataConfigRequests(dataConfig)
    if (widget.component.info.packageName === 'Chart' && requestItems.length > 1) {
      const composed = composeChartTargetRows(
        requestItems.map((item) => ({ rows: item.dataset.source || [], bindings: item.bindings })),
      )
      source = composed
      dimensions = Array.from(new Set(composed.flatMap((row) => Object.keys(row))))
    }
    if (widget.component.info.packageName === 'Chart') {
      if (requestItems.length <= 1) {
        dataConfig.dataset.dimensions = dimensions
        dataConfig.dataset.source = source
        const chartRule = dataConfig.bindings.find(isChartBindingRule)
        if (chartRule) {
          applyChartData(widget.component, buildChartDataset(chartRule, source))
        } else {
          widget.component.dataConfig = dataConfig
        }
      } else {
        // 多请求图表的合成数据只由运行时渲染快照消费，不能写入请求1的根级 dataset 镜像。
        widget.component.dataConfig = dataConfig
      }
    } else {
      if (requestItems.length <= 1) {
        dataConfig.dataset.dimensions = dimensions
        dataConfig.dataset.source = source
        widget.component.dataConfig = dataConfig
        applyWidgetBindings(widget.component, dataConfig.bindings, source[0] || null, source)
      } else {
        /**
         * 多请求控件按请求逐项应用各自绑定。不能把请求二的 source 写进根 dataset，
         * 因为根 dataset 是请求一兼容镜像；也不能只使用根 bindings，否则请求二的
         * 返回结果会被错误地套用到请求一映射上。
         */
        widget.component.dataConfig = dataConfig
        requestItems.forEach((item) => {
          applyWidgetBindings(
            widget.component,
            item.bindings,
            item.dataset.source?.[0] || null,
            item.dataset.source || [],
          )
        })
      }
    }

    // 预览态只刷新当前部件实例，避免一次数据回填触发整层二维画布重算。
    useSceneWidgetStore().bumpWidgetRenderVersion(widget.id)
  }
}
