import { readonly, ref } from 'vue'
import type { INTERACTIVE_EVENT_ENUM } from '@/enums/scenePanelEnum'
import type WidgetCommand from '@/integrations/scene/widgetRuntime/widgetCommand'
import type { ActionCompletion } from '@/utils/renderScene/interactionActionSequence'

/**
 * 二维部件运行时端口。
 *
 * 这层只表达画布二维部件运行需要的最小能力，不绑定旧 renderScene 实例。
 * 当前项目会用旧 sceneApi 适配它；后续三维底层替换时，只需要换掉端口实现。
 */
export interface WidgetRuntimePort {
  isPreview: () => boolean
  handleInteractiveEvent: (
    widgetId: string,
    eventType: INTERACTIVE_EVENT_ENUM,
    childId?: string | null,
  ) => void
  scheduleStatusEvaluation: () => void
  executeAllStatusEvents: () => void
  clearSceneObjectSelection: () => void
  /**
   * 确保指定二维组件已经创建运行时实例。
   * 仅发布预览的数据源实现该能力：初始隐藏组件仍保留在内存分片缓存中，第一次被动作显示时
   * 才异步装载。编辑器和旧场景未实现时返回 undefined，由调用方继续使用现有同步显隐逻辑。
   */
  activateWidgets?: (widgetIds: readonly string[]) => Promise<void>
  /**
   * 确保指定二维视觉分组的成员已经创建运行时实例。
   * 发布预览首屏会裁剪掉隐藏分组的结构节点，调用方不能再从当前仓库反推完整成员，
   * 因此由发布控制器根据页面内存中的完整图层树解析分组并合并成一次激活批次。
   */
  activateWidgetGroups?: (groupIds: readonly string[]) => Promise<void>
  /** 动作命中尚未完成初始化的三维目标时，等待其依赖、实例及数据索引准备完成。 */
  prepareSceneObjects?: (objectIds: readonly string[]) => ActionCompletion
  /**
   * 释放端口内部的延迟任务。
   * 发布预览的状态规则使用独立动画帧合并，页面卸载时必须取消，避免旧预览实例继续执行动作。
   */
  dispose: () => void
}
/**
 * 二维部件命令端口。
 *
 * 面板和仓库继续创建 WidgetCommand，但只通过该端口登记到统一命令总线。
 * 仓库不直接认识 CommandBus 或旧 historyModules，既保持二维领域逻辑独立，也确保所有操作共享顺序。
 */
export interface WidgetCommandPort {
  /** 在编辑态写入之前检查，回放和运行态恢复由端口自身放行。 */
  assertCanEdit?: () => void
  executeWidgetCommand: (command: WidgetCommand) => void
  isApplyingWidgetHistory: () => boolean
}

/**
 * 二维叠加层宿主端口。
 *
 * 这层只做画布叠加层和外层视口的协调：预览态切换、尺寸刷新、清理三维选中态。
 * 当前实现仍包旧 sceneApi；后续统一 SceneRuntime 落地后，只替换这里的实现即可。
 */
export interface WidgetOverlayHostPort {
  isMounted: () => boolean
  refreshViewportLayout: () => void
  /**
   * 启动预览流程；旧 renderScene 需要先完成异步数据初始化，调用方可选择等待其完成后再结算二维状态。
   */
  enterPreview: () => void | Promise<void>
  exitPreview: () => void
  /**
   * 返回 true 表示旧视口确认本次点击是三维空白区。
   * 调用方只在 true 时写入 SceneStore 空选中态，避免点中模型时被外层 click 冒泡误清选。
   */
  clearSceneSelectionWhenBlankClick: (event: MouseEvent) => boolean
  restoreSceneObjectHighlight: (uuid?: string | null) => void
}

const noopWidgetRuntimePort: WidgetRuntimePort = {
  isPreview: () => false,
  handleInteractiveEvent: () => undefined,
  scheduleStatusEvaluation: () => undefined,
  executeAllStatusEvents: () => undefined,
  clearSceneObjectSelection: () => undefined,
  dispose: () => undefined,
}

const noopWidgetCommandPort: WidgetCommandPort = {
  executeWidgetCommand: () => undefined,
  isApplyingWidgetHistory: () => false,
}

const noopWidgetOverlayHostPort: WidgetOverlayHostPort = {
  isMounted: () => false,
  refreshViewportLayout: () => undefined,
  enterPreview: () => undefined,
  exitPreview: () => undefined,
  clearSceneSelectionWhenBlankClick: () => false,
  restoreSceneObjectHighlight: () => undefined,
}

let currentWidgetRuntimePort: WidgetRuntimePort = noopWidgetRuntimePort
let currentWidgetCommandPort: WidgetCommandPort = noopWidgetCommandPort
let currentWidgetOverlayHostPort: WidgetOverlayHostPort = noopWidgetOverlayHostPort
const widgetPreviewState = ref(false)
/** 每次进入或退出预览推进代次，旧异步动作即使遇到快速重新进入也必须失效。 */
let widgetPreviewGeneration = 0

/**
 * 注册当前编辑器或预览页的二维运行时端口。
 * 使用模块级引用是为了让 Pinia 仓库、DOM 层和面板层共享同一个运行时入口。
 */
export const setWidgetRuntimePort = (port: WidgetRuntimePort) => {
  currentWidgetRuntimePort = port
}

export const getWidgetRuntimePort = () => currentWidgetRuntimePort

/**
 * 二维预览态响应式标记。
 *
 * 旧 scenePreviewModules.isPreview 是普通字段，DOM 层直接读取时不会触发 Vue 更新。
 * 这里提供独立响应式状态，保证进入预览后二维组件只响应交互，不再显示编辑框或拖拽。
 */
export const setWidgetPreviewState = (isPreview: boolean) => {
  if (widgetPreviewState.value !== isPreview) widgetPreviewGeneration += 1
  widgetPreviewState.value = isPreview
}

export const getWidgetPreviewGeneration = () => widgetPreviewGeneration

export const getWidgetPreviewState = () => readonly(widgetPreviewState)

export const isWidgetPreview = () => widgetPreviewState.value

/**
 * 注册当前二维命令端口。
 * 端口为空时采用 no-op，避免场景还未初始化时误触发历史系统空引用。
 */
export const setWidgetCommandPort = (port: WidgetCommandPort) => {
  currentWidgetCommandPort = port
}

export const getWidgetCommandPort = () => currentWidgetCommandPort

/**
 * 注册二维叠加层宿主端口。
 * 独立于运行时端口，避免二维面板和画布必须感知旧三维 renderScene 实例。
 */
export const setWidgetOverlayHostPort = (port: WidgetOverlayHostPort) => {
  currentWidgetOverlayHostPort = port
}

export const getWidgetOverlayHostPort = () => currentWidgetOverlayHostPort

/**
 * 场景卸载时恢复空端口，防止旧 sceneApi 被二维仓库或 DOM 事件闭包继续引用。
 */
export const resetWidgetRuntimePorts = () => {
  /**
   * 先释放当前端口的异步任务，再替换为空端口。
   * 不能只覆盖引用：已排队的动画帧仍可能闭包持有已卸载预览页的 renderScene 实例。
   */
  currentWidgetRuntimePort.dispose()
  currentWidgetRuntimePort = noopWidgetRuntimePort
  currentWidgetCommandPort = noopWidgetCommandPort
  currentWidgetOverlayHostPort = noopWidgetOverlayHostPort
  setWidgetPreviewState(false)
}
