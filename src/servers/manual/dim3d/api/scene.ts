import request from '@/request.ts'
import { authContext } from '@/auth/authContext'
import { resolvePlatformApiUrl } from '@/auth/platformApiPathResolver'
import { isEmbeddedMode } from '@/auth/runtime'
import { getDim3dHeaders } from './auth'
import { DIM3D_ADMIN_API, DIM3D_OPERATION_API_PREFIX } from './constants'
import type { Dim3dTemplateType } from './template'

/** 新场景分页查询参数，字段与 /dim3d/scene/page 契约保持一致。 */
export interface Dim3dScenePageParams {
  sceneName?: string
  sceneCategory?: string
  sceneType?: 'local3d' | 'gis'
  /** 场景分页支持按普通场景或模板场景过滤，模板资源面板只读取轻量模板元数据。 */
  sceneKind?: 'INSTANCE' | 'TEMPLATE'
  publishStatus?: 0 | 1
  tenantId?: string
  pageNum?: number
  pageSize?: number
  orderByColumn?: string
  isAsc?: string
}

/** 场景列表基础视图；编号保留字符串，避免 int64 在浏览器中失真。 */
export interface Dim3dScenePageVo {
  sceneId?: string | number
  name?: string
  sceneDesc?: string
  sceneCategory?: string
  sceneCategoryName?: string
  sceneType?: 'local3d' | 'gis'
  sceneTypeName?: string
  /** 模板元数据由场景分页投影返回；普通场景固定为 INSTANCE 且没有保存范围。 */
  sceneKind?: 'INSTANCE' | 'TEMPLATE'
  saveScope?: Dim3dSceneTemplateSaveScope
  publishStatus?: 0 | 1
  coverAssetId?: string | number
  coverUrl?: string
  updateTime?: string
  tenantId?: string | number
  /**
   * 当前线上不可变发布快照编号。
   *
   * 新场景分片查询接口以该字段作为运行态入口；sceneId 只标识编辑场景，不能用于预览分片路径。
   */
  publishedPublicationId?: string | number
}

export interface Dim3dScenePageResponse {
  total?: number
  rows?: Dim3dScenePageVo[]
  code?: number
  msg?: string
}

/** 场景版本快照；编号字段按字符串处理，避免浏览器把长整型精度截断。 */
export interface Dim3dSceneRevisionVo {
  revisionId?: string | number
  sceneId?: string | number
  revisionNo?: number
  schemaVersion?: number
  /** 当前真实接口返回的四包快照；四个字段必须作为同一修订整体解析。 */
  sceneJson?: string
  threeDJson?: string
  twoDJson?: string
  dependenciesJson?: string
  /** 兼容早期详情契约，仅在四包字段完全不存在时读取。 */
  definitionJson?: string
  settingsJson?: string
  contentHash?: string
  baseRevisionNo?: number
  changeSummary?: string
  status?: number
}

/** 新场景详情响应，编辑器只读取当前编辑版本，不再访问旧 projectEngineering 接口。 */
export interface Dim3dSceneDetailVo extends Dim3dScenePageVo {
  sceneId?: string
  name?: string
  currentRevision?: Dim3dSceneRevisionVo
  publishedRevision?: Dim3dSceneRevisionVo
  accessMode?: string
  accessUrl?: string
  needPassword?: boolean
}

export interface Dim3dSceneDetailResponse {
  code?: number
  msg?: string
  data?: Dim3dSceneDetailVo
}

export interface Dim3dSceneForm {
  name: string
  sceneDesc?: string
  sceneCategory?: string
  ownerType?: string
  sceneType: 'local3d' | 'gis'
  coverAssetId?: string
}

/** 模板保存范围与后端 AppSceneSnapshotTemplateBo 的值域保持一致。 */
export type Dim3dSceneTemplateSaveScope = 'twoD' | 'threeD' | 'all'

/**
 * 当前编辑器快照另存模板请求体。
 * 四包来自同一次采集，来源场景及修订用于校验采集基线。
 */
export interface Dim3dSceneSnapshotTemplateBody {
  sourceSceneId: string
  sourceRevisionNo?: number
  requestId: string
  name: string
  /** 固定模板类型；后端快照另存接口补齐该字段后可直接按此值持久化。 */
  templateType: Dim3dTemplateType
  /** 模板类型专属分类字典编码；另存模板接口要求非空。 */
  category: string
  saveScope: Dim3dSceneTemplateSaveScope
  /** 四包正文使用的协议版本，便于后端在解析前先选择对应校验器。 */
  schemaVersion: number
  sceneDesc?: string
  sceneCategory?: string
  ownerType?: 'PLATFORM' | 'TENANT'
  coverAssetId?: string
  sceneJson: string
  threeDJson: string
  twoDJson: string
  dependenciesJson: string
}

