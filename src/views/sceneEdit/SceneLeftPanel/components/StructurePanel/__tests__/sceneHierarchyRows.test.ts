import { describe, expect, it, vi } from 'vitest'
import { buildSceneNodeIndex } from '@/scene-platform/core/sceneNodeIndex'
import { createSceneNodeIndexCache } from '@/scene-platform/core/sceneNodeIndexCache'
import type { SceneObject } from '@/scene-platform'
import { buildSceneHierarchyLayout, createSceneHierarchySearch, flattenSceneHierarchyRows, resolveSceneHierarchyLocation } from '../sceneHierarchyRows'
import { reconcileStructureSceneSelection } from '../structurePanelSelectionHelpers'

const node = (id: string, parentInstanceId?: string, layerId?: string, order = 0): SceneObject => ({
  id, name: id, type: 'group', parentInstanceId, layerId, order, visible: true, locked: false,
  transform: { kind: 'local', position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 },
})
const asIndex = (nodes: SceneObject[]) => ({ ...buildSceneNodeIndex(nodes), structureVersion: 1 })

describe('结构树可见行', () => {
  it('滚动和层级刷新按业务编号保留多选，视口切换时清理旧批次', () => {
    const selected = new Set(['primary', 'offscreen', 'removed'])
    const sceneIds = new Set(['primary', 'offscreen', 'external'])
    reconcileStructureSceneSelection(selected, 'primary', (id) => sceneIds.has(id))
    expect(selected).toEqual(new Set(['primary', 'offscreen']))
    reconcileStructureSceneSelection(selected, 'external', (id) => sceneIds.has(id))
    expect(selected.size).toBe(0)
  })

  it('跨分类子节点跟随根的页签和显示图层，自己的图层仍可管理', () => {
    const root = node('root', undefined, 'A')
    const child = node('child', 'root', 'B')
    const rootOnDefault = node('default', undefined, '系统默认')
    const missingLayer = node('missing', undefined, '缺失图层')
    const legacy = { id: 'legacy', name: '旧版对象' }
    const layout = buildSceneHierarchyLayout(asIndex([child, root, missingLayer, rootOnDefault]),
      [root, rootOnDefault, missingLayer, legacy], [child], new Set(['A', 'B', '空图层']))
    expect(layout.sections.model.roots.get('A')).toEqual(['root'])
    expect(layout.sections.model.roots.get('')).toEqual(['default', 'missing', 'legacy'])
    expect(layout.sections.model.memberLayers).toEqual(new Set(['A', 'B']))
    expect(layout.sections.model.roots.get('空图层')).toBeUndefined()
    expect(layout.sections.model.count).toBe(5)
    expect(layout.sections['three-dimensional-component'].count).toBe(0)
    expect(flattenSceneHierarchyRows(layout, ['root'], new Set(['root'])).map(({ id, depth }) => [id, depth]))
      .toEqual([['root', 0], ['child', 1]])
    expect(child.layerId).toBe('B')
  })

  it('折叠跳过后代，按索引顺序显示同级，重开保留子节点展开意图', () => {
    const nodes = [node('r'), node('second', 'r', undefined, 2), node('first', 'r', undefined, 1), node('leaf', 'first')]
    const index = asIndex(nodes)
    const layout = buildSceneHierarchyLayout(index, nodes, [], new Set())
    const reads = vi.spyOn(index.childrenByParent, 'get')
    const expanded = new Set(['first'])
    expect(flattenSceneHierarchyRows(layout, ['r'], expanded).map((row) => row.id)).toEqual(['r'])
    expect(reads.mock.calls).toEqual([['r']])
    expanded.add('r')
    expect(flattenSceneHierarchyRows(layout, ['r'], expanded).map(({ id, depth }) => [id, depth]))
      .toEqual([['r', 0], ['first', 1], ['leaf', 2], ['second', 1]])
  })

  it('选中跨分类后代时定位到根的页签和图层，并返回完整祖先路径', () => {
    const root = node('r', undefined, 'A')
    const parent = node('parent', 'r', 'B')
    const leaf = node('leaf', 'parent', 'B')
    const layout = buildSceneHierarchyLayout(asIndex([leaf, parent, root]), [root], [parent, leaf], new Set(['A', 'B']))
    expect(resolveSceneHierarchyLocation(layout, 'leaf')).toEqual({
      category: 'model', ancestors: ['parent', 'r'], layerId: 'A',
    })
    expect(resolveSceneHierarchyLocation(layout, 'removed')).toBeUndefined()
  })

  it('搜索深层子节点时保留祖先并临时展开，清空搜索恢复折叠', () => {
    const nodes = [node('r'), node('a', 'r'), node('needle', 'a'), node('unrelated', 'r')]
    const layout = buildSceneHierarchyLayout(asIndex(nodes), nodes, [], new Set())
    const expanded = new Set<string>()
    const search = createSceneHierarchySearch()
    const matches = search(layout, 'needle')
    expect(matches?.directIds).toEqual(new Set(['needle']))
    expect(flattenSceneHierarchyRows(layout, ['r'], expanded, matches?.pathIds).map((row) => row.id))
      .toEqual(['r', 'a', 'needle'])
    expect(expanded.size).toBe(0)
    expect(search(layout, '')).toBeUndefined()
    expect(flattenSceneHierarchyRows(layout, ['r'], expanded).map((row) => row.id)).toEqual(['r'])
  })

  it('显隐或选中刷新后复用结果，改名和旧版条目变化后重新匹配', () => {
    const root = node('root')
    const child = node('needle', 'root')
    const index = asIndex([root, child])
    const search = createSceneHierarchySearch()
    const layout = (items: { id: string; name: string }[]) =>
      buildSceneHierarchyLayout(index, items, [], new Set())
    const original = search(layout([root, child]), 'needle')
    const updated = { ...child, visible: false }
    expect(search(layout([{ ...root }, updated]), 'needle')).toBe(original)
    expect(search(layout([root, { ...updated, name: 'renamed' }]), 'needle')?.directIds).toEqual(new Set())
    expect(search(layout([root, { id: 'legacy', name: 'NEEDLE' }]), 'needle')?.directIds)
      .toEqual(new Set(['legacy']))
  })

  it('同一实时索引换父级、移除命中或重载后更新搜索路径', () => {
    const nodes = [node('old'), node('new'), node('needle', 'old')]
    const cache = createSceneNodeIndexCache(() => nodes)
    const layout = () => buildSceneHierarchyLayout(cache.get(), nodes, [], new Set())
    const search = createSceneHierarchySearch()
    expect(search(layout(), 'needle')?.pathIds).toEqual(new Set(['needle', 'old']))
    const index = cache.get()
    const moved = node('needle', 'new')
    nodes[2] = moved
    cache.upsert(moved)
    expect(cache.get()).toBe(index)
    const afterMove = search(layout(), 'needle')
    expect(afterMove?.pathIds).toEqual(new Set(['needle', 'new']))
    cache.clear()
    expect(search(layout(), 'needle')).not.toBe(afterMove)
    nodes.pop()
    cache.remove('needle')
    expect(search(layout(), 'needle')?.pathIds).toEqual(new Set())
  })

  it('两万层业务树按迭代方式投影并保持节点键稳定', () => {
    const nodes = Array.from({ length: 20_000 }, (_, i) => node(String(i), i ? String(i - 1) : undefined))
    const layout = buildSceneHierarchyLayout(asIndex(nodes), [...nodes].reverse(), [], new Set())
    const rows = flattenSceneHierarchyRows(layout, ['0'], new Set(nodes.map(({ id }) => id)))
    expect(rows).toHaveLength(nodes.length)
    expect(rows.at(-1)).toMatchObject({ id: '19999', depth: 19_999 })
  })
})
