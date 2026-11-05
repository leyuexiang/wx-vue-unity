import type { SceneObject } from '../core/types'
import type { SceneCommand } from './types'
import { captureSceneObjectMembershipRollback } from './sceneObjectRollback'

/**
 * 创建对象命令。
 *
 * undo 语义：
 * - 如果对象原本存在（同 id），undo 恢复旧对象；
 * - 如果对象原本不存在，undo 直接删除该对象。
 */
export function createCreateObjectCommand(object: SceneObject): SceneCommand {
  let previousObject: SceneObject | null = null

  return {
    name: 'CreateObject',
    captureRollback: (store) => captureSceneObjectMembershipRollback(store, new Set([object.id]), [object]),
    execute: (store) => {
      // 创建也可能覆盖同编号对象或指定业务父级，均不能绕过已有锁定。
      if (store.isObjectEffectivelyLocked(object.id) ||
          (object.parentInstanceId && store.isObjectEffectivelyLocked(object.parentInstanceId)) ||
          (object.layerId && store.getLayer(object.layerId)?.locked)) {
        throw new Error('节点、父级或目标图层已锁定，无法创建或覆盖')
      }
      if (object.type === 'camera' && object.firstPerson) {
        const existing = store.getObjects().find(
          (candidate) =>
            candidate.id !== object.id &&
            candidate.type === 'camera' &&
            candidate.firstPerson !== undefined,
        )
        if (existing) throw new Error('每个场景仅支持一个第一人称相机')
      }
      if (
        object.type === 'effect' &&
        object.effect?.type === 'three-map' &&
        store.getObjects().some(
          (candidate) =>
            candidate.id !== object.id &&
            candidate.type === 'effect' &&
            candidate.effect?.type === 'three-map',
        )
      ) {
        throw new Error('每个场景仅支持一个中国3D地图')
      }
      if (!previousObject) {
        previousObject = store.getObject(object.id)
      }
      store.upsertObject(object)
    },
    undo: (store) => {
      if (previousObject) {
        store.upsertObject(previousObject)
        return
      }
      store.removeObject(object.id)
    },
  }
}
