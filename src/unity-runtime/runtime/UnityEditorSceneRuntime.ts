import type { FrameTarget, PickWorldPoint, SceneDefinition, SceneLayer, SceneObject, ScreenPoint, ViewportHost } from '@/scene-platform'
import { createUpdateObjectTransformCommand } from '@/scene-platform'
import { BaseSceneRuntime } from '@/scene-platform/runtime/baseSceneRuntime'
import type { UnityTransport } from '../connection/UnityTransport'
import { LegacyUnityTransport, type LegacySessionConfig } from '../connection/LegacyUnityTransport'
import { waitForCloudRuntimeReady } from '../connection/waitForCloudRuntimeReady'
import { WebUnityTransport } from '../connection/WebUnityTransport'
import { JsonRpcUnityCloudRuntime } from './JsonRpcUnityCloudRuntime'
import {
  fromUnityTransform,
  getUnityDeferredRenderWarnings,
  getUnityModelAssetId,
  isUnityDeferredObject,
  projectObjectForUnity,
  projectSceneForUnity,
  projectSceneForUnityLoadedInstances,
} from './projectSceneForUnity'
import type { UnityRenderMode } from '../renderMode'
import type { SceneObjectInteractionEvent } from '@/scene-platform/runtime/sceneRuntime'
import type {
  ObjectInteractionHighlightOptions,
  ObjectInteractionMoveCameraOptions,
  ObjectInteractionSwitchViewOptions,
} from '@/scene-platform/runtime/sceneRuntime'
import type { UnityInteractionActionDto } from '../protocol/types'

export interface UnityEditorSceneRuntimeOptions {
  mode: UnityRenderMode
  cloudConfig?: LegacySessionConfig
  webBootstrapUrl?: string
  getHost: () => ViewportHost | null
  onStatus: (message: string) => void
  onWarnings?: (messages: string[]) => void
  /** 云渲染连接确认失败且通道清理完毕后通知编辑页；正常退出、短暂抖动及普通业务报错不会触发。 */
  onDisconnected?: (message: string) => void
}

/** One SceneRuntime boundary for the Web player and the cloud video stream. */
export class UnityEditorSceneRuntime extends BaseSceneRuntime {
  private transport: UnityTransport | null = null
  private unity: JsonRpcUnityCloudRuntime | null = null
  private readonly unsubscribe: Array<() => void> = []
  private video: HTMLVideoElement | null = null
  private operations = Promise.resolve()
  private focusSelectionVersion = 0
  private readonly programmaticUpdates = new Set<string>()
  private readonly missingModelAssetIds = new Set<string>()
  // 缺失模型的子节点也暂缓表现，逻辑记录继续留在完整草稿。
  private deferredDescendants = new Set<string>()
  // 分片读取只改变 Unity 表现快照，完整 SceneStore 和 Runtime 对象缓存继续保留全部节点。
  private projectedInstanceIds: Set<string> | null = null
  /** 只用于把画布逻辑像素换成相机视口比例，不在 Runtime 保存临时拖放事件。 */
  private renderContainer: HTMLElement | null = null
  /** 三维事件订阅与场景同寿命；卸载时清空，避免旧编辑页继续执行动作。 */
  private readonly objectInteractionListeners = new Set<(event: SceneObjectInteractionEvent) => void>()
  private modeOperation = Promise.resolve()
  private remoteMode: 'edit' | 'preview' = 'edit'

  constructor(type: SceneDefinition['type'], private readonly options: UnityEditorSceneRuntimeOptions) {
    super(type, `unity-${options.mode}-${type}`)
    this.capabilities.editing.objectPick = true
    this.capabilities.editing.gizmo = true
    this.capabilities.transform.local = type === 'local3d'
    this.capabilities.transform.geo = type === 'gis'
    this.capabilities.transform.terrainClamp = false
    this.capabilities.rendering.imagery = false
    this.capabilities.rendering.terrain = false
    this.capabilities.rendering.tileset = false
    this.capabilities.rendering.indoorLocalLights = false
    this.capabilities.editing.annotation = false
    this.capabilities.assets.glb = false
    this.capabilities.assets.particles = false
    for (const key of Object.keys(this.capabilities.effects) as Array<keyof typeof this.capabilities.effects>) {
      this.capabilities.effects[key] = false
    }
    this.capabilities.rendering.indoorLocalLightsUnavailableReason = '当前 Unity 渲染暂不支持灯光编辑'
  }

