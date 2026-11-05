import type { SceneStreamingConfig } from '../core/types'
import type { RemovedSceneObject } from '../store/sceneStore'
import { collectEditableSceneSubtrees } from './collectEditableSceneSubtrees'
import type { SceneCommand } from './types'
import { captureSceneObjectMembershipRollback } from './sceneObjectRollback'

/** 删除整个选区并保留精确的恢复位置和区块配置。 */
export function createDeleteSceneSubtreesCommand(
  selectedIds: readonly string[],
  validateReferences: (ids: ReadonlySet<string>) => void,
): SceneCommand {
  const requested = [...new Set(selectedIds)]
  let removed: RemovedSceneObject[] = []
  let previousStreaming: SceneStreamingConfig | undefined
  let streamingChanged = false
  let selectedBefore: string | null = null

  return {
    name: '删除三维节点',
    captureRollback: (store) => removed.length
      ? captureSceneObjectMembershipRollback(store, new Set(removed.map(({ removed }) => removed.id)), removed.map(({ removed }) => removed)) : undefined,
    execute: (store) => {
      const { ids } = collectEditableSceneSubtrees(store, requested, '删除')
      validateReferences(ids)
      const streaming = store.getScene().streaming
      const selected = store.getSelectedObjectId()
      removed = store.removeObjectBatch(ids)
      streamingChanged = streaming !== store.getScene().streaming
      previousStreaming = streamingChanged && streaming ? structuredClone(streaming) : undefined
      selectedBefore = selected
    },
    undo: (store) => {
      // 只恢复本命令实际裁剪过的区块，未触及的配置沿用当前值。
      const streaming = streamingChanged ? previousStreaming : store.getScene().streaming
      store.restoreObjectBatch(removed, streaming)
      store.setSelectedObjectId(selectedBefore)
    },
  }
}
