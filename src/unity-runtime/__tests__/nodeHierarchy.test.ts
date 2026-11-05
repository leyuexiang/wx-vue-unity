import { describe, expect, it } from 'vitest'
import { buildSceneNodeIndex } from '@/scene-platform/core/sceneNodeIndex'

describe('节点父子索引', () => {
  it('线性构建乱序父子关系并按稳定编号打破顺序同值', () => {
    const index = buildSceneNodeIndex([{ id: 'b', parentInstanceId: 'root', order: 0 }, { id: 'root', order: 0 }, { id: 'a', parentInstanceId: 'root', order: 0 }])
    expect(index.childrenByParent.get('root')).toEqual(['a', 'b'])
    expect(index.parentById.get('a')).toBe('root')
  })
  it.each([
    [{ id: 'a' }, { id: 'a' }],
    [{ id: 'a', parentInstanceId: 'missing' }],
    [{ id: 'a', parentInstanceId: 'b' }, { id: 'b', parentInstanceId: 'a' }],
  ])('拒绝重复、孤儿或循环', (...nodes) => {
    expect(() => buildSceneNodeIndex(nodes)).toThrow()
  })
  it('深链使用迭代校验，不递归爆栈', () => {
    const nodes = Array.from({ length: 20000 }, (_, i) => ({ id: String(i), ...(i ? { parentInstanceId: String(i - 1) } : {}) }))
    expect(buildSceneNodeIndex(nodes).nodesById.size).toBe(20000)
  })
})
