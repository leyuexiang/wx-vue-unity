import {
  assertSceneNodeRecord, buildSceneNodeIndex, compareSceneNodeOrder, type SceneNodeRecord,
} from './sceneNodeIndex'

/** 会话内的只读实时视图；持有者不得把映射当作撤销快照或跨会话保存。 */
export interface SceneNodeIndex<T extends SceneNodeRecord> {
  readonly nodesById: ReadonlyMap<string, T>
  readonly parentById: ReadonlyMap<string, string>
  readonly childrenByParent: ReadonlyMap<string, readonly string[]>
  readonly structureVersion: number
}

/**
 * 按需构建一次，后续只更新变更记录与受影响父级。
 * 写入先合并，读取时校验最终批次，允许父子新增/删除以任意顺序进入同一事务。
 * 缓存由场景存储直接拥有，不新增全局引用或事件订阅。
 */
export function createSceneNodeIndexCache<T extends SceneNodeRecord>(readNodes: () => readonly T[]) {
  let maps: ReturnType<typeof buildSceneNodeIndex<T>> | undefined
  let view: SceneNodeIndex<T> | undefined
  let version = 0
  let viewVersion: { value: number } | undefined
  const pending = new Map<string, T | null>()

  const flush = () => {
    if (!maps || !pending.size) return
    const { nodesById, parentById, childrenByParent } = maps
    const read = (id: string) => pending.has(id) ? pending.get(id) ?? undefined : nodesById.get(id)
    const changedParents = new Set<string>()
    const touchedParents = new Set<string>()
    const addedByParent = new Map<string, string[]>()

    // 所有校验在修改已提交映射之前完成，拒绝批次不会留下半索引。
    for (const [id, node] of pending) {
      const previous = nodesById.get(id)
      if (node) {
        assertSceneNodeRecord(node)
        if (!previous || previous.parentInstanceId !== node.parentInstanceId) changedParents.add(id)
      } else if (previous) {
        for (const child of childrenByParent.get(id) ?? []) {
          if (read(child)?.parentInstanceId === id) throw new Error(`父实例不存在：${id}`)
        }
      }
      if ((!previous && !node) || (previous && node &&
          previous.parentInstanceId === node.parentInstanceId && previous.order === node.order)) continue
      if (previous) touchedParents.add(previous.parentInstanceId ?? '')
      if (node) {
        const parent = node.parentInstanceId ?? ''
        touchedParents.add(parent)
        // 只补真正新增或换入的成员，纯顺序调整保留原集合成员。
        if (!previous || previous.parentInstanceId !== node.parentInstanceId) {
          const added = addedByParent.get(parent)
          if (added) added.push(id)
          else addedByParent.set(parent, [id])
        }
      }
    }
    const done = new Set<string>()
    const path = new Set<string>()
    for (const id of changedParents) {
      path.clear()
      let cursor = id
      while (cursor && !done.has(cursor)) {
        const node = read(cursor)
        if (!node) throw new Error(`父实例不存在：${cursor}`)
        if (path.has(cursor)) throw new Error('父子关系包含循环')
        path.add(cursor)
        cursor = node.parentInstanceId ?? ''
      }
      for (const ancestor of path) done.add(ancestor)
    }

    for (const [id, node] of pending) {
      if (node) {
        nodesById.set(id, node)
        parentById.set(id, node.parentInstanceId ?? '')
      } else {
        nodesById.delete(id)
        parentById.delete(id)
      }
    }
    for (const parent of touchedParents) {
      const children = (childrenByParent.get(parent) ?? []).filter((id) =>
        nodesById.has(id) && parentById.get(id) === parent)
      for (const id of addedByParent.get(parent) ?? []) children.push(id)
      if (children.length) {
        children.sort((a, b) => compareSceneNodeOrder(nodesById.get(a)!, nodesById.get(b)!))
        childrenByParent.set(parent, children)
      } else childrenByParent.delete(parent)
    }
    if (touchedParents.size) viewVersion!.value = ++version
    pending.clear()
  }

  return {
    get: (): SceneNodeIndex<T> => {
      if (!maps) {
        maps = buildSceneNodeIndex(readNodes())
        const createdVersion = { value: ++version }
        viewVersion = createdVersion
        view = { ...maps, get structureVersion() { return createdVersion.value } }
      }
      flush()
      return view!
    },
    upsert: (node: T) => {
      if (!maps) return
      const previous = maps.nodesById.get(node.id)
      if (!pending.has(node.id) && previous && previous.parentInstanceId === node.parentInstanceId && previous.order === node.order) {
        // 改名、操控器变换等高频写入只替换记录，不分配结构工作集合。
        maps.nodesById.set(node.id, node)
        return
      }
      pending.set(node.id, node)
    },
    remove: (id: string) => { if (maps) pending.set(id, null) },
    clear: () => {
      // 重载与回滚后数据对象引用已替换，下一次读取从当前完整草稿重建。
      maps = undefined
      view = undefined
      viewVersion = undefined
      pending.clear()
    },
  }
}