  override async mount(container: HTMLElement): Promise<void> {
    await super.mount(container)
    this.renderContainer = container
    if (this.options.mode === 'cloud') {
      if (!this.options.cloudConfig) throw new Error('云渲染信令尚未配置')
      const video = document.createElement('video')
      video.className = 'unity-cloud-video'
      video.style.cssText = 'width:100%;height:100%;display:block;object-fit:contain;outline:none'
      video.autoplay = true
      video.playsInline = true
      video.muted = true
      video.tabIndex = 0
      video.addEventListener('playing', () => (this.transport as LegacyUnityTransport | null)?.markVideoPlaying())
      video.addEventListener('mousedown', () => video.focus())
      // 视口右键用于Unity旋转：只取消浏览器默认菜单，保留按下、移动和松开的原有输入转发。
      video.addEventListener('contextmenu', (event) => event.preventDefault())
      for (const name of ['mousedown', 'mouseup', 'mousemove', 'wheel'] as const) {
        video.addEventListener(name, (event) => {
          if (name === 'wheel') event.preventDefault()
          ;(this.transport as LegacyUnityTransport | null)?.sendPointerInput(event, video.getBoundingClientRect())
        }, { passive: false })
      }
      for (const name of ['keydown', 'keyup'] as const) {
        video.addEventListener(name, (event) => {
          event.preventDefault()
          ;(this.transport as LegacyUnityTransport | null)?.sendKeyboardInput(event)
        })
      }
      video.addEventListener('blur', () => (this.transport as LegacyUnityTransport | null)?.sendReleaseInput())
      container.append(video)
      this.video = video
      const transport = new LegacyUnityTransport(this.options.cloudConfig, video)
      this.transport = transport
      this.unsubscribe.push(transport.onSnapshot((snapshot) => {
        this.options.onStatus(snapshot.message)
        // 使用结构化终态，避免依赖提示文案；销毁时已移除订阅，不会把主动退出误认为异常断开。
        if (!this.disposed && snapshot.state === 'failed') this.options.onDisconnected?.(snapshot.message)
      }))
      await transport.connect()
      await waitForCloudRuntimeReady(transport)
    } else {
      if (!this.options.webBootstrapUrl) throw new Error('Unity Web 部署配置尚未提供')
      this.transport = new WebUnityTransport(container, this.options.webBootstrapUrl, this.options.onStatus)
      await this.transport.connect()
    }
    if (this.disposed) throw new Error('Unity 视口已关闭')
    const unity = new JsonRpcUnityCloudRuntime(this.transport)
    this.unity = unity
    await unity.connect()
    if (!unity.capabilities?.sceneTypes.includes(this.type)) throw new Error(`当前 Unity 播放器不支持 ${this.type === 'gis' ? 'GIS' : '普通三维'} 场景，请更新对应端的播放器`)
    this.capabilities.rendering.imagery = this.type === 'gis' && unity.capabilities.features['gis.imagery'] === true
    this.capabilities.rendering.terrain = this.type === 'gis' && unity.capabilities.features['gis.terrain'] === true
    this.capabilities.rendering.tileset = this.type === 'gis' && unity.capabilities.features['gis.tileset'] === true
    // 资源面板根据真实协商结果开放模型入口；这里表示可加载已发布模型，不表示按网页地址直接导入文件。
    this.capabilities.assets.glb = unity.capabilities.objectTypes.includes('model') && unity.capabilities.features['scene.loadDraft'] !== false
    this.capabilities.streaming.nativeTileStreaming = this.type === 'gis'
    this.capabilities.culling.nativeTileFrustum = this.type === 'gis'
    this.unsubscribe.push(unity.on('runtimeError', ({ message }) => this.options.onStatus(`Unity 渲染异常：${message}`)))
    this.unsubscribe.push(unity.on('selectionChanged', ({ instanceId }) => {
      this.options.getHost()?.getStore().setSelectedObjectId(instanceId)
    }))
    this.unsubscribe.push(unity.on('objectInteraction', ({ instanceId, eventType }) => {
      if (!this.objectMap.has(instanceId)) return
      // 引擎只在预览模式发出此通知；再校验对象仍在当前 Runtime，拒绝过期或已删除目标。
      this.objectInteractionListeners.forEach((listener) => listener({ objectId: instanceId, eventType }))
    }))
    this.unsubscribe.push(unity.on('transformCommitted', ({ instanceId, transform }) => {
      if (this.programmaticUpdates.has(instanceId)) return
      const host = this.options.getHost()
      const current = host?.getStore().getObject(instanceId)
      if (!host || !current || (current.transform.kind === 'geo') !== (transform.space === 'wgs84')) return
      const next = fromUnityTransform(transform, current.transform)
      if (JSON.stringify(current.transform) === JSON.stringify(next)) return
      try { host.getCommandBus().execute(createUpdateObjectTransformCommand(instanceId, next)) }
      catch (error) { this.options.onStatus(error instanceof Error ? error.message : 'Unity 变换提交失败') }
    }))
    this.options.onStatus('Unity 运行时已连接')
  }

