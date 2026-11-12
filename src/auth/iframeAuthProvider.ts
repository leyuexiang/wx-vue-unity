import {
  AuthProviderError,
  type AuthContext,
  type AuthProvider,
  type IframeAuthPayload,
  type IframeAuthProviderOptions,
  type IframeReadyMessage,
  type PlatformType,
} from './authTypes'
import { MemoryAuthContext, type AuthContextStore } from './authContext'
import { parseManagementMenus } from './iotNavigation'

const DEFAULT_PROTOCOL_VERSION = '1.0'
const DEFAULT_TIMEOUT_MS = 10_000
const SUPPORTED_PLATFORM_TYPES: readonly PlatformType[] = ['tenant', 'operation']
const AUTH_EXPIRED_REASON = 'access_token_expired'

type PendingHandshake = {
  readonly requestId: string
  readonly promise: Promise<AuthContext>
  readonly resolve: (context: AuthContext) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

/** 去重并冻结字符串数组，确保权限和角色不会被外部对象后续修改。 */
function normalizeStringList(value: unknown, fieldName: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    throw new AuthProviderError('INVALID_MESSAGE', `${fieldName} 必须是非空字符串数组`)
  }
  return Object.freeze([...new Set(value)])
}

/**
 * 将来源规范化为 origin（协议、主机和端口），拒绝通配符和带路径的配置。
 * postMessage 的 targetOrigin 不能使用“*”，否则认证失效消息可能被错误窗口接收。
 */
function normalizeOrigin(value: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.trim() === '*') {
    throw new AuthProviderError('INVALID_ORIGIN', '父页面来源必须是精确 origin，不能使用通配符')
  }
  try {
    const parsed = new URL(value)
    if (!/^https?:$/.test(parsed.protocol) || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new Error('origin must not contain a path, query or hash')
    }
    return parsed.origin
  } catch {
    throw new AuthProviderError('INVALID_ORIGIN', '父页面来源格式无效')
  }
}

