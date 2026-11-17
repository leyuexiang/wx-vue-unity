import { watch, type WatchStopHandle } from 'vue'
import { useSceneDataStore, useSceneRequestStore } from '@/stores/sceneAuxiliaryStores'
import { useSceneWidgetStore, type WidgetConfig } from '@/stores/sceneEditStore'
import type { ComponentDataConfig } from '@/types/data-config'
import type { SceneObject, ViewportHost } from '@/scene-platform'
import type renderScene from '@/utils/renderScene'
import { getDataConfigRequests } from '@/utils/dataConfig'
import { appLogger } from '@/utils/logger'
import { SceneDataPollingRuntime } from './widgetRuntime'
import { getWidgetPreviewState } from './widgetRuntime/ports'

export interface EditorSceneDataPollingController {
  /** 启动编辑场景的数据任务；重复调用只会在配置确实变化时重建调度。 */
  start: () => Promise<void>
  /** 释放监听、延迟任务和全部轮询定时器。 */
  dispose: () => void
}

export interface EditorSceneDataPollingControllerOptions {
  getViewportHost: () => ViewportHost | null
  getLegacySceneApi?: () => renderScene | null
  /** 引擎回写前叠加仅存在于预览内存中的临时状态，不修改请求调度器或领域 Store 快照。 */
  projectSceneObjectForRuntime?: (object: SceneObject) => SceneObject
  /** 三维对象数据应用到当前 Runtime 后，交给会话级规则服务评估该对象的状态。 */
  onSceneObjectUpdated?: (object: SceneObject) => void | Promise<void>
  /** 测试可缩短防抖窗口；生产默认合并同一轮表单和 Store 更新。 */
  refreshDelayMs?: number
}

/**
 * 只提取会改变请求任务或结果映射的配置字段。
 *
 * 远程请求返回后会更新 `dataset.source/dimensions`。这些运行时结果不能进入监听签名，否则每次
 * 轮询回填都会反向触发调度器重启，造成重复首轮请求。静态数据的权威输入位于
 * `request.config.data`，数据集的权威引用也位于 `request.config`，所以所有类型都无需把结果镜像
 * `dataset` 纳入签名。
 */
const projectDataConfigForPollingSignature = (
  dataConfig: ComponentDataConfig | null | undefined,
) => {
  if (!dataConfig) return null
  return {
    version: dataConfig.version,
    requests: getDataConfigRequests(dataConfig).map((item) => ({
      id: item.id,
      request: item.request,
      extractor: item.extractor,
      bindings: item.bindings,
      filterFn: item.filterFn,
      deletedAutoMappingTargets: item.deletedAutoMappingTargets,
    })),
  }
}

const projectWidgetForPollingSignature = (widget: WidgetConfig) => ({
  id: widget.id,
  dataConfig: projectDataConfigForPollingSignature(widget.component.dataConfig),
  // 分页适配属于请求配置，外观不参与签名；更换参数、响应路径或每页数量才重新初始化。
  recordPagination:
    widget.component.info.keyName === 'VRecordPagination'
      ? (widget.component.option as { pagination?: unknown }).pagination
      : undefined,
})

const projectObjectForPollingSignature = (object: SceneObject) => ({
  id: object.id,
  dataConfig: projectDataConfigForPollingSignature(
    object.metadata?.dataConfig as ComponentDataConfig | undefined,
  ),
})

/**
 * 生成稳定签名时按实例编号排序，二维层级调整和三维对象排序不会误触发网络任务重建。
 * 所有输入都是场景可序列化数据，不包含引擎对象，因此可以安全使用 JSON 序列化比较。
 */
const createPollingSignature = (
  widgets: readonly WidgetConfig[],
  objects: readonly SceneObject[],
  publicRequests: unknown,
  requestGlobalConfig: unknown,
) =>
  JSON.stringify({
    widgets: [...widgets]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(projectWidgetForPollingSignature),
    objects: [...objects]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(projectObjectForPollingSignature),
    publicRequests,
    requestGlobalConfig,
  })

/**
 * 创建编辑场景级数据请求控制器。
 *
 * 二维部件和三维领域对象共用请求调度器；三维响应只投影到当前 Runtime，不改写 SceneStore，
 * 因此实时数据不会进入配置命令历史。公共接口和全局请求参数仍由场景请求仓库统一提供。
 */
