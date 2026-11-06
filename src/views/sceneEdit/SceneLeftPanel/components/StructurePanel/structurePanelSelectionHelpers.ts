import type { ComputedRef, InjectionKey } from 'vue'

/**
 * 判断当前鼠标事件是否为主键点击。
 *
 * 结构树里的左键选择、双击聚焦、组头选中都依赖同一套入口，
 * 抽成纯函数后可以让组件层只保留“事件编排”，不再散落按钮判断。
 */
export const isPrimaryStructureMouseButton = (event: Pick<MouseEvent, 'button'>) =>
  event.button === 0

/** 多选必须包含视口的主选中编号，同时剔除批量层级变更中已移除的编号。 */
export function reconcileStructureSceneSelection(
  ids: Set<string>,
  primary: string | null,
  hasObject: (id: string) => boolean,
) {
  if (!primary || !ids.has(primary)) {
    ids.clear()
    return
  }
  for (const id of ids) {
    if (!hasObject(id)) ids.delete(id)
  }
}

/**
 * 根据当前多选结果和 Ctrl 语义，生成下一次部件选中集合。
 *
 * 这里严格保持现有 Windows 风格：
 * - 普通左键：切为单选；
 * - Ctrl + 左键：切换该部件是否处于当前多选集合中。
 */
export const resolveNextStructureWidgetSelection = (
  currentWidgetIds: string[],
  widgetId: string,
  ctrlKey: boolean,
) => {
  if (!ctrlKey) {
    return [widgetId]
  }

  return currentWidgetIds.includes(widgetId)
    ? currentWidgetIds.filter((itemId) => itemId !== widgetId)
    : [...currentWidgetIds, widgetId]
}

export type StructureSelectionEntry = {
  id: string
  type: 'widget' | 'group'
}

/** 选中路径只描述要展开的祖先；页面框架仅在选中其内部节点时额外展开明细。 */
export type StructureSelectionExpansion = {
  widgetIds: ReadonlySet<string>
  groupIds: ReadonlySet<string>
  frameId: string | null
}

/**
 * 由结构面板统一提供只读选中路径，递归节点直接查询集合。
 * 避免把路径逐层透传，或让每个已渲染节点重新遍历整棵组件树。
 */
export const STRUCTURE_SELECTION_EXPANSION_KEY: InjectionKey<
  ComputedRef<StructureSelectionExpansion | null>
> = Symbol('structureSelectionExpansion')

/**
 * 沿实际展示的父节点索引收集选中节点的祖先，不访问其子节点。
 * 多选路径共享已访问集合，每个节点最多查询一次父节点；组件和分组使用独立类型标识，
 * 既能处理两者交错的展示层级，也能在异常循环关系下及时终止。
 *
 * @param selectedEntries 当前真实选中节点，不包含分组选中时投影出的全部成员。
 * @param getParent 查询结构树实际展示的父节点，跨视觉分组时不追溯隐藏的组件父关系。
 * @returns 需要展开的组件和分组祖先集合；选中节点只在也是其他选中节点的祖先时展开。
 */
export const resolveStructureSelectionExpansion = (
  selectedEntries: readonly StructureSelectionEntry[],
  getParent: (entry: StructureSelectionEntry) => StructureSelectionEntry | null,
): Pick<StructureSelectionExpansion, 'widgetIds' | 'groupIds'> => {
  const widgetIds = new Set<string>()
  const groupIds = new Set<string>()
  const visited = new Set<string>()
  const pendingEntries = [...selectedEntries]

  while (pendingEntries.length) {
    const entry = pendingEntries.pop()!
    const key = `${entry.type}:${entry.id}`
    if (visited.has(key)) continue
    visited.add(key)

    const parent = getParent(entry)
    if (!parent || (parent.type === entry.type && parent.id === entry.id)) continue
    if (parent.type === 'widget') widgetIds.add(parent.id)
    else groupIds.add(parent.id)
    pendingEntries.push(parent)
  }

  return { widgetIds, groupIds }
}

/**
 * 根据结构树当前可见顺序解析锚点到目标之间的节点范围。
 *
 * 组和组件使用不同类型参与匹配，避免 ID 恰好相同时把两个不同层级节点混为一谈；
 * 调用方再根据节点类型展开分组成员并写入对应的 Store 选择状态。
 */
