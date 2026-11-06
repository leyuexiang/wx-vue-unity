import request from '@/request.ts'
import { getDim3dHeaders } from './auth'
import { DIM3D_OPERATION_API_PREFIX } from './constants'

/** 模板所属业务类型。两个值由产品固定，不再依赖系统字典接口动态下发。 */
export const DIM3D_TEMPLATE_TYPE = Object.freeze({
  INDUSTRY: 'dim3d_template_industry',
  EXHIBITION: 'dim3d_template_exhibition',
} as const)

export type Dim3dTemplateType = (typeof DIM3D_TEMPLATE_TYPE)[keyof typeof DIM3D_TEMPLATE_TYPE]

/** 模板上下线状态；页面只在拿到这两个明确枚举时才允许切换。 */
export type Dim3dTemplateStatus = 'ONLINE' | 'OFFLINE'

/** 模板资源归属由后端定义为系统资源或我的资源，当前设计稿未提供对应筛选控件。 */
export type Dim3dTemplateResourceBelong = 'SYSTEM' | 'MINE'

/** 模板保存范围，用于编辑器按二维/三维能力过滤模板。 */
export type Dim3dTemplateSaveScope = 'twoD' | 'threeD' | 'all'

/** 模板来源场景类型；与统一场景平台的 SceneType 保持同值域。 */
export type Dim3dTemplateSceneType = 'gis' | 'local3d'

/** 模板分页接口的原始查询参数，所有编号均保持字符串，避免大整数在浏览器中失真。 */
export interface Dim3dTemplatePageParams {
  includeSnapshots?: boolean
  templateName?: string
  templateType?: Dim3dTemplateType
  category?: string
  resourceBelong?: Dim3dTemplateResourceBelong
  status?: Dim3dTemplateStatus
  pageSize?: number
  pageNum?: number
  orderByColumn?: string
  isAsc?: string
}

/** 模板列表记录。接口未返回的展示字段由页面适配层统一降级为占位文案。 */
export interface Dim3dTemplatePageVo {
  id?: string | number
  templateName?: string
  templateDesc?: string
  templateType?: Dim3dTemplateType
  templateTypeName?: string
  category?: string
  categoryName?: string
  resourceBelong?: Dim3dTemplateResourceBelong
  resourceBelongName?: string
  coverImageId?: string | number
  /** 新模板快照接口兼容字段；资源面板会与 coverImageId 统一解析。 */
  coverAssetId?: string | number
  status?: Dim3dTemplateStatus
  statusName?: string
  createTime?: string
  updateTime?: string
  /** 纯二维模板为 twoD，可跨场景使用；threeD/all 需要匹配当前场景类型。 */
  saveScope?: Dim3dTemplateSaveScope
  /** 三维快照来源场景类型；旧接口缺失时页面会按兼容规则展示。 */
  sceneType?: Dim3dTemplateSceneType
  /** 模板快照场景编号，后续实例化接口使用；不等同于模板业务编号时必须由后端返回。 */
  templateSceneId?: string | number
}

/**
 * 模板详情在分页字段基础上补充模板文件编号。列表接口不承诺返回该字段，编辑时必须
 * 以详情接口为准，才能在没有文件替换控件的情况下保持原模板文件绑定不被覆盖。
 */
export interface Dim3dTemplateDetailVo extends Dim3dTemplatePageVo {
  id?: string | number
  templateFileId?: string | number
}

/** 与模型、图片分页适配器统一的标准分页结果。 */
export interface Dim3dTemplatePageResponse {
  total?: number
  rows?: Dim3dTemplatePageVo[]
  code?: number
  msg?: string
}

/** 兼容网关把正式分页对象额外包进 data 字段的响应形态。 */
interface Dim3dTemplatePageEnvelope {
  data?: Dim3dTemplatePageResponse
  code?: number
  msg?: string
}

/** 模板详情接口的标准响应，编号均在页面提交前显式转换为字符串。 */
export interface Dim3dTemplateDetailResponse {
  data?: Dim3dTemplateDetailVo
  code?: number
  msg?: string
}

/**
 * 模板编辑请求体只包含已由 OpenAPI 确认的字段。Figma 中的 2D/3D/2D+3D 单选
 * 当前没有对应后端契约，因此不能擅自添加到这里，以免产生无法持久化的伪字段。
 */
