import type { SceneStore } from '../store/sceneStore'
import type { RemovedSceneObject } from '../store/sceneStore'
import type { SceneObject } from '../core/types'

/** 对象字段回放的补偿直接恢复当时记录，不重新执行受锁定约束的新编辑。 */
export function captureSceneObjectUpdateRollback(store: SceneStore, id: string) {
  const before = store.getNodeIndex().nodesById.get(id)
  return () => { if (before) store.upsertObject(before) }
}

/**
 * 成员变更只捕获相关记录/原数组位置与区块引用，不再复制整场景。
 * 补偿使用底层恢复入口，原选择及显式编辑范围仍由确认事务统一恢复。
 */
export function captureSceneObjectMembershipRollback(store: SceneStore, ids: ReadonlySet<string>,
  related: readonly Pick<SceneObject, 'parentInstanceId' | 'layerId'>[] = []) {
  const scope = (node: Pick<SceneObject, 'parentInstanceId' | 'layerId'>) =>
    node.parentInstanceId ? 'parent:' + node.parentInstanceId : 'layer:' + (node.layerId ?? '')
  const scopes = new Set(related.map(scope))
  const nodes = store.getNodeIndex().nodesById
  for (const id of ids) {
    const node = nodes.get(id)
    if (node) scopes.add(scope(node))
  }
  const entries: RemovedSceneObject[] = []
  const beforeIds = new Set<string>()
  store.getObjects().forEach((object, index) => {
    if (ids.has(object.id)) beforeIds.add(object.id)
    // 创建/删除可能隐式重编号兄弟，补偿同时保留这些记录的原始顺序。
    if (ids.has(object.id) || scopes.has(scope(object))) entries.push({ removed: object, index })
  })
  const beforeDeleted = store.getDeletedObjectIds()
  const streaming = store.getScene().streaming
  return () => {
    const current = store.getNodeIndex().nodesById
    const added = new Set<string>()
    const deleted = new Set<string>()
    for (const id of ids) {
      if (beforeIds.has(id) || !current.has(id)) continue
      if (beforeDeleted.has(id)) deleted.add(id)
      else added.add(id)
    }
    if (deleted.size) store.removeObjectBatch(deleted)
    if (added.size) store.removeObjectBatch(added, { revertInsertion: { streaming } })
    if (entries.length) store.restoreObjectBatch(entries, streaming, { replaceExisting: true })
    if (store.getScene().streaming !== streaming) store.updateSceneStreaming(streaming, 'membership')
  }
}
