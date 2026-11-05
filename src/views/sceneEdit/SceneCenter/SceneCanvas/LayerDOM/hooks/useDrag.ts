import { getWidgetPointerSession } from '@/integrations/scene/widgetRuntime/widgetPointerSession'
import { throttle } from 'lodash-es'
import { getAspectLockedRect, getWidgetAspectRatio } from '@/utils/widgetAspectRatio'
import { DragType } from '../type'
import {
  resolveAlignedWidgetPosition,
  type AlignmentGuide,
  type AlignmentRect,
  type WidgetCanvasBounds,
} from '../alignment'
import { useSceneWidgetStore, type WidgetConfig } from '@/stores/sceneEditStore'

interface DragGuideOptions {
  onCancel?: () => void
  onGuidesChange?: (guides: AlignmentGuide[]) => void
}

interface GroupMoveAlignmentOptions extends DragGuideOptions {
  movingRect: AlignmentRect
  excludedWidgetIds: string[]
  targets?: AlignmentRect[]
  canvas?: WidgetCanvasBounds
}

/**
 * 解析画布拖动时真正需要一起移动的部件集合。
 *
 * 结构树多选只记录用户点选的部件 ID；如果其中包含父部件，父部件的子树也必须随之移动，
 * 但不能因为父子同时出现在选中集合里而重复计算位移。返回值保持首次出现顺序，便于历史
 * 快照和拖动期间的遍历稳定可预测。
 */
export const resolveWidgetMoveIds = (
  dragWidgetId: string,
  selectedWidgetIds: string[],
  getWidgetDescendantIds: (widgetId: string) => string[],
) => {
  const selection = selectedWidgetIds.includes(dragWidgetId) ? selectedWidgetIds : [dragWidgetId]

  return Array.from(
    new Set(selection.flatMap((widgetId) => [widgetId, ...getWidgetDescendantIds(widgetId)])),
  )
}

const createAlignmentContext = (
  sceneWidgetStore: ReturnType<typeof useSceneWidgetStore>,
  excludedWidgetIds: string[],
) => {
  const excludedIds = new Set(excludedWidgetIds)
  const layout = sceneWidgetStore.getWidgetCanvasLayout()
  const targets = sceneWidgetStore
    .getOrderedWidgets()
    .filter((item) => {
      if (excludedIds.has(item.id)) return false
      const ownVisible =
        (item.component.option as Record<string, unknown> | undefined)?.visible !== false
      return sceneWidgetStore.isWidgetEffectivelyVisible(item.id, ownVisible)
    })
    .map<AlignmentRect>((item) => ({
      id: item.id,
      l: item.component.attr.l,
      t: item.component.attr.t,
      w: item.component.attr.w,
      h: item.component.attr.h,
    }))

  return {
    canvas: { width: layout.width, height: layout.height },
    targets,
    /** 用户看到的吸附距离始终约为 5 屏幕像素，不随画布缩放而忽松忽紧。 */
    threshold: 5 / Math.max(layout.scale, Number.EPSILON),
  }
}

