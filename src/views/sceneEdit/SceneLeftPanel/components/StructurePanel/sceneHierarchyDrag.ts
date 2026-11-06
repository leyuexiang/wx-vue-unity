import type { SceneStore } from '@/scene-platform'
import { getSceneNodeMoveRoots, isLocalHierarchyNode } from '@/scene-platform/commands/moveSceneNodeCommand'

type Placement = 'before' | 'inside' | 'after'
export type SceneHierarchyDropTarget = { kind: 'root' } | { kind: 'node'; id: string; placement: Placement }

export const SCENE_HIERARCHY_DRAG_TYPE = 'application/x-jtyf-scene-hierarchy'

/** 节点行的上下四分之一用于排序，中央用于换父级。 */
export function getSceneHierarchyDropPlacement(clientY: number, rect: Pick<DOMRect, 'top' | 'height'>): Placement {
  const ratio = (clientY - rect.top) / rect.height
  if (ratio <= 0.25) return 'before'
  if (ratio >= 0.75) return 'after'
  return 'inside'
}

/** 以真实业务索引验证拖放。排序下标来自移除本批根节点后的完整同级集合。 */
export function resolveSceneHierarchyDrop(
  store: SceneStore,
  ids: readonly string[],
  target: SceneHierarchyDropTarget,
): { parentId?: string; siblingIndex?: number } {
  const index = store.getNodeIndex()
  const selected = new Set(ids)
  if (store.getScene().type !== 'local3d' || !selected.size) throw new Error('当前场景不支持拖动节点')
  for (const id of selected) {
    if (!index.nodesById.has(id)) throw new Error('待移动节点已不存在')
  }
  const roots = new Set(getSceneNodeMoveRoots(selected, index.parentById))
  for (const id of roots) {
    if (!isLocalHierarchyNode(index.nodesById.get(id)!)) throw new Error('待移动节点类型不支持拖动')
    if (store.isObjectEffectivelyLocked(id)) throw new Error('待移动节点受锁定限制')
  }
  if (target.kind === 'root') return {}

  const anchor = index.nodesById.get(target.id)
  if (!anchor || selected.has(target.id)) throw new Error('不能拖到所选节点上')
  const inside = target.placement === 'inside'
  const parentId = inside ? anchor.id : anchor.parentInstanceId
  if (parentId) {
    const parent = index.nodesById.get(parentId)
    if (!parent || !isLocalHierarchyNode(parent)) throw new Error('目标父级类型不支持拖动')
    if (store.isObjectEffectivelyLocked(parentId)) throw new Error('目标父级受锁定限制')
  }
  for (let id: string | undefined = target.id; id; id = index.parentById.get(id)) {
    if (roots.has(id)) throw new Error('不能拖到自身或后代上')
  }
  if (inside) return { parentId }

  if (!parentId && [...roots].some((id) => index.nodesById.get(id)?.layerId !== anchor.layerId)) {
    throw new Error('根级排序仅限同一图层')
  }
  let siblingIndex = 0
  for (const id of index.childrenByParent.get(parentId ?? '') ?? []) {
    if (id === anchor.id) return { parentId, siblingIndex: siblingIndex + (target.placement === 'after' ? 1 : 0) }
    if (!roots.has(id) && (parentId || index.nodesById.get(id)?.layerId === anchor.layerId)) siblingIndex++
  }
  throw new Error('排序目标已不存在')
}
