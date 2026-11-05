import type { SceneStore } from '../store/sceneStore'

/** 从完整草稿收集后代，共享锁定检查结果，避免深树和重叠选择重复遍历。 */
export function collectEditableSceneSubtrees(store: SceneStore, requested: readonly string[], action: '删除' | '复制') {
  // 复用存储拥有的索引，连续子树命令不再反复扫描并排序完整场景。
  const { nodesById, childrenByParent } = store.getNodeIndex()
  const ids = new Set<string>()
  const pending = [...requested]
  for (let index = 0; index < pending.length; index++) {
    const id = pending[index]!
    if (ids.has(id)) continue
    if (!nodesById.has(id)) throw new Error(`待${action}节点已不存在：${id}`)
    // 父链结果由统一查询缓存，复制和删除不再维护另一套锁定规则。
    if (store.isObjectEffectivelyLocked(id)) {
      throw new Error(`节点「${nodesById.get(id)!.name}」已锁定，无法${action}所选节点`)
    }
    ids.add(id)
    for (const child of childrenByParent.get(id) ?? []) pending.push(child)
  }
  return { ids, nodesById }
}
