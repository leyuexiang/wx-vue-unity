import type { SceneObject, SceneStreamingConfig } from '../core/types'
import { pruneSceneStreamingChunkObjectReferences } from '../core/sceneDefinition'
import type { SceneCommand } from './types'
import { captureSceneObjectMembershipRollback } from './sceneObjectRollback'

/** 删除命令需要跨撤销周期保留区块配置；复制纯 JSON 快照，避免后续编辑原地修改历史。 */
const cloneStreamingConfig = (
  streaming: SceneStreamingConfig | undefined,
): SceneStreamingConfig | undefined => (streaming ? structuredClone(streaming) : undefined)

/**
 * 删除对象命令。
 *
 * 特殊语义：
 * - 如果删除的是当前选中对象，Store 会自动清空选中态；
 * - 删除对象关联的流式区块会同步裁剪；undo 时恢复对象、区块快照和当时的选中态。
 */
export function createDeleteObjectCommand(objectId: string): SceneCommand {
  let removed: { object: SceneObject; index: number } | null = null
  let previousSelectedObjectId: string | null = null
  let previousStreaming: SceneStreamingConfig | undefined
  let streamingChangedByDelete = false

  return {
    name: 'DeleteObject',
    captureRollback: (store) => captureSceneObjectMembershipRollback(store, new Set([objectId]), removed ? [removed.object] : []),
    execute: (store) => {
      if (store.isObjectEffectivelyLocked(objectId)) {
        throw new Error(`Locked object cannot be deleted: ${objectId}`)
      }
      if (!removed) {
        previousSelectedObjectId = store.getSelectedObjectId()
        const previousStreamingReference = store.getScene().streaming
        previousStreaming = cloneStreamingConfig(store.getScene().streaming)
        const result = store.removeObject(objectId)
        if (result) {
          removed = { object: result.removed, index: result.index }
          /**
           * Store 默认已在 removeObject 内完成裁剪；这里再做一次边界兜底，兼容宿主注入的旧 Store，
           * 同时让删除命令自身明确承担“对象与区块索引一起变更”的语义。
           */
          const currentScene = store.getScene()
          const repairedStreaming = pruneSceneStreamingChunkObjectReferences({
            id: currentScene.id,
            objects: currentScene.objects,
            streaming: currentScene.streaming,
          })
          if (repairedStreaming !== currentScene.streaming) {
            store.updateSceneStreaming(repairedStreaming)
          }
          streamingChangedByDelete = store.getScene().streaming !== previousStreamingReference
        }
      } else {
        store.removeObject(objectId)
      }
    },
    undo: (store) => {
      if (!removed) return
      store.insertObjectAt(removed.object, removed.index)
      /**
       * removeObject 会即时裁剪失效区块；撤销时必须恢复删除前的完整配置，
       * 包括混合区块、分组和运行态覆盖，保证再次重做仍可得到同一场景快照。
       */
      if (streamingChangedByDelete) {
        store.updateSceneStreaming(cloneStreamingConfig(previousStreaming))
      }
      store.setSelectedObjectId(previousSelectedObjectId)
    },
  }
}
