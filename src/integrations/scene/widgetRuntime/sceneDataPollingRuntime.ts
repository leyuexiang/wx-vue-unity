import type { Dataset } from '@/types/threeScene'
import type {
  ComponentDataBindingRule,
  ComponentDataConfig,
  PublicRequestConfig,
  RequestGlobalConfig,
  RequestIntervalUnit,
} from '@/types/data-config'
import type { SceneObject } from '@/scene-platform'
import { getIotState, type IotStateSnapshot } from '@/servers/manual/iot/api'
import { createIotStateWebSocketClient, type IotStateUpdate } from '@/servers/manual/iot/websocket'
import { getDataSourceAdapter } from '@/utils/dataConfig/dataSourceAdapters'
import {
  createEmptyRequestGlobalConfig,
  customizeHttpRequest,
  executeComponentDataRequest,
  getDataConfigRequests,
  intervalUnitHandle,
  mergeAjaxRequestWithGlobalConfig,
  normalizeDataConfig,
  resolveComponentData,
  transformRequestPayloadToRows,
  type DataRequestRuntimeContext,
} from '@/utils/dataConfig'
import { appLogger } from '@/utils/logger'
import { reconcileRuntimeDataConfig, requestInputSignature } from './requestInputSignature'
import { resolvePreviewRemoteInterval } from '@/utils/renderScene/scenePreviewRemoteHelpers'
import { WidgetDataRuntimeService, type WidgetPreviewRemoteEntry } from './widgetDataRuntimeService'
import {
  applyInteractionRequestParameters,
  isPublicRequestParameterTarget,
} from '@/utils/dataConfig/interactionRequestParameters'
import {
  clearQuizRuntimeStatus,
  setQuizRuntimeStatus,
} from '@/packages/components/Widget/Quiz/quizRuntimeStatus'
import { validateQuizPayload } from '@/packages/components/Widget/Quiz/quizUtils'
import { RecordPaginationRuntime } from './recordPaginationRuntime'
import {
  registerSceneRequestParameterHandler,
  type SceneRequestParameterAction,
} from './sceneDataRequestActions'

type SceneObjectRemoteEntry = {
  kind: 'object'
  targetId: string
  intervalSeconds: number | null
  intervalUnit: RequestIntervalUnit | null
  requestType: 'ajax' | 'public'
  publicRequestId?: string | null
  requestId: string
}

type IotStateTask = {
  objectId: string
  deviceId: string
  pointCode: string
  bindings: ComponentDataBindingRule[]
  intervalMs: number
  delivery: 'auto' | 'websocket' | 'polling'
  subscriptionId: string
  running: boolean
  timer?: ReturnType<typeof setInterval>
  unsubscribe?: () => void
  lastStateVersion?: string
}

type SceneDataRemoteEntry = WidgetPreviewRemoteEntry | SceneObjectRemoteEntry

/** 稳定任务对象同时充当响应令牌；同编号删除后重加也不能接收旧任务的响应。 */
type RemoteTask = {
  entry: SceneDataRemoteEntry
  signature: string
  /** 请求版本与在途集合属于任务实例，删除重加不会与旧任务发生编号碰撞。 */
  version: number
  inflight: Set<number>
  /** 首轮初始化完成屏障；事件只等待目标自身，不等待全场景其它慢请求。 */
  initialWork?: Promise<void>
  timer?: ReturnType<typeof setInterval>
}
/** 公共请求只保留当前接口的一份响应和在途承诺，供本会话新增订阅者复用。 */
type PublicTask = {
  /** 主动传参推进版本，旧请求不能回填缓存或覆盖新参数的结果。 */
  version: number
  signature: string
  entries: SceneDataRemoteEntry[]
  intervalMs: number
  timer?: ReturnType<typeof setInterval>
  pending?: Promise<unknown>
  payload?: unknown
  hasPayload: boolean
}

/** 部分无组件实例的远程目标只在运行时测试或迁移期间出现，分类前安全检查组件身份。 */
const isQuizWidgetEntry = (entry: SceneDataRemoteEntry): entry is WidgetPreviewRemoteEntry =>
  entry.kind === 'widget' && entry.target.component?.info?.keyName === 'VQuiz'

export interface SceneDataPollingRuntimeOptions {
  /** 当前运行场景上下文；嵌入模式的数据请求会据此追加 sceneId。 */
  getRuntimeContext?: () => DataRequestRuntimeContext
  getDatasets?: () => Dataset[]
  getPublicRequests: () => PublicRequestConfig[]
  getRequestGlobalConfig: () => RequestGlobalConfig
  /** 二维组件始终从现有部件仓库读取；测试可注入轻量替身。 */
  widgetDataService?: Pick<
    WidgetDataRuntimeService,
    | 'applyStaticDataConfigs'
    | 'collectRemoteEntries'
    | 'executeRemoteEntry'
    | 'applyRemoteExecutionResult'
    | 'getDataConfigForEntry'
    | 'applyRemoteResult'
    | 'isQuizLoaded'
  >
  /** 三维对象使用领域快照读取，因而同一逻辑可覆盖本地三维和地理信息系统场景。 */
  getSceneObjects?: () => readonly SceneObject[]
  /** 只把数据结果写入当前 Runtime，不修改编辑场景 Store 和持久化快照。 */
  applySceneObject?: (object: SceneObject, options?: { runtimeOnly?: boolean }) => void | Promise<void>
}

const resolvePublicRequestPayload = (response: unknown): unknown => {
  if (!response || typeof response !== 'object') return response
  const record = response as { data?: unknown; content?: unknown }
  if (record.data !== undefined) return record.data
  if (record.content !== undefined) return record.content
  return response
}

const createSingleRequestConfig = (
  dataConfig: ComponentDataConfig,
  requestId: string,
): ComponentDataConfig | null => {
  const item = getDataConfigRequests(dataConfig).find((request) => request.id === requestId)
  if (!item) return null
  return {
    ...dataConfig,
    request: item.request,
    extractor: item.extractor,
    dataset: item.dataset,
    bindings: item.bindings,
    filterFn: item.filterFn,
    requests: [item],
  }
}

const normalizeBoolean = (value: unknown) => {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string')
    return !['', '0', 'false', 'no', 'off'].includes(value.toLowerCase())
  return Boolean(value)
}

