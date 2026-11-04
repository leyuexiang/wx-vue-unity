import type { AuthContext } from './authTypes'

const STORAGE_PREFIX = 'xr-center-tab-auth:'
const MAX_AGE_MS = 60_000
const REFRESH_MAX_AGE_MS = 30 * 60_000
/** 交接信封寿命与消息等待分开；无响应时按内嵌认证的10秒上限结束。 */
const HANDOFF_TIMEOUT_MS = 10_000
const TAB_READY = 'XR_CENTER_TAB_AUTH_READY'
const TAB_AUTH = 'XR_CENTER_TAB_AUTH'
/** 旧版本曾在该地址片段中携带完整鉴权上下文；当前版本仅负责识别并清除，不再解析。 */
const TAB_AUTH_FRAGMENT = 'xrAuth'
const REFRESH_CONTEXT_PREFIX = 'xr-center-refresh-auth:'
/** 每个浏览器源站只保存一份本地缓存；设备标识存在值内，不额外增加设备编号存储项。 */
const DEVICE_CACHE_KEY = 'xr-center-editor-auth:v1'
/** 会话存储天然按页签隔离，固定键只记录当前页签所属的交接编号。 */
const SESSION_CACHE_KEY = 'xr-center-editor-auth-session:v1'
const MAX_CONTEXTS = 64
interface AuthEnvelope { createdAt: number; context: AuthContext }
interface DeviceAuthCache {
  version: 1
  deviceId: string
  handoffs: Record<string, AuthEnvelope>
  refreshContexts: Record<string, AuthEnvelope>
}
const pendingContexts = new Map<string, AuthEnvelope>()
const migratedLocalStores = new WeakSet<Storage>()
let responderInstalled = false
const createId = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value))

/** 有界清理只保留仍有效的最近上下文，防止把旧的“键数量增长”转移到单个值内部。 */
function pruneContexts(value: unknown, maxAgeMs: number): Record<string, AuthEnvelope> {
  const valid: Array<[string, AuthEnvelope]> = []
  if (isRecord(value)) {
    for (const [id, candidate] of Object.entries(value)) {
      if (!/^[\w.-]+$/.test(id)) continue
      const envelope = parseAuthEnvelope(candidate, maxAgeMs)
      if (envelope) valid.push([id, envelope])
    }
  }
  // 相同毫秒产生的交接按插入顺序优先保留较新项，刚创建的信封不能被立即淘汰。
  if (valid.length > MAX_CONTEXTS) {
    valid.reverse().sort((first, second) => second[1].createdAt - first[1].createdAt)
    valid.length = MAX_CONTEXTS
    valid.reverse()
  }
  // 使用无原型字典，交接编号即使恰好与对象内置属性同名，也只能命中实际保存的信封。
  const contexts: Record<string, AuthEnvelope> = Object.create(null)
  for (const [id, envelope] of valid) contexts[id] = envelope
  return contexts
}

/**
 * 一次读取、修改并写回固定缓存，不在每个资源或请求中查询存储。
 * 首次访问顺带迁移旧随机键；先成功写入新缓存，再删除旧项，写入失败不会损坏旧版本数据。
 * 缓存只提供按交接编号查找的快照，绝不以设备标识或“最后一次登录”替代页签身份校验。
 */
