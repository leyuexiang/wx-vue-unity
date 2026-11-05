import { getWidgetCommandPort } from '@/integrations/scene/widgetRuntime/ports'
import { cloneDeep } from 'lodash-es'
import type BaseWidgetConfig from '@/packages/components/BaseWidgetConfig'
import { useSceneStore, useSceneWidgetStore, type WidgetConfig } from '@/stores/sceneEditStore'
import type { ComponentDataConfig } from '@/types/data-config'
import type {
  InteractionEvent,
  SceneWidgetTargetItem,
  WidgetGroupBounds,
  WidgetLayerGroupNode,
} from '@/types/threeScene'
import {
  type WidgetPanelCapabilities,
  type WidgetPanelReadWriteAdapter,
  type WidgetPanelSelection,
  type WidgetPanelTarget,
} from '@/scene-platform/editor/panels'
import { canApplyWidgetAnimation } from '@/utils/widgetAnimation'
import { normalizeWidgetComponent } from '@/utils/widgetComponent'
import { getWidgetDataConfigById, setWidgetDataConfigById } from '@/utils/dataConfig'
import type { WidgetHistorySnapshot } from '@/integrations/scene/widgetRuntime/widgetCommand'
import {
  findPageFrameChild,
  normalizePageFrameOption,
  type PageFrameOption,
} from '@/packages/components/Widget/VPageMenu/pageFrameTypes'

type WidgetHistoryChangeOptions = {
  includeLayerTree?: boolean
  mergeSession?: symbol
}

const EMPTY_WIDGET_CAPABILITIES: WidgetPanelCapabilities = {
  base: false,
  animation: false,
  data: false,
  status: false,
  interaction: false,
}

const getStore = () => useSceneWidgetStore()

/**
 * 当前项目的二维部件面板能力声明。
 * 这里允许感知当前组件包类型；平台协议层只消费最终布尔能力。
 */
export const getWidgetPanelCapabilities = (
  component?: BaseWidgetConfig | null,
): WidgetPanelCapabilities => {
  if (!component) return EMPTY_WIDGET_CAPABILITIES

  return {
    base: true,
    animation: canApplyWidgetAnimation(component.info.packageName),
    data: true,
    status: true,
    interaction: true,
  }
}

export const getWidgetByPanelId = (id?: string | null) => {
  return getStore().getWidgetById(id)
}

/**
 * 统一解析二维组件锁定状态。
 * 面板只消费结果，不需要了解视觉分组树的具体存储结构。
 */
export const getWidgetPanelLockState = (widgetId: string) => {
  const widgetStore = getStore()
  const widget = widgetStore.getWidgetById(widgetId)
  const ownLocked =
    (widget?.component.option as Record<string, unknown> | undefined)?.locked === true
  const parentGroupId = widgetStore.getWidgetParentGroupId(widgetId)
  const inheritedLocked = Boolean(parentGroupId && widgetStore.isWidgetGroupLocked(parentGroupId))
  return {
    ownLocked,
    inheritedLocked,
    effectiveLocked: ownLocked || inheritedLocked,
  }
}

export const setWidgetPanelLocked = (widgetId: string, locked: boolean) =>
  getStore().setWidgetLocked(widgetId, locked)

/**
 * 基础面板通过仓库统一更新显隐，确保全部二维包类型都会同步刷新目标画布缓存。
 */
export const setWidgetPanelVisible = (widgetId: string, visible: boolean) =>
  getStore().setWidgetVisible(widgetId, visible)

export const getWidgetPanelCanvasConfig = () => {
  return getStore().getWidgetCanvasConfig()
}

export const getWidgetPanelGroupIds = (groupId: string) => {
  return getStore().getGroupWidgetIds(groupId)
}

export const getWidgetPanelGroupBounds = (
  groupId: string,
  includeHidden = false,
): WidgetGroupBounds | null => {
  return getStore().getGroupBounds(groupId, includeHidden)
}

export const getWidgetPanelGroupVisible = (groupId: string) => {
  return getStore().getGroupVisible(groupId)
}

export const setWidgetPanelGroupVisible = (groupId: string, visible: boolean) => {
  getStore().setGroupVisible(groupId, visible)
}

/**
 * 更新视觉分组锁定状态。
 * 锁定只通过 Store 计算成员有效状态，不把组状态批量写回组件自身配置。
 */
export const setWidgetPanelGroupLocked = (groupId: string, locked: boolean) => {
  getStore().setWidgetGroupLocked(groupId, locked)
}

/**
 * 编辑器分组代理的整体变换锁定态。
 * 组锁或任一成员自身锁定都会返回 true，右侧面板与画布共用同一判定。
 */
export const isWidgetPanelGroupTransformLocked = (groupId: string) => {
  return getStore().isWidgetGroupTransformLocked(groupId)
}

export const moveWidgetPanelGroup = (groupId: string, deltaX: number, deltaY: number) => {
  getStore().moveWidgetGroup(groupId, deltaX, deltaY)
}

