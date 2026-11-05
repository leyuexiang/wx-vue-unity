import {
  createCreateObjectLayerCommand,
  createDeleteObjectLayerCommand,
  createMoveObjectToLayerCommand,
  createReorderObjectLayersCommand,
  createUpdateObjectLayerCommand,
  createUpdateObjectLockCommand,
  type CommandBus,
  type ObjectLayerPatch,
  type SceneDefinition,
  type SceneLayer,
  type SceneObject,
  type SceneStore,
} from '@/scene-platform'
import { assertOriginalObjectLayerDeletionAllowed } from './twoDPackagePreservation'

export const EDITOR_DEFAULT_OBJECT_LAYER_ID = 'editor-object-layer-default'
export const EDITOR_DEFAULT_OBJECT_LAYER_NAME = '默认图层'

type EditorSceneObjectLayer = SceneLayer & { type: 'object' }

export interface EditorSceneObjectLayerGroup {
  id: string
  name: string
  visible: boolean
  locked: boolean
  order: number
  layer: EditorSceneObjectLayer
  objectIds: string[]
  objects: SceneObject[]
}

export type EditorSceneLayerSkipReason =
  | 'missing-store'
  | 'missing-scene'
  | 'missing-layer-id'
  | 'missing-layer'
  | 'unchanged'
  | 'locked-object'

export type EditorSceneLayerUpdateResult =
  | {
      status: 'applied'
      layerId?: string
      changedObjectIds: string[]
      layerCreated?: boolean
    }
  | {
      status: 'skipped'
      reason: EditorSceneLayerSkipReason
    }

const isObjectLayer = (layer: SceneLayer): layer is EditorSceneObjectLayer =>
  layer.type === 'object'

/**
 * 判断是否为编辑器为旧数据补齐的系统默认对象图层。
 *
 * 该图层只用于给无 layerId 的旧对象提供可保存归属；
 * 当场景里只有这一层时，页面可以继续展示为原来的扁平模型列表，避免把兼容数据暴露成用户主动创建的图层。
 */
export const isEditorManagedDefaultObjectLayer = (
  layer?: SceneLayer | null,
): layer is EditorSceneObjectLayer =>
  Boolean(
    layer &&
      isObjectLayer(layer) &&
      layer.name === EDITOR_DEFAULT_OBJECT_LAYER_NAME &&
      layer.metadata?.editorManaged === true,
  )

const compareObjectLayers = (layers: readonly SceneLayer[]) => {
  const indexMap = new Map(layers.map((layer, index) => [layer.id, index]))

  return (first: EditorSceneObjectLayer, second: EditorSceneObjectLayer) => {
    const orderDiff = first.order - second.order
    if (orderDiff !== 0) return orderDiff
    return (indexMap.get(first.id) ?? 0) - (indexMap.get(second.id) ?? 0)
  }
}

const getSortedObjectLayers = (layers: readonly SceneLayer[]) =>
  layers.filter(isObjectLayer).sort(compareObjectLayers(layers))

const createDefaultObjectLayer = (
  existingLayers: readonly SceneLayer[],
  order = 0,
): EditorSceneObjectLayer => {
  const usedIds = new Set(existingLayers.map((layer) => layer.id))
  let id = EDITOR_DEFAULT_OBJECT_LAYER_ID
  let index = 1

  while (usedIds.has(id)) {
    id = `${EDITOR_DEFAULT_OBJECT_LAYER_ID}-${index}`
    index += 1
  }

  return {
    id,
    name: EDITOR_DEFAULT_OBJECT_LAYER_NAME,
    type: 'object',
    visible: true,
    locked: false,
    order,
    metadata: {
      editorManaged: true,
    },
  }
}

/**
 * 获取对象图层；旧场景没有 SceneLayer 时只生成临时视图，不修改原始场景。
 * 真正写回 Store 的动作由 ensureEditorSceneObjectLayersInStore 负责，避免只读计算产生副作用。
 */
