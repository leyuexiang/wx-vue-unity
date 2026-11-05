import type { WidgetCanvasConfig } from '@/types/threeScene'

export interface SceneStageCommandContext {
  /** 应用纯舞台尺寸快照，调用方负责写入二维仓库并刷新视口。 */
  applyWidgetCanvasSize: (size: WidgetCanvasConfig) => void
  captureWidgetCanvasSize?: () => WidgetCanvasConfig
}

/**
 * 创建舞台尺寸命令需要的最小回放对象。
 *
 * 舞台尺寸已经在提交前应用，因此该对象交由 CommandBus.recordExecuted 登记；它不再继承旧
 * Command 基类，也不依赖旧 HistoryModules，只保留统一适配器需要的 name/undo/redo。
 */
export const createSceneStageCommand = (
  oldSize: WidgetCanvasConfig,
  newSize: WidgetCanvasConfig,
  context: SceneStageCommandContext,
) => {
  const previous = structuredClone(oldSize)
  const next = structuredClone(newSize)
  return {
    name: 'Update Scene Stage Size',
    captureRollback: context.captureWidgetCanvasSize ? () => {
      const size = structuredClone(context.captureWidgetCanvasSize!())
      return () => context.applyWidgetCanvasSize(size)
    } : undefined,
    undo: () => context.applyWidgetCanvasSize(previous),
    redo: () => context.applyWidgetCanvasSize(next),
  }
}
