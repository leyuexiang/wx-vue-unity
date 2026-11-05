import type { SceneLayer, SceneObject } from '../core/types'
import type { SceneCommand } from './types'
import { captureSceneObjectMembershipRollback, captureSceneObjectUpdateRollback } from './sceneObjectRollback'

export type ObjectLayerPatch = Partial<Pick<SceneLayer, 'name' | 'visible' | 'locked' | 'order'>>

const getSortedObjectLayers = (layers: readonly SceneLayer[]) => {
  const originalIndex = new Map(layers.map((layer, index) => [layer.id, index]))
  return layers
    .filter((layer) => layer.type === 'object')
    .sort(
      (first, second) =>
        first.order - second.order ||
        (originalIndex.get(first.id) ?? 0) - (originalIndex.get(second.id) ?? 0),
    )
}

/** 创建纯管理用途的对象图层；Runtime 不会据此创建 Three 父子节点。 */
export function createCreateObjectLayerCommand(layer: SceneLayer): SceneCommand {
  return {
    name: 'CreateObjectLayer',
    execute: (store) => {
      if (store.getLayer(layer.id)) throw new Error(`Layer already exists: ${layer.id}`)
      store.upsertLayer(layer)
    },
    undo: (store) => {
      store.removeLayer(layer.id)
    },
  }
}

/** 更新对象图层的管理属性，不覆盖同组对象自身的显隐或锁定状态。 */
export function createUpdateObjectLayerCommand(
  layerId: string,
  patch: ObjectLayerPatch,
): SceneCommand {
  let previousLayer: SceneLayer | null = null
  return {
    name: 'UpdateObjectLayer',
    execute: (store) => {
      const current = store.getLayer(layerId)
      if (!current || current.type !== 'object')
        throw new Error(`Object layer not found: ${layerId}`)
      previousLayer ??= current
      store.upsertLayer({ ...current, ...patch, id: current.id, type: 'object' })
    },
    undo: (store) => {
      if (previousLayer) store.upsertLayer(previousLayer)
    },
  }
}

/**
 * 原子重排对象分组及其成员的全局数组缓存。
 *
 * 分组顺序持久化到 SceneLayer.order；成员的同组顺序继续由 SceneObject.order 表达。
 * 命令保存首次执行前的图层和对象快照，确保一次分组拖拽只产生一条可撤销记录。
 */
export function createReorderObjectLayersCommand(
  orderedLayerIds: readonly string[],
  movedLayerId?: string,
): SceneCommand {
  let previousLayers: SceneLayer[] | null = null
  let previousObjects: SceneObject[] | null = null

  return {
    name: 'ReorderObjectLayers',
    execute: (store) => {
      const objectLayers = getSortedObjectLayers(store.getLayers())
      const layerMap = new Map(objectLayers.map((layer) => [layer.id, layer]))
      if (movedLayerId) {
        const movedLayer = layerMap.get(movedLayerId)
        if (!movedLayer) throw new Error(`Object layer not found: ${movedLayerId}`)
        if (movedLayer.locked)
          throw new Error(`Locked object layer cannot be moved: ${movedLayerId}`)
      }

      const uniqueLayerIds = Array.from(new Set(orderedLayerIds))
      const invalidLayerId = uniqueLayerIds.find((layerId) => !layerMap.has(layerId))
      if (invalidLayerId) throw new Error(`Object layer not found: ${invalidLayerId}`)

      previousLayers ??= objectLayers.map((layer) => ({ ...layer }))
      previousObjects ??= store.getObjects().map((object) => ({ ...object }))

      const orderedLayerIdSet = new Set(uniqueLayerIds)
      const nextLayers = [
        ...uniqueLayerIds.map((layerId) => layerMap.get(layerId)!),
        ...objectLayers.filter((layer) => !orderedLayerIdSet.has(layer.id)),
      ].map((layer, order) => ({ ...layer, order }))

      nextLayers.forEach((layer) => {
        if (store.getLayer(layer.id)?.order !== layer.order) store.upsertLayer(layer)
      })

      const nextLayerIds = new Set(nextLayers.map((layer) => layer.id))
      const objectsByLayer = new Map(nextLayers.map((layer) => [layer.id, [] as SceneObject[]]))
      const rootObjects: SceneObject[] = []
      store.getObjects().forEach((object) => {
        if (object.layerId && nextLayerIds.has(object.layerId)) {
          objectsByLayer.get(object.layerId)?.push(object)
        } else {
          rootObjects.push(object)
        }
      })

      const nextObjects = [
        ...rootObjects.sort((first, second) => first.order - second.order),
        ...nextLayers.flatMap((layer) =>
          (objectsByLayer.get(layer.id) ?? []).sort((first, second) => first.order - second.order),
        ),
      ]
      nextObjects.forEach((object, index) => {
        if (store.getObjects()[index]?.id !== object.id) store.insertObjectAt(object, index)
      })
    },
    undo: (store) => {
      if (!previousLayers || !previousObjects) return
      previousLayers.forEach((layer) => store.upsertLayer(layer))
      previousObjects.forEach((object, index) => store.insertObjectAt(object, index))
    },
  }
}