export const buildEditorSceneObjectLayerGroups = (
  scene?: SceneDefinition | null,
): EditorSceneObjectLayerGroup[] => {
  if (!scene) return []

  const sortedObjectLayers = getSortedObjectLayers(scene.layers)
  /** 无显式分组的对象保持根级平铺，不能再伪装成用户可见的默认分组。 */
  if (sortedObjectLayers.length === 0) return []

  const objectLayers = sortedObjectLayers
  const objectLayerIds = new Set(objectLayers.map((layer) => layer.id))
  const objectsByLayer = new Map(objectLayers.map((layer) => [layer.id, [] as SceneObject[]]))

  scene.objects.forEach((object) => {
    if (object.layerId && objectLayerIds.has(object.layerId)) {
      objectsByLayer.get(object.layerId)?.push(object)
    }
  })

  return objectLayers.map((layer) => {
    const objects = objectsByLayer.get(layer.id) || []

    return {
      id: layer.id,
      name: layer.name,
      visible: layer.visible,
      locked: layer.locked,
      order: layer.order,
      layer,
      objectIds: objects.map((object) => object.id),
      objects,
    }
  })
}

/**
 * 补齐编辑器对象图层并把无归属对象挂到默认对象图层。
 *
 * 旧草稿的兼容归属仍同步到运行端和结构面板，但不单独视为用户编辑。
 */
export const ensureEditorSceneObjectLayersInStore = (
  store?: SceneStore | null,
): EditorSceneLayerUpdateResult => {
  if (!store) return { status: 'skipped', reason: 'missing-store' }

  const scene = store.getScene()
  if (!scene) return { status: 'skipped', reason: 'missing-scene' }

  let objectLayers = getSortedObjectLayers(scene.layers)
  let fallbackLayer = objectLayers.find(isEditorManagedDefaultObjectLayer)
  let layerCreated = false

  if (!fallbackLayer) {
    // 有用户图层时，未归组节点应留在根列表，不能自动移进任意分组。
    if (scene.objects.length === 0 || objectLayers.length) return { status: 'skipped', reason: 'unchanged' }

    const nextOrder =
      scene.layers.reduce((maxOrder, layer) => Math.max(maxOrder, layer.order), -1) + 1
    fallbackLayer = createDefaultObjectLayer(scene.layers, nextOrder)
    store.upsertLayer(fallbackLayer, 'loadNormalization')
    objectLayers = [fallbackLayer]
    layerCreated = true
  }

  const objectLayerIds = new Set(objectLayers.map((layer) => layer.id))
  const changedObjectIds: string[] = []

  /**
   * 先复制数组再写 Store，避免 upsertObject 修改 scene.objects 时影响本轮遍历。
   * 这里只更新 layerId，不触碰变换、资产、样式等运行时敏感字段。
   */
  scene.objects.slice().forEach((object) => {
    if (object.layerId && objectLayerIds.has(object.layerId)) return

    store.upsertObject({
      ...object,
      layerId: fallbackLayer.id,
    }, 'loadNormalization')
    changedObjectIds.push(object.id)
  })

  if (!layerCreated && changedObjectIds.length === 0) {
    return { status: 'skipped', reason: 'unchanged' }
  }

  return {
    status: 'applied',
    layerId: fallbackLayer.id,
    changedObjectIds,
    layerCreated,
  }
}

const applyObjectOrder = (store: SceneStore, desiredObjects: readonly SceneObject[]): string[] => {
  const currentIds = store.getObjects().map((object) => object.id)
  const desiredIds = desiredObjects.map((object) => object.id)
  if (
    currentIds.length === desiredIds.length &&
    currentIds.every((objectId, index) => objectId === desiredIds[index])
  ) {
    return []
  }

  const movedObjectIds: string[] = []
  desiredObjects.forEach((object, index) => {
    if (store.getObjects()[index]?.id === object.id) return
    store.insertObjectAt(object, index)
    movedObjectIds.push(object.id)
  })

  return movedObjectIds
}

const buildLayerRankMap = (layers: readonly EditorSceneObjectLayer[]) =>
  new Map(layers.map((layer, index) => [layer.id, index]))