  override async loadScene(scene: SceneDefinition): Promise<void> {
    if (!this.unity) throw new Error('Unity 运行时尚未连接')
    this.projectedInstanceIds = null
    this.focusSelectionVersion++
    this.options.onStatus('正在加载 Unity 场景')
    await this.loadUnityDraft(scene)
    await super.loadScene(scene)
    this.reportDeferredObjects()
    this.options.onStatus('Unity 场景已就绪')
  }

  override async upsertObject(object: SceneObject): Promise<void> {
    const previous = this.objectMap.get(object.id)
    const existedInUnity = previous !== undefined && !this.isDeferredInUnity(previous)
    await super.upsertObject(object)
    this.reportDeferredObjects()
    if (!this.unity || !this.scene) return
    await this.operations
    // SceneStore also holds deferred objects. A type change can enter or leave the Unity projection.
    // 层级和同级顺序由完整快照提交，避免单对象更新留下旧父级。
    const representationChanged = previous !== undefined && (
      previous.type !== object.type || getUnityModelAssetId(previous) !== getUnityModelAssetId(object)
      || previous.parentInstanceId !== object.parentInstanceId || previous.order !== object.order
    )
    if (this.isDeferredInUnity(object) && !existedInUnity && !representationChanged) return
    if (!existedInUnity || this.isDeferredInUnity(object) || representationChanged) {
      await this.loadUnityDraft(this.scene)
      this.reportDeferredObjects()
      return
    }
    this.programmaticUpdates.add(object.id)
    try { await this.unity.updateObject(projectObjectForUnity(object)) }
    finally { this.programmaticUpdates.delete(object.id) }
  }

  /**
   * 只更新 Unity 的表现投影，不替换完整场景快照。
   *
   * 分片会话可以反复调用该入口完成卸载和恢复。未包含在投影中的对象仍留在
   * `objectMap` 与 Web 完整草稿中，因此不会被误判为业务删除，也不会改变保存脏状态。
   */
  async applyLoadedInstanceProjection(loadedInstanceIds: ReadonlySet<string>): Promise<void> {
    if (!this.unity) throw new Error('Unity 运行时尚未连接')
    if (!this.scene) throw new Error('Unity 场景尚未加载')
    const previous = this.projectedInstanceIds
    const projected = projectSceneForUnityLoadedInstances(this.scene, loadedInstanceIds)
    // 将父级链纳入驻留集合，避免父节点虽被投影却被交互层误判为未加载。
    const next = new Set(projected.objects.map((object) => object.instanceId))
    const operation = this.operations.then(async () => {
      if (this.disposed || !this.scene || !this.unity) throw new Error('Unity 运行时已关闭')
      this.projectedInstanceIds = next
      try {
        await this.loadUnityDraft(this.scene)
        this.reportDeferredObjects()
        this.options.onStatus('Unity 分片表现已更新')
      } catch (error) {
        this.projectedInstanceIds = previous
        throw error
      }
    })
    this.operations = operation.then(() => undefined, () => undefined)
    return operation
  }

