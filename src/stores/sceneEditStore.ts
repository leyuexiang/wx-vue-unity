import { defineStore } from 'pinia'
import { computed, ref, type Ref } from 'vue'
import { cloneDeep, isEqual } from 'lodash-es'
import type renderModel from '@/utils/renderScene'
import type { SceneTransform } from '@/scene-platform'
import type {
  WidgetCanvasConfig,
  WidgetGroupBounds,
  WidgetLayerNode,
  WidgetModel,
} from '@/types/threeScene'
import { loadConfig } from '@/packages'
import type BaseWidgetConfig from '@/packages/components/BaseWidgetConfig'
import { installWidget } from '@/utils/renderScene/widgetModules'
import { createUuid } from '@/utils/uuid'
import { createSnowflakeId } from '@/utils/snowflakeId'
import { mergeWidgetComponentWithDefaults, normalizeWidgetComponent } from '@/utils/widgetComponent'
import { createDefaultSceneStageSize, normalizeSceneStageSize } from '@/utils/sceneStage'
import {
  areWidgetGroupIdsInSameParent,
  areWidgetIdsInSameParent,
  areWidgetLayerSelectionsInSameParent,
  appendEmptyWidgetGroup,
  appendWidgetLayerNode,
  buildWidgetGroupParentIndex,
  buildWidgetParentGroupIndex,
  buildWidgetZIndexMap,
  buildNextWidgetGroupName,
  collectWidgetGroupWidgetIds,
  createDefaultWidgetLayerTree,
  createWidgetGroupLayerTree,
  createWidgetGroupLayerTreeFromGroups,
  createWidgetGroupLayerTreeFromMixedSelection,
  deleteWidgetGroupLayerTree,
  flattenWidgetLayerTree,
  moveWidgetGroupIntoGroup,
  moveWidgetLayerItems,
  normalizeWidgetLayerTree,
  preserveWidgetLayerRuntimeState,
  removeWidgetFromLayerTree,
} from '@/utils/widgetLayer'
import { deduplicateWidgetsById } from '@/utils/widgetCollection'
import {
  buildWidgetChildrenIndex,
  collectWidgetAncestorIds,
  collectWidgetDescendantIds,
  compactWidgetHierarchySelection,
  normalizeWidgetHierarchy,
  orderWidgetIdsByHierarchy,
} from '@/utils/widgetHierarchy'
import WidgetCommand, {
  type WidgetHistorySnapshot,
} from '@/integrations/scene/widgetRuntime/widgetCommand'
import {
  getWidgetCommandPort,
  getWidgetRuntimePort,
} from '@/integrations/scene/widgetRuntime/ports'
export { useSceneDataStore, useSceneRequestStore } from './sceneAuxiliaryStores'

type ModelStoreType = {
  sceneApi: Ref<renderModel | null>
  currentTransformMaterialUuid: Ref<string | null>
  selectedThreeMapObjectId: Ref<string | null>
  currentObjectLayerId: Ref<string | null>
  setSceneApi: (api: renderModel | null) => void
  setCurrentTransformMaterialUuid: (uuid: string | null) => void
  setSelectedThreeMapObjectId: (objectId: string | null) => void
  setCurrentObjectLayerId: (layerId: string | null) => void
  transformMaterialRandomId: Ref<string>
  setTransformMaterialRandomId: () => void
  /**
   * Gizmo 拖拽中的临时变换，仅供属性面板实时展示，绝不写入场景快照、命令栈或 MySQL。
   * 指针抬起后由 SceneCanvas 用一条正式命令提交最终值，再清空该预览状态。
   */
  sceneTransformPreview: Ref<SceneTransformPreview | null>
  setSceneTransformPreview: (preview: SceneTransformPreview | null) => void
  sceneIsPublish: Ref<boolean>
  setSceneIsPublish: (isPublish: boolean) => void
  isMeasuring: Ref<boolean>
  setIsMeasuring: (isMeasuring: boolean) => void
}

/**
 * 编辑器临时变换预览。
 *
 * Runtime 负责模型实时渲染，Store 只保存经过动画帧合并的可序列化快照，以便右侧属性面板能在拖拽旋转、
 * 缩放时同步显示。该状态不参与保存，刷新页面或取消拖拽都会回到最后一次正式场景数据。
 */
export interface SceneTransformPreview {
  readonly objectId: string
  readonly transform: SceneTransform
}

export const useSceneStore = defineStore('modelStore', (): ModelStoreType => {
  const sceneApi = ref<renderModel | null>(null) as Ref<renderModel | null>
  const setSceneApi = (api: renderModel | null) => {
    sceneApi.value = api
  }

  const currentTransformMaterialUuid = ref<string | null>(null)
  /** 独立 Three 地图没有旧 Mesh，单独保存其选中编号供检查器路由消费。 */
  const selectedThreeMapObjectId = ref<string | null>(null)
  const setSelectedThreeMapObjectId = (objectId: string | null) => {
    selectedThreeMapObjectId.value = objectId
  }
  const currentObjectLayerId = ref<string | null>(null)
  const setCurrentTransformMaterialUuid = <T extends string | null>(uuid: T) => {
    currentTransformMaterialUuid.value = uuid
    if (uuid) currentObjectLayerId.value = null
  }

  /** 当前选中的三维视觉分组；它只驱动结构树和右侧基础面板，不代表 Three 父节点。 */
  const setCurrentObjectLayerId = (layerId: string | null) => {
    currentObjectLayerId.value = layerId
    if (layerId) currentTransformMaterialUuid.value = null
  }

  /**
   * 设置更新变换材质随机值
   * ps:用于触发 Vue 的响应式更新
   */
  const transformMaterialRandomId = ref<string>('')
  const setTransformMaterialRandomId = () => {
    /**
     * 统一走项目内部的 UUID 工具出口，避免 Store 自己再依赖 `three` 的深路径模块。
     */
    transformMaterialRandomId.value = createUuid()
  }

  const sceneTransformPreview = ref<SceneTransformPreview | null>(null)
  const setSceneTransformPreview = (preview: SceneTransformPreview | null) => {
    /**
     * 缩放三元组必须复制，避免 Runtime 下一帧复用数组时回写已经发给 Vue 的响应式快照。
     * 这里每帧最多调用一次，且只复制一个对象的少量数值字段，不触发场景全量克隆。
     */
    sceneTransformPreview.value = preview
      ? {
          objectId: preview.objectId,
          transform: {
            ...preview.transform,
            scale: Array.isArray(preview.transform.scale)
              ? ([...preview.transform.scale] as [number, number, number])
              : preview.transform.scale,
          },
        }
      : null
  }

  const sceneIsPublish = ref<boolean>(false)
  const setSceneIsPublish = (isPublish: boolean) => {
    sceneIsPublish.value = isPublish
  }

  const isMeasuring = ref<boolean>(false)
  const setIsMeasuring = (measuring: boolean) => {
    isMeasuring.value = measuring
  }

  return {
    sceneApi,
    setSceneApi,
    currentTransformMaterialUuid,
    selectedThreeMapObjectId,
    setCurrentTransformMaterialUuid,
    setSelectedThreeMapObjectId,
    currentObjectLayerId,
    setCurrentObjectLayerId,
    transformMaterialRandomId,
    setTransformMaterialRandomId,
    sceneTransformPreview,
    setSceneTransformPreview,
    sceneIsPublish,
    setSceneIsPublish,
    isMeasuring,
    setIsMeasuring,
  }
})
export interface WidgetConfig {
  id: string
  component: BaseWidgetConfig
  /**
   * 结构面板中的真实父组件编号。
   *
   * 二维组件仍以绝对舞台坐标渲染，父子关系负责结构、继承状态和级联移动；
   * 不把 DOM 实例嵌套进另一个组件，避免改变已有组件的定位与裁剪语义。
   */
  parentId?: string
}

/**
 * 编辑器预览事务快照。
 *
 * 预览中的交互允许临时改变部件显隐、数据绑定结果和运行时输入值，但这些变化不能进入编辑器
 * 的正式场景状态或撤销栈。快照覆盖二维运行时可能触碰的状态，退出预览时一次性恢复。
 */
export interface WidgetPreviewSnapshot {
  widgets: WidgetConfig[] | null
  widgetLayerTree: WidgetLayerNode[]
  widgetRuntimeValueMap: Record<string, Record<string, unknown>>
  currentWidgetsIds: string[] | null
  currentWidgetGroupId: string | null
  currentWidgetGroupIds: string[]
  currentWidgetChildSelection: WidgetChildSelection | null
}

/** 画布二维部件的键盘微调方向；每次调用只移动一个逻辑画布单位。 */
export type WidgetNudgeDirection = 'up' | 'down' | 'left' | 'right'

export interface WidgetChildSelection {
  frameId: string
  childId: string
}

/** 选择来源仅用于编辑器联动，不进入场景配置；外部来源包含画布和程序化选择。 */
export type WidgetSelectionSource = 'external' | 'structure'

interface WidgetHistorySnapshotOptions {
  includeLayerTree?: boolean
  /** 仅数字属性输入等可连续编辑的单部件字段传入。 */
  mergeSession?: symbol
}

