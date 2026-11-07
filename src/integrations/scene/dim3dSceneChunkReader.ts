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
