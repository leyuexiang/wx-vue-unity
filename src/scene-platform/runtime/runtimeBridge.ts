import type {
  SceneDefinition,
  SceneLayer,
  SceneObject,
  SceneSettings,
  SceneStreamingConfig,
  VegetationQualityPreset,
  VegetationSystemDefinition,
} from '../core/types'
import type { CameraPathWaypointSelection, SceneStore, SceneStoreEvent } from '../store/sceneStore'
import type { SceneRuntime } from './sceneRuntime'
import type { SceneObjectStreamingInteraction } from './runtimeTypes'
import { buildSceneNodeIndex } from '../core/sceneNodeIndex'
import { createSceneNodeVisibilityCache, type SceneNodeVisibilityState } from '../core/sceneNodeVisibility'
import { createSceneNodeLockCache, type SceneNodeLockState } from '../core/sceneNodeLock'
import { createSceneNodeWorkQueue, SceneNodeWorkFlag } from '../core/sceneNodeWorkQueue'

export interface RuntimeBridge {
  start: () => void
  stop: () => void
  flush: () => Promise<void>
  /** 失败补偿后用当前权威草稿覆盖可能部分成功的运行端。 */
  resync: () => Promise<void>
  /**
   * 将对象编辑／拖拽保护意图直接转发给当前 Runtime。
   *
   * 这是运行时临时通道，不进入 Store 事件队列，也不等待 flush；因此不会被保存、撤销或同步到
   * MySQL。桥接层只复制可序列化意图值，绝不向编辑器暴露区块编号、pin 句柄或引擎资源。
   */
  setObjectStreamingInteraction: (
    objectId: string,
    interaction: SceneObjectStreamingInteraction,
  ) => void
}

/**
 * 在场景整体写入 Runtime 前执行的纯解析钩子。
 *
 * 编辑器 Store 始终保留完整、可保存的场景定义；钩子只为当前 Runtime 生成一次临时读取快照，
 * 因而不会把预览预算、缓存状态或引擎对象反写到领域数据。返回原引用表示无需生成额外对象，
 * 保证未配置覆盖的场景不会增加大场景切换时的复制成本。
 */
export type RuntimeSceneLoadResolver = (scene: SceneDefinition) => SceneDefinition

/**
 * 构造仅包含正式植被入口和显隐依赖的稳定签名。
 *
 * 物种目录、种植规则、高程来源和编辑参数属于下一次生成输入，不影响当前已发布三维瓦片，故不进入
 * 签名。质量与预算由独立表现通道处理；运行时会基于当前真正挂载的定义切换同发布包密度入口，
 * 因此不会覆盖“已生成、未发布”的临时正式结果。
 */
function createVegetationRuntimeSignature(
  vegetation: VegetationSystemDefinition | undefined,
): string {
  if (!vegetation) return 'none'
  return JSON.stringify({
    enabled: vegetation.enabled,
    streamingEnabled: vegetation.streaming.enabled,
    layers: vegetation.layers.map((layer) => ({
      id: layer.id,
      visible: layer.visible,
      priority: layer.priority,
      manifestAsset: layer.manifestAsset
        ? {
            id: layer.manifestAsset.id,
            url: layer.manifestAsset.url,
            version: layer.manifestAsset.version,
            hash: layer.manifestAsset.hash,
          }
        : null,
      tilesetAsset: layer.tilesetAsset
        ? {
            id: layer.tilesetAsset.id,
            url: layer.tilesetAsset.url,
            version: layer.tilesetAsset.version,
            hash: layer.tilesetAsset.hash,
          }
        : null,
      /** 固定三项避免枚举未知键；该签名只在领域变更时计算，不进入逐帧渲染路径。 */
      densityTilesetAssets: (['high', 'balanced', 'performance'] as const).map(
        (preset: VegetationQualityPreset) => {
        const asset = layer.densityTilesetAssets?.[preset]
        return asset
          ? {
              preset,
              id: asset.id,
              url: asset.url,
              version: asset.version,
              hash: asset.hash,
            }
          : { preset, id: null, url: null, version: null, hash: null }
        },
      ),
    })),
  })
}

