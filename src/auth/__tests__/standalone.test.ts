import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** 隔离存储与网络，不读取开发者会话，不向真实业务服务器提交账号。 */
const storage = new Map<string, string>()
const profile = { user: { userId: '9007199254740993', nickName: '鉴权测试' }, roles: ['editor'], permissions: ['scene:read'] }
const tokens = { access_token: 'fake-access', client_id: 'fake-client', expire_in: 60, refresh_token: 'fake-refresh', refresh_expire_in: 120 }
const ok = (data: unknown) => new Response(JSON.stringify({ code: 200, msg: '成功', data }))
const fail = (status = 401) => new Response(JSON.stringify({ code: status, msg: '认证失败' }), { status })
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.resetModules()
  storage.clear()
  vi.stubEnv('VITE_DIM3D_SERVER_URL', 'https://reference.invalid:30080/')
  vi.stubEnv('VITE_AUTH_CLIENT_ID', 'configured-client')
  vi.stubEnv('VITE_AUTH_OPERATION_CLIENT_ID', '')
  vi.stubEnv('VITE_AUTH_TENANT_CLIENT_ID', 'tenant-client')
  vi.stubEnv('VITE_AUTH_REFRESH_ENABLED', 'false')
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  })
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe('独立鉴权现代业务协议', () => {
  it('参考资料响应保留授权菜单，缺失菜单不按角色合成入口', async () => {
    const auth = await import('../standalone')
    const { authContext } = await import('../authContext')
    fetchMock.mockResolvedValueOnce(ok(tokens)).mockResolvedValueOnce(ok({
      ...profile, menus: [{ id: '1', name: '后台资源', children: [{ id: '2', name: '模型', component: 'resourceManage/modelManage/index' }] }],
    }))
    await auth.loginStandalone('13800000000', 'fake')
    expect(authContext.get()?.menus?.[0]?.name).toBe('后台资源')
    auth.clearStandalone()
    fetchMock.mockResolvedValueOnce(ok(tokens)).mockResolvedValueOnce(ok(profile))
    await auth.loginStandalone('13800000000', 'fake')
    expect(authContext.get()?.menus).toBeUndefined()
  })
  it('兼容租户真实资料仅返回 userName，保留真实权限和空角色，刷新后仍可恢复', async () => {
    const auth = await import('../standalone')
    const { authContext } = await import('../authContext')
    // 复现参考租户接口实际字段，用假编号和名称替代用户资料，不保存真实凭据。
    const tenantProfile = { user: { userId: '100001', tenantId: '100', userName: '租户测试用户', avatar: null }, permissions: ['scene:read'], roles: [] }
    fetchMock.mockResolvedValueOnce(ok({ ...tokens, refresh_token: null, refresh_expire_in: null })).mockResolvedValueOnce(ok(tenantProfile))
    await expect(auth.loginStandalone('13800000000', 'fake', 'tenant')).resolves.toMatchObject({ user: { userId: '100001', nickName: '租户测试用户' }, permissions: ['scene:read'], roles: [] })
    expect(authContext.get()).toMatchObject({ platformType: 'tenant', permissions: ['scene:read'], roles: [] })
    expect(auth.getStandaloneProfile()?.user.avatar).toBeUndefined()
    vi.resetModules()
    const restoredAuth = await import('../standalone')
    fetchMock.mockResolvedValueOnce(ok(tenantProfile))
    await expect(restoredAuth.restoreStandalone()).resolves.toMatchObject({ user: { nickName: '租户测试用户' } })
  })

  it('租户返回昵称时优先使用昵称，不因显示名称兼容放宽身份校验', async () => {
    const auth = await import('../standalone')
    fetchMock.mockResolvedValueOnce(ok(tokens)).mockResolvedValueOnce(ok({ ...profile, user: { ...profile.user, userName: '租户账号名' } }))
    await expect(auth.loginStandalone('13800000000', 'fake', 'tenant')).resolves.toMatchObject({ user: { nickName: profile.user.nickName } })
    auth.clearStandalone()
    fetchMock.mockResolvedValueOnce(ok(tokens)).mockResolvedValueOnce(ok({ user: { userName: '只有名称没有身份' }, permissions: [], roles: [] }))
    await expect(auth.loginStandalone('13800000000', 'fake', 'tenant')).rejects.toThrow('用户权限响应格式错误')
    expect(auth.hasStandaloneSession()).toBe(false)
  })

  it('运营资料仍要求原有昵称字段，不把租户名称适配扩散到运营协议', async () => {
    const auth = await import('../standalone')
    fetchMock.mockResolvedValueOnce(ok(tokens)).mockResolvedValueOnce(ok({ user: { userId: '100001', userName: '运营账号' }, permissions: [], roles: [] }))
    await expect(auth.loginStandalone('13800000000', 'fake', 'operation')).rejects.toThrow('用户权限响应格式错误')
  })

  it.each(['operation', 'tenant'] as const)('参考%s登录的刷新字段为 null 时仍建立有效访问会话', async platformType => {
    vi.stubEnv('VITE_AUTH_REFRESH_ENABLED', 'true')
    const auth = await import('../standalone')
    const { authContext } = await import('../authContext')
    // 按真实响应保留访问有效期，仅用假令牌复现空刷新字段，不记录实际用户凭据。
    fetchMock.mockResolvedValueOnce(ok({ ...tokens, expire_in: 604800, refresh_token: null, refresh_expire_in: null }))
      .mockResolvedValueOnce(ok(profile))
    const before = Date.now()
    await expect(auth.loginStandalone('13800000000', 'fake', platformType)).resolves.toEqual(profile)
    expect(authContext.get()).toMatchObject({ accessToken: tokens.access_token, platformType })
    expect(authContext.get()?.expiresAt).toBeGreaterThanOrEqual(before + 604800 * 1000)
    expect(authContext.hasValidContext()).toBe(true)
    expect(await auth.refreshStandalone()).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // 刷新页面同样能恢复；不会把空刷新期限转换成零而立即判定失效。
    fetchMock.mockResolvedValueOnce(ok(profile))
    await expect(auth.restoreStandalone()).resolves.toEqual(profile)
    expect(authContext.hasValidContext()).toBe(true)
  })

  it('参考访问有效期为 null 时不虚构期限，以后端身份校验为准', async () => {
    const auth = await import('../standalone')
    const { authContext } = await import('../authContext')
    fetchMock.mockResolvedValueOnce(ok({ ...tokens, expire_in: null, refresh_token: null, refresh_expire_in: null }))
      .mockResolvedValueOnce(ok(profile))
    await auth.loginStandalone('13800000000', 'fake')
    expect(authContext.get()?.expiresAt).toBeUndefined()
    expect(authContext.hasValidContext()).toBe(true)
  })

  it.each([0, -1, '604800', '', false])('仍拒绝实际非法的访问有效期 %s', async expire_in => {
    const auth = await import('../standalone')
    fetchMock.mockResolvedValueOnce(ok({ ...tokens, expire_in }))
    await expect(auth.loginStandalone('13800000000', 'fake')).rejects.toThrow('登录有效期格式错误')
    expect(auth.hasStandaloneSession()).toBe(false)
  })

  it('租户入口使用租户应用和资料接口，并沿用现有租户内容权限', async () => {
    const auth = await import('../standalone')
    const { authContext } = await import('../authContext')
    const { getCurrentManagementCapabilities, resolveResourceCardCapabilities } = await import('../capabilities')
    fetchMock.mockResolvedValueOnce(ok(tokens)).mockResolvedValueOnce(ok(profile))
    await auth.loginStandalone('13800000000', 'fake', 'tenant')
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://reference.invalid:30080/api/auth/tenant/login')
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body).clientId).toBe('tenant-client')
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://reference.invalid:30080/api/tenant/profile/getInfo')
    expect(authContext.get()?.platformType).toBe('tenant')
    const capabilities = getCurrentManagementCapabilities()
    expect(capabilities.template.canAccess).toBe(false)
    expect(capabilities.scene.canAuthorize).toBe(false)
    expect(capabilities.editor.saveAsTemplate).toBe(false)
    expect(capabilities.scene.publish.accessModes.map(item => item.value)).toEqual(['PERSONAL', 'PUBLIC_ENCRYPT', 'ENTERPRISE', 'PUBLIC_SHARE'])
    expect(resolveResourceCardCapabilities(capabilities, 'SYSTEM').canEdit).toBe(false)
    expect(resolveResourceCardCapabilities(capabilities, 'MINE')).toMatchObject({ canEdit: true, canDelete: true, canToggleStatus: false })
  })

  it('运营入口优先使用运营专用应用，保持运营页面能力', async () => {
    vi.stubEnv('VITE_AUTH_OPERATION_CLIENT_ID', 'operation-client')
    const auth = await import('../standalone')
    const { getCurrentManagementCapabilities } = await import('../capabilities')
    fetchMock.mockResolvedValueOnce(ok(tokens)).mockResolvedValueOnce(ok(profile))
    await auth.loginStandalone('13800000000', 'fake', 'operation')
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body).clientId).toBe('operation-client')
    expect(getCurrentManagementCapabilities()).toMatchObject({ template: { canAccess: true }, scene: { canAuthorize: true }, editor: { saveAsTemplate: true } })
  })

  it('租户应用缺失时明确失败，不回退到运营应用或游客变量', async () => {
    vi.stubEnv('VITE_AUTH_TENANT_CLIENT_ID', '')
    vi.stubEnv('VITE_PUBLIC_PREVIEW_GUEST_CLIENT_ID', 'guest-only')
    const auth = await import('../standalone')
    await expect(auth.loginStandalone('13800000000', 'fake', 'tenant')).rejects.toThrow('租户端登录应用编号')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('刷新页面仍恢复租户平台，恢复和续期不切回运营端', async () => {
    vi.stubEnv('VITE_AUTH_REFRESH_ENABLED', 'true')
    let auth = await import('../standalone')
    fetchMock.mockResolvedValueOnce(ok(tokens)).mockResolvedValueOnce(ok(profile))
    await auth.loginStandalone('13800000000', 'fake', 'tenant')
    vi.resetModules()
    auth = await import('../standalone')
    fetchMock.mockResolvedValueOnce(ok(profile))
    await auth.restoreStandalone()
    expect(fetchMock.mock.calls[2]?.[0]).toBe('https://reference.invalid:30080/api/tenant/profile/getInfo')
    fetchMock.mockResolvedValueOnce(ok(tokens))
    expect(await auth.refreshStandalone()).toBe(true)
    expect(JSON.parse(fetchMock.mock.calls[3]?.[1].body)).toMatchObject({ platformType: 'tenant', clientId: tokens.client_id })
    const { authContext } = await import('../authContext')
    expect(authContext.get()?.platformType).toBe('tenant')
  })

  it('无平台的旧会话不恢复为运营身份', async () => {
    storage.set('wx-unity:standalone-session:v1', JSON.stringify({ server: 'https://reference.invalid:30080', tokens, profile }))
    const auth = await import('../standalone')
    expect(await auth.restoreStandalone()).toBeNull()
    expect(storage.size).toBe(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('切换平台后独立续期，上一平台的迟到响应不覆盖新身份', async () => {
    vi.stubEnv('VITE_AUTH_REFRESH_ENABLED', 'true')
    const auth = await import('../standalone')
    fetchMock.mockResolvedValueOnce(ok(tokens)).mockResolvedValueOnce(ok(profile))
    await auth.loginStandalone('13800000000', 'fake', 'operation')
    let resolveOperation!: (response: Response) => void
    fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { resolveOperation = resolve }))
    const oldTask = auth.refreshStandalone()
    const tenantTokens = { ...tokens, access_token: 'tenant-access', client_id: 'tenant-client' }
    fetchMock.mockResolvedValueOnce(ok(tenantTokens)).mockResolvedValueOnce(ok(profile))
    await auth.loginStandalone('13800000000', 'fake', 'tenant')
    fetchMock.mockResolvedValueOnce(ok(tenantTokens))
    expect(await auth.refreshStandalone()).toBe(true)
    resolveOperation(ok(tokens))
    expect(await oldTask).toBe(false)
    const { authContext } = await import('../authContext')
    expect(authContext.get()).toMatchObject({ platformType: 'tenant', accessToken: 'tenant-access', clientId: 'tenant-client' })
  })

  it('登录和资料共用业务地址，不插入额外平台段，身份准备完成才发布上下文', async () => {
    const auth = await import('../standalone')
    const { authContext } = await import('../authContext')
    fetchMock.mockResolvedValueOnce(ok(tokens)).mockResolvedValueOnce(ok(profile))
    await auth.loginStandalone(' 13800000000 ', 'fake-password')
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://reference.invalid:30080/api/auth/operation/login')
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body)).toEqual({ clientId: 'configured-client', accountType: 2, phonenumber: '13800000000', password: 'fake-password', grantType: 'password' })
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://reference.invalid:30080/api/system/user/getInfo')
    expect(fetchMock.mock.calls[1]?.[1].headers).toMatchObject({ Authorization: 'Bearer fake-access', ClientId: 'fake-client' })
    expect(authContext.get()).toMatchObject({ accessToken: 'fake-access', clientId: 'fake-client', platformType: 'operation', permissions: ['scene:read'] })
    expect(authContext.get()?.expiresAt).toBeGreaterThan(Date.now())
    expect([...storage.values()].join('')).not.toContain('fake-password')
  })

  it('资料失败不建立会话，也不回退到旧权限接口', async () => {
    const auth = await import('../standalone')
    const { authContext } = await import('../authContext')
    fetchMock.mockResolvedValueOnce(ok(tokens)).mockResolvedValueOnce(fail())
    await expect(auth.loginStandalone('13800000000', 'fake')).rejects.toThrow('认证失败')
    expect(authContext.get()).toBeNull()
    expect(auth.hasStandaloneSession()).toBe(false)
    expect(storage.size).toBe(0)
  })

  it('不接受旧成功码或缺失客户端编号的响应', async () => {
    const auth = await import('../standalone')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: tokens })))
    await expect(auth.loginStandalone('13800000000', 'fake')).rejects.toThrow('认证请求失败')
    fetchMock.mockResolvedValueOnce(ok({ access_token: 'fake' }))
    await expect(auth.loginStandalone('13800000000', 'fake')).rejects.toThrow('客户端编号')
    expect(storage.size).toBe(0)
  })

  it('刷新页面重新校验权限，后端撤销身份后清理缓存', async () => {
    let auth = await import('../standalone')
    fetchMock.mockResolvedValueOnce(ok(tokens)).mockResolvedValueOnce(ok(profile))
    await auth.loginStandalone('13800000000', 'fake')
    vi.resetModules()
    auth = await import('../standalone')
    fetchMock.mockResolvedValueOnce(ok({ ...profile, permissions: [] }))
    expect((await auth.restoreStandalone())?.permissions).toEqual([])
    fetchMock.mockResolvedValueOnce(fail())
    expect(await auth.restoreStandalone()).toBeNull()
    expect(storage.size).toBe(0)
  })

  it('切换服务器后拒绝旧服务器会话且不发送旧令牌', async () => {
    let auth = await import('../standalone')
    fetchMock.mockResolvedValueOnce(ok(tokens)).mockResolvedValueOnce(ok(profile))
    await auth.loginStandalone('13800000000', 'fake')
    vi.resetModules()
    vi.stubEnv('VITE_DIM3D_SERVER_URL', 'https://new-backend.invalid')
    auth = await import('../standalone')
    expect(await auth.restoreStandalone()).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(storage.size).toBe(0)
  })

  it('来源模式不请求尚未实现的续期端点', async () => {
    const auth = await import('../standalone')
    fetchMock.mockResolvedValueOnce(ok(tokens)).mockResolvedValueOnce(ok(profile))
    await auth.loginStandalone('13800000000', 'fake')
    expect(await auth.refreshStandalone()).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('并发续期只发一次请求，轮换令牌失败不悬挂后续请求', async () => {
    vi.stubEnv('VITE_AUTH_REFRESH_ENABLED', 'true')
    const auth = await import('../standalone')
    fetchMock.mockResolvedValueOnce(ok(tokens)).mockResolvedValueOnce(ok(profile))
    await auth.loginStandalone('13800000000', 'fake')
    let resolveRefresh!: (response: Response) => void
    fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { resolveRefresh = resolve }))
    const first = auth.refreshStandalone()
    const second = auth.refreshStandalone()
    expect(first).toBe(second)
    resolveRefresh(fail())
    expect(await Promise.all([first, second])).toEqual([false, false])
    fetchMock.mockResolvedValueOnce(ok({ ...tokens, access_token: 'rotated', refresh_token: 'rotated-refresh' }))
    expect(await auth.refreshStandalone()).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('退出后丢弃迟到续期结果，注销失败仍清空本地身份', async () => {
    vi.stubEnv('VITE_AUTH_REFRESH_ENABLED', 'true')
    const auth = await import('../standalone')
    const { authContext } = await import('../authContext')
    fetchMock.mockResolvedValueOnce(ok(tokens)).mockResolvedValueOnce(ok(profile))
    await auth.loginStandalone('13800000000', 'fake')
    let resolveRefresh!: (response: Response) => void
    fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { resolveRefresh = resolve }))
    const refreshing = auth.refreshStandalone()
    fetchMock.mockResolvedValueOnce(fail(500))
    await expect(auth.logoutStandalone()).rejects.toThrow('认证失败')
    resolveRefresh(ok(tokens))
    expect(await refreshing).toBe(false)
    expect(authContext.get()).toBeNull()
    expect(storage.size).toBe(0)
  })

  it('业务码 401 与传输状态 401 同样拒绝会话', async () => {
    const auth = await import('../standalone')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ code: 401, msg: '登录过期' })))
    await expect(auth.loginStandalone('13800000000', 'fake')).rejects.toMatchObject({ code: 401 })
    expect(auth.hasStandaloneSession()).toBe(false)
  })

  it('恢复资料期间退出，迟到资料不能恢复旧身份', async () => {
    const auth = await import('../standalone')
    const { authContext } = await import('../authContext')
    fetchMock.mockResolvedValueOnce(ok(tokens)).mockResolvedValueOnce(ok(profile))
    await auth.loginStandalone('13800000000', 'fake')
    let resolveProfile!: (response: Response) => void
    fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { resolveProfile = resolve }))
    const restoring = auth.restoreStandalone()
    auth.clearStandalone()
    resolveProfile(ok(profile))
    expect(await restoring).toBeNull()
    expect(authContext.get()).toBeNull()
    expect(storage.size).toBe(0)
  })

  it('恢复请求迟到的 401 不得清理另一轮成功登录', async () => {
    const auth = await import('../standalone')
    fetchMock.mockResolvedValueOnce(ok(tokens)).mockResolvedValueOnce(ok(profile))
    await auth.loginStandalone('13800000000', 'fake')
    let resolveProfile!: (response: Response) => void
    fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { resolveProfile = resolve }))
    const restoring = auth.restoreStandalone()
    fetchMock.mockResolvedValueOnce(ok(tokens)).mockResolvedValueOnce(ok(profile))
    await auth.loginStandalone('13800000000', 'fake')
    resolveProfile(fail())
    expect(await restoring).toBeNull()
    expect(auth.hasStandaloneSession()).toBe(true)
  })
})
