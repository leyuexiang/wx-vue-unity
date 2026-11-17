import { afterEach, describe, expect, it, vi } from 'vitest'
import { pollVegetationGenerationTask } from '../vegetationTaskPolling'
import type { VegetationGenerationTaskResponse } from '../editorVegetationPublicationAdapter'

/** 手动控制查询完成顺序，复现取消响应先于旧查询返回的竞态。 */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

describe('植被任务轮询生命周期', () => {
  afterEach(() => vi.useRealTimers())

  it.each(['响应', '异常'])('取消确认后丢弃旧查询的%s', async (kind) => {
    vi.useFakeTimers()
    let task: VegetationGenerationTaskResponse = { taskId: 'task-1', status: 'RUNNING' }
    const pending = deferred<VegetationGenerationTaskResponse>()
    const writeTask = vi.fn((next) => {
      task = next
    })
    const result = pollVegetationGenerationTask({
      signal: new AbortController().signal,
      readTask: () => task,
      writeTask,
      queryTask: () => pending.promise,
    })
    await vi.advanceTimersByTimeAsync(1_000)
    task = { taskId: 'task-1', status: 'CANCELED' }
    if (kind === '响应') pending.resolve({ taskId: 'task-1', status: 'RUNNING' })
    else pending.reject(new Error('旧查询失败'))
    await expect(result).resolves.toBe(task)
    expect(writeTask).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('切场景后忽略不支持取消的迟到查询', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const pending = deferred<VegetationGenerationTaskResponse>()
    const task = { taskId: 'task-1', status: 'RUNNING' as const }
    const writeTask = vi.fn()
    const result = pollVegetationGenerationTask({
      signal: controller.signal,
      readTask: () => task,
      writeTask,
      queryTask: () => pending.promise,
    })
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(1_000)
    controller.abort()
    pending.resolve({ taskId: 'task-1', status: 'SUCCESS' })
    await rejected
    expect(writeTask).not.toHaveBeenCalled()
  })

  it('等待期间取消会释放计时器和监听，不发送查询', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const queryTask = vi.fn()
    const result = pollVegetationGenerationTask({
      signal: controller.signal,
      readTask: () => ({ taskId: 'task-1', status: 'RUNNING' }),
      writeTask: vi.fn(),
      queryTask,
    })
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await rejected
    expect(queryTask).not.toHaveBeenCalled()
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(vi.getTimerCount()).toBe(0)
  })
})