export interface Dim3dTemplateForm {
  templateName: string
  templateDesc?: string
  templateType: Dim3dTemplateType
  category: string
  resourceBelong: Dim3dTemplateResourceBelong
  templateFileId: string
  coverImageId?: string
}

/** 模板状态和删除接口只需消费业务码与消息，不扩展本轮未启用的新增、编辑字段。 */
export interface Dim3dTemplateVoidResponse {
  code?: number
  msg?: string
  data?: null
}

/** 场景快照模板另存请求；四包正文来自同一次编辑器采集，编号均按字符串传输。 */
export interface Dim3dSceneTemplateSnapshotRequest {
  sourceSceneId: string
  sourceRevisionNo: number | string
  requestId: string
  templateName: string
  templateDesc?: string
  templateType: Dim3dTemplateType
  category: string
  resourceBelong?: Dim3dTemplateResourceBelong
  saveScope: Dim3dTemplateSaveScope
  coverAssetId?: string
  sceneJson: string
  threeDJson: string
  twoDJson: string
  dependenciesJson: string
}

/** 场景快照模板另存、目录和回读使用的独立入口，避免改变旧文件型模板协议。 */
const DIM3D_SCENE_TEMPLATE_API_PREFIX = `${DIM3D_OPERATION_API_PREFIX}/dim3d/scene/template`

export function saveAsDim3dSceneTemplateSnapshot(
  body: Dim3dSceneTemplateSnapshotRequest,
  options?: Record<string, unknown>,
) {
  return request<{ data?: Dim3dTemplateDetailVo; code?: number; msg?: string }>(
    `${DIM3D_OPERATION_API_PREFIX}/dim3d/scene/saveAsTemplateFromSnapshot`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getDim3dHeaders() },
      data: body,
      passAuth: true,
      ...(options || {}),
    },
  )
}

export async function pageDim3dSceneTemplate(
  params: Dim3dTemplatePageParams,
  options?: Record<string, unknown>,
) {
  const response = await request<Dim3dTemplatePageResponse | Dim3dTemplatePageEnvelope>(
    `${DIM3D_SCENE_TEMPLATE_API_PREFIX}/page`,
    {
      method: 'GET',
      params,
      headers: getDim3dHeaders(),
      passAuth: true,
      ...(options || {}),
    },
  )
  const payload = response as unknown as { data?: unknown; code?: number; msg?: string }
  const rootPage = normalizeDim3dTemplatePage(payload)
  if (rootPage) return rootPage
  const dataPage = normalizeDim3dTemplatePage(payload.data)
  if (dataPage) return dataPage
  throw createDim3dTemplatePageError(
    typeof payload.code === 'number' ? payload.code : 502,
    payload.msg || '场景快照模板目录返回格式异常',
  )
}

export function getDim3dSceneTemplateInfo(id: string, options?: Record<string, unknown>) {
  return request<Dim3dTemplateDetailResponse>(
    `${DIM3D_SCENE_TEMPLATE_API_PREFIX}/info/${encodeURIComponent(id)}`,
    {
      method: 'GET',
      headers: getDim3dHeaders(),
      passAuth: true,
      ...(options || {}),
    },
  )
}

export function removeDim3dSceneTemplate(id: string, options?: Record<string, unknown>) {
  return request<Dim3dTemplateVoidResponse>(
    `${DIM3D_SCENE_TEMPLATE_API_PREFIX}/remove/${encodeURIComponent(id)}`,
    {
      method: 'DELETE',
      headers: getDim3dHeaders(),
      passAuth: true,
      ...(options || {}),
    },
  )
}

export function changeDim3dSceneTemplateStatus(
  status: Dim3dTemplateStatus,
  id: string,
  options?: Record<string, unknown>,
) {
  return request<Dim3dTemplateVoidResponse>(
    `${DIM3D_SCENE_TEMPLATE_API_PREFIX}/${status}/${encodeURIComponent(id)}`,
    {
      method: 'PUT',
      headers: getDim3dHeaders(),
      passAuth: true,
      ...(options || {}),
    },
  )
}

/**
 * 把代理层可能出现的 rows、records、list、items 统一为标准分页结果。
 * 仅兼容同一模板分页契约的字段别名，缺少列表字段时必须报错，不能把鉴权失败伪装为空列表。
 */
