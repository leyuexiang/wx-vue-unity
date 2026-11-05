import { editorSceneOperation } from '../editorSceneOperationGate'
import type { CommandBus, SceneCommand } from '@/scene-platform'
import WidgetCommand from '@/integrations/scene/widgetRuntime/widgetCommand'
import type { WidgetCommandPort } from './ports'

type CommandBusGetter = () => (Pick<CommandBus, 'recordExecuted'> & Partial<Pick<CommandBus, 'getIsPending'>>) | null | undefined
const sourceWidgetCommand = Symbol('二维部件快照')
type WidgetSceneCommand = SceneCommand & { [sourceWidgetCommand]?: WidgetCommand }

/**
 * 将“状态已经由二维仓库写入”的 WidgetCommand 包装成平台命令。
 *
 * 二维仓库当前采用“先修改状态，再保存新旧快照”的事务方式，因此包装命令的 execute 只负责重做。
 * 首次登记通过 CommandBus.recordExecuted 完成，不调用 execute，避免重复应用新快照和冗余渲染更新。
 */
export const createAlreadyAppliedSceneCommand = (
  widgetCommand: Pick<WidgetCommand, 'name' | 'redo' | 'undo'> & Partial<Pick<WidgetCommand, 'captureRollback'>>,
  runAsWidgetHistory: (apply: () => void) => void,
): SceneCommand => {
  const sceneCommand: WidgetSceneCommand = {
    name: widgetCommand.name,
    // 当前适配入口只写二维部件或二维舞台尺寸，回放不需要确认三维投影。
    confirmationScope: 'local',
    captureRollback: widgetCommand.captureRollback ? () => {
      const restore = widgetCommand.captureRollback?.()
      return restore ? () => runAsWidgetHistory(restore) : undefined
    } : undefined,
    execute: () => {
      runAsWidgetHistory(() => widgetCommand.redo())
    },
    undo: () => {
      runAsWidgetHistory(() => widgetCommand.undo())
    },
  }
  if (widgetCommand instanceof WidgetCommand && widgetCommand.mergeSession !== undefined) {
    sceneCommand.mergeSession = widgetCommand.mergeSession
    sceneCommand[sourceWidgetCommand] = widgetCommand
    sceneCommand.mergeWith = (next: WidgetSceneCommand) => {
      const snapshot = next[sourceWidgetCommand]
      return snapshot !== undefined && widgetCommand.mergeWith(snapshot)
    }
  }
  return sceneCommand
}
/**
 * 创建二维命令总线端口。
 *
 * 端口只在提交和历史应用边界读取命令总线，不长期缓存视口宿主，避免场景切换后继续向已销毁的
 * CommandBus 写入。深度计数用于覆盖撤销/重做中的嵌套同步；二维 Store 可据此跳过二次历史记录。
 */
export const createCommandBusWidgetCommandPort = (
  getCommandBus: CommandBusGetter,
): WidgetCommandPort => {
  let applyingDepth = 0

  const runAsWidgetHistory = (apply: () => void) => {
    applyingDepth += 1
    try {
      apply()
    } finally {
      applyingDepth = Math.max(0, applyingDepth - 1)
    }
  }

  return {
    assertCanEdit: () => {
      if (applyingDepth) return
      const operation = editorSceneOperation.value
      if (getCommandBus()?.getIsPending?.() || (operation && operation !== 'createObject' && operation !== 'widgetEdit')) {
        throw new Error('场景正在处理其他操作，请完成后再编辑部件')
      }
    },
    executeWidgetCommand: (command) => {
      getCommandBus()?.recordExecuted(
        createAlreadyAppliedSceneCommand(command, runAsWidgetHistory),
      )
    },
    isApplyingWidgetHistory: () => applyingDepth > 0,
  }
}
