import request from '@/request.ts'
import { getDim3dHeaders } from './auth'
import { DIM3D_ADMIN_API, DIM3D_PLATFORM_API_PREFIX } from './constants'

/** 模型目录使用平台网关地址，请求层按当前登录端补全平台段。 */
const MODEL_URL = `${DIM3D_PLATFORM_API_PREFIX}/dim3d/model`

/** 模型管理接口的资源归属枚举，值必须与 OpenAPI 契约一致。 */
export type Dim3dResourceBelong = 'SYSTEM' | 'MINE'

/** 模型管理接口的上下线状态枚举，值必须与 OpenAPI 契约一致。 */
export type Dim3dModelStatus = 'ONLINE' | 'OFFLINE'

/** 模型管理接口的付费状态枚举，值必须与 OpenAPI 契约一致。 */
export type Dim3dModelPaidState = 'FREE' | 'PAID'

export interface Dim3dModelPageParams {
  modelName?: string
  resourceBelong?: Dim3dResourceBelong
  status?: Dim3dModelStatus
  isPaid?: Dim3dModelPaidState
  category?: string
  pageSize?: number
  pageNum?: number
  orderByColumn?: string
  isAsc?: string
}

export interface Dim3dModelPageVo {
  id?: string
  modelName?: string
  modelDesc?: string
  category?: string
  categoryName?: string
  resourceBelong?: Dim3dResourceBelong
  resourceBelongName?: string
  isPaid?: Dim3dModelPaidState
  isPaidName?: string
  /** 正式接口返回两位小数的元价格字符串，旧服务仍可能返回数字。 */
  priceYuan?: string | number | null
  coverImageId?: string
  /** 受控发布事务维护的稳定编号，列表和详情均可返回；旧目录没有关联。 */
  resourceId?: string | number | null
  /** 目录统一用字符串返回文件编号，访问方式由独立授权接口确认。 */
  modelFileId?: string
  /** 部分网关会在详情或资源扩展字段中直接返回可预览路径，作为兼容字段接收。 */
  modelFilePath?: string
  modelFileUrl?: string
  resourceRelativePath?: string
  status?: Dim3dModelStatus
  statusName?: string
  createBy?: string | null
  createByName?: string | null
  createTime?: string
  updateBy?: string | null
  updateByName?: string | null
  updateTime?: string
}

export interface Dim3dModelDetailVo extends Dim3dModelPageVo {
  modelFileId?: string
}

export interface Dim3dModelPageResponse {
  total?: number
  rows?: Dim3dModelPageVo[]
  code?: number
  msg?: string
}

/** 兼容部分网关将分页结果再包一层 data 的过渡响应形态。 */
interface Dim3dModelPageEnvelope {
  data?: Dim3dModelPageResponse
  code?: number
  msg?: string
}

/**
 * 将网关返回的分页候选统一成 total/rows。
 * 正式契约是 rows；records/list/items 仅作为同一分页响应的字段别名兼容，
 * 不读取旧接口的 projectResourceInfoList 等业务字段，避免误把其他 data 当模型列表。
 */
const normalizeDim3dModelPage = (value: unknown): Dim3dModelPageResponse | undefined => {
  // 少数代理会把分页数组直接放在 data 中；数组本身仍需经过统一适配，
  // 这样页面不会因为缺少 rows 字段而错误显示“0 个”。
  if (Array.isArray(value)) return { total: value.length, rows: value as Dim3dModelPageVo[] }
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as {
    total?: unknown
    rows?: unknown
    records?: unknown
    list?: unknown
    items?: unknown
    code?: unknown
    msg?: unknown
  }
  const rows = [candidate.rows, candidate.records, candidate.list, candidate.items].find(
    (entry): entry is Dim3dModelPageVo[] => Array.isArray(entry),
  )
  if (!rows) return undefined
  return {
    total: typeof candidate.total === 'number' ? candidate.total : rows.length,
    rows,
    code: typeof candidate.code === 'number' ? candidate.code : undefined,
    msg: typeof candidate.msg === 'string' ? candidate.msg : undefined,
  }
}

/**
 * 将阶段三分页接口的业务错误转换为带状态码的 Error。
 *
 * 阶段三网关在缺少令牌时可能返回 HTTP 200，但响应体是
 * `{ code: 401, data: null }`。如果继续把“没有 rows”归一化为 `rows: []`，
 * 页面就会把鉴权失败误显示成“没有匹配的数据”。这里保留后端错误码，
 * 让调用方可以区分“权限失败”和“合法空列表”。
 */
const createDim3dModelPageError = (code: number, message: string) => {
  const error = new Error(message) as Error & { code: number; status: number }
  error.code = code
  error.status = code
  return error
}

export interface Dim3dModelDetailResponse {
  data?: Dim3dModelDetailVo
  code?: number
  msg?: string
}

