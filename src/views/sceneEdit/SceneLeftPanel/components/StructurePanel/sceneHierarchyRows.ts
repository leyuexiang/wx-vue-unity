import type { SceneNodeIndex } from '@/scene-platform/core/sceneNodeIndexCache'
import type { SceneObject } from '@/scene-platform'
import type { SceneObjectStructureCategory } from './structurePanelSelectionHelpers'

type Category = SceneObjectStructureCategory
type Item = { id: string; name: string }
export type SceneHierarchyRow<T> = T & { depth: number; expandable: boolean; expanded: boolean }

/** 仅从草稿父级建立显示归属。根和同级次序来自共享索引，兼容条目继续平铺。 */
export function buildSceneHierarchyLayout<T extends Item>(
  index: SceneNodeIndex<SceneObject>,
  models: readonly T[],
  components: readonly T[],
  layerIds: ReadonlySet<string>,
) {
  const items = new Map<string, T>()
  const ownCategory = new Map<string, Category>()
  for (const item of models) { items.set(item.id, item); ownCategory.set(item.id, 'model') }
  for (const item of components) { items.set(item.id, item); ownCategory.set(item.id, 'three-dimensional-component') }
  const categoryById = new Map<string, Category>()
  const sections = {
    model: { roots: new Map<string, string[]>(), count: 0, memberLayers: new Set<string>() },
    'three-dimensional-component': { roots: new Map<string, string[]>(), count: 0, memberLayers: new Set<string>() },
  }
  const path: string[] = []
  for (const id of items.keys()) {
    let cursor = id
    while (!categoryById.has(cursor)) {
      path.push(cursor)
      const parent = index.parentById.get(cursor)
      if (!parent || !items.has(parent)) break
      cursor = parent
    }
    const category = categoryById.get(cursor) ?? ownCategory.get(cursor)!
    for (const entry of path) categoryById.set(entry, category)
    path.length = 0
    sections[category].count++
    const layerId = index.nodesById.get(id)?.layerId
    if (layerId && layerIds.has(layerId)) sections[category].memberLayers.add(layerId)
  }

  const appendRoot = (id: string) => {
    const category = categoryById.get(id)
    if (!category) return
    const layerId = index.nodesById.get(id)?.layerId
    const key = layerId && layerIds.has(layerId) ? layerId : ''
    const roots = sections[category].roots
    const entries = roots.get(key)
    if (entries) entries.push(id)
    else roots.set(key, [id])
  }
  for (const id of index.childrenByParent.get('') ?? []) appendRoot(id)
  for (const id of items.keys()) {
    const parent = index.parentById.get(id)
    // 未映射的旧条目及展示源中缺少父条目的实例保留入口，草稿关系照常保留。
    if (parent === undefined || (parent && !items.has(parent))) appendRoot(id)
  }
  return { items, sections, categoryById, index }
}

/** 定位使用业务根的页签和显示图层，子节点自身的图层归属保持独立。 */
export function resolveSceneHierarchyLocation<T extends Item>(
  layout: ReturnType<typeof buildSceneHierarchyLayout<T>>,
  id: string,
) {
  const category = layout.categoryById.get(id)
  if (!category) return undefined
  const ancestors: string[] = []
  let root = id
  for (let parent = layout.index.parentById.get(id); parent && layout.items.has(parent); parent = layout.index.parentById.get(parent)) {
    ancestors.push(parent)
    root = parent
  }
  const layerId = layout.index.nodesById.get(root)?.layerId
  return { category, ancestors, layerId: layerId && layout.sections[category].roots.has(layerId) ? layerId : undefined }
}

type SearchLayout = Pick<ReturnType<typeof buildSceneHierarchyLayout<Item>>, 'items' | 'index'>

/** 只缓存当前查询。选中、显隐或变换刷新行时，名称和父级未变即可复用匹配及祖先路径。 */
export function createSceneHierarchySearch() {
  let cached: {
    keyword: string
    names: ReadonlyMap<string, string>
    index: SearchLayout['index']
    structureVersion: number
    result: { directIds: ReadonlySet<string>; pathIds: ReadonlySet<string> }
  } | undefined

  return (layout: SearchLayout | null, keyword: string) => {
    if (!layout || !keyword) {
      cached = undefined
      return undefined
    }

    const { index, items } = layout
    if (cached?.keyword === keyword && cached.index === index &&
      cached.structureVersion === index.structureVersion && cached.names.size === items.size) {
      let namesUnchanged = true
      for (const [id, item] of items) {
        if (cached.names.get(id) === item.name) continue
        namesUnchanged = false
        break
      }
      if (namesUnchanged) return cached.result
    }

    const names = new Map<string, string>()
    const directIds = new Set<string>()
    const pathIds = new Set<string>()
    for (const [id, item] of items) {
      names.set(id, item.name)
      if (!item.name.toLowerCase().includes(keyword)) continue
      directIds.add(id)
      let ancestor: string | undefined = id
      while (ancestor && items.has(ancestor) && !pathIds.has(ancestor)) {
        pathIds.add(ancestor)
        ancestor = index.parentById.get(ancestor)
      }
    }
    const result = { directIds, pathIds }
    cached = { keyword, names, index, structureVersion: index.structureVersion, result }
    return result
  }
}

/** 用显式栈按同级顺序生成可见行，折叠时不访问更深的后代。 */
export function flattenSceneHierarchyRows<T extends Item>(
  layout: ReturnType<typeof buildSceneHierarchyLayout<T>>,
  roots: readonly string[],
  expandedIds: ReadonlySet<string>,
  matches?: ReadonlySet<string>,
  revealMatches = matches !== undefined,
): SceneHierarchyRow<T>[] {
  const rows: SceneHierarchyRow<T>[] = []
  const pending: Array<{ id: string; depth: number }> = []
  const enqueue = (ids: readonly string[], depth: number) => {
    for (let i = ids.length - 1; i >= 0; i--) {
      const id = ids[i]!
      if (layout.items.has(id) && (!matches || matches.has(id))) pending.push({ id, depth })
    }
  }
  enqueue(roots, 0)
  while (pending.length) {
    const { id, depth } = pending.pop()!
    const children = layout.index.childrenByParent.get(id) ?? []
    const expandable = children.some((child) => layout.items.has(child) && (!matches || matches.has(child)))
    const expanded = expandable && (revealMatches || expandedIds.has(id))
    rows.push({ ...layout.items.get(id)!, depth, expandable, expanded })
    if (expanded) enqueue(children, depth + 1)
  }
  return rows
}
