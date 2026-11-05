import type { SceneObject } from '../core/types'
import type { SceneCommand } from './types'
import { captureSceneObjectUpdateRollback } from './sceneObjectRollback'

export interface UpdateObjectExtensionsPatch {
  metadata?: Record<string, unknown>
  /**
   * 撤销时补回的元数据字段。
   *
   * 部分旧对象的可编辑配置仍只存在于运行时 `userData`。首次迁移这些配置时，原始
   * SceneObject 并没有对应字段；若撤销时直接恢复原对象，Runtime 将无法得知应恢复哪份
   * 旧配置。该补丁只在撤销时合并，用于把当次编辑前的可序列化快照固化为平台基线。
   */
  undoMetadata?: Record<string, unknown>
}

interface UpdateObjectExtensionsCommand extends SceneCommand {
  objectId: string
  getPatch: () => UpdateObjectExtensionsPatch
}

const isUpdateObjectExtensionsCommand = (
  command: SceneCommand,
): command is UpdateObjectExtensionsCommand =>
  command.name === 'UpdateObjectExtensions' &&
  typeof (command as Partial<UpdateObjectExtensionsCommand>).objectId === 'string' &&
  typeof (command as Partial<UpdateObjectExtensionsCommand>).getPatch === 'function'

const mergePatch = (
  previous: UpdateObjectExtensionsPatch,
  next: UpdateObjectExtensionsPatch,
): UpdateObjectExtensionsPatch => ({
  ...(previous.metadata || next.metadata
    ? { metadata: { ...previous.metadata, ...next.metadata } }
    : {}),
  /**
   * 连续输入会合并为同一条历史记录。撤销基线必须以第一笔编辑前的值为准，
   * 因而这里让 `previous` 覆盖 `next` 的同名字段，不能反过来写。
   */
  ...(previous.undoMetadata || next.undoMetadata
    ? { undoMetadata: { ...next.undoMetadata, ...previous.undoMetadata } }
    : {}),
})

/**
 * 创建对象可序列化扩展字段更新命令。
 *
 * 设备编号、可拾取和对象专属面板配置属于编辑器扩展数据，统一落在 `metadata`。
 * 命令以浅合并方式只更新本次字段。仅显式提供同一字段的编辑会话时合并历史，运行时从 Store
 * 收到完整对象快照后再同步旧引擎兼容字段。对于
 * 原先不在 SceneObject 内的旧配置，可选的 `undoMetadata` 会在撤销时补成持久化基线。
 */
export function createUpdateObjectExtensionsCommand(
  objectId: string,
  patch: UpdateObjectExtensionsPatch,
  mergeSession?: symbol,
): SceneCommand {
  let previousObject: SceneObject | null = null
  let nextPatch = patch

  const command: UpdateObjectExtensionsCommand = {
    name: 'UpdateObjectExtensions',
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
        throw new Error(`Locked object cannot update extensions: ${objectId}`)
      }

      store.upsertObject({
        ...current,
        ...(nextPatch.metadata ? { metadata: { ...current.metadata, ...nextPatch.metadata } } : {}),
      })
    },
    undo: (store) => {
      if (!previousObject) return

      if (!nextPatch.undoMetadata) {
        store.upsertObject(previousObject)
        return
      }

      /**
       * 仅在调用方明确提供撤销基线时补写字段。普通扩展命令仍严格恢复原对象，
       * 避免把不相关的 metadata 变更带入历史回退。
       */
      store.upsertObject({
        ...previousObject,
        metadata: { ...previousObject.metadata, ...nextPatch.undoMetadata },
      })
    },
    mergeWith: (nextCommand) => {
      if (!isUpdateObjectExtensionsCommand(nextCommand)) return false
      if (nextCommand.objectId !== objectId) return false
      nextPatch = mergePatch(nextPatch, nextCommand.getPatch())
      return true
    },
  }

  return command
}