function updateDeviceCache<T>(update: (cache: DeviceAuthCache) => T): T | null {
  try {
    const storage = localStorage
    const raw = storage.getItem(DEVICE_CACHE_KEY)
    let stored: unknown
    try { stored = raw ? JSON.parse(raw) : null } catch { stored = null }
    const saved = isRecord(stored) && stored.version === 1 &&
      typeof stored.deviceId === 'string' && /^[\w.-]{1,120}$/.test(stored.deviceId) ? stored : null
    const cache: DeviceAuthCache = {
      version: 1,
      deviceId: saved ? saved.deviceId as string : createId(),
      handoffs: pruneContexts(saved?.handoffs, MAX_AGE_MS),
      refreshContexts: pruneContexts(saved?.refreshContexts, REFRESH_MAX_AGE_MS),
    }
    const obsoleteKeys: string[] = []
    if (!migratedLocalStores.has(storage)) {
      // 先收集键再删除，避免删除导致存储下标移动而漏掉相邻的历史项。
      for (let index = 0; index < storage.length; index++) {
        const key = storage.key(index)
        if (!key) continue
        const handoff = key.startsWith(STORAGE_PREFIX)
        if (!handoff && !key.startsWith(REFRESH_CONTEXT_PREFIX)) continue
        obsoleteKeys.push(key)
        const id = key.slice(handoff ? STORAGE_PREFIX.length : REFRESH_CONTEXT_PREFIX.length)
        if (!/^[\w.-]+$/.test(id)) continue
        let old: unknown
        try { old = JSON.parse(storage.getItem(key) || 'null') } catch { continue }
        const envelope = parseAuthEnvelope(old, handoff ? MAX_AGE_MS : REFRESH_MAX_AGE_MS)
        const target = handoff ? cache.handoffs : cache.refreshContexts
        if (envelope && (!target[id] || target[id].createdAt < envelope.createdAt)) target[id] = envelope
      }
    }
    const result = update(cache)
    cache.handoffs = pruneContexts(cache.handoffs, MAX_AGE_MS)
    cache.refreshContexts = pruneContexts(cache.refreshContexts, REFRESH_MAX_AGE_MS)
    const serialized = JSON.stringify(cache)
    if (serialized !== raw) storage.setItem(DEVICE_CACHE_KEY, serialized)
    for (const key of obsoleteKeys) storage.removeItem(key)
    migratedLocalStores.add(storage)
    return result
  } catch {
    // 浏览器限制本地存储时不阻断会话副本及窗口消息通道，也不输出凭据。
    return null
  }
}

/**
 * 认证归属使用不会随场景锁轮换的交接编号，旧版本的锁编号只用于兼容读取。
 * 首次进入时尚未生成 clientKey，也能先保存认证；每次刷新不必复制或迁移多份令牌。
 */
function getRefreshKeys(): string[] {
  const params = new URLSearchParams(window.location.search)
  return [...new Set([params.get('authHandoff'), params.get('clientKey')])].filter(
    (key): key is string => Boolean(key && /^[\w.-]+$/.test(key)),
  )
}

/**
 * 两种存储都复用固定键：会话副本只属于当前页签，本地副本按交接编号索引并保留原有30分钟期限。
 * 只复用存储位置，不延长登录期限；不同页签和平台的凭据不能因使用固定键而相互覆盖。
 */
export function persistTabAuthRefreshContext(context: Readonly<AuthContext>): void {
  if (typeof window === 'undefined' || !context.accessToken) return
  const refreshKey = getRefreshKeys()[0]
  if (!refreshKey) return
  const envelope: AuthEnvelope = { createdAt: Date.now(), context }
  try {
    sessionStorage.setItem(SESSION_CACHE_KEY, JSON.stringify({ ...envelope, ownerId: refreshKey }))
    // 旧会话项属于当前页签，成功保存固定副本后即可全部回收，不影响其它页签的会话存储。
    const obsoleteKeys: string[] = []
    for (let index = 0; index < sessionStorage.length; index++) {
      const key = sessionStorage.key(index)
      if (key?.startsWith(REFRESH_CONTEXT_PREFIX)) obsoleteKeys.push(key)
    }
    for (const key of obsoleteKeys) sessionStorage.removeItem(key)
  } catch {
    // 会话存储失败后继续尝试本地存储，不影响当前已完成的认证。
  }
  updateDeviceCache(cache => {
    cache.refreshContexts[refreshKey] = envelope
    delete cache.handoffs[refreshKey]
  })
}

/**
 * 清除旧地址中可能残留的鉴权片段，但绝不再解析或采用其中的内容。
 *
 * 这样从旧管理页打开的新页签也会尽快移除地址栏中的敏感数据，同时阻断通过 URL 注入鉴权
 * 上下文的入口；若旧片段还包含其他非鉴权参数，则只删除 xrAuth 并保留其余片段参数。
 */