const normalizeDim3dTemplatePage = (value: unknown): Dim3dTemplatePageResponse | undefined => {
  if (Array.isArray(value)) return { total: value.length, rows: value as Dim3dTemplatePageVo[] }
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
    (entry): entry is Dim3dTemplatePageVo[] => Array.isArray(entry),
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
 * 网关可能以 HTTP 200 携带业务 401/403；保留状态码供页面区分登录过期、权限不足和真正空数据。
 */
const createDim3dTemplatePageError = (code: number, message: string) => {
  const error = new Error(message) as Error & { code: number; status: number }
  error.code = code
  error.status = code
  return error
}

/**
 * 查询模板分页列表。
 * 接口前缀统一从环境配置派生，并在每次调用时重新读取三维临时鉴权头，避免页面固化服务器地址或过期令牌。
 */
export async function pageDim3dTemplate(
  params: Dim3dTemplatePageParams,
  options?: Record<string, unknown>,
) {
  const response = await request<Dim3dTemplatePageResponse | Dim3dTemplatePageEnvelope>(
    `${DIM3D_OPERATION_API_PREFIX}/dim3d/template/page`,
    {
      method: 'GET',
      params,
      headers: getDim3dHeaders(),
      passAuth: true,
      ...(options || {}),
    },
  )
  const payload = response as unknown as {
    rows?: unknown
    total?: unknown
    data?: unknown
    code?: number
    msg?: string
  }

  if (payload.code === 401 || payload.code === 403) {
    throw createDim3dTemplatePageError(
      payload.code,
      payload.msg ||
        (payload.code === 401 ? '模板列表接口未授权，请配置有效令牌' : '模板列表接口禁止访问'),
    )
  }

  const rootPage = normalizeDim3dTemplatePage(payload)
  if (rootPage) return rootPage
  const dataPage = normalizeDim3dTemplatePage(payload.data)
  if (dataPage) return dataPage
  const nestedData =
    payload.data && typeof payload.data === 'object'
      ? (payload.data as { data?: unknown }).data
      : undefined
  const nestedPage = normalizeDim3dTemplatePage(nestedData)
  if (nestedPage) return nestedPage

  throw createDim3dTemplatePageError(
    typeof payload.code === 'number' ? payload.code : 502,
    payload.msg || '模板列表接口返回格式异常',
  )
}

/**
 * 编辑弹窗打开时查询模板详情。路径编号先编码，既保护特殊编号也避免把大整数转成 number
 * 后丢失精度；鉴权和地址前缀仍统一复用三维操作服务配置。
 */
export function getDim3dTemplateInfo(id: string, options?: Record<string, unknown>) {
  return request<Dim3dTemplateDetailResponse>(
    `${DIM3D_OPERATION_API_PREFIX}/dim3d/template/info/${encodeURIComponent(id)}`,
    {
      method: 'GET',
      headers: getDim3dHeaders(),
      passAuth: true,
      ...(options || {}),
    },
  )
}

/**
 * 保存模板编辑。封面上传已经完成时仅提交 ossId；模板文件编号由详情保留，本轮不猜测
 * 模板文件替换上传流程，避免提交空值破坏现有模板文件关联。
 */
export function editDim3dTemplate(
  id: string,
  body: Dim3dTemplateForm,
  options?: Record<string, unknown>,
) {
  return request<Dim3dTemplateVoidResponse>(
    `${DIM3D_OPERATION_API_PREFIX}/dim3d/template/edit/${encodeURIComponent(id)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...getDim3dHeaders() },
      data: body,
      passAuth: true,
      ...(options || {}),
    },
  )
}

/** 删除模板；调用方必须先完成二次确认，并校验传入的真实业务编号。 */
export function removeDim3dTemplate(id: string, options?: Record<string, unknown>) {
  return request<Dim3dTemplateVoidResponse>(
    `${DIM3D_OPERATION_API_PREFIX}/dim3d/template/remove/${encodeURIComponent(id)}`,
    {
      method: 'DELETE',
      headers: getDim3dHeaders(),
      passAuth: true,
      ...(options || {}),
    },
  )
}

/** 切换模板上线或下线状态；状态值直接放入路径，禁止使用前端自造枚举。 */
export function changeDim3dTemplateStatus(
  status: Dim3dTemplateStatus,
  id: string,
  options?: Record<string, unknown>,
) {
  return request<Dim3dTemplateVoidResponse>(
    `${DIM3D_OPERATION_API_PREFIX}/dim3d/template/${status}/${encodeURIComponent(id)}`,
    {
      method: 'PUT',
      headers: getDim3dHeaders(),
      passAuth: true,
      ...(options || {}),
    },
  )
}
