import type { SceneNodeIndex } from './sceneNodeIndexCache'
import type { SceneLayer, SceneObject } from './types'
import { createSceneNodeWorkQueue, SceneNodeWorkFlag, type SceneNodeWorkQueue } from './sceneNodeWorkQueue'

type VisibilityNode = Pick<SceneObject, 'id' | 'parentInstanceId' | 'layerId' | 'visible'>
export interface SceneNodeVisibilityState {
  readonly ownVisible: boolean
  readonly inheritedVisible: boolean
  readonly effectiveVisible: boolean
}
const emptyMembers: ReadonlySet<string> = new Set()

/**
 * 派生显隐不回写草稿；父链与自身图层分别参与最终状态。
 * 存储在对象/图层写入时通知，重载和同步回滚时清理；成员反向索引避免每次切图层扫描整场景。
 */
export function createSceneNodeVisibilityCache(
  readIndex: () => SceneNodeIndex<VisibilityNode>, readLayers: () => readonly SceneLayer[],
  sharedWork?: SceneNodeWorkQueue,
) {
  const states = new Map<string, SceneNodeVisibilityState>()
  const members = new Map<string, Set<string>>()
  const layers = new Map<string, boolean>()
  const work = sharedWork ?? createSceneNodeWorkQueue(readIndex, (id) => members.get(id) ?? emptyMembers)
  work.subscribe(SceneNodeWorkFlag.Visibility, (id) => { states.delete(id) })
  const chain: VisibilityNode[] = []
  let initialized = false

  const addMember = (node: VisibilityNode) => {
    if (!node.layerId) return
    let ids = members.get(node.layerId)
    if (!ids) members.set(node.layerId, ids = new Set())
    ids.add(node.id)
  }
  const removeMember = (node: VisibilityNode) => {
    if (!node.layerId) return
    const ids = members.get(node.layerId)
    ids?.delete(node.id)
    if (!ids?.size) members.delete(node.layerId)
  }
  const initialize = (index: SceneNodeIndex<VisibilityNode>) => {
    if (initialized) return
    for (const node of index.nodesById.values()) addMember(node)
    for (const layer of readLayers()) layers.set(layer.id, layer.visible)
    initialized = true
  }
  const invalidate = (id: string) => {
    states.delete(id)
    if (states.size) work.mark(id, SceneNodeWorkFlag.Visibility)
  }

  return {
    get: (id: string): SceneNodeVisibilityState | null => {
      const index = readIndex()
      initialize(index)
      work.flush(index)
      if (!index.nodesById.has(id)) return null
      const cached = states.get(id)
      if (cached) return cached
      let cursor = id
      while (cursor && !states.has(cursor)) {
        // 读取的是已校验无环的逻辑索引，深链不使用递归。
        const node = index.nodesById.get(cursor)!
        chain.push(node)
        cursor = node.parentInstanceId ?? ''
      }
      let parentVisible = states.get(cursor)?.effectiveVisible ?? true
      for (let i = chain.length - 1; i >= 0; i--) {
        const node = chain[i]!
        const inheritedVisible = parentVisible && (!node.layerId || layers.get(node.layerId) !== false)
        const ownVisible = node.visible
        const state = { ownVisible, inheritedVisible, effectiveVisible: ownVisible && inheritedVisible }
        states.set(node.id, state)
        parentVisible = state.effectiveVisible
      }
      chain.length = 0
      return states.get(id)!
    },
    getMembers: (layerId: string): ReadonlySet<string> => {
      initialize(readIndex())
      return members.get(layerId) ?? emptyMembers
    },
    upsert: (previous: VisibilityNode | undefined, current: VisibilityNode) => {
      const changed = !previous || previous.visible !== current.visible ||
        previous.parentInstanceId !== current.parentInstanceId || previous.layerId !== current.layerId
      if (initialized && changed) {
        if (previous) removeMember(previous)
        addMember(current)
        invalidate(current.id)
      }
      return changed
    },
    remove: (node: VisibilityNode) => {
      if (!initialized) return
      removeMember(node)
      invalidate(node.id)
    },
    upsertLayer: (previous: SceneLayer | undefined, current: SceneLayer) => {
      const changed = (previous?.visible ?? true) !== current.visible
      if (initialized) {
        layers.set(current.id, current.visible)
        if (changed && states.size) work.markLayer(current.id, SceneNodeWorkFlag.Visibility)
      }
      return changed
    },
    removeLayer: (id: string) => {
      if (!initialized) return
      if (layers.get(id) === false && states.size) work.markLayer(id, SceneNodeWorkFlag.Visibility)
      layers.delete(id)
    },
    clear: () => {
      states.clear()
      members.clear()
      layers.clear()
      work.clear(SceneNodeWorkFlag.Visibility)
      chain.length = 0
      initialized = false
    },
  }
}
