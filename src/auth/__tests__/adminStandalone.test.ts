import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 覆盖148真实字段与租户身份传播，测试仅用假账号和假令牌。
const storage = new Map<string, string>()
const ok = (data: unknown) => new Response(JSON.stringify({ code: 200, data }))
const profile = { user: { id: '9007199254740993', nickname: '测试用户' }, permissions: ['dim3d:model:query'], roles: ['viewer'] }

beforeEach(() => {
  vi.resetModules()
  storage.clear()
  vi.stubEnv('VITE_DIM3D_API_MODE', 'admin')
  vi.stubEnv('VITE_DIM3D_SERVER_URL', 'https://service.invalid')
  vi.stubEnv('VITE_AUTH_OPERATION_TENANT_ID', '1')
  vi.stubEnv('VITE_AUTH_TENANT_ID', '2')
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  })
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe('本项目148认证', () => {
  it('登录、恢复、资源上下文和退出使用同一租户与令牌', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(ok({ accessToken: 'fake-access', expiresTime: Date.now() + 60000 }))
      .mockImplementation(async () => ok(profile))
    vi.stubGlobal('fetch', fetchMock)
    const auth = await import('../standalone')
    const { authContext } = await import('../authContext')
    await expect(auth.loginStandalone('viewer', 'fake-password', 'tenant')).resolves.toMatchObject({ user: { userId: profile.user.id } })
    expect(fetchMock.mock.calls[0]).toEqual(['https://service.invalid/admin-api/system/auth/login', expect.objectContaining({
      headers: expect.objectContaining({ 'tenant-id': '2' }), body: JSON.stringify({ username: 'viewer', password: 'fake-password' }),
    })])
    expect(authContext.get()).toMatchObject({ tenantId: '2', accessToken: 'fake-access', roles: ['viewer'] })
    await auth.restoreStandalone()
    expect(fetchMock).toHaveBeenLastCalledWith('https://service.invalid/admin-api/system/auth/get-permission-info', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer fake-access', 'tenant-id': '2' }),
    }))
    await auth.logoutStandalone()
    expect(fetchMock).toHaveBeenLastCalledWith('https://service.invalid/admin-api/system/auth/logout', expect.objectContaining({ headers: expect.objectContaining({ 'tenant-id': '2' }) }))
    expect(authContext.get()).toBeNull()
  })

  it('租户部署配置变化后拒绝恢复旧租户身份', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(ok({ accessToken: 'fake-access', expiresTime: Date.now() + 60000 })).mockImplementation(async () => ok(profile)))
    const auth = await import('../standalone')
    await auth.loginStandalone('viewer', 'fake-password', 'tenant')
    vi.stubEnv('VITE_AUTH_TENANT_ID', '3')
    expect(await auth.restoreStandalone()).toBeNull()
  })

  it('管理API保持统一路径且外部服务路径保持原样', async () => {
    const { resolvePlatformApiUrl } = await import('../platformApiPathResolver')
    expect(resolvePlatformApiUrl('https://service.invalid/admin-api/dim3d/model/page', 'tenant'))
      .toBe('https://service.invalid/admin-api/dim3d/model/page')
    expect(resolvePlatformApiUrl('https://other.invalid/admin-api/data', 'tenant'))
      .toBe('https://other.invalid/admin-api/data')
  })
})


describe('手机短信登录', () => {
  it('发送验证码使用后台登录场景和所选租户，不建立会话', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok(true))
    vi.stubGlobal('fetch', fetchMock)
    const auth = await import('../standalone')
    await auth.sendStandaloneSms('13800000000', 'tenant')
    expect(fetchMock).toHaveBeenCalledWith('https://service.invalid/admin-api/system/auth/send-sms-code', expect.objectContaining({
      headers: expect.objectContaining({ 'tenant-id': '2' }), body: JSON.stringify({ mobile: '13800000000', scene: 21 }),
    }))
    expect(storage.size).toBe(0)
  })
  it('验证码登录复用权限查询，账号登录仍使用原密码接口', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(ok({ accessToken: 'fake-access', expiresTime: Date.now() + 60000 }))
      .mockResolvedValueOnce(ok(profile))
    vi.stubGlobal('fetch', fetchMock)
    const auth = await import('../standalone')
    await auth.loginStandalone('13800000000', '123456', 'operation', 'mobile')
    expect(fetchMock.mock.calls[0]).toEqual(['https://service.invalid/admin-api/system/auth/sms-login', expect.objectContaining({
      headers: expect.objectContaining({ 'tenant-id': '1' }), body: JSON.stringify({ mobile: '13800000000', code: '123456' }),
    })])
    expect(fetchMock.mock.calls[1]?.[0]).toContain('/system/auth/get-permission-info')
  })
  it('无效手机号或验证码不发请求', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock)
    const auth = await import('../standalone')
    await expect(auth.sendStandaloneSms('invalid', 'tenant')).rejects.toThrow('有效手机号')
    await expect(auth.loginStandalone('13800000000', 'bad', 'tenant', 'mobile')).rejects.toThrow('验证码')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
