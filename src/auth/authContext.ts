import type { AuthContext, PlatformType } from './authTypes'

/**
 * 鉴权上下文的最小读写契约。
 *
 * 请求层只依赖该契约即可读取令牌、客户端编号和平台类型，不需要知道令牌来自 iframe
 * 消息还是未来的独立登录实现，从而避免认证方式与业务请求产生反向耦合。
 */
export interface AuthContextStore {
  get(): Readonly<AuthContext> | null
  set(context: AuthContext): Readonly<AuthContext>
  clear(): void
  hasValidContext(now?: number): boolean
  getAccessToken(): string | null
  getClientId(): string | null
  getPermissions(): readonly string[]
  getRoles(): readonly string[]
  getPlatformType(): PlatformType | null
}

/**
 * 只存在内存中的鉴权上下文。
 *
 * 该类刻意不依赖 Web Storage、路由或登录页。认证失效时 clear() 只清理内存，页面跳转
 * 由宿主项目负责；这样同一个认证核心可以在 iframe、测试和未来独立部署中复用。
 */
export class MemoryAuthContext implements AuthContextStore {
  private context: Readonly<AuthContext> | null = null

  get(): Readonly<AuthContext> | null {
    return this.context
  }

  set(context: AuthContext): Readonly<AuthContext> {
    // 租户随令牌跨页签传递，拒绝损坏身份，避免向后端提交隐式或不规范租户。
    if (context.tenantId !== undefined && !/^[1-9]\d{0,18}$/.test(context.tenantId)) throw new Error('登录租户编号无效')
    // 复制数组并冻结快照，防止调用方通过原始数组修改权限或角色，影响后续请求判断。
    const snapshot: AuthContext = {
      accessToken: context.accessToken,
      clientId: context.clientId,
      permissions: Object.freeze([...context.permissions]),
      roles: Object.freeze([...context.roles]),
      platformType: context.platformType,
      ...(context.tenantId === undefined ? {} : { tenantId: context.tenantId }),
      ...(context.expiresAt === undefined ? {} : { expiresAt: context.expiresAt }),
      ...(context.traceId === undefined ? {} : { traceId: context.traceId }),
    }
    this.context = Object.freeze(snapshot)
    return this.context
  }

  clear(): void {
    // 不向日志输出令牌或上下文内容，避免失效处理时把凭据泄露到控制台或埋点。
    this.context = null
  }

  hasValidContext(now = Date.now()): boolean {
    const context = this.context
    if (!context) return false
    if (context.expiresAt === undefined || context.expiresAt === 0) return true
    return context.expiresAt > now
  }

  getAccessToken(): string | null {
    return this.context?.accessToken ?? null
  }

  getClientId(): string | null {
    return this.context?.clientId ?? null
  }

  getPermissions(): readonly string[] {
    return this.context?.permissions ?? []
  }

  getRoles(): readonly string[] {
    return this.context?.roles ?? []
  }

  getPlatformType(): PlatformType | null {
    return this.context?.platformType ?? null
  }
}

/** 创建可替换的内存认证上下文实例。 */
export function createAuthContext(): MemoryAuthContext {
  return new MemoryAuthContext()
}

/** 与组合根共享的默认上下文；不在模块加载时读取任何浏览器存储。 */
export const authContext = createAuthContext()

