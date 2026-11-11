import type {
  EffectSpec,
  SceneDefinition,
  SceneLayer,
  SceneObject,
  SceneStreamingConfig,
  SceneSettings,
  CameraPath,
  VegetationSystemDefinition,
} from '../core/types'
import { pruneSceneStreamingChunkObjectReferences } from '../core/sceneDefinition'
import { createSceneNodeIndexCache, type SceneNodeIndex } from '../core/sceneNodeIndexCache'
import { createSceneNodeTransformCache, type SceneNodeMatrix } from '../core/sceneNodeTransforms'
import { createSceneNodeVisibilityCache, type SceneNodeVisibilityState } from '../core/sceneNodeVisibility'
import { createSceneNodeLockCache, type SceneNodeLockState } from '../core/sceneNodeLock'
import { createSceneNodeWorkQueue, type SceneNodeWorkQueue } from '../core/sceneNodeWorkQueue'
import {
  sceneLayerSaveFields, sceneObjectSaveFields, sceneObjectSaveMetadataKeys,
  type SceneLayerSaveField, type SceneObjectSaveField, type SceneSaveDomain, type SceneSaveEdits,
} from '../core/sceneSaveEdits'

/**
 * 相机路径点的编辑器临时选择。
 *
 * 该结构只存在于 SceneStore 的内存状态，用于连接画布拾取、右侧属性面板和 Cesium 辅助图元高亮；
 * 它不是 SceneDefinition 的一部分，因此不会进入保存、导出或撤销重做的数据快照。
 */
export interface CameraPathWaypointSelection {
  pathId: string
  waypointId: string
}

/**
 * SceneStore 事件类型。
 *
 * 约束：事件只表达“领域状态变更”，不携带任何渲染引擎对象引用。
 */
export type SceneStoreEvent =
  | { type: 'sceneLoaded'; scene: SceneDefinition }
  /** 场景级设置的增量更新，不触发对象和效果的全量重建。 */
  | { type: 'sceneSettingsUpdated'; settings: SceneSettings }
  | { type: 'sceneGisUpdated' }
  /** 区块和流式分组的可持久化元数据变更。 */
  | { type: 'sceneStreamingUpdated'; streaming: SceneStreamingConfig | undefined; origin?: 'loadNormalization' }
  /** 显隐和锁定标记只描述派生传播范围，不是后代的持久化编辑。 */
  | { type: 'objectUpserted'; object: SceneObject; origin?: 'loadNormalization'; visibilityChanged?: boolean; lockChanged?: boolean }
  | { type: 'objectRemoved'; objectId: string }
  | { type: 'objectHierarchyChanged' }
  /** 图层事件只同步可序列化管理状态；对象图层不会在 Runtime 中创建父子节点。 */
  | { type: 'layerUpserted'; layer: SceneLayer; origin?: 'loadNormalization'; visibilityChanged?: boolean; lockChanged?: boolean }
  | { type: 'layerRemoved'; layerId: string }
  | { type: 'effectUpserted'; effect: EffectSpec }
  | { type: 'effectRemoved'; effectId: string }
  | { type: 'selectionChanged'; objectId: string | null }
  | { type: 'effectSelectionChanged'; effectId: string | null }
  | { type: 'cameraPathsUpdated'; cameraPaths: CameraPath[] }
  /** 植被定义整组替换；物种、规则和发布引用始终通过同一个可持久化快照提交。 */
  | { type: 'vegetationUpdated'; vegetation: VegetationSystemDefinition | undefined }
  | { type: 'cameraPathWaypointSelectionChanged'; selection: CameraPathWaypointSelection | null }

export type SceneNodePatch = Pick<SceneObject, 'id' | 'parentInstanceId' | 'order' | 'transform'>
export type RemovedSceneObject = { removed: SceneObject; index: number }

