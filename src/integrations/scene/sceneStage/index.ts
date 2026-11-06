import { editorSceneOperation } from '@/integrations/scene/editorSceneOperationGate'
import { useSceneWidgetStore } from '@/stores/sceneEditStore'
import type { WidgetCanvasConfig } from '@/types/threeScene'
import { createSceneStageCommand } from './sceneStageCommand'
import { getActiveSceneViewportHost } from '@/integrations/scene/editorScenePlatformHost'
import { createAlreadyAppliedSceneCommand } from '@/integrations/scene/widgetRuntime/commandBusWidgetCommandAdapter'
import {
  isSameSceneStageSize,
  normalizeSceneStageSize,
} from '@/utils/sceneStage'

/**
 * 读取当前发布舞台尺寸。
 *
 * 场景面板只需要知道“当前尺寸是多少”，不需要感知旧 renderScene 实例或历史模块位置。
 */
export const getCurrentSceneStageSize = () => {
  return useSceneWidgetStore().getWidgetCanvasConfig()
}

/**
 * 读取发布舞台尺寸的响应式引用。
 *
 * 面板用它监听撤销、重做和场景加载后的尺寸变化；具体 Store 仍被隔离在当前项目集成层。
 */
export const getSceneStageSizeState = () => {
  return useSceneWidgetStore().widgetCanvasSize
}

/**
 * 提交发布舞台尺寸变更。
 *
 * 当前通过活动视口的统一 CommandBus 提交：
 * - 面板只提交草稿尺寸；
 * - 这里负责归一化、写 Store、记录历史命令；
 * - 已应用的尺寸状态只登记一次，撤销/重做时再应用快照。
 */
export const commitSceneStageSizeChange = (
  draftSize: Partial<WidgetCanvasConfig>,
): WidgetCanvasConfig => {
  const widgetStore = useSceneWidgetStore()
  const oldSize = widgetStore.getWidgetCanvasConfig()
  const nextSize = normalizeSceneStageSize(draftSize, oldSize)

  if (isSameSceneStageSize(oldSize, nextSize)) {
    return nextSize
  }
  const commandBus = getActiveSceneViewportHost()?.getCommandBus()
  if (editorSceneOperation.value || commandBus?.getIsPending()) {
    throw new Error('场景正在处理其他操作，请完成后再调整舞台')
  }

  widgetStore.setWidgetCanvasSizeFromConfig(nextSize)
  if (commandBus) {
    const command = createSceneStageCommand(oldSize, nextSize, {
      applyWidgetCanvasSize: (size) => widgetStore.setWidgetCanvasSizeFromConfig(size),
      captureWidgetCanvasSize: () => widgetStore.getWidgetCanvasConfig(),
    })
    try {
      commandBus.recordExecuted(createAlreadyAppliedSceneCommand(command, (apply) => apply()))
    } catch (error) {
      // 登记失败时舞台仍应与历史一致。
      widgetStore.setWidgetCanvasSizeFromConfig(oldSize)
      throw error
    }
  }

  return nextSize
}
