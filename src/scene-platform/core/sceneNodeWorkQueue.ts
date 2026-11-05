import type { SceneNodeIndex } from './sceneNodeIndexCache'
import type { SceneNodeRecord } from './sceneNodeIndex'

/** 每种标记代表一类派生缓存，按位合并后保留各自独立失效语义。 */
export const SceneNodeWorkFlag = { Transform: 1, Visibility: 2, Lock: 4 } as const
const allFlags = 7
const emptyMembers: ReadonlySet<string> = new Set()
type WorkIndex = SceneNodeIndex<SceneNodeRecord>
type Visitor = (id: string, flags: number) => void
export interface SceneNodeWorkStats {
  batches: number
  visitedNodes: number
  transformNodes: number
  visibilityNodes: number
  lockNodes: number
  lastRoots: number
  lastVisitedNodes: number
  failures: number
}
export interface SceneNodeWorkQueue {
  mark: (id: string, flags: number) => void
  markLayer: (id: string, flags: number) => void
  hasPending: () => boolean
  subscribe: (flags: number, visitor: Visitor) => () => void
  flush: (index?: WorkIndex, visitor?: Visitor) => number
  clear: (flags?: number) => void
  getStats: () => SceneNodeWorkStats
}

/**
 * 会话内复用的确定性子树工作集合。输入必须是已经校验无环的逻辑索引。
 * 先找最上层变更根，再父先子后遍历；后代补充的类型与祖先类型一起传播。
 */
export function createSceneNodeWorkQueue(
  readIndex: () => WorkIndex, readMembers: (id: string) => ReadonlySet<string> = () => emptyMembers,
): SceneNodeWorkQueue {
  const roots = new Map<string, number>()
  const layers = new Map<string, number>()
  const active = new Map<string, number>()
  const topRoots = new Set<string>()
  const ancestorRoots = new Map<string, string | undefined>()
  const path: string[] = []
  const workIds: string[] = []
  const workFlags: number[] = []
  const subscribers = new Set<{ flags: number; visitor: Visitor }>()
  let flushing = false
  const stats: SceneNodeWorkStats = { batches: 0, visitedNodes: 0, transformNodes: 0, visibilityNodes: 0,
    lockNodes: 0, lastRoots: 0, lastVisitedNodes: 0, failures: 0 }
  const merge = (map: Map<string, number>, id: string, flags: number) => {
    flags &= allFlags
    if (flags) map.set(id, (map.get(id) ?? 0) | flags)
  }
  const clearMask = (map: Map<string, number>, flags: number) => {
    for (const [id, previous] of map) {
      const next = previous & ~flags
      if (next) map.set(id, next)
      else map.delete(id)
    }
  }

  return {
    mark: (id, flags) => merge(roots, id, flags),
    markLayer: (id, flags) => merge(layers, id, flags),
    hasPending: () => roots.size > 0 || layers.size > 0,
    subscribe: (flags, visitor) => {
      const entry = { flags, visitor }
      subscribers.add(entry)
      return () => { subscribers.delete(entry) }
    },
    flush: (providedIndex, visitor) => {
      if (flushing) throw new Error('派生工作批次不能重入')
      // 空闲路径不访问索引、不分配集合，也不覆盖上次实际批次的统计。
      if (!roots.size && !layers.size) return 0
      flushing = true
      try {
        const index = providedIndex ?? readIndex()
        for (const [id, flags] of layers) {
          for (const member of readMembers(id)) merge(roots, member, flags)
        }
        layers.clear()
        for (const [id, flags] of roots) active.set(id, flags)
        roots.clear()
        if (!active.size) return 0

        if (active.size === 1) {
          // 单叶子编辑直接处理自身，不能为去重而反复上溯极深但未变的父链。
          for (const id of active.keys()) topRoots.add(id)
        } else {
          for (const id of active.keys()) {
            path.length = 0
            let cursor = id
            while (cursor && !ancestorRoots.has(cursor)) {
              path.push(cursor)
              cursor = index.parentById.get(cursor) ?? ''
            }
            let top = ancestorRoots.get(cursor)
            // 完成标记共享，深链上多个变更根的筛选只访问父链并集一次。
            for (let i = path.length - 1; i >= 0; i--) {
              const ancestor = path[i]!
              if (top === undefined && active.has(ancestor)) top = ancestor
              ancestorRoots.set(ancestor, top)
            }
            topRoots.add(ancestorRoots.get(id) ?? id)
          }
        }

        for (const id of topRoots) { workIds.push(id); workFlags.push(0) }
        let visited = 0, transforms = 0, visibility = 0, locks = 0
        while (workIds.length) {
          const id = workIds.pop()!
          const flags = workFlags.pop()! | (active.get(id) ?? 0)
          for (const entry of subscribers) {
            if (entry.flags & flags) entry.visitor(id, flags & entry.flags)
          }
          visitor?.(id, flags)
          visited++
          if (flags & SceneNodeWorkFlag.Transform) transforms++
          if (flags & SceneNodeWorkFlag.Visibility) visibility++
          if (flags & SceneNodeWorkFlag.Lock) locks++
          const children = index.childrenByParent.get(id)
          if (!children) continue
          for (let i = children.length - 1; i >= 0; i--) {
            workIds.push(children[i]!); workFlags.push(flags)
          }
        }
        stats.batches++
        stats.visitedNodes += visited
        stats.transformNodes += transforms
        stats.visibilityNodes += visibility
        stats.lockNodes += locks
        stats.lastRoots = topRoots.size
        stats.lastVisitedNodes = visited
        return visited
      } catch (error) {
        // 缓存删除是幂等操作；失败后保留整批，修复索引/处理器后可安全重试。
        for (const [id, flags] of active) merge(roots, id, flags)
        stats.failures++
        throw error
      } finally {
        active.clear()
        topRoots.clear()
        ancestorRoots.clear()
        path.length = 0
        workIds.length = 0
        workFlags.length = 0
        flushing = false
      }
    },
    clear: (flags) => {
      if (flushing) throw new Error('派生工作批次处理中不能清理')
      if (flags !== undefined) { clearMask(roots, flags); clearMask(layers, flags); return }
      roots.clear(); layers.clear()
      stats.batches = stats.visitedNodes = stats.transformNodes = stats.visibilityNodes = stats.lockNodes = 0
      stats.lastRoots = stats.lastVisitedNodes = stats.failures = 0
    },
    getStats: () => ({ ...stats }),
  }
}