  async updateSceneLayers(layers: SceneLayer[]): Promise<void> {
    if (!this.scene || this.type !== 'gis') return
    await this.operations
    const selection = this.selectedObjectId
    await this.loadScene({ ...this.scene, layers })
    this.setSelectedObject(selection)
  }

  override removeObject(objectId: string): void | Promise<void> {
    const previous = this.objectMap.get(objectId)
    super.removeObject(objectId)
    this.reportDeferredObjects()
    if (!previous || this.isDeferredInUnity(previous)) return
    if (!this.scene || !this.unity) return
    const scene = this.scene
    this.operations = this.operations.then(() => this.loadUnityDraft(scene))
      .catch((error) => { this.options.onStatus(error instanceof Error ? error.message : 'Unity 对象删除同步失败') })
    // 桥接层需等待实际删除完成，保证撤销、创建失败补偿与随后重做不会交叉重载旧草稿。
    return this.operations
  }

  override setSelectedObject(objectId: string | null): void {
    const previous = this.selectedObjectId
    super.setSelectedObject(objectId)
    if (previous !== this.selectedObjectId) this.focusSelectionVersion++
    const selected = objectId ? this.objectMap.get(objectId) : null
    this.unity?.setSelection(selected && this.isDeferredInUnity(selected) ? null : this.selectedObjectId)
  }

  /** GIS 拖放复用 Unity 相机屏幕射线；按舞台容器尺寸归一化，兼容缩放后的浏览器画布。 */
  override async pickWorldPosition(point: ScreenPoint): Promise<PickWorldPoint | null> {
    const container = this.renderContainer
    const unity = this.unity
    if (this.type !== 'gis' || !container || !unity || this.isDisposed) return null
    return unity.pickWorldPosition(point, { width: container.clientWidth, height: container.clientHeight })
  }

  /** 编辑预览切换必须等待 Unity 确认，保证业务点击与编辑拾取不会同时生效。 */
  override setEditingEnabled(enabled: boolean): Promise<void> {
    super.setEditingEnabled(enabled)
    const nextMode = enabled ? 'edit' : 'preview'
    const unity = this.unity
    if (!unity || !this.scene || this.remoteMode === nextMode) return Promise.resolve()

    const operation = this.modeOperation.then(async () => {
      if (this.unity !== unity || this.remoteMode === nextMode) return
      await unity.setMode(nextMode)
      if (this.unity === unity) this.remoteMode = nextMode
    })
    // 队列内部恢复后续切换能力；当前调用仍返回原始拒绝，让进入预览的调用方能回滚。
    this.modeOperation = operation.catch((error) => {
      this.options.onStatus(error instanceof Error ? error.message : 'Unity 预览模式切换失败')
    })
    return operation
  }

  /** 注册三维对象预览交互；返回的释放函数可重复调用。 */
  subscribeObjectInteraction(listener: (event: SceneObjectInteractionEvent) => void): () => void {
    this.objectInteractionListeners.add(listener)
    return () => this.objectInteractionListeners.delete(listener)
  }

  /** 对 Unity 草稿应用显隐增量，并等待确认，便于动作序列遵守先后顺序。 */
  setObjectVisibleAsync(objectId: string, visible: boolean): Promise<boolean> {
    const unity = this.unity
    if (!unity) return Promise.resolve(false)
    const operation = this.operations.then(async () => {
      const current = this.objectMap.get(objectId)
      if (!current || this.isDeferredInUnity(current)) return false
      if (current.visible === visible) return true

      const next = { ...current, visible }
      await super.upsertObject(next)
      this.programmaticUpdates.add(objectId)
      try {
        await unity.updateObject(projectObjectForUnity(next))
        return true
      } catch (error) {
        // 引擎拒绝显隐时还原 Runtime 快照，避免后续动作读到未生效的可见状态。
        await super.upsertObject(current)
        throw error
      } finally {
        this.programmaticUpdates.delete(objectId)
      }
    })
    this.operations = operation.then(() => undefined, (error) => {
      this.options.onStatus(error instanceof Error ? error.message : 'Unity 模型显隐同步失败')
    })
    return operation
  }

