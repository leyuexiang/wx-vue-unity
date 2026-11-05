import type { SceneObject } from '../core/types'
import type { SceneCommand } from './types'
import { captureSceneObjectUpdateRollback } from './sceneObjectRollback'

/**
 * 对象样式增量。
 *
 * 样式字段承载材质透明度、颜色等可序列化显示参数。它与 metadata 分离，避免业务元数据
 * 变更被误判为渲染样式更新；每次命令只浅合并本次字段，不覆盖同一对象已有的其它样式。
 */
export type UpdateObjectStylePatch = Record<string, unknown>

interface UpdateObjectStyleCommand extends SceneCommand {
  objectId: string
  getPatch: () => UpdateObjectStylePatch
}

const isUpdateObjectStyleCommand = (command: SceneCommand): command is UpdateObjectStyleCommand =>
  command.name === 'UpdateObjectStyle' &&
  typeof (command as Partial<UpdateObjectStyleCommand>).objectId === 'string' &&
  typeof (command as Partial<UpdateObjectStyleCommand>).getPatch === 'function'

/**
 * 创建对象样式更新命令。
 *
 * 命令只写入 SceneStore，RuntimeBridge 根据样式脏标记同步到具体引擎。只有调用方显式
 * 提供相同字段的编辑会话时，才合并同一对象的历史记录。
 */
export function createUpdateObjectStyleCommand(
  objectId: string,
  patch: UpdateObjectStylePatch,
  mergeSession?: symbol,
): SceneCommand {
  let previousObject: SceneObject | null = null
  let nextPatch = patch

  const command: UpdateObjectStyleCommand = {
    name: 'UpdateObjectStyle',
    captureRollback: (store) => captureSceneObjectUpdateRollback(store, objectId),
    objectId,
    mergeSession,
    getPatch: () => nextPatch,
    execute: (store) => {
      if (!previousObject) previousObject = store.getObject(objectId)

      const current = store.getObject(objectId)
      if (!current) {
        throw new Error(`Object not found: ${objectId}`)
      }
      if (store.isObjectEffectivelyLocked(objectId)) {
        throw new Error(`Locked object cannot update style: ${objectId}`)
      }

      store.upsertObject({
        ...current,
        style: { ...current.style, ...nextPatch },
      })
    },
    undo: (store) => {
      if (previousObject) store.upsertObject(previousObject)
    },
    mergeWith: (nextCommand) => {
      if (!isUpdateObjectStyleCommand(nextCommand)) return false
      if (nextCommand.objectId !== objectId) return false
      nextPatch = { ...nextPatch, ...nextCommand.getPatch() }
      return true
    },
  }

  return command
}