/**
 * 为正式植被渲染质量与缓存预算建立独立签名。
 *
 * 质量与预算只作用当前活动瓦片。新版运行时会在此通道内原子切换同发布包的密度入口；旧发布没有
 * 三档入口时仍只更新公开细节参数，且两种情况都不会用 Store 中的旧定义覆盖临时正式结果。
 */
function createVegetationRenderingOptionsSignature(
  vegetation: VegetationSystemDefinition | undefined,
): string {
  if (!vegetation) return 'none'
  return JSON.stringify({
    qualityPreset: vegetation.streaming.qualityPreset,
    memoryBudgetMB: vegetation.streaming.memoryBudgetMB,
  })
}

/**
 * 为正式植被距离裁剪建立独立签名。
 *
 * 两个数值只改变当前瓦片集的显隐阈值，不属于发布清单、质量档位或缓存预算；独立通道可以避免每次
 * 调整都销毁并重新请求三维瓦片，也不会覆盖尚未发布的正式结果预览。
 */
function createVegetationDisplayDistanceSignature(
  vegetation: VegetationSystemDefinition | undefined,
): string {
  if (!vegetation) return 'none'
  return JSON.stringify({
    maximumDisplayDistanceM: vegetation.streaming.maximumDisplayDistanceM,
    distanceHysteresisM: vegetation.streaming.distanceHysteresisM,
  })
}

/**
 * 创建编辑态植被预览签名。
 *
 * 只投影预览真正消费的字段，忽略发布清单、流式预算和无关元数据。签名仅在植被命令提交时计算，
 * 不进入逐帧路径；规则和物种数组保持保存顺序，因此撤销回到原快照时可以直接取消待执行重建。
 */
function createVegetationPreviewRuntimeSignature(
  vegetation: VegetationSystemDefinition | undefined,
): string {
  if (!vegetation) return 'none'
  return JSON.stringify({
    enabled: vegetation.enabled,
    previewEnabled: vegetation.editing.previewEnabled,
    /** 编辑预览模型与正式瓦片必须使用同一档位的局部阴影语义。 */
    qualityPreset: vegetation.streaming.qualityPreset,
    seed: vegetation.seed,
    elevationSource: vegetation.elevationSource,
    layers: vegetation.layers.map((layer) => ({
      id: layer.id,
      visible: layer.visible,
      speciesIds: layer.speciesIds,
    })),
    speciesCatalog: vegetation.speciesCatalog.map((species) => ({
      id: species.id,
      enabled: species.enabled,
      modelAsset: species.modelAsset,
      minimumScale: species.minimumScale,
      maximumScale: species.maximumScale,
    })),
    rules: vegetation.rules,
  })
}

/**
 * RuntimeBridge 负责把 SceneStore 的“领域状态变化”同步到 Runtime。
 *
 * 关键约束：
 * - Store 是业务状态真源；Runtime 不反向写 Store；
 * - 同步过程需要顺序化，避免并发造成渲染侧状态抖动；
 * - 同步只传递领域对象，不传递 Cesium/Three 引擎对象。
 *
 * 性能策略：
 * - 对象变更事件会做合并（同一个 objectId 多次 upsert 只保留最后一次）；
 * - selectionChanged 只保留最后一次；
 * - 通过 flush 将一批变更“打包”同步，避免高频拖拽时向 Runtime 发送过多命令。
 * - 编辑／拖拽的开始和结束属于独立临时意图，直接同步到 Runtime，不写入 Store 或持久化链路。
 */
