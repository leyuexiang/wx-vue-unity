import { useSceneWidgetStore } from '@/stores/sceneEditStore'
import { appLogger } from '@/utils/logger'
import { beginEditorSceneOperation, blockEditorSceneForRecovery, editorSceneOperation } from '../editorSceneOperationGate'
import { getActiveSceneViewportHost, subscribeActiveSceneViewportHost } from '../editorScenePlatformHost'

interface PointerParticipant {
  move: ((event: MouseEvent) => void) & { flush: () => unknown; cancel: () => void }
  commit: () => void
  rollback: () => void
  cleanup?: () => void
}
export interface WidgetPointerSession {
  attach: (participant: PointerParticipant) => void
  isActive: () => boolean
  cancel: () => void
}
let activeSession: WidgetPointerSession | undefined

/** 一次鼠标交互持有门禁及所有监听。取消恢复原数据，场景替换只清理旧回调。 */
export function getWidgetPointerSession(): WidgetPointerSession | undefined {
  if (activeSession?.isActive()) return activeSession
  if (editorSceneOperation.value) return undefined
  const store = useSceneWidgetStore()
  const generation = store.getWidgetRestoreGeneration()
  const host = getActiveSceneViewportHost()
  const runtime = host?.getRuntime()
  const release = beginEditorSceneOperation('widgetEdit')
  let participant: PointerParticipant | undefined
  let closed = false
  let finishing = false
  let unsubscribeHost: (() => void) | undefined
  let unsubscribeStore: (() => void) | undefined
  const current = () => getActiveSceneViewportHost() === host && host?.getRuntime() === runtime
    && !runtime?.isDisposed && store.getWidgetRestoreGeneration() === generation

  const finish = (mode: 'commit' | 'cancel' | 'abandon') => {
    if (closed || finishing) return
    finishing = true
    const valid = current()
    let recover: (() => void) | undefined
    try {
      if (valid && mode === 'commit') {
        try {
          // flush必须发生在关闭标记之前，保证最后一帧仍可通过生命周期检查。
          participant?.move.flush()
          participant?.commit()
        } catch (error) {
          appLogger.warn('WidgetPointerSession', '提交二维交互失败，恢复原快照', error)
          mode = 'cancel'
        }
      }
      participant?.move.cancel()
      if (current() && mode === 'cancel' && participant) {
        try { participant.rollback() }
        catch (error) {
          recover = participant.rollback
          appLogger.warn('WidgetPointerSession', '二维交互快照恢复失败', error)
        }
      }
    } finally {
      closed = true
      if (participant) {
        participant.move.cancel()
        window.removeEventListener('mousemove', participant.move)
        try { participant.cleanup?.() }
        catch (error) { appLogger.warn('WidgetPointerSession', '清理二维交互辅助状态失败', error) }
      }
      window.removeEventListener('mouseup', commit)
      window.removeEventListener('blur', cancel)
      window.removeEventListener('pagehide', cancel)
      window.removeEventListener('keydown', escape, true)
      document.removeEventListener('visibilitychange', visibility)
      unsubscribeHost?.()
      unsubscribeStore?.()
      participant = undefined
      if (activeSession === session) activeSession = undefined
      release()
    }
    const rollback = recover
    if (rollback && current()) {
      let clearRecovery: (() => void) | undefined
      let stopHost: (() => void) | undefined
      let stopScene: (() => void) | undefined
      let pending = true
      const clear = () => {
        pending = false
        clearRecovery?.()
        stopHost?.()
        stopScene?.()
      }
      const retry = async () => {
        if (!pending || !current()) { clear(); return false }
        try { rollback() }
        catch { return false }
        clear()
        return true
      }
      clearRecovery = blockEditorSceneForRecovery('二维交互恢复未完成，请重试恢复', retry)
      stopHost = subscribeActiveSceneViewportHost(() => { if (!current()) clear() })
      // 同一宿主重载也作废旧快照和待重试状态。
      stopScene = host?.getStore().subscribe((event) => { if (event.type === 'sceneLoaded') clear() })
      if (!current()) clear()
    }
  }
  const commit = (event: MouseEvent) => { if (event.button === 0) finish('commit') }
  const cancel = () => finish('cancel')
  const escape = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    cancel()
  }
  const visibility = () => { if (document.visibilityState === 'hidden') cancel() }
  const session: WidgetPointerSession = {
    attach: (next) => {
      if (!session.isActive()) return
      if (participant) throw new Error('同一次指针交互只能登记一个编辑事务')
      participant = next
      window.addEventListener('mousemove', next.move)
    },
    isActive: () => {
      if (closed) return false
      if (!current()) { finish('abandon'); return false }
      return true
    },
    cancel,
  }
  activeSession = session
  window.addEventListener('mouseup', commit)
  window.addEventListener('blur', cancel)
  window.addEventListener('pagehide', cancel)
  window.addEventListener('keydown', escape, true)
  document.addEventListener('visibilitychange', visibility)
  unsubscribeHost = subscribeActiveSceneViewportHost(() => { if (!current()) finish('abandon') })
  unsubscribeStore = host?.getStore().subscribe((event) => { if (event.type === 'sceneLoaded') finish('abandon') })
  return session
}
