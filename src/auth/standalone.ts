import { authContext } from './authContext'
import { normalizeAccessToken } from './accessToken'
import { DIM3D_SERVER_URL as server } from '@/servers/manual/dim3d/api/constants'
import { DIM3D_ADMIN_API } from '@/servers/manual/dim3d/api/constants'
import type { PlatformType } from './authTypes'

/** 第二版会话明确绑定登录平台；不恢复缺失平台的旧版本，避免把租户身份默认为运营端。 */
const sessionKey = 'wx-unity:standalone-session:v2'
const legacySessionKey = 'wx-unity:standalone-session:v1'
/** 两端真实端点显式映射；租户资料路径不含 web，不参与业务路径自动改写。 */
const platformEndpoints = {
  operation: { login: '/auth/operation/login', profile: '/system/user/getInfo' },
  tenant: { login: '/auth/tenant/login', profile: '/tenant/profile/getInfo' },
} as const

/** 沿用现代业务封套，旧管理接口的成功码 0 不在此协议内。 */
interface ApiResult<T> { code: number; msg: string; data: T }
/** 登录令牌使用参考运营端字段；有效期统一为秒，转换为毫秒仅在会话层完成。 */
export interface StandaloneTokens {
  tenantId?: string
  access_token: string
  client_id: string
  /** 参考服务可能返回 null；空值表示未声明期限，不能当作零秒或格式错误。 */
  expire_in?: number | null
  /** 未签发刷新令牌时参考服务返回 null，此时只使用访问令牌，不进行续期。 */
  refresh_token?: string | null
  refresh_expire_in?: number | null
}
/** 后端原始资料：运营端返回 nickName，参考租户端返回 userName，头像允许为空。 */
export interface StandaloneProfileResponse {
  user: {
    userId: string | number
    nickName?: string | null
    userName?: string | null
    avatar?: string | number | null
    deptId?: string | number | null
  }
  permissions: string[]
  roles: string[]
}
/** 页面内部资料投影：显示名称统一为 nickName，不要求后端两种用户表使用同名字段。 */
export interface StandaloneProfile {
  user: { userId: string | number; nickName: string; avatar?: string | number; deptId?: string | number }
  permissions: string[]
  roles: string[]
}
interface Session {
  server: string
  /** 同一服务器切换认证协议时，旧令牌与响应格式不能跨协议恢复。 */
  apiMode?: 'admin' | 'reference'
  /** 来自本次成功登录所用的端点；恢复、续期及页签交接均保留同一平台。 */
  platformType: PlatformType
  tokens: StandaloneTokens
  expiresAt?: number
  refreshExpiresAt?: number
  profile: StandaloneProfile
}
let activeSession: Session | null = null
let refreshTask: { version: number; promise: Promise<boolean> } | null = null
// 生命周期编号使退出、重新登录、恢复请求相互隔离，迟到响应不能恢复旧身份。
let sessionVersion = 0