export const useMove = (
  e: MouseEvent,
  dragElement: WidgetConfig,
  options: DragGuideOptions = {},
) => {
  // 主键按下和松开配对，右键菜单等交互不创建拖拽事务。
  if (e.button !== 0) return
  e.stopPropagation()
  e.preventDefault()
  const sceneWidgetStore = useSceneWidgetStore()
  /**
   * Hook 是画布写入的最后一道防线。
   * 即使调用方漏做禁用态判断，锁定组件也不能注册全局拖拽监听或产生历史快照。
   */
  if (sceneWidgetStore.isWidgetLocked(dragElement.id)) return

  /**
   * 从结构树多选后，活动框的任意一个成员都可以成为拖动入口。
   * 这里只在拖动开始时读取一次选中集合，后续 pointer/mousemove 不再依赖可能变化的选中态，
   * 因而所有部件始终使用同一个逻辑画布增量，彼此的相对位置不会被破坏。
   */
  const selectedWidgetIds = (sceneWidgetStore.currentWidgetsIds || []).filter((widgetId) =>
    Boolean(sceneWidgetStore.getWidgetById(widgetId)),
  )
  const movingSelectionIds = resolveWidgetMoveIds(
    dragElement.id,
    selectedWidgetIds,
    sceneWidgetStore.getWidgetDescendantIds,
  )

  /** 多选中的锁定部件不能被其它已选部件拖动时绕过锁定保护，整个操作保持原子地不生效。 */
  if (selectedWidgetIds.some((widgetId) => sceneWidgetStore.isWidgetLocked(widgetId))) return

  const hierarchyOrigins = new Map(
    movingSelectionIds
      .map((id) => sceneWidgetStore.getWidgetById(id))
      .filter((item): item is WidgetConfig => Boolean(item))
      .map((item) => [item.id, { l: item.component.attr.l, t: item.component.attr.t }]),
  )
  const movingRect = movingSelectionIds.reduce<AlignmentRect | null>((bounds, widgetId) => {
    const item = sceneWidgetStore.getWidgetById(widgetId)
    if (!item) return bounds

    const { l, t, w, h } = item.component.attr
    if (!bounds) return { id: dragElement.id, l, t, w, h }

    const right = Math.max(bounds.l + bounds.w, l + w)
    const bottom = Math.max(bounds.t + bounds.h, t + h)
    return {
      ...bounds,
      l: Math.min(bounds.l, l),
      t: Math.min(bounds.t, t),
      w: right - Math.min(bounds.l, l),
      h: bottom - Math.min(bounds.t, t),
    }
  }, null) || {
    id: dragElement.id,
    l: dragElement.component.attr.l,
    t: dragElement.component.attr.t,
    w: dragElement.component.attr.w,
    h: dragElement.component.attr.h,
  }
  const pointer = getWidgetPointerSession()
  if (!pointer) return
  const oldSnapshot = sceneWidgetStore.createWidgetHistorySnapshot(movingSelectionIds)
  const alignmentContext = createAlignmentContext(sceneWidgetStore, movingSelectionIds)

  const origin = {
    l: dragElement.component.attr.l,
    t: dragElement.component.attr.t,
    clientX: e.clientX,
    clientY: e.clientY,
  }

  const handleDragMove = throttle((e: MouseEvent) => {
    if (!pointer.isActive()) return
    /**
     * 外层画布可能已经被 CSS 缩放。
     * 这里必须把屏幕像素位移换算成逻辑画布位移，才能保证部件保存的 l/t 不被显示缩放污染。
     */
    const delta = sceneWidgetStore.screenDeltaToWidgetCanvasDelta(
      e.clientX - origin.clientX,
      e.clientY - origin.clientY,
    )
    const alignedPosition = resolveAlignedWidgetPosition(
      {
        id: dragElement.id,
        l: origin.l,
        t: origin.t,
        w: dragElement.component.attr.w,
        h: dragElement.component.attr.h,
      },
      {
        l: Math.round(movingRect.l + delta.x),
        t: Math.round(movingRect.t + delta.y),
      },
      alignmentContext.targets,
      alignmentContext.canvas,
      alignmentContext.threshold,
    )
    const deltaX = alignedPosition.l - movingRect.l
    const deltaY = alignedPosition.t - movingRect.t
    hierarchyOrigins.forEach((itemOrigin, widgetId) => {
      const item = sceneWidgetStore.getWidgetById(widgetId)
      if (!item) return
      item.component.attr.l = itemOrigin.l + deltaX
      item.component.attr.t = itemOrigin.t + deltaY
    })
    options.onGuidesChange?.(alignedPosition.guides)
  }, 16)

  pointer.attach({
    move: handleDragMove,
    commit: () => sceneWidgetStore.recordWidgetHistorySnapshot(
      '移动部件', oldSnapshot, sceneWidgetStore.createWidgetHistorySnapshot(movingSelectionIds),
    ),
    rollback: () => sceneWidgetStore.applyWidgetHistorySnapshot(oldSnapshot),
    cleanup: () => options.onGuidesChange?.([]),
  })
}

/**
 * 分组整体拖拽。
 * 这里不关心组内结构，只把鼠标位移量交给外层回调统一分发给组内成员，
 * 这样可以复用现有拖拽节流策略，又不会把 store、DOM 逻辑耦合进 hook 里。
 */
export const useGroupMove = (
  e: MouseEvent,
  onMove: (deltaX: number, deltaY: number) => void,
  onEnd?: () => void,
  alignmentOptions?: GroupMoveAlignmentOptions,
) => {
  if (e.button !== 0) return
  e.stopPropagation()
  e.preventDefault()
  const sceneWidgetStore = useSceneWidgetStore()
  const pointer = getWidgetPointerSession()
  if (!pointer) return
  const alignmentContext = alignmentOptions
    ? {
        ...createAlignmentContext(sceneWidgetStore, alignmentOptions.excludedWidgetIds),
        ...(alignmentOptions.targets ? { targets: alignmentOptions.targets } : {}),
        ...(alignmentOptions.canvas ? { canvas: alignmentOptions.canvas } : {}),
      }
    : null

  const origin = {
    clientX: e.clientX,
    clientY: e.clientY,
    lastDeltaX: 0,
    lastDeltaY: 0,
  }

  const handleDragMove = throttle((e: MouseEvent) => {
    if (!pointer.isActive()) return
    /**
     * 分组移动只向外抛出逻辑增量。
     * 外层 store 继续批量修改组内成员坐标，避免拖动期间触发运行时配置重建。
     */
    const delta = sceneWidgetStore.screenDeltaToWidgetCanvasDelta(
      e.clientX - origin.clientX,
      e.clientY - origin.clientY,
    )
    let nextDeltaX = Math.round(delta.x)
    let nextDeltaY = Math.round(delta.y)
    if (alignmentOptions && alignmentContext) {
      const alignedPosition = resolveAlignedWidgetPosition(
        alignmentOptions.movingRect,
        {
          l: alignmentOptions.movingRect.l + nextDeltaX,
          t: alignmentOptions.movingRect.t + nextDeltaY,
        },
        alignmentContext.targets,
        alignmentContext.canvas,
        alignmentContext.threshold,
      )
      nextDeltaX = alignedPosition.l - alignmentOptions.movingRect.l
      nextDeltaY = alignedPosition.t - alignmentOptions.movingRect.t
      alignmentOptions.onGuidesChange?.(alignedPosition.guides)
    }
    onMove(nextDeltaX - origin.lastDeltaX, nextDeltaY - origin.lastDeltaY)
    origin.lastDeltaX = nextDeltaX
    origin.lastDeltaY = nextDeltaY
  }, 16)

  pointer.attach({
    move: handleDragMove,
    commit: () => onEnd?.(),
    rollback: () => alignmentOptions?.onCancel?.(),
    cleanup: () => alignmentOptions?.onGuidesChange?.([]),
  })
}