export interface SceneStore {
  /**
   * 订阅 Store 内部状态变化事件。
   *
   * 用途：让 RuntimeBridge / UI Adapter 监听领域状态变化，而不是反向依赖 Store 内部字段。
   */
  subscribe: (listener: (event: SceneStoreEvent) => void) => () => void
  getScene: () => SceneDefinition
  /** 获取当前场景所有对象的只读列表（不应直接修改） */
  getObjects: () => readonly SceneObject[]
  /** 会话内共享的只读实时索引；批次最终状态在读取时校验，不作为历史快照。 */
  getNodeIndex: () => SceneNodeIndex<SceneObject>
  /** 只读本地矩阵查询；只接受本地坐标节点，不写回业务变换。 */
  getObjectLocalMatrix: (objectId: string) => SceneNodeMatrix
  /** 只读世界矩阵查询；省略编号得到本地场景根矩阵，地理节点仍走原坐标合同。 */
  getObjectWorldMatrix: (objectId?: string) => SceneNodeMatrix
  /** 自身值与父链/图层继承分别读取；派生状态不持久化，缺失节点返回null。 */
  getObjectVisibilityState: (objectId: string) => SceneNodeVisibilityState | null
  /** 自身、父链与图层锁定分别派生，不能将有效值保存成子节点自身值。 */
  getObjectLockState: (objectId: string) => SceneNodeLockState | null
  /** 当前图层成员的只读实时集合，避免显隐/锁定同步反复扫描全部节点。 */
  getObjectIdsInLayer: (layerId: string) => ReadonlySet<string>
  /** 获取当前场景所有图层的只读列表（不应直接修改） */
  getLayers: () => readonly SceneLayer[]
  /** 获取当前场景所有效果的只读列表（不应直接修改） */
  getEffects: () => readonly EffectSpec[]
  getCameraPaths: () => readonly CameraPath[]
  /** 读取当前植被领域快照；缺失表示系统尚未创建，而不是空运行时状态。 */
  getVegetation: () => VegetationSystemDefinition | undefined
  getCameraPathWaypointSelection: () => CameraPathWaypointSelection | null
  loadScene: (scene: SceneDefinition) => void
  /** 更新可序列化场景设置，并向 Runtime 发送增量同步事件。 */
  updateSceneSettings: (settings: SceneSettings) => SceneSettings
  /** GIS 基础配置原子提交；保留当前对象选择和其它编辑状态。 */
  updateSceneGisConfig: (config: Pick<SceneDefinition, 'coordinateSystem' | 'layers' | 'settings'>) => void
  /** 原子替换场景流式元数据，供资源实例创建后补齐区块归属。 */
  updateSceneStreaming: (
    streaming: SceneStreamingConfig | undefined,
    origin?: 'membership' | 'loadNormalization',
  ) => SceneStreamingConfig | undefined
  updateCameraPaths: (cameraPaths: CameraPath[]) => CameraPath[]
  /**
   * 原子替换植被定义。调用方必须传入已经过领域校验的新快照，Store 不接收引擎对象或单株实例。
   */
  updateVegetation: (
    vegetation: VegetationSystemDefinition | undefined,
  ) => VegetationSystemDefinition | undefined
  /** 设置路径点的临时编辑选择，不会修改 SceneDefinition 或产生领域命令。 */
  setCameraPathWaypointSelection: (selection: CameraPathWaypointSelection | null) => void
  /**
   * 在 Store 内以事务方式执行一段同步修改。
   *
   * 成功时按原顺序发布事务内事件；失败时恢复执行前快照并丢弃事件，避免命令留下半更新。
   */
  runTransaction: <T>(operation: () => T) => T
  /** 同一编辑命令一次提交层级，不触发逐个对象重载。 */
  applyObjectHierarchy: (patches: readonly SceneNodePatch[], restoredEditedIds?: ReadonlySet<string>) => void
  getHierarchyEditedIds: () => ReadonlySet<string>
  /** 记录原档合并许可，快照与待保存草稿使用同一读取时点。 */
  captureSaveEdits: () => SceneSaveEdits
  restoreSaveEdits: (edits: SceneSaveEdits) => void
  getObject: (objectId: string) => SceneObject | null
  upsertObject: (object: SceneObject, origin?: 'loadNormalization') => SceneObject | null
  insertObjectAt: (object: SceneObject, index: number) => void
  removeObject: (objectId: string) => { removed: SceneObject; index: number } | null
  /** 批量成员变更一次替换草稿，保留现存节点的同级编号。 */
  removeObjectBatch: (ids: ReadonlySet<string>, options?: { revertInsertion: { streaming: SceneStreamingConfig | undefined } }) => RemovedSceneObject[]
  /** 恢复模式允许替换已有记录，用于失败补偿精确保留原同级顺序和数组位置。 */
  restoreObjectBatch: (entries: readonly RemovedSceneObject[], streaming: SceneStreamingConfig | undefined,
    options?: { replaceExisting: boolean }) => void
  getDeletedObjectIds: () => ReadonlySet<string>
  getLayer: (layerId: string) => SceneLayer | null
  upsertLayer: (layer: SceneLayer, origin?: 'loadNormalization') => SceneLayer | null
  insertLayerAt: (layer: SceneLayer, index: number) => void
  removeLayer: (layerId: string) => { removed: SceneLayer; index: number } | null
  /** 组锁定不覆盖对象自身 locked；该查询统一给命令和界面计算有效锁定。 */
  isObjectEffectivelyLocked: (objectId: string) => boolean
  getEffect: (effectId: string) => EffectSpec | null
  upsertEffect: (effect: EffectSpec) => EffectSpec | null
  insertEffectAt: (effect: EffectSpec, index: number) => void
  removeEffect: (effectId: string) => { removed: EffectSpec; index: number } | null
  getSelectedObjectId: () => string | null
  setSelectedObjectId: (objectId: string | null) => void
  getSelectedEffectId: () => string | null
  setSelectedEffectId: (effectId: string | null) => void
}

const ROOT_OBJECT_LAYER_KEY = '__root__'

/**
 * 按持久化字段生成对象数组缓存顺序。
 * 根级对象固定排在用户分组前；组内顺序只读取 SceneObject.order，不再依赖接口返回数组的天然顺序。
 */
const sortSceneObjectsByStableOrder = (scene: SceneDefinition, normalizeOrders = true): SceneDefinition => {
  const layerRank = new Map(
    scene.layers
      .filter((layer) => layer.type === 'object')
      .sort((first, second) => first.order - second.order)
      .map((layer, index) => [layer.id, index]),
  )
  const originalIndex = new Map(scene.objects.map((object, index) => [object.id, index]))
  const objects = [...scene.objects].sort((first, second) => {
    const firstParent = first.parentInstanceId ?? ''
    const secondParent = second.parentInstanceId ?? ''
    if (firstParent !== secondParent) return firstParent < secondParent ? -1 : 1
    if (firstParent) return first.order - second.order || (first.id < second.id ? -1 : first.id > second.id ? 1 : 0)
    const firstLayerRank = first.layerId
      ? (layerRank.get(first.layerId) ?? Number.MAX_SAFE_INTEGER)
      : -1
    const secondLayerRank = second.layerId
      ? (layerRank.get(second.layerId) ?? Number.MAX_SAFE_INTEGER)
      : -1
    if (firstLayerRank !== secondLayerRank) return firstLayerRank - secondLayerRank
    if (first.order !== second.order) return first.order - second.order
    return (originalIndex.get(first.id) ?? 0) - (originalIndex.get(second.id) ?? 0)
  })
  if (normalizeOrders) reindexSceneObjectOrders(objects)
  return { ...scene, objects }
}

