import type { VegetationGenerationTaskResponse } from './editorVegetationPublicationAdapter'

const terminalStatuses = new Set(['SUCCESS', 'PARTIAL_FAILED', 'FAILED', 'CANCELED'])

/** 等待完成和取消均移除监听，避免长任务的每轮等待积累中止回调。 */
function waitForPoll(signal: AbortSignal, delayMs: number): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort)
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, delayMs)
    const abort = () => {
      clearTimeout(timer)
      cleanup()
      reject(signal.reason)
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

/**
 * 串行查询当前任务。取消响应替换任务对象后，旧查询的结果和错误都丢弃。
 * 场景生命周期由信号控制；查询器即使忽略取消，也不能再写入界面。
 */
export async function pollVegetationGenerationTask(options: {
  signal: AbortSignal
  readTask: () => VegetationGenerationTaskResponse
  writeTask: (task: VegetationGenerationTaskResponse) => void
  queryTask: (taskId: string, signal: AbortSignal) => Promise<VegetationGenerationTaskResponse>
  intervalMs?: number
}): Promise<VegetationGenerationTaskResponse> {
  const { signal, readTask, writeTask, queryTask } = options
  while (true) {
    signal.throwIfAborted()
    if (terminalStatuses.has(readTask().status)) return readTask()
    await waitForPoll(signal, options.intervalMs ?? 1_000)
    signal.throwIfAborted()
    const before = readTask()
    if (terminalStatuses.has(before.status)) return before
    try {
      const next = await queryTask(before.taskId, signal)
      signal.throwIfAborted()
      if (readTask() === before) writeTask(next)
    } catch (error) {
      signal.throwIfAborted()
      // 用户取消得到更新视图时，以该视图为准，不再展示旧查询的失败。
      if (readTask() === before) throw error
    }
  }
}