export const useResize = (e: MouseEvent, dragElement: WidgetConfig, type: DragType) => {
  if (e.button !== 0) return
  e.stopPropagation()
  e.preventDefault()
  const sceneWidgetStore = useSceneWidgetStore()
  /** 与移动保持相同的写入口守卫，阻止锁定组件通过控制点修改尺寸。 */
  if (sceneWidgetStore.isWidgetLocked(dragElement.id)) return
  const pointer = getWidgetPointerSession()
  if (!pointer) return
  const oldSnapshot = sceneWidgetStore.createWidgetHistorySnapshot([dragElement.id])

  const start = { clientX: e.clientX, clientY: e.clientY }
  const origin = { ...dragElement.component.attr }

  interface DiffVector2 {
    x: number
    y: number
  }

  interface ResizeConfig {
    w?: boolean // 改变宽度，true 为 +，false 为 -
    h?: boolean // 改变高度，true 为 +，false 为 -
    lImmediate?: boolean // 是否立即改变左侧位置，true 为立即改变，false 为宽度 ≤ 0后改变
    tImmediate?: boolean // 是否立即改变顶部位置，true 为立即改变，false 为高度 ≤ 0后改变
  }

  const createResizeStrategy = (config: ResizeConfig) => {
    return (element: WidgetConfig, diff: DiffVector2) => {
      // 比例取自按下时的快照，直接写回同一属性对象，复用已有节流和撤销记录。
      if (getWidgetAspectRatio(origin)) {
        Object.assign(
          element.component.attr,
          getAspectLockedRect(origin, config.w, config.h, diff.x, diff.y),
        )
        return
      }
      if (config.hasOwnProperty('w')) {
        const newWidth = Math.max(0, origin.w + (config.w ? diff.x : -diff.x))
        element.component.attr.w = newWidth

        if (config.lImmediate) {
          dragElement.component.attr.l = origin.l + diff.x
        } else if (newWidth <= 0) {
          dragElement.component.attr.l = origin.l + diff.x + origin.w
        }
      }
      if (config.hasOwnProperty('h')) {
        const newHeight = Math.max(0, origin.h + (config.h ? diff.y : -diff.y))
        element.component.attr.h = newHeight

        if (config.tImmediate) {
          dragElement.component.attr.t = origin.t + diff.y
        } else if (newHeight <= 0) {
          dragElement.component.attr.t = origin.t + diff.y + origin.h
        }
      }
    }
  }

  const resizeStrategies = {
    [DragType.L]: createResizeStrategy({ w: false, lImmediate: true }),
    [DragType.R]: createResizeStrategy({ w: true }),
    [DragType.T]: createResizeStrategy({ h: false, tImmediate: true }),
    [DragType.B]: createResizeStrategy({ h: true }),
    [DragType.LT]: createResizeStrategy({ w: false, h: false, lImmediate: true, tImmediate: true }),
    [DragType.RT]: createResizeStrategy({ w: true, h: false, tImmediate: true }),
    [DragType.LB]: createResizeStrategy({ w: false, h: true, lImmediate: true }),
    [DragType.RB]: createResizeStrategy({ w: true, h: true }),
  }

  const useResizeMove = throttle((e: MouseEvent) => {
    if (!pointer.isActive()) return
    /**
     * 拉伸同样只写逻辑尺寸。
     * 这样缩放画布后拖动控制点，组件宽高变化仍与视觉拖动距离一致。
     */
    const diff = sceneWidgetStore.screenDeltaToWidgetCanvasDelta(
      e.clientX - start.clientX,
      e.clientY - start.clientY,
    )
    const diffX = Math.round(diff.x)
    const diffY = Math.round(diff.y)

    resizeStrategies[type](dragElement, { x: diffX, y: diffY })
  }, 16)

  pointer.attach({
    move: useResizeMove,
    commit: () => sceneWidgetStore.recordWidgetHistorySnapshot(
      '调整部件尺寸', oldSnapshot, sceneWidgetStore.createWidgetHistorySnapshot([dragElement.id]),
    ),
    rollback: () => sceneWidgetStore.applyWidgetHistorySnapshot(oldSnapshot),
  })
}
