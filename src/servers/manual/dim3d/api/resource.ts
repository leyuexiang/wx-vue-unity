import request from '@/request.ts'
import { getDim3dHeaders } from './auth'
import { DIM3D_AMM_PREFIX, DIM3D_API_PREFIX } from './constants'

/** 模型资源元信息，resourceRelativePath 是 amm 桶内相对路径，不是完整 URL。 */
export interface Dim3dResourceInfo {
  id?: string | number
  resourceName?: string
  resourceType?: string
  assetName?: string
  resourceRelativePath?: string
}

export interface Dim3dResourceInfoResponse {
  code?: number
  msg?: string
  data?: Dim3dResourceInfo
}

/** 资源详情接口由统一三维服务器根地址派生，禁止在业务适配器中维护 IP 和端口。 */
const DIM3D_RESOURCE_INFO_URL = `${DIM3D_API_PREFIX}/dim3d/resource/info`

/** 按 modelFileId 查询模型资源元信息；编号始终按字符串传递，避免大整数精度损失。 */
export function getDim3dResourceInfo(
  modelFileId: string,
  options?: Record<string, unknown>,
): Promise<Dim3dResourceInfoResponse> {
  return request<Dim3dResourceInfoResponse>(
    `${DIM3D_RESOURCE_INFO_URL}/${encodeURIComponent(modelFileId.trim())}`,
    {
      method: 'GET',
      headers: getDim3dHeaders(),
      passAuth: true,
      // 资源详情是模型文件解析的公共接口；平台差异只作用于模型列表，详情沿用原始路径。
      skipPlatformPath: true,
      ...(options || {}),
    },
  )
}

/** 将接口相对路径规范化为 amm 桶完整地址，避免重复或缺失斜杠。 */
export function buildDim3dResourceUrl(resourceRelativePath: string) {
  const normalizedPath = resourceRelativePath.trim().replace(/^\/+/, '')
  return normalizedPath ? `${DIM3D_AMM_PREFIX}${normalizedPath}` : ''
}

export { DIM3D_AMM_PREFIX, DIM3D_RESOURCE_INFO_URL }

/** 查询文件是否已有受管模型发布；只有明确不存在时才允许沿用历史对象存储路径。 */
export async function getDim3dManagedModelId(modelFileId: string): Promise<string | undefined> {
  let response: { code: number; data?: { resourceId: string; contentFormat: string } }
  try {
    response = await request<typeof response>(
      `${DIM3D_API_PREFIX}/dim3d/resources/${encodeURIComponent(modelFileId)}/current`, {
        method: 'GET', headers: getDim3dHeaders(), passAuth: true, skipPlatformPath: true,
        suppressNotFoundNotification: true,
      },
    )
  } catch (error) {
    // 请求层会将传输和业务404都转换成异常；只有这类明确不存在才代表历史资源。
    const status = error as { code?: number; status?: number }
    if (status.code === 404 || status.status === 404) return undefined
    throw error
  }
  if (response.code === 404) return undefined
  if (response.code !== 200 || response.data?.resourceId !== modelFileId ||
    !['model.glb.v1', 'model.gltf.v1'].includes(response.data.contentFormat)) {
    throw new Error('模型当前发布信息无效，请重新加载')
  }
  return modelFileId
}