export const createEditorSceneDataPollingController = (
  options: EditorSceneDataPollingControllerOptions,
): EditorSceneDataPollingController => {
  const widgetStore = useSceneWidgetStore()
  const dataStore = useSceneDataStore()
  const requestStore = useSceneRequestStore()
  const refreshDelayMs = Math.max(0, options.refreshDelayMs ?? 100)
  const watchStops: WatchStopHandle[] = []
  let stopSceneStoreSubscription: (() => void) | null = null
  let refreshTimer: ReturnType<typeof setTimeout> | null = null
  let lastSignature = ''
  // 预览可能与防抖刷新同时到达；相同配置必须共享完成屏障，不能只按签名提前返回。
  let refreshWork: Promise<void> = Promise.resolve()
  let started = false
  let disposed = false

  const pollingRuntime = new SceneDataPollingRuntime({
    getDatasets: () => dataStore.sceneDataset,
    getPublicRequests: () => requestStore.scenePublicRequestList,
    getRequestGlobalConfig: () => requestStore.sceneRequestGlobalConfig,
    getRuntimeContext: () => ({
      sceneId: options.getViewportHost()?.getStore().getScene().id,
    }),
    // 模型配置存放在领域对象 metadata 中；只读当前场景快照，不复制整场或扫描旧引擎对象。
    getSceneObjects: () => options.getViewportHost()?.getStore().getScene().objects ?? [],
    applySceneObject: async (object, updateOptions) => {
      /**
       * 数据结果属于运行时状态，直接交给当前引擎中立 Runtime。GIS 与本地三维在各自适配器中
       * 应用经纬高或本地变换；绝不调用 SceneStore.upsertObject，避免轮询数据进入保存和撤销栈。
       */
      const host = options.getViewportHost()
      if (!host) return
      const runtimeObject = options.projectSceneObjectForRuntime?.(object) ?? object
      await host.getRuntime().upsertObject(runtimeObject, updateOptions)
      await options.onSceneObjectUpdated?.(runtimeObject)
    },
  })

  const readSignature = () => {
    // 保留响应式代理，签名读取才能追踪面板内原位修改的配置；结果数据已由投影排除。
    return createPollingSignature(
      widgetStore.totalWidgets ?? [],
      options.getViewportHost()?.getStore().getScene().objects ?? [],
      requestStore.scenePublicRequestList,
      requestStore.sceneRequestGlobalConfig,
    )
  }

  const refresh = async (force = false) => {
    if (disposed || !options.getViewportHost()) return
    const signature = readSignature()
    if (!force && signature === lastSignature) return refreshWork
    lastSignature = signature
    refreshWork = pollingRuntime.start()
    await refreshWork
  }

  const scheduleRefresh = () => {
    if (disposed) return
    if (refreshTimer !== null) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => {
      refreshTimer = null
      void refresh().catch((error) => {
        appLogger.error('EditorSceneDataPollingController', '刷新场景数据请求任务失败', error)
      })
    }, refreshDelayMs)
  }

  /** 删除不能等待配置防抖，否则在途结果仍可能回填已删除的实例。 */
  const refreshImmediately = () => {
    if (refreshTimer !== null) clearTimeout(refreshTimer)
    refreshTimer = null
    void refresh().catch((error) => {
      appLogger.error('EditorSceneDataPollingController', '协调场景数据任务失败', error)
    })
  }

  const start = async () => {
    if (disposed) return
    /** 旧预览模块继续负责历史数据集和交互事件，但不再创建二维或三维远程请求定时器。 */
    options.getLegacySceneApi?.()?.scenePreviewModules.setDataPollingManagedExternally(true)

    const isFirstStart = !started
    if (isFirstStart) {
      started = true
      watchStops.push(
        watch(
          readSignature,
          scheduleRefresh,
        ),
        watch(() => widgetStore.totalWidgets, (widgets, previous) => {
          // 仓库通过替换集合批量删除组件；这里只比较编号，不监听高频结果和外观字段。
          const ids = new Set((widgets ?? []).map((widget) => widget.id))
          if (previous?.some((widget) => !ids.has(widget.id))) refreshImmediately()
        }, { flush: 'sync' }),
        watch(getWidgetPreviewState(), (preview, previous) => {
          if (preview || !previous) return
          // 先失效预览请求和参数覆盖，再由原配置重建编辑态任务；同步执行以保护随后恢复的二维快照。
          pollingRuntime.stop()
          lastSignature = ''
          refreshWork = Promise.resolve()
          scheduleRefresh()
        }, { flush: 'sync' }),
      )
      const sceneStore = options.getViewportHost()?.getStore()
      stopSceneStoreSubscription =
        sceneStore?.subscribe((event) => {
          if (event.type === 'sceneLoaded') {
            // 即使新场景复用相同实例编号和配置，也不能继承旧场景的请求、缓存或传参。
            pollingRuntime.stop()
            lastSignature = ''
            refreshWork = Promise.resolve()
            refreshImmediately()
            return
          }
          if (event.type === 'objectRemoved' || event.type === 'objectHierarchyChanged') {
            // 结构面板删除、撤销与批量新增只发布最终层级事件，也必须同步撤销已移除目标的任务。
            refreshImmediately()
            return
          }
          /** 仅实例集合或其数据配置可能变化的事件需要复核签名，选择和变换等结果会被签名过滤。 */
          if (event.type === 'objectUpserted') {
            scheduleRefresh()
          }
        }) ?? null
    }

    await refresh(isFirstStart)
  }

  const dispose = () => {
    if (disposed) return
    disposed = true
    if (refreshTimer !== null) clearTimeout(refreshTimer)
    refreshTimer = null
    watchStops.splice(0).forEach((stop) => stop())
    stopSceneStoreSubscription?.()
    stopSceneStoreSubscription = null
    pollingRuntime.dispose()
  }

  return { start, dispose }
}