const normalizeVector = (value: unknown): [number, number, number] | null => {
  if (Array.isArray(value) && value.length >= 3) {
    const vector = value.slice(0, 3).map(Number)
    return vector.every(Number.isFinite) ? (vector as [number, number, number]) : null
  }
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const vector = [Number(record.x), Number(record.y), Number(record.z)]
  return vector.every(Number.isFinite) ? (vector as [number, number, number]) : null
}

/**
 * 将引擎中立的数据绑定投影到领域对象副本。
 * 地理信息系统对象的位置与姿态分别映射为经纬高和航向/俯仰/横滚，本地对象保持三元数组语义。
 */
const applySceneObjectBindings = (
  object: SceneObject,
  bindings: ComponentDataBindingRule[],
  row: Record<string, unknown> | undefined,
): SceneObject => {
  if (!row) return object
  let next = object
  bindings.forEach((binding) => {
    if (binding.kind !== 'object' || !(binding.sourceField in row)) return
    const rawValue = row[binding.sourceField]
    if (binding.targetPath === 'visible') {
      next = { ...next, visible: normalizeBoolean(rawValue) }
      return
    }
    const vector = normalizeVector(rawValue)
    if (!vector) return
    const transform = next.transform
    if (binding.targetPath === 'scale') {
      next = { ...next, transform: { ...transform, scale: vector } }
      return
    }
    if (transform.kind === 'local') {
      if (binding.targetPath === 'position') {
        next = { ...next, transform: { ...transform, position: vector } }
      } else if (binding.targetPath === 'rotation') {
        next = { ...next, transform: { ...transform, rotation: vector } }
      }
      return
    }
    if (binding.targetPath === 'position') {
      next = {
        ...next,
        transform: {
          ...transform,
          longitude: vector[0],
          latitude: vector[1],
          height: vector[2],
        },
      }
    } else if (binding.targetPath === 'rotation') {
      next = {
        ...next,
        transform: { ...transform, heading: vector[0], pitch: vector[1], roll: vector[2] },
      }
    }
  })
  return next
}

/**
 * 场景级统一数据请求调度器。
 *
 * 二维组件和三维对象只负责提供配置与结果应用；普通请求按“域 + 实例 + 请求项”独立轮询，公共接口
 * 跨二维、三维按公共接口编号合并为一个任务。调度器不依赖具体渲染引擎，编辑器与发布预览、
 * 本地三维与地理信息系统场景共用同一失败隔离、并发保护和销毁流程。
 */
export class SceneDataPollingRuntime {
  private readonly widgetDataService: SceneDataPollingRuntimeOptions['widgetDataService']
  /** 逐条翻页复用请求执行器，但只在预览初始化及跨页时发请求。 */
  private readonly recordPaginationRuntime: RecordPaginationRuntime
  /** 当前场景会话内已加载的测验编号；防止共享公共接口轮询覆盖用户答题状态。 */
  private readonly loadedQuizWidgetIds = new Set<string>()
  /** 组件可显式重试加载失败的题库；普通交互不通过此映射重发请求。 */
  private readonly quizEntriesByWidgetId = new Map<string, SceneDataRemoteEntry[]>()
  private readonly tasks = new Map<string, RemoteTask>()
  /** 按目标直达其请求，动作等待不扫描全场景任务。 */
  private readonly tasksByTarget = new Map<string, RemoteTask[]>()
  private readonly publicTasks = new Map<string, PublicTask>()
  private readonly publicDeliveries = new Map<RemoteTask, object>()
  /** 共享参数只属于当前会话；记录持久输入签名，在用户编辑接口后废弃旧覆盖。 */
  private readonly publicRequestOverrides = new Map<
    string,
    { signature: string; config: PublicRequestConfig }
  >()
  /** 持久输入与运行时快照分开记录，不能把交互覆盖误判成编辑配置改变。 */
  private readonly sourceSignatures = new Map<string, Map<string, string>>()
  private readonly objectPresentationSignatures = new Map<string, string>()
  private readonly staticWidgetSignatures = new Map<string, string>()
  private readonly staticObjectSignatures = new Map<string, string>()
  private readonly runtimeObjectSnapshots = new Map<string, SceneObject>()
  /** 参数覆盖属于运行态；二维持久化配置不变，避免其监听器重启全部请求。 */
  private readonly widgetRequestOverrides = new Map<string, ComponentDataConfig>()
  private readonly ajaxEntriesByTarget = new Map<string, Map<string, SceneDataRemoteEntry>>()
  /** 三维对象设备绑定的状态查询任务；状态只写入当前运行时快照，不进入场景保存数据。 */
  private readonly iotStateTasks = new Map<string, IotStateTask>()
  /** 当前场景复用一条已认证连接，避免每个模型实例各自建立 WebSocket。 */
  private readonly iotStateWebSocket = createIotStateWebSocketClient()
  private unregisterParameterHandler: (() => void) | null = null
  private running = false
  private generation = 0

  constructor(private readonly options: SceneDataPollingRuntimeOptions) {
    this.recordPaginationRuntime = new RecordPaginationRuntime({
      ...options,
      getPublicRequests: () => this.getRuntimePublicRequests(),
      // 翻页协调只比较持久输入，避免运行时共享传参被误判为配置修改而重复初始化。
      getPublicRequestDefinitions: options.getPublicRequests,
    })
    this.widgetDataService =
      options.widgetDataService ??
      new WidgetDataRuntimeService({
        getDatasets: options.getDatasets ?? (() => []),
        getPublicRequests: options.getPublicRequests,
        getRequestGlobalConfig: options.getRequestGlobalConfig,
        getRuntimeContext: options.getRuntimeContext,
      })
  }

