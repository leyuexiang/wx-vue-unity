/** 取消或完成时销毁工作线程；文件通过结构化复制传递，不在主线程读取完整字节。 */
export function hashModelFile(file: File, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const worker = new Worker(new URL('./fileHash.worker.ts', import.meta.url), { type: 'module' })
    const cleanup = () => { signal.removeEventListener('abort', abort); worker.terminate() }
    const abort = () => { cleanup(); reject(new DOMException('已停止等待模型导入', 'AbortError')) }
    signal.addEventListener('abort', abort, { once: true })
    worker.onmessage = event => {
      cleanup()
      if (typeof event.data.sha256 === 'string') resolve(event.data.sha256)
      else reject(new Error(event.data.error || '文件摘要计算失败'))
    }
    worker.onerror = () => { cleanup(); reject(new Error('文件摘要计算失败')) }
    worker.postMessage(file)
  })
}
