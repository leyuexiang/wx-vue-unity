import request from '@/request.ts'
import { getDim3dHeaders } from './auth'
import { DIM3D_ADMIN_API, DIM3D_PLATFORM_API_PREFIX } from './constants'

/** 通用对象存储上传结果；ossId 必须始终按字符串处理，避免大整数精度丢失。 */
export interface Dim3dOssFile {
  ossId?: string | number
  url?: string
  fileName?: string
  originalName?: string
  fileSuffix?: string
  ext1?: string
  service?: string
}

export interface Dim3dOssUploadResponse {
  code?: number
  msg?: string
  data?: Dim3dOssFile
}

export interface Dim3dOssListResponse {
  code?: number
  msg?: string
  data?: Dim3dOssFile[]
}

/** 图片和封面的文件入口由当前登录端分流，参考服务继续使用原公共路径。 */
const DIM3D_OSS_PREFIX = `${DIM3D_PLATFORM_API_PREFIX}/resource/oss`

/** 上传普通资源文件，表单字段固定为 file；响应中的 url 只用于即时预览。 */
export function uploadDim3dOssFile(
  file: File,
  options?: Record<string, unknown>,
): Promise<Dim3dOssUploadResponse> {
  const formData = new FormData()
  formData.append('file', file)
  return request<Dim3dOssUploadResponse>(`${DIM3D_OSS_PREFIX}/upload`, {
    method: 'POST',
    data: formData,
    requestType: 'form',
    headers: getDim3dHeaders(),
    passAuth: true,
    ...(options || {}),
    skipPlatformPath: !DIM3D_ADMIN_API,
  })
}

/** 按单个 ossId 查询文件，避免猜测后端未声明的多编号分隔符。 */
export function getDim3dOssFileById(
  ossId: string,
  options?: Record<string, unknown>,
): Promise<Dim3dOssListResponse> {
  const normalizedId = ossId.trim()
  return request<Dim3dOssListResponse>(
    `${DIM3D_OSS_PREFIX}/listByIds/${encodeURIComponent(normalizedId)}`,
    {
      method: 'GET',
      headers: getDim3dHeaders(),
      passAuth: true,
      ...(options || {}),
      // 与上传使用同一登录端，文件范围由服务端的归属授权核对。
      skipPlatformPath: !DIM3D_ADMIN_API,
    },
  )
}

export { DIM3D_OSS_PREFIX }