  async start(): Promise<void> {
    this.running = true
    const definitions = new Map(
      this.options.getPublicRequests().map((request) => [request.id, request]),
    )
    for (const [id, override] of this.publicRequestOverrides) {
      if (JSON.stringify(definitions.get(id)) !== override.signature)
        this.publicRequestOverrides.delete(id)
    }
    const generation = this.generation
    const sceneObjects = [...(this.options.getSceneObjects?.() ?? [])]
    const objectSources = new Map(sceneObjects.map((object) => [object.id, object]))
    const objectIds = new Set(objectSources.keys())
    // 合并持久化输入和已有运行态；新增模型不能把既有模型恢复成保存时的默认参数。
    for (const object of sceneObjects) {
      const key = `object:${object.id}`
      const previous = this.runtimeObjectSnapshots.get(object.id)
      const source = normalizeDataConfig(
        object.metadata?.dataConfig as ComponentDataConfig | undefined,
      )
      const merged =
        source &&
        reconcileRuntimeDataConfig(
          source,
          normalizeDataConfig(previous?.metadata?.dataConfig as ComponentDataConfig | undefined) ??
            undefined,
          this.sourceSignatures.get(key),
        )
      const presentation = JSON.stringify([object.visible, object.transform])
      const keepPresentation =
        previous && this.objectPresentationSignatures.get(object.id) === presentation
      this.runtimeObjectSnapshots.set(object.id, {
        ...object,
        ...(keepPresentation ? { visible: previous.visible, transform: previous.transform } : {}),
        metadata: { ...object.metadata, ...(merged ? { dataConfig: merged.config } : {}) },
      })
      if (merged) this.sourceSignatures.set(key, merged.signatures)
      else this.sourceSignatures.delete(key)
      this.objectPresentationSignatures.set(object.id, presentation)
    }
    for (const id of this.runtimeObjectSnapshots.keys()) {
      if (objectIds.has(id)) continue
      this.runtimeObjectSnapshots.delete(id)
      this.objectPresentationSignatures.delete(id)
      this.sourceSignatures.delete(`object:${id}`)
      this.staticObjectSignatures.delete(id)
    }
    const iotStateWork = this.syncIotStateTasks(sceneObjects, generation)
    const retainedStaticWidgets = new Set<string>()
    this.widgetDataService?.applyStaticDataConfigs((widget, config) => {
      retainedStaticWidgets.add(widget.id)
      const signature = JSON.stringify(
        getDataConfigRequests(config)
          .filter((item) => item.request.type === 'static' || item.request.type === 'dataset')
          .map((item) => [item.id, requestInputSignature(item)]),
      )
      const changed = this.staticWidgetSignatures.get(widget.id) !== signature
      this.staticWidgetSignatures.set(widget.id, signature)
      return changed
    })
    for (const id of this.staticWidgetSignatures.keys()) {
      if (!retainedStaticWidgets.has(id)) this.staticWidgetSignatures.delete(id)
    }
    // 静态数据在进入异步等待前同步提交快照；慢请求不阻塞其他批次新增对象的初始化。
    const staticObjects = sceneObjects.filter((object) => {
      const config = normalizeDataConfig(
        object.metadata?.dataConfig as ComponentDataConfig | undefined,
      )
      const signature = JSON.stringify(
        getDataConfigRequests(config)
          .filter((item) => item.request.type === 'static')
          .map((item) => [item.id, requestInputSignature(item)]),
      )
      const changed = this.staticObjectSignatures.get(object.id) !== signature
      this.staticObjectSignatures.set(object.id, signature)
      return changed
    })
    const staticWork = this.applyStaticSceneObjectData(staticObjects, generation)
    const entries = [
      ...(this.widgetDataService?.collectRemoteEntries() ?? []),
      ...this.collectSceneObjectEntries(sceneObjects),
    ].filter(
      (entry) =>
        entry.kind !== 'widget' || entry.target.component?.info?.keyName !== 'VRecordPagination',
    )
    const publicRequests = new Map(
      this.options.getPublicRequests().map((request) => [request.id, request]),
    )
    const sharedSignature = JSON.stringify([
      this.options.getRequestGlobalConfig(),
      this.options.getRuntimeContext?.(),
    ])
    const retained = new Set<string>()
    const created: SceneDataRemoteEntry[] = []
    const widgetConfigs = new Map<string, ComponentDataConfig>()
    this.ajaxEntriesByTarget.clear()
    this.tasksByTarget.clear()
    this.quizEntriesByWidgetId.clear()
    for (const entry of entries) {
      const key = this.getEntryKey(entry)
      const targetKey = this.getTargetKey(entry)
      retained.add(key)
      const config =
        entry.kind === 'widget'
          ? this.widgetDataService?.getDataConfigForEntry(entry)
          : normalizeDataConfig(
              objectSources.get(entry.targetId)?.metadata?.dataConfig as
                | ComponentDataConfig
                | undefined,
            )
      // 二维完整配置每个目标只处理一次，保留未变化请求的参数覆盖。
      if (entry.kind === 'widget' && !widgetConfigs.has(entry.target.id)) {
        const source = normalizeDataConfig(entry.target.component?.dataConfig)
        if (source) {
          const merged = reconcileRuntimeDataConfig(
            source,
            this.widgetRequestOverrides.get(entry.target.id),
            this.sourceSignatures.get(targetKey),
          )
          widgetConfigs.set(entry.target.id, merged.config)
          if (this.widgetRequestOverrides.has(entry.target.id))
            this.widgetRequestOverrides.set(entry.target.id, merged.config)
          this.sourceSignatures.set(targetKey, merged.signatures)
        }
      }
      const item = getDataConfigRequests(config).find((item) => item.id === entry.requestId)
      const signature = JSON.stringify([
        sharedSignature,
        item && requestInputSignature(item),
        entry.intervalSeconds,
        entry.intervalUnit,
        entry.requestType,
        entry.publicRequestId && publicRequests.get(entry.publicRequestId),
      ])
      const previous = this.tasks.get(key)
      let task: RemoteTask
      if (previous?.signature === signature) {
        // 保留任务身份和定时器，只替换目标引用；在途响应也会回填到最新实例。
        task = previous
        task.entry = entry
      } else {
        if (previous?.timer) clearInterval(previous.timer)
        task = { entry, signature, version: 0, inflight: new Set() }
        this.tasks.set(key, task)
        created.push(entry)
        if (isQuizWidgetEntry(entry)) {
          this.loadedQuizWidgetIds.delete(entry.target.id)
          setQuizRuntimeStatus(entry.target.id, 'loading')
        }
        if (entry.requestType === 'ajax') this.scheduleAjaxEntry(entry, generation)
      }
      const targetTasks = this.tasksByTarget.get(targetKey) ?? []
      targetTasks.push(task)
      this.tasksByTarget.set(targetKey, targetTasks)
      if (isQuizWidgetEntry(entry)) {
        const group = this.quizEntriesByWidgetId.get(entry.target.id) ?? []
        group.push(entry)
        this.quizEntriesByWidgetId.set(entry.target.id, group)
      }
      if (entry.requestType === 'ajax') {
        const requests = this.ajaxEntriesByTarget.get(targetKey) ?? new Map()
        requests.set(entry.requestId, entry)
        this.ajaxEntriesByTarget.set(targetKey, requests)
      }
    }
    for (const [key, task] of this.tasks) {
      if (retained.has(key)) continue
      if (task.timer) clearInterval(task.timer)
      this.tasks.delete(key)
      if (isQuizWidgetEntry(task.entry) && !this.quizEntriesByWidgetId.has(task.entry.target.id)) {
        this.loadedQuizWidgetIds.delete(task.entry.target.id)
        clearQuizRuntimeStatus([task.entry.target.id])
      }
    }
    const widgetIds = new Set(
      entries.filter((entry) => entry.kind === 'widget').map((entry) => entry.target.id),
    )
    for (const id of this.widgetRequestOverrides.keys()) {
      if (!widgetIds.has(id)) this.widgetRequestOverrides.delete(id)
    }
    for (const key of this.sourceSignatures.keys()) {
      if (key.startsWith('widget:') && !widgetIds.has(key.slice(7)))
        this.sourceSignatures.delete(key)
    }
    // 会话中的传参入口只注册一次，增量协调没有注销窗口。
    this.unregisterParameterHandler ??= registerSceneRequestParameterHandler(
      (action) => this.passParameters(action),
      (objectId) => this.getSceneObjectDataConfig(objectId),
      (kind, ids) => this.waitForTargets(kind, ids),
    )
    const publicGroups = this.groupPublicEntries(entries)
    for (const [id, group] of publicGroups)
      this.schedulePublicGroup(id, group, generation, sharedSignature)
    for (const [id, task] of this.publicTasks) {
      if (publicGroups.has(id)) continue
      if (task.timer) clearInterval(task.timer)
      this.publicTasks.delete(id)
    }
    this.recordPaginationRuntime.start()
    // 首轮只执行新增或自身输入变化的任务，同时登记目标就绪屏障供后续配置动作等待。
    const work: Promise<unknown>[] = [staticWork, ...iotStateWork]
    for (const entry of created) {
      if (entry.requestType !== 'ajax') continue
      const task = this.tasks.get(this.getEntryKey(entry))!
      const pending = this.executeAjaxEntry(entry, generation)
      task.initialWork = pending
      void pending.then(() => {
        if (task.initialWork === pending) task.initialWork = undefined
      })
      work.push(pending)
    }
    for (const [id, group] of this.groupPublicEntries(created)) {
      const pending = this.executePublicGroup(id, group, generation, true)
      const owners = group.map((entry) => this.tasks.get(this.getEntryKey(entry))!)
      owners.forEach((owner) => {
        owner.initialWork = pending
      })
      void pending.then(() =>
        owners.forEach((owner) => {
          if (owner.initialWork === pending) owner.initialWork = undefined
        }),
      )
      work.push(pending)
    }
    await Promise.allSettled(work)
  }

