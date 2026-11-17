import { computed, inject, nextTick, toRaw, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue'
import { Connection, Search, Delete, Hide, View, Lock, Unlock } from '@element-plus/icons-vue'
import draggable from 'vuedraggable'
import { runConfirmedEditorCommand } from '@/integrations/scene/editorSceneCommandTransaction'
import { ElMessage, ElMessageBox } from 'element-plus'
import { beginEditorSceneOperation, editorSceneOperation } from '@/integrations/scene/editorSceneOperationGate'
import { buildSceneNodeIndex } from '@/scene-platform/core/sceneNodeIndex'
import { createMoveSceneNodesCommand, isLocalHierarchyNode } from '@/scene-platform/commands/moveSceneNodeCommand'
import type { SceneCommand } from '@/scene-platform/commands/types'
import type { SceneAllContentsItem, WidgetLayerNode } from '@/types/threeScene'
import type { CommandBus, RuntimeBridge, SceneObject, SceneStore } from '@/scene-platform'
import { useSceneStore, useSceneWidgetStore } from '@/stores/sceneEditStore'
import {
  focusSceneContentByUuid,
  getSceneAllContents,
  removeSceneContentByUuid,
  selectSceneContentByUuid,
  toggleSceneContentPickupByUuid,
  toggleSceneContentVisibleByUuid,
} from '@/utils/renderScene/sceneModules'
import { updateWidgetVisibleById } from '@/integrations/scene/widgetStructure'
import { getWidgetRuntimePort } from '@/integrations/scene/widgetRuntime'
import { listVegetationRegions } from '@/integrations/scene/editorVegetationRegions'
import { VEGETATION_STRUCTURE_KEY } from '../../../vegetationStructure'
import {
  getActiveSceneViewportHost,
  subscribeActiveSceneViewportHost,
} from '@/integrations/scene/editorScenePlatformHost'
import {
  clearEditorSceneSelection,
  selectEditorSceneObject,
} from '@/integrations/scene/editorSceneSelectionAdapter'
import { resolveEditorLegacyEngineObjectId } from '@/integrations/scene/editorSceneRuntimeObjectIdResolver'
import {
  buildLegacySceneContentMap,
  isEditorThreeDimensionalComponentContent,
  mapSceneObjectsToStructureContents,
} from '@/integrations/scene/editorSceneObjectTree'
import { deleteEditorSceneSubtrees } from '@/integrations/scene/editorSceneSubtreeDeletion'
import { copyEditorSceneSubtrees } from '@/integrations/scene/editorSceneSubtreeCopy'
import { createEditorUnityGroup } from '@/integrations/scene/editorUnityCreationAdapter'
import {
  buildEditorSceneObjectLayerGroups,
  deleteEditorSceneObjectLayer,
  ensureEditorSceneObjectLayersInStore,
  isEditorManagedDefaultObjectLayer,
  moveEditorSceneObjectToLayer,
  reorderEditorSceneObjectLayers,
  resolveEditorSceneObjectEffectiveState,
  setEditorSceneObjectLocked,
  setEditorSceneObjectLayerLocked,
  setEditorSceneObjectLayerVisible,
} from '@/integrations/scene/editorSceneLayerAdapter'
import { applySceneObjectVisibilityToStore } from '@/integrations/scene/editorSceneVisibilityAdapter'
import { renameEditorSceneObjectWithCommand } from '@/integrations/scene/editorSceneObjectMutationAdapter'
import { appLogger } from '@/utils/logger'
import {
  findPageFrameChild,
  normalizePageFrameOption,
} from '@/packages/components/Widget/VPageMenu/pageFrameTypes'
import WidgetGroupItem from './WidgetGroupItem'
import WidgetLeafItem from './WidgetLeafItem'
import {
  buildSceneHierarchyLayout,
  createSceneHierarchySearch,
  flattenSceneHierarchyRows,
  resolveSceneHierarchyLocation,
} from './sceneHierarchyRows'
import { resolveSceneHierarchyDrop, type SceneHierarchyDropTarget } from './sceneHierarchyDrag'
import createGroupIcon from '@/assets/icons/create-group.svg'
import structureModelActiveIcon from '@/assets/images/structure-model-active.svg'
import structureModelDefaultIcon from '@/assets/images/structure-model-default.svg'
import structureWidgetActiveIcon from '@/assets/images/structure-widget-active.svg'
import structureWidgetDefaultIcon from '@/assets/images/structure-widget-default.svg'
import structureThreeDimensionalComponentActiveIcon from '@/assets/images/scene-left-navigation/marker-active.svg'
import structureThreeDimensionalComponentDefaultIcon from '@/assets/images/scene-left-navigation/marker-default.svg'
import {
  buildWidgetEntryMap,
  resolveWidgetHierarchyDropTarget,
  resolveWidgetSortPlacement,
  setWidgetDragData,
  filterWidgetLayerNodes,
  syncExpandedGroupIds,
  type WidgetSortableMoveEvent,
  type WidgetMenuContextPayload,
} from './structurePanelHelpers'
import {
  adjustStructureContextMenuPosition,
  createHiddenStructureContextMenuState,
  createStructureContextMenuState,
} from './structurePanelMenuHelpers'
import {
  isPrimaryStructureMouseButton,
  isStructureSceneObjectSelected,
  reconcileStructureSceneSelection,
  resolveNextExpandedStructureGroups,
  resolveStructureSelectionRange,
  resolveNextStructureWidgetSelection,
  shouldResetStructureContextSelection,
  resolveAutomaticSceneObjectCategory,
  resolveStructureSelectionExpansion,
  STRUCTURE_SELECTION_EXPANSION_KEY,
  type SceneObjectStructureCategory,
  type StructureSelectionEntry,
  type StructureSelectionExpansion,
} from './structurePanelSelectionHelpers'

/**
 * 结构面板组合式控制器。
 *
 * 该文件集中管理模型/组件结构树的查询索引、选择同步、拖拽事务和平台桥接。
 * 主视图只负责模板编排，避免单文件同时承担运行时兼容与节点渲染职责。
 */
export const useStructurePanel = () => {
  type StructureSceneObjectItem = {
    id: string
    name: string
    kind: 'scene-object'
    isActive: boolean
    raw: SceneAllContentsItem
    depth?: number
    expandable?: boolean
    expanded?: boolean
  }

  type StructureModelLayerGroup = {
    id: string
    name: string
    visible: boolean
    locked: boolean
    objectCount: number
    isSystemDefaultLayer: boolean
    items: StructureSceneObjectItem[]
    displayCount?: number
    searchHit?: boolean
  }
  type StructureCategory = SceneObjectStructureCategory | 'widget' | 'vegetation'

  const store = useSceneStore()
  const sceneWidgetStore = useSceneWidgetStore()
  const vegetationStructure = inject(VEGETATION_STRUCTURE_KEY, null)

  const searchValue = ref('')
  const activeStructureCategory = ref<StructureCategory>('model')
  const structureCategorySelectedByUser = ref(false)
  const expandedGroupIds = ref<string[]>([])
  // 对象图层与业务节点使用独立展开集合，避免同名编号串到二维分组。
  const expandedSceneLayerIds = ref(new Set<string>())
  const expandedSceneNodeIds = ref(new Set<string>())
  const isSceneLayerExpanded = (id: string) => expandedSceneLayerIds.value.has(id)
  const toggleSceneLayerExpanded = (id: string) => {
    if (!expandedSceneLayerIds.value.delete(id)) expandedSceneLayerIds.value.add(id)
  }
  const toggleSceneNodeExpanded = (id: string) => {
    // 搜索暂时展开命中路径，用户的常规展开状态在清空搜索后恢复。
    if (hierarchySearchKeyword.value) return
    if (!expandedSceneNodeIds.value.delete(id)) expandedSceneNodeIds.value.add(id)
  }
  const contextMenuRef = ref<HTMLElement>()
  const contextMenu = ref(createHiddenStructureContextMenuState())
  const scenePlatformStore = ref<SceneStore | null>(null)
  // 多选只为批量删除保存稳定编号，视口和属性面板沿用单选目标。
  const selectedSceneObjectIds = ref(new Set<string>())
  const scenePlatformBridge = ref<RuntimeBridge | null>(null)
  const scenePlatformCommandBus = ref<Pick<CommandBus, 'execute' | 'cancelLatest'> | null>(null)
  const scenePlatformStoreRevision = ref(0)
  const hierarchyIndexRevision = ref(0)
  const modelLayerDragGroup = { name: 'scene-model-layer' }
  const widgetLayerDragGroup = { name: 'scene-widget-layer', pull: true, put: true }
  const draggedWidgetIds = ref<string[]>([])
  const draggedGroupId = ref('')
  const widgetGroupDropTargetId = ref('')
  const widgetGroupSortGapTarget = ref<{ relatedId: string; placement: 'before' | 'after' } | null>(
    null,
  )
  const widgetSelectionBeforePointerDown = ref<string[]>([])
  /** Shift 范围选择使用最近一次组件或分组点击作为锚点。 */
  const structureSelectionAnchor = ref<StructureSelectionEntry | null>(null)
  const widgetNestingHandled = ref(false)
  const widgetDropHandled = ref(false)
  const widgetHierarchyHoverCandidateId = ref('')
  const widgetHierarchyDropTargetId = ref('')
  const widgetSortGapTarget = ref<{
    relatedWidgetId: string
    placement: 'before' | 'after'
  } | null>(null)
  let stopScenePlatformHostSubscription: (() => void) | null = null
  let stopScenePlatformStoreSubscription: (() => void) | null = null
  let syncingSceneObjectLayers = false
  let structureSceneSession = 0

  const searchKeyword = computed(() => searchValue.value.trim().toLowerCase())
  const hierarchySearchKeyword = ref('')
  // 只延后业务树查询，清空立即恢复，平铺列表与二维搜索保持原有响应方式。
  watch(searchKeyword, (keyword, _, onCleanup) => {
    if (!keyword) {
      hierarchySearchKeyword.value = ''
      return
    }
    const timer = setTimeout(() => { hierarchySearchKeyword.value = keyword }, 180)
    onCleanup(() => clearTimeout(timer))
  })
  const showVegetationCategory = computed(() => {
    void scenePlatformStoreRevision.value
    return !!vegetationStructure && scenePlatformStore.value?.getScene().type === 'gis'
  })
  const vegetationRegions = computed(() => {
    void scenePlatformStoreRevision.value
    if (!showVegetationCategory.value) return []
    return vegetationStructure?.draft.value?.regions ?? listVegetationRegions(scenePlatformStore.value?.getVegetation()?.rules ?? [])
  })
  const filteredVegetationRegions = computed(() => {
    const counts = new Map<string, number>()
    const occurrences = new Map<string, number>()
    const labels = { imagery: '影像种植', polygon: '多边形', corridor: '行道树', 'altitude-zonation': '海拔带' }
    for (const region of vegetationRegions.value) {
      const name = region.name.trim() || '未命名种植区域'
      counts.set(name, (counts.get(name) ?? 0) + 1)
    }
    return vegetationRegions.value.map((region) => {
      const name = region.name.trim() || '未命名种植区域'
      const occurrence = (occurrences.get(name) ?? 0) + 1
      occurrences.set(name, occurrence)
      return {
        id: region.id,
        name: (counts.get(name) ?? 0) > 1 ? `${name} (${occurrence})` : name,
        kindLabel: labels[region.kind],
      }
    }).filter((region) => `${region.name} ${region.kindLabel}`.toLowerCase().includes(searchKeyword.value))
  })
  const selectedVegetationRegionId = computed(() => vegetationStructure?.draft.value?.selectedRegionId)
  const vegetationSelectionDisabled = computed(() => vegetationStructure?.draft.value?.selectionDisabled ?? false)
  const currentTransformMaterialUuid = computed(() => store.currentTransformMaterialUuid)
  const transformMaterialRandomId = computed(() => store.transformMaterialRandomId)

  /**
   * Store 本身是普通 TypeScript 对象，不是 Vue 响应式对象。
   * 这里用 revision 作为轻量刷新信号，Store 事件到达时只重算对象树列表，不触碰渲染核心。
   */
  const refreshScenePlatformStoreRevision = () => {
    scenePlatformStoreRevision.value += 1
  }

  const scenePlatformObjects = computed(() => {
    void scenePlatformStoreRevision.value
    /**
     * 场景仓库（SceneStore）的 getObjects 返回内部对象数组。
     * 新增、删除和改名会复用同一个数组引用；这里按 revision 返回浅拷贝，
     * 确保 Vue 计算属性能看到引用变化，结构面板会主动刷新而不是等下一次选中态变化。
     */
    return [...(scenePlatformStore.value?.getObjects() || [])]
  })
  const legacySceneContents = computed(() => {
    const selectedUuid = currentTransformMaterialUuid.value
    const refreshToken = transformMaterialRandomId.value
    const scenePlatformRefreshToken = scenePlatformStoreRevision.value
    void selectedUuid
    void refreshToken
    void scenePlatformRefreshToken
    /**
     * 旧场景快照只在结构树计算时读取一次，并由 Pinia 的选中刷新信号和平台 Store revision
     * 驱动更新。这样历史对象操作后的界面能及时刷新，也不会在每个模板节点里重复遍历 Three 场景。
     */
    return getSceneAllContents()
  })

  const legacySceneContentMap = computed(() =>
    buildLegacySceneContentMap(legacySceneContents.value),
  )

  const allSceneContents = computed(() => {
    /**
     * F024 保持 SceneStore 主读：已迁移对象的数量、顺序、名称来自 Store；旧快照只补齐
     * 未映射历史对象。合并适配器按多种稳定标识去重，避免同一模型同时出现新旧两条记录。
     */
    return mapSceneObjectsToStructureContents(
      scenePlatformObjects.value,
      legacySceneContentMap.value,
      legacySceneContents.value,
    )
  })

  /**
   * 三维组件和模型都由 SceneStore / Runtime 管理，但结构树的产品分类不同。
   * 这里用一次线性遍历同时生成两份列表，避免组件页和模型页分别扫描全部场景对象；分类只改变
   * 展示位置，节点后续仍复用三维对象的选中、聚焦、显隐、锁定和删除能力。
   */
  const categorizedSceneObjectItems = computed(() => {
    void scenePlatformStoreRevision.value
    const modelItems: StructureSceneObjectItem[] = []
    const threeDimensionalComponentItems: StructureSceneObjectItem[] = []

    allSceneContents.value.forEach((item) => {
      const structureItem: StructureSceneObjectItem = {
        id: item.uuid,
        name: item.name,
        kind: 'scene-object',
        isActive: selectedSceneObjectIds.value.has(item.uuid) || (!selectedSceneObjectIds.value.size && isStructureSceneObjectSelected(
          item.uuid,
          currentTransformMaterialUuid.value,
          store.selectedThreeMapObjectId,
          scenePlatformStore.value?.getSelectedObjectId(),
        )),
        raw: item,
      }

      if (isEditorThreeDimensionalComponentContent(item)) {
        threeDimensionalComponentItems.push(structureItem)
      } else modelItems.push(structureItem)
    })

    return { modelItems, threeDimensionalComponentItems }
  })

  const allModelItems = computed(() => categorizedSceneObjectItems.value.modelItems)
  const allThreeDimensionalComponentItems = computed(
    () => categorizedSceneObjectItems.value.threeDimensionalComponentItems,
  )

  /**
   * 模型和三维组件都使用同一套场景图层协议。
   * 这里只替换待展示的对象集合，避免为三维组件复制一套分组、排序和锁定逻辑。
   */
  const buildSceneObjectLayerGroups = (items: StructureSceneObjectItem[]) => {
    void scenePlatformStoreRevision.value
    const itemMap = new Map(items.map((item) => [item.id, item]))

    /**
     * F014 的 3D 图层视图只展示真实 3D 模型条目。
     * SceneStore 中过渡期可能包含二维部件镜像对象，适配器仍会维护其 layerId；
     * 这里按对象树映射结果过滤，避免二维镜像回流到 3D 模型区域。
     */
    return buildEditorSceneObjectLayerGroups(scenePlatformStore.value?.getScene() || null)
      .map((group) => ({
        id: group.id,
        name: group.name,
        visible: group.visible,
        locked: group.locked,
        objectCount: group.objectIds.length,
        isSystemDefaultLayer: isEditorManagedDefaultObjectLayer(group.layer),
        items: group.objectIds
          .map((objectId) => itemMap.get(objectId))
          .filter((item): item is StructureSceneObjectItem => Boolean(item)),
      }))
      .filter((group) => group.items.length > 0 || group.objectCount === 0)
  }

  const modelLayerGroups = computed<StructureModelLayerGroup[]>(() =>
    buildSceneObjectLayerGroups(allModelItems.value),
  )
  const threeDimensionalComponentLayerGroups = computed<StructureModelLayerGroup[]>(() =>
    buildSceneObjectLayerGroups(allThreeDimensionalComponentItems.value),
  )

  /**
   * 系统默认图层只承担旧场景兼容，不在结构面板中伪装成“未分组”。
   * 根级列表通过排除用户视觉分组成员得到，因此模型在运行时仍是完全平铺的独立对象。
   */
  const rootModelItems = computed(() => {
    const groupedIds = new Set(
      modelLayerGroups.value
        .filter((group) => !group.isSystemDefaultLayer)
        .flatMap((group) => group.items.map((item) => item.id)),
    )
    const keyword = searchKeyword.value
    return allModelItems.value.filter(
      (item) => !groupedIds.has(item.id) && (!keyword || item.name.toLowerCase().includes(keyword)),
    )
  })

  /** 搜索只裁剪视觉结果，拖拽在搜索期间禁用，避免过滤列表覆盖完整归属关系。 */
  const visibleModelGroups = computed(() => {
    const keyword = searchKeyword.value
    return modelLayerGroups.value
      .filter((group) => !group.isSystemDefaultLayer)
      .map((group) => {
        if (!keyword || group.name.toLowerCase().includes(keyword)) return group
        return {
          ...group,
          items: group.items.filter((item) => item.name.toLowerCase().includes(keyword)),
        }
      })
      .filter(
        (group) => !keyword || group.name.toLowerCase().includes(keyword) || group.items.length > 0,
      )
  })

  const rootThreeDimensionalComponentItems = computed(() => {
    const groupedIds = new Set(
      threeDimensionalComponentLayerGroups.value
        .filter((group) => !group.isSystemDefaultLayer)
        .flatMap((group) => group.items.map((item) => item.id)),
    )
    const keyword = searchKeyword.value
    return allThreeDimensionalComponentItems.value.filter(
      (item) => !groupedIds.has(item.id) && (!keyword || item.name.toLowerCase().includes(keyword)),
    )
  })

  const visibleThreeDimensionalComponentGroups = computed(() => {
    const keyword = searchKeyword.value
    return threeDimensionalComponentLayerGroups.value
      .filter((group) => !group.isSystemDefaultLayer)
      .map((group) => {
        if (!keyword || group.name.toLowerCase().includes(keyword)) return group
        return {
          ...group,
          items: group.items.filter((item) => item.name.toLowerCase().includes(keyword)),
        }
      })
      .filter(
        (group) => !keyword || group.name.toLowerCase().includes(keyword) || group.items.length > 0,
      )
  })

  const hierarchyDisplayLayers = computed(() => {
    void scenePlatformStoreRevision.value
    return (scenePlatformStore.value?.getLayers() ?? [])
      .filter((layer) => layer.type === 'object' && !isEditorManagedDefaultObjectLayer(layer))
      .sort((a, b) => a.order - b.order)
  })
  const hierarchyLayout = computed(() => {
    void scenePlatformStoreRevision.value
    const sceneStore = scenePlatformStore.value
    if (sceneStore?.getScene().type !== 'local3d' || !getActiveSceneViewportHost()?.getRuntime().id.startsWith('unity-')) return null
    const index = sceneStore.getNodeIndex()
    // 平铺草稿仍可用原拖拽。存在业务父级时显示层级，拖拽语义由 M2-06 接入。
    if (!index.childrenByParent.size || (index.childrenByParent.size === 1 && index.childrenByParent.has(''))) return null
    return buildSceneHierarchyLayout(index, allModelItems.value, allThreeDimensionalComponentItems.value,
      new Set(hierarchyDisplayLayers.value.map((layer) => layer.id)))
  })
  const searchSceneHierarchy = createSceneHierarchySearch()
  const hierarchyMatches = computed(() =>
    searchSceneHierarchy(hierarchyLayout.value, hierarchySearchKeyword.value),
  )
  const sceneObjectCategoryCounts = computed(() => ({
    model: hierarchyLayout.value?.sections.model.count ?? allModelItems.value.length,
    'three-dimensional-component': hierarchyLayout.value?.sections['three-dimensional-component'].count
      ?? allThreeDimensionalComponentItems.value.length,
  }))
  const hierarchyVisibleRows = computed(() => {
    const layout = hierarchyLayout.value
    const category = activeStructureCategory.value
    if (!layout || category === 'widget' || category === 'vegetation') return null
    const section = layout.sections[category]
    const keyword = hierarchySearchKeyword.value
    const matches = hierarchyMatches.value?.pathIds
    const flatten = (roots: readonly string[], filter = matches) =>
      flattenSceneHierarchyRows(layout, roots, expandedSceneNodeIds.value, filter)
    const rootItems = flatten(section.roots.get('') ?? [])
    const groups: StructureModelLayerGroup[] = []
    for (const layer of hierarchyDisplayLayers.value) {
      const objectCount = scenePlatformStore.value?.getObjectIdsInLayer(layer.id).size ?? 0
      if (objectCount && !section.memberLayers.has(layer.id)) continue
      const roots = section.roots.get(layer.id) ?? []
      const layerMatches = Boolean(keyword && layer.name.toLowerCase().includes(keyword))
      const items = layerMatches
        ? flattenSceneHierarchyRows(layout, roots, expandedSceneNodeIds.value, undefined, true)
        : isSceneLayerExpanded(layer.id) || keyword ? flatten(roots) : []
      if (keyword && !layerMatches && !items.length) continue
      groups.push({ id: layer.id, name: layer.name, visible: layer.visible, locked: layer.locked,
        objectCount, isSystemDefaultLayer: false, items, displayCount: roots.length, searchHit: layerMatches })
    }
    return { rootItems, groups }
  })

  // 沿用图层在前的显示顺序，图层和对象行使用各自的键命名空间。
  const sceneHierarchyRows = computed(() => {
    const rows = hierarchyVisibleRows.value
    if (!rows) return null
    const directIds = hierarchyMatches.value?.directIds
    const result: (
      | { kind: 'node'; key: string; item: StructureSceneObjectItem; layerDepth: number; searchHit: boolean }
      | { kind: 'layer'; key: string; group: StructureModelLayerGroup; searchHit: boolean }
    )[] = []
    const appendNode = (item: StructureSceneObjectItem, layerDepth: number) => {
      result.push({ kind: 'node', key: `node:${item.id}`, item, layerDepth, searchHit: directIds?.has(item.id) ?? false })
    }
    for (const group of rows.groups) {
      result.push({ kind: 'layer', key: `layer:${group.id}`, group, searchHit: group.searchHit ?? false })
      for (const item of group.items) appendNode(item, 1)
    }
    for (const item of rows.rootItems) appendNode(item, 0)
    return result
  })
  const selectedHierarchyObjectId = computed(() => {
    void scenePlatformStoreRevision.value
    return hierarchyLayout.value ? scenePlatformStore.value?.getSelectedObjectId() : undefined
  })
  const hierarchyRenameTarget = computed(() => {
    const id = selectedHierarchyObjectId.value
    if (!id || selectedSceneObjectIds.value.size > 1 ||
      hierarchyLayout.value?.categoryById.get(id) !== activeStructureCategory.value) return undefined
    const platform = scenePlatformStore.value
    if (!platform?.getObject(id)) return undefined
    return { id, locked: platform.isObjectEffectivelyLocked(id) }
  })
  const canEditHierarchyRows = computed(() => Boolean(scenePlatformCommandBus.value) && !editorSceneOperation.value)
  const renameHierarchySelection = async () => {
    const platform = scenePlatformStore.value
    const commandBus = scenePlatformCommandBus.value
    const target = hierarchyRenameTarget.value
    const object = target && platform?.getObject(target.id)
    if (!target || !object || !commandBus || target.locked || editorSceneOperation.value) return
    const session = structureSceneSession
    let name: string
    try {
      const result = await ElMessageBox.prompt('输入节点名称', '重命名节点', {
        inputValue: object.name,
        inputValidator: (value) => Boolean(value?.trim()) || '请输入节点名称',
        confirmButtonText: '保存',
        cancelButtonText: '取消',
      })
      name = result.value
    } catch {
      return
    }
    // 弹窗可跨越重载或保存，提交前以会话和稳定编号重新确认编辑资格。
    if (structureSceneSession !== session || scenePlatformStore.value !== platform ||
      scenePlatformCommandBus.value !== commandBus || editorSceneOperation.value) return
    try {
      const result = renameEditorSceneObjectWithCommand({ store: platform, commandBus, objectId: object.id, name })
      if (result.status === 'applied') flushScenePlatformBridge('重命名节点')
      else if (result.reason === 'locked-object') ElMessage.warning('节点已锁定，无法重命名')
    } catch (error) {
      ElMessage.warning(error instanceof Error ? error.message : '无法重命名节点')
    }
  }
  const revealSceneHierarchyObject = (id: string) => {
    const layout = hierarchyLayout.value
    if (!layout || activeStructureCategory.value === 'widget' || hierarchySearchKeyword.value) return
    const location = resolveSceneHierarchyLocation(layout, id)
    if (!location) return
    activeStructureCategory.value = location.category
    for (const parent of location.ancestors) expandedSceneNodeIds.value.add(parent)
    if (location.layerId) expandedSceneLayerIds.value.add(location.layerId)
  }

  /** 结构树模型区和三维组件区共用以下动态数据，模板只保留一套列表实现。 */
  const activeSceneObjectLabel = computed(() =>
    activeStructureCategory.value === 'three-dimensional-component' ? '三维组件' : '模型',
  )
  const activeSceneObjectRootItems = computed(() =>
    activeStructureCategory.value === 'three-dimensional-component'
      ? rootThreeDimensionalComponentItems.value
      : rootModelItems.value,
  )
  const activeVisibleSceneObjectGroups = computed(() =>
    activeStructureCategory.value === 'three-dimensional-component'
      ? visibleThreeDimensionalComponentGroups.value
      : visibleModelGroups.value,
  )

  const selectStructureCategory = (category: StructureCategory) => {
    selectedSceneObjectIds.value = new Set()
    structureCategorySelectedByUser.value = true
    activeStructureCategory.value = category
  }

  const autoSelectSceneObjectCategory = () => {
    const currentCategory = activeStructureCategory.value
    if (currentCategory === 'widget' || currentCategory === 'vegetation') return
    const nextCategory = resolveAutomaticSceneObjectCategory(
      currentCategory,
      sceneObjectCategoryCounts.value.model,
      sceneObjectCategoryCounts.value['three-dimensional-component'],
      structureCategorySelectedByUser.value,
    )
    activeStructureCategory.value = nextCategory
  }

  /** 模型分组删除状态按仓库修订统一缓存，避免模板为每个按钮重复解析有效锁定状态。 */
  const modelGroupDeleteDisabledIds = computed(
    () =>
      new Set(
        modelLayerGroups.value
          .filter((group) => group.locked || group.items.some((item) => isModelLocked(item)))
          .map((group) => group.id),
      ),
  )

  const isModelGroupDeleteDisabled = (group: StructureModelLayerGroup) =>
    modelGroupDeleteDisabledIds.value.has(group.id)

  const threeDimensionalComponentGroupDeleteDisabledIds = computed(
    () =>
      new Set(
        threeDimensionalComponentLayerGroups.value
          .filter((group) => group.locked || group.items.some((item) => isModelLocked(item)))
          .map((group) => group.id),
      ),
  )

  /** 根据当前结构分类判断三维对象分组能否删除，模型与三维组件共用同一组级规则。 */
  const isActiveSceneObjectGroupDeleteDisabled = (group: StructureModelLayerGroup) =>
    group.locked || (hierarchyLayout.value && scenePlatformStore.value
      ? [...scenePlatformStore.value.getObjectIdsInLayer(group.id)].some((id) => scenePlatformStore.value!.isObjectEffectivelyLocked(id))
      : activeStructureCategory.value === 'three-dimensional-component'
      ? threeDimensionalComponentGroupDeleteDisabledIds.value.has(group.id)
      : isModelGroupDeleteDisabled(group))

  const widgetEntryMap = computed(() => buildWidgetEntryMap(sceneWidgetStore.totalWidgets || []))
  const widgetGroupMap = computed(
    () =>
      new Map(
        sceneWidgetStore.widgetLayerTree
          .filter(
            (node): node is Extract<WidgetLayerNode, { type: 'group' }> => node.type === 'group',
          )
          .map((group) => [group.id, group]),
      ),
  )

  /**
   * 图层树继续保存全部真实组件的顺序；结构面板顶层只投影没有父组件的节点。
   * 子组件由 WidgetLeafItem 按同一份父子索引递归渲染，避免在界面层复制可写结构状态。
   */
  const visibleWidgetLayerTree = computed<WidgetLayerNode[]>(() =>
    sceneWidgetStore.widgetLayerTree
      .map<WidgetLayerNode | null>((node) => {
        if (node.type === 'group') {
          if (sceneWidgetStore.getWidgetGroupParentGroupId(node.id)) return null
          const groupWidgetIds = new Set(node.children)
          return {
            ...node,
            children: node.children.filter((id) => {
              const parentId = sceneWidgetStore.getWidgetParentId(id)
              return !parentId || !groupWidgetIds.has(parentId)
            }),
          }
        }
        return sceneWidgetStore.getWidgetParentId(node.id) ? null : node
      })
      .filter((node): node is WidgetLayerNode => node !== null),
  )

  /** 子组件顺序复用图层树的拍平顺序，保证结构展示与 zIndex 的前后关系一致。 */
  const widgetChildrenMap = computed(() => {
    const childrenMap = new Map<string, string[]>()
    const widgetById = new Map(
      (sceneWidgetStore.totalWidgets || []).map((widget) => [widget.id, widget]),
    )
    const widgetGroupIds = new Map<string, string | null>()
    sceneWidgetStore.widgetLayerTree.forEach((node) => {
      if (node.type !== 'group') return
      const groupWidgetIds = new Set(node.children)
      node.children.forEach((widgetId) => {
        widgetGroupIds.set(widgetId, node.id)
        const widget = widgetById.get(widgetId)
        if (!widget?.parentId || !groupWidgetIds.has(widget.parentId)) return
        // 子组件只有在同一视觉分组中才以内嵌层级显示；跨视觉分组时保留真实 parentId，
        // 但把它投影为新分组的根成员，避免旧分组中出现重复节点。
        const children = childrenMap.get(widget.parentId) || []
        children.push(widgetId)
        childrenMap.set(widget.parentId, children)
      })
    })
    sceneWidgetStore.getOrderedWidgets().forEach((widget) => {
      if (!widget.parentId) return
      if (widgetGroupIds.has(widget.id)) return
      const children = childrenMap.get(widget.parentId) || []
      children.push(widget.id)
      childrenMap.set(widget.parentId, children)
    })
    return childrenMap
  })

  /**
   * 反向索引必须由展示用 childrenMap 派生：跨视觉分组的组件虽保留真实 parentId，
   * 在结构列表中却是新分组的根成员，自动展开时应沿用户实际看到的分支定位。
   * 索引仅在父子结构或图层顺序变化时重建，选中切换不扫描全部组件。
   */
  const structureWidgetParentMap = computed(() => {
    const parentMap = new Map<string, string>()
    widgetChildrenMap.value.forEach((childIds, parentId) => {
      childIds.forEach((childId) => parentMap.set(childId, parentId))
    })
    return parentMap
  })

  /**
   * 使用原始选中态计算路径，不能使用 selectedStructureWidgetIds 的组成员高亮投影，
   * 否则选中一个分组会误把其全部子树展开。结构列表内选择和空选择返回空路径，
   * 根分组与递归组件因此只更新高亮，保留已有手动展开状态，也无需重新查询祖先。
   */
  const structureSelectionExpansion = computed<StructureSelectionExpansion | null>(() => {
    if (sceneWidgetStore.currentWidgetSelectionSource === 'structure') return null

    const selectedEntries: StructureSelectionEntry[] = [
      ...(sceneWidgetStore.currentWidgetsIds || [])
        .filter((id) => widgetEntryMap.value.has(id))
        .map((id) => ({ id, type: 'widget' as const })),
      ...(sceneWidgetStore.currentWidgetGroupIds || [])
        .filter((id) => widgetGroupMap.value.has(id))
        .map((id) => ({ id, type: 'group' as const })),
    ]
    if (!selectedEntries.length) return null

    const ancestors = resolveStructureSelectionExpansion(selectedEntries, (entry) => {
      if (entry.type === 'widget') {
        const parentWidgetId = structureWidgetParentMap.value.get(entry.id)
        if (parentWidgetId) return { id: parentWidgetId, type: 'widget' }
        const parentGroupId = sceneWidgetStore.getWidgetParentGroupId(entry.id)
        return parentGroupId ? { id: parentGroupId, type: 'group' } : null
      }
      const parentGroupId = sceneWidgetStore.getWidgetGroupParentGroupId(entry.id)
      return parentGroupId ? { id: parentGroupId, type: 'group' } : null
    })

    return {
      ...ancestors,
      frameId: sceneWidgetStore.currentWidgetChildSelection?.frameId || null,
    }
  })
  provide(STRUCTURE_SELECTION_EXPANSION_KEY, structureSelectionExpansion)

  watch(
    structureSelectionExpansion,
    (expansion) => {
      if (!expansion) return
      // 切到二维组件分类并只保留其选中路径；模型/三维组件分组的展开状态相互独立。
      activeStructureCategory.value = 'widget'
      expandedGroupIds.value = [
        ...expandedGroupIds.value.filter((id) => !widgetGroupMap.value.has(id)),
        ...expansion.groupIds,
      ]
    },
    { immediate: true },
  )

  const filteredWidgetLayerNodes = computed<WidgetLayerNode[]>(() => {
    return filterWidgetLayerNodes(
      searchKeyword.value,
      visibleWidgetLayerTree.value,
      widgetEntryMap.value,
      widgetGroupMap.value,
    )
  })

  /** 分组选中时同步投影其全部成员，让父分组和内部组件显示为同一组选中结果。 */
  const selectedStructureWidgetIds = computed(() => {
    const selectedWidgetIds = sceneWidgetStore.currentWidgetsIds || []
    const selectedGroupIds = sceneWidgetStore.currentWidgetGroupIds || []
    return Array.from(
      new Set([
        ...selectedWidgetIds,
        ...selectedGroupIds.flatMap((groupId) => sceneWidgetStore.getGroupWidgetIds(groupId)),
      ]),
    )
  })

  const widgetLayerNodeCount = computed(() =>
    sceneWidgetStore.widgetLayerTree.reduce(
      (total, node) => total + (node.type === 'group' ? 1 + node.children.length : 1),
      0,
    ),
  )

  /**
   * 各结构分类使用 Figma 提供的成对状态图标。
   * 图标地址在计算结果中保持稳定，模板只按当前分类选择一次，避免通过滤镜实时改色导致边缘失真。
   * 三维组件直接复用系统资源“装饰”入口的定位图标；结构面板由本地三维和 GIS 场景共用，
   * 因此在此唯一配置源中替换即可保证两种场景的默认态和选中态保持一致。
   */
  const structureCategoryItems = computed(() => [
    {
      label: '模型',
      value: 'model' as const,
      icon: structureModelDefaultIcon,
      activeIcon: structureModelActiveIcon,
      count: sceneObjectCategoryCounts.value.model,
    },
    {
      label: '二维组件',
      value: 'widget' as const,
      icon: structureWidgetDefaultIcon,
      activeIcon: structureWidgetActiveIcon,
      count: widgetLayerNodeCount.value,
    },
    {
      label: '三维组件',
      value: 'three-dimensional-component' as const,
      icon: structureThreeDimensionalComponentDefaultIcon,
      activeIcon: structureThreeDimensionalComponentActiveIcon,
      count: sceneObjectCategoryCounts.value['three-dimensional-component'],
    },
    ...(showVegetationCategory.value ? [{
      label: '种植区域',
      value: 'vegetation' as const,
      iconComponent: Connection,
      count: vegetationRegions.value.length,
    }] : []),
  ])

  watch(
    () => sceneWidgetStore.widgetLayerTree,
    () => {
      /**
       * 树更新只清理已删除节点的展开状态，不依据 ID 差异自动展开。
       * 首次加载和场景切换因此都保持折叠；用户新建分组由各创建入口显式展开，反馈不受影响。
       */
      expandedGroupIds.value = syncExpandedGroupIds(
        expandedGroupIds.value,
        sceneWidgetStore.widgetLayerTree,
      )
    },
    {
      deep: true,
      immediate: true,
    },
  )

  const isGroupExpanded = (groupId: string) => expandedGroupIds.value.includes(groupId)

  const toggleGroupExpanded = (groupId: string) => {
    expandedGroupIds.value = resolveNextExpandedStructureGroups(expandedGroupIds.value, groupId)
  }

  const hideContextMenu = () => {
    contextMenu.value = createHiddenStructureContextMenuState()
  }

  watch(activeStructureCategory, () => {
    hideContextMenu()
    searchValue.value = ''
    structureSelectionAnchor.value = null
  })

  /**
   * 菜单挂到 body 后，不能再用写死宽高去推测边界。
   * 这里在菜单实际渲染完成后读取真实尺寸，再做一次窗口内收口：
   * - 普通场景下保持紧贴右键位置；
   * - 只有靠近视口边缘时才向内偏移。
   */
  const adjustContextMenuPosition = async () => {
    if (!contextMenu.value.visible) return
    await nextTick()
    const menuElement = contextMenuRef.value
    if (!menuElement) return

    const padding = 12
    const nextPosition = adjustStructureContextMenuPosition(
      { x: contextMenu.value.x, y: contextMenu.value.y },
      { width: window.innerWidth, height: window.innerHeight },
      { width: menuElement.offsetWidth, height: menuElement.offsetHeight },
      padding,
    )

    contextMenu.value.x = nextPosition.x
    contextMenu.value.y = nextPosition.y
  }

  /**
   * 右键菜单挂到 body 后，需要由全局指针事件负责点外关闭。
   * 这里使用捕获阶段，确保先于结构树、画布等局部点击逻辑执行，不留下“点击别处菜单不消失”的残留状态。
   */
  const handleGlobalPointerDown = (event: PointerEvent) => {
    if (!contextMenu.value.visible) return
    /**
     * 这里不能只依赖 target + contains：
     * 菜单通过 teleport 挂到 body 后，图标图片、按钮、文字等子节点都可能成为真实事件源。
     * 改为判断完整传播路径里是否包含菜单根节点，只有点到菜单外部时才关闭弹窗。
     */
    const eventPath = typeof event.composedPath === 'function' ? event.composedPath() : []
    if (contextMenuRef.value && eventPath.includes(contextMenuRef.value)) return
    hideContextMenu()
  }

  const clearStructureSelection = () => {
    hideContextMenu()
    store.setCurrentObjectLayerId(null)
    store.setSelectedThreeMapObjectId(null)
    structureSelectionAnchor.value = null
    selectedSceneObjectIds.value = new Set()

    /**
     * F008 空白点击以 SceneStore 清选为准。
     * 旧运行时清理只负责马上卸掉视口高亮，Store 写入负责驱动对象树和属性面板一致为空。
     */
    void clearEditorSceneSelection({
      store: scenePlatformStore.value,
      bridge: scenePlatformBridge.value,
      getLegacySelectedObjectId: () => store.currentTransformMaterialUuid || null,
      setLegacySelectedObjectId: (objectId) => store.setCurrentTransformMaterialUuid(objectId),
      clearLegacySceneObjectSelection: () => getWidgetRuntimePort().clearSceneObjectSelection(),
      clearWidgetSelection: () => sceneWidgetStore.clearCurrentWidgetSelection(),
    }).catch((error) => {
      appLogger.warn('StructurePanel', '清除场景选中态失败', error)
    })
  }

  const clearSelectionFromBlank = (event: MouseEvent) => {
    if (activeStructureCategory.value !== 'vegetation' && event.target === event.currentTarget) {
      clearStructureSelection()
    }
  }

  const clearVegetationSelectionFromBlank = (event: MouseEvent) => {
    if (activeStructureCategory.value !== 'vegetation') return
    const target = event.target
    if (!(target instanceof Element) ||
      target.closest('[data-structure-item], .el-input, .el-scrollbar__bar, button')) return
    vegetationStructure?.clearRegionSelection()
  }

  const selectVegetationRegion = (id: string) => {
    if (!vegetationStructure || vegetationSelectionDisabled.value) return
    clearStructureSelection()
    vegetationStructure.openRegion(id)
  }

  /**
   * 结构树中的模型选择统一走渲染层适配函数。
   * 组件这里只负责响应 UI 事件，不再直接读取场景对象和变换控制器实例。
   */
  const chooseMesh = (item: SceneAllContentsItem) => {
    const selectedSceneObject = scenePlatformStore.value?.getObject(item.uuid)
    const isThreeMap = selectedSceneObject?.effect?.type === 'three-map'
    /**
     * 中国 3D 地图没有旧 Mesh。必须在异步 flush 之前先写入编辑态，否则本地三维 Runtime
     * 同步高亮时会把 Pinia uuid 清掉，结构树只闪一下就回到未选中。
     */
    if (isThreeMap) {
      store.setCurrentTransformMaterialUuid(item.uuid)
      store.setSelectedThreeMapObjectId(item.uuid)
    } else {
      store.setSelectedThreeMapObjectId(null)
    }
    /**
     * 结构树记录的是 SceneObject.id，旧 Three 选择函数只接受 Object3D.uuid。
     * 优先从活动 Runtime 的双向映射取引擎标识；尚未完成迁移的存量对象仍使用原 uuid。
     */
    const legacyObjectId =
      resolveEditorLegacyEngineObjectId(getActiveSceneViewportHost()?.getRuntime(), item.uuid) ??
      item.uuid

    void selectEditorSceneObject({
      store: scenePlatformStore.value,
      bridge: scenePlatformBridge.value,
      objectId: item.uuid,
      selectLegacySceneObject: isThreeMap
        ? undefined
        : () => selectSceneContentByUuid(legacyObjectId),
      setLegacySelectedObjectId: (objectId) =>
        store.setCurrentTransformMaterialUuid(
          resolveEditorLegacyEngineObjectId(getActiveSceneViewportHost()?.getRuntime(), objectId) ??
            objectId,
        ),
      clearWidgetSelection: () => sceneWidgetStore.clearCurrentWidgetSelection(),
    })
      .then((selection) => {
        if (selection.status !== 'applied') return
        if (!isThreeMap) {
          store.setSelectedThreeMapObjectId(null)
          return
        }
        store.setCurrentTransformMaterialUuid(item.uuid)
        store.setSelectedThreeMapObjectId(item.uuid)
        store.setTransformMaterialRandomId()
      })
      .catch((error) => {
        appLogger.warn('StructurePanel', '结构树选择模型失败', item.uuid, error)
      })
  }

  /**
   * 双击聚焦同样下沉到渲染层，避免组件自己拼接“选中 + 高亮 + 相机聚焦”的组合逻辑。
   */
  const focusMesh = (item: SceneAllContentsItem) => {
    const host = getActiveSceneViewportHost()
    if (host?.getStore().getObject(item.uuid)) {
      /**
       * 已迁移对象直接调用统一 Runtime 聚焦，不经过旧 sceneModules。
       * Runtime 内部自行处理 Three/Cesium 差异，结构树无需持有引擎对象或相机引用。
       */
      void host
        .getRuntime()
        .frame({ objectId: item.uuid })
        .catch((error) => {
          appLogger.warn('StructurePanel', '平台对象聚焦失败', item.uuid, error)
        })
      return
    }

    // 未映射的历史对象继续使用旧聚焦入口，避免存量场景双击后失去相机定位能力。
    focusSceneContentByUuid(item.uuid)
  }

  /**
   * 切换部件选择前，需要先把模型变换器与材质高亮状态清空。
   * 否则用户从 3D 模型切到部件树时，编辑器仍可能错误保留模型选中外观。
   */
  const resetSelectionBeforeWidgetPick = () => {
    store.setCurrentObjectLayerId(null)
    getWidgetRuntimePort().clearSceneObjectSelection()
  }

  /**
   * 读取当前结构树中真实可见的组件和分组行顺序。
   * 两类节点都由结构项写入稳定 data 属性，查询 DOM 可以同时覆盖根节点、分组成员和递归子组件，
   * 并自然遵守分组展开状态与搜索裁剪结果。
   */
  const getVisibleStructureSelectionEntries = (event: MouseEvent) => {
    if (typeof Element === 'undefined') return []
    const eventElement =
      event.currentTarget instanceof Element
        ? event.currentTarget
        : event.target instanceof Element
          ? event.target
          : null
    const panel = eventElement?.closest<HTMLElement>('.scene-edit-structure-panel')
    if (!panel) return []

    const entries: StructureSelectionEntry[] = []
    panel
      .querySelectorAll<HTMLElement>('[data-widget-row-id], [data-structure-group-id]')
      .forEach((row) => {
        if (row.dataset.widgetRowId) {
          entries.push({ id: row.dataset.widgetRowId, type: 'widget' })
        } else if (row.dataset.structureGroupId) {
          entries.push({ id: row.dataset.structureGroupId, type: 'group' })
        }
      })
    return entries
  }

  /**
   * 将范围内的分组展开为全部成员，同时保留分组本身的选中态。
   * 这样单击分组仍可使用现有整组变换代理，范围选择则能让父分组和内部组件一起高亮。
   * 所有结构选择入口显式标记来源，选择只改变高亮，不刷新节点展开状态。
   */
  const applyStructureSelectionRange = (entries: StructureSelectionEntry[], ctrlKey: boolean) => {
    const selectedGroupIds = entries
      .filter((entry) => entry.type === 'group')
      .map((entry) => entry.id)
    const selectedWidgetIds = entries
      .filter((entry) => entry.type === 'widget')
      .map((entry) => entry.id)
    const currentWidgetIds = ctrlKey ? sceneWidgetStore.currentWidgetsIds || [] : []
    const currentGroupIds = ctrlKey ? sceneWidgetStore.currentWidgetGroupIds || [] : []
    const nextGroupIds = Array.from(new Set([...currentGroupIds, ...selectedGroupIds]))
    const nextWidgetIds = Array.from(
      new Set([
        ...currentWidgetIds,
        ...selectedWidgetIds,
        ...nextGroupIds.flatMap((groupId) => sceneWidgetStore.getGroupWidgetIds(groupId)),
      ]),
    )

    if (nextGroupIds.length || ctrlKey) {
      sceneWidgetStore.setCurrentWidgetMixedSelection(nextWidgetIds, nextGroupIds, 'structure')
    } else {
      sceneWidgetStore.setCurrentWidgetsIds(nextWidgetIds, 'structure')
    }
  }

  const selectStructureRange = (
    targetEntry: StructureSelectionEntry,
    ctrlKey: boolean,
    event: MouseEvent,
  ) => {
    const rangeEntries = resolveStructureSelectionRange(
      getVisibleStructureSelectionEntries(event),
      structureSelectionAnchor.value,
      targetEntry,
    )
    if (!rangeEntries) return false

    hideContextMenu()
    resetSelectionBeforeWidgetPick()
    applyStructureSelectionRange(rangeEntries, ctrlKey)
    return true
  }

  const chooseWidget = (id: string, event: MouseEvent) => {
    if (!isPrimaryStructureMouseButton(event)) return

    const targetEntry: StructureSelectionEntry = { id, type: 'widget' }
    if (event.shiftKey && selectStructureRange(targetEntry, event.ctrlKey, event)) return

    resetSelectionBeforeWidgetPick()

    /**
     * 多选只对部件生效，并保持 Windows 的 Ctrl 增量语义；Shift 范围由上面的统一结构行入口处理。
     * 具体集合计算交给纯函数或范围应用函数，组件层只负责把结果写回 Store。
     */
    const currentIds = sceneWidgetStore.currentWidgetsIds || []
    const nextWidgetIds = resolveNextStructureWidgetSelection(currentIds, id, event.ctrlKey)
    if (event.ctrlKey) {
      sceneWidgetStore.setCurrentWidgetMixedSelection(
        nextWidgetIds,
        sceneWidgetStore.currentWidgetGroupIds || [],
        'structure',
      )
    } else {
      sceneWidgetStore.setCurrentWidgetsIds(nextWidgetIds, 'structure')
    }
    structureSelectionAnchor.value = targetEntry
  }

  const chooseGroup = (groupId: string) => {
    hideContextMenu()
    structureSelectionAnchor.value = { id: groupId, type: 'group' }
    resetSelectionBeforeWidgetPick()
    sceneWidgetStore.setCurrentWidgetGroupId(groupId, 'structure')
  }

  const selectItem = (item: StructureSceneObjectItem, event: MouseEvent) => {
    if (editorSceneOperation.value) return
    structureSelectionAnchor.value = null
    store.setCurrentObjectLayerId(null)
    const platform = scenePlatformStore.value
    if ((event.ctrlKey || event.metaKey) && platform?.getObject(item.id)) {
      const selected = platform.getSelectedObjectId()
      const next = new Set(selectedSceneObjectIds.value.size ? selectedSceneObjectIds.value : selected ? [selected] : [])
      if (next.has(item.id)) next.delete(item.id)
      else next.add(item.id)
      selectedSceneObjectIds.value = next
      if (next.size && (!selected || !next.has(selected))) {
        const primary = next.values().next().value
        const row = allSceneContents.value.find((entry) => entry.uuid === primary)
        if (row) chooseMesh(row)
      } else if (!next.size) {
        platform.setSelectedObjectId(null)
        store.setCurrentTransformMaterialUuid(null)
        store.setSelectedThreeMapObjectId(null)
      }
      return
    }
    selectedSceneObjectIds.value = new Set()
    chooseMesh(item.raw)
  }
  const focusItem = (item: StructureSceneObjectItem) => {
    focusMesh(item.raw)
  }

  const selectWidgetFromNode = ({ event, widgetId }: { event: MouseEvent; widgetId: string }) => {
    hideContextMenu()
    const currentIds = sceneWidgetStore.currentWidgetsIds || []
    widgetSelectionBeforePointerDown.value =
      !event.ctrlKey && !event.shiftKey && currentIds.length > 1 && currentIds.includes(widgetId)
        ? [...currentIds]
        : []
    chooseWidget(widgetId, event)
  }

  const selectWidgetChildFromNode = ({
    event,
    frameId,
    childId,
  }: {
    event: MouseEvent
    frameId: string
    childId: string
  }) => {
    if (!isPrimaryStructureMouseButton(event)) return
    hideContextMenu()
    structureSelectionAnchor.value = null
    resetSelectionBeforeWidgetPick()
    sceneWidgetStore.setCurrentWidgetChildSelection({ frameId, childId }, 'structure')
  }

  const updateWidgetChildState = (
    frameId: string,
    childId: string,
    key: 'visible' | 'locked',
    value: boolean,
  ) => {
    const frame = sceneWidgetStore.getWidgetById(frameId)
    if (!frame || frame.component.info.keyName !== 'VPageMenu') return
    if (key === 'visible' && sceneWidgetStore.isWidgetLocked(frameId)) return
    sceneWidgetStore.runWidgetHistoryChange(
      `更新页面框架子节点${key === 'visible' ? '显隐' : '锁定'}`,
      [frameId],
      () => {
        const option = normalizePageFrameOption(frame.component.option)
        const child = findPageFrameChild(option, childId)
        if (!child) return
        child[key] = value
        frame.component.option = option
        sceneWidgetStore.bumpWidgetRenderVersion(frameId)
      },
    )
  }

  const toggleWidgetChildVisible = (frameId: string, childId: string, visible: boolean) =>
    updateWidgetChildState(frameId, childId, 'visible', visible)

  const toggleWidgetChildLocked = (frameId: string, childId: string, locked: boolean) =>
    updateWidgetChildState(frameId, childId, 'locked', locked)

  const selectGroup = ({ event, groupId }: { event: MouseEvent; groupId: string }) => {
    if (!isPrimaryStructureMouseButton(event)) return
    const targetEntry: StructureSelectionEntry = { id: groupId, type: 'group' }
    if (event.shiftKey && selectStructureRange(targetEntry, event.ctrlKey, event)) return
    if (!event.ctrlKey) {
      chooseGroup(groupId)
      return
    }

    hideContextMenu()
    structureSelectionAnchor.value = null
    resetSelectionBeforeWidgetPick()
    const currentGroupIds = sceneWidgetStore.currentWidgetGroupIds || []
    sceneWidgetStore.setCurrentWidgetMixedSelection(
      sceneWidgetStore.currentWidgetsIds || [],
      currentGroupIds.includes(groupId)
        ? currentGroupIds.filter((id) => id !== groupId)
        : [...currentGroupIds, groupId],
      'structure',
    )
  }

  const openContextMenu = ({ event, groupId, widgetId }: WidgetMenuContextPayload) => {
    event.preventDefault()

    if (groupId) {
      chooseGroup(groupId)
      return
    }

    const currentIds = sceneWidgetStore.currentWidgetsIds || []
    if (shouldResetStructureContextSelection(widgetId, currentIds)) {
      /**
       * 右键单个部件时若该部件尚未被选中，需要先把当前选择切到它自身。
       * 这里直接按“非 Ctrl 单选”语义切换，避免伪造 MouseEvent 带来额外的开发态兼容风险。
       */
      resetSelectionBeforeWidgetPick()
      sceneWidgetStore.setCurrentWidgetsIds([widgetId!], 'structure')
      structureSelectionAnchor.value = { id: widgetId!, type: 'widget' }
    }

    const selectedWidgetIds = sceneWidgetStore.currentWidgetsIds || []
    const selectedGroupIds = sceneWidgetStore.currentWidgetGroupIds || []
    const canCreateSelectedGroup =
      selectedWidgetIds.length > 0 && selectedGroupIds.length > 0
        ? sceneWidgetStore.canCreateWidgetGroupFromMixedSelection(
            selectedWidgetIds,
            selectedGroupIds,
          )
        : sceneWidgetStore.canCreateWidgetGroup(selectedWidgetIds)
    contextMenu.value = createStructureContextMenuState(
      event,
      sceneWidgetStore.widgetLayerTree,
      selectedWidgetIds,
      canCreateSelectedGroup,
    )

    if (contextMenu.value.canCreateGroup) {
      void adjustContextMenuPosition()
    }
  }

  /** 根据当前两类选中态选择唯一成组入口，混合选择优先保持既有分组边界。 */
  const createGroupFromCurrentSelection = () => {
    const selectedWidgetIds = sceneWidgetStore.currentWidgetsIds || []
    const selectedGroupIds = sceneWidgetStore.currentWidgetGroupIds || []
    if (selectedWidgetIds.length && selectedGroupIds.length) {
      return sceneWidgetStore.createWidgetGroupFromMixedSelection(
        selectedWidgetIds,
        selectedGroupIds,
      )
    }
    if (selectedGroupIds.length > 1) {
      return sceneWidgetStore.createWidgetGroupFromGroups(selectedGroupIds)
    }
    if (selectedWidgetIds.length > 1) {
      return sceneWidgetStore.createWidgetGroup(selectedWidgetIds)
    }
    return null
  }

  const handleCreateGroup = () => {
    const selectedNodeCount =
      (sceneWidgetStore.currentWidgetsIds?.length || 0) +
      (sceneWidgetStore.currentWidgetGroupIds?.length || 0)
    if (selectedNodeCount < 2) {
      hideContextMenu()
      return
    }
    /**
     * 创建分组必须以 store 的真实返回值为准：
     * - 成功建组后再关闭菜单；
     * - 若后续因为同级校验等原因失败，则保留菜单，避免用户误以为“已经创建成功但没显示出来”。
     */
    const createdGroupId = createGroupFromCurrentSelection()
    if (!createdGroupId) return
    // 创建后立即展开新组，确保完整的组件子树可见，避免用户误以为操作没有生效。
    expandedGroupIds.value = Array.from(new Set([...expandedGroupIds.value, createdGroupId]))
    chooseGroup(createdGroupId)
    hideContextMenu()
  }

  /**
   * 标题栏入口兼容两种创建方式：有多个选中组件时直接成组，没有多选时创建空组。
   * 两种路径都在成功后展开新组并选中组节点，避免创建完成后用户看不到成员。
   */
  const createWidgetGroup = () => {
    const selectedNodeCount =
      (sceneWidgetStore.currentWidgetsIds?.length || 0) +
      (sceneWidgetStore.currentWidgetGroupIds?.length || 0)
    if (selectedNodeCount > 1) {
      const createdGroupId = createGroupFromCurrentSelection()
      if (!createdGroupId) return
      expandedGroupIds.value = Array.from(new Set([...expandedGroupIds.value, createdGroupId]))
      chooseGroup(createdGroupId)
      return
    }

    const createdGroupId = sceneWidgetStore.createEmptyWidgetGroup()
    if (!createdGroupId) return
    expandedGroupIds.value = Array.from(new Set([...expandedGroupIds.value, createdGroupId]))
    chooseGroup(createdGroupId)
  }

  /**
   * 分组行内不再提供重命名按钮，改为直接暴露组级启用开关。
   * 名称编辑统一收口到右侧分组基础面板，结构树这里只负责批量显隐。
   */
  const toggleGroupVisible = (groupId: string) => {
    sceneWidgetStore.setGroupVisible(groupId, !sceneWidgetStore.getGroupVisible(groupId))
  }

  const toggleWidgetLocked = (widgetId: string, locked: boolean) => {
    sceneWidgetStore.setWidgetLocked(widgetId, locked)
  }

  const toggleWidgetGroupLocked = (groupId: string, locked: boolean) => {
    sceneWidgetStore.setWidgetGroupLocked(groupId, locked)
  }

  /** 删除视觉分组只让成员回根，组件实例与配置均由 Store 原样保留。 */
  const deleteWidgetGroup = (groupId: string) => {
    if (sceneWidgetStore.isWidgetGroupLocked(groupId)) return
    sceneWidgetStore.deleteWidgetGroup(groupId)
    hideContextMenu()
  }

  const moveWidgetToGroup = (widgetId: string, groupId: string, targetIndex?: number) => {
    // 自定义落点已提交时忽略拖拽库下一微任务补发的 change，避免生成两条历史。
    if (widgetNestingHandled.value || widgetDropHandled.value) return
    sceneWidgetStore.moveWidgetToGroup(widgetId, groupId, targetIndex)
  }

  const clearWidgetHierarchyHoverIntent = () => {
    widgetHierarchyHoverCandidateId.value = ''
    widgetHierarchyDropTargetId.value = ''
  }

  const clearWidgetSortGapIntent = () => {
    widgetSortGapTarget.value = null
  }

  /**
   * 原生子节点与根列表共用真实行的落点。整行按上下半区排序，中央持续悬停后切换为挂载。
   * 快速拖放始终能调整顺序；单次遍历选择空白处最近边缘，并忽略拖拽子树。
   */
  const handleGlobalWidgetDragOver = (event: DragEvent) => {
    if (!draggedWidgetIds.value.length && !draggedGroupId.value) return
    /**
     * 捕获阶段的 event.target 仍指向本次拖拽真正经过的组件行，应优先使用它。
     * SortableJS 换位后，elementFromPoint 可能命中已经移动到指针下方的拖动项自身，
     * 这会让中央悬停候选丢失，表现为只能排序、无法稳定拖成子组件。
     */
    const pointedElement =
      event.target instanceof Element
        ? event.target
        : document.elementFromPoint(event.clientX, event.clientY)
    const panel = pointedElement?.closest('.scene-edit-structure-panel')
    if (draggedGroupId.value) {
      const groupRow = panel
        ? pointedElement?.closest<HTMLElement>('[data-structure-group-id]')
        : null
      const targetGroupId = groupRow?.dataset.structureGroupId || ''
      const rect = groupRow?.getBoundingClientRect()
      const center = rect && (event.clientY - rect.top) / rect.height
      const invalidTarget =
        !targetGroupId ||
        targetGroupId === draggedGroupId.value ||
        sceneWidgetStore
          .getWidgetGroupDescendantIds(draggedGroupId.value)
          .includes(targetGroupId) ||
        [targetGroupId, ...sceneWidgetStore.getWidgetGroupAncestorIds(targetGroupId)].some(
          sceneWidgetStore.isWidgetGroupLocked,
        )
      widgetGroupDropTargetId.value =
        !invalidTarget && center !== undefined && center > 0.25 && center < 0.75
          ? targetGroupId
          : ''
      const layerRow = panel
        ? pointedElement?.closest<HTMLElement>('[data-structure-layer-id]')
        : null
      const relatedId = layerRow?.dataset.structureLayerId || ''
      const layerRect = layerRow?.getBoundingClientRect()
      const sortRect = groupRow && targetGroupId === relatedId ? rect : layerRect
      widgetGroupSortGapTarget.value =
        !widgetGroupDropTargetId.value &&
        (!groupRow || targetGroupId === relatedId) &&
        relatedId &&
        relatedId !== draggedGroupId.value &&
        sortRect
          ? {
              relatedId,
              placement: event.clientY < sortRect.top + sortRect.height / 2 ? 'before' : 'after',
            }
          : null
      if (widgetGroupDropTargetId.value || widgetGroupSortGapTarget.value) event.preventDefault()
      return
    }
    const clearIntent = () => {
      clearWidgetHierarchyHoverIntent()
      clearWidgetSortGapIntent()
    }
    if (!panel) {
      clearIntent()
      return
    }
    const excludedIds = new Set(draggedWidgetIds.value)
    draggedWidgetIds.value.forEach((id) => {
      sceneWidgetStore.getWidgetDescendantIds(id).forEach((childId) => excludedIds.add(childId))
    })
    const row = pointedElement?.closest<HTMLElement>('[data-widget-row-id]')
    if (row && !excludedIds.has(row.dataset.widgetRowId!)) {
      const rect = row.getBoundingClientRect()
      const relatedWidgetId = row.dataset.widgetRowId!
      const hierarchyTarget = resolveWidgetHierarchyDropTarget(
        {
          relatedContext: { element: { id: relatedWidgetId, type: 'widget' } },
          relatedRect: rect,
        },
        { clientY: event.clientY, target: row },
        draggedWidgetIds.value,
      )
      if (hierarchyTarget) {
        enterWidgetHierarchyHoverTarget(hierarchyTarget)
      } else {
        clearWidgetHierarchyHoverIntent()
        widgetSortGapTarget.value = {
          relatedWidgetId,
          placement: resolveWidgetSortPlacement(event.clientY, rect),
        }
      }
      event.preventDefault()
      return
    }
    let nearest: { relatedWidgetId: string; placement: 'before' | 'after' } | null = null
    let distance = 12
    panel.querySelectorAll<HTMLElement>('[data-widget-row-id]').forEach((element) => {
      const id = element.dataset.widgetRowId!
      if (element.offsetParent === null || excludedIds.has(id)) return
      const rect = element.getBoundingClientRect()
      const beforeDistance = Math.abs(event.clientY - rect.top)
      const afterDistance = Math.abs(event.clientY - rect.bottom)
      const edgeDistance = Math.min(beforeDistance, afterDistance)
      if (edgeDistance <= distance) {
        distance = edgeDistance
        nearest = {
          relatedWidgetId: id,
          placement: resolveWidgetSortPlacement(event.clientY, rect),
        }
      }
    })
    clearWidgetHierarchyHoverIntent()
    widgetSortGapTarget.value = nearest
    // 行间也要允许原生放下，否则子节点的原生拖拽会被浏览器判为无效目标。
    if (nearest) event.preventDefault()
  }

  const enterWidgetHierarchyHoverTarget = (targetWidgetId: string) => {
    if (widgetHierarchyHoverCandidateId.value === targetWidgetId) return
    /**
     * 中央区域是明确的“成为子组件”落点，进入后立即激活，用户无需停留等待。
     * 排序仍由上下四分之一区域承担，两种操作通过位置区分，避免依赖操作速度。
     */
    widgetHierarchyHoverCandidateId.value = targetWidgetId
    widgetHierarchyDropTargetId.value = targetWidgetId
    widgetSortGapTarget.value = null
  }

  const handleWidgetDragStart = (widgetId: string) => {
    if (!widgetId) return
    const selectedIds = sceneWidgetStore.currentWidgetsIds || []
    const dragSelection = widgetSelectionBeforePointerDown.value.includes(widgetId)
      ? widgetSelectionBeforePointerDown.value
      : selectedIds
    draggedWidgetIds.value = dragSelection.includes(widgetId) ? [...dragSelection] : [widgetId]
    draggedGroupId.value = ''
    widgetGroupDropTargetId.value = ''
    widgetGroupSortGapTarget.value = null
    widgetNestingHandled.value = false
    widgetDropHandled.value = false
    clearWidgetHierarchyHoverIntent()
    clearWidgetSortGapIntent()
  }

  const handleWidgetSortableStart = (event: { item?: HTMLElement }) => {
    const groupId = event.item?.querySelector<HTMLElement>('[data-structure-group-id]')?.dataset
      .structureGroupId
    if (groupId) {
      draggedGroupId.value = groupId
      draggedWidgetIds.value = []
      widgetGroupDropTargetId.value = ''
      widgetGroupSortGapTarget.value = null
      widgetDropHandled.value = false
      clearWidgetHierarchyHoverIntent()
      clearWidgetSortGapIntent()
      return
    }
    const widgetId = event.item?.dataset.widgetId
    if (widgetId) handleWidgetDragStart(widgetId)
  }

  const handleWidgetDragEnd = () => {
    if (draggedGroupId.value) {
      const targetGroupId = widgetGroupDropTargetId.value
      if (targetGroupId) {
        widgetDropHandled.value = sceneWidgetStore.moveWidgetGroupToGroup(
          draggedGroupId.value,
          targetGroupId,
          0,
        )
        if (widgetDropHandled.value) {
          expandedGroupIds.value = Array.from(new Set([...expandedGroupIds.value, targetGroupId]))
        }
      } else if (widgetGroupSortGapTarget.value) {
        const { relatedId, placement } = widgetGroupSortGapTarget.value
        const sourceIndex = visibleWidgetLayerTree.value.findIndex(
          (node) => node.id === draggedGroupId.value,
        )
        const relatedIndex = visibleWidgetLayerTree.value.findIndex((node) => node.id === relatedId)
        if (sourceIndex >= 0 && relatedIndex >= 0) {
          const targetIndex = relatedIndex + (placement === 'after' ? 1 : 0)
          widgetDropHandled.value = sceneWidgetStore.moveWidgetLayerNodeAtRoot(
            draggedGroupId.value,
            targetIndex - (sourceIndex < targetIndex ? 1 : 0),
          )
        }
      }
    } else if (widgetHierarchyDropTargetId.value && !widgetNestingHandled.value) {
      moveDraggedWidgetsUnderParent(widgetHierarchyDropTargetId.value)
    } else if (widgetSortGapTarget.value && !widgetNestingHandled.value) {
      widgetDropHandled.value = sceneWidgetStore.moveWidgetsAroundWidget(
        draggedWidgetIds.value,
        widgetSortGapTarget.value.relatedWidgetId,
        widgetSortGapTarget.value.placement === 'after',
      )
    } else if (widgetNestingHandled.value) {
      widgetDropHandled.value = true
    }
    draggedWidgetIds.value = []
    draggedGroupId.value = ''
    widgetGroupDropTargetId.value = ''
    widgetGroupSortGapTarget.value = null
    widgetSelectionBeforePointerDown.value = []
    widgetNestingHandled.value = false
    clearWidgetHierarchyHoverIntent()
    clearWidgetSortGapIntent()
    // vuedraggable 在下一微任务才发出 change；让防重标记跨过该回调后再释放。
    void nextTick(() => {
      widgetDropHandled.value = false
    })
  }

  /** 拖到组件行本身时建立父子关系；多选集合由拖拽开始时的稳定快照决定。 */
  const moveDraggedWidgetsUnderParent = (targetWidgetId: string) => {
    if (!draggedWidgetIds.value.length || draggedWidgetIds.value.includes(targetWidgetId)) return
    widgetNestingHandled.value = sceneWidgetStore.moveWidgetsUnderParent(
      draggedWidgetIds.value,
      targetWidgetId,
    )
    widgetDropHandled.value = widgetNestingHandled.value
  }

  const handleWidgetRootDragChange = (event: {
    added?: { element?: WidgetLayerNode; newIndex?: number }
    moved?: { element?: WidgetLayerNode; newIndex?: number }
  }) => {
    if (widgetNestingHandled.value || widgetDropHandled.value) return
    /**
     * 跨容器拖入根级时，只有目标根列表的 added 负责写归属；源分组的 removed 被忽略。
     * 根级内部排序则由 moved 提交。两种分支都只调用一个 Store 动作，保证单次拖拽只写一条历史。
     */
    const added = event.added?.element
    if (added?.type === 'widget') {
      sceneWidgetStore.moveWidgetToGroup(added.id, null, event.added?.newIndex)
      return
    }

    const moved = event.moved?.element
    if (moved) sceneWidgetStore.moveWidgetLayerNodeAtRoot(moved.id, event.moved?.newIndex)
  }

  const canMoveWidget = (
    event: WidgetSortableMoveEvent,
    originalEvent?: {
      clientX?: number
      clientY?: number
      target?: EventTarget | null
      touches?: ArrayLike<{ clientY: number }>
    },
  ) => {
    const node = event.draggedContext?.element
    if (!node) return true
    const movable =
      node.type === 'widget'
        ? !sceneWidgetStore.isWidgetLocked(node.id)
        : ![node.id, ...sceneWidgetStore.getWidgetGroupAncestorIds(node.id)].some(
            sceneWidgetStore.isWidgetGroupLocked,
          )
    if (!movable || node.type !== 'widget') {
      clearWidgetHierarchyHoverIntent()
      clearWidgetSortGapIntent()
      return movable && node.type !== 'group'
    }

    const hoverTargetWidgetId = resolveWidgetHierarchyDropTarget(
      event,
      originalEvent,
      draggedWidgetIds.value,
    )
    if (!hoverTargetWidgetId) {
      /**
       * 指针离开中央挂载区时立即释放旧候选。排序位置由全局拖拽事件记录，
       * 松手后再一次性写入 Store，拖动过程中不实时搬动节点。
       */
      clearWidgetHierarchyHoverIntent()
      /**
       * 捕获阶段已经命中组件行时，排序线会保存最终落点；即使排序库本次没有提供
       * relatedContext，也必须冻结实时换位。只有拖到空容器时才允许跨容器接管。
       */
      return !widgetSortGapTarget.value && event.relatedContext?.element?.type !== 'widget'
    }

    /**
     * 进入组件行时始终冻结排序库的实时换位：鼠标从行外进入中央前必然先经过边缘，
     * 若边缘立即换位，拖动项会挡住目标行，最终出现虚线提示却无法挂载的问题。
     * 全局拖拽处理会持续记录最终落点，松手时中央挂载、上下边缘排序。
     */
    enterWidgetHierarchyHoverTarget(hoverTargetWidgetId)
    return false
  }

  /**
   * 删除禁用状态按分组树一次性预计算，渲染每个分组时只做 Set 查询。
   * 这也保证搜索结果裁剪子节点后，仍能看到完整分组中未展示成员的锁定状态。
   */
  const widgetGroupDeleteDisabledIds = computed(
    () =>
      new Set(
        sceneWidgetStore.widgetLayerTree
          .filter(
            (node): node is Extract<WidgetLayerNode, { type: 'group' }> => node.type === 'group',
          )
          .filter(
            (group) =>
              sceneWidgetStore.isWidgetGroupTransformLocked(group.id) ||
              sceneWidgetStore
                .getGroupWidgetIds(group.id)
                .some((widgetId) => sceneWidgetStore.isWidgetLocked(widgetId)),
          )
          .map((group) => group.id),
      ),
  )

  const isWidgetGroupDeleteDisabled = (group: Extract<WidgetLayerNode, { type: 'group' }>) =>
    widgetGroupDeleteDisabledIds.value.has(group.id)

  const canCreateBusinessGroup = computed(() => Boolean(localHierarchy.value && canEditHierarchyRows.value &&
    !searchKeyword.value && !hierarchySearchKeyword.value))
  const createBusinessGroup = async () => {
    const host = getActiveSceneViewportHost()
    if (!host || host.getStore() !== toRaw(scenePlatformStore.value) || !canCreateBusinessGroup.value) return
    const session = structureSceneSession
    const isActive = () => getActiveSceneViewportHost() === host && structureSceneSession === session
    try {
      const id = await createEditorUnityGroup(host, isActive)
      if (!id) return
      selectStructureCategory('model')
      store.setCurrentObjectLayerId(null)
      await nextTick()
      if (isActive()) revealSceneHierarchyObject(id)
    } catch (error) {
      ElMessage.warning(error instanceof Error ? error.message : '无法创建业务分组')
    }
  }

  /** 模型分组选中态写入主 Store，使左树与右侧分组属性面板消费同一数据源。 */
  const selectedModelGroupId = computed(() => store.currentObjectLayerId)
  const selectModelGroup = (groupId: string) => {
    selectedSceneObjectIds.value = new Set()
    store.setCurrentObjectLayerId(groupId)
    clearEditorSceneSelection({ store: scenePlatformStore.value })
    store.setCurrentTransformMaterialUuid(null)
  }

  /** 层级编辑只在可消费该合同的本地 Unity 草稿开放。 */
  let indexedHierarchyNodes: ReadonlyMap<string, SceneObject> | undefined
  const localHierarchy = computed(() => {
    void hierarchyIndexRevision.value
    const store = scenePlatformStore.value
    if (store?.getScene().type !== 'local3d' || !getActiveSceneViewportHost()?.getRuntime().id.startsWith('unity-')) {
      indexedHierarchyNodes = undefined
      return null
    }
    const index = buildSceneNodeIndex(store.getObjects())
    indexedHierarchyNodes = index.nodesById
    return index
  })
  const hierarchySelection = computed(() => {
    void scenePlatformStoreRevision.value
    const index = localHierarchy.value
    if (!index) return []
    const primary = scenePlatformStore.value?.getSelectedObjectId()
    const ids = selectedSceneObjectIds.value.size ? selectedSceneObjectIds.value : primary ? [primary] : []
    const nodes: SceneObject[] = []
    for (const id of ids) {
      const node = index.nodesById.get(id)
      if (!node || !isLocalHierarchyNode(node)) return []
      nodes.push(node)
    }
    return nodes
  })
  const selectedHierarchyNode = computed(() => hierarchySelection.value.length === 1 ? hierarchySelection.value[0] : undefined)
  const selectedHierarchyParent = computed(() => {
    const nodes = hierarchySelection.value
    const parent = nodes[0]?.parentInstanceId
    return nodes.length && nodes.every((node) => node.parentInstanceId === parent) ? parent ?? '' : undefined
  })
  const hierarchyParents = computed(() => {
    const index = localHierarchy.value
    const nodes = hierarchySelection.value
    if (!index || !nodes.length) return []
    // 所选子树和其后代不能成为整批的目标父级。
    const descendants = new Set<string>()
    const pending = nodes.map((node) => node.id)
    for (let i = 0; i < pending.length; i++) {
      const id = pending[i]!
      if (descendants.has(id)) continue
      descendants.add(id)
      for (const child of index.childrenByParent.get(id) ?? []) pending.push(child)
    }
    return [...index.nodesById.values()].filter((candidate) => isLocalHierarchyNode(candidate) && !descendants.has(candidate.id))
  })
  // 选择器和拖放都先冲刷待确认变换，再在同一会话内生成并确认一条层级命令。
  const runHierarchyMove = async (prepare: (platform: SceneStore) => SceneCommand | undefined) => {
    const host = getActiveSceneViewportHost()
    if (!host || host.getStore() !== toRaw(scenePlatformStore.value) || editorSceneOperation.value) return false
    const session = structureSceneSession
    try {
      const release = beginEditorSceneOperation('moveSceneNode')
      try {
        const current = () => getActiveSceneViewportHost() === host && structureSceneSession === session
        await host.getBridge().flush()
        if (!current()) return false
        const command = prepare(host.getStore())
        return command ? await runConfirmedEditorCommand(host, 'execute', command, current) : false
      } finally {
        release()
      }
    } catch (error) {
      ElMessage.warning(error instanceof Error ? error.message : '无法调整节点层级')
      return false
    }
  }
  const editSelectedHierarchy = (parent: string | undefined, shift?: number) => {
    const ids = hierarchySelection.value.map((node) => node.id)
    if (!ids.length) return
    return runHierarchyMove((platform) => {
      if (shift === undefined) return createMoveSceneNodesCommand(platform, ids, parent)
      const index = platform.getNodeIndex()
      const node = ids.length === 1 ? index.nodesById.get(ids[0]!) : undefined
      if (!node) return
      const siblings = (index.childrenByParent.get(node.parentInstanceId ?? '') ?? [])
        .filter((id) => node.parentInstanceId || index.nodesById.get(id)?.layerId === node.layerId)
      return createMoveSceneNodesCommand(platform, ids, node.parentInstanceId, siblings.indexOf(node.id) + shift)
    })
  }

  type HierarchyDragSource = { id: string; ids: string[]; session: number }
  const getHierarchyDragSource = (id: string): HierarchyDragSource | undefined => {
    const platform = scenePlatformStore.value
    const node = platform?.getObject(id)
    if (!hierarchyLayout.value || !canEditHierarchyRows.value || searchKeyword.value || hierarchySearchKeyword.value ||
      !node || !isLocalHierarchyNode(node) || platform?.isObjectEffectivelyLocked(id)) return
    // 已选中的行拖动整个批次，未选中的行仅拖动自身。
    const selected = selectedSceneObjectIds.value
    return { id, ids: selected.has(id) ? [...selected] : [id], session: structureSceneSession }
  }
  const getHierarchyDropError = (source: HierarchyDragSource, target: SceneHierarchyDropTarget) => {
    const platform = scenePlatformStore.value
    if (!platform || structureSceneSession !== source.session || editorSceneOperation.value) return '拖动已失效'
    try {
      resolveSceneHierarchyDrop(platform, source.ids, target)
    } catch (error) {
      return error instanceof Error ? error.message : '无法拖到此处'
    }
  }
  const dropHierarchyNodes = async (source: HierarchyDragSource, target: SceneHierarchyDropTarget) => {
    if (structureSceneSession !== source.session || searchKeyword.value || hierarchySearchKeyword.value) return
    const moved = await runHierarchyMove((platform) => {
      const { parentId, siblingIndex } = resolveSceneHierarchyDrop(platform, source.ids, target)
      return createMoveSceneNodesCommand(platform, source.ids, parentId, siblingIndex)
    })
    if (moved && structureSceneSession === source.session && target.kind === 'node' && target.placement === 'inside') {
      expandedSceneNodeIds.value.add(target.id)
    }
  }
  const hasBusinessHierarchy = computed(() =>
    !!localHierarchy.value && [...localHierarchy.value.parentById.values()].some(Boolean),
  )

  const handleModelMove = (objectId: string, layerId: string | null, targetIndex?: number) => {
    // 已启用业务父子关系时用同级命令调整，图层拖拽不会改写业务顺序。
    if (hasBusinessHierarchy.value) return
    const result = moveEditorSceneObjectToLayer({
      store: scenePlatformStore.value,
      commandBus: scenePlatformCommandBus.value,
      objectId,
      layerId,
      targetIndex,
    })
    if (result.status === 'applied') refreshScenePlatformStoreRevision()
  }

  type ModelDragChange = {
    added?: { element?: StructureSceneObjectItem; newIndex?: number }
    moved?: { element?: StructureSceneObjectItem; newIndex?: number }
  }

  const handleRootModelDragChange = (event: ModelDragChange) => {
    /** 跨组由目标列表的 added 提交，同组由 moved 提交；removed 不写 Store。 */
    const change = event.added || event.moved
    const objectId = change?.element?.id
    if (objectId) handleModelMove(objectId, null, change?.newIndex)
  }

  const handleModelGroupDragChange = (layerId: string, event: ModelDragChange) => {
    /** 归属和目标顺序必须从同一个 change 事件进入命令，确保一次拖拽只有一条历史。 */
    const change = event.added || event.moved
    const objectId = change?.element?.id
    if (objectId) handleModelMove(objectId, layerId, change?.newIndex)
  }

  const canMoveModel = (event: { draggedContext?: { element?: StructureSceneObjectItem } }) => {
    const item = event.draggedContext?.element
    return !hasBusinessHierarchy.value && (item ? !isModelLocked(item) : true)
  }

  type ModelLayerDragChange = {
    moved?: { element?: StructureModelLayerGroup; oldIndex?: number; newIndex?: number }
  }

  /**
   * 重排当前分类可见的三维分组，同时保持另一分类专属分组和系统图层的相对槽位不变。
   * 完整图层序列交给单条平台命令提交，分组成员会随组一起调整数组缓存与渲染提交顺序。
   */
  const handleModelLayerDragChange = (event: ModelLayerDragChange) => {
    const moved = event.moved
    const movedLayerId = moved?.element?.id
    if (!movedLayerId || moved.newIndex === undefined) return

    const activeLayerIds = activeVisibleSceneObjectGroups.value.map((group) => group.id)
    const remainingActiveLayerIds = activeLayerIds.filter((layerId) => layerId !== movedLayerId)
    const targetIndex = Math.min(Math.max(moved.newIndex, 0), remainingActiveLayerIds.length)
    remainingActiveLayerIds.splice(targetIndex, 0, movedLayerId)

    const completeLayerIds = buildEditorSceneObjectLayerGroups(
      scenePlatformStore.value?.getScene() || null,
    ).map((group) => group.id)
    const activeLayerIdSet = new Set(activeLayerIds)
    let activeIndex = 0
    const orderedLayerIds = completeLayerIds.map((layerId) =>
      activeLayerIdSet.has(layerId) ? remainingActiveLayerIds[activeIndex++]! : layerId,
    )

    const result = reorderEditorSceneObjectLayers(
      scenePlatformStore.value,
      orderedLayerIds,
      scenePlatformCommandBus.value,
      movedLayerId,
    )
    if (result.status === 'applied') refreshScenePlatformStoreRevision()
  }

  /** 锁定分组只能查看和展开，不能作为拖拽源改变结构顺序。 */
  const canMoveModelLayer = (event: { draggedContext?: { element?: StructureModelLayerGroup } }) =>
    !hasBusinessHierarchy.value && !event.draggedContext?.element?.locked

  /**
   * 结构树里的模型眼睛按钮以 SceneStore 为唯一主写源。
   *
   * RuntimeBridge 已能把 visible 同步到 Three / Cesium，避免旧渲染与 Store 双写时因顺序不同
   * 出现“面板显示已隐藏、运行时又被旧调用切回显示”的竞态。仅未进入 SceneStore 的存量对象
   * 才继续调用旧渲染入口，确保过渡期对象不会失去显隐能力。
   */
  const updateMeshVisible = (item: SceneAllContentsItem) => {
    if (editorSceneOperation.value) return
    const sceneObject = scenePlatformStore.value?.getObject(item.uuid)
    const nextVisible = sceneObject ? !sceneObject.visible : !item.visible

    if (sceneObject) {
      if (hierarchyLayout.value && !scenePlatformCommandBus.value) return
      const result = applySceneObjectVisibilityToStore({
        commandBus: scenePlatformCommandBus.value,
        store: scenePlatformStore.value,
        objectId: item.uuid,
        visible: nextVisible,
      })
      if (result.status !== 'applied') return
    } else if (!toggleSceneContentVisibleByUuid(item.uuid)) {
      return
    }

    refreshScenePlatformStoreRevision()
    flushScenePlatformBridge('切换模型显隐')
  }

  const toggleModelLayerVisible = (group: StructureModelLayerGroup) => {
    // 树形图层的持久化状态只从当前仓库和命令读取，避免窗口行快照覆盖较新的状态。
    if (editorSceneOperation.value || (hierarchyLayout.value && !scenePlatformCommandBus.value)) return
    const nextVisible = !(scenePlatformStore.value?.getLayer(group.id)?.visible ?? group.visible)

    /**
     * 组内受管对象由图层适配器批量写入 Store，再统一冲刷 RuntimeBridge。
     * 仅 Store 没有记录的旧对象需要逐项走旧渲染兜底，避免对已迁移对象重复切换一次。
     */
    const result = setEditorSceneObjectLayerVisible({
      store: scenePlatformStore.value,
      commandBus: scenePlatformCommandBus.value,
      layerId: group.id,
      visible: nextVisible,
    })
    let legacyUpdated = false
    group.items.forEach((item) => {
      if (scenePlatformStore.value?.getObject(item.id) || item.raw.visible === nextVisible) return

      legacyUpdated = toggleSceneContentVisibleByUuid(item.id) || legacyUpdated
    })

    if (result.status !== 'applied' && !legacyUpdated) return

    refreshScenePlatformStoreRevision()
    flushScenePlatformBridge('切换模型图层显隐')
  }

  const toggleModelLayerLocked = (group: StructureModelLayerGroup) => {
    if (editorSceneOperation.value) return
    const result = setEditorSceneObjectLayerLocked({
      store: scenePlatformStore.value,
      commandBus: scenePlatformCommandBus.value,
      layerId: group.id,
      locked: !(scenePlatformStore.value?.getLayer(group.id)?.locked ?? group.locked),
    })
    if (result.status === 'applied') refreshScenePlatformStoreRevision()
  }

  const deleteModelGroup = (group: StructureModelLayerGroup) => {
    if (editorSceneOperation.value || isActiveSceneObjectGroupDeleteDisabled(group)) return
    try {
      const result = deleteEditorSceneObjectLayer({
        store: scenePlatformStore.value,
        commandBus: scenePlatformCommandBus.value,
        layerId: group.id,
      })
      if (result.status !== 'applied') return
      if (selectedModelGroupId.value === group.id) store.setCurrentObjectLayerId(null)
      refreshScenePlatformStoreRevision()
    } catch (error) {
      ElMessage.warning(error instanceof Error ? error.message : '无法删除图层')
    }
  }

  const isModelLocked = (item: StructureSceneObjectItem) => {
    const sceneObject = scenePlatformStore.value?.getObject(item.id)
    if (!sceneObject) return !item.raw.userData.isDrag
    return resolveEditorSceneObjectEffectiveState(scenePlatformStore.value, item.id).effectiveLocked
  }

  // 仅为窗口中的节点读取派生状态。后代按真实父级和所属图层继承权限。
  const getHierarchyNodeActions = (item: StructureSceneObjectItem) => {
    const platform = scenePlatformStore.value
    const object = platform?.getObject(item.id)
    if (!object) {
      return { locked: !item.raw.userData.isDrag, inheritedLocked: false, inheritedHidden: false,
        visibilityDisabled: false, lockDisabled: false, canDrag: false }
    }
    const state = resolveEditorSceneObjectEffectiveState(platform, item.id)
    const missingCommand = !scenePlatformCommandBus.value
    return { locked: state.effectiveLocked, inheritedLocked: state.inheritedLocked,
      inheritedHidden: !state.inheritedVisible, visibilityDisabled: missingCommand || state.effectiveLocked,
      lockDisabled: missingCommand || state.inheritedLocked,
      canDrag: !missingCommand && !state.effectiveLocked && isLocalHierarchyNode(object) }
  }

  /**
   * 结构树锁定按钮以 SceneStore 为主写。
   *
   * `metadata.pickable` 会通过 RuntimeBridge 同步到 Three / Cesium；Three Runtime 再将其
   * 投影回旧 TransformControls 所需的 `userData.isDrag`。只有尚未迁入 Store 的存量对象，
   * 才继续调用旧渲染桥接函数，避免新旧两条链路对同一对象反向切换。
   */
  const updateMeshPickup = (item: SceneAllContentsItem) => {
    if (editorSceneOperation.value) return
    const sceneObject = scenePlatformStore.value?.getObject(item.uuid)
    if (sceneObject) {
      const state = resolveEditorSceneObjectEffectiveState(scenePlatformStore.value, item.uuid)
      if (state.inheritedLocked) return
      const result = setEditorSceneObjectLocked({
        store: scenePlatformStore.value,
        commandBus: scenePlatformCommandBus.value,
        objectId: item.uuid,
        locked: !state.ownLocked,
      })
      if (result.status !== 'applied') return

      refreshScenePlatformStoreRevision()
      flushScenePlatformBridge('切换模型锁定状态')
      return
    }

    // 未迁移的存量对象没有 SceneStore 副本，只能保留旧桥接入口保障当前编辑器可用。
    toggleSceneContentPickupByUuid(item.uuid)
  }

  /**
   * Store 变更后主动冲刷运行时桥（RuntimeBridge）。
   * 当前视口仍由旧 Three 场景立即响应；这里主要保证平台 Runtime 镜像及时清理或更新，
   * 并把异步失败收口到日志，避免结构面板交互被 Promise 状态阻塞。
   */
  const flushScenePlatformBridge = (operationName: string) => {
    void scenePlatformBridge.value?.flush().catch((error) => {
      appLogger.warn('StructurePanel', `${operationName}后同步运行时失败`, error)
    })
  }

  const deleteManagedNodes = async (ids: readonly string[]) => {
    const host = getActiveSceneViewportHost()
    if (!host || host.getStore() !== toRaw(scenePlatformStore.value) || editorSceneOperation.value) return
    try {
      if (!await deleteEditorSceneSubtrees(host, ids) || getActiveSceneViewportHost() !== host) return
      selectedSceneObjectIds.value = new Set()
      const legacySelected = store.currentTransformMaterialUuid
      if (legacySelected && host.getStore().getDeletedObjectIds().has(legacySelected)) {
        store.setCurrentTransformMaterialUuid(null)
        store.setSelectedThreeMapObjectId(null)
      }
    } catch (error) {
      ElMessage.warning(error instanceof Error ? error.message : '无法删除所选节点')
    }
  }

  const deleteSelectedSceneObjects = () => deleteManagedNodes([...selectedSceneObjectIds.value])
  const copyableSelection = computed(() => {
    void scenePlatformStoreRevision.value
    const platform = scenePlatformStore.value
    if (!platform) return []
    const primary = platform.getSelectedObjectId()
    // 沿用结构面板的多选集合；普通单选使用场景仓库中的权威编号。
    return selectedSceneObjectIds.value.size
      ? [...selectedSceneObjectIds.value]
      : primary && platform.getObject(primary) ? [primary] : []
  })
  const copySelectedSceneObjects = async () => {
    const host = getActiveSceneViewportHost()
    if (!host || host.getStore() !== toRaw(scenePlatformStore.value) || editorSceneOperation.value) return
    try {
      if (await copyEditorSceneSubtrees(host, copyableSelection.value) && getActiveSceneViewportHost() === host) {
        selectedSceneObjectIds.value = new Set()
      }
    } catch (error) {
      ElMessage.warning(error instanceof Error ? error.message : '无法复制所选节点')
    }
  }
  const deleteMesh = (item: SceneAllContentsItem) => {
    if (editorSceneOperation.value) return
    if (scenePlatformStore.value?.getObject(item.uuid)) return deleteManagedNodes([item.uuid])
    // 旧引擎对象没有逻辑节点记录，继续走原单对象兼容入口。
    if (!item.userData.isDrag) return
    if (removeSceneContentByUuid(item.uuid)) refreshScenePlatformStoreRevision()
  }

  const deleteWidget = (id: string) => {
    sceneWidgetStore.deleteWidgets([id])
    hideContextMenu()
  }

  /**
   * 部件显隐入口统一走 sceneModules。
   * 这样结构树眼睛按钮、右侧属性、状态动作、交互动作都共享同一份可见性更新逻辑。
   */
  const updateWidgetVisible = (id: string, visible: boolean) => {
    updateWidgetVisibleById(id, visible)
  }

  const subscribeScenePlatformStore = (
    nextStore: SceneStore | null,
    nextBridge: RuntimeBridge | null,
    nextCommandBus: Pick<CommandBus, 'execute' | 'cancelLatest'> | null,
  ) => {
    if (scenePlatformStore.value !== nextStore) {
      /** 宿主切换到另一份场景仓库时清除上一个场景的分类选择，再按新场景内容自动定位。 */
      selectedSceneObjectIds.value = new Set()
      structureSceneSession++
      expandedSceneLayerIds.value.clear()
      expandedSceneNodeIds.value.clear()
      structureCategorySelectedByUser.value = false
      activeStructureCategory.value = 'model'
    }
    stopScenePlatformStoreSubscription?.()
    stopScenePlatformStoreSubscription = null
    scenePlatformStore.value = nextStore
    scenePlatformBridge.value = nextBridge
    scenePlatformCommandBus.value = nextCommandBus

    if (nextStore) {
      /**
       * SceneStore 的对象新增、删除、选中和整场景加载都会触发事件。
       * F014 在这里补齐对象图层归属，但只通过集成适配器写入可序列化层数据和 layerId；
       * 组件仍不直接碰 Runtime、Three 对象或平台核心私有状态。
       */
      stopScenePlatformStoreSubscription = nextStore.subscribe((event) => {
        // 选中和操控回写不改变层级，避免为每帧变换重新排序节点。
        if (event.type === 'sceneLoaded' || event.type === 'objectHierarchyChanged' || event.type === 'objectRemoved') {
          hierarchyIndexRevision.value++
        } else if (event.type === 'objectUpserted') {
          const current = event.object
          // 只查看上次索引，整批事件结束后由面板按需构建一次。
          const previous = indexedHierarchyNodes?.get(current.id)
          if (!previous || previous.name !== current.name || previous.type !== current.type ||
            previous.parentInstanceId !== current.parentInstanceId || previous.order !== current.order ||
            previous.layerId !== current.layerId || previous.transform.kind !== current.transform.kind) {
            hierarchyIndexRevision.value++
          }
        }
        if (event.type === 'sceneLoaded') {
          structureSceneSession++
          selectedSceneObjectIds.value = new Set()
          expandedSceneLayerIds.value.clear()
          expandedSceneNodeIds.value.clear()
          /** 场景切换重新从默认模型分类开始；若新场景只有组件，下面会自动切到组件分类。 */
          structureCategorySelectedByUser.value = false
          activeStructureCategory.value = 'model'
        }
        if (event.type === 'layerRemoved') expandedSceneLayerIds.value.delete(event.layerId)
        if (event.type === 'objectRemoved') {
          expandedSceneNodeIds.value.delete(event.objectId)
          selectedSceneObjectIds.value.delete(event.objectId)
        }
        if (selectedSceneObjectIds.value.size && (event.type === 'selectionChanged' || event.type === 'objectHierarchyChanged')) {
          reconcileStructureSceneSelection(selectedSceneObjectIds.value, nextStore.getSelectedObjectId(),
            (id) => Boolean(nextStore.getObject(id)))
        }
        if (event.type === 'objectHierarchyChanged' && expandedSceneNodeIds.value.size) {
          const nodes = nextStore.getNodeIndex().nodesById
          for (const id of expandedSceneNodeIds.value) if (!nodes.has(id)) expandedSceneNodeIds.value.delete(id)
        }
        // 兼容补齐只随加载执行，不能覆盖用户主动将节点移回根级的结果。
        if (event.type === 'sceneLoaded' && !syncingSceneObjectLayers) {
          syncingSceneObjectLayers = true
          try {
            ensureEditorSceneObjectLayersInStore(nextStore)
          } finally {
            syncingSceneObjectLayers = false
          }
        }
        refreshScenePlatformStoreRevision()
        if (event.type === 'sceneLoaded' || event.type === 'objectUpserted' || event.type === 'objectHierarchyChanged') {
          autoSelectSceneObjectCategory()
        }
      })

      syncingSceneObjectLayers = true
      try {
        ensureEditorSceneObjectLayersInStore(nextStore)
      } finally {
        syncingSceneObjectLayers = false
      }
    }

    refreshScenePlatformStoreRevision()
    if (nextStore) autoSelectSceneObjectCategory()
  }

  watch(
    () => sceneWidgetStore.currentWidgetGroupId,
    () => {
      hideContextMenu()
    },
  )

  onMounted(() => {
    stopScenePlatformHostSubscription = subscribeActiveSceneViewportHost((host) => {
      subscribeScenePlatformStore(
        host?.getStore() || null,
        host?.getBridge() || null,
        host?.getCommandBus() || null,
      )
    })
    document.addEventListener('pointerdown', handleGlobalPointerDown, true)
    document.addEventListener('dragover', handleGlobalWidgetDragOver, true)
  })

  onBeforeUnmount(() => {
    structureSceneSession++
    stopScenePlatformHostSubscription?.()
    stopScenePlatformHostSubscription = null
    stopScenePlatformStoreSubscription?.()
    stopScenePlatformStoreSubscription = null
    scenePlatformStore.value = null
    scenePlatformBridge.value = null
    scenePlatformCommandBus.value = null
    document.removeEventListener('pointerdown', handleGlobalPointerDown, true)
    document.removeEventListener('dragover', handleGlobalWidgetDragOver, true)
  })

  return {
    Search,
    Delete,
    Hide,
    View,
    Lock,
    Unlock,
    draggable,
    WidgetGroupItem,
    WidgetLeafItem,
    createGroupIcon,
    store,
    sceneWidgetStore,
    searchValue,
    activeStructureCategory,
    expandedGroupIds,
    contextMenuRef,
    contextMenu,
    scenePlatformStore,
    scenePlatformBridge,
    scenePlatformCommandBus,
    scenePlatformStoreRevision,
    modelLayerDragGroup,
    widgetLayerDragGroup,
    searchKeyword,
    hierarchySearchKeyword,
    currentTransformMaterialUuid,
    transformMaterialRandomId,
    refreshScenePlatformStoreRevision,
    scenePlatformObjects,
    legacySceneContents,
    legacySceneContentMap,
    allSceneContents,
    categorizedSceneObjectItems,
    allModelItems,
    allThreeDimensionalComponentItems,
    modelLayerGroups,
    rootModelItems,
    visibleModelGroups,
    rootThreeDimensionalComponentItems,
    visibleThreeDimensionalComponentGroups,
    activeSceneObjectLabel,
    activeSceneObjectRootItems,
    sceneHierarchyRows,
    hierarchyRenameTarget,
    renameHierarchySelection,
    canEditHierarchyRows,
    selectedHierarchyObjectId,
    revealSceneHierarchyObject,
    activeVisibleSceneObjectGroups,
    modelGroupDeleteDisabledIds,
    isModelGroupDeleteDisabled,
    threeDimensionalComponentGroupDeleteDisabledIds,
    isActiveSceneObjectGroupDeleteDisabled,
    widgetEntryMap,
    widgetGroupMap,
    widgetGroupDeleteDisabledIds,
    selectedStructureWidgetIds,
    visibleWidgetLayerTree,
    widgetChildrenMap,
    widgetHierarchyDropTargetId,
    widgetGroupDropTargetId,
    widgetGroupSortGapTarget,
    widgetSortGapTarget,
    filteredWidgetLayerNodes,
    widgetLayerNodeCount,
    structureCategoryItems,
    filteredVegetationRegions,
    selectedVegetationRegionId,
    vegetationSelectionDisabled,
    selectVegetationRegion,
    selectStructureCategory,
    isGroupExpanded,
    isSceneLayerExpanded,
    toggleSceneLayerExpanded,
    toggleSceneNodeExpanded,
    toggleGroupExpanded,
    hideContextMenu,
    adjustContextMenuPosition,
    handleGlobalPointerDown,
    clearSelectionFromBlank,
    clearVegetationSelectionFromBlank,
    chooseMesh,
    focusMesh,
    resetSelectionBeforeWidgetPick,
    chooseWidget,
    chooseGroup,
    selectItem,
    focusItem,
    selectedHierarchyNode,
    selectedHierarchyParent,
    hierarchySelection,
    hierarchyParents,
    editSelectedHierarchy,
    getHierarchyDragSource,
    getHierarchyDropError,
    dropHierarchyNodes,
    selectWidgetFromNode,
    selectWidgetChildFromNode,
    selectGroup,
    openContextMenu,
    handleCreateGroup,
    createWidgetGroup,
    toggleGroupVisible,
    toggleWidgetLocked,
    toggleWidgetChildVisible,
    toggleWidgetChildLocked,
    toggleWidgetGroupLocked,
    deleteWidgetGroup,
    moveWidgetToGroup,
    handleWidgetDragStart,
    handleWidgetSortableStart,
    handleWidgetDragEnd,
    setWidgetDragData,
    moveDraggedWidgetsUnderParent,
    handleWidgetRootDragChange,
    canMoveWidget,
    isWidgetGroupDeleteDisabled,
    canCreateBusinessGroup,
    createBusinessGroup,
    selectedModelGroupId,
    selectModelGroup,
    handleModelMove,
    handleRootModelDragChange,
    handleModelGroupDragChange,
    handleModelLayerDragChange,
    canMoveModel,
    canMoveModelLayer,
    updateMeshVisible,
    toggleModelLayerVisible,
    toggleModelLayerLocked,
    deleteModelGroup,
    isModelLocked,
    getHierarchyNodeActions,
    updateMeshPickup,
    flushScenePlatformBridge,
    deleteMesh,
    selectedSceneObjectIds,
    deleteSelectedSceneObjects,
    copyableSelection,
    copySelectedSceneObjects,
    editorSceneOperation,
    deleteWidget,
    updateWidgetVisible,
    subscribeScenePlatformStore,
  }
}
