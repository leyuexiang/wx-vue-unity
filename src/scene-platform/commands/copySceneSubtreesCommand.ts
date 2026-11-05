import type { SceneObject, SceneStreamingConfig } from '../core/types'
import type { RemovedSceneObject } from '../store/sceneStore'
import { collectEditableSceneSubtrees } from './collectEditableSceneSubtrees'
import type { SceneCommand } from './types'
import { captureSceneObjectMembershipRollback } from './sceneObjectRollback'

const siblingScope = (node: SceneObject) => node.parentInstanceId === undefined
  ? `layer:${node.layerId ?? ''}` : `parent:${node.parentInstanceId}`

/** 副本与源节点位置相同，延用已有区块和资源，只追加成员编号。 */
function copyChunkMembership(streaming: SceneStreamingConfig | undefined, copies: ReadonlyMap<string, string>) {
  let changed = false
  const chunks = streaming?.chunks.map((chunk) => {
    const added: string[] = []
    for (const id of chunk.objectIds) {
      const copyId = copies.get(id)
      if (copyId) added.push(copyId)
    }
    if (!added.length) return chunk
    changed = true
    return { ...chunk, objectIds: [...chunk.objectIds, ...added] }
  })
  return changed && streaming && chunks ? { ...streaming, chunks } : streaming
}

export function createCopySceneSubtreesCommand(
  requested: readonly string[],
  createId: () => string,
  prepareCopy: (copy: SceneObject, copies: ReadonlyMap<string, string>) => void,
): SceneCommand {
  let batch: {
    entries: RemovedSceneObject[]
    ids: Set<string>
    selectedBefore: string | null
    primaryCopy: string
    streamingBefore: SceneStreamingConfig | undefined
    streamingAfter: SceneStreamingConfig | undefined
  } | undefined

  return {
    name: '复制三维节点',
    captureRollback: (store) => batch ? captureSceneObjectMembershipRollback(store, batch.ids, batch.entries.map(({ removed }) => removed)) : undefined,
    execute(store) {
      // 重做仍复核当前源子树，不能仅依赖首次准备时的锁定检查。
      const editable = collectEditableSceneSubtrees(store, requested, '复制')
      if (!batch) {
        const { ids, nodesById } = editable
        if (!ids.size) return
        const copies = new Map<string, string>()
        const copyIds = new Set<string>()
        const objects = store.getObjects()
        const lastOrder = new Map<string, number>()
        for (const node of objects) {
          const scope = siblingScope(node)
          lastOrder.set(scope, Math.max(lastOrder.get(scope) ?? -1, node.order))
          if (!ids.has(node.id)) continue
          // 沿用现有单实例规则，整批检查后才向草稿写入。
          if (node.effect?.type === 'three-map' || node.firstPerson) throw new Error(`节点「${node.name}」不支持复制`)
          const id = createId()
          if (!id || nodesById.has(id) || copyIds.has(id) || store.getDeletedObjectIds().has(id)) {
            throw new Error('副本编号重复，请重新复制')
          }
          copies.set(node.id, id)
          copyIds.add(id)
        }

        // 同级副本排在原节点之后，保留源节点相对顺序，不改写原有编号或顺序。
        const roots = [...ids].map((id) => nodesById.get(id)!)
          .filter((node) => !node.parentInstanceId || !ids.has(node.parentInstanceId))
          .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1))
        const rootOrder = new Map<string, number>()
        for (const root of roots) {
          const scope = siblingScope(root)
          const order = lastOrder.get(scope)! + 1
          if (order > 2147483647) throw new Error('同级节点顺序已达上限，无法复制')
          rootOrder.set(root.id, order)
          lastOrder.set(scope, order)
        }

        const entries: RemovedSceneObject[] = []
        for (const [sourceId, copyId] of copies) {
          const copy = structuredClone(nodesById.get(sourceId)!)
          copy.id = copyId
          if (copy.parentInstanceId) copy.parentInstanceId = copies.get(copy.parentInstanceId) ?? copy.parentInstanceId
          const order = rootOrder.get(sourceId)
          if (order !== undefined) {
            copy.order = order
            copy.name += ' 副本'
          }
          if (copy.effect?.id === sourceId) copy.effect.id = copyId
          if (copy.metadata) {
            delete copy.metadata.engineObjectUuid
            delete copy.metadata.legacyOnlyUuid
          }
          prepareCopy(copy, copies)
          entries.push({ removed: copy, index: objects.length + entries.length })
        }
        const streaming = store.getScene().streaming
        const streamingAfter = copyChunkMembership(streaming, copies)
        batch = {
          entries, ids: copyIds,
          selectedBefore: store.getSelectedObjectId(),
          primaryCopy: copies.get(requested[0]!)!,
          streamingBefore: streaming,
          streamingAfter,
        }
      }
      // 原副本可能恢复到与当前源节点不同的外部父级，另查其最新锁定。
      const checkedParents = new Set<string>()
      for (const { removed } of batch.entries) {
        const parent = removed.parentInstanceId
        if (!parent || batch.ids.has(parent) || checkedParents.has(parent)) continue
        checkedParents.add(parent)
        if (store.isObjectEffectivelyLocked(parent)) throw new Error('副本目标父级已锁定')
      }
      // 重做和失败补偿复用原批次，节点编号和内部引用保持一致。
      const streaming = batch.streamingBefore === batch.streamingAfter ? store.getScene().streaming : batch.streamingAfter
      store.restoreObjectBatch(batch.entries, streaming)
      store.setSelectedObjectId(batch.primaryCopy)
    },
    undo(store) {
      if (!batch) return
      const streaming = batch.streamingBefore === batch.streamingAfter ? store.getScene().streaming : batch.streamingBefore
      store.removeObjectBatch(batch.ids, { revertInsertion: { streaming } })
      store.setSelectedObjectId(batch.selectedBefore)
    },
  }
}