  /** 目标首次数据就绪后再执行赋值/显隐等配置动作，避免初始化回填把动作结果覆盖。 */
  waitForTargets(
    targetKind: 'widget' | 'object',
    targetIds: readonly string[],
  ): void | Promise<void> {
    const work: Promise<void>[] = []
    for (const id of targetIds) {
      for (const task of this.tasksByTarget.get(`${targetKind}:${id}`) ?? []) {
        if (task.initialWork) work.push(task.initialWork)
      }
    }
    if (targetKind === 'widget') {
      const pagination = this.recordPaginationRuntime.waitForTargets(targetIds)
      if (pagination) work.push(pagination)
    }
    if (work.length) return Promise.allSettled(work).then(() => undefined)
  }

  stop(): void {
    this.recordPaginationRuntime.stop()
    this.stopPollingTasks()
  }

  /** 仅退出预览、切换场景或销毁才清空会话；增量加载不能调用此方法。 */
  private stopPollingTasks(): void {
    this.running = false
    this.unregisterParameterHandler?.()
    this.unregisterParameterHandler = null
    this.generation += 1
    this.tasks.forEach((task) => {
      if (task.timer) clearInterval(task.timer)
    })
    this.publicTasks.forEach((task) => {
      if (task.timer) clearInterval(task.timer)
    })
    this.tasks.clear()
    this.tasksByTarget.clear()
    this.publicTasks.clear()
    this.publicRequestOverrides.clear()
    this.publicDeliveries.clear()
    this.sourceSignatures.clear()
    this.objectPresentationSignatures.clear()
    this.staticWidgetSignatures.clear()
    this.staticObjectSignatures.clear()
    this.runtimeObjectSnapshots.clear()
    this.loadedQuizWidgetIds.clear()
    this.widgetRequestOverrides.clear()
    this.ajaxEntriesByTarget.clear()
    this.iotStateTasks.forEach((task) => {
      if (task.timer) clearInterval(task.timer)
      task.unsubscribe?.()
    })
    this.iotStateTasks.clear()
    this.iotStateWebSocket.dispose()
    clearQuizRuntimeStatus(this.quizEntriesByWidgetId.keys())
    this.quizEntriesByWidgetId.clear()
  }

  dispose(): void {
    this.stop()
    this.runtimeObjectSnapshots.clear()
  }

  private getSceneObject(objectId: string) {
    return this.runtimeObjectSnapshots.get(objectId) ?? null
  }

  /** 从设备绑定读取标准点位，要求点位同时存在于现有对象数据映射中。 */
  private getIotStateBinding(object: SceneObject) {
    const dataConfig = this.getSceneObjectDataConfig(object.id)
    const binding = object.metadata?.deviceBinding
    // 数据源与映射按请求项配对，其他接口的数据映射不能被物联网状态覆盖。
    const requests = getDataConfigRequests(dataConfig)
    const item = requests.find(({ request }) => request.type === 'adapter'
      && (request.config as { adapterId?: unknown }).adapterId === 'iot-state')
    const adapterConfig = item?.request.config as { adapterId?: unknown; config?: unknown } | undefined
    const adapter = adapterConfig?.adapterId === 'iot-state' ? getDataSourceAdapter('iot-state') : undefined
    const iotConfig = adapter?.normalizeConfig(adapterConfig?.config)
    if (item && !iotConfig) return null
    if (!binding && !iotConfig) return null
    const deviceId = iotConfig?.deviceId || (typeof (binding as { deviceId?: unknown })?.deviceId === 'string'
      ? (binding as { deviceId: string }).deviceId.trim()
      : '')
    const pointCode = iotConfig?.pointCode || (typeof (binding as { pointCode?: unknown })?.pointCode === 'string'
      ? (binding as { pointCode: string }).pointCode.trim()
      : '')
    if (!deviceId || !pointCode) return null
    const bindings = (item?.bindings ?? requests.flatMap((item) => item.bindings ?? []))
      .filter((item) => item.kind === 'object')
    if (!bindings.length) return null
    const intervalSeconds = iotConfig?.pollIntervalSeconds || (typeof (binding as { pollIntervalSeconds?: unknown })?.pollIntervalSeconds === 'number'
      ? (binding as { pollIntervalSeconds: number }).pollIntervalSeconds
      : 5)
    const delivery = iotConfig?.delivery || ((binding as { delivery?: unknown })?.delivery === 'websocket' || (binding as { delivery?: unknown })?.delivery === 'auto'
      ? (binding as { delivery: 'auto' | 'websocket' }).delivery
      : 'polling')
    return { deviceId, pointCode, bindings, intervalMs: Math.max(1000, intervalSeconds * 1000), delivery }
  }