/**
 * 删除视觉分组并把成员归属清空。
 * 对象仍保留在场景根级；命令不改变对象顺序、变换和 Three 父子关系。
 */
export function createDeleteObjectLayerCommand(layerId: string): SceneCommand {
  let removedLayer: { layer: SceneLayer; index: number } | null = null
  let previousMembers: SceneObject[] = []
  return {
    name: 'DeleteObjectLayer',
    captureRollback: (store) => {
      const currentLayer = store.getLayer(layerId)
      const index = store.getLayers().findIndex((layer) => layer.id === layerId)
      const ids = new Set([...store.getObjectIdsInLayer(layerId), ...previousMembers.map((object) => object.id)])
      const restoreObjects = captureSceneObjectMembershipRollback(store, ids, previousMembers)
      return () => {
        // 恢复图层归属属于失败补偿，不重新执行删除命令的编辑门禁。
        if (currentLayer) store.insertLayerAt(currentLayer, index)
        restoreObjects()
        if (!currentLayer && store.getLayer(layerId)) store.removeLayer(layerId)
      }
    },
    execute: (store) => {
      const layer = store.getLayer(layerId)
      if (!layer || layer.type !== 'object') throw new Error(`Object layer not found: ${layerId}`)
      if (layer.locked) throw new Error(`Locked object layer cannot be deleted: ${layerId}`)

      const currentMembers = store.getObjects().filter((object) => object.layerId === layerId)
      /**
       * 删除分组会把全部成员移动到根级，因此必须复用对象移动相同的“有效锁定”约束。
       * 在执行任何写入前一次性校验，避免部分成员已脱组后才发现锁定对象而留下半完成状态。
       */
      const lockedMember = currentMembers.find((object) =>
        store.isObjectEffectivelyLocked(object.id),
      )
      if (lockedMember) {
        throw new Error(`Locked object cannot be moved: ${lockedMember.id}`)
      }

      if (!removedLayer) {
        const index = store.getLayers().findIndex((item) => item.id === layerId)
        removedLayer = { layer, index }
        previousMembers = currentMembers
      }

      previousMembers.forEach((object) => store.upsertObject({ ...object, layerId: undefined }))
      store.removeLayer(layerId)
    },
    undo: (store) => {
      if (!removedLayer) return
      store.insertLayerAt(removedLayer.layer, removedLayer.index)
      previousMembers.forEach((object) => store.upsertObject(object))
    },
  }
}

/**
 * 移动视觉归属；空 layerId 表示回到根级平铺列表。
 * targetObjectIndex 是移除当前对象后在 SceneDefinition.objects 中的绝对插入位置；
 * 归属与顺序由同一命令提交，撤销时也能原子恢复原父级和精确顺序。
 */