  /** 临时高亮只进入引擎运行态，不写回对象元数据或命令历史。 */
  setObjectInteractionHighlight(
    objectId: string,
    options: ObjectInteractionHighlightOptions,
  ): Promise<boolean> {
    return this.executeInteractionAction({
      actionType: 'highlightModel',
      instanceId: objectId,
      enabled: options.enabled,
      ...(options.color ? { color: options.color } : {}),
    })
  }

  /** 结构树使用统一聚焦入口，必须转交引擎，不能沿用基类的空实现。 */
  override async frame(target?: FrameTarget): Promise<void> {
    if (!target || !('objectId' in target)) return
    if (!await this.moveCameraToObject(target.objectId)) throw new Error('当前 Unity 对象无法聚焦')
  }

  /** 相机聚焦由 Unity 使用当前场景坐标体系完成，前端不推算局部坐标或地理位置。 */
  moveCameraToObject(
    objectId: string,
    options: ObjectInteractionMoveCameraOptions = {},
  ): Promise<boolean> {
    return this.executeInteractionAction({
      actionType: 'moveCamera',
      instanceId: objectId,
      ...(typeof options.transitionTime === 'number' ? { transitionTime: options.transitionTime } : {}),
      ...(typeof options.smoothFactor === 'number' ? { smoothFactor: options.smoothFactor } : {}),
    })
  }

  /** 正视、侧视、顶视由引擎结合普通三维或地理坐标计算相机姿态。 */
  switchCameraView(options: ObjectInteractionSwitchViewOptions = {}): Promise<boolean> {
    return this.executeInteractionAction({
      actionType: 'switchView',
      ...(options.viewType ? { viewType: options.viewType } : {}),
      ...(typeof options.transitionTime === 'number' ? { transitionTime: options.transitionTime } : {}),
    })
  }

  /** 以单一队列维持高亮、聚焦和视图动作的提交顺序，并等待引擎响应。 */
  private executeInteractionAction(action: UnityInteractionActionDto): Promise<boolean> {
    const unity = this.unity
    if (!unity?.executeInteractionAction || unity.capabilities?.features['interaction.action'] !== true) {
      return Promise.resolve(false)
    }
    const focusVersion = this.focusSelectionVersion
    const operation = this.operations.then(async () => {
      if (this.unity !== unity || this.isDisposed) return false
      // 排队中的旧聚焦不能在改选或重载后才发往引擎。
      if (action.actionType === 'moveCamera' && focusVersion !== this.focusSelectionVersion) return false
      if (
        'instanceId' in action &&
        (!this.objectMap.has(action.instanceId) || this.isDeferredInUnity(this.objectMap.get(action.instanceId)!))
      ) return false
      await unity.executeInteractionAction!(action)
      return true
    })
    this.operations = operation.then(() => undefined, (error) => {
      this.options.onStatus(error instanceof Error ? error.message : 'Unity 三维交互动作执行失败')
    })
    return operation
  }

  override async upsertEffect(effect: SceneDefinition['effects'][number]): Promise<void> {
    await super.upsertEffect(effect)
    this.reportDeferredObjects()
  }

  override removeEffect(effectId: string): void {
    super.removeEffect(effectId)
    this.reportDeferredObjects()
  }