  private syncIotStateTasks(sceneObjects: readonly SceneObject[], generation: number): Promise<void>[] {
    this.iotStateTasks.forEach((task) => {
      if (task.timer) clearInterval(task.timer)
      task.unsubscribe?.()
    })
    this.iotStateTasks.clear()
    return sceneObjects.flatMap((object) => {
      const binding = this.getIotStateBinding(object)
      if (!binding) return []
      const task: IotStateTask = {
        objectId: object.id, deviceId: binding.deviceId, pointCode: binding.pointCode,
        bindings: binding.bindings,
        intervalMs: binding.intervalMs, running: false,
        delivery: binding.delivery,
        subscriptionId: `iot-${generation}-${object.id}`,
      }
      this.iotStateTasks.set(object.id, task)
      if (task.delivery === 'polling') {
        task.timer = setInterval(() => void this.executeIotStateTask(task, generation), task.intervalMs)
        return [this.executeIotStateTask(task, generation)]
      }
      return [this.subscribeIotStateTask(task, generation)]
    })
  }

  /** WebSocket 首次确认后立即取一次快照；自动模式失败时才启用查询轮询补偿。 */
  private async subscribeIotStateTask(task: IotStateTask, generation: number): Promise<void> {
    try {
      const unsubscribe = await this.iotStateWebSocket.subscribe(
        {
          subscriptionId: task.subscriptionId,
          sceneId: this.options.getRuntimeContext?.()?.sceneId || undefined,
          objectId: task.objectId,
          deviceId: task.deviceId,
          pointCode: task.pointCode,
        },
        (update) => {
          if (update.stateVersion && task.lastStateVersion && update.stateVersion <= task.lastStateVersion) return
          task.lastStateVersion = update.stateVersion || update.eventId
          void this.applyIotSnapshot(task, update, generation).catch(error => {
            appLogger.error('SceneDataPollingRuntime', '物联网状态应用失败', error)
          })
        },
        () => { void this.executeIotStateTask(task, generation) },
      )
      if (!this.running || generation !== this.generation || this.iotStateTasks.get(task.objectId) !== task) {
        unsubscribe()
        return
      }
      task.unsubscribe = unsubscribe
      await this.executeIotStateTask(task, generation)
    } catch (error) {
      if (task.delivery === 'auto' && this.running && generation === this.generation && this.iotStateTasks.get(task.objectId) === task) {
        task.timer = setInterval(() => void this.executeIotStateTask(task, generation), task.intervalMs)
        await this.executeIotStateTask(task, generation)
      } else if (generation === this.generation) {
        appLogger.error('SceneDataPollingRuntime', `物联网实时订阅失败 (${task.objectId})`, error)
      }
    }
  }

  private async executeIotStateTask(task: IotStateTask, generation: number): Promise<void> {
    if (!this.running || generation !== this.generation || task.running) return
    task.running = true
    try {
      const sceneId = this.options.getRuntimeContext?.()?.sceneId
      const versionBeforeQuery = task.lastStateVersion
      const snapshot: IotStateSnapshot | null = sceneId
        ? await getIotState(task.deviceId, task.pointCode, { sceneId, objectId: task.objectId })
        : await getIotState(task.deviceId, task.pointCode)
      // 查询发出后收到的推送优先，避免较晚返回的首屏快照覆盖实时值。
      if (versionBeforeQuery !== task.lastStateVersion) return
      if (!snapshot || !this.running || generation !== this.generation || this.iotStateTasks.get(task.objectId) !== task) return
      await this.applyIotSnapshot(task, snapshot, generation)
    } catch (error) {
      if (generation === this.generation) appLogger.error('SceneDataPollingRuntime', `物联网状态查询失败 (${task.objectId})`, error)
    } finally {
      task.running = false
    }
  }

  private async applyIotSnapshot(
    task: IotStateTask,
    snapshot: IotStateSnapshot,
    generation: number,
  ): Promise<void> {
    if (!this.running || generation !== this.generation || this.iotStateTasks.get(task.objectId) !== task) return
    const object = this.getSceneObject(task.objectId)
    if (!object) return
    const row = { ...snapshot, value: snapshot.value, [snapshot.pointCode]: snapshot.value }
    const nextObject = applySceneObjectBindings(object, task.bindings, row)
    this.runtimeObjectSnapshots.set(task.objectId, nextObject)
    if (nextObject !== object) await this.options.applySceneObject?.(nextObject, { runtimeOnly: true })
  }