function discardLegacyTabAuthFragment(): void {
  const fragmentParams = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  if (!fragmentParams.has(TAB_AUTH_FRAGMENT)) return

  fragmentParams.delete(TAB_AUTH_FRAGMENT)
  const remainingFragment = fragmentParams.toString()
  window.history.replaceState(
    window.history.state,
    '',
    `${window.location.pathname}${window.location.search}${remainingFragment ? `#${remainingFragment}` : ''}`,
  )
}

/**
 * 将当前页签的内存鉴权快照一次性转交给新开的编辑器/预览页签。
 * 新页签不是 iframe，无法再次从父页面完成 postMessage 握手，因此使用短时、一次性
 * 的同源信封传递。交接编号仍逐次隔离，但所有信封共用固定本地缓存，消费后立即移除。
 */
export function createTabAuthHandoff(context: Readonly<AuthContext>): string | null {
  if (typeof window === 'undefined' || !context.accessToken) return null
  const randomId = createId()
  const envelope: AuthEnvelope = { createdAt: Date.now(), context }
  // 无额外计时器：创建或响应时清理过期内存快照，并限制上限，失联窗口不会无限占用内存。
  for (const [id, candidate] of pendingContexts) {
    if (!parseAuthEnvelope(candidate, MAX_AGE_MS)) pendingContexts.delete(id)
  }
  if (pendingContexts.size >= MAX_CONTEXTS) pendingContexts.delete(pendingContexts.keys().next().value!)
  const id = updateDeviceCache(cache => {
    cache.handoffs[randomId] = envelope
    return randomId
  })
  if (id) pendingContexts.set(id, envelope)
  return id
}

/** 在已创建的空白页签跳转前写入短时鉴权信封，兼容浏览器切断跨域 opener 的情况。 */
export function createTabAuthWindowName(context: Readonly<AuthContext>): string {
  return JSON.stringify({ type: TAB_AUTH, createdAt: Date.now(), context })
}

/**
 * 清理当前页签的鉴权交接缓存。
 *
 * 预览页只允许在首次进入时消费交接上下文；关闭页签或浏览器前必须移除未消费的
 * 信封、刷新快照和窗口名称，防止下次复用上一次访问权限。固定缓存只删除当前编号对应的
 * 内容，保留设备标识及其它页签上下文，不能为清理一个页面而清空整个设备缓存。
 */
export function clearTabAuthHandoffCache(): void {
  if (typeof window === 'undefined') return
  const params = new URLSearchParams(window.location.search)
  const handoffId = params.get('authHandoff')
  const refreshKeys = getRefreshKeys()
  updateDeviceCache(cache => {
    for (const id of refreshKeys) {
      delete cache.handoffs[id]
      delete cache.refreshContexts[id]
    }
  })
  try {
    const cached = JSON.parse(sessionStorage.getItem(SESSION_CACHE_KEY) || 'null') as { ownerId?: string } | null
    if (cached?.ownerId && refreshKeys.includes(cached.ownerId)) sessionStorage.removeItem(SESSION_CACHE_KEY)
  } catch {
    // 固定会话副本不可读时继续清理旧版本副本和窗口名称。
  }
  try {
    if (handoffId && /^[\w.-]+$/.test(handoffId)) {
      localStorage.removeItem(`${STORAGE_PREFIX}${handoffId}`)
      pendingContexts.delete(handoffId)
    }
  } catch {
    // 交接存储受限不妨碍继续清理会话缓存。
  }
  // 同时清理稳定编号和旧版本的锁编号缓存；其中一种存储失败不能阻断另一种。
  for (const refreshKey of refreshKeys) {
    const key = `${REFRESH_CONTEXT_PREFIX}${refreshKey}`
    try {
      sessionStorage.removeItem(key)
    } catch {
      // 存储受限时继续清理本地副本。
    }
    try {
      localStorage.removeItem(key)
    } catch {
      // 不阻塞关闭；页面内存与窗口名称仍会清理。
    }
  }
  window.name = ''
}

