/** 只索引逻辑记录，不复制业务载荷，不依赖运行端对象。 */
export interface SceneNodeRecord { id: string; parentInstanceId?: string; order?: number }
/** 全量校验与增量校验共用字段约束，避免两条路径接受不同的节点合同。 */
export function assertSceneNodeRecord(node: SceneNodeRecord) {
  if (typeof node.id !== 'string' || !node.id.trim()) throw new Error('节点编号为空或重复')
  if (node.parentInstanceId !== undefined && (typeof node.parentInstanceId !== 'string' || !node.parentInstanceId.trim())) {
    throw new Error('父实例编号必须为非空字符串')
  }
  // 顺序在播放器和服务端都使用有符号32位整数。
  if (node.order !== undefined && (!Number.isInteger(node.order) || node.order < 0 || node.order > 2147483647)) {
    throw new Error('节点顺序必须是有效的非负整数')
  }
}

/** 同序时按编号的序数排序，避免不同语言或地区环境产生不同兄弟顺序。 */
export const compareSceneNodeOrder = (a: SceneNodeRecord, b: SceneNodeRecord) =>
  ((a.order ?? 0) - (b.order ?? 0)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

export function buildSceneNodeIndex<T extends SceneNodeRecord>(nodes: readonly T[]) {
  const nodesById = new Map<string, T>()
  const parentById = new Map<string, string>()
  const childrenByParent = new Map<string, string[]>()
  for (const node of nodes) {
    assertSceneNodeRecord(node)
    if (nodesById.has(node.id)) throw new Error('节点编号为空或重复')
    nodesById.set(node.id, node)
    const parent = node.parentInstanceId ?? ''
    parentById.set(node.id, parent)
    const children = childrenByParent.get(parent)
    if (children) children.push(node.id)
    else childrenByParent.set(parent, [node.id])
  }
  // 完成标记跨父链复用，每个节点最多进入一次路径，避免深链平方遍历。
  const done = new Set<string>()
  const path = new Set<string>()
  for (const node of nodes) {
    path.clear()
    let cursor = node.id
    while (cursor && !done.has(cursor)) {
      if (!nodesById.has(cursor)) throw new Error(`父实例不存在：${cursor}`)
      if (path.has(cursor)) throw new Error('父子关系包含循环')
      path.add(cursor)
      cursor = parentById.get(cursor)!
    }
    for (const id of path) done.add(id)
  }
  // 结构校验为线性；兄弟排序成本单独按各父级的子节点数量计算。
  for (const children of childrenByParent.values()) children.sort((a, b) =>
    compareSceneNodeOrder(nodesById.get(a)!, nodesById.get(b)!))
  return { nodesById, parentById, childrenByParent }
}