/**
 * 数组在编辑期间仍作为高效视图缓存；发生创建、删除、跨组或组内拖拽后，按当前数组一次线性重编号。
 * 只替换 order 确实变化的对象，避免普通属性编辑产生无关对象分配与运行时同步。
 */
const objectOrderScope = (object: SceneObject) =>
  object.parentInstanceId ? 'parent:' + object.parentInstanceId : 'layer:' + (object.layerId || ROOT_OBJECT_LAYER_KEY)

const reindexSceneObjectOrders = (
  objects: SceneObject[],
  onChanged?: (object: SceneObject, scope: string) => void,
) => {
  const nextOrderByLayer = new Map<string, number>()
  objects.forEach((object, index) => {
    const layerKey = objectOrderScope(object)
    const order = nextOrderByLayer.get(layerKey) ?? 0
    nextOrderByLayer.set(layerKey, order + 1)
    if (object.order !== order) {
      objects[index] = { ...object, order }
      // 数组已替换记录，派生索引必须收到新对象，不能继续引用旧顺序。
      onChanged?.(objects[index]!, layerKey)
    }
  })
}

export function createSceneStore(initialScene: SceneDefinition): SceneStore {
  /**
   * Store 也可能由测试、宿主或恢复流程直接注入未经过 JSON 解析的旧快照；初始化时先修复一次，
   * 让 RuntimeBridge 后续看到的第一份场景就满足区块对象引用约束。
   */
  const initialStreaming = pruneSceneStreamingChunkObjectReferences({
    id: initialScene.id,
    objects: initialScene.objects,
    streaming: initialScene.streaming,
  })
  const repairedInitialScene =
    initialStreaming === initialScene.streaming
      ? initialScene
      : { ...initialScene, streaming: initialStreaming }
  let scene = sortSceneObjectsByStableOrder(repairedInitialScene)
  const nodeIndexCache = createSceneNodeIndexCache(() => scene.objects)
  // 三类派生共用一次子树失效遍历，图层成员在最终索引就绪后按需解析。
  const nodeWork: SceneNodeWorkQueue = createSceneNodeWorkQueue(() => nodeIndexCache.get(),
    (id): ReadonlySet<string> => nodeVisibility.getMembers(id))
  const nodeTransforms = createSceneNodeTransformCache(() => nodeIndexCache.get(), nodeWork)
  const nodeVisibility = createSceneNodeVisibilityCache(() => nodeIndexCache.get(), () => scene.layers, nodeWork)
  const nodeLocks = createSceneNodeLockCache(() => nodeIndexCache.get(), () => scene.layers, nodeVisibility.getMembers, nodeWork)
  const trackNodeTransform = (previous: SceneObject | undefined, current: SceneObject) => {
    // 顺序、图层和名称不改变坐标；仅姿态或父链改变时失效相关派生结果。
    if (previous && previous.parentInstanceId === current.parentInstanceId) {
      const before = previous.transform, after = current.transform
      if (before === after) return
      if (before.kind === 'local' && after.kind === 'local') {
        // 撤销快照或属性适配可能复制变换对象，常数次字段比较避免相同姿态重复传播。
        let equal = true
        for (let axis = 0; axis < 3; axis++) {
          const oldScale = typeof before.scale === 'number' ? before.scale : before.scale[axis]
          const newScale = typeof after.scale === 'number' ? after.scale : after.scale[axis]
          if (before.position[axis] !== after.position[axis] || before.rotation[axis] !== after.rotation[axis] || oldScale !== newScale) {
            equal = false
            break
          }
        }
        if (equal) return
      }
    }
    nodeTransforms.invalidate(current.id)
  }
  let hierarchyEditedIds = new Set<string>()
  let objectSaveEdits = new Map<string, ReadonlySet<SceneObjectSaveField>>()
  let layerSaveEdits = new Map<string, ReadonlySet<SceneLayerSaveField>>()
  let editedDomains = new Set<SceneSaveDomain>()
  let editedEffects = new Set<string>()
  const captureSaveEdits = (): SceneSaveEdits => ({
    objects: new Map(objectSaveEdits),
    layers: new Map(layerSaveEdits),
    domains: new Set(editedDomains),
    effects: new Set(editedEffects),
  })
  const restoreSaveEdits = (edits: SceneSaveEdits) => {
    snapshotSaveEditsForTransaction()
    objectSaveEdits = new Map(edits.objects)
    layerSaveEdits = new Map(edits.layers)
    editedDomains = new Set(edits.domains)
    editedEffects = new Set(edits.effects)
  }
  let deletedObjectIds = new Set<string>()
  let selectedObjectId: string | null = null
  let selectedEffectId: string | null = null
  let selectedCameraPathWaypoint: CameraPathWaypointSelection | null = null
  const listeners = new Set<(event: SceneStoreEvent) => void>()
  let transactionDepth = 0
  let transactionSnapshot: {
    scene: SceneDefinition
    hierarchyEditedIds: Set<string>
    saveEdits?: SceneSaveEdits
    deletedObjectIds: Set<string>
    selectedObjectId: string | null
    selectedEffectId: string | null
    selectedCameraPathWaypoint: CameraPathWaypointSelection | null
  } | null = null
  let transactionEvents: SceneStoreEvent[] = []
  // 普通变换和选择无需复制本会话的字段索引，首次实际改动才留补偿快照。
  const snapshotSaveEditsForTransaction = () => {
    if (transactionSnapshot && !transactionSnapshot.saveEdits) transactionSnapshot.saveEdits = captureSaveEdits()
  }
  const markDomainEdited = (domain: SceneSaveDomain) => {
    if (editedDomains.has(domain)) return
    snapshotSaveEditsForTransaction()
    editedDomains.add(domain)
  }
  const markEffectEdited = (id: string) => {
    if (editedEffects.has(id)) return
    snapshotSaveEditsForTransaction()
    editedEffects.add(id)
  }

  const dispatch = (event: SceneStoreEvent) => {
    listeners.forEach((listener) => listener(event))
  }

  const emit = (event: SceneStoreEvent) => {
    // 在对外发布前登记变更；事务内读取也必须看到已写入的当前逻辑状态。
    if (event.type === 'objectUpserted') nodeIndexCache.upsert(event.object)
    else if (event.type === 'objectRemoved') nodeIndexCache.remove(event.objectId)
    if (transactionDepth > 0) {
      transactionEvents.push(event)
      return
    }
    dispatch(event)
  }

  const cloneScene = (input: SceneDefinition): SceneDefinition => structuredClone(input)

  const getObjectIndex = (objectId: string) =>
    scene.objects.findIndex((item) => item.id === objectId)

  const getObject = (objectId: string) => scene.objects.find((item) => item.id === objectId) ?? null

  const getLayerIndex = (layerId: string) => scene.layers.findIndex((item) => item.id === layerId)

  const getLayer = (layerId: string) => scene.layers.find((item) => item.id === layerId) ?? null

  const getEffectIndex = (effectId: string) =>
    scene.effects.findIndex((item) => item.id === effectId)

  const getEffect = (effectId: string) => scene.effects.find((item) => item.id === effectId) ?? null

  // 每次只复制单个记录的字段集合，保存和补偿可共享既有集合的只读快照。
  const markSaveField = <T extends string>(edits: Map<string, ReadonlySet<T>>, id: string, field: T) => {
    const current = edits.get(id)
    if (!current?.has(field)) {
      snapshotSaveEditsForTransaction()
      edits.set(id, new Set([...(current ?? []), field]))
    }
  }
  const trackObjectFields = (before: SceneObject, after: SceneObject) => {
    for (const key of sceneObjectSaveFields) {
      if (before[key] !== after[key]) markSaveField(objectSaveEdits, after.id, key)
    }
    if (before.metadata === after.metadata) return
    for (const key of sceneObjectSaveMetadataKeys) {
      if (before.metadata?.[key] !== after.metadata?.[key]) markSaveField(objectSaveEdits, after.id, key)
    }
  }
  const reindexEditedSiblings = (before: SceneObject, after: SceneObject) => {
    const previousScope = objectOrderScope(before)
    const nextScope = objectOrderScope(after)
    reindexSceneObjectOrders(scene.objects, (object, scope) => {
      nodeIndexCache.upsert(object)
      if (object.id !== after.id && (scope === previousScope || scope === nextScope)) {
        markSaveField(objectSaveEdits, object.id, 'order')
      }
    })
  }
  /** 旧数组重编号会替换未单独发事件的兄弟记录，索引也必须收到这些变化。 */
  const reindexObjects = () => reindexSceneObjectOrders(scene.objects, (object) => nodeIndexCache.upsert(object))
  const trackLayerFields = (before: SceneLayer | undefined, after: SceneLayer) => {
    if (after.type !== 'object') return
    if (!before) {
      markSaveField(layerSaveEdits, after.id, 'presence')
      return
    }
    for (const key of sceneLayerSaveFields) {
      if (before[key] !== after[key]) markSaveField(layerSaveEdits, after.id, key)
    }
  }

  const upsertObject: SceneStore['upsertObject'] = (object, origin) => {
    const index = getObjectIndex(object.id)
    if (index >= 0) {
      const previous = scene.objects[index]
      scene.objects[index] = object
      if (previous.layerId !== object.layerId || previous.order !== object.order) {
        if (origin) reindexObjects()
        else reindexEditedSiblings(previous, object)
      }
      const current = scene.objects[index]!
      trackNodeTransform(previous, current)
      const visibilityChanged = nodeVisibility.upsert(previous, current)
      const lockChanged = nodeLocks.upsert(previous, current)
      if (!origin) trackObjectFields(previous, current)
      emit({ type: 'objectUpserted', object: current, ...(origin ? { origin } : {}), ...(visibilityChanged ? { visibilityChanged } : {}), ...(lockChanged ? { lockChanged } : {}) })
      return previous
    }

    scene.objects.push(object)
    nodeTransforms.invalidate(object.id)
    nodeVisibility.upsert(undefined, object)
    nodeLocks.upsert(undefined, object)
    reindexObjects()
    emit({ type: 'objectUpserted', object: getObject(object.id) ?? object, visibilityChanged: true, lockChanged: true, ...(origin ? { origin } : {}) })
    return null
  }

  const insertObjectAt = (object: SceneObject, index: number) => {
    const existingIndex = getObjectIndex(object.id)
    const previous = scene.objects[existingIndex]
    if (existingIndex >= 0) {
      scene.objects.splice(existingIndex, 1)
    }

    const boundedIndex = Math.min(Math.max(index, 0), scene.objects.length)
    scene.objects.splice(boundedIndex, 0, object)
    if (previous) reindexEditedSiblings(previous, object)
    else reindexObjects()
    const current = scene.objects[boundedIndex]!
    trackNodeTransform(previous, current)
    const visibilityChanged = nodeVisibility.upsert(previous, current)
    const lockChanged = nodeLocks.upsert(previous, current)
    if (previous) trackObjectFields(previous, current)
    emit({ type: 'objectUpserted', object: current, ...(visibilityChanged ? { visibilityChanged } : {}), ...(lockChanged ? { lockChanged } : {}) })
  }

  const removeObject = (objectId: string) => {
    // 现有删除入口处理单个对象，拒绝留下无法保存的孤儿节点。
    if (scene.objects.some((node) => node.parentInstanceId === objectId)) {
      throw new Error('请先移动该节点的子节点，再删除父节点')
    }
    const index = getObjectIndex(objectId)
    if (index < 0) return null

    const removed = scene.objects[index]
    scene.objects.splice(index, 1)
    nodeTransforms.invalidate(objectId)
    nodeVisibility.remove(removed)
    nodeLocks.remove(objectId)
    reindexObjects()
    emit({ type: 'objectRemoved', objectId })

    /**
     * 对象是区块索引的外部引用，删除对象后必须在同一事务中裁剪失效编号。
     * 事件顺序保持“对象移除 -> 区块更新”，RuntimeBridge 才会先释放实例，再替换索引，
     * 避免旧区块在增量同步期间继续指向已删除对象。
     */
    const repairedStreaming = pruneSceneStreamingChunkObjectReferences({
      id: scene.id,
      objects: scene.objects,
      streaming: scene.streaming,
    })
    if (repairedStreaming !== scene.streaming) {
      scene = { ...scene, streaming: repairedStreaming }
      emit({ type: 'sceneStreamingUpdated', streaming: repairedStreaming })
    }

    if (selectedObjectId === objectId) {
      selectedObjectId = null
      emit({ type: 'selectionChanged', objectId: null })
    }

    return { removed, index }
  }

  const removeObjectBatch: SceneStore['removeObjectBatch'] = (ids, options) => {
    const removed: RemovedSceneObject[] = []
    const removedVisibility: SceneObject[] = []
    let removedCount = 0
    const objects = scene.objects.filter((object, index) => {
      if (ids.has(object.id)) {
        removedCount++
        removedVisibility.push(object)
        // 撤销新增时命令已持有完整副本，无需再复制一份快照。
        if (!options) removed.push({ removed: structuredClone(object), index })
        return false
      }
      if (object.parentInstanceId && ids.has(object.parentInstanceId)) {
        throw new Error('批量删除范围必须包含被删除节点的全部后代')
      }
      return true
    })
    if (removedCount !== ids.size) throw new Error('部分待删除节点已不存在，请重新选择')
    if (!removedCount) return removed
    const streaming = options ? options.revertInsertion.streaming : pruneSceneStreamingChunkObjectReferences({ ...scene, objects })
    scene = { ...scene, objects, streaming }
    for (const object of removedVisibility) nodeVisibility.remove(object)
    for (const id of ids) {
      nodeIndexCache.remove(id)
      nodeTransforms.invalidate(id)
      nodeLocks.remove(id)
    }
    // 副本撤销只是移除本次新增，不能登记为对原始草稿的显式删除。
    if (!options) deletedObjectIds = new Set([...deletedObjectIds, ...ids])
    const clearSelection = selectedObjectId !== null && ids.has(selectedObjectId)
    if (clearSelection) selectedObjectId = null
    // 只发布最终草稿，避免Unity在逐条同步时看到孤儿节点或中间区块配置。
    emit({ type: 'objectHierarchyChanged' })
    if (clearSelection) emit({ type: 'selectionChanged', objectId: null })
    return removed
  }

  const restoreObjectBatch: SceneStore['restoreObjectBatch'] = (entries, streaming, options) => {
    if (!entries.length) return
    const existing = new Map(scene.objects.map((object) => [object.id, object]))
    const replacing = options?.replaceExisting ? new Set(entries.map(({ removed }) => removed.id)) : undefined
    const retained = replacing ? scene.objects.filter((object) => !replacing.has(object.id)) : scene.objects
    const byIndex = new Map<number, SceneObject>()
    const restoredIds = new Set<string>()
    const count = retained.length + entries.length
    for (const { removed, index } of entries) {
      if ((!replacing && existing.has(removed.id)) || restoredIds.has(removed.id)) throw new Error(`待恢复节点编号已存在：${removed.id}`)
      if (index < 0 || index >= count || byIndex.has(index)) throw new Error('节点顺序已变化，无法恢复原删除批次')
      byIndex.set(index, structuredClone(removed))
      restoredIds.add(removed.id)
    }
    for (const { removed } of entries) {
      const parent = removed.parentInstanceId
      if (parent && !existing.has(parent) && !restoredIds.has(parent)) throw new Error(`待恢复节点的父级不存在：${parent}`)
    }
    // 按原数组位置一次合并，撤销后稳定编号、父级和同级顺序均保持原值。
    let cursor = 0
    const objects = Array.from({ length: count }, (_, index) =>
      byIndex.get(index) ?? retained[cursor++]!)
    scene = { ...scene, objects, streaming }
    for (const object of byIndex.values()) {
      nodeIndexCache.upsert(object)
      nodeTransforms.invalidate(object.id)
      nodeVisibility.upsert(existing.get(object.id), object)
      nodeLocks.upsert(existing.get(object.id), object)
    }
    deletedObjectIds = new Set([...deletedObjectIds].filter((id) => !restoredIds.has(id)))
    emit({ type: 'objectHierarchyChanged' })
  }

  const upsertLayer: SceneStore['upsertLayer'] = (layer, origin) => {
    const index = getLayerIndex(layer.id)
    if (index >= 0) {
      const previous = scene.layers[index]
      scene.layers[index] = layer
      const visibilityChanged = nodeVisibility.upsertLayer(previous, layer)
      const lockChanged = nodeLocks.upsertLayer(previous, layer)
      if (!origin) trackLayerFields(previous, layer)
      emit({ type: 'layerUpserted', layer, ...(origin ? { origin } : {}), ...(visibilityChanged ? { visibilityChanged } : {}), ...(lockChanged ? { lockChanged } : {}) })
      return previous
    }

    scene.layers.push(layer)
    const visibilityChanged = nodeVisibility.upsertLayer(undefined, layer)
    const lockChanged = nodeLocks.upsertLayer(undefined, layer)
    if (!origin) trackLayerFields(undefined, layer)
    emit({ type: 'layerUpserted', layer, ...(origin ? { origin } : {}), ...(visibilityChanged ? { visibilityChanged } : {}), ...(lockChanged ? { lockChanged } : {}) })
    return null
  }

  const insertLayerAt = (layer: SceneLayer, index: number) => {
    const existingIndex = getLayerIndex(layer.id)
    const previous = scene.layers[existingIndex]
    if (existingIndex >= 0) scene.layers.splice(existingIndex, 1)
    const boundedIndex = Math.min(Math.max(index, 0), scene.layers.length)
    scene.layers.splice(boundedIndex, 0, layer)
    const visibilityChanged = nodeVisibility.upsertLayer(previous, layer)
    const lockChanged = nodeLocks.upsertLayer(previous, layer)
    trackLayerFields(previous, layer)
    emit({ type: 'layerUpserted', layer, ...(visibilityChanged ? { visibilityChanged } : {}), ...(lockChanged ? { lockChanged } : {}) })
  }

  const removeLayer = (layerId: string) => {
    const index = getLayerIndex(layerId)
    if (index < 0) return null
    const removed = scene.layers[index]
    scene.layers.splice(index, 1)
    nodeVisibility.removeLayer(layerId)
    nodeLocks.removeLayer(layerId)
    if (removed.type === 'object') markSaveField(layerSaveEdits, layerId, 'presence')
    emit({ type: 'layerRemoved', layerId })
    return { removed, index }
  }

  const upsertEffect = (effect: EffectSpec) => {
    markEffectEdited(effect.id)
    const index = getEffectIndex(effect.id)
    if (index >= 0) {
      const previous = scene.effects[index]
      scene.effects[index] = effect
      emit({ type: 'effectUpserted', effect })
      return previous
    }

    scene.effects.push(effect)
    emit({ type: 'effectUpserted', effect })
    return null
  }

  const insertEffectAt = (effect: EffectSpec, index: number) => {
    markEffectEdited(effect.id)
    const existingIndex = getEffectIndex(effect.id)
    if (existingIndex >= 0) {
      scene.effects.splice(existingIndex, 1)
    }

    const boundedIndex = Math.min(Math.max(index, 0), scene.effects.length)
    scene.effects.splice(boundedIndex, 0, effect)
    emit({ type: 'effectUpserted', effect })
  }

  const removeEffect = (effectId: string) => {
    const index = getEffectIndex(effectId)
    if (index < 0) return null
    markEffectEdited(effectId)

    const removed = scene.effects[index]
    scene.effects.splice(index, 1)
    emit({ type: 'effectRemoved', effectId })
    if (selectedEffectId === effectId) {
      selectedEffectId = null
      emit({ type: 'effectSelectionChanged', effectId: null })
    }
    return { removed, index }
  }

  const updateSceneSettings = (settings: SceneSettings) => {
    markDomainEdited('settings')
    const previous = scene.settings
    /**
     * 用新 SceneDefinition 外壳替换 settings，避免持有旧 settings 引用的保存适配层看到半更新状态。
     * objects/layers/effects 保持原数组引用，RuntimeBridge 因而不会误触发整场景重建。
     */
    scene = {
      ...scene,
      settings,
    }
    emit({ type: 'sceneSettingsUpdated', settings })
    return previous
  }

  /**
   * 原子替换区块、分组和策略配置。
   *
   * 区块归属属于场景定义而非单个对象字段；资源实例创建后由编辑器适配层调用此入口，
   * RuntimeBridge 会按场景流式索引重新注册，避免直接修改 getScene() 返回对象造成界面和运行时不同步。
   */
  const updateSceneStreaming: SceneStore['updateSceneStreaming'] = (streaming, origin) => {
    const previous = scene.streaming
    // 自动成员维护不能授权重写原手工分组和策略。
    if (!origin) markDomainEdited('streamingPolicy')
    /**
     * 流式配置可能来自资源创建、恢复或外部适配器；统一在 Store 边界过滤不存在的对象编号，
     * 防止任意调用方把坏索引重新写回场景。对象尚未 upsert 时应先提交对象，再提交区块配置。
     */
    const repairedStreaming = pruneSceneStreamingChunkObjectReferences({
      id: scene.id,
      objects: scene.objects,
      streaming,
    })
    if (repairedStreaming === undefined) {
      const { streaming: _removedStreaming, ...sceneWithoutStreaming } = scene
      scene = sceneWithoutStreaming as SceneDefinition
    } else {
      scene = { ...scene, streaming: repairedStreaming }
    }
    emit({ type: 'sceneStreamingUpdated', streaming: repairedStreaming,
      ...(origin === 'loadNormalization' ? { origin } : {}) })
    return previous
  }

  /** 以整组替换路径数组，保证路径点编辑只产生一个领域事件并可被命令撤销。 */
  const updateCameraPaths = (cameraPaths: CameraPath[]) => {
    markDomainEdited('cameraPaths')
    const previous = scene.cameraPaths ?? []
    scene = { ...scene, cameraPaths }
    emit({ type: 'cameraPathsUpdated', cameraPaths })
    /**
     * 命令撤销、删除路径或外部加载可使临时选择指向失效点；在同一批事件中清除它，
     * RuntimeBridge 会先重建辅助实体再清除高亮，不会留下过期 Entity 状态。
     */
    if (
      selectedCameraPathWaypoint &&
      !cameraPaths.some(
        (path) =>
          path.id === selectedCameraPathWaypoint?.pathId &&
          path.waypoints.some((point) => point.id === selectedCameraPathWaypoint?.waypointId),
      )
    ) {
      selectedCameraPathWaypoint = null
      emit({ type: 'cameraPathWaypointSelectionChanged', selection: null })
    }
    return previous
  }

  /**
   * 使用新的 SceneDefinition 外壳替换植被快照，保持对象、普通图层和效果数组引用稳定。
   * 删除系统时同时删除可选字段，而不是长期保存显式 undefined，确保序列化结果与旧场景兼容。
   */
  const updateVegetation = (vegetation: VegetationSystemDefinition | undefined) => {
    markDomainEdited('vegetation')
    const previous = scene.vegetation
    if (vegetation === undefined) {
      const { vegetation: _removedVegetation, ...sceneWithoutVegetation } = scene
      scene = sceneWithoutVegetation as SceneDefinition
    } else {
      scene = { ...scene, vegetation }
    }
    emit({ type: 'vegetationUpdated', vegetation })
    return previous
  }

  /**
   * 写入前依据当前路径数据验证选择目标，避免异步画布拾取结果在路径已删除后选中幽灵点。
   *
   * 此方法不调用 CommandBus，不修改场景定义；仅向 UI 与 Runtime 发出临时交互事件。
   */
  const setCameraPathWaypointSelection = (selection: CameraPathWaypointSelection | null) => {
    const nextSelection =
      selection &&
      scene.cameraPaths?.some(
        (path) =>
          path.id === selection.pathId &&
          path.waypoints.some((point) => point.id === selection.waypointId),
      )
        ? { ...selection }
        : null
    if (
      selectedCameraPathWaypoint?.pathId === nextSelection?.pathId &&
      selectedCameraPathWaypoint?.waypointId === nextSelection?.waypointId
    ) {
      return
    }
    selectedCameraPathWaypoint = nextSelection
    emit({ type: 'cameraPathWaypointSelectionChanged', selection: nextSelection })
  }

  return {
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getScene: () => scene,
    getObjects: () => scene.objects,
    getNodeIndex: () => nodeIndexCache.get(),
    getObjectLocalMatrix: (id) => nodeTransforms.getLocalMatrix(id),
    getObjectWorldMatrix: (id) => nodeTransforms.getWorldMatrix(id),
    getObjectVisibilityState: (id) => nodeVisibility.get(id),
    getObjectLockState: (id) => nodeLocks.get(id),
    getObjectIdsInLayer: (id) => nodeVisibility.getMembers(id),
    getLayers: () => scene.layers,
    getEffects: () => scene.effects,
    getCameraPaths: () => scene.cameraPaths ?? [],
    getVegetation: () => scene.vegetation,
    getCameraPathWaypointSelection: () =>
      selectedCameraPathWaypoint ? { ...selectedCameraPathWaypoint } : null,
    loadScene: (nextScene) => {
      /**
       * 统一加载入口也执行一次纯数据修复，覆盖绕过 JSON 解析器而直接注入旧快照的宿主路径。
       * 没有失效引用时保持原场景对象引用，避免普通场景切换产生额外深拷贝。
       */
      const repairedStreaming = pruneSceneStreamingChunkObjectReferences({
        id: nextScene.id,
        objects: nextScene.objects,
        streaming: nextScene.streaming,
      })
      const repairedScene =
        repairedStreaming === nextScene.streaming
          ? nextScene
          : { ...nextScene, streaming: repairedStreaming }
      scene = sortSceneObjectsByStableOrder(repairedScene)
      nodeIndexCache.clear()
      nodeTransforms.clear()
      nodeVisibility.clear()
      nodeLocks.clear()
      nodeWork.clear()
      hierarchyEditedIds = new Set()
      snapshotSaveEditsForTransaction()
      objectSaveEdits.clear()
      layerSaveEdits.clear()
      editedDomains.clear()
      editedEffects.clear()
      deletedObjectIds = new Set()
      selectedObjectId = null
      selectedEffectId = null
      selectedCameraPathWaypoint = null
      emit({ type: 'sceneLoaded', scene })
      emit({ type: 'selectionChanged', objectId: null })
      emit({ type: 'effectSelectionChanged', effectId: null })
      emit({ type: 'cameraPathWaypointSelectionChanged', selection: null })
    },
    updateSceneSettings,
    updateSceneGisConfig: (config) => {
      markDomainEdited('gis')
      scene = { ...scene, ...config }
      emit({ type: 'sceneGisUpdated' })
    },
    updateSceneStreaming,
    updateCameraPaths,
    updateVegetation,
    setCameraPathWaypointSelection,
    runTransaction: (operation) => {
      const isOuterTransaction = transactionDepth === 0

      if (isOuterTransaction) {
        transactionSnapshot = {
          scene: cloneScene(scene),
          hierarchyEditedIds,
          deletedObjectIds,
          selectedObjectId,
          selectedEffectId,
          selectedCameraPathWaypoint,
        }
        transactionEvents = []
      }

      transactionDepth += 1

      try {
        const result = operation()
        transactionDepth -= 1

        if (isOuterTransaction) {
          const events = transactionEvents
          transactionSnapshot = null
          transactionEvents = []
          events.forEach(dispatch)
        }

        return result
      } catch (error) {
        transactionDepth -= 1

        if (isOuterTransaction && transactionSnapshot) {
          scene = transactionSnapshot.scene
          nodeIndexCache.clear()
          nodeTransforms.clear()
          nodeVisibility.clear()
          nodeLocks.clear()
          nodeWork.clear()
          hierarchyEditedIds = transactionSnapshot.hierarchyEditedIds
          if (transactionSnapshot.saveEdits) restoreSaveEdits(transactionSnapshot.saveEdits)
          deletedObjectIds = transactionSnapshot.deletedObjectIds
          selectedObjectId = transactionSnapshot.selectedObjectId
          selectedEffectId = transactionSnapshot.selectedEffectId
          selectedCameraPathWaypoint = transactionSnapshot.selectedCameraPathWaypoint
          transactionSnapshot = null
          transactionEvents = []
        }

        throw error
      }
    },
    applyObjectHierarchy: (patches, restoredEditedIds) => {
      if (!patches.length) return
      const byId = new Map(patches.map((patch) => [patch.id, patch]))
      const objects = scene.objects.map((object) => {
        const patch = byId.get(object.id)
        if (!patch || (object.parentInstanceId === patch.parentInstanceId && object.order === patch.order &&
          object.transform === patch.transform)) return object
        const updated = { ...object, ...patch }
        trackNodeTransform(object, updated)
        nodeVisibility.upsert(object, updated)
        nodeLocks.upsert(object, updated)
        nodeIndexCache.upsert(updated)
        return updated
      })
      // 命令已经给出受影响同级的顺序，禁止全局重编号覆盖无关分组或撤销快照。
      scene = sortSceneObjectsByStableOrder({ ...scene, objects }, false)
      hierarchyEditedIds = restoredEditedIds
        ? new Set(restoredEditedIds)
        : new Set([...hierarchyEditedIds, ...byId.keys()])
      emit({ type: 'objectHierarchyChanged' })
    },
    getHierarchyEditedIds: () => hierarchyEditedIds,
    captureSaveEdits,
    restoreSaveEdits,
    getObject,
    upsertObject,
    insertObjectAt,
    removeObject,
    removeObjectBatch,
    restoreObjectBatch,
    getDeletedObjectIds: () => deletedObjectIds,
    getLayer,
    upsertLayer,
    insertLayerAt,
    removeLayer,
    isObjectEffectivelyLocked: (objectId) => nodeLocks.get(objectId)?.effectiveLocked ?? false,
    getEffect,
    upsertEffect,
    insertEffectAt,
    removeEffect,
    getSelectedObjectId: () => selectedObjectId,
    getSelectedEffectId: () => selectedEffectId,
    setSelectedObjectId: (objectId) => {
      const nextSelectedId = objectId && getObject(objectId) ? objectId : null
      if (nextSelectedId === selectedObjectId) return
      selectedObjectId = nextSelectedId
      if (nextSelectedId && selectedEffectId) {
        selectedEffectId = null
        emit({ type: 'effectSelectionChanged', effectId: null })
      }
      emit({ type: 'selectionChanged', objectId: selectedObjectId })
    },
    setSelectedEffectId: (effectId) => {
      const nextSelectedId = effectId && getEffect(effectId) ? effectId : null
      if (nextSelectedId === selectedEffectId) return
      selectedEffectId = nextSelectedId
      if (nextSelectedId && selectedObjectId) {
        selectedObjectId = null
        emit({ type: 'selectionChanged', objectId: null })
      }
      emit({ type: 'effectSelectionChanged', effectId: selectedEffectId })
    },
  }
}