/** 认证端点固定公共路径，不经过平台插段、通用令牌注入和业务 401 重试。 */
async function call<T>(path: string, body?: unknown, tokens?: StandaloneTokens, tenantId?: string): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  try {
    const response = await fetch(`${server}/${DIM3D_ADMIN_API ? 'admin-api' : 'api'}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'omit',
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(tokens ? { Authorization: `Bearer ${normalizeAccessToken(tokens.access_token)}`, ClientId: tokens.client_id } : {}),
        ...((tokens?.tenantId || tenantId) ? { 'tenant-id': tokens?.tenantId || tenantId! } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const result = await response.json() as ApiResult<T>
    if (!response.ok || result.code !== 200) {
      throw Object.assign(new Error(result.msg || '认证请求失败'), { status: response.status, code: result.code })
    }
    return result.data
  } finally {
    clearTimeout(timer)
  }
}

/** 校验边界数据，缺失权限不补发管理员权限，也不把无效令牌视为登录成功。 */
function validateTokens(tokens: StandaloneTokens): void {
  if (!tokens || typeof tokens.access_token !== 'string' || !normalizeAccessToken(tokens.access_token) ||
    typeof tokens.client_id !== 'string' || !tokens.client_id.trim()) throw new Error('登录响应缺少令牌或客户端编号')
  for (const value of [tokens.expire_in, tokens.refresh_expire_in]) {
    // 可选字段的 null 与未返回等价；只校验实际提供的数值，仍拒绝字符串、零、负数及非有限值。
    if (value != null && (!Number.isFinite(value) || value <= 0)) throw new Error('登录有效期格式错误')
  }
}
function validateProfile(profile: StandaloneProfile): void {
  const userId = profile?.user?.userId
  const validId = typeof userId === 'string' ? Boolean(userId.trim()) : typeof userId === 'number' && Number.isFinite(userId)
  if (!profile?.user || !validId || typeof profile.user.nickName !== 'string' ||
    !Array.isArray(profile.permissions) || !profile.permissions.every(value => typeof value === 'string') ||
    !Array.isArray(profile.roles) || !profile.roles.every(value => typeof value === 'string')) throw new Error('用户权限响应格式错误')
}

/** 在网络边界适配真实租户名称字段；不猜测用户编号、不补权限，登录和页面恢复共用此入口。 */
async function loadProfile(tokens: StandaloneTokens, platformType: PlatformType): Promise<StandaloneProfile> {
  if (DIM3D_ADMIN_API) {
    const response = await call<{ user: { id: string | number; nickname: string; avatar?: string; deptId?: string | number }; permissions: string[]; roles: string[] }>(
      '/system/auth/get-permission-info', undefined, tokens)
    const profile: StandaloneProfile = { user: { userId: response.user?.id, nickName: response.user?.nickname,
      ...(response.user?.avatar == null ? {} : { avatar: response.user.avatar }),
      ...(response.user?.deptId == null ? {} : { deptId: response.user.deptId }) }, permissions: response.permissions, roles: response.roles }
    validateProfile(profile)
    return profile
  }
  const response = await call<StandaloneProfileResponse>(platformEndpoints[platformType].profile, undefined, tokens)
  const user = response?.user
  if (!user || typeof user !== 'object') throw new Error('用户权限响应格式错误')
  const name = platformType === 'tenant' && (typeof user.nickName !== 'string' || !user.nickName.trim())
    ? user.userName
    : user.nickName
  if (typeof name !== 'string') throw new Error('用户权限响应格式错误')
  const profile: StandaloneProfile = {
    user: {
      userId: user.userId,
      nickName: name,
      ...(user.avatar == null ? {} : { avatar: user.avatar }),
      ...(user.deptId == null ? {} : { deptId: user.deptId }),
    },
    permissions: response.permissions,
    roles: response.roles,
  }
  validateProfile(profile)
  return profile
}

/** 仅当前页签保存会话，绑定服务器地址；切换环境不能恢复上一后端的令牌。 */
function applySession(session: Session): void {
  activeSession = session
  authContext.set({
    accessToken: normalizeAccessToken(session.tokens.access_token), clientId: session.tokens.client_id,
    permissions: session.profile.permissions, roles: session.profile.roles, platformType: session.platformType,
    expiresAt: session.expiresAt,
    ...(session.tokens.tenantId ? { tenantId: session.tokens.tenantId } : {}),
  })
  try { sessionStorage.setItem(sessionKey, JSON.stringify(session)) } catch { /* 存储受限时仅保持内存会话。 */ }
}

/** 短信请求沿用认证租户配置，发送成功不代表已建立会话。 */
export async function sendStandaloneSms(mobile: string, platformType: PlatformType): Promise<void> {
  if (!DIM3D_ADMIN_API) throw new Error('当前登录服务暂不支持短信登录')
  if (!/^1[3-9]\d{9}$/.test(mobile.trim())) throw new Error('请输入有效手机号')
  if (platformType !== 'operation' && platformType !== 'tenant') throw new Error('请选择有效登录平台')
  const tenantId = String(platformType === 'tenant' ? import.meta.env.VITE_AUTH_TENANT_ID || '' : import.meta.env.VITE_AUTH_OPERATION_TENANT_ID || '').trim()
  if (!/^[1-9]\d{0,18}$/.test(tenantId)) throw new Error('未配置有效登录租户编号')
  await call<boolean>('/system/auth/send-sms-code', { mobile: mobile.trim(), scene: 21 }, undefined, tenantId)
}

/** 两种登录复用权限加载与会话校验，不通过手机号表单改变租户或登录平台。 */
export async function loginStandalone(phonenumber: string, password: string, platformType: PlatformType = 'operation', method: 'account' | 'mobile' = 'account'): Promise<StandaloneProfile> {
  if (platformType !== 'operation' && platformType !== 'tenant') throw new Error('请选择有效登录平台')
  if (method !== 'account' && method !== 'mobile') throw new Error('请选择有效登录方式')
  if (method === 'mobile' && (!/^1[3-9]\d{9}$/.test(phonenumber.trim()) || !/^\d{4,6}$/.test(password))) throw new Error('请输入有效手机号和验证码')
  if (method === 'mobile' && !DIM3D_ADMIN_API) throw new Error('当前登录服务暂不支持短信登录')
  const configuredClientId = platformType === 'tenant' ? import.meta.env.VITE_AUTH_TENANT_CLIENT_ID :
    import.meta.env.VITE_AUTH_OPERATION_CLIENT_ID || import.meta.env.VITE_AUTH_CLIENT_ID
  const clientId = String(configuredClientId || '').trim()
  if (!DIM3D_ADMIN_API && !clientId) throw new Error(`未配置${platformType === 'tenant' ? '租户端' : '运营端'}登录应用编号`)
  const version = ++sessionVersion
  const issuedAt = Date.now()
  const endpoints = platformEndpoints[platformType]
  let tokens: StandaloneTokens
  if (DIM3D_ADMIN_API) {
    const tenantId = String(platformType === 'tenant' ? import.meta.env.VITE_AUTH_TENANT_ID || '' : import.meta.env.VITE_AUTH_OPERATION_TENANT_ID || '').trim()
    if (!/^[1-9]\d{0,18}$/.test(tenantId)) throw new Error('未配置有效登录租户编号')
    // 密码和短信走各自已存在的认证入口；租户仍由部署配置选择并由服务端校验。
    const result = await call<{ accessToken: string; expiresTime: string | number }>(
      method === 'mobile' ? '/system/auth/sms-login' : '/system/auth/login',
      method === 'mobile' ? { mobile: phonenumber.trim(), code: password } : { username: phonenumber.trim(), password }, undefined, tenantId)
    const expiresAt = typeof result.expiresTime === 'number' ? result.expiresTime : Date.parse(result.expiresTime)
    if (!Number.isFinite(expiresAt) || expiresAt <= issuedAt) throw new Error('登录有效期格式错误')
    tokens = { access_token: result.accessToken, client_id: 'admin-api', tenantId, expire_in: (expiresAt - issuedAt) / 1000 }
  } else {
    tokens = await call<StandaloneTokens>(endpoints.login, { clientId, accountType: 2, phonenumber: phonenumber.trim(), password, grantType: 'password' })
  }
  validateTokens(tokens)
  // 先取得真实权限再发布会话，避免用户信息失败后页面短暂携带未验证的管理员身份。
  const profile = await loadProfile(tokens, platformType)
  if (version !== sessionVersion) throw new Error('登录操作已取消')
  const now = issuedAt
  applySession({ server, apiMode: DIM3D_ADMIN_API ? 'admin' : 'reference', platformType, tokens, profile,
    // 显式使用空值判断，防止 null 经数值运算变成零而把刚登录的会话立即判为过期。
    expiresAt: tokens.expire_in == null ? undefined : now + tokens.expire_in * 1000,
    refreshExpiresAt: tokens.refresh_expire_in == null ? undefined : now + tokens.refresh_expire_in * 1000 })
  return profile
}

/** 恢复页签会话后重新查询权限；暂时网络失败保留存储，明确失效才删除。 */
export async function restoreStandalone(): Promise<StandaloneProfile | null> {
  const version = ++sessionVersion
  let session: Session
  try {
    sessionStorage.removeItem(legacySessionKey)
    const stored = sessionStorage.getItem(sessionKey)
    if (!stored) return null
    session = JSON.parse(stored) as Session
    if (session.server !== server || (session.apiMode ?? 'reference') !== (DIM3D_ADMIN_API ? 'admin' : 'reference') ||
      (session.platformType !== 'operation' && session.platformType !== 'tenant')) {
      clearStandalone()
      return null
    }
    validateTokens(session.tokens)
    if (DIM3D_ADMIN_API && session.tokens.tenantId !== String(session.platformType === 'tenant' ? import.meta.env.VITE_AUTH_TENANT_ID || '' : import.meta.env.VITE_AUTH_OPERATION_TENANT_ID || '').trim()) {
      clearStandalone()
      return null
    }
    validateProfile(session.profile)
    for (const value of [session.expiresAt, session.refreshExpiresAt]) {
      if (value !== undefined && !Number.isFinite(value)) throw new Error('会话有效期格式错误')
    }
  } catch { clearStandalone(); return null }
  activeSession = session
  if (session.expiresAt && session.expiresAt <= Date.now()) {
    const refreshed = await refreshStandalone()
    if (version !== sessionVersion) return null
    if (!refreshed) { clearStandalone(); return null }
    session = activeSession!
  }
  try {
    const profile = await loadProfile(session.tokens, session.platformType)
    if (version !== sessionVersion) return null
    applySession({ ...session, profile })
    return profile
  } catch (error) {
    // 已经发生退出或另一轮登录时，旧恢复请求的失败也不能清理新身份。
    if (version !== sessionVersion) return null
    const status = error as { status?: number; code?: number }
    if (status.status === 401 || status.code === 401) { clearStandalone(); return null }
    throw error
  }
}

/** 当前来源未证实续期端点，默认关闭；自建后端实现文档协议后才能启用。并发请求共享一次续期。 */
export function refreshStandalone(): Promise<boolean> {
  // 仅同一轮登录可共享续期；切换平台重新登录后不等待上一身份尚未完成的请求。
  const version = sessionVersion
  if (refreshTask?.version === version) return refreshTask.promise
  const session = activeSession
  if (DIM3D_ADMIN_API || import.meta.env.VITE_AUTH_REFRESH_ENABLED !== 'true' || !session?.tokens.refresh_token ||
    (session.refreshExpiresAt !== undefined && session.refreshExpiresAt <= Date.now())) return Promise.resolve(false)
  const task = (async () => {
    try {
      const now = Date.now()
      const tokens = await call<StandaloneTokens>('/auth/refresh', { clientId: session.tokens.client_id, refreshToken: session.tokens.refresh_token, platformType: session.platformType })
      validateTokens(tokens)
      if (!tokens.refresh_token || !tokens.expire_in || !tokens.refresh_expire_in) throw new Error('续期响应不完整')
      // 退出或另一轮登录已替换会话时，丢弃迟到响应，禁止恢复已经退出的身份。
      if (activeSession !== session || version !== sessionVersion || tokens.client_id !== session.tokens.client_id) return false
      applySession({ ...session, tokens, expiresAt: now + tokens.expire_in * 1000, refreshExpiresAt: now + tokens.refresh_expire_in * 1000 })
      return true
    } catch { return false }
    finally { if (refreshTask?.version === version) refreshTask = null }
  })()
  refreshTask = { version, promise: task }
  return task
}

/** 判断请求是否属于本地登录会话，宿主交接身份不可借用独立模式续期。 */
export function hasStandaloneSession(): boolean { return activeSession !== null }
/** 请求发出时记录身份版本，旧身份迟到的失败不能注销新登录的平台。 */
export function getStandaloneSessionVersion(): number { return sessionVersion }
export function getStandaloneProfile(): StandaloneProfile | null { return activeSession?.profile ?? null }

/** 清理仅属于独立登录的状态，不删除其他项目或临时联调配置。 */
export function clearStandalone(): void {
  sessionVersion++
  activeSession = null
  authContext.clear()
  try {
    sessionStorage.removeItem(sessionKey)
    sessionStorage.removeItem(legacySessionKey)
  } catch { /* 清理存储失败不阻断内存退出。 */ }
}

/** 主动退出先撤销本地身份，远端注销失败也不能恢复已退出的会话。 */
export async function logoutStandalone(): Promise<void> {
  const tokens = activeSession?.tokens
  clearStandalone()
  if (tokens) await call<null>(DIM3D_ADMIN_API ? '/system/auth/logout' : '/auth/logout', {}, tokens)
}
