import { describe, expect, it, vi } from 'vitest'
import { buildSceneNodeIndex } from '../sceneNodeIndex'
import { createSceneNodeWorkQueue, SceneNodeWorkFlag as Flag } from '../sceneNodeWorkQueue'
import { createSceneDefinition } from '../sceneDefinition'
import { createSceneStore } from '../../store/sceneStore'
import type { SceneObject } from '../types'
import { createRuntimeBridge } from '../../runtime/runtimeBridge'
import { MemorySceneRuntime } from '../../runtime/memory/memorySceneRuntime'

const graph = () => ({ ...buildSceneNodeIndex([
  { id: 'r' }, { id: 'a', parentInstanceId: 'r' }, { id: 'b', parentInstanceId: 'a' }, { id: 'other' },
]), structureVersion: 1 })

describe('按类型合并的子树工作队列', () => {
  it.each([false, true])('祖先与后代标记合并，一次遍历保留后代类型，倒序登记=%s', (reverse) => {
    const index = graph()
    const queue = createSceneNodeWorkQueue(() => index)
    const children = vi.spyOn(index.childrenByParent, 'get')
    const calls: Array<[string, number]> = []
    const roots = [['r', Flag.Visibility], ['a', Flag.Transform], ['a', Flag.Lock]] as const
    for (const [id, mask] of reverse ? [...roots].reverse() : roots) queue.mark(id, mask)
    expect(queue.flush(index, (id, mask) => calls.push([id, mask]))).toBe(3)
    expect(calls).toEqual([['r', Flag.Visibility], ['a', 7], ['b', 7]])
    expect(children).toHaveBeenCalledTimes(3)
    expect(queue.getStats()).toMatchObject({ batches: 1, visitedNodes: 3, transformNodes: 2, visibilityNodes: 3, lockNodes: 2, lastRoots: 1 })
  })

  it('重复登记只处理一次，空闲队列不读取索引或改变统计', () => {
    const read = vi.fn(graph)
    const queue = createSceneNodeWorkQueue(read)
    expect(queue.flush()).toBe(0)
    expect(read).not.toHaveBeenCalled()
    for (let i = 0; i < 1000; i++) queue.mark('a', Flag.Lock)
    expect(queue.flush()).toBe(2)
    const stats = queue.getStats()
    expect(queue.flush()).toBe(0)
    expect(queue.getStats()).toEqual(stats)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('单叶子变更不遍历祖先，多个深链根的筛选保持线性访问', () => {
    const nodes = Array.from({ length: 20000 }, (_, i) => ({ id: String(i), ...(i ? { parentInstanceId: String(i - 1) } : {}) }))
    const index = { ...buildSceneNodeIndex(nodes), structureVersion: 1 }
    const parents = vi.spyOn(index.parentById, 'get')
    const queue = createSceneNodeWorkQueue(() => index)
    queue.mark('19999', Flag.Transform)
    expect(queue.flush()).toBe(1)
    expect(parents).not.toHaveBeenCalled()
    for (let i = nodes.length - 1; i >= 0; i--) queue.mark(String(i), Flag.Visibility)
    expect(queue.flush()).toBe(20000)
    expect(parents.mock.calls.length).toBeLessThanOrEqual(nodes.length * 2)
    expect(queue.getStats()).toMatchObject({ lastRoots: 1, lastVisitedNodes: 20000 })
  })

  it('图层请求先合并类型，只解析一次成员，再与直接节点请求合并', () => {
    const index = graph()
    const readMembers = vi.fn(() => new Set(['r', 'a']))
    const queue = createSceneNodeWorkQueue(() => index, readMembers)
    queue.markLayer('layer', Flag.Visibility)
    queue.markLayer('layer', Flag.Lock)
    queue.mark('b', Flag.Transform)
    const calls = new Map<string, number>()
    queue.flush(index, (id, mask) => calls.set(id, mask))
    expect(readMembers).toHaveBeenCalledTimes(1)
    expect(calls).toEqual(new Map([['r', 6], ['a', 6], ['b', 7]]))
    expect(queue.getStats()).toMatchObject({ visitedNodes: 3, lastRoots: 1 })
  })

  it('按类型订阅和清理不丢其他类型，新批次请求留待下一次处理', () => {
    const queue = createSceneNodeWorkQueue(graph)
    const transform = vi.fn(), visibility = vi.fn()
    queue.subscribe(Flag.Transform, transform)
    const stop = queue.subscribe(Flag.Visibility, visibility)
    queue.mark('r', Flag.Transform | Flag.Visibility)
    queue.clear(Flag.Transform)
    queue.flush(undefined, (id) => { if (id === 'r') queue.mark('other', Flag.Lock) })
    expect(transform).not.toHaveBeenCalled()
    expect(visibility).toHaveBeenCalledTimes(3)
    expect(queue.hasPending()).toBe(true)
    expect(queue.flush()).toBe(1)
    stop()
    queue.mark('r', Flag.Visibility); queue.flush()
    expect(visibility).toHaveBeenCalledTimes(3)
    queue.mark('r', 7); queue.clear()
    expect(queue.hasPending()).toBe(false)
    expect(queue.getStats()).toMatchObject({ batches: 0, visitedNodes: 0 })
  })

  it('索引或处理失败保留请求，修复后重试不保留临时遍历引用', () => {
    let ready = false, fail = true
    const index = graph()
    const queue = createSceneNodeWorkQueue(() => { if (!ready) throw new Error('索引失败'); return index })
    queue.subscribe(Flag.Visibility, (id) => { if (id === 'a' && fail) throw new Error('处理失败') })
    queue.mark('r', Flag.Visibility)
    expect(() => queue.flush()).toThrow('索引失败')
    expect(queue.hasPending()).toBe(true)
    ready = true
    expect(() => queue.flush()).toThrow('处理失败')
    expect(queue.hasPending()).toBe(true)
    fail = false
    expect(queue.flush()).toBe(3)
    expect(queue.hasPending()).toBe(false)
    expect(queue.getStats()).toMatchObject({ batches: 1, visitedNodes: 3, failures: 2 })
  })
})

const node = (id: string, parentInstanceId?: string): SceneObject => ({
  id, name: id, type: 'group', parentInstanceId, visible: true, locked: false, order: 0,
  transform: { kind: 'local', position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 },
})
const makeStore = () => createSceneStore(createSceneDefinition({
  id: '统一派生', name: '统一派生', type: 'local3d', objects: [node('r'), node('a', 'r'), node('b', 'a'), node('other')],
  coordinateSystem: { kind: 'local', unit: 'meter', upAxis: 'Y', gridEnabled: true },
  layers: [{ id: 'layer', name: '图层', type: 'object', order: 0, visible: true, locked: false }],
}))
const warm = (store: ReturnType<typeof makeStore>) => {
  store.getObjectWorldMatrix('b'); store.getObjectVisibilityState('b'); store.getObjectLockState('b')
  store.getObjectWorldMatrix('other'); store.getObjectVisibilityState('other'); store.getObjectLockState('other')
}

describe('存储派生工作集合与独立桥接批次', () => {
  it('父子三类变更只遍历一次，重复查询与无关节点保持缓存', () => {
    const store = makeStore()
    warm(store)
    const unrelated = store.getObjectWorldMatrix('other')
    const children = vi.spyOn(store.getNodeIndex().childrenByParent, 'get')
    store.runTransaction(() => {
      store.upsertObject({ ...store.getObject('r')!, visible: false, locked: true,
        transform: { kind: 'local', position: [10, 0, 0], rotation: [0, 0, 0], scale: 1 } })
      store.upsertObject({ ...store.getObject('a')!, transform: { kind: 'local', position: [2, 0, 0], rotation: [0, 0, 0], scale: 1 } })
    })
    expect(store.getObjectWorldMatrix('b')[3]).toEqual([12, 0, 0])
    expect(store.getObjectVisibilityState('b')?.effectiveVisible).toBe(false)
    expect(store.getObjectLockState('b')?.effectiveLocked).toBe(true)
    expect(children).toHaveBeenCalledTimes(3)
    expect(store.getObjectWorldMatrix('other')).toBe(unrelated)
    store.getObjectWorldMatrix('b'); store.getObjectVisibilityState('b'); store.getObjectLockState('b')
    expect(children).toHaveBeenCalledTimes(3)
  })

  it('图层显隐和锁定合并一次子树失效，不使世界矩阵重算', () => {
    const store = makeStore()
    store.upsertObject({ ...store.getObject('r')!, layerId: 'layer' })
    warm(store)
    const matrix = store.getObjectWorldMatrix('b')
    const children = vi.spyOn(store.getNodeIndex().childrenByParent, 'get')
    store.upsertLayer({ ...store.getLayer('layer')!, visible: false, locked: true })
    expect(store.getObjectVisibilityState('b')?.effectiveVisible).toBe(false)
    expect(store.getObjectLockState('b')?.effectiveLocked).toBe(true)
    expect(store.getObjectWorldMatrix('b')).toBe(matrix)
    expect(children).toHaveBeenCalledTimes(3)
  })

  it('查询提前消费派生变化，不影响运行桥接同步；失败事务不丢之前已提交的传播', async () => {
    const store = makeStore()
    const runtime = new MemorySceneRuntime('local3d')
    const bridge = createRuntimeBridge(store, runtime)
    bridge.start(); await bridge.flush(); warm(store)
    const upsert = vi.spyOn(runtime, 'upsertObject')
    store.upsertObject({ ...store.getObject('r')!, visible: false, locked: true })
    expect(store.getObjectVisibilityState('b')?.effectiveVisible).toBe(false)
    expect(() => store.runTransaction(() => {
      store.upsertObject({ ...store.getObject('r')!, visible: true, locked: false })
      store.getObjectLockState('b')
      throw new Error('回滚')
    })).toThrow('回滚')
    await bridge.flush()
    expect(upsert.mock.calls.map(([object]) => object.id).sort()).toEqual(['a', 'b', 'r'])
    expect(upsert.mock.calls.every(([object]) => !object.visible && object.locked)).toBe(true)
    bridge.stop()
  })
})
