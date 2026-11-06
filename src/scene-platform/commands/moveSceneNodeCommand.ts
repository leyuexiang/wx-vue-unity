import type { SceneObject } from '../core/types'
import { createSceneRelativeTransform } from '../core/sceneNodeTransforms'
import type { SceneNodePatch, SceneStore } from '../store/sceneStore'
import type { SceneCommand } from './types'

type Local = Extract<SceneObject['transform'], { kind: 'local' }>

export const isLocalHierarchyNode = (node: SceneObject) =>
  node.transform.kind === 'local' && (node.type === 'model' || node.type === 'primitive' || node.type === 'group')

/** 选中祖先时，后代随子树移动。缓存途经父链，避免重复向根查询。 */
export function getSceneNodeMoveRoots(selected: ReadonlySet<string>, parentById: ReadonlyMap<string, string>) {
  const covered = new Map<string, boolean>()
  return [...selected].filter((id) => {
    const path: string[] = []
    let parent = parentById.get(id)!
    while (parent && !selected.has(parent) && !covered.has(parent)) {
      path.push(parent)
      parent = parentById.get(parent)!
    }
    const hasSelectedAncestor = selected.has(parent) || covered.get(parent) === true
    for (const ancestor of path) covered.set(ancestor, hasSelectedAncestor)
    return !hasSelectedAncestor
  })
}

const nodePatch = ({ id, parentInstanceId, order, transform }: SceneObject): SceneNodePatch =>
  ({ id, parentInstanceId, order, transform })

/** 单节点排序和换父级沿用同一批处理规则。 */
export function createMoveSceneNodeCommand(
  store: SceneStore,
  id: string,
  parentId: string | undefined,
  siblingIndex?: number,
): SceneCommand | undefined {
  return createMoveSceneNodesCommand(store, [id], parentId, siblingIndex)
}

