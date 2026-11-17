import request from '@/request.ts'
import { getDim3dHeaders } from './auth'
import { DIM3D_OPERATION_API_PREFIX } from './constants'
import type { Dim3dModelStatus, Dim3dResourceBelong } from './model'

/** 阶段三图标分页查询参数，字段与 operation OpenAPI 保持一致。 */
export interface Dim3dIconPageParams {
  iconName?: string
  category?: string
  secondaryCategory?: string
  resourceBelong?: Dim3dResourceBelong
  status?: Dim3dModelStatus
  pageSize?: number
  pageNum?: number
  orderByColumn?: string
  isAsc?: string
}

/** 图标列表和详情共用的真实字段；文件编号必须按字符串处理。 */
export interface Dim3dIconPageVo {
  id?: string
  iconName?: string
  iconDesc?: string
  category?: string
  categoryName?: string
  secondaryCategory?: string
  resourceBelong?: Dim3dResourceBelong
  resourceBelongName?: string
  iconFileId?: string
  status?: Dim3dModelStatus
  statusName?: string
  createTime?: string
  updateTime?: string
}

export interface Dim3dIconPageResponse {
  total?: number
  rows?: Dim3dIconPageVo[]
  code?: number
  msg?: string
}

export interface Dim3dIconDetailResponse {
  data?: Dim3dIconPageVo
  code?: number
  msg?: string
}

/** 新增和编辑图标请求体，不能把旧接口的 iconPath 或 typeId 传给阶段三接口。 */
export interface Dim3dIconForm {
  iconName: string
  iconDesc?: string
  category: string
  secondaryCategory?: string
  resourceBelong: Dim3dResourceBelong
  iconFileId: string
}

export interface Dim3dIconVoidResponse {
  code?: number
  msg?: string
  data?: null
}

/** 新增返回服务端生成的字符串目录编号。 */
export interface Dim3dIconCreateResponse {
  code?: number
  msg?: string
  data?: string
}

interface Dim3dIconPageEnvelope {
  data?: Dim3dIconPageResponse
  code?: number
  msg?: string
}

/** 对齐已核实的后端 data.list 分页，同时兼容现有 rows 消费合同。 */
const normalizeIconPage = (value: unknown): Dim3dIconPageResponse | undefined => {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as { total?: unknown; rows?: unknown; list?: unknown; code?: unknown; msg?: unknown }
  const rows = Array.isArray(candidate.rows) ? candidate.rows : candidate.list
  if (!Array.isArray(rows)) return undefined
  return {
    total: typeof candidate.total === 'number' ? candidate.total : rows.length,
    rows: rows as Dim3dIconPageVo[],
    code: typeof candidate.code === 'number' ? candidate.code : undefined,
    msg: typeof candidate.msg === 'string' ? candidate.msg : undefined,
  }
}

/** 保留阶段三业务鉴权错误码，避免把 401/403 空 data 误报为列表为空。 */
const createIconPageError = (code: number, message: string) => {
  const error = new Error(message) as Error & { code: number; status: number }
  error.code = code
  error.status = code
  return error
}

/** 业务错误码可能不在全局枚举中，保存入口必须再次确认回执成功，避免失败后关闭表单。 */
const requireIconMutationSuccess = <T extends { code?: number; msg?: string }>(response: T): T => {
  if (response?.code !== 200) {
    throw createIconPageError(response?.code ?? 502, response?.msg || '图片保存失败')
  }
  return response
}

/** 阶段三图标分页接口；不再读取旧 `projectIconInfoList/countMax` 字段。 */
export async function pageDim3dIcon(
  params: Dim3dIconPageParams,
  options?: Record<string, unknown>,
) {
  const response = await request<Dim3dIconPageResponse | Dim3dIconPageEnvelope>(
    `${DIM3D_OPERATION_API_PREFIX}/dim3d/icon/page`,
    {
      method: 'GET',
      params,
      headers: getDim3dHeaders(),
      passAuth: true,
      ...(options || {}),
    },
  )
  const payload = response as unknown as {
    data?: unknown
    rows?: unknown
    total?: unknown
    code?: number
    msg?: string
  }
  if (payload.code === 401 || payload.code === 403) {
    throw createIconPageError(
      payload.code,
      payload.msg || (payload.code === 401 ? '当前登录已过期，请重新登录' : '图片列表接口禁止访问'),
    )
  }
  const root = normalizeIconPage(payload)
  if (root) return root
  const nested = normalizeIconPage(payload.data)
  if (nested) return nested
  throw createIconPageError(
    typeof payload.code === 'number' ? payload.code : 502,
    payload.msg || '图片列表接口返回格式异常',
  )
}

/** 查询图标详情，编辑时用于回显真实文件编号和分类字段。 */
export function getDim3dIconInfo(id: string, options?: Record<string, unknown>) {
  return request<Dim3dIconDetailResponse>(`${DIM3D_OPERATION_API_PREFIX}/dim3d/icon/info/${id}`, {
    method: 'GET',
    headers: getDim3dHeaders(),
    passAuth: true,
    ...(options || {}),
  })
}

/** 新增图标；文件上传完成后才允许提交 iconFileId。 */
export function addDim3dIcon(body: Dim3dIconForm, options?: Record<string, unknown>) {
  return request<Dim3dIconCreateResponse>(`${DIM3D_OPERATION_API_PREFIX}/dim3d/icon/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getDim3dHeaders() },
    data: body,
    passAuth: true,
    ...(options || {}),
  }).then(requireIconMutationSuccess)
}

/** 编辑图标；未替换文件时继续提交详情中的原 iconFileId。 */
export function editDim3dIcon(id: string, body: Dim3dIconForm, options?: Record<string, unknown>) {
  return request<Dim3dIconVoidResponse>(`${DIM3D_OPERATION_API_PREFIX}/dim3d/icon/edit/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...getDim3dHeaders() },
    data: body,
    passAuth: true,
    ...(options || {}),
  }).then(requireIconMutationSuccess)
}

/** 删除图标。 */
export function removeDim3dIcon(id: string, options?: Record<string, unknown>) {
  return request<Dim3dIconVoidResponse>(`${DIM3D_OPERATION_API_PREFIX}/dim3d/icon/remove/${id}`, {
    method: 'DELETE',
    headers: getDim3dHeaders(),
    passAuth: true,
    ...(options || {}),
  })
}

/** 切换图标上线或下线状态。 */
export function changeDim3dIconStatus(
  status: Dim3dModelStatus,
  id: string,
  options?: Record<string, unknown>,
) {
  return request<Dim3dIconVoidResponse>(
    `${DIM3D_OPERATION_API_PREFIX}/dim3d/icon/${status}/${id}`,
    {
      method: 'PUT',
      headers: getDim3dHeaders(),
      passAuth: true,
      ...(options || {}),
    },
  )
}