export interface Dim3dModelForm {
  modelName: string
  modelDesc?: string
  category: string
  resourceBelong: Dim3dResourceBelong
  isPaid: Dim3dModelPaidState
  price?: number
  coverImageId?: string | null
  modelFileId: string
}

export interface Dim3dVoidResponse {
  code?: number
  msg?: string
  data?: null
}

/** 管理端四类目录写入都等事务完成才给空回执，避免把旧异步回执当作已保存。 */
function confirmModelWrite(response: Dim3dVoidResponse): Dim3dVoidResponse {
  if (response?.code !== 200 || (DIM3D_ADMIN_API && response.data != null)) {
    throw new Error(response?.msg || '模型操作回执无效')
  }
  return response
}

/** 分页查询模型列表，并兼容旧网关可能附加的 data 包装层。 */
export async function pageDim3dModel(
  params: Dim3dModelPageParams,
  options?: Record<string, unknown>,
) {
  const response = await request<Dim3dModelPageResponse | Dim3dModelPageEnvelope>(
    `${MODEL_URL}/page`,
    {
      method: 'GET',
      params,
      headers: getDim3dHeaders(),
      // 三维服务与管理服务使用不同令牌，禁止全局请求拦截器覆盖临时令牌。
      passAuth: true,
      ...(options || {}),
    },
  )
  // 响应可能是根级分页，也可能经过一到两层 data 包装；这里保留未知形态，
  // 由类型守卫逐层确认 rows，避免交叉类型把 payload 错误收窄为 never。
  const payload = response as unknown as {
    rows?: unknown
    total?: unknown
    data?: unknown
    code?: number
    msg?: string
  }
  // 根级分页同时带业务状态，失败时即使附有空 rows 也不算成功查询。
  if (typeof payload.code === 'number' && payload.code !== 200) {
    throw createDim3dModelPageError(
      payload.code,
      payload.msg ||
        (payload.code === 401 ? '模型列表接口未授权，请配置有效令牌' :
          payload.code === 403 ? '模型列表接口禁止访问' : '模型列表查询失败'),
    )
  }
  // 兼容当前网关的根级分页、标准 data 分页，以及代理额外包裹的 data.data 分页。
  const rootPage = normalizeDim3dModelPage(payload)
  if (rootPage) return rootPage
  const dataPage = normalizeDim3dModelPage(payload.data)
  if (dataPage) return dataPage
  const nestedData =
    payload.data && typeof payload.data === 'object'
      ? (payload.data as { data?: unknown }).data
      : undefined
  const nestedPage = normalizeDim3dModelPage(nestedData)
  if (nestedPage) return nestedPage
  // 只有识别到明确分页结构时才允许返回空列表。缺少 rows 的异常响应不能
  // 被伪装成 0 条数据，否则鉴权失败、网关错误和响应契约变更都会被误判为空。
  throw createDim3dModelPageError(
    typeof payload.code === 'number' ? payload.code : 502,
    payload.msg || '模型列表接口返回格式异常',
  )
}

/** 查询模型详情，供后续编辑表单接入复用。 */
export function getDim3dModelInfo(id: string, options?: Record<string, unknown>) {
  return request<Dim3dModelDetailResponse>(`${MODEL_URL}/info/${encodeURIComponent(id)}`, {
    method: 'GET',
    headers: getDim3dHeaders(),
    passAuth: true,
    ...(options || {}),
  })
}

/** 新增提交完整目录表单，文件编号取自已就绪的上传回执。 */
export function addDim3dModel(body: Dim3dModelForm, options?: Record<string, unknown>) {
  return request<Dim3dVoidResponse>(`${MODEL_URL}/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getDim3dHeaders() },
    data: body,
    passAuth: true,
    ...(options || {}),
  }).then(confirmModelWrite)
}

/** 编辑保留目录编号。原位替换沿用文件编号并在查询参数中提交替换操作编号。 */
export function editDim3dModel(
  id: string,
  body: Dim3dModelForm,
  options?: Record<string, unknown>,
) {
  return request<Dim3dVoidResponse>(`${MODEL_URL}/edit/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...getDim3dHeaders() },
    data: body,
    passAuth: true,
    ...(options || {}),
  }).then(confirmModelWrite)
}

/** 删除模型。 */
export function removeDim3dModel(id: string, options?: Record<string, unknown>) {
  return request<Dim3dVoidResponse>(`${MODEL_URL}/remove/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: getDim3dHeaders(),
    passAuth: true,
    ...(options || {}),
  }).then(confirmModelWrite)
}

/** 切换模型上线或下线状态。 */
export function changeDim3dModelStatus(
  status: Dim3dModelStatus,
  id: string,
  options?: Record<string, unknown>,
) {
  return request<Dim3dVoidResponse>(`${MODEL_URL}/${status}/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: getDim3dHeaders(),
    passAuth: true,
    ...(options || {}),
  }).then(confirmModelWrite)
}
