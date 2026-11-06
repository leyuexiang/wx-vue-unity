import type { ViewportHost } from '@/scene-platform'
import type { SceneCommand } from '@/scene-platform/commands/types'
import { blockEditorSceneForRecovery } from './editorSceneOperationGate'
import { subscribeActiveSceneViewportHost } from './editorScenePlatformHost'

/** 调用方持有编辑门禁，按命令的写入范围确认本地数据或运行投影。 */
export async function runConfirmedEditorCommand(
  host: ViewportHost,
  action: 'execute' | 'undo' | 'redo',
  command: SceneCommand | undefined,
  isActive: () => boolean,
  prepare?: () => void,
): Promise<boolean> {
  const bus = host.getCommandBus()
  const target = action === 'execute' ? command : bus.getReplayCommand(action)
  if (!target) return false
  // 本地仓库命令只恢复自身，涉及运行端准备的命令必须使用三维事务。
  const localOnly = target.confirmationScope === 'local'
  if (localOnly && prepare) throw new Error('本地命令不能附加运行端准备操作')
  const bridge = localOnly ? undefined : host.getBridge()
  const runtime = host.getRuntime()
  const sceneId = host.getStore().getScene().id
  const sameScene = () => host.getRuntime() === runtime && !runtime.isDisposed && host.getStore().getScene().id === sceneId
  if (bridge) await bridge.flush()
  if (!isActive() || !sameScene()) return false
  // 等待期间栈顶可能被清理或替换，确认条件只适用于原目标。
  if (action !== 'execute' && bus.getReplayCommand(action) !== target) return false
  const transaction = bus.beginConfirmed(action, target)
  if (!transaction) return false
  const alive = () => sameScene() && transaction.isCurrent()
  try {
    if (transaction.applicationFailed) throw transaction.applicationError
    if (target.applyAsync) {
      await target.applyAsync(action)
      if (!alive()) return false
    }
    prepare?.()
    if (bridge) await bridge.flush()
    if (!alive()) return false
    if (!isActive()) throw new Error('场景操作已取消')
    transaction.commit()
    return true
  } catch (originalError) {
    if (!alive()) throw originalError
    let releaseRecovery: (() => void) | undefined
    let stopHost: (() => void) | undefined
    let stopScene: (() => void) | undefined
    let recoveryClosed = false
    const clearRecovery = () => {
      recoveryClosed = true
      releaseRecovery?.()
      stopHost?.()
      stopScene?.()
    }
    let retrying = false
    const recover = async (): Promise<boolean> => {
      if (retrying || recoveryClosed || !alive()) return false
      retrying = true
      try {
        transaction.restore()
        // 反向事件可能只覆盖部分目标，完整重同步保证部分成功的运行端也能恢复。
        if (bridge) await bridge.resync()
        if (recoveryClosed || !alive()) return false
        transaction.finishRollback()
        clearRecovery()
        return true
      } catch {
        return false
      } finally { retrying = false }
    }
    if (!await recover() && alive()) {
      releaseRecovery = blockEditorSceneForRecovery('场景恢复未完成，请重试恢复后继续编辑', recover)
      stopScene = host.getStore().subscribe((event) => {
        if (event.type === 'sceneLoaded') clearRecovery()
      })
      stopHost = subscribeActiveSceneViewportHost(() => {
        if (!alive() || !isActive()) clearRecovery()
      })
      // 订阅会立即回放宿主，补充清理已在订阅时失效的情况。
      if (!alive() || !isActive()) clearRecovery()
      throw Object.assign(new Error('命令失败且场景恢复未完成，请使用“重试恢复”'), { originalError })
    }
    throw originalError
  }
}