export function createRuntimeBridge(
  store: SceneStore,
  runtime: SceneRuntime,
  resolveSceneForRuntime: RuntimeSceneLoadResolver = (scene) => scene,
): RuntimeBridge {
  let unsubscribe: (() => void) | null = null
  let pending = Promise.resolve()
  let stopped = false
  let started = false
  /** 生命周期版本阻断旧 Runtime 的异步收尾任务写入新场景。 */
  let lifecycleVersion = 0
  let scheduled = false

  let pendingScene = store.getScene()
  let hasSceneLoad = false
  /** 场景设置采用独立增量通道，滑杆输入不会触发全场景对象重建。 */
  let pendingSceneSettings: SceneSettings | null = null
  let pendingSceneLayers: SceneLayer[] | null = null
  /** 待增量替换的流式配置；独立布尔值用于区分“删除 streaming”与“尚未收到事件”。 */
  let pendingSceneStreaming: SceneStreamingConfig | undefined
  let hasPendingSceneStreaming = false
  let pendingCameraPaths: SceneDefinition['cameraPaths'] | null = null
  /** undefined 同时可能表示“删除植被系统”，因此使用独立布尔值表示是否收到更新。 */
  let pendingVegetation: VegetationSystemDefinition | undefined
  let hasPendingVegetation = false
  let appliedVegetationSignature = createVegetationRuntimeSignature(store.getVegetation())
  let appliedVegetationDisplayDistanceSignature = createVegetationDisplayDistanceSignature(
    store.getVegetation(),
  )
  let appliedVegetationRenderingOptionsSignature = createVegetationRenderingOptionsSignature(
    store.getVegetation(),
  )
  let appliedVegetationPreviewSignature = createVegetationPreviewRuntimeSignature(
    store.getVegetation(),
  )
  /** 路径点高亮属于临时 UI 状态；undefined 表示当前批次未收到选择变化。 */
  let pendingCameraPathWaypointSelection: CameraPathWaypointSelection | null | undefined = undefined
  const upsertMap = new Map<string, Parameters<SceneRuntime['upsertObject']>[0]>()
  const removedSet = new Set<string>()
  // 桥接使用独立异步批次，不能被事务内派生查询提前消费；遍历工具与存储相同。
  const stateWork = createSceneNodeWorkQueue(() => store.getNodeIndex(), store.getObjectIdsInLayer)
  const effectUpsertMap = new Map<string, Parameters<SceneRuntime['upsertEffect']>[0]>()
  const effectRemovedSet = new Set<string>()
  let selectedObjectId: string | null | undefined = undefined

  /**
   * 将视觉分组状态投影为 Runtime 可直接消费的有效状态。
   * 投影只发生在桥接边界，不回写 SceneStore，因此组解锁/显示后仍能恢复成员自身状态。
   */
  const projectObjectForRuntime = (object: SceneObject,
    readVisibility: (id: string) => SceneNodeVisibilityState | null = store.getObjectVisibilityState,
    readLock: (id: string) => SceneNodeLockState | null = store.getObjectLockState): SceneObject => {
    const effectivelyLocked = object.locked || readLock(object.id)?.inheritedLocked === true
    const effectivelyVisible = object.visible && (readVisibility(object.id)?.inheritedVisible ?? true)
    if (!effectivelyLocked && effectivelyVisible === object.visible) return object

    return {
      ...object,
      visible: effectivelyVisible,
      locked: effectivelyLocked,
      metadata: effectivelyLocked ? { ...object.metadata, pickable: false } : object.metadata,
    }
  }

  const projectSceneForRuntime = (scene: SceneDefinition): SceneDefinition => {
    let readVisibility = store.getObjectVisibilityState
    let readLock = store.getObjectLockState
    if (scene.objects !== store.getObjects() || scene.layers !== store.getLayers()) {
      // 外部解析器可能产生临时快照；在其自身树上派生，不能混用当前草稿的父显隐。
      const index = { ...buildSceneNodeIndex(scene.objects), structureVersion: 0 }
      const visibility = createSceneNodeVisibilityCache(() => index, () => scene.layers)
      readVisibility = visibility.get
      readLock = createSceneNodeLockCache(() => index, () => scene.layers, visibility.getMembers).get
    }
    return { ...scene, objects: scene.objects.map((object) => projectObjectForRuntime(object, readVisibility, readLock)) }
  }

  const collectEffectiveStateUpserts = () => {
    if (!stateWork.hasPending()) return
    if (!hasSceneLoad) {
      const index = store.getNodeIndex()
      stateWork.flush(index, (id) => {
        const object = index.nodesById.get(id)
        if (object) upsertMap.set(id, object)
      })
    } else stateWork.clear()
  }

  const drainAndApply = async () => {
    const currentVersion = lifecycleVersion
    while (true) {
      collectEffectiveStateUpserts()
      const sceneToLoad = hasSceneLoad ? pendingScene : null
      const sceneSettings = sceneToLoad ? null : pendingSceneSettings
      const sceneLayers = sceneToLoad ? null : pendingSceneLayers
      const sceneStreaming = pendingSceneStreaming
      const shouldUpdateSceneStreaming =
        !sceneToLoad && hasPendingSceneStreaming && runtime.updateSceneStreaming
      const upserts = new Map(upsertMap)
      const removed = new Set(removedSet)
      const effectUpserts = new Map(effectUpsertMap)
      const effectRemoved = new Set(effectRemovedSet)
      const selection = selectedObjectId
      const cameraPathWaypointSelection = pendingCameraPathWaypointSelection
      const vegetation = pendingVegetation
      const shouldUpdateVegetation =
        !sceneToLoad &&
        hasPendingVegetation &&
        createVegetationRuntimeSignature(vegetation) !== appliedVegetationSignature
      const shouldUpdateVegetationDisplayDistance =
        !sceneToLoad &&
        hasPendingVegetation &&
        createVegetationDisplayDistanceSignature(vegetation) !==
          appliedVegetationDisplayDistanceSignature
      const shouldUpdateVegetationRenderingOptions =
        !sceneToLoad &&
        hasPendingVegetation &&
        createVegetationRenderingOptionsSignature(vegetation) !==
          appliedVegetationRenderingOptionsSignature
      const shouldUpdateVegetationPreview =
        !sceneToLoad &&
        hasPendingVegetation &&
        createVegetationPreviewRuntimeSignature(vegetation) !== appliedVegetationPreviewSignature

      hasSceneLoad = false
      pendingSceneSettings = null
      pendingSceneLayers = null
      pendingSceneStreaming = undefined
      hasPendingSceneStreaming = false
      upsertMap.clear()
      removedSet.clear()
      effectUpsertMap.clear()
      effectRemovedSet.clear()
      selectedObjectId = undefined
      pendingCameraPathWaypointSelection = undefined
      pendingVegetation = undefined
      hasPendingVegetation = false

      if (stopped || currentVersion !== lifecycleVersion) return

      if (
        !sceneToLoad &&
        !sceneSettings &&
        !sceneLayers &&
        !shouldUpdateSceneStreaming &&
        !pendingCameraPaths &&
        !shouldUpdateVegetation &&
        !shouldUpdateVegetationDisplayDistance &&
        !shouldUpdateVegetationRenderingOptions &&
        !shouldUpdateVegetationPreview &&
        cameraPathWaypointSelection === undefined &&
        upserts.size === 0 &&
        removed.size === 0 &&
        effectUpserts.size === 0 &&
        effectRemoved.size === 0 &&
        selection === undefined
      ) {
        return
      }

      /**
       * 单个对象或效果失败不应阻断同批独立同步；保留首个错误供 flush 暴露，后续 Store 事件仍可
       * 继续进入 Runtime。每次操作都 await，确保异步销毁和紧随其后的同 id 创建严格有序。
       */
      let firstError: unknown = null
      const applySafely = async (operation: () => void | Promise<void>) => {
        try {
          await operation()
        } catch (error) {
          firstError ??= error
        }
      }

      if (sceneToLoad) {
        /**
         * 只在整场景加载边界解析运行上下文策略。对象增量更新继续使用 Store 的原始领域对象，
         * 避免高频拖拽或批量对象事件重复分配 streaming 配置，也避免把临时策略当作保存基线。
         * 先解析运行时上下文（resolveSceneForRuntime），再投影图层锁定/可见性（projectSceneForRuntime），两者均为纯函数转换。
         */
        await applySafely(async () => {
          await runtime.loadScene(projectSceneForRuntime(resolveSceneForRuntime(sceneToLoad)))
          appliedVegetationSignature = createVegetationRuntimeSignature(sceneToLoad.vegetation)
          appliedVegetationDisplayDistanceSignature = createVegetationDisplayDistanceSignature(
            sceneToLoad.vegetation,
          )
          appliedVegetationRenderingOptionsSignature = createVegetationRenderingOptionsSignature(
            sceneToLoad.vegetation,
          )
          appliedVegetationPreviewSignature = createVegetationPreviewRuntimeSignature(
            sceneToLoad.vegetation,
          )
        })
        if (stopped || currentVersion !== lifecycleVersion) return
      }

      /** 场景加载已携带完整设置；只有纯增量事件才调用更新接口，避免重复加载模型。 */
      if (sceneSettings && runtime.updateSceneSettings) {
        await applySafely(() => runtime.updateSceneSettings?.(sceneSettings))
        if (stopped || currentVersion !== lifecycleVersion) return
      }
      if (sceneLayers && runtime.updateSceneLayers) {
        await applySafely(() => runtime.updateSceneLayers?.(sceneLayers))
        if (stopped || currentVersion !== lifecycleVersion) return
      }

      /**
       * 植被更新只调用专属入口，不触发整场 loadScene。纯规则编辑已经在事件入口按运行时签名过滤，
       * 因此资源市场物种参数和几何规则表单不会重载当前发布瓦片。
       */
      if (shouldUpdateVegetation) {
        if (runtime.updateVegetation) {
          await applySafely(async () => {
            await runtime.updateVegetation?.(vegetation)
            appliedVegetationSignature = createVegetationRuntimeSignature(vegetation)
            appliedVegetationDisplayDistanceSignature =
              createVegetationDisplayDistanceSignature(vegetation)
            appliedVegetationRenderingOptionsSignature =
              createVegetationRenderingOptionsSignature(vegetation)
          })
          if (stopped || currentVersion !== lifecycleVersion) return
        } else {
          appliedVegetationSignature = createVegetationRuntimeSignature(vegetation)
          appliedVegetationDisplayDistanceSignature =
            createVegetationDisplayDistanceSignature(vegetation)
          appliedVegetationRenderingOptionsSignature =
            createVegetationRenderingOptionsSignature(vegetation)
        }
      }

      /**
       * 档位与预算只作用当前活动植被。专用入口使用 Runtime 持有的定义按需换密度入口，从而保留
       * 未发布任务预览；旧 Runtime 才回退完整更新，以维持公共协议兼容性。
       */
      if (shouldUpdateVegetationRenderingOptions && !shouldUpdateVegetation && vegetation) {
        if (runtime.updateVegetationRenderingOptions) {
          await applySafely(async () => {
            await runtime.updateVegetationRenderingOptions?.({
              qualityPreset: vegetation.streaming.qualityPreset,
              memoryBudgetMB: vegetation.streaming.memoryBudgetMB,
            })
            appliedVegetationRenderingOptionsSignature =
              createVegetationRenderingOptionsSignature(vegetation)
          })
        } else if (runtime.updateVegetation) {
          await applySafely(async () => {
            await runtime.updateVegetation?.(vegetation)
            appliedVegetationRenderingOptionsSignature =
              createVegetationRenderingOptionsSignature(vegetation)
          })
        } else {
          appliedVegetationRenderingOptionsSignature =
            createVegetationRenderingOptionsSignature(vegetation)
        }
        if (stopped || currentVersion !== lifecycleVersion) return
      }

      /**
       * 只有距离发生变化时使用原位通道，当前正式瓦片和临时正式结果预览都不会被替换。
       * 旧运行时没有实现专用入口时才回退完整更新，保持公共桥接协议向后兼容。
       */
      if (shouldUpdateVegetationDisplayDistance && !shouldUpdateVegetation && vegetation) {
        if (runtime.updateVegetationDisplayDistance) {
          await applySafely(async () => {
            await runtime.updateVegetationDisplayDistance?.({
              maximumDisplayDistanceM: vegetation.streaming.maximumDisplayDistanceM,
              distanceHysteresisM: vegetation.streaming.distanceHysteresisM,
            })
            appliedVegetationDisplayDistanceSignature =
              createVegetationDisplayDistanceSignature(vegetation)
          })
        } else if (runtime.updateVegetation) {
          await applySafely(async () => {
            await runtime.updateVegetation?.(vegetation)
            appliedVegetationDisplayDistanceSignature =
              createVegetationDisplayDistanceSignature(vegetation)
          })
        } else {
          appliedVegetationDisplayDistanceSignature =
            createVegetationDisplayDistanceSignature(vegetation)
        }
        if (stopped || currentVersion !== lifecycleVersion) return
      }

      /**
       * 编辑预览在独立入口重建。具体 Runtime 会立即启动可取消任务并快速返回，因此不会阻塞 Bridge
       * 接收下一次规则编辑；正式瓦片签名保持不变时，上面的发布入口不会被调用。
       */
      if (shouldUpdateVegetationPreview) {
        if (runtime.updateVegetationPreview) {
          await applySafely(async () => {
            await runtime.updateVegetationPreview?.(vegetation)
            appliedVegetationPreviewSignature = createVegetationPreviewRuntimeSignature(vegetation)
          })
          if (stopped || currentVersion !== lifecycleVersion) return
        } else {
          appliedVegetationPreviewSignature = createVegetationPreviewRuntimeSignature(vegetation)
        }
      }

      if (pendingCameraPaths) {
        const paths = pendingCameraPaths
        pendingCameraPaths = null
        pendingVegetation = undefined
        hasPendingVegetation = false
        if (runtime.updateCameraPaths) {
          await applySafely(() => runtime.updateCameraPaths?.(paths))
          if (stopped || currentVersion !== lifecycleVersion) return
        }
      }

      /** 路径辅助实体重建完成后再同步临时高亮，避免高亮写入已移除的旧 Entity。 */
      if (cameraPathWaypointSelection !== undefined && runtime.setSelectedCameraPathWaypoint) {
        await applySafely(() =>
          runtime.setSelectedCameraPathWaypoint?.(cameraPathWaypointSelection),
        )
        if (stopped || currentVersion !== lifecycleVersion) return
      }

      for (const objectId of removed) {
        await applySafely(() => runtime.removeObject(objectId))
        if (stopped || currentVersion !== lifecycleVersion) return
      }

      for (const object of upserts.values()) {
        await applySafely(() => runtime.upsertObject(projectObjectForRuntime(object)))
        if (stopped || currentVersion !== lifecycleVersion) return
      }

      /**
       * 对象增量必须先于区块注册执行：同一批拖拽事件中，新对象只有完成 upsert 后才会进入 Runtime
       * 领域快照。随后再注册 streaming，才能让新 chunk 通过对象校验并接管刚创建的实例。
       * 未实现专用入口的旧 Runtime 已在事件入口回退为 sceneLoaded，保持协议兼容。
       */
      if (shouldUpdateSceneStreaming) {
        await applySafely(() => runtime.updateSceneStreaming?.(sceneStreaming))
        if (stopped || currentVersion !== lifecycleVersion) return
      }

      for (const effectId of effectRemoved) {
        await applySafely(() => runtime.removeEffect(effectId))
        if (stopped || currentVersion !== lifecycleVersion) return
      }

      for (const effect of effectUpserts.values()) {
        await applySafely(() => runtime.upsertEffect(effect))
        if (stopped || currentVersion !== lifecycleVersion) return
      }

      if (selection !== undefined) {
        await applySafely(() => runtime.setSelectedObject(selection))
      }

      if (stopped || currentVersion !== lifecycleVersion) return
      if (firstError) throw firstError
    }
  }

  const schedule = () => {
    if (scheduled) return
    scheduled = true
    const runScheduledDrain = async () => {
      scheduled = false
      await drainAndApply()
    }
    /**
     * 前一批 Runtime 失败后仍继续执行下一批，避免 rejected Promise 让整个同步队列永久停摆；
     * 当前批次错误仍保留给 flush 调用方感知。
     */
    pending = pending.then(runScheduledDrain, runScheduledDrain)
  }

  const handleEvent = (event: SceneStoreEvent) => {
    switch (event.type) {
      case 'objectHierarchyChanged':
      case 'sceneLoaded': {
        stateWork.clear()
        pendingSceneLayers = null
        // 一次层级事务走一次完整快照，保持原选择并等待运行端确认。
        pendingScene = event.type === 'sceneLoaded' ? event.scene : store.getScene()
        hasSceneLoad = true
        pendingSceneSettings = null
        pendingSceneStreaming = undefined
        hasPendingSceneStreaming = false
        pendingCameraPaths = null
        pendingCameraPathWaypointSelection = null
        upsertMap.clear()
        removedSet.clear()
        effectUpsertMap.clear()
        effectRemovedSet.clear()
        selectedObjectId = event.type === 'sceneLoaded' ? null : store.getSelectedObjectId()
        schedule()
        return
      }
      case 'sceneSettingsUpdated': {
        pendingSceneSettings = event.settings
        schedule()
        return
      }
      case 'sceneStreamingUpdated': {
        /** 初始场景加载尚未出队时，直接刷新待加载快照，避免首轮加载使用旧 streaming 配置。 */
        if (hasSceneLoad) {
          pendingScene = store.getScene()
          schedule()
          return
        }
        /** 优先走 Runtime 原位更新；旧 Runtime 没有该能力时才回退完整场景同步。 */
        if (runtime.updateSceneStreaming) {
          pendingSceneStreaming = event.streaming
          hasPendingSceneStreaming = true
        } else {
          pendingScene = store.getScene()
          hasSceneLoad = true
          pendingSceneSettings = null
          pendingCameraPaths = null
          upsertMap.clear()
          removedSet.clear()
          effectUpsertMap.clear()
          effectRemovedSet.clear()
          selectedObjectId = store.getSelectedObjectId()
        }
        schedule()
        return
      }
      case 'cameraPathsUpdated': {
        pendingCameraPaths = event.cameraPaths
        /**
         * 路径数据更新会使 Cesium 先移除并重建辅助 Entity。
         * 即使用户仍选中同一个点，Store 也不会重复派发相同的选择事件；这里主动读取当前临时选择，
         * 保证 Bridge 在新 Entity 创建完成后重新投影高亮，而不让画布直接依赖具体 Runtime。
         */
        pendingCameraPathWaypointSelection = store.getCameraPathWaypointSelection()
        schedule()
        return
      }
      case 'vegetationUpdated': {
        const nextSignature = createVegetationRuntimeSignature(event.vegetation)
        const nextDisplayDistanceSignature = createVegetationDisplayDistanceSignature(
          event.vegetation,
        )
        const nextRenderingOptionsSignature = createVegetationRenderingOptionsSignature(
          event.vegetation,
        )
        const nextPreviewSignature = createVegetationPreviewRuntimeSignature(event.vegetation)
        if (
          nextSignature === appliedVegetationSignature &&
          nextDisplayDistanceSignature === appliedVegetationDisplayDistanceSignature &&
          nextRenderingOptionsSignature === appliedVegetationRenderingOptionsSignature &&
          nextPreviewSignature === appliedVegetationPreviewSignature
        ) {
          /** 快速连续编辑回到当前运行时配置时取消尚未执行的中间替换。 */
          pendingVegetation = undefined
          hasPendingVegetation = false
          return
        }
        pendingVegetation = event.vegetation
        hasPendingVegetation = true
        schedule()
        return
      }
      case 'cameraPathWaypointSelectionChanged': {
        pendingCameraPathWaypointSelection = event.selection
        schedule()
        return
      }
      case 'objectUpserted': {
        removedSet.delete(event.object.id)
        upsertMap.set(event.object.id, event.object)
        stateWork.mark(event.object.id, (event.visibilityChanged ? SceneNodeWorkFlag.Visibility : 0) |
          (event.lockChanged ? SceneNodeWorkFlag.Lock : 0))
        schedule()
        return
      }
      case 'objectRemoved': {
        upsertMap.delete(event.objectId)
        removedSet.add(event.objectId)
        schedule()
        return
      }
      case 'layerUpserted': {
        if (event.layer.type !== 'object' && runtime.updateSceneLayers) pendingSceneLayers = store.getScene().layers
        /** 对象图层是视觉管理数据；只重新投影其成员，不在 Runtime 创建分组节点。 */
        if (event.layer.type === 'object') {
          const flags = (event.visibilityChanged ? SceneNodeWorkFlag.Visibility : 0) |
            (event.lockChanged ? SceneNodeWorkFlag.Lock : 0)
          if (flags) {
            // 显隐和锁定共用最终批次的成员读取，事件入队时无需先遍历一遍成员。
            stateWork.markLayer(event.layer.id, flags)
          } else {
            const index = store.getNodeIndex()
            for (const id of store.getObjectIdsInLayer(event.layer.id)) {
              const object = index.nodesById.get(id)
              if (object) upsertMap.set(id, object)
            }
          }
        }
        schedule()
        return
      }
      case 'layerRemoved': {
        if (runtime.updateSceneLayers) pendingSceneLayers = store.getScene().layers
        // 缺失图层恢复默认显隐与锁定，传播到仍引用它的成员子树。
        stateWork.markLayer(event.layerId, SceneNodeWorkFlag.Visibility | SceneNodeWorkFlag.Lock)
        /** 删除组命令会先把成员移回根级，对象事件已携带最终归属；这里只保证队列被刷新。 */
        schedule()
        return
      }
      case 'effectUpserted': {
        effectRemovedSet.delete(event.effect.id)
        effectUpsertMap.set(event.effect.id, event.effect)
        schedule()
        return
      }
      case 'effectRemoved': {
        effectUpsertMap.delete(event.effectId)
        effectRemovedSet.add(event.effectId)
        schedule()
        return
      }
      case 'selectionChanged': {
        selectedObjectId = event.objectId
        schedule()
        return
      }
    }
  }

  /**
   * 临时交互意图不参加 Store 批处理：对象已开始编辑或拖拽时必须立即到达 Runtime，后续 Runtime
   * 才能在区块扫描前建立保护。这里复制两个基础字段，避免调用方在同步调用返回后修改输入对象而
   * 影响 Runtime 内部状态；桥接停止、Runtime 销毁或尚未启动时均安全忽略迟到事件。
   */
  const setObjectStreamingInteraction: RuntimeBridge['setObjectStreamingInteraction'] = (
    objectId,
    interaction,
  ) => {
    if (!started || stopped || runtime.isDisposed) return

    runtime.setObjectStreamingInteraction(objectId, {
      kind: interaction.kind,
      active: interaction.active,
    })
  }

  return {
    start: () => {
      pendingSceneLayers = null
      if (unsubscribe) return
      stopped = false
      started = true
      pendingScene = store.getScene()
      hasSceneLoad = true
      pendingSceneSettings = null
      pendingSceneStreaming = undefined
      hasPendingSceneStreaming = false
      pendingCameraPaths = null
      pendingVegetation = undefined
      hasPendingVegetation = false
      pendingCameraPathWaypointSelection = store.getCameraPathWaypointSelection()
      schedule()
      unsubscribe = store.subscribe(handleEvent)
    },
    stop: () => {
      stateWork.clear()
      pendingSceneLayers = null
      unsubscribe?.()
      unsubscribe = null
      lifecycleVersion += 1
      stopped = true
      started = false
      upsertMap.clear()
      removedSet.clear()
      effectUpsertMap.clear()
      effectRemovedSet.clear()
      pendingSceneSettings = null
      pendingCameraPaths = null
      pendingCameraPathWaypointSelection = undefined
      selectedObjectId = undefined
    },
    resync: async () => {
      if (stopped || !started) throw new Error('运行时桥接已停止')
      stateWork.clear()
      pendingScene = store.getScene()
      hasSceneLoad = true
      selectedObjectId = store.getSelectedObjectId()
      upsertMap.clear()
      removedSet.clear()
      effectUpsertMap.clear()
      effectRemovedSet.clear()
      schedule()
      await pending
    },
    flush: async () => {
      await pending
    },
    setObjectStreamingInteraction,
  }
}