const sortObjectsByLayer = (
  objects: readonly SceneObject[],
  layers: readonly EditorSceneObjectLayer[],
  orderedObjectIdsByLayer = new Map<string, string[]>(),
) => {
  const layerRankMap = buildLayerRankMap(layers)
  const fallbackLayerId = layers[0]?.id
  const originalIndexMap = new Map(objects.map((object, index) => [object.id, index]))
  const objectMap = new Map(objects.map((object) => [object.id, object]))
  const orderedObjectIdSet = new Set(
    Array.from(orderedObjectIdsByLayer.values()).flatMap((objectIds) => objectIds),
  )

  const groupedObjects = new Map<string, SceneObject[]>()
  objects.forEach((object) => {
    const layerId =
      object.layerId && layerRankMap.has(object.layerId) ? object.layerId : fallbackLayerId
    if (!layerId) return
    const currentObjects = groupedObjects.get(layerId) || []
    currentObjects.push(object)
    groupedObjects.set(layerId, currentObjects)
  })

  return layers.flatMap((layer) => {
    const currentObjects = (groupedObjects.get(layer.id) || []).sort(
      (first, second) =>
        first.order - second.order ||
        (originalIndexMap.get(first.id) ?? 0) - (originalIndexMap.get(second.id) ?? 0),
    )
    const preferredObjects = (orderedObjectIdsByLayer.get(layer.id) || [])
      .map((objectId) => objectMap.get(objectId))
      .filter((object): object is SceneObject => Boolean(object))
    const remainingObjects = currentObjects
      .filter((object) => !orderedObjectIdSet.has(object.id))
      .sort(
        (first, second) =>
          (originalIndexMap.get(first.id) ?? 0) - (originalIndexMap.get(second.id) ?? 0),
      )

    return [...preferredObjects, ...remainingObjects]
  })
}

export const setEditorSceneObjectLayerVisible = ({
  store,
  commandBus,
  layerId,
  visible,
}: {
  store?: SceneStore | null
  commandBus?: Pick<CommandBus, 'execute'> | null
  layerId?: string | null
  visible: boolean
}): EditorSceneLayerUpdateResult => {
  if (!store) return { status: 'skipped', reason: 'missing-store' }
  if (!layerId) return { status: 'skipped', reason: 'missing-layer-id' }

  const scene = store.getScene()
  const layer = getSortedObjectLayers(scene.layers).find((item) => item.id === layerId)
  if (!layer) return { status: 'skipped', reason: 'missing-layer' }

  if (layer.visible === visible) return { status: 'skipped', reason: 'unchanged' }

  /** 组显隐只写图层自身；RuntimeBridge 计算有效可见性，不覆盖成员原值。 */
  if (commandBus) commandBus.execute(createUpdateObjectLayerCommand(layerId, { visible }))
  else store.upsertLayer({ ...layer, visible })

  return {
    status: 'applied',
    layerId,
    changedObjectIds: store
      .getObjects()
      .filter((object) => object.layerId === layerId)
      .map((object) => object.id),
  }
}

export const reorderEditorSceneObjectLayers = (
  store?: SceneStore | null,
  orderedLayerIds: readonly string[] = [],
  commandBus?: Pick<CommandBus, 'execute'> | null,
  movedLayerId?: string,
): EditorSceneLayerUpdateResult => {
  if (!store) return { status: 'skipped', reason: 'missing-store' }

  const scene = store.getScene()
  const objectLayers = getSortedObjectLayers(scene.layers)
  if (objectLayers.length === 0) return { status: 'skipped', reason: 'missing-layer' }

  const layerMap = new Map(objectLayers.map((layer) => [layer.id, layer]))
  const orderedUniqueLayerIds = Array.from(new Set(orderedLayerIds)).filter((layerId) =>
    layerMap.has(layerId),
  )
  const orderedLayerIdSet = new Set(orderedUniqueLayerIds)
  const remainingLayers = objectLayers.filter((layer) => !orderedLayerIdSet.has(layer.id))
  const nextObjectLayers = [
    ...orderedUniqueLayerIds.map((layerId) => layerMap.get(layerId)!),
    ...remainingLayers,
  ].map((layer, index) => ({
    ...layer,
    order: index,
  }))

  const nextLayerOrderMap = new Map(nextObjectLayers.map((layer) => [layer.id, layer.order]))
  const layerOrderChanged = objectLayers.some(
    (layer) => layer.order !== nextLayerOrderMap.get(layer.id),
  )

  const desiredObjects = sortObjectsByLayer(store.getObjects(), nextObjectLayers)
  const movedObjectIds = desiredObjects
    .filter((object, index) => store.getObjects()[index]?.id !== object.id)
    .map((object) => object.id)

  if (!layerOrderChanged && movedObjectIds.length === 0) {
    return { status: 'skipped', reason: 'unchanged' }
  }

  if (commandBus) {
    commandBus.execute(createReorderObjectLayersCommand(orderedLayerIds, movedLayerId))
  } else {
    objectLayers.forEach((layer) => {
      const order = nextLayerOrderMap.get(layer.id)
      if (order !== undefined && order !== layer.order) store.upsertLayer({ ...layer, order })
    })
    applyObjectOrder(store, desiredObjects)
  }

  return {
    status: 'applied',
    changedObjectIds: movedObjectIds,
  }
}