export const updateWidgetPanelGroupName = (groupId: string, name: string) => {
  getStore().updateWidgetGroupName(groupId, name)
}

export const getWidgetPanelGroupState = (groupId: string) => {
  const widgetStore = getStore()
  const targetGroup = widgetStore.widgetLayerTree.find(
    (node): node is WidgetLayerGroupNode => node.type === 'group' && node.id === groupId,
  )

  if (!targetGroup) return null

  return {
    id: targetGroup.id,
    name: targetGroup.name,
    visible: targetGroup.visible !== false,
    locked: targetGroup.locked === true,
  }
}

export const getWidgetPanelTargetById = (
  id?: string | null,
): WidgetPanelTarget<WidgetConfig> | null => {
  const widget = getWidgetByPanelId(id)
  if (!widget) return null

  const lockState = getWidgetPanelLockState(widget.id)

  return {
    kind: 'widget',
    id: widget.id,
    widget,
    capabilities: getWidgetPanelCapabilities(widget.component),
    ...lockState,
  }
}

/**
 * 将当前项目的二维选中态翻译成平台面板目标。
 * 分组、多选、单选在这里一次性分流，右侧入口只根据协议结果渲染。
 */
export const resolveWidgetPanelSelection = (): WidgetPanelSelection<WidgetConfig> => {
  const widgetStore = getStore()

  const childSelection = widgetStore.currentWidgetChildSelection
  if (childSelection) {
    const frame = widgetStore.getWidgetById(childSelection.frameId)
    const child =
      frame?.component.info.keyName === 'VPageMenu'
        ? findPageFrameChild(
            normalizePageFrameOption(frame.component.option),
            childSelection.childId,
          )
        : null
    if (frame && child) {
      return {
        kind: 'widgetChild',
        frameId: childSelection.frameId,
        childId: childSelection.childId,
        widget: frame,
        effectiveLocked: getWidgetPanelLockState(frame.id).effectiveLocked || child.locked,
      }
    }
  }

  if (widgetStore.currentWidgetGroupId) {
    return {
      kind: 'widgetGroup',
      id: widgetStore.currentWidgetGroupId,
      widgetIds: widgetStore.getGroupWidgetIds(widgetStore.currentWidgetGroupId),
      effectiveLocked: widgetStore.isWidgetGroupTransformLocked(widgetStore.currentWidgetGroupId),
    }
  }

  const currentIds = widgetStore.currentWidgetsIds || []
  if (currentIds.length > 1) {
    return {
      kind: 'multiWidget',
      ids: [...currentIds],
      effectiveLocked: currentIds.some((id) => widgetStore.isWidgetLocked(id)),
    }
  }

  if (currentIds.length === 1) {
    return getWidgetPanelTargetById(currentIds[0]) || { kind: 'none' }
  }

  return { kind: 'none' }
}

export const getSelectedWidgetPanelTarget = () => {
  const selection = resolveWidgetPanelSelection()
  return selection.kind === 'widget' ? selection : null
}

/**
 * 事件页允许普通二维组件和页面框架子项成为写入目标。
 * 子项仍以所属页面框架作为动作条件的数据上下文，只额外携带 childId 区分事件列表。
 */
export const getSelectedWidgetEventTarget = () => {
  const selection = resolveWidgetPanelSelection()
  if (selection.kind === 'widget') {
    return { id: selection.id, childId: null, widget: selection.widget }
  }
  if (selection.kind === 'widgetChild') {
    return {
      id: selection.frameId,
      childId: selection.childId,
      widget: selection.widget,
    }
  }
  return null
}

export const setWidgetPanelChildSelection = (frameId: string, childId: string) => {
  if (!childId) {
    getStore().setCurrentWidgetsIds([frameId])
    return
  }
  getStore().setCurrentWidgetChildSelection({ frameId, childId })
}

/**
 * 二维面板命令端口。
 * 当前使用 WidgetCommand 生成快照，再由编辑态端口登记到唯一 CommandBus；面板组件无需感知底层历史实现。
 */
export const runWidgetPanelHistoryChange = <T>(
  name: string,
  ids: string[],
  mutate: () => T,
  options: WidgetHistoryChangeOptions = {},
) => {
  return getStore().runWidgetHistoryChange(name, ids, mutate, options)
}

export const createWidgetPanelHistorySnapshot = (
  ids: string[],
  options: WidgetHistoryChangeOptions = {},
) => {
  getWidgetCommandPort().assertCanEdit?.()
  return getStore().createWidgetHistorySnapshot(ids, options)
}

export const recordWidgetPanelHistorySnapshot = (
  name: string,
  oldSnapshot: WidgetHistorySnapshot,
  newSnapshot: WidgetHistorySnapshot,
) => {
  getStore().recordWidgetHistorySnapshot(name, oldSnapshot, newSnapshot)
}

export const setWidgetPanelAnimationPreview = (
  payload: { widgetId: string; animation: string } | null,
) => {
  getStore().setWidgetAnimationPreview(payload)
}

