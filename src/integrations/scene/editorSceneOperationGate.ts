import { computed, readonly, shallowRef } from 'vue'
import { getActiveSceneViewportHost } from './editorScenePlatformHost'

/** 编辑器内共享的短期操作门禁，避免异步创建、保存与整场景替换交叉读取不同快照。 */
export type EditorSceneOperation = 'importJson' | 'template' | 'createObject' | 'save' | 'publish' | 'saveTemplate' | 'moveSceneNode' | 'deleteSceneNodes' | 'copySceneNodes' | 'history' | 'widgetEdit' | 'publicRequestEdit'
const activeOperation = shallowRef<EditorSceneOperation | null>(null)
const recovery = shallowRef<{ message: string; retry: () => Promise<boolean> } | null>(null)
export const editorSceneRecovery = readonly(recovery)
export const editorSceneOperation = computed(() => recovery.value ? 'historyRecovery' : activeOperation.value)
const beforeOperation = new Set<() => void>()

/** 先结算当前面板草稿，避免下一次操作捕获未登记的属性状态。 */
export const flushEditorSceneEdits = () => {
  if (editorSceneOperation.value) return
  beforeOperation.forEach((flush) => flush())
}

export const subscribeEditorSceneBeforeOperation = (flush: () => void) => {
  beforeOperation.add(flush)
  return () => { beforeOperation.delete(flush) }
}
/** 恢复期间保留阻塞，只有所属事务可释放。 */
export const blockEditorSceneForRecovery = (message: string, retry: () => Promise<boolean>) => {
  const state = { message, retry }
  recovery.value = state
  return () => { if (recovery.value === state) recovery.value = null }
}

/**
 * 同步取得当前页的操作权；释放函数只释放自己持有的凭证。
 * 页面卸载后的迟到任务不能误释放新编辑器刚取得的操作权。
 */
export const beginEditorSceneOperation = (operation: EditorSceneOperation) => {
  flushEditorSceneEdits()
  if (editorSceneOperation.value) throw new Error('当前场景正在处理其他操作，请完成后重试')
  // 先登记面板待提交值，再切断合并。保存失败后的新输入也从新步骤开始。
  getActiveSceneViewportHost()?.getCommandBus().breakHistoryMerge()
  const token = Symbol(operation)
  activeToken = token
  activeOperation.value = operation
  return () => {
    if (activeToken !== token) return
    activeToken = null
    activeOperation.value = null
  }
}
let activeToken: symbol | null = null