const createObjectLayerId = (store: SceneStore) => {
  const usedIds = new Set(store.getLayers().map((layer) => layer.id))
  // 已删除原图层的编号仍用于保存，不能在同一会话复用。
  for (const id of store.captureSaveEdits().layers.keys()) usedIds.add(id)
  let sequence = 1
  let id = `editor-object-group-${sequence}`
  while (usedIds.has(id)) {
    sequence += 1
    id = `editor-object-group-${sequence}`
  }
  return id
}

/** 创建可持久化的空模型分组；该图层不会成为 Three Object3D。 */
export const createEditorSceneObjectLayer = ({
  store,
  commandBus,
  name,
}: {
  store?: SceneStore | null
  commandBus?: Pick<CommandBus, 'execute'> | null
  name?: string
}): EditorSceneLayerUpdateResult => {
  if (!store) return { status: 'skipped', reason: 'missing-store' }
  if (!commandBus) return { status: 'skipped', reason: 'unchanged' }
  const objectLayers = getSortedObjectLayers(store.getLayers())
  const id = createObjectLayerId(store)
  const layer: EditorSceneObjectLayer = {
    id,
    name: name?.trim() || `分组${objectLayers.length + 1}`,
    type: 'object',
    visible: true,
    locked: false,
    order: objectLayers.length,
    metadata: { editorManaged: true, visualGroup: true },
  }
  commandBus.execute(createCreateObjectLayerCommand(layer))
  return { status: 'applied', layerId: id, changedObjectIds: [], layerCreated: true }
}

/** 更新分组名称、显隐、锁定或视觉顺序。 */
export const updateEditorSceneObjectLayer = ({
  store,
  commandBus,
  layerId,
  patch,
}: {
  store?: SceneStore | null
  commandBus?: Pick<CommandBus, 'execute'> | null
  layerId?: string | null
  patch: ObjectLayerPatch
}): EditorSceneLayerUpdateResult => {
  if (!store) return { status: 'skipped', reason: 'missing-store' }
  if (!layerId) return { status: 'skipped', reason: 'missing-layer-id' }
  const layer = store.getLayer(layerId)
  if (!layer || layer.type !== 'object') return { status: 'skipped', reason: 'missing-layer' }
  if (!commandBus) return { status: 'skipped', reason: 'unchanged' }
  commandBus.execute(createUpdateObjectLayerCommand(layerId, patch))
  return { status: 'applied', layerId, changedObjectIds: [] }
}

export const setEditorSceneObjectLayerLocked = (options: {
  store?: SceneStore | null
  commandBus?: Pick<CommandBus, 'execute'> | null
  layerId?: string | null
  locked: boolean
}) => updateEditorSceneObjectLayer({ ...options, patch: { locked: options.locked } })

/** 设置模型自身锁定；组锁定不会覆盖该值，解锁组后可恢复成员原状态。 */
export const setEditorSceneObjectLocked = ({
  store,
  commandBus,
  objectId,
  locked,
}: {
  store?: SceneStore | null
  commandBus?: Pick<CommandBus, 'execute'> | null
  objectId: string
  locked: boolean
}): EditorSceneLayerUpdateResult => {
  if (!store) return { status: 'skipped', reason: 'missing-store' }
  const object = store.getObject(objectId)
  if (!object || !commandBus) return { status: 'skipped', reason: 'unchanged' }
  if (object.locked === locked) return { status: 'skipped', reason: 'unchanged' }
  if (store.getObjectLockState(objectId)?.inheritedLocked) return { status: 'skipped', reason: 'locked-object' }
  commandBus.execute(createUpdateObjectLockCommand(objectId, locked))
  return { status: 'applied', layerId: object.layerId, changedObjectIds: [objectId] }
}

/** 删除分组后成员回到根级平铺，成员本身和顺序不变。 */
export const deleteEditorSceneObjectLayer = ({
  store,
  commandBus,
  layerId,
}: {
  store?: SceneStore | null
  commandBus?: Pick<CommandBus, 'execute'> | null
  layerId?: string | null
}): EditorSceneLayerUpdateResult => {
  if (!store) return { status: 'skipped', reason: 'missing-store' }
  if (!layerId) return { status: 'skipped', reason: 'missing-layer-id' }
  if (!store.getLayer(layerId)) return { status: 'skipped', reason: 'missing-layer' }
  if (!commandBus) return { status: 'skipped', reason: 'unchanged' }
  assertOriginalObjectLayerDeletionAllowed(
    store.getScene().id, layerId, new Set(store.getObjects().map((object) => object.id)), store.getDeletedObjectIds(),
  )
  const changedObjectIds = store
    .getObjects()
    .filter((item) => item.layerId === layerId)
    .map((item) => item.id)
  commandBus.execute(createDeleteObjectLayerCommand(layerId))
  return { status: 'applied', layerId, changedObjectIds }
}