function defaultRequestIdFactory(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * iframe 鉴权提供者。
 *
 * 它只负责父子窗口握手和内存上下文，不负责登录页跳转、刷新令牌或持久化令牌。
 * 当请求层确认 401 时，调用 notifyAuthExpired() 通知父页面，由父页面自行处理登录。
 */
export class IframeAuthProvider implements AuthProvider {
  private readonly parentOrigins: readonly string[]
  private readonly protocolVersion: string
  private readonly platformTypes: readonly PlatformType[]
  private readonly timeoutMs: number
  private readonly now: () => number
  private readonly requestIdFactory: () => string
  private readonly onStatusChange?: IframeAuthProviderOptions['onStatusChange']
  private readonly contextStore: AuthContextStore
  private readonly hostWindow: Window | null
  private pendingHandshake: PendingHandshake | null = null
  private listening = false
  private destroyed = false
  private authExpiredNotified = false
  /** 记录实际完成本轮握手的父页面来源，避免失效通知发给错误宿主。 */
  private authenticatedParentOrigin: string | null = null
  private status: 'unauthenticated' | 'authenticating' | 'authenticated' | 'expired' =
    'unauthenticated'

  private readonly handleMessage = (event: MessageEvent<unknown>): void => {
    const pending = this.pendingHandshake
    if (!pending || this.destroyed) return

    // 来源和 source 必须同时匹配，不能只依赖 origin；否则同源的其他窗口也可能伪造 AUTH。
    if (!this.parentOrigins.includes(event.origin)) return
    if (!this.hostWindow || event.source !== this.hostWindow.parent) return

    const data = event.data
    if (!isRecord(data) || data.type !== 'XR_CENTER_AUTH') return

    // 认证响应必须关联最近一次 READY，旧页面或旧请求的响应不得覆盖当前上下文。
    if (data.requestId !== pending.requestId) return

    try {
      const context = this.parseAuthMessage(data)
      this.completeHandshake(context, event.origin)
    } catch (error) {
      this.failHandshake(
        error instanceof AuthProviderError
          ? error
          : new AuthProviderError('INVALID_MESSAGE', 'XR_CENTER_AUTH 消息格式无效'),
      )
    }
  }

  constructor(options: IframeAuthProviderOptions, contextStore: AuthContextStore = new MemoryAuthContext()) {
    this.parentOrigins = Object.freeze(
      [...new Set([options.parentOrigin, ...(options.parentOrigins ?? [])].map(normalizeOrigin))],
    )
    this.protocolVersion = options.protocolVersion ?? DEFAULT_PROTOCOL_VERSION
    this.platformTypes = Object.freeze(
      [...new Set(options.platformTypes ?? SUPPORTED_PLATFORM_TYPES)].filter((platformType) =>
        SUPPORTED_PLATFORM_TYPES.includes(platformType),
      ),
    )
    if (this.platformTypes.length === 0) {
      throw new AuthProviderError('INVALID_MESSAGE', '至少需要声明一个受支持的平台类型')
    }
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new AuthProviderError('INVALID_MESSAGE', '鉴权超时时间必须是正数')
    }
    this.now = options.now ?? (() => Date.now())
    this.requestIdFactory = options.requestIdFactory ?? defaultRequestIdFactory
    this.onStatusChange = options.onStatusChange
    this.contextStore = contextStore
    this.hostWindow = options.window ?? (typeof window === 'undefined' ? null : window)
  }

  /** 启动监听并向父页面发送一次 READY；未收到合法 AUTH 前 Promise 不会完成。 */
  initialize(): Promise<AuthContext> {
    if (this.destroyed) {
      return Promise.reject(new AuthProviderError('DESTROYED', '认证提供者已销毁'))
    }

    const current = this.contextStore.get()
    if (current && this.status === 'authenticated' && this.contextStore.hasValidContext(this.now())) {
      return Promise.resolve(current as AuthContext)
    }
    if (this.pendingHandshake) return this.pendingHandshake.promise
    if (!this.hostWindow || !this.hostWindow.parent) {
      return Promise.reject(new AuthProviderError('UNAVAILABLE', '当前运行环境没有父页面'))
    }
    if (this.hostWindow.parent === this.hostWindow) {
      return Promise.reject(new AuthProviderError('UNAVAILABLE', '独立打开时不能使用 iframe 鉴权'))
    }

    this.installListener()
    this.contextStore.clear()
    this.authenticatedParentOrigin = null
    this.authExpiredNotified = false
    this.setStatus('authenticating')

    const requestId = this.requestIdFactory()
    if (typeof requestId !== 'string' || requestId.trim() === '') {
      this.setStatus('unauthenticated')
      return Promise.reject(new AuthProviderError('INVALID_MESSAGE', 'requestId 必须是非空字符串'))
    }

    let resolvePromise!: (context: AuthContext) => void
    let rejectPromise!: (error: Error) => void
    const promise = new Promise<AuthContext>((resolve, reject) => {
      resolvePromise = resolve
      rejectPromise = reject
    })
    const timer = setTimeout(() => {
      if (this.pendingHandshake?.requestId !== requestId) return
      this.failHandshake(new AuthProviderError('TIMEOUT', '等待父页面 XR_CENTER_AUTH 超时'))
    }, this.timeoutMs)

    this.pendingHandshake = {
      requestId,
      promise,
      resolve: resolvePromise,
      reject: rejectPromise,
      timer,
    }

    const readyMessage: IframeReadyMessage = {
      type: 'XR_CENTER_READY',
      requestId,
      version: this.protocolVersion,
      platformTypes: this.platformTypes,
    }
    try {
      // 多宿主部署时无法提前知道实际父页面来源，因此向每个受信来源发送 READY；
      // 后续 AUTH 仍会校验 event.origin 与 event.source，未知来源不会被接受。
      for (const parentOrigin of this.parentOrigins) {
        this.hostWindow.parent.postMessage(readyMessage, parentOrigin)
      }
    } catch (error) {
      this.failHandshake(
        new AuthProviderError('UNAVAILABLE', error instanceof Error ? error.message : '发送 READY 失败'),
      )
    }
    return promise
  }

  /** 清理旧上下文后重新握手；用于父页面完成登录或续签后再次注入令牌。 */
  renew(): Promise<AuthContext> {
    this.cancelPending(new AuthProviderError('DESTROYED', '重新鉴权已取消上一轮握手'))
    this.contextStore.clear()
    this.status = 'unauthenticated'
    this.authExpiredNotified = false
    return this.initialize()
  }

  getContext(): Readonly<AuthContext> | null {
    const context = this.contextStore.get()
    if (!context || !this.contextStore.hasValidContext(this.now())) return null
    return context
  }

  /** 只清除内存状态，不触发 window.location 或任何登录跳转。 */
  clear(): void {
    this.contextStore.clear()
    this.authExpiredNotified = false
    this.setStatus('unauthenticated')
  }

  /**
   * 通知父页面认证已失效。
   *
   * 同一轮失效只允许发送一次，避免并发请求的多个 401 触发父页面多次跳转；返回值表示
   * 本次是否真正发送了通知，便于请求层只对首次失效执行额外处理。
   */
  notifyAuthExpired(reason = AUTH_EXPIRED_REASON): boolean {
    if (this.destroyed || this.authExpiredNotified) return false
    this.authExpiredNotified = true
    this.contextStore.clear()
    this.setStatus('expired')

    const message = {
      type: 'XR_CENTER_AUTH_EXPIRED' as const,
      reason: typeof reason === 'string' && reason.trim() ? reason : AUTH_EXPIRED_REASON,
    }
    if (!this.hostWindow || this.hostWindow.parent === this.hostWindow) return false
    const targetOrigin = this.authenticatedParentOrigin ?? this.parentOrigins[0]
    try {
      this.hostWindow.parent.postMessage(message, targetOrigin)
      return true
    } catch {
      // 即使宿主窗口已关闭，也必须保持失效门闩，避免下一个 401 继续尝试跳转。
      return false
    }
  }

  /** 释放监听器、定时器和未完成握手；不触发页面跳转。 */
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.removeListener()
    this.cancelPending(new AuthProviderError('DESTROYED', '认证提供者已销毁'))
    this.contextStore.clear()
    this.setStatus('unauthenticated')
  }

  private installListener(): void {
    if (this.listening || !this.hostWindow) return
    this.hostWindow.addEventListener('message', this.handleMessage as EventListener)
    this.listening = true
  }

  private removeListener(): void {
    if (!this.listening || !this.hostWindow) return
    this.hostWindow.removeEventListener('message', this.handleMessage as EventListener)
    this.listening = false
  }

  private setStatus(status: typeof this.status): void {
    this.status = status
    this.onStatusChange?.(status, this.contextStore.get())
  }

  private parseAuthMessage(data: Record<string, unknown>): AuthContext {
    if (typeof data.requestId !== 'string' || data.requestId.trim() === '') {
      throw new AuthProviderError('INVALID_MESSAGE', 'XR_CENTER_AUTH.requestId 无效')
    }
    if (typeof data.accessToken !== 'string' || data.accessToken.trim() === '') {
      throw new AuthProviderError('INVALID_MESSAGE', 'XR_CENTER_AUTH.accessToken 无效')
    }
    if (typeof data.clientId !== 'string' || data.clientId.trim() === '') {
      throw new AuthProviderError('INVALID_MESSAGE', 'XR_CENTER_AUTH.clientId 无效')
    }
    if (data.platformType !== 'tenant' && data.platformType !== 'operation') {
      throw new AuthProviderError('INVALID_MESSAGE', 'XR_CENTER_AUTH.platformType 无效')
    }
    if (!this.platformTypes.includes(data.platformType)) {
      throw new AuthProviderError('INVALID_MESSAGE', '父页面返回了子应用未声明的平台类型')
    }

    const permissions = normalizeStringList(data.permissions, 'permissions')
    const roles = normalizeStringList(data.roles, 'roles')
    let expiresAt: number | undefined
    if (data.expiresAt !== undefined) {
      if (typeof data.expiresAt !== 'number' || !Number.isFinite(data.expiresAt) || data.expiresAt < 0) {
        throw new AuthProviderError('INVALID_MESSAGE', 'expiresAt 必须是非负时间戳')
      }
      // 0 是协议中表示“宿主未提供过期时间”的保留值；其余过期时间必须晚于当前时间。
      if (data.expiresAt !== 0 && data.expiresAt <= this.now()) {
        throw new AuthProviderError('INVALID_MESSAGE', 'accessToken 已过期')
      }
      expiresAt = data.expiresAt
    }
    let traceId: string | undefined
    if (data.traceId !== undefined) {
      if (typeof data.traceId !== 'string' || data.traceId.trim() === '') {
        throw new AuthProviderError('INVALID_MESSAGE', 'traceId 无效')
      }
      traceId = data.traceId
    }

    return {
      accessToken: data.accessToken,
      clientId: data.clientId,
      permissions,
      roles,
      platformType: data.platformType,
      ...(data.menus === undefined ? {} : { menus: parseManagementMenus(data.menus) }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(traceId === undefined ? {} : { traceId }),
    }
  }

  private completeHandshake(context: AuthContext, parentOrigin: string): void {
    const pending = this.pendingHandshake
    if (!pending) return
    clearTimeout(pending.timer)
    this.pendingHandshake = null
    const snapshot = this.contextStore.set(context) as AuthContext
    this.authenticatedParentOrigin = parentOrigin
    this.authExpiredNotified = false
    this.setStatus('authenticated')
    pending.resolve(snapshot)
  }

  private failHandshake(error: Error): void {
    const pending = this.pendingHandshake
    if (!pending) return
    clearTimeout(pending.timer)
    this.pendingHandshake = null
    this.contextStore.clear()
    this.setStatus('unauthenticated')
    pending.reject(error)
  }

  private cancelPending(error: Error): void {
    const pending = this.pendingHandshake
    if (!pending) return
    clearTimeout(pending.timer)
    this.pendingHandshake = null
    pending.reject(error)
  }
}

/** 便于组合根按函数式风格创建提供者。 */
export function createIframeAuthProvider(
  options: IframeAuthProviderOptions,
  contextStore?: AuthContextStore,
): IframeAuthProvider {
  return new IframeAuthProvider(options, contextStore)
}