/** 新模板场景视图；长整型编号保持字符串，禁止转换为 JavaScript 数字。 */
export interface Dim3dSceneTemplateVo {
  sceneId?: string
  sceneCode?: string
  name?: string
  sceneDesc?: string
  sceneType?: 'local3d' | 'gis'
  sceneKind?: 'INSTANCE' | 'TEMPLATE'
  saveScope?: Dim3dSceneTemplateSaveScope
  sceneCategory?: string
  ownerType?: 'PLATFORM' | 'TENANT'
  accessMode?: 'PERSONAL' | 'ENTERPRISE' | 'PUBLIC_ENCRYPT' | 'PUBLIC_SHARE'
  coverAssetId?: string
  revisionNo?: number
  publishStatus?: 0 | 1
  publishExpireTime?: string
  createBy?: string
  createByName?: string
  createTime?: string
  updateBy?: string
  updateByName?: string
  updateTime?: string
}

export interface Dim3dSceneSnapshotTemplateResponse {
  code?: number
  msg?: string
  data?: Dim3dSceneTemplateVo
}

/** 从快照模板创建独立场景的请求；模板场景编号和请求编号均按字符串传输。 */
export interface Dim3dSceneFromTemplateBody {
  templateSceneId: string
  requestId: string
  name: string
  sceneDesc?: string
  sceneCategory?: string
}

export interface Dim3dSceneFromTemplateResult {
  sceneId?: string
  templateSceneId?: string
  sceneKind?: 'INSTANCE'
  sceneType?: 'local3d' | 'gis'
  revisionId?: string
  revisionNo?: number
}

export interface Dim3dSceneFromTemplateResponse {
  code?: number
  msg?: string
  data?: Dim3dSceneFromTemplateResult
}

export interface Dim3dSceneVoidResponse {
  code?: number
  msg?: string
  data?: unknown
}

export interface Dim3dScenePublishForm {
  changeSummary?: string
  /** 新版发布接口要求访问模式必填；值直接来自 dim3d_access_mode 字典。 */
  accessMode: string
  accessPassword?: string
}

/** 新版场景发布结果；长整型字段同时兼容网关返回字符串，避免调用方进行不安全数值转换。 */
export interface Dim3dScenePublishResultVo {
  /** 发布成功后的不可变发布快照编号，与列表的 publishedPublicationId 语义一致。 */
  publishedPublicationId?: string | number
  publishNo?: number
  sceneRevisionId?: string | number
  revisionNo?: number
  status?: 0 | 1 | 2 | 3
  publishedBy?: string | number
  publishedTime?: string
  /** true 表示线上已是最新草稿且访问设置未变化，本次没有生成新的发布记录。 */
  alreadyPublished?: boolean
}

export interface Dim3dScenePublishResponse {
  code?: number
  msg?: string
  data?: Dim3dScenePublishResultVo
}

/** 场景授权请求体；场景编号和租户编号均按字符串传输，避免长整型精度丢失。 */
export interface Dim3dSceneGrantForm {
  sceneId: string
  grantTenantId: string
}

/** 场景授权租户记录。status=1 表示当前有效授权，其他状态仅用于历史记录。 */
export interface Dim3dSceneAuthorizeTenantVo {
  grantTenantId?: string | number
  grantedTime?: string
  status?: number
}

export interface Dim3dSceneAuthorizeTenantResponse {
  code?: number
  msg?: string
  data?: Dim3dSceneAuthorizeTenantVo[]
}

/** 场景编辑锁视图；lockToken 仅在成功持锁时返回，必须原样保存并随心跳回传。 */
export interface Dim3dSceneLockVo {
  sceneId?: string | number
  lockToken?: string
  baseRevisionNo?: number
  expireTime?: string
  locked?: boolean
  lockedMap?: Record<string, boolean>
}

/** 加锁和心跳接口共用的响应主体。 */
export interface Dim3dSceneLockResponse {
  code?: number
  msg?: string
  data?: Dim3dSceneLockVo
}

/** 心跳续期请求体；接口要求令牌非空，调用方不得使用场景编号替代。 */
export interface Dim3dSceneHeartbeatForm {
  lockToken: string
}

/**
 * 为一次编辑页签生成唯一客户端标识。
 * 优先使用浏览器原生 UUID；不支持时使用时间与随机片段组合，避免同一用户并发页签共用 clientKey。
 */