export const bumpWidgetPanelRenderVersion = (widgetId: string) => {
  getStore().bumpWidgetRenderVersion(widgetId)
}

export const setWidgetPanelAnimations = (widgetId: string, animations: string[]) => {
  if (getStore().isWidgetLocked(widgetId)) return
  const widget = getWidgetByPanelId(widgetId)
  if (!widget) return

  runWidgetPanelHistoryChange('配置部件动画', [widgetId], () => {
    normalizeWidgetComponent(widget.component).styles.animations = [...animations]
  })
}

export const clearWidgetPanelAnimations = (widgetId: string) => {
  if (getStore().isWidgetLocked(widgetId)) return
  const widget = getWidgetByPanelId(widgetId)
  if (!widget) return

  runWidgetPanelHistoryChange('清除部件动画', [widgetId], () => {
    normalizeWidgetComponent(widget.component).styles.animations = []
  })
}

export const getWidgetStatusList = (widgetId?: string | null): InteractionEvent[] => {
  const widget = getWidgetByPanelId(widgetId)
  return widget?.component.statusList || []
}

export const setWidgetStatusList = (
  widgetId: string | null | undefined,
  statusList: InteractionEvent[],
) => {
  if (widgetId && getStore().isWidgetLocked(widgetId)) return
  const widget = getWidgetByPanelId(widgetId)
  if (!widget) return

  runWidgetPanelHistoryChange('更新部件状态配置', [widget.id], () => {
    widget.component.statusList = cloneDeep(statusList)
    getStore().bumpWidgetRenderVersion(widget.id)
  })
  useSceneStore().setTransformMaterialRandomId()
}

export const getWidgetInteractiveEventList = (
  widgetId?: string | null,
  childId?: string | null,
): InteractionEvent[] => {
  const widget = getWidgetByPanelId(widgetId)
  if (widget && childId && widget.component.info.keyName === 'VPageMenu') {
    const child = findPageFrameChild(widget.component.option as PageFrameOption, childId)
    return child?.interactiveEvent || []
  }
  return widget?.component.interactiveEvent || []
}

export const setWidgetInteractiveEventList = (
  widgetId: string | null | undefined,
  interactiveEventList: InteractionEvent[],
  childId?: string | null,
) => {
  if (widgetId && getStore().isWidgetLocked(widgetId)) return
  const widget = getWidgetByPanelId(widgetId)
  if (!widget) return
  const child =
    childId && widget.component.info.keyName === 'VPageMenu'
      ? findPageFrameChild(widget.component.option as PageFrameOption, childId)
      : null
  if (childId && (!child || child.locked)) return

  runWidgetPanelHistoryChange('更新部件交互配置', [widget.id], () => {
    if (child) {
      child.interactiveEvent = cloneDeep(interactiveEventList)
    } else {
      widget.component.interactiveEvent = cloneDeep(interactiveEventList)
    }
    getStore().bumpWidgetRenderVersion(widget.id)
  })
  useSceneStore().setTransformMaterialRandomId()
}

export const getWidgetDisplayName = (widget: WidgetConfig) => {
  return (
    ((widget.component.option as Record<string, unknown> | undefined)?.label as string) ||
    widget.component.info.name ||
    widget.component.info.keyName ||
    widget.id
  )
}

export const getWidgetKindLabelByPackage = (
  packageName: string,
): SceneWidgetTargetItem['kindLabel'] => {
  if (packageName === 'Chart') return '图表'
  if (packageName === 'Decorate') return '装饰'
  if (packageName === 'Control') return '控件'
  return '部件'
}

/**
 * 状态/交互动作选择部件时使用的候选列表。
 * 这份列表来自二维部件仓库，不再从三维 sceneModules 里回退解析。
 */
export const getWidgetTargetOptions = (): SceneWidgetTargetItem[] => {
  return getStore()
    .getOrderedWidgets()
    .map((item) => ({
      id: item.id,
      name: getWidgetDisplayName(item),
      packageName: item.component.info.packageName,
      visible: (item.component.option as Record<string, unknown> | undefined)?.visible !== false,
      kindLabel: getWidgetKindLabelByPackage(item.component.info.packageName),
    }))
}

export const createCurrentProjectWidgetPanelAdapter = (): WidgetPanelReadWriteAdapter<
  WidgetConfig,
  ComponentDataConfig,
  InteractionEvent
> => ({
  getSelection: resolveWidgetPanelSelection,
  getTargetById: (id) => getWidgetPanelTargetById(id),
  getCapabilities: (widget) => getWidgetPanelCapabilities(widget?.component),
  getDataConfig: (id) => getWidgetDataConfigById(id),
  setDataConfig: (id, dataConfig) => {
    if (getStore().isWidgetLocked(id)) return
    setWidgetDataConfigById(id, dataConfig)
  },
  getStatusList: getWidgetStatusList,
  setStatusList: setWidgetStatusList,
  getInteractiveEventList: getWidgetInteractiveEventList,
  setInteractiveEventList: setWidgetInteractiveEventList,
})