  private reportDeferredObjects(): void {
    if (!this.scene) return
    const warnings = getUnityDeferredRenderWarnings({ ...this.scene, effects: [...this.effectMap.values()] })
    const missing = this.scene.objects.filter((object) => object.type === 'model' && this.missingModelAssetIds.has(getUnityModelAssetId(object)))
    if (missing.length) {
      warnings.push(`以下模型未在当前 Unity 美术版本发布，暂未显示，配置仍保留：${missing.slice(0, 6).map((object) => `${object.name}（资源 ${getUnityModelAssetId(object)}）`).join('、')}${missing.length > 6 ? `等 ${missing.length} 项` : ''}。请发布对应 Unity 资源后重新进入场景。`)
    }
    this.options.onWarnings?.(warnings)
  }

  private isDeferredInUnity(object: SceneObject): boolean {
    return (this.projectedInstanceIds !== null && !this.projectedInstanceIds.has(object.id)) ||
      this.deferredDescendants.has(object.id) || isUnityDeferredObject(object) ||
      (object.type === 'model' && this.missingModelAssetIds.has(getUnityModelAssetId(object)))
  }

  private async loadUnityDraft(scene: SceneDefinition): Promise<void> {
    if (!this.unity) throw new Error('Unity 运行时尚未连接')
    const draft = this.projectedInstanceIds === null
      ? projectSceneForUnity(scene)
      : projectSceneForUnityLoadedInstances(scene, this.projectedInstanceIds)
    const childrenByParent = new Map<string, string[]>()
    for (const object of draft.objects) {
      if (!object.parentInstanceId) continue
      const siblings = childrenByParent.get(object.parentInstanceId)
      if (siblings) siblings.push(object.instanceId)
      else childrenByParent.set(object.parentInstanceId, [object.instanceId])
    }
    // Only an explicit catalog miss can degrade a model. Network, integrity and other load errors remain fatal.
    // Every retry removes at least one resource from this transient projection, bounding the loop by resource count.
    while (true) {
      const resources = draft.resources.filter((resource) => !this.missingModelAssetIds.has(resource.assetId))
      const resourceKeys = new Set(resources.map((resource) => resource.resourceKey))
      const missingRoots = draft.objects.filter((object) =>
        object.objectType === 'model' && object.resourceRefKeys.some((key) => !resourceKeys.has(key)),
      ).map((object) => object.instanceId)
      const omitted = new Set(missingRoots)
      const descendants = new Set<string>()
      // 缺父节点时不能把局部变换直接用在场景根，按子树暂缓提交。
      for (let i = 0; i < missingRoots.length; i++) {
        for (const child of childrenByParent.get(missingRoots[i]!) ?? []) {
          descendants.add(child)
          if (omitted.has(child)) continue
          omitted.add(child)
          missingRoots.push(child)
        }
      }
      const objects = omitted.size ? draft.objects.filter((object) => !omitted.has(object.instanceId)) : draft.objects
      try {
        await this.unity.loadScene({ ...draft, objects, resources })
        this.deferredDescendants = descendants
        return
      }
      catch (error) {
        const match = error instanceof Error ? /^当前美术版本不存在资源键[:：]\s*(\S+)\s*$/u.exec(error.message) : null
        const missing = match ? resources.find((resource) => resource.assetId === match[1] || `model/${resource.assetId}` === match[1]) : undefined
        if (!missing) throw error
        this.missingModelAssetIds.add(missing.assetId)
        this.options.onStatus(`模型资源 ${missing.assetId} 尚未在 Unity 发布，正在加载其余场景`)
      }
    }
  }

  async setGizmoMode(mode: 'translate' | 'rotate' | 'scale'): Promise<void> {
    if (!this.unity) throw new Error('Unity 运行时尚未连接')
    await this.unity.setGizmoMode(mode)
  }

  override dispose(): void {
    this.unsubscribe.splice(0).forEach((stop) => stop())
    const unity = this.unity
    const transport = this.transport
    this.unity = null
    this.transport = null
    this.missingModelAssetIds.clear()
    this.deferredDescendants.clear()
    this.projectedInstanceIds = null
    this.objectInteractionListeners.clear()
    this.video?.remove()
    this.video = null
    this.renderContainer = null
    if (unity) void unity.disconnect()
    else void transport?.disconnect()
    super.dispose()
  }
}
