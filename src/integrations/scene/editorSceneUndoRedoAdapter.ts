import { runConfirmedEditorCommand } from './editorSceneCommandTransaction'
import { toRaw } from 'vue'
import type { CommandBus } from '@/scene-platform'
import { getActiveSceneViewportHost, subscribeActiveSceneViewportHost } from './editorScenePlatformHost'
import { beginEditorSceneOperation, editorSceneOperation, flushEditorSceneEdits } from './editorSceneOperationGate'

export interface EditorUndoRedoState {
  undoSteps: number
  redoSteps: number
  canUndo: boolean
  canRedo: boolean
}

interface EditorUndoRedoOptions {
  commandBus?: Pick<CommandBus, 'undo' | 'redo' | 'getUndoSize' | 'getRedoSize' | 'clear'> | null
}

/** 统一读取唯一命令总线的撤销/重做状态，不再维护或回退到第二套历史栈。 */
export const getEditorUndoRedoState = ({ commandBus }: EditorUndoRedoOptions): EditorUndoRedoState => {
  const undoSteps = commandBus?.getUndoSize() ?? 0
  const redoSteps = commandBus?.getRedoSize() ?? 0
  const available = !editorSceneOperation.value
  return { undoSteps, redoSteps, canUndo: available && undoSteps > 0, canRedo: available && redoSteps > 0 }
}

export const undoEditorHistory = ({ commandBus }: EditorUndoRedoOptions): boolean =>
  Boolean(commandBus?.undo())

export const redoEditorHistory = ({ commandBus }: EditorUndoRedoOptions): boolean =>
  Boolean(commandBus?.redo())

export const clearEditorHistory = ({ commandBus }: EditorUndoRedoOptions) => {
  const undoSteps = commandBus?.getUndoSize() ?? 0
  const redoSteps = commandBus?.getRedoSize() ?? 0
  if (undoSteps > 0 || redoSteps > 0) commandBus?.clear()
  return { cleared: undoSteps > 0 || redoSteps > 0 }
}


export type EditorHistoryDirection = 'undo' | 'redo'

interface EditorHistoryDispatchOptions {
  /** 校验发起入口仍属于活动宿主，避免旧面板操作另一个场景。 */
  commandBus: CommandBus | null
  onApplied?: () => void
  onError: (error: unknown) => void
}

/**
 * 工具栏与快捷键共用回放入口。门禁覆盖等待及同步，历史订阅统一刷新步数。
 * 回放与异步补偿共用确认事务，恢复未完成时由共享恢复门禁阻止后续编辑。
 */
export const dispatchEditorHistory = async (
  direction: EditorHistoryDirection,
  { commandBus, onApplied, onError }: EditorHistoryDispatchOptions,
): Promise<boolean> => {
  const host = getActiveSceneViewportHost()
  // 面板的ref可能代理命令总线，身份判断使用原对象，快捷键与工具栏才能共用同一宿主。
  if (!host || !commandBus || host.getCommandBus() !== toRaw(commandBus) || editorSceneOperation.value) return false
  try {
    // 草稿可能是第一条撤销记录，先结算再检查历史是否为空。
    flushEditorSceneEdits()
  } catch (error) {
    onError(error)
    return false
  }
  const state = getEditorUndoRedoState({ commandBus })
  if (!(direction === 'undo' ? state.canUndo : state.canRedo)) return false

  const runtime = host.getRuntime()
  const sceneId = host.getStore().getScene().id
  const current = () => getActiveSceneViewportHost() === host
    && host.getRuntime() === runtime && !runtime.isDisposed && host.getStore().getScene().id === sceneId
  const release = beginEditorSceneOperation('history')
  // 切页立即释放旧页面门禁，原异步任务仍受宿主及事务令牌校验。
  const unsubscribe = subscribeActiveSceneViewportHost(() => { if (!current()) release() })
  try {
    const applied = await runConfirmedEditorCommand(host, direction, undefined, current)
    if (!applied || !current()) return false
    onApplied?.()
    return true
  } catch (error) {
    if (current()) onError(error)
    return false
  } finally {
    unsubscribe()
    release()
  }
}
