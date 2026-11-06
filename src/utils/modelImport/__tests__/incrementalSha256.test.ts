import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { IncrementalSha256 } from '../incrementalSha256'

it('分块与填充边界和Node标准实现一致，包含空文件及跨1MiB文件', () => {
  for (const size of [0, 1, 55, 56, 63, 64, 65, 127, 128, 1024 * 1024 + 17]) {
    const bytes = Uint8Array.from({ length: size }, (_, i) => (i * 17) % 256)
    for (const chunk of [1, 67, 1024 * 1024]) {
      const hash = new IncrementalSha256()
      for (let offset = 0; offset < bytes.length; offset += chunk) hash.update(bytes.subarray(offset, offset + chunk))
      expect(hash.digest(), `${size}/${chunk}`).toBe(createHash('sha256').update(bytes).digest('hex'))
    }
  }
})
