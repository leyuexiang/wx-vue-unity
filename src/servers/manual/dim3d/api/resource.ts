import request from '@/request.ts'
import { getDim3dHeaders } from './auth'
import { DIM3D_ADMIN_API, DIM3D_AMM_PREFIX, DIM3D_API_PREFIX, DIM3D_PLATFORM_API_PREFIX } from './constants'

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
const DIM3D_RESOURCE_INFO_URL = `${DIM3D_PLATFORM_API_PREFIX}/dim3d/resource/info`

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
      ...(options || {}),
      // 参考服务的历史元信息路径仍为公共路径；本项目按会话路由并校验目录可见性。
      skipPlatformPath: !DIM3D_ADMIN_API,
    },
  )
}

/** 将接口相对路径规范化为 amm 桶完整地址，避免重复或缺失斜杠。 */
export function buildDim3dResourceUrl(resourceRelativePath: string) {
  const normalizedPath = resourceRelativePath.trim().replace(/^\/+/, '')
  return normalizedPath ? `${DIM3D_AMM_PREFIX}${normalizedPath}` : ''
}

export { DIM3D_AMM_PREFIX, DIM3D_RESOURCE_INFO_URL }

export type Dim3dModelFileAccess =
  | { id: string; accessMode: 'MANAGED' }
  | { id: string; accessMode: 'LEGACY'; url: string }

/** 旧管理服未注册文件访问查询时，只接受已授权且身份匹配的当前模型发布。 */
async function readManagedModelOnOldServer(
  id: string,
  options: Record<string, unknown>,
): Promise<Dim3dModelFileAccess> {
  const response = await request<{
    code: number
    msg?: string
    data?: { resourceId: string; contentFormat: string }
  }>(`${DIM3D_API_PREFIX}/dim3d/resources/${id}/current`, options)
  const release = response.data
  if (response.code === 200 && release?.resourceId === id &&
      (release.contentFormat === 'model.glb.v1' || release.contentFormat === 'model.gltf.v1')) {
    return { id, accessMode: 'MANAGED' }
  }
  throw new Error(response.msg || '模型文件访问方式无效')
}

/** 管理模式使用目录授权后的访问方式。只有历史模式才解析可直接访问的相对路径。 */
export async function getDim3dModelFileAccess(id: string, signal?: AbortSignal): Promise<Dim3dModelFileAccess> {
  if (!/^[1-9]\d{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n) {
    throw new Error('模型文件编号无效')
  }
  if (DIM3D_ADMIN_API) {
    const options = {
      method: 'GET', headers: getDim3dHeaders(), passAuth: true, signal,
      suppressNotFoundNotification: true,
    }
    const response = await request<{ code: number; msg?: string; data?: {
      id: string; accessMode: string; resourceRelativePath?: string
    } }>(`${DIM3D_PLATFORM_API_PREFIX}/dim3d/model/file-access/${id}`, {
      ...options, suppressMethodNotAllowedNotification: true,
    }).catch((error: unknown) => {
      const status = error as { code?: number; status?: number } | null
      // 仅兼容已实测的旧路由 405。资源不可见、权限异常和网络故障保留原错误。
      if (status?.code === 405 || status?.status === 405) {
        return { code: 405, data: undefined, msg: undefined }
      }
      throw error
    })
    if (response.code === 405) return readManagedModelOnOldServer(id, { ...options, skipPlatformPath: true })
    const file = response.data
    if (response.code !== 200 || file?.id !== id) throw new Error(response.msg || '模型文件访问方式无效')
    if (file.accessMode === 'MANAGED') return { id, accessMode: 'MANAGED' }
    if (file.accessMode === 'LEGACY' && file.resourceRelativePath?.trim()) {
      return { id, accessMode: 'LEGACY', url: buildDim3dResourceUrl(file.resourceRelativePath) }
    }
    throw new Error('模型文件访问方式无效')
  }

  // 参考服务沿用原资源详情。当前项目管理服务始终按服务端返回的访问方式分流。
  const response = await getDim3dResourceInfo(id, { signal, suppressNotFoundNotification: true })
  const data = response.data
  if (response.code !== 200 || String(data?.id ?? '') !== id || data?.resourceType?.toUpperCase() !== 'MODEL'
    || !data.resourceRelativePath?.trim()) {
    throw new Error(response.msg || '模型资源未返回有效预览地址')
  }
  return { id, accessMode: 'LEGACY', url: buildDim3dResourceUrl(data.resourceRelativePath) }
}
