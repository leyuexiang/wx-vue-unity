/**
 * 当前系统支持的两类业务平台。
 *
 * 内嵌模式来自已校验的宿主消息；独立模式来自成功认证的运营或租户登录入口，不能
 * 通过域名、路由、角色或权限猜测。接口层据此选择 operation/tenant/web 路径段。
 */
export type PlatformType = 'tenant' | 'operation'

/** iframe 鉴权协议中的消息类型。 */
export type IframeAuthMessageType =
  | 'XR_CENTER_READY'
  | 'XR_CENTER_AUTH'
  | 'XR_CENTER_AUTH_EXPIRED'

/**
 * 已通过运行时校验的内存鉴权快照。
 *
 * 该类型不包含刷新令牌，也不自行提供持久化能力。内嵌认证提供者只在内存中保存快照，
 * 刷新后重新握手；独立场景页签由 tabAuthHandoff 管理会话副本，并保留实际过期时间。
 */
export interface AuthContext {
  /** 本项目后端登录时确认的租户，随令牌一起传给业务与资源API。 */
  readonly tenantId?: string
  readonly accessToken: string
  readonly clientId: string
  readonly permissions: readonly string[]
  readonly roles: readonly string[]
  readonly platformType: PlatformType
  /** Unix 毫秒时间戳；0 或缺省表示由宿主不提供过期时间。 */
  readonly expiresAt?: number
  readonly traceId?: string
}

/** 认证提供者生命周期状态。 */
export type AuthStatus = 'unauthenticated' | 'authenticating' | 'authenticated' | 'expired'

/** iframe 子应用发送给父页面的就绪消息。 */
export interface IframeReadyMessage {
  readonly type: 'XR_CENTER_READY'
  readonly requestId: string
  readonly version: string
  readonly platformTypes: readonly PlatformType[]
}

/** 父页面发送给 iframe 子应用的鉴权消息。 */
export interface IframeAuthPayload {
  readonly type: 'XR_CENTER_AUTH'
  readonly requestId: string
  readonly accessToken: string
  readonly clientId: string
  readonly permissions: readonly string[]
  readonly roles: readonly string[]
  readonly platformType: PlatformType
  readonly expiresAt?: number
  readonly traceId?: string
}

/** iframe 子应用通知父页面认证失效的消息。 */
export interface IframeAuthExpiredMessage {
  readonly type: 'XR_CENTER_AUTH_EXPIRED'
  readonly reason: string
}

/** 所有 iframe 鉴权消息的联合类型。 */
export type IframeAuthMessage =
  | IframeReadyMessage
  | IframeAuthPayload
  | IframeAuthExpiredMessage

/** 认证提供者对外暴露的最小稳定契约。 */
export interface AuthProvider {
  /** 完成首次认证握手；未获得有效 AUTH 前不会解析。 */
  initialize(): Promise<AuthContext>
  /** 清理上下文并重新发起一次握手，供宿主续签或重新登录后使用。 */
  renew(): Promise<AuthContext>
  /** 当前内存中的认证快照。 */
  getContext(): Readonly<AuthContext> | null
  /** 主动清理内存认证状态，不得触发页面跳转。 */
  clear(): void
  /** 处理请求层确认的 401，只通知父页面一次。 */
  notifyAuthExpired(reason?: string): boolean
  /** 释放消息监听器、计时器和未完成的握手。 */
  destroy(): void
}

/** 认证生命周期中可观测的状态变化。 */
export type AuthStatusListener = (status: AuthStatus, context: Readonly<AuthContext> | null) => void

/** iframe 认证提供者的配置。 */
export interface IframeAuthProviderOptions {
  /** 父页面的精确来源（协议、域名和端口），禁止使用通配符。 */
  readonly parentOrigin: string
  /**
   * 允许嵌入当前子应用的全部父页面来源。
   *
   * parentOrigin 保留用于兼容旧配置；配置多宿主时，握手消息会发送到每个来源，
   * 但只接受来自白名单来源且 source 为 window.parent 的认证响应。
   */
  readonly parentOrigins?: readonly string[]
  /** 协议版本，未指定时使用 1.0。 */
  readonly protocolVersion?: string
  /** 子应用声明支持的平台类型。 */
  readonly platformTypes?: readonly PlatformType[]
  /** READY 后等待 AUTH 的超时时间，默认 10 秒。 */
  readonly timeoutMs?: number
  /** 为测试或多宿主部署提供时间来源。 */
  readonly now?: () => number
  /** 为测试提供稳定 requestId；生产环境默认使用随机值。 */
  readonly requestIdFactory?: () => string
  /** 状态变化回调，不得在回调中保存访问令牌。 */
  readonly onStatusChange?: AuthStatusListener
  /** 测试或非浏览器宿主注入 window；浏览器中默认使用全局 window。 */
  readonly window?: Window
}

/** 认证协议错误，code 用于区分超时、来源伪造和消息格式错误。 */
export type AuthProviderErrorCode =
  | 'UNAVAILABLE'
  | 'TIMEOUT'
  | 'INVALID_ORIGIN'
  | 'INVALID_SOURCE'
  | 'INVALID_MESSAGE'
  | 'DESTROYED'

export class AuthProviderError extends Error {
  readonly code: AuthProviderErrorCode

  constructor(code: AuthProviderErrorCode, message: string) {
    super(message)
    this.name = 'AuthProviderError'
    this.code = code
  }
}