/**
 * 移动模型的视觉归属和同级顺序，但不修改 Three 父子关系。
 * 目标同级下标会先换算成场景对象数组的绝对下标，再与归属一起交给单条命令提交。
 */
export const moveEditorSceneObjectToLayer = ({
  store,
  commandBus,
  objectId,
  layerId,
  targetIndex,
}: {
  store?: SceneStore | null
  commandBus?: Pick<CommandBus, 'execute'> | null
  objectId: string
  layerId?: string | null
  targetIndex?: number
}): EditorSceneLayerUpdateResult => {
  if (!store) return { status: 'skipped', reason: 'missing-store' }
  const object = store.getObject(objectId)
  if (!object) return { status: 'skipped', reason: 'unchanged' }
  if (layerId && !store.getLayer(layerId)) return { status: 'skipped', reason: 'missing-layer' }
  if (!commandBus) return { status: 'skipped', reason: 'unchanged' }

  const managedDefaultLayer = getSortedObjectLayers(store.getLayers()).find(
    isEditorManagedDefaultObjectLayer,
  )
  /** 根级模型在持久化层仍归属于系统默认图层，界面只隐藏这层视觉包装。 */
  const targetLayerId = layerId || managedDefaultLayer?.id
  const currentVisualLayerId = isEditorManagedDefaultObjectLayer(
    object.layerId ? store.getLayer(object.layerId) : null,
  )
    ? undefined
    : object.layerId
  const currentSiblings = store.getObjects().filter((item) => item.layerId === object.layerId)
  const currentIndex = currentSiblings.findIndex((item) => item.id === objectId)
  const boundedTargetIndex =
    targetIndex === undefined
      ? undefined
      : Math.min(Math.max(targetIndex, 0), Math.max(currentSiblings.length - 1, 0))

  if (
    currentVisualLayerId === (layerId || undefined) &&
    (targetIndex === undefined || currentIndex === boundedTargetIndex)
  ) {
    return { status: 'skipped', reason: 'unchanged' }
  }

  let targetObjectIndex: number | undefined
  if (targetIndex !== undefined) {
    const objectsWithoutMoved = store.getObjects().filter((item) => item.id !== objectId)
    const targetSiblings = objectsWithoutMoved.filter((item) => item.layerId === targetLayerId)
    const siblingIndex = Math.min(Math.max(targetIndex, 0), targetSiblings.length)
    const orderedTargetIds = targetSiblings.map((item) => item.id)
    orderedTargetIds.splice(siblingIndex, 0, objectId)

    /**
     * 空目标组不能简单插到全局数组末尾，否则图层顺序与结构树顺序会分离。
     * 先在内存中构造最终对象及目标组顺序，再复用统一图层排序计算绝对下标；
     * 真正写入仍只发生在 MoveObjectToLayer 单条命令中，撤销基线不会被提前污染。
     */
    const nextObject = { ...object, layerId: targetLayerId }
    const orderedObjects = sortObjectsByLayer(
      [...objectsWithoutMoved, nextObject],
      getSortedObjectLayers(store.getLayers()),
      new Map([[targetLayerId!, orderedTargetIds]]),
    )
    targetObjectIndex = orderedObjects.findIndex((item) => item.id === objectId)
  }

  commandBus.execute(createMoveObjectToLayerCommand(objectId, targetLayerId, targetObjectIndex))
  return { status: 'applied', layerId: layerId || undefined, changedObjectIds: [objectId] }
}

/** 统一返回对象自身状态、组继承状态和最终生效状态。 */
export const resolveEditorSceneObjectEffectiveState = (
  store: SceneStore | null | undefined,
  objectId: string,
) => {
  const object = store?.getObject(objectId)
  const lock = store?.getObjectLockState(objectId)
  const visibility = store?.getObjectVisibilityState(objectId)
  return {
    ownLocked: object?.locked === true,
    inheritedLocked: lock?.inheritedLocked ?? false,
    effectiveLocked: lock?.effectiveLocked ?? false,
    ownVisible: object?.visible !== false,
    inheritedVisible: visibility?.inheritedVisible ?? true,
    effectiveVisible: visibility?.effectiveVisible ?? false,
  }
}