export const createDim3dSceneClientKey = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `scene-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

const sceneRequest = (path: string, method: string, options: Record<string, unknown> = {}) =>
  request(`${DIM3D_OPERATION_API_PREFIX}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...getDim3dHeaders() },
    passAuth: true,
    ...options,
  })

const normalizePage = (value: unknown): Dim3dScenePageResponse | undefined => {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as { total?: unknown; rows?: unknown; records?: unknown; data?: unknown }
  const rows = [candidate.rows, candidate.records].find(Array.isArray)
  if (!rows) return undefined
  return {
    total: typeof candidate.total === 'number' ? candidate.total : rows.length,
    rows: rows as Dim3dScenePageVo[],
  }
}

/** 获取真实场景分页列表，兼容网关将分页结果包在 data 中的过渡响应。 */
export async function pageDim3dScene(
  params: Dim3dScenePageParams,
  options?: Record<string, unknown>,
) {
  const response = await request<Dim3dScenePageResponse>(
    `${DIM3D_OPERATION_API_PREFIX}/dim3d/scene/page`,
    {
      method: 'GET',
      params,
      headers: getDim3dHeaders(),
      passAuth: true,
      ...(options || {}),
    },
  )
  const payload = response as unknown as { code?: number; msg?: string; data?: unknown }
  const page = normalizePage(response) || normalizePage(payload.data)
  if (page) return page
  throw new Error(payload.msg || '场景列表接口返回格式异常')
}

export const addDim3dScene = (body: Dim3dSceneForm) =>
  sceneRequest('/dim3d/scene/add', 'POST', { data: body })
/** 从在线快照模板创建独立场景，后端负责四包复制和内部编号映射。 */
export const createDim3dSceneFromTemplate = (body: Dim3dSceneFromTemplateBody) =>
  sceneRequest('/dim3d/scene/fromTemplate', 'POST', { data: body }) as Promise<Dim3dSceneFromTemplateResponse>
export const editDim3dScene = (id: string, body: Dim3dSceneForm) =>
  sceneRequest(`/dim3d/scene/edit/${encodeURIComponent(id)}`, 'PUT', { data: body })
/** 按字符串场景编号读取新接口详情，禁止经过旧接口的 Integer 参数转换。 */
export const getDim3dSceneInfo = (id: string) =>
  sceneRequest(
    `/dim3d/scene/info/${encodeURIComponent(id)}`,
    'GET',
  ) as Promise<Dim3dSceneDetailResponse>
export const removeDim3dScene = (id: string) =>
  sceneRequest(`/dim3d/scene/remove/${encodeURIComponent(id)}`, 'DELETE')
export const copyDim3dScene = (id: string) =>
  sceneRequest(`/dim3d/scene/copy/${encodeURIComponent(id)}`, 'POST')
/**
 * 将当前编辑器内存中的完整四包快照另存为模板。
 * 新契约使用无路径参数的单请求，禁止回退到已废弃的 saveAsTemplate/{id} 复制接口。
 */
export const saveDim3dSceneSnapshotAsTemplate = async (body: Dim3dSceneSnapshotTemplateBody) => {
  if (DIM3D_ADMIN_API && (!Number.isInteger(body.sourceRevisionNo) || (body.sourceRevisionNo ?? 0) < 1)) {
    throw new Error('当前场景缺少有效的保存修订，请重新打开后再另存模板')
  }
  const response: Dim3dSceneSnapshotTemplateResponse = await sceneRequest('/dim3d/scene/saveAsTemplateFromSnapshot', 'POST', {
    data: body,
  })
  return DIM3D_ADMIN_API && response.code === 0 ? { ...response, code: 200 } : response
}
/** 发布最新草稿；accessMode 必填，响应通过 alreadyPublished 区分重复发布与实际发布。 */
export const publishDim3dScene = (id: string, body: Dim3dScenePublishForm) =>
  sceneRequest(`/dim3d/scene/publish/${encodeURIComponent(id)}`, 'POST', {
    data: body,
  }) as Promise<Dim3dScenePublishResponse>
/** 取消当前线上发布版本；新版接口使用 PUT 且不接收请求体。 */
export const cancelDim3dScene = (id: string) =>
  sceneRequest(
    `/dim3d/scene/cancel/${encodeURIComponent(id)}`,
    'PUT',
  ) as Promise<Dim3dSceneVoidResponse>

/** 为场景授予租户访问权限。接口契约要求 sceneId/grantTenantId 原样作为字符串提交。 */
export const grantDim3dSceneTenant = (body: Dim3dSceneGrantForm) =>
  sceneRequest('/dim3d/scene/grant', 'POST', { data: body })

/** 回收场景对指定租户的访问权限。 */
export const revokeDim3dSceneTenant = (body: Dim3dSceneGrantForm) =>
  sceneRequest('/dim3d/scene/revoke', 'POST', { data: body })