export function createMoveObjectToLayerCommand(
  objectId: string,
  layerId?: string | null,
  targetObjectIndex?: number,
): SceneCommand {
  let previousObject: SceneObject | null = null
  let previousObjectIndex = -1
  return {
    name: 'MoveObjectToLayer',
    captureRollback: (store) => captureSceneObjectMembershipRollback(store, new Set([objectId]), [
      ...(previousObject ? [previousObject] : []),
      { parentInstanceId: store.getObject(objectId)?.parentInstanceId, layerId: layerId || undefined },
    ]),
    execute: (store) => {
      const current = store.getObject(objectId)
      if (!current) throw new Error(`Object not found: ${objectId}`)
      if (store.isObjectEffectivelyLocked(objectId)) {
        throw new Error(`Locked object cannot be moved: ${objectId}`)
      }
      if (layerId) {
        const target = store.getLayer(layerId)
        if (!target || target.type !== 'object')
          throw new Error(`Object layer not found: ${layerId}`)
        if (target.locked) throw new Error(`Object layer is locked: ${layerId}`)
      }
      if (!previousObject) {
        previousObject = current
        previousObjectIndex = store.getObjects().findIndex((object) => object.id === objectId)
      }

      const nextObject = { ...current, layerId: layerId || undefined }
      if (targetObjectIndex === undefined) {
        store.upsertObject(nextObject)
      } else {
        /** insertObjectAt 会先移除同 id 旧项，再按目标下标插入，适合命令重做。 */
        store.insertObjectAt(nextObject, targetObjectIndex)
      }
    },
    undo: (store) => {
      if (!previousObject) return
      /** 精确恢复首次执行前的对象快照与全局下标，不能只恢复 layerId。 */
      store.insertObjectAt(previousObject, previousObjectIndex)
    },
  }
}

/** 更新模型名称；锁定对象只能查看，不能从任意入口绕过只读约束。 */
export function createUpdateObjectNameCommand(objectId: string, name: string): SceneCommand {
  let previousObject: SceneObject | null = null
  const nextName = name.trim()
  return {
    name: 'UpdateObjectName',
    captureRollback: (store) => captureSceneObjectUpdateRollback(store, objectId),
    execute: (store) => {
      if (!nextName) throw new Error('Object name cannot be empty')
      const current = store.getObject(objectId)
      if (!current) throw new Error(`Object not found: ${objectId}`)
      if (store.isObjectEffectivelyLocked(objectId)) {
        throw new Error(`Locked object cannot be renamed: ${objectId}`)
      }
      previousObject ??= current
      store.upsertObject({ ...current, name: nextName })
    },
    undo: (store) => {
      if (previousObject) store.upsertObject(previousObject)
    },
  }
}

/** 更新对象自身锁定；锁定只限制编辑能力，不覆盖独立的可拾取配置。 */
export function createUpdateObjectLockCommand(objectId: string, locked: boolean): SceneCommand {
  let previousLocked: boolean | undefined
  return {
    name: 'UpdateObjectLock',
    captureRollback: (store) => captureSceneObjectUpdateRollback(store, objectId),
    execute: (store) => {
      const current = store.getObject(objectId)
      if (!current) throw new Error(`Object not found: ${objectId}`)
      // 自身锁定允许解除；继承锁定必须先由对应父级或图层解除。
      if (store.getObjectLockState(objectId)?.inheritedLocked) throw new Error('节点受父级或图层锁定，无法修改自身锁定')
      previousLocked ??= current.locked
      store.upsertObject({
        ...current,
        locked,
      })
    },
    undo: (store) => {
      // 回放和补偿只还原本字段，不覆盖期间更新的其他配置。
      const current = store.getObject(objectId)
      if (current && previousLocked !== undefined) store.upsertObject({ ...current, locked: previousLocked })
    },
  }
}