export const resolveStructureSelectionRange = (
  visibleEntries: StructureSelectionEntry[],
  anchorEntry: StructureSelectionEntry | null,
  targetEntry: StructureSelectionEntry,
) => {
  const findEntryIndex = (entry: StructureSelectionEntry | null) =>
    entry
      ? visibleEntries.findIndex(
          (visibleEntry) => visibleEntry.id === entry.id && visibleEntry.type === entry.type,
        )
      : -1
  const anchorIndex = findEntryIndex(anchorEntry)
  const targetIndex = findEntryIndex(targetEntry)

  // 锚点可能因删除、过滤或结构调整而暂时不在当前列表中，交由调用方退回普通选择语义。
  if (anchorIndex < 0 || targetIndex < 0) return null

  return visibleEntries.slice(
    Math.min(anchorIndex, targetIndex),
    Math.max(anchorIndex, targetIndex) + 1,
  )
}

/**
 * 根据结构树当前可见顺序生成 Shift 范围选择结果。
 *
 * 范围只包含当前实际渲染出的组件行，因此折叠分组或搜索隐藏的组件不会被意外选中。
 * Ctrl + Shift 在已有多选的基础上追加范围，单独 Shift 则以范围替换当前组件选择。
 */
export const resolveNextStructureWidgetRangeSelection = (
  visibleWidgetIds: string[],
  currentWidgetIds: string[],
  anchorWidgetId: string | null,
  widgetId: string,
  ctrlKey: boolean,
) => {
  const rangeEntries = resolveStructureSelectionRange(
    visibleWidgetIds.map((id) => ({ id, type: 'widget' as const })),
    anchorWidgetId ? { id: anchorWidgetId, type: 'widget' } : null,
    { id: widgetId, type: 'widget' },
  )

  if (!rangeEntries) {
    return resolveNextStructureWidgetSelection(currentWidgetIds, widgetId, ctrlKey)
  }

  const rangeIds = rangeEntries.map((entry) => entry.id)

  if (!ctrlKey) return rangeIds

  return Array.from(new Set([...currentWidgetIds, ...rangeIds]))
}

/**
 * 右键打开菜单前，若目标部件尚未处于当前选中集合中，需要先把选择切到它自身。
 *
 * 这样后续“创建分组”与批量删除等动作看到的始终是用户当前右键命中的真实对象，
 * 不会出现菜单基于旧选择集生成的问题。
 */
export const shouldResetStructureContextSelection = (
  widgetId: string | undefined,
  currentWidgetIds: string[],
) => typeof widgetId === 'string' && !currentWidgetIds.includes(widgetId)

/**
 * 切换分组展开状态。
 *
 * 结构树展开列表本质上只是一个 ID 集合，
 * 这里统一处理增删，避免组件里重复写数组过滤和追加逻辑。
 */
export const resolveNextExpandedStructureGroups = (expandedGroupIds: string[], groupId: string) =>
  expandedGroupIds.includes(groupId)
    ? expandedGroupIds.filter((id) => id !== groupId)
    : [...expandedGroupIds, groupId]

export type SceneObjectStructureCategory = 'model' | 'three-dimensional-component'

/**
 * 结构树三维对象是否处于选中高亮。
 *
 * 中国 3D 地图没有旧 Three Mesh，Pinia uuid 在 Runtime flush 期间可能被旧清选入口短暂清空。
 * 同时核对平台 Store 与独立地图选中编号，避免列表高亮只依赖一条过渡期字段而闪掉。
 */
export const isStructureSceneObjectSelected = (
  itemId: string,
  currentTransformMaterialUuid?: string | null,
  selectedThreeMapObjectId?: string | null,
  selectedSceneObjectId?: string | null,
) =>
  itemId === currentTransformMaterialUuid ||
  itemId === selectedThreeMapObjectId ||
  itemId === selectedSceneObjectId

/**
 * 场景首次加载或首次创建三维组件时，若当前仍停留在默认的模型分类，自动展示实际存在的组件。
 * 用户已经主动点选过分类后不再覆盖其选择，避免场景事件把结构面板切回其它分类。
 */
export const resolveAutomaticSceneObjectCategory = (
  currentCategory: SceneObjectStructureCategory,
  modelCount: number,
  componentCount: number,
  categorySelectedByUser: boolean,
): SceneObjectStructureCategory => {
  if (
    categorySelectedByUser ||
    currentCategory !== 'model' ||
    modelCount > 0 ||
    componentCount === 0
  ) {
    return currentCategory
  }

  return 'three-dimensional-component'
}
