import {
  getDim3dSceneChunks,
  type Dim3dSceneChunkReadData,
  type Dim3dSceneChunkReadParams,
  type Dim3dSceneChunkReadResponse,
} from '@/servers/manual/dim3d/api/scene'

export interface Dim3dSceneChunkReaderOptions extends Dim3dSceneChunkReadParams {
  sceneId: string
}

export type Dim3dSceneChunkRequest = (
  sceneId: string,
  params: Dim3dSceneChunkReadParams,
) => Promise<Dim3dSceneChunkReadResponse>

export interface Dim3dSceneChunkReadSessionOptions {
  sceneId: string
  revisionNo: number
  /** 已由完整四包基线知道的实例编号，用于计算当前尚未读取的实例集合。 */
  knownInstanceIds?: readonly string[]
}

export interface Dim3dSceneChunkReadSessionSnapshot {
  sceneId: string
  revisionNo: number
  sourceHash?: string
  totalChunks?: number
  loadedChunkIds: readonly string[]
  loadedInstanceIds: readonly string[]
  unloadedInstanceIds: readonly string[]
}

export interface Dim3dSceneChunkReadSession {
  readPage: (params?: Omit<Dim3dSceneChunkReadParams, 'revisionNo'>) => Promise<{
    data: Dim3dSceneChunkReadData
    state: Dim3dSceneChunkReadSessionSnapshot
  }>
  snapshot: () => Dim3dSceneChunkReadSessionSnapshot
  subscribe: (listener: (state: Dim3dSceneChunkReadSessionSnapshot) => void) => () => boolean
  unloadChunk: (chunkId: string) => void
  reset: () => void
}

const validateOptions = (options: Dim3dSceneChunkReaderOptions) => {
  if (!options.sceneId.trim()) throw new Error('分片读取缺少场景编号')
  if (!Number.isInteger(options.revisionNo) || options.revisionNo < 1) throw new Error('分片读取修订号无效')
  if (options.pageNum !== undefined && (!Number.isInteger(options.pageNum) || options.pageNum < 1)) {
    throw new Error('分片读取页码无效')
  }
  if (options.pageSize !== undefined && (!Number.isInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 500)) {
    throw new Error('分片读取页大小无效')
  }
}

/**
 * 读取固定修订的只读分片，并核对服务端返回的完整基线身份。
 *
 * <p>该适配器只返回区块结果，不更新 SceneStore，也不把未加载实例转成删除集合。
 * 保存仍由完整四包适配器负责。</p>
 */
export const readDim3dSceneChunkPage = async (
  options: Dim3dSceneChunkReaderOptions,
  request: Dim3dSceneChunkRequest = getDim3dSceneChunks,
): Promise<Dim3dSceneChunkReadData> => {
  validateOptions(options)
  const { sceneId, ...params } = options
  const response = await request(sceneId, params)
  if (response.code !== 200 || !response.data) {
    throw new Error(response.msg?.trim() || `分片读取失败，业务码：${String(response.code)}`)
  }
  const baseline = response.data.completeBaseline
  if (baseline.sceneId !== sceneId || baseline.revisionNo !== options.revisionNo) {
    throw new Error('分片读取返回了不匹配的完整基线')
  }
  return response.data
}

/**
 * 为只读页面维护固定书签下的分片读取状态。
 *
 * <p>会话只记录已读取区块和实例编号，不修改 SceneStore，也不把未读取集合当作删除集合。
 * 重新打开或切换修订时由调用方丢弃旧会话并创建新会话。</p>
 */
export const createDim3dSceneChunkReadSession = (
  options: Dim3dSceneChunkReadSessionOptions,
  request: Dim3dSceneChunkRequest = getDim3dSceneChunks,
): Dim3dSceneChunkReadSession => {
  const knownInstanceIds = new Set(options.knownInstanceIds ?? [])
  const loadedChunkIds = new Set<string>()
  const loadedInstanceIds = new Set<string>()
  const instanceIdsByChunk = new Map<string, Set<string>>()
  const listeners = new Set<(state: Dim3dSceneChunkReadSessionSnapshot) => void>()
  let sourceHash: string | undefined
  let totalChunks: number | undefined

  const snapshot = (): Dim3dSceneChunkReadSessionSnapshot => ({
    sceneId: options.sceneId,
    revisionNo: options.revisionNo,
    ...(sourceHash ? { sourceHash } : {}),
    ...(totalChunks === undefined ? {} : { totalChunks }),
    loadedChunkIds: [...loadedChunkIds],
    loadedInstanceIds: [...loadedInstanceIds],
    unloadedInstanceIds: [...knownInstanceIds].filter((id) => !loadedInstanceIds.has(id)),
  })

  const publish = () => {
    const current = snapshot()
    listeners.forEach((listener) => listener(current))
  }

  return {
    readPage: async (params: Omit<Dim3dSceneChunkReadParams, 'revisionNo'> = {}) => {
      const data = await readDim3dSceneChunkPage(
        { sceneId: options.sceneId, revisionNo: options.revisionNo, ...params },
        request,
      )
      sourceHash = data.sourceHash
      totalChunks = data.total
      data.rows.forEach((row) => {
        const previousIds = instanceIdsByChunk.get(row.chunkId)
        previousIds?.forEach((id) => loadedInstanceIds.delete(id))
        loadedChunkIds.add(row.chunkId)
        const currentIds = new Set(row.instanceIds)
        instanceIdsByChunk.set(row.chunkId, currentIds)
        currentIds.forEach((id) => loadedInstanceIds.add(id))
      })
      publish()
      return { data, state: snapshot() }
    },
    snapshot,
    subscribe: (listener: (state: Dim3dSceneChunkReadSessionSnapshot) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    unloadChunk: (chunkId: string) => {
      const currentIds = instanceIdsByChunk.get(chunkId)
      if (!currentIds) return
      currentIds.forEach((id) => loadedInstanceIds.delete(id))
      instanceIdsByChunk.delete(chunkId)
      loadedChunkIds.delete(chunkId)
      publish()
    },
    reset: () => {
      sourceHash = undefined
      totalChunks = undefined
      loadedChunkIds.clear()
      loadedInstanceIds.clear()
      instanceIdsByChunk.clear()
      publish()
    },
  }
}