  /**
   * 同一动作先完成全部参数覆盖，再按请求编号各执行一次。
   * 正在途中的旧请求不阻塞主动刷新；请求版本负责丢弃旧结果，普通轮询继续保持并发去重。
   */
  async passParameters(action: SceneRequestParameterAction): Promise<void> {
    if (!this.running) return
    const publicAssignments: SceneRequestParameterAction['assignments'] = []
    const localAssignments: SceneRequestParameterAction['assignments'] = []
    for (const assignment of action.assignments) {
      ;(isPublicRequestParameterTarget(assignment.targetProperty)
        ? publicAssignments
        : localAssignments
      ).push(assignment)
    }
    // 旧动态请求直接沿用原入口，避免重复解析参数；无效公共映射也不能误触发组件重试。
    if (!publicAssignments.length) return this.passLocalParameters(action)
    const localAction = { ...action, assignments: localAssignments }
    const task = this.tasksByTarget.get(`${action.targetKind}:${action.targetId}`)?.[0]
    const config =
      action.targetKind === 'widget'
        ? task?.entry.kind === 'widget'
          ? normalizeDataConfig(task.entry.target.component.dataConfig)
          : this.recordPaginationRuntime.getDataConfig(action.targetId)
        : this.getSceneObjectDataConfig(action.targetId)
    const updated =
      config &&
      applyInteractionRequestParameters(config, publicAssignments, this.getRuntimePublicRequests())
    if (!updated?.publicRequests?.length) {
      if (localAssignments.length) await this.passLocalParameters(localAction)
      return
    }
    const definitions = new Map(
      this.options.getPublicRequests().map((request) => [request.id, request]),
    )
    // 先提交本次动作的全部共享参数，再请求；同接口重复引用已由参数工具合并。
    for (const request of updated.publicRequests) {
      this.publicRequestOverrides.set(request.id, {
        signature: JSON.stringify(definitions.get(request.id)),
        config: request,
      })
    }
    const work: Promise<unknown>[] = updated.publicRequests.map((request) => {
      const group = this.publicTasks.get(request.id)
      if (!group) return Promise.resolve()
      // 显式公共刷新同时重置其测验订阅者；普通轮询仍保护用户正在填写的答案。
      for (const entry of group.entries) {
        if (!isQuizWidgetEntry(entry)) continue
        this.loadedQuizWidgetIds.delete(entry.target.id)
        setQuizRuntimeStatus(entry.target.id, 'loading')
      }
      return this.executePublicGroup(request.id, group.entries, this.generation, false, true)
    })
    work.push(
      this.recordPaginationRuntime.refreshPublicRequests(
        new Set(updated.publicRequests.map((request) => request.id)),
      ),
    )
    if (localAssignments.length) work.push(this.passLocalParameters(localAction))
    await Promise.allSettled(work)
  }

  /** 运行时覆盖按公共编号统一读取，普通订阅、后来加入的组件和翻页请求沿用同一组筛选条件。 */
  private getRuntimePublicRequests(): PublicRequestConfig[] {
    return this.options
      .getPublicRequests()
      .map((request) => this.publicRequestOverrides.get(request.id)?.config ?? request)
  }

  /** 普通请求保持原有实例隔离规则；公共接口赋值已由上层统一处理。 */
  private async passLocalParameters(action: SceneRequestParameterAction): Promise<void> {
    if (!this.running) return
    // 翻页组件的外部筛选参数只覆盖实例，并从第一页重新初始化；不恢复定时轮询。
    if (
      action.targetKind === 'widget' &&
      (await this.recordPaginationRuntime.passParameters(action.targetId, action.assignments))
    )
      return
    if (action.targetKind === 'widget') {
      const quizEntries = this.quizEntriesByWidgetId.get(action.targetId)
      if (quizEntries) {
        this.loadedQuizWidgetIds.delete(action.targetId)
        setQuizRuntimeStatus(action.targetId, 'loading')
        const ajaxRetries = quizEntries
          .filter((entry) => entry.requestType === 'ajax')
          .map((entry) => this.executeAjaxEntry(entry, this.generation, true))
        const publicRetries = new Map<string, SceneDataRemoteEntry[]>()
        quizEntries.forEach((entry) => {
          if (entry.requestType !== 'public' || !entry.publicRequestId) return
          const group = publicRetries.get(entry.publicRequestId) ?? []
          group.push(entry)
          publicRetries.set(entry.publicRequestId, group)
        })
        await Promise.allSettled([
          ...ajaxRetries,
          ...[...publicRetries].map(([requestId, group]) =>
            this.executePublicGroup(requestId, group, this.generation),
          ),
        ])
        return
      }
    }
    const targetKey = `${action.targetKind}:${action.targetId}`
    const entries = this.ajaxEntriesByTarget.get(targetKey)
    const firstEntry = entries?.values().next().value as SceneDataRemoteEntry | undefined
    if (!entries || !firstEntry) return
    const dataConfig =
      firstEntry.kind === 'widget'
        ? (this.widgetRequestOverrides.get(action.targetId) ??
          normalizeDataConfig(firstEntry.target.component.dataConfig))
        : this.getSceneObjectDataConfig(action.targetId)
    if (!dataConfig) return
    const updated = applyInteractionRequestParameters(dataConfig, action.assignments)
    if (!updated.requestIds.length) return
    if (firstEntry.kind === 'widget') {
      this.widgetRequestOverrides.set(action.targetId, updated.config)
    } else {
      const object = this.getSceneObject(action.targetId)
      if (!object) return
      this.runtimeObjectSnapshots.set(action.targetId, {
        ...object,
        metadata: { ...object.metadata, dataConfig: updated.config },
      })
    }
    await Promise.allSettled(
      updated.requestIds.map((requestId) => {
        const entry = entries.get(requestId)
        return entry ? this.executeAjaxEntry(entry, this.generation, true) : Promise.resolve()
      }),
    )
  }

  /** 域前缀使同编号的二维组件与三维对象不会共享参数或请求状态。 */
  private getTargetKey(entry: SceneDataRemoteEntry) {
    return entry.kind === 'widget' ? `widget:${entry.target.id}` : `object:${entry.targetId}`
  }

  private getSceneObjectDataConfig(objectId: string) {
    const object = this.getSceneObject(objectId)
    return normalizeDataConfig(object?.metadata?.dataConfig as ComponentDataConfig | undefined)
  }

  private collectSceneObjectEntries(
    sceneObjects: readonly SceneObject[],
  ): SceneObjectRemoteEntry[] {
    const publicRequests = this.options.getPublicRequests()
    const globalConfig = this.options.getRequestGlobalConfig() || createEmptyRequestGlobalConfig()
    return sceneObjects.flatMap((object) => {
      const dataConfig = normalizeDataConfig(
        object.metadata?.dataConfig as ComponentDataConfig | undefined,
      )
      if (!dataConfig) return []
      return getDataConfigRequests(dataConfig).flatMap((item) => {
        if (item.request.type !== 'ajax' && item.request.type !== 'public') return []
        const itemConfig = createSingleRequestConfig(dataConfig, item.id)
        if (!itemConfig) return []
        const interval = resolvePreviewRemoteInterval(itemConfig, publicRequests, globalConfig)
        return [
          {
            kind: 'object' as const,
            targetId: object.id,
            intervalSeconds: interval.seconds,
            intervalUnit: interval.unit,
            requestType: item.request.type,
            publicRequestId:
              item.request.type === 'public'
                ? (item.request.config as { publicRequestId?: string | null }).publicRequestId
                : null,
            requestId: item.id,
          },
        ]
      })
    })
  }