export const useSceneWidgetStore = defineStore('sceneWidgetStore', () => {
  const boundingClientRect = ref<DOMRect>()
  const setBoundingClientRect = (rect: DOMRect) => {
    boundingClientRect.value = rect
    syncWidgetCanvasScale()
  }

  const widgetCanvasSize = ref<WidgetCanvasConfig>(createDefaultSceneStageSize())
  const widgetCanvasScale = ref(1)
  const widgetCanvasAutoScale = ref(1)

  const getWidgetCanvasSize = () => {
    return widgetCanvasSize.value
  }

  const syncWidgetCanvasScale = () => {
    const rect = boundingClientRect.value
    const size = getWidgetCanvasSize()
    if (!rect || !size) return

    /**
     * 缩放比例只由当前可见舞台矩形决定。
     * 新版不再保存或叠加手动缩放，确保编辑态、预览态和发布态都按同一份用户发布尺寸构图。
     */
    const fitScale = Math.min(rect.width / size.width, rect.height / size.height)
    widgetCanvasAutoScale.value = Number.isFinite(fitScale) && fitScale > 0 ? fitScale : 1
    widgetCanvasScale.value = widgetCanvasAutoScale.value
  }

  const setWidgetCanvasSizeFromConfig = (size?: Partial<WidgetCanvasConfig> | null) => {
    /**
     * 舞台尺寸是场景级发布配置：
     * - 新场景或旧场景缺少该配置时回落到默认发布尺寸；
     * - 已保存过尺寸的场景按配置恢复，并经过统一范围保护，避免异常值影响渲染器。
     *
     * 注意：不能用当前 Store 尺寸作为兜底。
     * 连续打开多个场景时，Store 里可能还保留上一个场景的尺寸；缺失字段必须回到 1920x1080 默认值。
     */
    const fallbackSize = createDefaultSceneStageSize()
    widgetCanvasSize.value = normalizeSceneStageSize(size, fallbackSize)
    syncWidgetCanvasScale()
  }

  const getWidgetCanvasConfig = (): WidgetCanvasConfig => {
    return { ...getWidgetCanvasSize() }
  }

  const getWidgetCanvasLayout = () => {
    const size = getWidgetCanvasSize()
    /**
     * LayerDOM 已经放在统一舞台内部。
     * 外层等比缩放由 SceneCanvas 统一完成，这里只暴露用户发布尺寸对应的设计坐标系本身。
     */
    return {
      width: size.width,
      height: size.height,
      scale: widgetCanvasScale.value || 1,
      left: 0,
      top: 0,
    }
  }

  const screenDeltaToWidgetCanvasDelta = (deltaX: number, deltaY: number) => {
    const scale = widgetCanvasScale.value || 1
    return {
      x: deltaX / scale,
      y: deltaY / scale,
    }
  }

  const screenPointToWidgetCanvasPoint = (clientX: number, clientY: number) => {
    const rect = boundingClientRect.value
    const size = getWidgetCanvasSize()
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      const scale = widgetCanvasScale.value || 1
      return { x: clientX / scale, y: clientY / scale }
    }

    /**
     * 鼠标落点使用可见舞台矩形反算到用户发布尺寸对应的设计坐标。
     * CSS 缩放或居中留白都不会污染最终写入部件的 l/t。
     */
    return {
      x: ((clientX - rect.left) / rect.width) * size.width,
      y: ((clientY - rect.top) / rect.height) * size.height,
    }
  }

  const totalWidgets = ref<WidgetConfig[] | null>(null)
  const setTotalWidgets = (
    widgets: WidgetConfig[] | ((widgets: WidgetConfig[]) => WidgetConfig[]) | null,
  ) => {
    if (typeof widgets === 'function') {
      totalWidgets.value = widgets(totalWidgets.value || [])
    } else {
      totalWidgets.value = widgets
    }
  }
  /**
   * 二维部件按实例 ID 建立只读索引。
   * 右侧面板、数据配置和交互配置会频繁按当前选中 ID 查找部件，
   * 这里集中生成 Map，避免各入口反复扫描 totalWidgets。
   */
  const widgetByIdMap = computed(() => {
    return new Map((totalWidgets.value || []).map((item) => [item.id, item]))
  })

  /** 父子关系直接保存在组件快照中，索引只做高频结构查询，不形成第二份可写状态。 */
  const widgetParentIndex = computed(
    () =>
      new Map(
        (totalWidgets.value || [])
          .filter((item) => Boolean(item.parentId))
          .map((item) => [item.id, item.parentId!]),
      ),
  )
  const widgetChildrenIndex = computed(() => buildWidgetChildrenIndex(totalWidgets.value || []))

  /**
   * 统一的二维部件查询出口。
   * 返回值仍是仓库中的真实实例引用，调用方可以在命令快照包裹下安全修改。
   */
  const getWidgetById = (id?: string | null) => {
    if (!id) return null
    return widgetByIdMap.value.get(id) || null
  }

  const getWidgetParentId = (widgetId: string) => widgetParentIndex.value.get(widgetId) || null
  const getWidgetChildIds = (widgetId: string) => widgetChildrenIndex.value.get(widgetId) || []
  const getWidgetDescendantIds = (widgetId: string) =>
    collectWidgetDescendantIds(widgetId, widgetChildrenIndex.value)

  /**
   * 解析“创建分组”实际要收纳的组件集合。
   *
   * 多选可能同时包含父组件和子组件，因此先压缩为最外层选中节点，
   * 再递归展开每棵子树，确保视觉分组不会把已有父子关系拆开。
   */
  const getExpandedWidgetSelectionIds = (ids: string[]) => {
    const selectedIds = getUniqueWidgetIds(ids).filter((id) => Boolean(getWidgetById(id)))
    const rootIds = compactWidgetHierarchySelection(selectedIds, widgetParentIndex.value)

    return getUniqueWidgetIds(rootIds.flatMap((id) => [id, ...getWidgetDescendantIds(id)]))
  }

  const getWidgetGroupMemberIds = (ids: string[]) => {
    const selectedIds = getUniqueWidgetIds(ids).filter((id) => Boolean(getWidgetById(id)))
    return selectedIds.length < 2 ? [] : getExpandedWidgetSelectionIds(selectedIds)
  }

  const currentWidgetsIds = ref<string[] | null>(null)
  const currentWidgetGroupId = ref<string | null>(null)
  /** 结构树中的视觉分组多选态；单选时同时同步 currentWidgetGroupId 供画布和右侧面板使用。 */
  const currentWidgetGroupIds = ref<string[]>([])
  /** 页面框架内部子节点的编辑器瞬时选中态，不参与场景序列化。 */
  const currentWidgetChildSelection = ref<WidgetChildSelection | null>(null)
  /**
   * 结构列表选择只更新高亮，画布等外部选择才需要定位并展开祖先。
   * 来源与选中集合在同一调用中写入，避免用定时器或鼠标焦点推测来源。
   */
  const currentWidgetSelectionSource = ref<WidgetSelectionSource>('external')
  const setCurrentWidgetsIds = (
    ids: string[] | null,
    source: WidgetSelectionSource = 'external',
  ) => {
    currentWidgetSelectionSource.value = source
    currentWidgetsIds.value = ids
    currentWidgetChildSelection.value = null
    widgetAnimationPreview.value = null
    if (ids?.length) {
      currentWidgetGroupId.value = null
      currentWidgetGroupIds.value = []
    }
  }

  /**
   * 当前组选中态与当前部件选中态互斥：
   * - 选中组时，右侧不应再继续展示旧的单部件属性；
   * - 选中单部件时，也要自动退出组选中态。
   * 来源随选择一并更新，结构列表选组时保留用户已有展开状态。
   */
  const setCurrentWidgetGroupId = (
    groupId: string | null,
    source: WidgetSelectionSource = 'external',
  ) => {
    currentWidgetSelectionSource.value = source
    currentWidgetGroupId.value = groupId
    currentWidgetGroupIds.value = groupId ? [groupId] : []
    currentWidgetChildSelection.value = null
    widgetAnimationPreview.value = null
    if (groupId) {
      currentWidgetsIds.value = null
    }
  }

  /** Ctrl 多选分组时保留旧组边界，并通过来源区分高亮更新与自动展开。 */
  const setCurrentWidgetGroupIds = (
    groupIds: string[],
    source: WidgetSelectionSource = 'external',
  ) => {
    currentWidgetSelectionSource.value = source
    const validGroupIdSet = new Set(
      widgetLayerTree.value.filter((node) => node.type === 'group').map((node) => node.id),
    )
    const nextGroupIds = Array.from(new Set(groupIds)).filter((id) => validGroupIdSet.has(id))
    currentWidgetGroupIds.value = nextGroupIds
    currentWidgetGroupId.value = nextGroupIds.length === 1 ? nextGroupIds[0] : null
    currentWidgetChildSelection.value = null
    widgetAnimationPreview.value = null
    if (nextGroupIds.length) currentWidgetsIds.value = null
  }

  /**
   * 写入结构树的组件与分组混合选中态。
   *
   * 普通单选入口继续保持组件/分组互斥；只有 Ctrl 增量选择走该方法，避免画布或右侧面板的
   * 既有单选调用意外保留旧选择。混选期间不设置 currentWidgetGroupId，因此不会误启用组包围框。
   * 结构列表的 Ctrl、Shift 范围选择统一携带来源，不能因成员投影而重新展开整棵树。
   */
  const setCurrentWidgetMixedSelection = (
    widgetIds: string[],
    groupIds: string[],
    source: WidgetSelectionSource = 'external',
  ) => {
    currentWidgetSelectionSource.value = source
    const nextWidgetIds = Array.from(new Set(widgetIds)).filter((id) => Boolean(getWidgetById(id)))
    const validGroupIdSet = new Set(
      widgetLayerTree.value.filter((node) => node.type === 'group').map((node) => node.id),
    )
    const nextGroupIds = Array.from(new Set(groupIds)).filter((id) => validGroupIdSet.has(id))

    currentWidgetsIds.value = nextWidgetIds.length ? nextWidgetIds : null
    currentWidgetGroupIds.value = nextGroupIds
    currentWidgetGroupId.value =
      nextWidgetIds.length === 0 && nextGroupIds.length === 1 ? nextGroupIds[0] : null
    currentWidgetChildSelection.value = null
    widgetAnimationPreview.value = null
  }

  /**
   * 清空所有部件相关选中态。
   * 结构面板空白点击、切到 3D 模型、进入预览等入口都统一走这里，避免只清一半状态。
   * 同时清理来源，下一次画布选择沿用默认外部联动语义。
   */
  const clearCurrentWidgetSelection = () => {
    currentWidgetSelectionSource.value = 'external'
    currentWidgetsIds.value = null
    currentWidgetGroupId.value = null
    currentWidgetGroupIds.value = []
    currentWidgetChildSelection.value = null
    widgetAnimationPreview.value = null
  }

  /** 页面框架内部节点同样区分选择来源，列表内点击明细时不重置其他组件分支。 */
  const setCurrentWidgetChildSelection = (
    selection: WidgetChildSelection | null,
    source: WidgetSelectionSource = 'external',
  ) => {
    currentWidgetSelectionSource.value = source
    currentWidgetChildSelection.value = selection
    widgetAnimationPreview.value = null
    if (selection) {
      currentWidgetsIds.value = [selection.frameId]
      currentWidgetGroupId.value = null
      currentWidgetGroupIds.value = []
    }
  }

  const widgetRenderVersionMap = ref<Record<string, number>>({})
  const bumpWidgetRenderVersion = (id: string) => {
    widgetRenderVersionMap.value = {
      ...widgetRenderVersionMap.value,
      [id]: (widgetRenderVersionMap.value[id] ?? 0) + 1,
    }
  }

  /**
   * 动画 hover 预览属于编辑器瞬时态，不参与场景保存。
   * 这里只记录“哪个部件正在预览哪一个公共动画”，画布层直接消费，不做额外重建。
   */
  const widgetAnimationPreview = ref<{ widgetId: string; animation: string } | null>(null)

  const setWidgetAnimationPreview = (payload: { widgetId: string; animation: string } | null) => {
    widgetAnimationPreview.value = payload
  }

  /**
   * 部件运行时值注册表。
   * 这份状态只服务于预览期的规则判断，不参与场景配置落盘：
   * - 可交互部件在值变化时把当前值上报到这里；
   * - 状态规则与交互规则统一从这里读取“当前部件值”；
   * - 删除部件时同步清理，避免旧值污染新的实例判断。
   */
  const widgetRuntimeValueMap = ref<Record<string, Record<string, unknown>>>({})

  /**
   * 部件视觉管理树是结构面板分组归属与渲染顺序的唯一真源。
   * totalWidgets 始终只保存平铺的真实部件；分组不会在画布 DOM 中创建父节点。
   */
  const widgetLayerTree = ref<WidgetLayerNode[]>([])

  /**
   * 高频成员查询统一收敛为两个响应式索引。
   * 结构节点悬浮、锁定守卫和画布显隐都可以 O(1) 取到父组，避免每个组件重复扫描整棵树。
   */
  const widgetParentGroupIndex = computed(() => buildWidgetParentGroupIndex(widgetLayerTree.value))
  const widgetGroupParentIndex = computed(() => buildWidgetGroupParentIndex(widgetLayerTree.value))
  const widgetGroupIndex = computed(
    () =>
      new Map(
        widgetLayerTree.value
          .filter(
            (node): node is Extract<WidgetLayerNode, { type: 'group' }> => node.type === 'group',
          )
          .map((group) => [group.id, group]),
      ),
  )

  const setWidgetLayerTree = (tree: WidgetLayerNode[]) => {
    const validWidgetIds = (totalWidgets.value || []).map((item) => item.id)
    widgetLayerTree.value = normalizeWidgetLayerTree(tree, validWidgetIds)
    syncWidgetZIndexWithLayerTree()
  }

  /**
   * 图层树顺序需要同步落到每个部件的 attr.zIndex 上。
   * 原因有两个：
   * 1. 画布重叠遮挡最终仍然要靠 zIndex 才能稳定表达，不应只赌 DOM 顺序；
   * 2. 场景保存/回显后，需要保留一份已经和结构顺序一致的显式层级值。
   *
   * 这里统一约定：
   * - 结构树与拍平数组越靠后，层级越高；
   * - 顶层组只是结构容器，真正参与 zIndex 计算的是拍平后的真实部件。
   */
  const syncWidgetZIndexWithLayerTree = () => {
    const widgets = totalWidgets.value || []
    if (!widgets.length) return

    const hierarchyOrderedIds = orderWidgetIdsByHierarchy(
      flattenWidgetLayerTree(widgetLayerTree.value),
      widgets,
    )
    const zIndexMap = buildWidgetZIndexMap(hierarchyOrderedIds)

    widgets.forEach((widget) => {
      const nextZIndex = zIndexMap[widget.id]
      if (nextZIndex === undefined) return
      widget.component.attr.zIndex = nextZIndex
    })
  }

  /**
   * 按当前部件实例表重建一份默认图层树。
   * 主要用于旧场景兼容和极端异常兜底。
   */
  const rebuildDefaultWidgetLayerTree = () => {
    /** 旧场景没有管理树时，按已保存 zIndex 从背景到前景迁移，避免恢复后遮挡关系翻转。 */
    widgetLayerTree.value = createDefaultWidgetLayerTree(
      [...(totalWidgets.value || [])]
        .sort((left, right) => left.component.attr.zIndex - right.component.attr.zIndex)
        .map((item) => item.id),
    )
    syncWidgetZIndexWithLayerTree()
  }

  /**
   * 由“平铺部件集合 + 视觉管理树”共同派生的响应式渲染列表。
   *
   * 这里必须使用 computed 作为画布的直接订阅源，不能只向画布暴露命令式查询方法。
   * 删除部件时，totalWidgets 和 widgetLayerTree 会在同一事务内先后更新；
   * 画布直接订阅这个派生状态，才能在当前渲染批次立即卸载已删节点，
   * 不再依赖选中态等无关更新触发组件重渲染。
   */
  const orderedWidgets = computed(() => {
    const widgets = totalWidgets.value || []
    const widgetMap = new Map(widgets.map((item) => [item.id, item]))
    const orderedIds = orderWidgetIdsByHierarchy(
      flattenWidgetLayerTree(widgetLayerTree.value),
      widgets,
    )
    return orderedIds
      .map((id) => widgetMap.get(id))
      .filter((item): item is WidgetConfig => Boolean(item))
  })

  /**
   * 保留查询方法作为命令和计算逻辑的兼容出口。
   * Vue 模板必须优先直接消费 orderedWidgets，以保留明确的响应式依赖。
   */
  const getOrderedWidgets = () => orderedWidgets.value

  /**
   * 返回指定分组下的真实部件 id 列表。
   * 这里只做轻量查询，不创建派生副本树，避免结构面板、画布层、右侧面板重复各扫一遍图层树。
   */
  const getGroupWidgetIds = (groupId: string) => {
    return collectWidgetGroupWidgetIds(widgetLayerTree.value, groupId)
  }

  const getWidgetParentGroupId = (widgetId: string) =>
    widgetParentGroupIndex.value.get(widgetId) || null

  const getWidgetGroupParentGroupId = (groupId: string) =>
    widgetGroupParentIndex.value.get(groupId) || null

  const getWidgetGroupAncestorIds = (groupId: string) => {
    const ancestorIds: string[] = []
    const visitedIds = new Set<string>()
    let currentGroupId = getWidgetGroupParentGroupId(groupId)
    while (currentGroupId && !visitedIds.has(currentGroupId)) {
      visitedIds.add(currentGroupId)
      ancestorIds.push(currentGroupId)
      currentGroupId = getWidgetGroupParentGroupId(currentGroupId)
    }
    return ancestorIds
  }

  const getWidgetGroupDescendantIds = (groupId: string) => {
    const descendantIds: string[] = []
    const visitedIds = new Set<string>()
    const visitGroup = (currentGroupId: string) => {
      if (visitedIds.has(currentGroupId)) return
      visitedIds.add(currentGroupId)
      const group = widgetGroupIndex.value.get(currentGroupId)
      ;(group?.childGroupIds || []).forEach((childGroupId) => {
        descendantIds.push(childGroupId)
        visitGroup(childGroupId)
      })
    }
    visitGroup(groupId)
    return descendantIds
  }

  const getWidgetOwnLocked = (widgetId: string) => {
    const widget = getWidgetById(widgetId)
    return (widget?.component.option as Record<string, unknown> | undefined)?.locked === true
  }

  const isWidgetGroupLocked = (groupId: string) =>
    widgetGroupIndex.value.get(groupId)?.locked === true

  /**
   * 判断二维分组的编辑器代理是否允许整体变换。
   * 分组自身锁定或任一成员自身锁定时都禁止移动、对齐，避免整体操作绕过成员锁定；
   * 此状态只服务编辑器代理，不会写入组件运行时父子关系。
   */
  const isWidgetGroupTransformLocked = (groupId: string) => {
    const group = widgetGroupIndex.value.get(groupId)
    if (!group) return true
    if (
      [
        groupId,
        ...getWidgetGroupAncestorIds(groupId),
        ...getWidgetGroupDescendantIds(groupId),
      ].some(isWidgetGroupLocked)
    ) {
      return true
    }
    return getGroupWidgetIds(groupId).some((widgetId) => getWidgetOwnLocked(widgetId))
  }

  /**
   * 组件有效锁定采用继承式计算：自身或父组任一锁定即视为锁定。
   * 这里不把组锁定写回成员，确保解锁分组后成员原有锁定状态能够准确恢复。
   */
  const isWidgetLocked = (widgetId: string) => {
    const hierarchyIds = [widgetId, ...collectWidgetAncestorIds(widgetId, widgetParentIndex.value)]
    return hierarchyIds.some((currentId) => {
      const parentGroupId = getWidgetParentGroupId(currentId)
      return (
        getWidgetOwnLocked(currentId) ||
        Boolean(
          parentGroupId &&
            [parentGroupId, ...getWidgetGroupAncestorIds(parentGroupId)].some(isWidgetGroupLocked),
        )
      )
    })
  }

  /**
   * 分组显隐与组件自身显隐取交集，不互相覆盖。
   * 调用方可传入预览态计算出的自身显隐，避免这里重新构建运行时 option。
   */
  const isWidgetEffectivelyVisible = (widgetId: string, ownVisible = true) => {
    if (!ownVisible) return false
    const hierarchyIds = [widgetId, ...collectWidgetAncestorIds(widgetId, widgetParentIndex.value)]
    return hierarchyIds.every((currentId) => {
      const currentWidget = getWidgetById(currentId)
      const currentOwnVisible =
        currentId === widgetId
          ? ownVisible
          : (currentWidget?.component.option as Record<string, unknown> | undefined)?.visible !==
            false
      const parentGroupId = getWidgetParentGroupId(currentId)
      return (
        currentOwnVisible &&
        (!parentGroupId ||
          [parentGroupId, ...getWidgetGroupAncestorIds(parentGroupId)].every(
            (groupId) => widgetGroupIndex.value.get(groupId)?.visible !== false,
          ))
      )
    })
  }

  /**
   * 更新二维部件自身显隐，并只使当前部件的画布缓存失效。
   *
   * 组件、装饰、图标和图表都由 LayerDOM 通过渲染版本读取缓存；只改 option.visible
   * 不足以触发非图表部件重算。显隐属于所有二维部件的通用运行时属性，因此必须在唯一仓库
   * 入口中同步递增目标版本，避免右侧基础面板和结构树各自维护不同刷新规则。
   */
  const setWidgetVisible = (widgetId: string, visible: boolean) => {
    const widget = getWidgetById(widgetId)
    if (!widget) return false

    const option = (widget.component.option as Record<string, unknown> | undefined) || {}
    if (option.visible === visible) return true

    widget.component.option = {
      ...option,
      visible,
    }
    bumpWidgetRenderVersion(widgetId)
    return true
  }

  /**
   * 计算分组在画布中的最小外接矩形。
   * 这里只统计当前仍可见的部件，避免隐藏部件把总选中框撑大。
   * 若组内全部部件都隐藏，则返回 null，让画布退化为“结构选中但无包围框”。
   */
  const getGroupBounds = (groupId: string, includeHidden = false): WidgetGroupBounds | null => {
    const groupWidgetIds = new Set(getGroupWidgetIds(groupId))
    if (!groupWidgetIds.size) return null

    const targetWidgets = getOrderedWidgets().filter((item) => {
      if (!groupWidgetIds.has(item.id)) return false
      if (includeHidden) return true
      const ownVisible =
        (item.component.option as Record<string, unknown> | undefined)?.visible !== false
      return isWidgetEffectivelyVisible(item.id, ownVisible)
    })

    if (!targetWidgets.length) return null

    let minLeft = Number.POSITIVE_INFINITY
    let minTop = Number.POSITIVE_INFINITY
    let maxRight = Number.NEGATIVE_INFINITY
    let maxBottom = Number.NEGATIVE_INFINITY

    targetWidgets.forEach((item) => {
      const { l, t, w, h } = item.component.attr
      minLeft = Math.min(minLeft, l)
      minTop = Math.min(minTop, t)
      maxRight = Math.max(maxRight, l + w)
      maxBottom = Math.max(maxBottom, t + h)
    })

    return {
      l: minLeft,
      t: minTop,
      w: maxRight - minLeft,
      h: maxBottom - minTop,
    }
  }

  /**
   * 读取分组自身的显隐状态。
   * 空组默认可见；旧数据没有 visible 字段时同样按可见兼容。
   */
  const getGroupVisible = (groupId: string) => {
    const group = widgetGroupIndex.value.get(groupId)
    return Boolean(group && group.visible !== false)
  }

  /**
   * 设置分组自身显隐，不覆盖成员各自的 visible。
   * 因为只改视觉管理树，所以一次操作只记录一条包含树快照的历史。
   */
  const setGroupVisible = (groupId: string, visible: boolean) => {
    const group = widgetGroupIndex.value.get(groupId)
    if (!group || group.visible === visible) return
    runWidgetHistoryChange(
      '更新部件分组显隐',
      getGroupWidgetIds(groupId),
      () => {
        widgetLayerTree.value = widgetLayerTree.value.map((node) =>
          node.type === 'group' && node.id === groupId ? { ...node, visible } : node,
        )
      },
      { includeLayerTree: true },
    )
  }

  /**
   * 预览态临时更新分组显隐。
   *
   * 预览交互需要看到分组开关的效果，但不能把这次变化登记进 CommandBus；退出预览时由
   * WidgetPreviewSnapshot 统一恢复。编辑态仍必须使用 setGroupVisible 记录正式历史。
   */
  const setGroupVisibleTransient = (groupId: string, visible: boolean) => {
    const group = widgetGroupIndex.value.get(groupId)
    if (!group || group.visible === visible) return

    widgetLayerTree.value = widgetLayerTree.value.map((node) =>
      node.type === 'group' && node.id === groupId ? { ...node, visible } : node,
    )
  }

  const setWidgetLocked = (widgetId: string, locked: boolean) => {
    const widget = getWidgetById(widgetId)
    const parentGroupId = getWidgetParentGroupId(widgetId)
    if (
      !widget ||
      (parentGroupId &&
        [parentGroupId, ...getWidgetGroupAncestorIds(parentGroupId)].some(isWidgetGroupLocked))
    ) {
      return false
    }
    if (getWidgetOwnLocked(widgetId) === locked) return true

    runWidgetHistoryChange('更新部件锁定', [widgetId], () => {
      widget.component.option = {
        ...((widget.component.option as Record<string, unknown> | undefined) || {}),
        locked,
      }
      bumpWidgetRenderVersion(widgetId)
    })
    /**
     * 锁定后立即撤销该部件的画布选中态，避免锁定操作完成后仍残留选中框，
     * 也避免后续键盘微调或其他编辑入口继续作用于已锁定部件。
     */
    if (locked && currentWidgetsIds.value?.includes(widgetId)) {
      clearCurrentWidgetSelection()
    }
    return true
  }

  const setWidgetGroupLocked = (groupId: string, locked: boolean) => {
    const group = widgetGroupIndex.value.get(groupId)
    if (
      !group ||
      group.locked === locked ||
      getWidgetGroupAncestorIds(groupId).some(isWidgetGroupLocked)
    ) {
      return false
    }
    runWidgetHistoryChange(
      '更新部件分组锁定',
      getGroupWidgetIds(groupId),
      () => {
        widgetLayerTree.value = widgetLayerTree.value.map((node) =>
          node.type === 'group' && node.id === groupId ? { ...node, locked } : node,
        )
      },
      { includeLayerTree: true },
    )
    return true
  }

  /**
   * 整体平移指定分组。
   * 这里只直接修改组内成员的位置，不 bump 渲染版本，避免拖动期间触发整层运行时 option 重算。
   */
  const moveWidgetGroup = (groupId: string, deltaX: number, deltaY: number) => {
    if (!deltaX && !deltaY) return
    if (isWidgetGroupTransformLocked(groupId)) return
    const groupWidgetIds = getGroupWidgetIds(groupId)
    if (!groupWidgetIds.length) return
    /**
     * 直接按组成员编号访问既有 Map，拖动每帧只遍历当前组成员，
     * 避免在大场景中反复扫描全部二维组件。
     */
    groupWidgetIds.forEach((widgetId) => {
      const item = getWidgetById(widgetId)
      if (!item) return
      item.component.attr.l += deltaX
      item.component.attr.t += deltaY
    })
  }

  const removeWidgetRuntimeValues = (id: string) => {
    if (!widgetRuntimeValueMap.value[id]) return
    const nextValueMap = { ...widgetRuntimeValueMap.value }
    delete nextValueMap[id]
    widgetRuntimeValueMap.value = nextValueMap
  }

  /**
   * 二维历史执行状态只通过命令端口读取。
   * 编辑态端口已将命令登记到唯一 CommandBus；预览态端口丢弃命令，Store 不直接依赖任何历史容器。
   */
  const isApplyingWidgetHistory = () => getWidgetCommandPort().isApplyingWidgetHistory()

  const getUniqueWidgetIds = (ids: string[]) => Array.from(new Set(ids.filter(Boolean)))

  const getWidgetIdsFromLayerTree = (tree: WidgetLayerNode[]) => flattenWidgetLayerTree(tree)

  const createWidgetHistorySnapshot = (
    ids: string[],
    options: WidgetHistorySnapshotOptions = {},
  ): WidgetHistorySnapshot => {
    const widgetIds = getUniqueWidgetIds(ids)
    const widgetIdSet = new Set(widgetIds)

    return {
      widgetIds,
      widgets: cloneDeep((totalWidgets.value || []).filter((item) => widgetIdSet.has(item.id))),
      widgetLayerTree: options.includeLayerTree ? cloneDeep(widgetLayerTree.value) : undefined,
      currentWidgetsIds: currentWidgetsIds.value ? [...currentWidgetsIds.value] : null,
      currentWidgetGroupId: currentWidgetGroupId.value,
      currentWidgetGroupIds: [...currentWidgetGroupIds.value],
    }
  }

  const hasWidgetHistoryPersistentChange = (
    oldSnapshot: WidgetHistorySnapshot,
    newSnapshot: WidgetHistorySnapshot,
  ) =>
    !isEqual(oldSnapshot.widgetIds, newSnapshot.widgetIds) ||
    !isEqual(oldSnapshot.widgets, newSnapshot.widgets) ||
    !isEqual(oldSnapshot.widgetLayerTree, newSnapshot.widgetLayerTree)

  /**
   * 将历史快照应用回部件仓库。
   *
   * 应用策略是“只处理受影响 ID”：
   * - 快照里存在的部件会替换当前同 ID 部件；
   * - 快照里不存在的受影响 ID 会从当前列表移除；
   * - 未受影响部件保持原引用，避免撤销单个属性时额外触发整层重渲染。
   */
  const applyWidgetHistorySnapshot = (snapshot: WidgetHistorySnapshot) => {
    const affectedIdSet = new Set(snapshot.widgetIds)
    const snapshotWidgetMap = new Map(snapshot.widgets.map((item) => [item.id, item]))
    const currentList = totalWidgets.value || []

    const nextWidgets = currentList
      .filter((item) => !affectedIdSet.has(item.id) || snapshotWidgetMap.has(item.id))
      .map((item) => {
        const snapshotWidget = snapshotWidgetMap.get(item.id)
        return snapshotWidget ? cloneDeep(snapshotWidget) : item
      })

    /**
     * 撤销“删除部件”时，快照中的部件已经不在当前列表里。
     * 这里按 snapshot.widgetIds 的顺序补回，真实层级顺序仍由图层树统一决定。
     */
    const existingIdSet = new Set(nextWidgets.map((item) => item.id))
    snapshot.widgetIds.forEach((id) => {
      const snapshotWidget = snapshotWidgetMap.get(id)
      if (!snapshotWidget || existingIdSet.has(id)) return
      nextWidgets.push(cloneDeep(snapshotWidget))
      existingIdSet.add(id)
    })

    totalWidgets.value = nextWidgets

    if (snapshot.widgetLayerTree) {
      widgetLayerTree.value = normalizeWidgetLayerTree(
        snapshot.widgetLayerTree,
        nextWidgets.map((item) => item.id),
      )
    }
    syncWidgetZIndexWithLayerTree()

    const nextWidgetIdSet = new Set(nextWidgets.map((item) => item.id))
    snapshot.widgetIds.forEach((id) => {
      if (!nextWidgetIdSet.has(id)) {
        removeWidgetRuntimeValues(id)
      }
    })

    const restoredSelectedWidgetIds =
      snapshot.currentWidgetsIds?.filter((id) => nextWidgetIdSet.has(id)) || []
    currentWidgetsIds.value = restoredSelectedWidgetIds.length ? restoredSelectedWidgetIds : null
    const validGroupIdSet = new Set(
      widgetLayerTree.value.filter((node) => node.type === 'group').map((node) => node.id),
    )
    currentWidgetGroupIds.value = snapshot.currentWidgetGroupIds.filter((id) =>
      validGroupIdSet.has(id),
    )
    currentWidgetGroupId.value =
      snapshot.currentWidgetGroupId &&
      validGroupIdSet.has(snapshot.currentWidgetGroupId) &&
      restoredSelectedWidgetIds.length === 0
        ? snapshot.currentWidgetGroupId
        : null
    widgetAnimationPreview.value = null

    snapshot.widgetIds.forEach((id) => {
      if (nextWidgetIdSet.has(id)) {
        bumpWidgetRenderVersion(id)
      }
    })
    useSceneStore().setTransformMaterialRandomId()
  }

  /** 捕获进入预览前的完整二维运行态，不产生历史命令。 */
  const createWidgetPreviewSnapshot = (): WidgetPreviewSnapshot => ({
    widgets: totalWidgets.value ? cloneDeep(totalWidgets.value) : null,
    widgetLayerTree: cloneDeep(widgetLayerTree.value),
    widgetRuntimeValueMap: cloneDeep(widgetRuntimeValueMap.value),
    currentWidgetsIds: currentWidgetsIds.value ? [...currentWidgetsIds.value] : null,
    currentWidgetGroupId: currentWidgetGroupId.value,
    currentWidgetGroupIds: [...currentWidgetGroupIds.value],
    currentWidgetChildSelection: currentWidgetChildSelection.value
      ? { ...currentWidgetChildSelection.value }
      : null,
  })

  /**
   * 恢复预览事务快照。
   * 直接替换二维配置，不调用任何编辑命令入口，因此不会污染撤销/重做记录；渲染版本递增保证
   * 预览期间被改写过的部件立即按编辑态配置重新渲染。
   */
  const restoreWidgetPreviewSnapshot = (snapshot: WidgetPreviewSnapshot) => {
    totalWidgets.value = snapshot.widgets ? cloneDeep(snapshot.widgets) : null

    const widgetIds = (totalWidgets.value || []).map((item) => item.id)
    widgetLayerTree.value = normalizeWidgetLayerTree(cloneDeep(snapshot.widgetLayerTree), widgetIds)
    widgetRuntimeValueMap.value = cloneDeep(snapshot.widgetRuntimeValueMap)

    const widgetIdSet = new Set(widgetIds)
    const validGroupIdSet = new Set(
      widgetLayerTree.value.filter((node) => node.type === 'group').map((node) => node.id),
    )
    currentWidgetsIds.value =
      snapshot.currentWidgetsIds?.filter((id) => widgetIdSet.has(id)) || null
    currentWidgetGroupIds.value = snapshot.currentWidgetGroupIds.filter((id) =>
      validGroupIdSet.has(id),
    )
    currentWidgetGroupId.value =
      snapshot.currentWidgetGroupId && validGroupIdSet.has(snapshot.currentWidgetGroupId)
        ? snapshot.currentWidgetGroupId
        : null
    currentWidgetChildSelection.value =
      snapshot.currentWidgetChildSelection &&
      widgetIdSet.has(snapshot.currentWidgetChildSelection.frameId)
        ? { ...snapshot.currentWidgetChildSelection }
        : null
    widgetAnimationPreview.value = null

    syncWidgetZIndexWithLayerTree()
    widgetIds.forEach((id) => bumpWidgetRenderVersion(id))
    useSceneStore().setTransformMaterialRandomId()
  }

  const recordWidgetHistorySnapshot = (
    name: string,
    oldSnapshot: WidgetHistorySnapshot,
    newSnapshot: WidgetHistorySnapshot,
    mergeSession?: symbol,
  ) => {
    if (isApplyingWidgetHistory()) return
    if (!hasWidgetHistoryPersistentChange(oldSnapshot, newSnapshot)) return

    getWidgetCommandPort().executeWidgetCommand(
      new WidgetCommand(name, oldSnapshot, newSnapshot, {
        createWidgetHistorySnapshot,
        applyWidgetHistorySnapshot,
      }, mergeSession),
    )
  }

  const runWidgetHistoryChange = <T>(
    name: string,
    ids: string[],
    mutate: () => T,
    options: WidgetHistorySnapshotOptions = {},
  ): T => {
    if (isApplyingWidgetHistory()) {
      return mutate()
    }

    getWidgetCommandPort().assertCanEdit?.()
    const oldSnapshot = createWidgetHistorySnapshot(ids, options)
    try {
      const result = mutate()
      const newSnapshot = createWidgetHistorySnapshot(ids, options)
      recordWidgetHistorySnapshot(name, oldSnapshot, newSnapshot, options.mergeSession)
      return result
    } catch (error) {
      // 外部配置和平台Store不共享事务，首次编辑或登记失败也必须恢复受影响部件。
      applyWidgetHistorySnapshot(oldSnapshot)
      throw error
    }
  }

  /**
   * 按键盘方向键微调当前选中的二维部件。
   *
   * 位置使用发布舞台的逻辑坐标，不能把屏幕缩放比例带入步长计算；因此每次方向键
   * 只修改一个 l/t 单位。多选、父子选中和分组选中都按同一个整体位移处理，避免
   * 部件之间的相对位置被破坏；同时复用二维历史快照，使每一次按键都能独立撤销。
   */
  const nudgeCurrentWidgets = (direction: WidgetNudgeDirection) => {
    const deltaByDirection: Record<WidgetNudgeDirection, { x: number; y: number }> = {
      up: { x: 0, y: -1 },
      down: { x: 0, y: 1 },
      left: { x: -1, y: 0 },
      right: { x: 1, y: 0 },
    }
    const { x: requestedDeltaX, y: requestedDeltaY } = deltaByDirection[direction]
    const selectedIds = currentWidgetGroupId.value
      ? getGroupWidgetIds(currentWidgetGroupId.value)
      : currentWidgetsIds.value || []
    if (!selectedIds.length) return false

    /** 选中父组件时连同完整子树移动；Set 保证父子同时选中时不会重复位移。 */
    const movingWidgetIds = getUniqueWidgetIds(
      selectedIds.flatMap((widgetId) => [widgetId, ...getWidgetDescendantIds(widgetId)]),
    ).filter((widgetId) => Boolean(getWidgetById(widgetId)))
    if (!movingWidgetIds.length || movingWidgetIds.some((widgetId) => isWidgetLocked(widgetId))) {
      return false
    }

    const movingWidgets = movingWidgetIds
      .map((widgetId) => getWidgetById(widgetId))
      .filter((widget): widget is WidgetConfig => Boolean(widget))
    const bounds = movingWidgets.reduce(
      (result, widget) => {
        const { l, t, w, h } = widget.component.attr
        return {
          minLeft: Math.min(result.minLeft, l),
          minTop: Math.min(result.minTop, t),
          maxRight: Math.max(result.maxRight, l + w),
          maxBottom: Math.max(result.maxBottom, t + h),
        }
      },
      {
        minLeft: Number.POSITIVE_INFINITY,
        minTop: Number.POSITIVE_INFINITY,
        maxRight: Number.NEGATIVE_INFINITY,
        maxBottom: Number.NEGATIVE_INFINITY,
      },
    )
    const canvas = getWidgetCanvasSize()

    /**
     * 与鼠标拖拽保持一致：越过画布边界时只移动到边界，不产生无效历史命令。
     * 若已有异常数据导致部件整体大于画布，则该方向不移动，避免计算出反向位移。
     */
    const clampNudgeDelta = (requested: number, minimum: number, maximum: number) => {
      if (!requested || minimum > maximum) return 0
      return Math.min(Math.max(requested, minimum), maximum)
    }
    const deltaX = clampNudgeDelta(requestedDeltaX, -bounds.minLeft, canvas.width - bounds.maxRight)
    const deltaY = clampNudgeDelta(
      requestedDeltaY,
      -bounds.minTop,
      canvas.height - bounds.maxBottom,
    )
    if (!deltaX && !deltaY) return false

    runWidgetHistoryChange('微调部件位置', movingWidgetIds, () => {
      movingWidgets.forEach((widget) => {
        widget.component.attr.l += deltaX
        widget.component.attr.t += deltaY
      })
    })
    return true
  }

  const setWidgetRuntimeValue = (id: string | undefined, field: string, value: unknown) => {
    if (!id || !field) return

    const currentFieldMap = widgetRuntimeValueMap.value[id] || {}
    if (Object.is(currentFieldMap[field], value)) {
      return
    }

    widgetRuntimeValueMap.value = {
      ...widgetRuntimeValueMap.value,
      [id]: {
        ...currentFieldMap,
        [field]: value,
      },
    }

    /**
     * 当前部件值属于预览期运行态数据。
     * 这里仍然要触发全局状态规则，因为规则可能跨部件、跨模型引用当前值。
     * 但不再每次输入都同步全量扫描，而是交给状态模块按帧合并调度，
     * 避免输入控件拖动、连续输入时把主线程反复打满。
     */
    const widgetRuntimePort = getWidgetRuntimePort()
    if (widgetRuntimePort.isPreview()) {
      widgetRuntimePort.scheduleStatusEvaluation()
    }
  }

  const createWidget = async (
    modelData: WidgetModel,
    vector2: { clientX: number; clientY: number },
  ) => {
    // 拖入组件安装期间若整场景被替换或清空，迟到的创建结果不能污染新场景。
    getWidgetCommandPort().assertCanEdit?.()
    const generation = widgetRestoreGeneration
    const { packageName, keyName } = modelData
    const widgetInstalled = await installWidget(packageName, keyName)
    if (!widgetInstalled) return null
    const config = await loadConfig(packageName, keyName)
    if (!config || generation !== widgetRestoreGeneration) return null

    getWidgetCommandPort().assertCanEdit?.()
    const component = new config.default()

    if (modelData.preset?.option) {
      /**
       * 图标页签的 125 张卡片复用同一个 `VIcon` 组件。
       * 这里把拖拽卡片携带的 option 合并到新实例，避免所有图标落到画布后都退回默认 apple。
       */
      component.option = {
        ...(cloneDeep(component.option) as Record<string, unknown>),
        ...cloneDeep(modelData.preset.option),
      }
    }

    if (modelData.preset?.dataConfig) {
      /**
       * 预设数据配置跟随新实例保存。
       * 右侧数据面板读取组件时就能展示当前图标名对应的静态数据，而不是空数组。
       */
      component.dataConfig = cloneDeep(modelData.preset.dataConfig)
    }

    /**
     * 页面框架是舞台级视觉底框：从资源面板首次拖入时，应立即贴合当前发布舞台，
     * 而不是沿用普通部件“以鼠标落点为中心”的定位规则。这里只影响新建实例；
     * 载入旧场景以及创建后的八方向缩放仍然使用持久化的 attr，不会覆盖用户调整结果。
     */
    if (packageName === 'Widget' && keyName === 'VPageMenu') {
      const { width, height } = getWidgetCanvasConfig()
      component.attr.l = 0
      component.attr.t = 0
      component.attr.w = width
      component.attr.h = height
    } else {
      const canvasPoint = screenPointToWidgetCanvasPoint(vector2.clientX, vector2.clientY)
      component.attr.l = Math.round(canvasPoint.x - component.attr.w / 2)
      component.attr.t = Math.round(canvasPoint.y - component.attr.h / 2)
    }

    /** 二维部件与三维对象共享雪花编号生成器，保证同一场景会话内的业务主键不重复。 */
    const widgetId = createSnowflakeId()
    const oldSnapshot = createWidgetHistorySnapshot([widgetId], { includeLayerTree: true })
    setTotalWidgets((widgets) => [...(widgets || []), { id: widgetId, component }])
    widgetLayerTree.value = appendWidgetLayerNode(widgetLayerTree.value, widgetId)
    syncWidgetZIndexWithLayerTree()
    /**
     * 空列表拖入第一个部件时，DOM 层会经历“实例表先变化、图层树随后补齐”的同帧更新。
     * 显式 bump 新实例的渲染版本，确保动态组件在最终 option 和图层树就绪后重新挂载一次，
     * 避免首个部件只出现编辑框而内容仍停留在默认空运行态。
     */
    bumpWidgetRenderVersion(widgetId)
    recordWidgetHistorySnapshot(
      '新增部件',
      oldSnapshot,
      createWidgetHistorySnapshot([widgetId], { includeLayerTree: true }),
    )

    return widgetId
  }

  /**
   * 把序列化二维配置恢复为已安装的运行时组件配置。
   * 全量场景恢复和发布预览的隐藏组件首次激活共用这一条转换链，避免两处分别加载默认配置后
   * 产生不同的字段合并结果。
   */
  const hydrateSavedWidgets = async (widgets: WidgetConfig[]) =>
    Promise.all(
      widgets.map(async ({ id, component, parentId }) => {
        const { packageName, keyName } = component.info
        await installWidget(packageName, keyName)
        const config = await loadConfig(packageName, keyName)
        return {
          id,
          ...(parentId ? { parentId } : {}),
          component: config
            ? mergeWidgetComponentWithDefaults(new config.default(), component)
            : normalizeWidgetComponent(component),
        }
      }),
    )

  /** 只保留当前已创建二维组件的运行时值，防止跨场景或按需缓存释放后残留旧数据。 */
  const retainWidgetRuntimeValues = (widgets: readonly WidgetConfig[]) => {
    const validWidgetIdSet = new Set(widgets.map((item) => item.id))
    widgetRuntimeValueMap.value = Object.fromEntries(
      Object.entries(widgetRuntimeValueMap.value).filter(([widgetId]) =>
        validWidgetIdSet.has(widgetId),
      ),
    )
  }

  // 每次整场景恢复推进代次；离开页面时的空恢复也会使旧组件安装结果失效。
  let widgetRestoreGeneration = 0
  const loadSavedWidgets = async (widgets: WidgetConfig[], tree?: WidgetLayerNode[] | null) => {
    const generation = ++widgetRestoreGeneration
    /**
     * 已保存部件属于“场景快照恢复”，语义上应该覆盖当前部件列表，
     * 不能继续沿用 createWidget 的“追加”模式。
     *
     * 之前这里每次加载都 append 一遍：
     * 1. 场景初始化如果被触发多次，会把同一批部件重复塞进 totalWidgets。
     * 2. 重复项沿用同一个 id，结构树与画布的“选中态”判断会同时命中两条记录。
     * 3. 最终表现就是：每个图表/控件显示两份，并且点击一个两个一起选中。
     *
     * 这里改成“先安装依赖，再一次性覆盖写入”，并按 id 去重，
     * 保证 totalWidgets 始终只保留当前场景真实存在的一份部件实例。
     */
    const loadedWidgets = await hydrateSavedWidgets(widgets)
    if (generation !== widgetRestoreGeneration) return

    /**
     * 后端历史数据或重复初始化都可能带来相同 id 的部件记录。
     * 这里统一保留第一次出现的实例，避免同一个 id 在结构树和画布层被渲染多次。
     */
    const deduplicatedWidgets = normalizeWidgetHierarchy(deduplicateWidgetsById(loadedWidgets))

    /**
     * 场景整体回显时，运行时值注册表也要同步按最新部件集合裁剪。
     * 否则上一个场景残留的部件值，可能被新的规则误读成当前实例状态。
     */
    retainWidgetRuntimeValues(deduplicatedWidgets)

    setTotalWidgets(deduplicatedWidgets)
    const widgetIds = deduplicatedWidgets.map((item) => item.id)
    /**
     * 旧场景没有视觉管理树时，以原 zIndex 升序建立“背景到前景”结构树；
     * 已有树则严格保留用户当前分组和排序，不再根据组件数组顺序重排。
     */
    const layerTreeInput =
      tree ??
      createDefaultWidgetLayerTree(
        [...deduplicatedWidgets]
          .sort((left, right) => left.component.attr.zIndex - right.component.attr.zIndex)
          .map((item) => item.id),
      )
    widgetLayerTree.value = normalizeWidgetLayerTree(layerTreeInput, widgetIds)
    syncWidgetZIndexWithLayerTree()
  }

  /**
   * 向当前二维仓库追加此前未创建的已保存组件。
   *
   * 该入口服务发布预览的首次显示：首屏只恢复初始有效可见组件，隐藏组件配置留在页面内存；
   * 动作第一次显示目标时仅安装新增组件，并用缓存的完整结构树重建当前已激活子集。已有组件
   * 不会重新安装或替换，避免图表实例、输入值和数据请求因另一个组件激活而被重置。
   */
  const appendSavedWidgets = async (widgets: WidgetConfig[], tree?: WidgetLayerNode[] | null) => {
    const generation = widgetRestoreGeneration
    const currentWidgets = totalWidgets.value || []
    const currentIds = new Set(currentWidgets.map((item) => item.id))
    const missingWidgets = deduplicateWidgetsById(widgets).filter(
      (item) => !currentIds.has(item.id),
    )
    if (!missingWidgets.length) return

    const loadedWidgets = await hydrateSavedWidgets(missingWidgets)
    if (generation !== widgetRestoreGeneration) return
    // 同代次可能并行激活多个隐藏组件，合并最新列表，避免后完成者覆盖先完成者。
    const nextWidgets = normalizeWidgetHierarchy(
      deduplicateWidgetsById([...(totalWidgets.value || []), ...loadedWidgets]),
    )
    setTotalWidgets(nextWidgets)
    retainWidgetRuntimeValues(nextWidgets)

    const widgetIds = nextWidgets.map((item) => item.id)
    /**
     * 按需加载传入的是完整发布树，结构上必须用它补齐新组件；但当前树已包含预览切页产生的
     * 临时分组显隐，不能在追加组件时被发布初始值覆盖，否则页面会瞬间回到默认首页。
     */
    const layerTreeInput = tree
      ? preserveWidgetLayerRuntimeState(tree, widgetLayerTree.value)
      : widgetLayerTree.value
    widgetLayerTree.value = normalizeWidgetLayerTree(layerTreeInput, widgetIds)
    syncWidgetZIndexWithLayerTree()
    loadedWidgets.forEach((item) => bumpWidgetRenderVersion(item.id))
  }

  const deleteWidgets = (ids: string[]) => {
    const targetIds = getUniqueWidgetIds(ids)
    if (!targetIds.length) return
    if (targetIds.some((id) => isWidgetLocked(id))) return

    const targetIdSet = new Set(targetIds)
    const promotedChildIds = (totalWidgets.value || [])
      .filter(
        (item) => item.parentId && targetIdSet.has(item.parentId) && !targetIdSet.has(item.id),
      )
      .map((item) => item.id)
    const affectedIds = getUniqueWidgetIds([...targetIds, ...promotedChildIds])

    runWidgetHistoryChange(
      '删除部件',
      affectedIds,
      () => {
        setTotalWidgets((widgets) =>
          (widgets || [])
            .filter((item) => !targetIdSet.has(item.id))
            .map((item) => {
              if (!item.parentId || !targetIdSet.has(item.parentId)) return item
              let nextParentId: string | undefined = item.parentId
              const visitedIds = new Set([item.id])
              while (
                nextParentId &&
                targetIdSet.has(nextParentId) &&
                !visitedIds.has(nextParentId)
              ) {
                visitedIds.add(nextParentId)
                nextParentId = getWidgetParentId(nextParentId) || undefined
              }
              if (nextParentId) return { ...item, parentId: nextParentId }
              const { parentId: _removedParentId, ...rootWidget } = item
              return rootWidget
            }),
        )
        widgetLayerTree.value = targetIds.reduce(
          (currentTree, id) => removeWidgetFromLayerTree(currentTree, id),
          widgetLayerTree.value,
        )
        syncWidgetZIndexWithLayerTree()
        targetIds.forEach((id) => {
          removeWidgetRuntimeValues(id)
        })
        if (currentWidgetsIds.value?.some((id) => targetIdSet.has(id))) {
          currentWidgetsIds.value = null
        }
        if (
          currentWidgetChildSelection.value &&
          targetIdSet.has(currentWidgetChildSelection.value.frameId)
        ) {
          currentWidgetChildSelection.value = null
        }
        const selectedGroupId = currentWidgetGroupId.value
        if (
          selectedGroupId &&
          !widgetLayerTree.value.some(
            (node) => node.type === 'group' && node.id === selectedGroupId,
          )
        ) {
          currentWidgetGroupId.value = null
          currentWidgetGroupIds.value = []
        }
      },
      { includeLayerTree: true },
    )
  }

  /**
   * 复制当前二维部件及其完整子树，并把副本插入到原部件正下方。
   *
   * 图层树的顺序约定为“越靠后越在上层”，因此无论部件位于根级还是某个分组内，
   * 都把新节点插到原节点之后。选中父组件时，子组件和更深层后代会一起复制，并将父级
   * 引用改写为副本树中的对应 ID；配置使用深复制，副本默认成为新的选中项，便于直接
   * 拖拽整棵子树到其他位置。
   */
  const duplicateWidgets = (ids: string[] = currentWidgetsIds.value || []) => {
    const selectedWidgetIds = getUniqueWidgetIds(ids)
    const sourceIdSet = new Set(
      selectedWidgetIds.flatMap((id) => [id, ...getWidgetDescendantIds(id)]),
    )
    const orderedSourceIds = flattenWidgetLayerTree(widgetLayerTree.value).filter((id) =>
      sourceIdSet.has(id),
    )
    if (!orderedSourceIds.length) return []
    if (orderedSourceIds.some((id) => !getWidgetById(id) || isWidgetLocked(id))) return []

    const duplicateIds = orderedSourceIds.map(() => createSnowflakeId())
    const affectedIds = [...orderedSourceIds, ...duplicateIds]

    return runWidgetHistoryChange(
      '复制部件',
      affectedIds,
      () => {
        const sourceMap = new Map(orderedSourceIds.map((id) => [id, getWidgetById(id)!]))
        const duplicateIdBySourceId = new Map(
          orderedSourceIds.map((sourceId, index) => [sourceId, duplicateIds[index]!]),
        )
        const duplicatedWidgets = orderedSourceIds.map((sourceId, index) => ({
          id: duplicateIds[index]!,
          ...(sourceMap.get(sourceId)!.parentId
            ? {
                parentId:
                  duplicateIdBySourceId.get(sourceMap.get(sourceId)!.parentId!) ||
                  sourceMap.get(sourceId)!.parentId,
              }
            : {}),
          component: cloneDeep(sourceMap.get(sourceId)!.component),
        }))

        setTotalWidgets((widgets) => [...widgets, ...duplicatedWidgets])

        const nextTree = widgetLayerTree.value.map((node) =>
          node.type === 'group' ? { ...node, children: [...node.children] } : { ...node },
        )
        orderedSourceIds.forEach((sourceId, index) => {
          const duplicateId = duplicateIds[index]!
          const group = nextTree.find(
            (node): node is Extract<WidgetLayerNode, { type: 'group' }> =>
              node.type === 'group' && node.children.includes(sourceId),
          )
          if (group) {
            const sourceIndex = group.children.indexOf(sourceId)
            group.children.splice(sourceIndex + 1, 0, duplicateId)
            return
          }

          const rootIndex = nextTree.findIndex(
            (node) => node.type === 'widget' && node.id === sourceId,
          )
          if (rootIndex >= 0) nextTree.splice(rootIndex + 1, 0, { id: duplicateId, type: 'widget' })
        })

        widgetLayerTree.value = nextTree
        syncWidgetZIndexWithLayerTree()
        duplicateIds.forEach((id) => bumpWidgetRenderVersion(id))
        setCurrentWidgetsIds(duplicateIds)
        return duplicateIds
      },
      { includeLayerTree: true },
    )
  }

  /**
   * 重排整个顶层图层树。
   * 顶层拖拽排序直接用这份方法落盘，避免视图组件自行改状态造成结构漂移。
   */
  const reorderWidgetLayerTree = (tree: WidgetLayerNode[]) => {
    const affectedIds = getUniqueWidgetIds([
      ...getWidgetIdsFromLayerTree(widgetLayerTree.value),
      ...getWidgetIdsFromLayerTree(tree),
    ])
    runWidgetHistoryChange('调整部件图层顺序', affectedIds, () => setWidgetLayerTree(tree), {
      includeLayerTree: true,
    })
  }

  /**
   * 按 vuedraggable 的最终 newIndex 重排一个根级节点。
   * 视图层只传稳定节点编号和目标位置，Store 基于当前真实树构造最终快照并复用一次历史事务；
   * 不接收组件先发出的 update:modelValue 中间数组，避免根级拖入分组或组内成员拖回根级时写出双历史。
   */
  const moveWidgetLayerNodeAtRoot = (nodeId: string, targetIndex?: number) => {
    if (!Number.isFinite(targetIndex)) return false

    const currentTree = widgetLayerTree.value
    const groupParentIndex = buildWidgetGroupParentIndex(currentTree)
    const rootNodes = currentTree.filter(
      (node) => node.type === 'widget' || !groupParentIndex.has(node.id),
    )
    const nestedGroupNodes = currentTree.filter(
      (node) => node.type === 'group' && groupParentIndex.has(node.id),
    )
    const sourceIndex = rootNodes.findIndex((node) => node.id === nodeId)
    if (sourceIndex < 0) return false

    const nextRootNodes = [...rootNodes]
    const [movedNode] = nextRootNodes.splice(sourceIndex, 1)
    const insertIndex = Math.max(0, Math.min(Math.trunc(targetIndex!), nextRootNodes.length))
    if (insertIndex === sourceIndex) return false

    nextRootNodes.splice(insertIndex, 0, movedNode)
    reorderWidgetLayerTree([...nextRootNodes, ...nestedGroupNodes])
    return true
  }

  /** 分组拖到另一分组行时作为其子分组插入，单次提交树和画布层级。 */
  const moveWidgetGroupToGroup = (groupId: string, targetGroupId: string, targetIndex = 0) => {
    if ([groupId, ...getWidgetGroupAncestorIds(groupId)].some(isWidgetGroupLocked)) return false
    if ([targetGroupId, ...getWidgetGroupAncestorIds(targetGroupId)].some(isWidgetGroupLocked)) {
      return false
    }
    const nextTree = moveWidgetGroupIntoGroup(
      widgetLayerTree.value,
      groupId,
      targetGroupId,
      targetIndex,
    )
    if (nextTree === widgetLayerTree.value || isEqual(nextTree, widgetLayerTree.value)) return false

    runWidgetHistoryChange(
      '调整部件分组层级',
      getWidgetIdsFromLayerTree(widgetLayerTree.value),
      () => {
        widgetLayerTree.value = nextTree
        syncWidgetZIndexWithLayerTree()
        setCurrentWidgetGroupId(groupId)
      },
      { includeLayerTree: true },
    )
    return true
  }

  /**
   * 重排指定组内的 children。
   * 当前不支持跨组拖入拖出，因此这里只接受“同组内新顺序”。
   */
  const reorderWidgetGroupChildren = (groupId: string, children: string[]) => {
    const currentGroupIds = getGroupWidgetIds(groupId)
    if (isWidgetGroupLocked(groupId) || currentGroupIds.some((id) => isWidgetLocked(id))) return
    const currentIdSet = new Set(currentGroupIds)
    const nextIdSet = new Set(children)
    /** 组内排序只能改变顺序，成员增删或跨组移动必须走 moveWidgetToGroup 的单次事务。 */
    if (
      currentIdSet.size !== nextIdSet.size ||
      currentGroupIds.some((id) => !nextIdSet.has(id)) ||
      children.some((id) => !currentIdSet.has(id))
    ) {
      return
    }
    const affectedIds = getUniqueWidgetIds([...currentGroupIds, ...children])
    runWidgetHistoryChange(
      '调整部件组内顺序',
      affectedIds,
      () => {
        widgetLayerTree.value = widgetLayerTree.value.map((node) =>
          node.type === 'group' && node.id === groupId
            ? {
                ...node,
                children: [...children],
              }
            : node,
        )
        syncWidgetZIndexWithLayerTree()
      },
      { includeLayerTree: true },
    )
  }

  /**
   * 创建真实图层组。
   * 仅允许把同一视觉父层级下的多个部件组成一个组；选中父组件时连同完整子树一起入组，
   * 组创建后默认选中新组。
   */
  const createWidgetGroup = (widgetIds: string[]) => {
    const groupMemberIds = getWidgetGroupMemberIds(widgetIds)
    if (!groupMemberIds.length) return null
    if (!areWidgetIdsInSameParent(widgetLayerTree.value, groupMemberIds)) return null
    if (groupMemberIds.some((id) => isWidgetLocked(id))) return null
    /** 二维分组也是可持久化场景层级对象，统一使用雪花编号，避免与部件主键碰撞。 */
    const groupId = createSnowflakeId()
    const groupName = buildNextWidgetGroupName(widgetLayerTree.value)
    return runWidgetHistoryChange(
      '创建部件分组',
      groupMemberIds,
      () => {
        widgetLayerTree.value = createWidgetGroupLayerTree(
          widgetLayerTree.value,
          groupId,
          groupName,
          groupMemberIds,
        )
        syncWidgetZIndexWithLayerTree()
        setCurrentWidgetGroupId(groupId)
        return groupId
      },
      { includeLayerTree: true },
    )
  }

  /**
   * 与创建动作共用同一套成员展开和边界校验，避免右键菜单显示可用但点击后无响应。
   */
  const canCreateWidgetGroup = (widgetIds: string[]) => {
    const groupMemberIds = getWidgetGroupMemberIds(widgetIds)
    return (
      groupMemberIds.length > 0 &&
      areWidgetIdsInSameParent(widgetLayerTree.value, groupMemberIds) &&
      groupMemberIds.every((id) => !isWidgetLocked(id))
    )
  }

  /** 将多个同层级旧分组包进新父组；旧分组节点和成员保持原样。 */
  const createWidgetGroupFromGroups = (groupIds: string[]) => {
    const selectedGroupIds = getUniqueWidgetIds(groupIds).filter((id) =>
      widgetGroupIndex.value.has(id),
    )
    if (!areWidgetGroupIdsInSameParent(widgetLayerTree.value, selectedGroupIds)) return null
    if (selectedGroupIds.some((id) => isWidgetGroupTransformLocked(id))) return null

    const groupId = createSnowflakeId()
    const groupName = buildNextWidgetGroupName(widgetLayerTree.value)
    const affectedWidgetIds = getUniqueWidgetIds(selectedGroupIds.flatMap(getGroupWidgetIds))
    return runWidgetHistoryChange(
      '创建嵌套部件分组',
      affectedWidgetIds,
      () => {
        widgetLayerTree.value = createWidgetGroupLayerTreeFromGroups(
          widgetLayerTree.value,
          groupId,
          groupName,
          selectedGroupIds,
        )
        syncWidgetZIndexWithLayerTree()
        setCurrentWidgetGroupId(groupId)
        return groupId
      },
      { includeLayerTree: true },
    )
  }

  const canCreateWidgetGroupFromGroups = (groupIds: string[]) => {
    const selectedGroupIds = getUniqueWidgetIds(groupIds).filter((id) =>
      widgetGroupIndex.value.has(id),
    )
    return (
      areWidgetGroupIdsInSameParent(widgetLayerTree.value, selectedGroupIds) &&
      selectedGroupIds.every((id) => !isWidgetGroupTransformLocked(id))
    )
  }

  /**
   * 把同层级的普通组件与既有视觉分组一次包装为新父组。
   * 组件父子树会完整展开进新组，既有分组则保留边界并作为 childGroupIds 被引用。
   */
  const createWidgetGroupFromMixedSelection = (widgetIds: string[], groupIds: string[]) => {
    const groupMemberIds = getExpandedWidgetSelectionIds(widgetIds)
    const selectedGroupIds = getUniqueWidgetIds(groupIds).filter((id) =>
      widgetGroupIndex.value.has(id),
    )
    if (!groupMemberIds.length || !selectedGroupIds.length) return null
    if (
      !areWidgetLayerSelectionsInSameParent(widgetLayerTree.value, groupMemberIds, selectedGroupIds)
    ) {
      return null
    }
    if (groupMemberIds.some((id) => isWidgetLocked(id))) return null
    if (selectedGroupIds.some((id) => isWidgetGroupTransformLocked(id))) return null

    const groupId = createSnowflakeId()
    const groupName = buildNextWidgetGroupName(widgetLayerTree.value)
    const affectedWidgetIds = getUniqueWidgetIds([
      ...groupMemberIds,
      ...selectedGroupIds.flatMap(getGroupWidgetIds),
    ])
    return runWidgetHistoryChange(
      '创建混合部件分组',
      affectedWidgetIds,
      () => {
        widgetLayerTree.value = createWidgetGroupLayerTreeFromMixedSelection(
          widgetLayerTree.value,
          groupId,
          groupName,
          groupMemberIds,
          selectedGroupIds,
        )
        syncWidgetZIndexWithLayerTree()
        setCurrentWidgetGroupId(groupId)
        return groupId
      },
      { includeLayerTree: true },
    )
  }

  const canCreateWidgetGroupFromMixedSelection = (widgetIds: string[], groupIds: string[]) => {
    const groupMemberIds = getExpandedWidgetSelectionIds(widgetIds)
    const selectedGroupIds = getUniqueWidgetIds(groupIds).filter((id) =>
      widgetGroupIndex.value.has(id),
    )
    return (
      groupMemberIds.length > 0 &&
      selectedGroupIds.length > 0 &&
      areWidgetLayerSelectionsInSameParent(
        widgetLayerTree.value,
        groupMemberIds,
        selectedGroupIds,
      ) &&
      groupMemberIds.every((id) => !isWidgetLocked(id)) &&
      selectedGroupIds.every((id) => !isWidgetGroupTransformLocked(id))
    )
  }

  /** 创建可持久化的空分组，并立即选中以便右侧面板修改名称。 */
  const createEmptyWidgetGroup = () => {
    /** 空分组与真实分组采用同一编号策略，保证后续拖入部件时无需再次换号。 */
    const groupId = createSnowflakeId()
    const groupName = buildNextWidgetGroupName(widgetLayerTree.value)
    return runWidgetHistoryChange(
      '创建空部件分组',
      [],
      () => {
        widgetLayerTree.value = appendEmptyWidgetGroup(widgetLayerTree.value, groupId, groupName)
        setCurrentWidgetGroupId(groupId)
        return groupId
      },
      { includeLayerTree: true },
    )
  }

  /**
   * 把组件拖入、拖出或跨组移动。
   * 归属和拍平顺序在同一份树快照内提交，随后只同步一次 zIndex，确保一次拖拽只有一条历史。
   */
  const moveWidgetToGroup = (
    widgetId: string,
    targetGroupId: string | null,
    targetIndex?: number,
  ) => {
    if (!getWidgetById(widgetId) || isWidgetLocked(widgetId)) return false
    if (targetGroupId && isWidgetGroupLocked(targetGroupId)) return false

    const oldTree = widgetLayerTree.value
    const subtreeIdSet = new Set([widgetId, ...getWidgetDescendantIds(widgetId)])
    const orderedSubtreeIds = flattenWidgetLayerTree(oldTree).filter((id) => subtreeIdSet.has(id))
    const nextTree = moveWidgetLayerItems(oldTree, orderedSubtreeIds, targetGroupId, targetIndex)
    const currentParentId = getWidgetParentId(widgetId)
    if ((nextTree === oldTree || isEqual(nextTree, oldTree)) && !currentParentId) return false

    runWidgetHistoryChange(
      '调整部件分组归属',
      [widgetId],
      () => {
        const widget = getWidgetById(widgetId)
        if (widget?.parentId) delete widget.parentId
        widgetLayerTree.value = nextTree
        syncWidgetZIndexWithLayerTree()
      },
      { includeLayerTree: true },
    )
    return true
  }

  /**
   * 把一个或多个组件插入指定组件前后。
   * 拖拽过程中结构树只展示插入线，直到松手才调用本动作一次性提交顺序和 zIndex。
   */
  const moveWidgetsAroundWidget = (
    widgetIds: string[],
    relatedWidgetId: string,
    insertAfter: boolean,
  ) => {
    const relatedWidget = getWidgetById(relatedWidgetId)
    if (!relatedWidget || isWidgetLocked(relatedWidgetId)) return false

    const existingIds = getUniqueWidgetIds(widgetIds).filter((id) => Boolean(getWidgetById(id)))
    const rootIds = compactWidgetHierarchySelection(existingIds, widgetParentIndex.value)
    if (!rootIds.length || rootIds.includes(relatedWidgetId)) return false
    if (rootIds.some((id) => isWidgetLocked(id))) return false

    const movingIdSet = new Set(rootIds.flatMap((id) => [id, ...getWidgetDescendantIds(id)]))
    if (movingIdSet.has(relatedWidgetId)) return false
    const oldTree = widgetLayerTree.value
    const orderedMovingIds = flattenWidgetLayerTree(oldTree).filter((id) => movingIdSet.has(id))
    if (!orderedMovingIds.length) return false

    const targetGroupId = getWidgetParentGroupId(relatedWidgetId)
    if (targetGroupId && isWidgetGroupLocked(targetGroupId)) return false
    const remainingTree = moveWidgetLayerItems(oldTree, orderedMovingIds, null, 0)
      .filter((node) => node.type === 'group' || !movingIdSet.has(node.id))
      .map((node) =>
        node.type === 'group'
          ? { ...node, children: node.children.filter((id) => !movingIdSet.has(id)) }
          : node,
      )
    const relatedSubtreeIds = new Set([relatedWidgetId, ...getWidgetDescendantIds(relatedWidgetId)])

    let targetIndex = -1
    if (targetGroupId) {
      const targetGroup = remainingTree.find(
        (node): node is Extract<WidgetLayerNode, { type: 'group' }> =>
          node.type === 'group' && node.id === targetGroupId,
      )
      if (!targetGroup) return false
      const relatedIndexes = targetGroup.children
        .map((id, index) => (relatedSubtreeIds.has(id) ? index : -1))
        .filter((index) => index >= 0)
      if (!relatedIndexes.length) return false
      targetIndex = insertAfter ? Math.max(...relatedIndexes) + 1 : Math.min(...relatedIndexes)
    } else {
      const relatedIndexes = remainingTree
        .map((node, index) =>
          node.type === 'widget' && relatedSubtreeIds.has(node.id) ? index : -1,
        )
        .filter((index) => index >= 0)
      if (!relatedIndexes.length) return false
      targetIndex = insertAfter ? Math.max(...relatedIndexes) + 1 : Math.min(...relatedIndexes)
    }

    const nextTree = moveWidgetLayerItems(oldTree, orderedMovingIds, targetGroupId, targetIndex)
    // 插入目标前后表示成为目标的同级节点；即使数组顺序没变，也必须提交脱离父级的变化。
    const targetParentId = getWidgetParentId(relatedWidgetId)
    const parentChanged = rootIds.some((id) => getWidgetParentId(id) !== targetParentId)
    if (!parentChanged && isEqual(nextTree, oldTree)) return false

    runWidgetHistoryChange(
      '调整部件图层顺序',
      rootIds,
      () => {
        // 仅修改拖拽子树的根节点，后代归属和画布坐标保持原值，撤销快照同时记录父级与顺序。
        rootIds.forEach((id) => {
          const widget = getWidgetById(id)!
          if (targetParentId) widget.parentId = targetParentId
          else delete widget.parentId
        })
        widgetLayerTree.value = nextTree
        syncWidgetZIndexWithLayerTree()
        setCurrentWidgetsIds(rootIds)
      },
      { includeLayerTree: true },
    )
    return true
  }

  /**
   * 把一个或多个组件挂到目标组件下。
   *
   * 多选中同时包含祖先和后代时只移动最外层节点；所有子树会随目标进入同一视觉分组，
   * 父级写入和图层顺序调整由同一条历史命令提交。
   */
  const moveWidgetsUnderParent = (widgetIds: string[], targetParentId: string) => {
    const targetWidget = getWidgetById(targetParentId)
    if (!targetWidget || isWidgetLocked(targetParentId)) return false

    const existingIds = getUniqueWidgetIds(widgetIds).filter((id) => Boolean(getWidgetById(id)))
    const rootIds = compactWidgetHierarchySelection(existingIds, widgetParentIndex.value)
    if (!rootIds.length || rootIds.includes(targetParentId)) return false
    if (rootIds.some((id) => isWidgetLocked(id))) return false
    if (rootIds.some((id) => getWidgetDescendantIds(id).includes(targetParentId))) return false

    const movingIdSet = new Set(rootIds.flatMap((id) => [id, ...getWidgetDescendantIds(id)]))
    const orderedMovingIds = flattenWidgetLayerTree(widgetLayerTree.value).filter((id) =>
      movingIdSet.has(id),
    )
    if (!orderedMovingIds.length) return false

    const targetGroupId = getWidgetParentGroupId(targetParentId)
    const targetSubtreeIdSet = new Set([targetParentId, ...getWidgetDescendantIds(targetParentId)])
    const remainingTree = moveWidgetLayerItems(widgetLayerTree.value, orderedMovingIds, null, 0)
      .filter((node) => node.type === 'group' || !movingIdSet.has(node.id))
      .map((node) =>
        node.type === 'group'
          ? { ...node, children: node.children.filter((id) => !movingIdSet.has(id)) }
          : node,
      )

    let insertIndex = 0
    if (targetGroupId) {
      const targetGroup = remainingTree.find(
        (node): node is Extract<WidgetLayerNode, { type: 'group' }> =>
          node.type === 'group' && node.id === targetGroupId,
      )
      if (!targetGroup) return false
      const lastTargetIndex = targetGroup.children.reduce(
        (lastIndex, id, index) => (targetSubtreeIdSet.has(id) ? index : lastIndex),
        -1,
      )
      insertIndex = lastTargetIndex + 1
    } else {
      const lastTargetIndex = remainingTree.reduce(
        (lastIndex, node, index) =>
          node.type === 'widget' && targetSubtreeIdSet.has(node.id) ? index : lastIndex,
        -1,
      )
      insertIndex = lastTargetIndex + 1
    }

    const nextTree = moveWidgetLayerItems(
      widgetLayerTree.value,
      orderedMovingIds,
      targetGroupId,
      insertIndex,
    )
    const alreadyNested = rootIds.every((id) => getWidgetParentId(id) === targetParentId)
    if (alreadyNested && isEqual(nextTree, widgetLayerTree.value)) return false

    runWidgetHistoryChange(
      '调整部件父子关系',
      rootIds,
      () => {
        rootIds.forEach((id) => {
          const widget = getWidgetById(id)
          if (widget) widget.parentId = targetParentId
        })
        widgetLayerTree.value = nextTree
        syncWidgetZIndexWithLayerTree()
        setCurrentWidgetsIds(rootIds)
      },
      { includeLayerTree: true },
    )
    return true
  }

  /**
   * 更新视觉分组名称。
   * 改名进入统一二维历史，供右侧属性面板编辑并支持一次撤销。
   */
  const updateWidgetGroupName = (groupId: string, name: string) => {
    const trimmedName = name.trim()
    if (!trimmedName) return

    const group = widgetGroupIndex.value.get(groupId)
    if (!group || group.locked || group.name === trimmedName) return
    runWidgetHistoryChange(
      '更新部件分组名称',
      group.children,
      () => {
        widgetLayerTree.value = widgetLayerTree.value.map((node) =>
          node.type === 'group' && node.id === groupId ? { ...node, name: trimmedName } : node,
        )
      },
      { includeLayerTree: true },
    )
  }

  /** 删除视觉分组，成员按原组内顺序回到根级，不删除任何真实组件。 */
  const deleteWidgetGroup = (groupId: string) => {
    const group = widgetGroupIndex.value.get(groupId)
    const groupWidgetIds = getGroupWidgetIds(groupId)
    if (!group || isWidgetGroupTransformLocked(groupId)) return []
    return runWidgetHistoryChange(
      '删除部件分组',
      groupWidgetIds,
      () => {
        const result = deleteWidgetGroupLayerTree(widgetLayerTree.value, groupId)
        widgetLayerTree.value = result.nextTree
        syncWidgetZIndexWithLayerTree()
        if (currentWidgetGroupIds.value.includes(groupId)) setCurrentWidgetGroupId(null)
        return result.widgetIds
      },
      { includeLayerTree: true },
    )
  }

  /**
   * 解组后按组内顺序还原子部件，并默认选中这些子部件。
   */
  const ungroupWidgetGroup = (groupId: string) => {
    const widgetIds = deleteWidgetGroup(groupId)
    if (widgetIds.length > 0) setCurrentWidgetsIds(widgetIds)
    return widgetIds
  }

  return {
    boundingClientRect,
    setBoundingClientRect,
    widgetCanvasSize,
    widgetCanvasScale,
    widgetCanvasAutoScale,
    setWidgetCanvasSizeFromConfig,
    getWidgetCanvasConfig,
    getWidgetCanvasLayout,
    screenDeltaToWidgetCanvasDelta,
    screenPointToWidgetCanvasPoint,

    currentWidgetsIds,
    currentWidgetSelectionSource,
    setCurrentWidgetsIds,
    currentWidgetGroupId,
    setCurrentWidgetGroupId,
    currentWidgetGroupIds,
    setCurrentWidgetGroupIds,
    setCurrentWidgetMixedSelection,
    currentWidgetChildSelection,
    setCurrentWidgetChildSelection,
    clearCurrentWidgetSelection,
    widgetRenderVersionMap,
    bumpWidgetRenderVersion,
    widgetAnimationPreview,
    setWidgetAnimationPreview,
    widgetRuntimeValueMap,
    setWidgetRuntimeValue,
    removeWidgetRuntimeValues,
    createWidgetHistorySnapshot,
    recordWidgetHistorySnapshot,
    runWidgetHistoryChange,
    nudgeCurrentWidgets,
    applyWidgetHistorySnapshot,
    widgetLayerTree,
    setWidgetLayerTree,
    syncWidgetZIndexWithLayerTree,
    rebuildDefaultWidgetLayerTree,
    orderedWidgets,
    getOrderedWidgets,
    getWidgetParentId,
    getWidgetChildIds,
    getWidgetDescendantIds,
    getWidgetGroupMemberIds,
    canCreateWidgetGroup,
    getGroupWidgetIds,
    getWidgetParentGroupId,
    getWidgetGroupParentGroupId,
    getWidgetGroupAncestorIds,
    getWidgetGroupDescendantIds,
    isWidgetLocked,
    isWidgetGroupLocked,
    isWidgetGroupTransformLocked,
    isWidgetEffectivelyVisible,
    setWidgetVisible,
    getGroupBounds,
    getGroupVisible,
    setGroupVisible,
    setGroupVisibleTransient,
    setWidgetLocked,
    setWidgetGroupLocked,
    moveWidgetGroup,
    reorderWidgetLayerTree,
    moveWidgetLayerNodeAtRoot,
    moveWidgetGroupToGroup,
    reorderWidgetGroupChildren,
    createWidgetGroup,
    createWidgetGroupFromGroups,
    canCreateWidgetGroupFromGroups,
    createWidgetGroupFromMixedSelection,
    canCreateWidgetGroupFromMixedSelection,
    createEmptyWidgetGroup,
    moveWidgetToGroup,
    moveWidgetsAroundWidget,
    moveWidgetsUnderParent,
    updateWidgetGroupName,
    deleteWidgetGroup,
    ungroupWidgetGroup,

    totalWidgets,
    getWidgetById,
    createWidgetPreviewSnapshot,
    restoreWidgetPreviewSnapshot,
    createWidget,
    /** 拖拽等延迟写入按恢复代次失效，防止同编号新场景被旧回调污染。 */
    getWidgetRestoreGeneration: () => widgetRestoreGeneration,
    loadSavedWidgets,
    appendSavedWidgets,

    deleteWidgets,
    duplicateWidgets,
  }
})
