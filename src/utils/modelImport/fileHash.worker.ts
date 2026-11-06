import { IncrementalSha256 } from './incrementalSha256'

// 在独立工作线程中顺序读取1MiB切片，避免主界面阻塞及500MiB连续内存分配。
self.onmessage = async (event: MessageEvent<File>) => {
  try {
    const file = event.data
    const hash = new IncrementalSha256()
    for (let offset = 0; offset < file.size; offset += 1024 * 1024) {
      hash.update(new Uint8Array(await file.slice(offset, offset + 1024 * 1024).arrayBuffer()))
    }
    self.postMessage({ sha256: hash.digest() })
  } catch { self.postMessage({ error: '无法读取模型文件，请重新选择' }) }
}