  private async applyStaticSceneObjectData(
    sceneObjects: readonly SceneObject[],
    generation: number,
  ) {
    const tasks = sceneObjects.flatMap((object) => {
      const dataConfig = normalizeDataConfig(
        object.metadata?.dataConfig as ComponentDataConfig | undefined,
      )
      if (!dataConfig) return []
      return getDataConfigRequests(dataConfig).flatMap((item) => {
        if (item.request.type !== 'static') return []
        const itemConfig = createSingleRequestConfig(dataConfig, item.id)
        if (!itemConfig) return []
        const resolved = resolveComponentData(itemConfig)
        return [
          this.applyObjectRows(
            object.id,
            item.id,
            resolved.source,
            resolved.dimensions,
            generation,
          ),
        ]
      })
    })
    await Promise.allSettled(tasks)
  }

  private groupPublicEntries(entries: SceneDataRemoteEntry[]) {
    const groups = new Map<string, SceneDataRemoteEntry[]>()
    entries.forEach((entry) => {
      if (entry.requestType !== 'public' || !entry.publicRequestId) return
      const group = groups.get(entry.publicRequestId) ?? []
      group.push(entry)
      groups.set(entry.publicRequestId, group)
    })
    return groups
  }

  private scheduleAjaxEntry(entry: SceneDataRemoteEntry, generation: number) {
    /** 首轮请求仍由统一启动流程发出；测验不得继承场景或接口自动轮询间隔。 */
    if (isQuizWidgetEntry(entry)) return
    if (!entry.intervalSeconds || entry.intervalSeconds <= 0) return
    const intervalMs = intervalUnitHandle(entry.intervalSeconds, entry.intervalUnit || 'second')
    if (intervalMs <= 0) return
    const task = this.tasks.get(this.getEntryKey(entry))
    if (task)
      task.timer = setInterval(() => void this.executeAjaxEntry(task.entry, generation), intervalMs)
  }

  /** 公共接口任务按接口输入协调，新增订阅只更新目标集合，不重排已有轮询。 */
  private schedulePublicGroup(
    publicRequestId: string,
    group: SceneDataRemoteEntry[],
    generation: number,
    sharedSignature: string,
  ) {
    const signature = JSON.stringify([
      sharedSignature,
      this.options.getPublicRequests().find((item) => item.id === publicRequestId),
    ])
    let task = this.publicTasks.get(publicRequestId)
    if (!task || task.signature !== signature) {
      if (task?.timer) clearInterval(task.timer)
      task = { signature, entries: group, intervalMs: 0, hasPayload: false, version: 0 }
      this.publicTasks.set(publicRequestId, task)
    }
    task.entries = group
    const intervalEntry = group.find(
      (entry) => !isQuizWidgetEntry(entry) && (entry.intervalSeconds ?? 0) > 0,
    )
    const intervalMs = intervalEntry?.intervalSeconds
      ? intervalUnitHandle(intervalEntry.intervalSeconds, intervalEntry.intervalUnit || 'second')
      : 0
    if (task.intervalMs === intervalMs) return
    if (task.timer) clearInterval(task.timer)
    task.timer = undefined
    task.intervalMs = intervalMs
    if (intervalMs <= 0) return
    const current = task
    task.timer = setInterval(
      () => void this.executePublicGroup(publicRequestId, current.entries, generation),
      intervalMs,
    )
  }

  private getEntryKey(entry: SceneDataRemoteEntry) {
    return entry.kind === 'widget'
      ? `twoD:${entry.target.id}:${entry.requestId}`
      : `threeD:${entry.targetId}:${entry.requestId}`
  }

  private async executeAjaxEntry(entry: SceneDataRemoteEntry, generation: number, force = false) {
    const entryKey = this.getEntryKey(entry)
    const owner = this.tasks.get(entryKey)
    if (!owner) return
    if (generation !== this.generation || (!force && owner.inflight.has(owner.version))) return
    const version = ++owner.version
    const taskKey = `${generation}:ajax:${entryKey}:${version}`
    const isCurrent = () =>
      generation === this.generation &&
      this.tasks.get(entryKey) === owner &&
      owner.version === version
    owner.inflight.add(version)
    try {
      if (entry.kind === 'widget') {
        const override = this.widgetRequestOverrides.get(entry.target.id)
        const itemOverride = override && createSingleRequestConfig(override, entry.requestId)
        const result = itemOverride
          ? await this.widgetDataService?.executeRemoteEntry(entry, itemOverride)
          : await this.widgetDataService?.executeRemoteEntry(entry)
        if (result && isCurrent()) {
          // 配置引用替换不改变任务身份，结果必须提交到协调后的当前组件。
          this.widgetDataService?.applyRemoteExecutionResult({
            ...result,
            target: (owner.entry as WidgetPreviewRemoteEntry).target,
          })
          if (isQuizWidgetEntry(owner.entry)) {
            this.updateQuizLoadState(
              owner.entry.target,
              this.widgetDataService?.isQuizLoaded(owner.entry.target) ?? false,
            )
          }
        } else if (!result && isCurrent() && isQuizWidgetEntry(owner.entry)) {
          setQuizRuntimeStatus(owner.entry.target.id, 'error', '题库请求未返回可用数据。')
        }
        return
      }
      const dataConfig = this.getSceneObjectDataConfig(entry.targetId)
      const itemConfig = dataConfig && createSingleRequestConfig(dataConfig, entry.requestId)
      if (!itemConfig) return
      const result = await executeComponentDataRequest(
        itemConfig,
        this.options.getPublicRequests(),
        this.options.getRequestGlobalConfig(),
        this.options.getRuntimeContext?.(),
      )
      if (!isCurrent()) return
      await this.applyObjectRows(
        entry.targetId,
        entry.requestId,
        result.source,
        result.dimensions,
        generation,
      )
    } catch (error) {
      if (isCurrent() && isQuizWidgetEntry(owner.entry)) {
        setQuizRuntimeStatus(owner.entry.target.id, 'error', '题库请求失败，请检查网络或接口配置。')
      }
      appLogger.error('SceneDataPollingRuntime', `普通请求执行失败 (${taskKey})`, error)
    } finally {
      owner.inflight.delete(version)
    }
  }