/** 管理页响应跨域编辑器页签的鉴权请求；仅保留短时内存快照。 */
export function installTabAuthResponder(): void {
  if (responderInstalled || typeof window === 'undefined') return
  responderInstalled = true
  window.addEventListener('message', (event) => {
    if (event.data?.type !== TAB_READY || typeof event.data?.handoffId !== 'string') return
    if (!getConfiguredParentOrigins().includes(event.origin)) return
    const candidate = pendingContexts.get(event.data.handoffId)
    const context = parseAuthEnvelope(candidate, MAX_AGE_MS)?.context
    if (!event.source || typeof (event.source as Window).postMessage !== 'function') return
    pendingContexts.delete(event.data.handoffId)
    try {
      // 已消费或不存在的编号明确返回空响应，让旧编辑页立即结束等待，不能复用旧授权。
      ;(event.source as Window).postMessage(
        { type: TAB_AUTH, handoffId: event.data.handoffId, context: context ?? null },
        event.origin,
      )
    } catch {
      // 编辑页关闭或跨来源导航后可能无法接收，不向控制台输出凭据。
    }
  })
}

/** 读取宿主来源白名单，供跨域页签握手使用；localhost 与局域网 IP 必须同时列入。 */
function getConfiguredParentOrigins(): string[] {
  const values = [
    // 管理页通常与编辑页同源，但外层宿主白名单不包含三维应用自身的端口。
    window.location.origin,
    String(import.meta.env.VITE_OPERATION_ORIGINS || ''),
    String(import.meta.env.VITE_OPERATION_ORIGIN || ''),
  ]
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean)
  const origins = new Set<string>()
  for (const value of values) {
    try {
      const url = new URL(value)
      if (/^https?:$/.test(url.protocol)) origins.add(url.origin)
    } catch {
      // 忽略错误配置；不使用通配来源，也不因一个配置项阻断整个等待流程。
    }
  }
  return [...origins]
}

/** 跨域新页签向 opener 请求一次性鉴权快照。 */
export function requestTabAuthHandoff(handoffId: string): Promise<AuthContext | null> {
  if (
    typeof window === 'undefined' ||
    !window.opener ||
    window.opener === window ||
    window.opener.closed
  ) {
    return Promise.resolve(null)
  }
  const parentOrigins = getConfiguredParentOrigins()
  const opener = window.opener
  if (parentOrigins.length === 0) return Promise.resolve(null)
  return new Promise((resolve) => {
    let settled = false
    const finish = (context: AuthContext | null) => {
      if (settled) return
      settled = true
      window.removeEventListener('message', handleMessage)
      clearTimeout(timer)
      resolve(context)
    }
    const handleMessage = (event: MessageEvent) => {
      if (!parentOrigins.includes(event.origin) || event.source !== opener) return
      if (event.data?.type !== TAB_AUTH || event.data?.handoffId !== handoffId) return
      finish(event.data.context ?? null)
    }
    const timer = setTimeout(() => finish(null), HANDOFF_TIMEOUT_MS)
    window.addEventListener('message', handleMessage)
    // 实际 opener 可能是 localhost 或局域网 IP，向每个受信来源各发一次，避免只命中旧单来源变量。
    try {
      for (const parentOrigin of parentOrigins) {
        opener.postMessage({ type: TAB_READY, handoffId }, parentOrigin)
      }
    } catch {
      // 发送异常也必须走统一收口，不能留下悬空监听器或让启动页面一直显示加载。
      finish(null)
    }
  })
}

/**
 * 统一校验存储信封；缓存期限与凭据期限分开，恢复缓存不能延长凭据的真实有效期。
 * 同页签会话副本随页签结束而消失，因此只按 expiresAt 判断；跨页签副本仍限制保留时间。
 */
