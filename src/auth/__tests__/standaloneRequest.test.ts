import { afterEach, beforeEach, expect, it, vi } from 'vitest'

/** 只替换传输边界，直接执行真实请求/响应拦截器，避免依赖真实账号和浏览器会话。 */
const fixture = vi.hoisted(() => ({
  requestHook: undefined as undefined | ((url: string, options: Record<string, unknown>) => { url: string; options: Record<string, unknown> }),
  responseHook: undefined as undefined | ((response: Response, options: Record<string, unknown>) => Promise<Response>),
  embedded: false,
  standalone: true,
  platformType: 'operation' as 'operation' | 'tenant',
  sessionVersion: 1,
  refresh: vi.fn(), login: vi.fn(), notify: vi.fn(), replay: vi.fn(),
}))
vi.mock('umi-request', () => ({ extend: () => Object.assign(fixture.replay, {
  interceptors: {
    request: { use: (hook: typeof fixture.requestHook) => { fixture.requestHook = hook } },
    response: { use: (hook: typeof fixture.responseHook) => { fixture.responseHook = hook } },
  },
}) }))
vi.mock('element-plus', () => ({ ElNotification: vi.fn() }))
vi.mock('@/auth/standalone', () => ({ hasStandaloneSession: () => fixture.standalone, getStandaloneSessionVersion: () => fixture.sessionVersion, refreshStandalone: fixture.refresh }))
vi.mock('@/utils/auth', () => ({ getAccessToken: () => 'test-access', toLogin: fixture.login }))
vi.mock('@/auth/authContext', () => ({ authContext: {
  get: () => ({ accessToken: 'test-access', clientId: 'test-client', platformType: fixture.platformType }),
  hasValidContext: () => true,
} }))
vi.mock('@/auth/runtime', () => ({ isEmbeddedMode: () => fixture.embedded, getAuthProvider: () => ({ notifyAuthExpired: fixture.notify }) }))

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  fixture.embedded = false
  fixture.standalone = true
  fixture.platformType = 'operation'
  fixture.sessionVersion = 1
  vi.stubEnv('VITE_DIM3D_SERVER_URL', 'https://reference.invalid')
  vi.stubGlobal('window', { location: { origin: 'http://localhost', pathname: '/dts/sceneManage' } })
  fixture.refresh.mockResolvedValue(false)
  fixture.replay.mockResolvedValue(new Response('{}'))
  await import('@/request')
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

const unauthorized = () => new Response(JSON.stringify({ code: 401, msg: '认证过期' }))
const url = 'https://reference.invalid/api/operation/dim3d/scene/page'

it('租户登录上下文令业务请求使用租户路径和当前身份', () => {
  fixture.platformType = 'tenant'
  const result = fixture.requestHook!('https://reference.invalid/api/dim3d/scene/page', { passAuth: true })
  expect(result.url).toBe('https://reference.invalid/api/tenant/web/dim3d/scene/page')
  expect(result.options.headers).toMatchObject({ Authorization: 'Bearer test-access', ClientId: 'test-client' })
})

it('切换登录平台后，旧请求的 401 不清除新身份', async () => {
  const options = fixture.requestHook!(url, { passAuth: true }).options
  fixture.sessionVersion++
  await expect(fixture.responseHook!(unauthorized(), { ...options, url })).rejects.toMatchObject({ code: 401 })
  expect(fixture.login).not.toHaveBeenCalled()
  expect(fixture.refresh).not.toHaveBeenCalled()
})

it('旧平台续期等待期间重新登录，旧续期失败不退出新平台', async () => {
  const options = fixture.requestHook!(url, { passAuth: true }).options
  let finish!: (value: boolean) => void
  fixture.refresh.mockImplementationOnce(() => new Promise<boolean>(resolve => { finish = resolve }))
  const result = fixture.responseHook!(unauthorized(), { ...options, url })
  // 响应拦截器先解析正文，等待进入续期，再模拟用户完成另一端登录。
  await vi.waitFor(() => expect(fixture.refresh).toHaveBeenCalledOnce())
  fixture.sessionVersion++
  finish(false)
  await expect(result).rejects.toMatchObject({ code: 401 })
  expect(fixture.login).not.toHaveBeenCalled()
})

it('带专用业务选项的第一方请求仍使用独立上下文并允许一次续期', async () => {
  const options = fixture.requestHook!(url, { passAuth: true }).options
  expect(options.headers).toMatchObject({ Authorization: 'Bearer test-access', ClientId: 'test-client' })
  expect(options.__standaloneAuth).toBe(true)
  fixture.refresh.mockResolvedValueOnce(true)
  await fixture.responseHook!(unauthorized(), { ...options, url })
  expect(fixture.refresh).toHaveBeenCalledTimes(1)
  expect(fixture.replay).toHaveBeenCalledWith(url, expect.objectContaining({ __authRetry: true }))
})

it('重放后再次 401 不再续期，直接通知登录', async () => {
  await expect(fixture.responseHook!(unauthorized(), { url, __standaloneAuth: true, __authRetry: true })).rejects.toMatchObject({ code: 401 })
  expect(fixture.refresh).not.toHaveBeenCalled()
  expect(fixture.login).toHaveBeenCalledTimes(1)
})

it('续期失败明确拒绝请求，不重放', async () => {
  await expect(fixture.responseHook!(unauthorized(), { url, __standaloneAuth: true })).rejects.toMatchObject({ code: 401 })
  expect(fixture.login).toHaveBeenCalledTimes(1)
  expect(fixture.replay).not.toHaveBeenCalled()
})

it.each([
  ['第三方', 'https://external.invalid/api/data', {}],
  ['公开票据', url, { publicPreview: true }],
  ['手配凭据', url, { preserveConfiguredHeaders: true, passAuth: true, headers: { Authorization: 'custom' } }],
])('%s 的 401 不影响独立登录', async (_label, address, supplied) => {
  const options = fixture.requestHook!(address, supplied).options
  expect(options.__standaloneAuth).toBe(false)
  await expect(fixture.responseHook!(unauthorized(), { ...options, url: address })).rejects.toMatchObject({ code: 401 })
  expect(fixture.refresh).not.toHaveBeenCalled()
  expect(fixture.login).not.toHaveBeenCalled()
})

it('内嵌认证失败只通知宿主，不调用独立刷新或登录', async () => {
  fixture.embedded = true
  const options = fixture.requestHook!(url, { passAuth: true }).options
  await expect(fixture.responseHook!(unauthorized(), { ...options, url })).rejects.toMatchObject({ code: 401 })
  expect(fixture.notify).toHaveBeenCalledTimes(1)
  expect(fixture.refresh).not.toHaveBeenCalled()
  expect(fixture.login).not.toHaveBeenCalled()
})

it('独立编辑页签交接身份失效时通知画布，不借用独立刷新', async () => {
  fixture.standalone = false
  const dispatch = vi.fn()
  vi.stubGlobal('window', { location: { origin: 'http://localhost', pathname: '/dts/sceneEdit' }, dispatchEvent: dispatch })
  vi.stubGlobal('CustomEvent', class { constructor(readonly type: string) {} })
  await expect(fixture.responseHook!(unauthorized(), { url })).rejects.toMatchObject({ code: 401 })
  expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'xr-center-auth-expired' }))
  expect(fixture.refresh).not.toHaveBeenCalled()
  expect(fixture.login).not.toHaveBeenCalled()
})
