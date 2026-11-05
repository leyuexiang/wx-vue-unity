import type { SceneTransform } from '../core/types'
import type { SceneCommand } from './types'
import { captureSceneObjectUpdateRollback } from './sceneObjectRollback'

interface UpdateObjectTransformCommand extends SceneCommand {
  objectId: string
  getTransform: () => SceneTransform
  getPreviousTransform: () => SceneTransform | undefined
}

const isUpdateObjectTransformCommand = (
  command: SceneCommand,
): command is UpdateObjectTransformCommand =>
  command.name === 'UpdateObjectTransform' &&
  typeof (command as Partial<UpdateObjectTransformCommand>).objectId === 'string' &&
  typeof (command as Partial<UpdateObjectTransformCommand>).getTransform === 'function' &&
  typeof (command as Partial<UpdateObjectTransformCommand>).getPreviousTransform === 'function'

/**
 * 更新对象 Transform 命令。
 *
 * 约束：
 * - Transform 是领域数据，不允许携带引擎对象（例如 Three.Matrix4 / Cesium.Cartesian3）。
 * - objectId 不存在时抛错，避免静默失败导致状态与渲染不一致。
 */
export function createUpdateObjectTransformCommand(
  objectId: string,
  transform: SceneTransform,
  mergeSession?: symbol,
): SceneCommand {
  let previousTransform: SceneTransform | undefined
  let nextTransform = transform

  const command: UpdateObjectTransformCommand = {
    name: 'UpdateObjectTransform',
    captureRollback: (store) => captureSceneObjectUpdateRollback(store, objectId),
    objectId,
    mergeSession,
    getTransform: () => nextTransform,
    getPreviousTransform: () => previousTransform,
    execute: (store) => {
      const current = store.getObject(objectId)
      if (!current) {
        throw new Error(`Object not found: ${objectId}`)
      }
      if (store.isObjectEffectivelyLocked(objectId)) {
        throw new Error(`Locked object cannot update transform: ${objectId}`)
      }
      previousTransform ??= current.transform
      store.upsertObject({ ...current, transform: nextTransform })
    },
    undo: (store) => {
      const current = store.getObject(objectId)
      // 只恢复变换，保留期间由其他来源更新的对象字段。
      if (current && previousTransform) store.upsertObject({ ...current, transform: previousTransform })
    },
    mergeWith: (nextCommand) => {
      if (!isUpdateObjectTransformCommand(nextCommand)) return false
      if (nextCommand.objectId !== objectId) return false
      if (nextCommand.getPreviousTransform() !== nextTransform) return false
      nextTransform = nextCommand.getTransform()
      return true
    },
  }

  return command
}