function parseAuthEnvelope(value: unknown, maxAgeMs: number): AuthEnvelope | null {
  if (!isRecord(value)) return null
  const envelope = value as { createdAt?: number; context?: AuthContext }
  const now = Date.now()
  if (typeof envelope.createdAt !== 'number' || !Number.isFinite(envelope.createdAt)) return null
  const age = now - envelope.createdAt
  if (age < 0 || age > maxAgeMs) return null
  const context = envelope.context
  // 老宿主可以不提供租户，已提供的身份归属必须在页签交接时保持有效。
  if (context?.tenantId !== undefined && (typeof context.tenantId !== 'string' || !/^[1-9]\d{0,18}$/.test(context.tenantId))) return null
  if (
    !context ||
    typeof context.accessToken !== 'string' ||
    !context.accessToken.trim() ||
    typeof context.clientId !== 'string' ||
    !context.clientId.trim() ||
    !Array.isArray(context.permissions) ||
    !Array.isArray(context.roles) ||
    context.permissions.some((permission) => typeof permission !== 'string') ||
    context.roles.some((role) => typeof role !== 'string') ||
    (context.platformType !== 'operation' && context.platformType !== 'tenant')
  )
    return null
  if (
    context.expiresAt !== undefined &&
    (!Number.isFinite(context.expiresAt) || (context.expiresAt !== 0 && context.expiresAt <= now))
  )
    return null
  return { createdAt: envelope.createdAt, context }
}

/** 存量独立信封与固定缓存共用相同校验，迁移不会放宽令牌格式或有效期。 */
function readAuthEnvelope(raw: string | null, maxAgeMs: number): AuthContext | null {
  if (!raw) return null
  try {
    return parseAuthEnvelope(JSON.parse(raw), maxAgeMs)?.context ?? null
  } catch {
    // 损坏的 JSON 或缺失字段只能使本通道失效，不能阻断其他安全通道。
    return null
  }
}

/** 读取指定存储的一份缓存，删除失效副本；访问异常时允许调用方继续尝试另一种存储。 */
function readRefreshContext(storage: Storage, key: string, maxAgeMs: number): AuthContext | null {
  const raw = storage.getItem(key)
  const context = readAuthEnvelope(raw, maxAgeMs)
  if (raw && !context) storage.removeItem(key)
  return context
}

/**
 * 优先恢复当前页签的固定会话副本，再消费窗口名称和设备缓存中匹配当前编号的快照。
 * 不以最后写入的账号作为兜底；每条恢复路径都保留原有期限，且统一回收已消费的交接信封。
 */
export function consumeTabAuthHandoff(): AuthContext | null {
  if (typeof window === 'undefined') return null
  discardLegacyTabAuthFragment()
  const refreshKeys = getRefreshKeys()
  let restored: AuthContext | null = null
  try {
    const raw = sessionStorage.getItem(SESSION_CACHE_KEY)
    const cached: unknown = raw ? JSON.parse(raw) : null
    if (isRecord(cached) && typeof cached.ownerId === 'string' && refreshKeys.includes(cached.ownerId)) {
      restored = parseAuthEnvelope(cached, Infinity)?.context ?? null
      if (!restored) sessionStorage.removeItem(SESSION_CACHE_KEY)
    }
  } catch {
    // 会话存储不可读时继续尝试窗口信封和本地存储。
  }
  // 兼容已经打开的旧页签；成功认证后的持久化会将它们合并为固定会话项。
  if (!restored) for (const refreshKey of refreshKeys) {
    try { restored = readRefreshContext(sessionStorage, `${REFRESH_CONTEXT_PREFIX}${refreshKey}`, Infinity) }
    catch { /* 存量副本不可用时继续尝试其它通道。 */ }
    if (restored) break
  }
  try {
    const envelope = JSON.parse(window.name || '') as { type?: string }
    if (envelope.type === TAB_AUTH) {
      if (!restored) restored = readAuthEnvelope(window.name, MAX_AGE_MS)
      // 交接完成即清空，不再让带凭据的窗口名称在刷新或后续导航中长期保留。
      window.name = ''
    }
  } catch {
    // 非鉴权窗口名称不参与认证。
  }
  const id = new URLSearchParams(window.location.search).get('authHandoff')
  const localContext = updateDeviceCache(cache => {
    let context = restored
    if (id && /^[\w.-]+$/.test(id)) {
      if (!context) context = cache.handoffs[id]?.context ?? null
      // 即使实际通过窗口名称或会话缓存恢复，也必须消费本地信封，否则每次访问都会留一份。
      delete cache.handoffs[id]
    }
    if (!context) for (const refreshKey of refreshKeys) {
      context = cache.refreshContexts[refreshKey]?.context ?? null
      if (context) break
    }
    return context
  })
  return restored ?? localContext
}
