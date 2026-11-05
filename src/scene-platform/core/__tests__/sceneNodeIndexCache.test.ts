import { describe, expect, it } from 'vitest'
import { buildSceneNodeIndex, type SceneNodeRecord } from '../sceneNodeIndex'
import { createSceneNodeIndexCache } from '../sceneNodeIndexCache'

describe('节点索引的结构与访问基线', () => {
  it.each(['deep', 'wide'] as const)('%s结构一次构建不反复读取业务父链', (shape) => {
    let parentReads = 0
    const nodes = Array.from({ length: 20000 }, (_, i): SceneNodeRecord => ({
      id: String(i).padStart(5, '0'), order: i,
      // 以字段访问次数验证复杂度，避免把设备耗时波动当作算法退化。
      get parentInstanceId() {
        parentReads++
        return i ? String(shape === 'deep' ? i - 1 : 0).padStart(5, '0') : undefined
      },
    }))
    const index = buildSceneNodeIndex(nodes)
    expect(index.nodesById.size).toBe(nodes.length)
    expect(parentReads).toBeLessThanOrEqual(nodes.length * 5)
    expect(index.childrenByParent.get('00000')?.length).toBe(shape === 'deep' ? 1 : 19999)
  })

  it.each([
    [{ id: 'a' }, { id: 'a' }],
    [{ id: 'a', parentInstanceId: 'missing' }],
    [{ id: 'a', parentInstanceId: 'a' }],
    [{ id: 'a', parentInstanceId: 'b' }, { id: 'b', parentInstanceId: 'a' }],
    [{ id: 'a', order: -1 }], [{ id: 'a', order: 2147483648 }],
  ])('拒绝无效结构或顺序 %#', (...nodes) => {
    expect(() => buildSceneNodeIndex(nodes)).toThrow()
  })
})

describe('会话节点索引增量缓存', () => {
  it('重复查询和普通属性变更不再读取完整集合，不替换兄弟集合', () => {
    type Node = SceneNodeRecord & { name?: string }
    const nodes: Node[] = [{ id: 'root' }, { id: 'a', parentInstanceId: 'root' }]
    let reads = 0
    const cache = createSceneNodeIndexCache(() => { reads++; return nodes })
    const first = cache.get()
    const siblings = first.childrenByParent.get('root')
    const version = first.structureVersion
    const renamed = { ...nodes[1]!, name: '改名' }
    nodes[1] = renamed
    cache.upsert(renamed)
    expect(cache.get()).toBe(first)
    expect(first.nodesById.get('a')).toBe(renamed)
    expect(first.childrenByParent.get('root')).toBe(siblings)
    expect(first.structureVersion).toBe(version)
    expect(reads).toBe(1)
  })

  it('换父级、新增、删除和重排只更新受影响兄弟，排序与全量结果一致', () => {
    const nodes: SceneNodeRecord[] = [
      { id: 'r' }, { id: 's' }, { id: 't' },
      { id: 'a', parentInstanceId: 'r' }, { id: 'b', parentInstanceId: 's' },
      { id: 'c', parentInstanceId: 't' },
    ]
    const cache = createSceneNodeIndexCache(() => nodes)
    const index = cache.get()
    const untouched = index.childrenByParent.get('t')
    const version = index.structureVersion
    nodes[3] = { id: 'a', parentInstanceId: 's', order: 2 }
    nodes[4] = { id: 'b', parentInstanceId: 's', order: 2 }
    nodes.push({ id: 'aa', parentInstanceId: 's', order: 2 })
    cache.upsert(nodes[3]!); cache.upsert(nodes[4]!); cache.upsert(nodes[6]!)
    cache.get()
    expect(index.childrenByParent.get('r')).toBeUndefined()
    expect(index.childrenByParent.get('s')).toEqual(['a', 'aa', 'b'])
    expect(index.childrenByParent.get('t')).toBe(untouched)
    expect(index.structureVersion).toBeGreaterThan(version)
    cache.remove('aa')
    nodes.pop()
    cache.get()
    const expected = buildSceneNodeIndex(nodes)
    expect([...index.parentById]).toEqual([...expected.parentById])
    expect(index.childrenByParent).toEqual(expected.childrenByParent)
  })

  it('整批添加允许父节点后到，删除子树允许任意登记顺序', () => {
    const nodes: SceneNodeRecord[] = []
    const cache = createSceneNodeIndexCache(() => nodes)
    cache.get()
    const child = { id: 'child', parentInstanceId: 'parent' }
    const parent = { id: 'parent' }
    nodes.push(child, parent)
    cache.upsert(child); cache.upsert(parent)
    expect(cache.get().parentById.get('child')).toBe('parent')
    cache.remove('parent'); cache.remove('child')
    nodes.length = 0
    expect(cache.get().nodesById.size).toBe(0)
  })

  it('循环或孤儿更新不污染已提交索引，纠正后可以重试', () => {
    const nodes: SceneNodeRecord[] = [{ id: 'r' }, { id: 'a', parentInstanceId: 'r' }]
    const cache = createSceneNodeIndexCache(() => nodes)
    const index = cache.get()
    cache.upsert({ id: 'r', parentInstanceId: 'a' })
    expect(() => cache.get()).toThrow('循环')
    expect(index.parentById.get('r')).toBe('')
    cache.upsert({ id: 'r' })
    cache.remove('r')
    expect(() => cache.get()).toThrow('父实例不存在')
    expect(index.nodesById.has('r')).toBe(true)
    cache.clear()
    expect(cache.get().parentById.get('a')).toBe('r')
  })

  it('清理后重新读取当前快照，不保留旧场景记录', () => {
    let nodes: SceneNodeRecord[] = [{ id: 'old' }]
    const cache = createSceneNodeIndexCache(() => nodes)
    const old = cache.get()
    nodes = [{ id: 'new' }]
    cache.clear()
    const current = cache.get()
    expect(current).not.toBe(old)
    expect(current.nodesById.has('old')).toBe(false)
    expect(current.nodesById.has('new')).toBe(true)
    expect(current.structureVersion).toBeGreaterThan(old.structureVersion)
  })
})
