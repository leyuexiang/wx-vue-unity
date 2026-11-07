import { describe, expect, it, vi } from 'vitest'
import { createDim3dSceneChunkReadSession, readDim3dSceneChunkPage } from '../dim3dSceneChunkReader'

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

  it('记录已加载区块并计算已知实例中的未加载集合', async () => {
    const request = vi.fn(async (_sceneId: string, params: { revisionNo: number; pageNum?: number }) => ({
      code: 200,
      data: {
        ...data,
        pageNum: params.pageNum ?? 1,
        total: 2,
        rows: [{ chunkId: `chunk-${params.pageNum ?? 1}`, instanceIds: [params.pageNum === 2 ? 'b' : 'a'], instances: [], relations: [] }],
      },
    }))
    const session = createDim3dSceneChunkReadSession({ sceneId: 'scene-1', revisionNo: 2, knownInstanceIds: ['a', 'b', 'c'] }, request)
    const first = await session.readPage({ pageNum: 1, pageSize: 1 })
    expect(first.state.loadedChunkIds).toEqual(['chunk-1'])
    expect(first.state.unloadedInstanceIds).toEqual(['b', 'c'])
    const second = await session.readPage({ pageNum: 2, pageSize: 1 })
    expect(second.state.loadedInstanceIds).toEqual(['a', 'b'])
    expect(second.state.unloadedInstanceIds).toEqual(['c'])
    session.reset()
    expect(session.snapshot().loadedInstanceIds).toEqual([])
  })
})
