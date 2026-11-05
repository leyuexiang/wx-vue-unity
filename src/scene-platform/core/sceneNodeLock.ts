import type { SceneNodeIndex } from './sceneNodeIndexCache'
import type { SceneLayer, SceneObject } from './types'
import { createSceneNodeWorkQueue, SceneNodeWorkFlag, type SceneNodeWorkQueue } from './sceneNodeWorkQueue'

type LockNode = Pick<SceneObject, 'id' | 'parentInstanceId' | 'layerId' | 'locked'>
export interface SceneNodeLockState {
  readonly ownLocked: boolean
  readonly inheritedLocked: boolean
  readonly effectiveLocked: boolean
}

/** 锁定派生独立失效；图层成员沿用已有会话索引，不复制业务节点或另建成员集合。 */
export function createSceneNodeLockCache(
  readIndex: () => SceneNodeIndex<LockNode>, readLayers: () => readonly SceneLayer[],
  readMembers: (layerId: string) => ReadonlySet<string>,
  sharedWork?: SceneNodeWorkQueue,
) {
  const states = new Map<string, SceneNodeLockState>()
  const layers = new Map<string, boolean>()
  const work = sharedWork ?? createSceneNodeWorkQueue(readIndex, readMembers)
  work.subscribe(SceneNodeWorkFlag.Lock, (id) => { states.delete(id) })
  const chain: LockNode[] = []
  let initialized = false

  const invalidate = (id: string) => {
    states.delete(id)
    if (states.size) work.mark(id, SceneNodeWorkFlag.Lock)
  }

  return {
    get: (id: string): SceneNodeLockState | null => {
      const index = readIndex()
      if (!initialized) {
        for (const layer of readLayers()) layers.set(layer.id, layer.locked)
        initialized = true
      }
      work.flush(index)
      if (!index.nodesById.has(id)) return null
      const cached = states.get(id)
      if (cached) return cached
      let cursor = id
      while (cursor && !states.has(cursor)) {
        const node = index.nodesById.get(cursor)!
        chain.push(node)
        cursor = node.parentInstanceId ?? ''
      }
      let parentLocked = states.get(cursor)?.effectiveLocked ?? false
      // 索引已校验无环，显式父链栈支持深树并复用公共祖先结果。
      for (let i = chain.length - 1; i >= 0; i--) {
        const node = chain[i]!
        const inheritedLocked = parentLocked || (node.layerId !== undefined && layers.get(node.layerId) === true)
        const ownLocked = node.locked
        const state = { ownLocked, inheritedLocked, effectiveLocked: ownLocked || inheritedLocked }
        states.set(node.id, state)
        parentLocked = state.effectiveLocked
      }
      chain.length = 0
      return states.get(id)!
    },
    upsert: (previous: LockNode | undefined, current: LockNode) => {
      const changed = !previous || previous.locked !== current.locked ||
        previous.parentInstanceId !== current.parentInstanceId || previous.layerId !== current.layerId
      if (initialized && changed) invalidate(current.id)
      return changed
    },
    remove: (id: string) => { if (initialized) invalidate(id) },
    upsertLayer: (previous: SceneLayer | undefined, current: SceneLayer) => {
      const changed = (previous?.locked ?? false) !== current.locked
      if (initialized) {
        layers.set(current.id, current.locked)
        if (changed && states.size) work.markLayer(current.id, SceneNodeWorkFlag.Lock)
      }
      return changed
    },
    removeLayer: (id: string) => {
      if (!initialized) return
      if (layers.get(id) === true && states.size) work.markLayer(id, SceneNodeWorkFlag.Lock)
      layers.delete(id)
    },
    clear: () => {
      states.clear()
      layers.clear()
      work.clear(SceneNodeWorkFlag.Lock)
      chain.length = 0
      initialized = false
    },
  }
}
