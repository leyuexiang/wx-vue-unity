import { describe, expect, it, vi } from 'vitest'
import { readDim3dSceneChunkPage } from '../dim3dSceneChunkReader'

const data = {
  sceneId: 'scene-1',
  revisionNo: 2,
  indexVersion: 1,
  sourceHash: 'a'.repeat(64),
  completeBaseline: { sceneId: 'scene-1', revisionNo: 2 },
  pageNum: 1,
  pageSize: 100,
  total: 1,
  hasMore: false,
  rows: [],
} as const

describe('dim3dSceneChunkReader', () => {
  it('读取固定修订并核对完整基线', async () => {
    const request = vi.fn(async () => ({ code: 200, data }))
    await expect(readDim3dSceneChunkPage({ sceneId: 'scene-1', revisionNo: 2 }, request)).resolves.toEqual(data)
    expect(request).toHaveBeenCalledWith('scene-1', { revisionNo: 2 })
  })

  it('拒绝不匹配的基线和越界分页', async () => {
    const request = vi.fn(async () => ({
      code: 200,
      data: { ...data, completeBaseline: { sceneId: 'scene-2', revisionNo: 2 } },
    }))
    await expect(readDim3dSceneChunkPage({ sceneId: 'scene-1', revisionNo: 2 }, request)).rejects.toThrow('完整基线')
    await expect(readDim3dSceneChunkPage({ sceneId: 'scene-1', revisionNo: 2, pageSize: 501 }, request)).rejects.toThrow('页大小')
  })

  it('保留后端业务错误，不生成空分片结果', async () => {
    const request = vi.fn(async () => ({ code: 404, msg: '区块不存在' }))
    await expect(readDim3dSceneChunkPage({ sceneId: 'scene-1', revisionNo: 2, chunkId: 'missing' }, request)).rejects.toThrow('区块不存在')
  })
})