  private async executePublicGroup(
    publicRequestId: string,
    entries: SceneDataRemoteEntry[],
    generation: number,
    reusePayload = false,
    force = false,
  ) {
    const group = this.publicTasks.get(publicRequestId)
    if (!group || generation !== this.generation) return
    if (force) {
      group.version += 1
      group.pending = undefined
      group.payload = undefined
      group.hasPayload = false
    }
    const version = group.version
    const delivery = {}
    // 每个订阅任务独立去重，允许新目标加入同一在途公共请求，同时防止轮询重复分发。
    const owners = entries.flatMap((entry) => {
      const owner = this.tasks.get(this.getEntryKey(entry))
      if (!owner || (!force && this.publicDeliveries.has(owner))) return []
      this.publicDeliveries.set(owner, delivery)
      return [owner]
    })
    if (!owners.length) return
    const isCurrent = (owner: RemoteTask) =>
      generation === this.generation &&
      this.publicTasks.get(publicRequestId) === group &&
      group.version === version &&
      this.publicDeliveries.get(owner) === delivery &&
      this.tasks.get(this.getEntryKey(owner.entry)) === owner
    try {
      let response: unknown
      if (reusePayload && group.hasPayload && !group.pending) response = group.payload
      else {
        if (!group.pending) {
          const publicRequest = this.getRuntimePublicRequests().find(
            (item) => item.id === publicRequestId,
          )
          if (!publicRequest) throw new Error('公共接口配置不存在。')
          const globalConfig =
            this.options.getRequestGlobalConfig() || createEmptyRequestGlobalConfig()
          const pending = customizeHttpRequest(
            mergeAjaxRequestWithGlobalConfig(publicRequest, globalConfig),
            globalConfig,
            this.options.getRuntimeContext?.(),
          )
          group.pending = pending
          // 只缓存当前会话和当前接口输入的响应；失败不缓存，后续轮询或显式重试仍可发送。
          void pending
            .then((payload) => {
              if (this.publicTasks.get(publicRequestId) === group && group.version === version) {
                group.payload = payload
                group.hasPayload = true
              }
            })
            .catch(() => {})
            .finally(() => {
              if (group.pending === pending) group.pending = undefined
            })
        }
        response = await group.pending
      }
      const rawPayload = resolvePublicRequestPayload(response)
      await Promise.allSettled(
        owners.map(async (owner) => {
          if (!isCurrent(owner)) return
          const entry = owner.entry
          try {
            const dataConfig =
              entry.kind === 'widget'
                ? this.widgetDataService?.getDataConfigForEntry(entry)
                : this.getSceneObjectDataConfig(entry.targetId)
            const itemConfig = dataConfig && createSingleRequestConfig(dataConfig, entry.requestId)
            if (!itemConfig) {
              if (isQuizWidgetEntry(entry)) {
                setQuizRuntimeStatus(entry.target.id, 'error', '测验题库请求配置缺失。')
              }
              return
            }
            const normalized = transformRequestPayloadToRows(
              rawPayload,
              itemConfig.extractor?.resultPath,
              itemConfig.filterFn,
            )
            if (entry.kind === 'widget') {
              if (isQuizWidgetEntry(entry)) {
                if (this.loadedQuizWidgetIds.has(entry.target.id)) return
                this.widgetDataService?.applyRemoteResult(entry, normalized.source)
                this.updateQuizLoadState(
                  entry.target,
                  this.widgetDataService?.isQuizLoaded(entry.target) ?? false,
                )
                return
              }
              this.widgetDataService?.applyRemoteResult(entry, normalized.source)
            } else {
              await this.applyObjectRows(
                entry.targetId,
                entry.requestId,
                normalized.source,
                normalized.dimensions,
                generation,
              )
            }
          } catch (error) {
            if (isQuizWidgetEntry(entry) && !this.loadedQuizWidgetIds.has(entry.target.id)) {
              setQuizRuntimeStatus(
                entry.target.id,
                'error',
                '题库响应处理失败，请检查字段映射配置。',
              )
            }
            throw error
          }
        }),
      )
    } catch (error) {
      owners.forEach((owner) => {
        const entry = owner.entry
        if (
          isCurrent(owner) &&
          isQuizWidgetEntry(entry) &&
          !this.loadedQuizWidgetIds.has(entry.target.id)
        ) {
          setQuizRuntimeStatus(entry.target.id, 'error', '题库请求失败，请检查网络或接口配置。')
        }
      })
      appLogger.error('SceneDataPollingRuntime', `公共接口执行失败 (${publicRequestId})`, error)
    } finally {
      // 旧请求结束不能清除后续主动刷新登记的分发令牌。
      owners.forEach((owner) => {
        if (this.publicDeliveries.get(owner) === delivery) this.publicDeliveries.delete(owner)
      })
    }
  }

  /** 根据完整题库校验结果同步界面状态；无效响应保留具体字段错误供用户修复。 */
  private updateQuizLoadState(target: WidgetPreviewRemoteEntry['target'], loaded: boolean) {
    if (loaded) {
      this.loadedQuizWidgetIds.add(target.id)
      setQuizRuntimeStatus(target.id, 'ready')
      return
    }
    const result = validateQuizPayload(target.component.option)
    setQuizRuntimeStatus(target.id, 'error', result.error || '题库格式不正确，请检查接口返回字段。')
  }

  private async applyObjectRows(
    objectId: string,
    requestId: string,
    source: Record<string, unknown>[],
    dimensions: string[],
    generation: number,
  ) {
    if (generation !== this.generation) return
    const currentObject = this.getSceneObject(objectId)
    const dataConfig = this.getSceneObjectDataConfig(objectId)
    const itemConfig = dataConfig && createSingleRequestConfig(dataConfig, requestId)
    if (!currentObject || !dataConfig || !itemConfig) return
    const nextDataConfig = structuredClone(dataConfig)
    const nextItem = getDataConfigRequests(nextDataConfig).find((item) => item.id === requestId)
    if (nextItem) {
      nextItem.dataset.source = source
      nextItem.dataset.dimensions = dimensions
    }
    const boundObject = applySceneObjectBindings(currentObject, itemConfig.bindings, source[0])
    const nextObject: SceneObject = {
      ...boundObject,
      metadata: { ...(boundObject.metadata ?? {}), dataConfig: nextDataConfig },
    }
    /** 先更新内存快照再等待引擎，保证同一对象的其它并发请求在最新结果上继续合并。 */
    this.runtimeObjectSnapshots.set(objectId, nextObject)
    await this.options.applySceneObject?.(nextObject)
  }
}