/** 先计算全部局部姿态和受影响同级顺序，再一次写入完整草稿。 */
export function createMoveSceneNodesCommand(
  store: SceneStore,
  ids: readonly string[],
  parentId: string | undefined,
  siblingIndex?: number,
): SceneCommand | undefined {
  if (!ids.length) return
  if (store.getScene().type !== 'local3d') throw new Error('地理场景暂不支持调整节点层级')
  // 节点变换查询共享会话索引；独立保存和运行投影仍各自校验完整快照。
  const { nodesById, parentById, childrenByParent } = store.getNodeIndex()
  const selected = new Set(ids)
  const parent = parentId ? nodesById.get(parentId) : undefined
  if (parentId !== undefined && (!parent || !isLocalHierarchyNode(parent))) {
    throw new Error('目标节点类型不支持调整层级')
  }
  for (const id of selected) {
    if (!nodesById.has(id)) throw new Error(`待移动节点已不存在：${id}`)
  }
  const rootIds = new Set(getSceneNodeMoveRoots(selected, parentById))
  // 跨父级移动使用当前草稿顺序，避免按点击先后改变同一批节点的排列。
  const roots = store.getObjects().filter((node) => rootIds.has(node.id))
  if (siblingIndex !== undefined) {
    if (!Number.isInteger(siblingIndex)) throw new Error('无效的同级顺序')
    // 根级顺序按对象图层维护，单个插入下标必须指向同一组同级节点。
    if (!parentId && roots.some((node) => node.layerId !== roots[0]?.layerId)) {
      throw new Error('根级排序需要节点属于同一图层')
    }
  }
  const assertMovePermissions = (active: SceneStore) => {
    const current = active.getNodeIndex()
    for (const node of roots) {
      const source = current.nodesById.get(node.id)
      if (!source || !isLocalHierarchyNode(source)) throw new Error('当前节点不存在或类型不支持调整层级')
      if (active.isObjectEffectivelyLocked(node.id)) throw new Error('节点或其祖先已锁定')
    }
    if (parentId !== undefined) {
      const target = current.nodesById.get(parentId)
      if (!target || !isLocalHierarchyNode(target)) throw new Error('目标节点类型不支持调整层级')
      if (active.isObjectEffectivelyLocked(parentId)) throw new Error('目标节点或其祖先已锁定')
    }
    for (let cursor = parentId; cursor; cursor = current.parentById.get(cursor)) {
      if (rootIds.has(cursor)) throw new Error('不能移动到自身或后代下')
    }
  }
  assertMovePermissions(store)
  const movers = roots.filter((node) => node.parentInstanceId !== parentId || siblingIndex !== undefined)
  if (!movers.length) return

  type Siblings = { parentId: string | undefined; current: readonly string[]; added: string[] }
  const rootLayerIds = new Map<SceneObject['layerId'], string[]>()
  for (const id of childrenByParent.get('') ?? []) {
    const layerId = nodesById.get(id)!.layerId
    const group = rootLayerIds.get(layerId)
    if (group) group.push(id)
    else rootLayerIds.set(layerId, [id])
  }
  const affected = new Map<string, Siblings>()
  const getSiblings = (parentId: string | undefined, layerId: SceneObject['layerId']) => {
    const key = parentId === undefined ? `layer:${layerId ?? ''}` : `parent:${parentId}`
    let group = affected.get(key)
    if (!group) {
      const current = (parentId === undefined ? rootLayerIds.get(layerId) : childrenByParent.get(parentId)) ?? []
      group = { parentId, current, added: [] }
      affected.set(key, group)
    }
    return group
  }
  for (const node of movers) {
    getSiblings(node.parentInstanceId, node.layerId)
    getSiblings(parentId, node.layerId).added.push(node.id)
  }

  const movingIds = new Set(movers.map((node) => node.id))
  const changedParents = movers.filter((node) => node.parentInstanceId !== parentId)
  const transforms = new Map<string, Local>()
  if (changedParents.length) {
    // 公共父链由存储缓存，整批只计算一次目标逆矩阵。
    const toLocal = createSceneRelativeTransform(store.getObjectWorldMatrix(parentId))
    for (const node of changedParents) transforms.set(node.id, toLocal(store.getObjectWorldMatrix(node.id)))
  }

  const before: SceneNodePatch[] = []
  const after: SceneNodePatch[] = []
  for (const group of affected.values()) {
    const next = group.current.filter((id) => !movingIds.has(id))
    const slot = siblingIndex === undefined ? next.length : Math.max(0, Math.min(next.length, siblingIndex))
    // 拼接数组避免极宽树把全部节点作为函数参数传入。
    const ordered = next.slice(0, slot).concat(group.added, next.slice(slot))
    if (ordered.length === group.current.length && ordered.every((id, i) => id === group.current[i])) continue
    ordered.forEach((id, order) => {
      const node = nodesById.get(id)!
      // 受影响同级集合一起保存，避免旧存档的稀疏编号和新顺序冲突。
      before.push(nodePatch(node))
      after.push({ id, parentInstanceId: group.parentId, order, transform: transforms.get(id) ?? node.transform })
    })
  }
  if (!after.length) return
  const affectedIds = new Set(after.map((patch) => patch.id))
  return {
    name: changedParents.length ? '更换节点父级' : '调整节点顺序',
    execute: (active) => {
      // 准备命令后可能发生其他来源更新，执行和重做均复核当前源/目标父链。
      assertMovePermissions(active)
      active.applyObjectHierarchy(after)
    },
    undo: (active) => active.applyObjectHierarchy(before),
    captureRollback: () => {
      // 运行端拒绝时精确恢复当时的字段和保存标记。正常撤销仍应登记需要保存的节点。
      const patches = store.getObjects().filter((node) => affectedIds.has(node.id)).map(nodePatch)
      const edited = store.getHierarchyEditedIds()
      return () => store.applyObjectHierarchy(patches, edited)
    },
  }
}