/** 获取场景当前及历史授权记录，调用方应只展示 status=1 的有效记录。 */
export const getDim3dSceneAuthorizedTenants = (id: string) =>
  sceneRequest(
    `/dim3d/scene/authorizedTenants/${encodeURIComponent(id)}`,
    'GET',
  ) as Promise<Dim3dSceneAuthorizeTenantResponse>

/**
 * 进入编辑器前申请场景锁。
 * clientKey 是前端为当前编辑页签生成的唯一会话标识，必须通过查询参数传给服务端，
 * 用于区分同一用户同时打开的多个编辑页签；场景编号仍按字符串传递，避免 int64 精度丢失。
 */
export const lockDim3dScene = (id: string, clientKey: string) =>
  (sceneRequest(`/dim3d/scene/lock/${encodeURIComponent(id)}`, 'POST', {
    params: { clientKey },
  }) as Promise<Dim3dSceneLockResponse>).then((response) => {
    // 148返回locked=true表示本次持锁成功；页面历史契约的false表示未被他人占用。
    // 仅在成功响应同时提供真实锁令牌时转换，拒绝和未知响应不能冒充持锁成功。
    if (DIM3D_ADMIN_API && response.code === 200 && response.data?.locked === true && response.data.lockToken) {
      return { ...response, data: { ...response.data, locked: false } }
    }
    return response
  })

/** 编辑期间续期场景锁，服务端按接口契约将锁 TTL 延长 20 分钟。 */
export const heartbeatDim3dScene = (id: string, body: Dim3dSceneHeartbeatForm) =>
  (sceneRequest(`/dim3d/scene/heartbeat/${encodeURIComponent(id)}`, 'POST', {
    data: body,
  }) as Promise<Dim3dSceneLockResponse>).then((response) => {
    // 管理接口的成功续约由true和到期时间共同确认，适配为页面的“未被他人占用”。
    if (DIM3D_ADMIN_API && response.code === 200 && response.data?.locked === true && response.data.expireTime) {
      return { ...response, data: { ...response.data, locked: false } }
    }
    return response
  })

/** 离开编辑器时释放当前页签持有的场景锁；clientKey 必须与加锁时保持一致。 */
export const unlockDim3dScene = (id: string, clientKey: string) =>
  sceneRequest(`/dim3d/scene/unlock/${encodeURIComponent(id)}`, 'DELETE', {
    params: { clientKey },
  }) as Promise<Dim3dSceneVoidResponse>

/**
 * 页面销毁阶段释放场景锁。
 * 普通请求链路来不及等待浏览器卸载，因此使用 fetch keepalive 尽量保证 DELETE 请求进入网络队列；
 * 该函数不等待响应，也不抛出异常，适用于 beforeunload/pagehide 等同步退出钩子。
 */
export const unlockDim3dSceneOnUnload = (id: string, clientKey: string) => {
  const params = new URLSearchParams({ clientKey })
  const baseUrl = `${DIM3D_OPERATION_API_PREFIX}/dim3d/scene/unlock/${encodeURIComponent(id)}?${params.toString()}`
  // unload 阶段必须绕过 umi-request，但仍复用同一个平台路径解析器，避免运营端固定路径
  // 在租户端卸载时把解锁请求发错服务。
  // 内嵌页使用父页面的平台类型；独立部署没有父页面上下文，按运营端接口契约补齐 operation。
  const platformType = authContext.getPlatformType() ?? (!isEmbeddedMode() ? 'operation' : null)
  const url = platformType ? resolvePlatformApiUrl(baseUrl, platformType) : baseUrl
  /**
   * 卸载阶段绕过请求拦截器，必须显式补齐内嵌页内存鉴权上下文的令牌和客户端编号；
   * 否则 iframe 中 getDim3dHeaders() 无法读取宿主内存令牌，DELETE 会被后端拒绝，锁只能等 TTL 过期。
   */
  const context = authContext.get()
  const headers = context
    ? {
        Authorization: `Bearer ${context.accessToken}`,
        ClientId: context.clientId,
        // 卸载请求绕过通用拦截器，仍须携带本次认证的租户身份才能释放148的编辑租约。
        ...(context.tenantId ? { 'tenant-id': context.tenantId } : {}),
      }
    : getDim3dHeaders()
  try {
    void fetch(url, {
      method: 'DELETE',
      headers,
      keepalive: true,
    }).catch(() => undefined)
  } catch {
    // 浏览器不支持 keepalive 或页面已进入销毁阶段时，不能再阻塞退出流程。
  }
}
