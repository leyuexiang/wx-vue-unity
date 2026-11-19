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
  get: () => ({ accessToken: 'test-access', clientId: 'test-client', platformType: fixture.platformType,
    tenantId: fixture.platformType === 'tenant' ? '2' : '1' }),
  getPlatformType: () => fixture.platformType,
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
const platformSegment = (platform: 'operation' | 'tenant') => platform === 'tenant' ? 'tenant/web' : 'operation'

it('租户登录上下文令业务请求使用租户路径和当前身份', () => {
  fixture.platformType = 'tenant'
  const result = fixture.requestHook!('https://reference.invalid/api/dim3d/scene/page', { passAuth: true })
  expect(result.url).toBe('https://reference.invalid/api/tenant/web/dim3d/scene/page')
  expect(result.options.headers).toMatchObject({ Authorization: 'Bearer test-access', ClientId: 'test-client' })
})

/** 经真实新增场景入口和请求拦截器复现旧临时凭据残留，确保读写请求共用当前登录身份。 */
it.each(['operation', 'tenant'] as const)('%s 新增场景不使用本地残留的临时凭据', async (platformType) => {
  fixture.platformType = platformType
  vi.stubEnv('VITE_DIM3D_API_MODE', 'admin')
  const storedCredentials: Record<string, string> = {
    'jtyf.dim3d.temp-token': 'expired-temporary-token',
    'jtyf.dim3d.client-id': 'legacy-client',
  }
  Object.assign(window, {
    localStorage: {
      getItem: (key: string) => storedCredentials[key] ?? null,
    },
  })
  const { addDim3dScene } = await import('@/servers/manual/dim3d/api/scene')
  // 只替换最终传输，保留业务入口生成的全部选项，再执行真实请求拦截器。
  fixture.replay.mockImplementationOnce((address, options) => fixture.requestHook!(address, options))
  const result = await addDim3dScene({ name: '鉴权回归场景', sceneType: 'local3d' }) as unknown as {
    url: string; options: Record<string, unknown>
  }
  expect(result.url).toBe(`https://reference.invalid/api/${platformSegment(platformType)}/dim3d/scene/add`)
  expect(result.options.headers).toMatchObject({ Authorization: 'Bearer test-access', ClientId: 'test-client' })
  expect(result.options.__standaloneAuth).toBe(true)
  // 当前身份真正失效时仍应进入统一登录处理，避免新增表单反复提交同一失效凭据。
  await expect(fixture.responseHook!(unauthorized(), { ...result.options, url: result.url }))
    .rejects.toMatchObject({ code: 401 })
  expect(fixture.login).toHaveBeenCalledOnce()
})

/** 普通图片查询在同源代理下也使用当前平台和登录凭据。 */
it.each(['operation', 'tenant'] as const)('%s 图片文件查询按端分流', async (platformType) => {
  fixture.platformType = platformType
  vi.stubEnv('VITE_DIM3D_API_MODE', 'admin')
  vi.stubEnv('VITE_DIM3D_SERVER_URL', '/dts-api')
  const { getDim3dOssFileById } = await import('@/servers/manual/dim3d/api/oss')
  fixture.replay.mockImplementationOnce((address, options) => fixture.requestHook!(address, options))
  const result = await getDim3dOssFileById('9007199254740993') as unknown as {
    url: string; options: Record<string, unknown>
  }
  expect(result.url).toBe(`/dts-api/api/${platformSegment(platformType)}/resource/oss/listByIds/9007199254740993`)
  expect(result.options.headers).toMatchObject({ Authorization: 'Bearer test-access', ClientId: 'test-client' })
})

/** 卸载时绕过请求拦截器，仍须携带租户身份并投递到本端的解锁入口。 */
it('租户离开编辑器时按当前端释放场景锁', async () => {
  fixture.platformType = 'tenant'
  vi.stubEnv('VITE_DIM3D_API_MODE', 'admin')
  vi.stubEnv('VITE_DIM3D_SERVER_URL', '/dts-api')
  const send = vi.fn().mockResolvedValue(new Response())
  vi.stubGlobal('fetch', send)
  const { unlockDim3dSceneOnUnload } = await import('@/servers/manual/dim3d/api/scene')
  unlockDim3dSceneOnUnload('17', 'tab-key')
  expect(send).toHaveBeenCalledWith('/dts-api/api/tenant/web/dim3d/scene/unlock/17?clientKey=tab-key',
    expect.objectContaining({
      method: 'DELETE', keepalive: true,
      headers: expect.objectContaining({ Authorization: 'Bearer test-access', 'tenant-id': '2' }),
    }))
})

/** 模板管理和编辑器应用使用同一登录端，仍将两种详情投递到各自业务路径。 */
it.each(['operation', 'tenant'] as const)('%s 文件型和快照模板详情按端分流', async (platformType) => {
  fixture.platformType = platformType
  vi.stubEnv('VITE_DIM3D_API_MODE', 'admin')
  vi.stubEnv('VITE_DIM3D_SERVER_URL', '/dts-api')
  const { getDim3dSceneTemplateInfo, getDim3dTemplateInfo } = await import('@/servers/manual/dim3d/api/template')
  const forwarded: string[] = []
  for (const load of [getDim3dTemplateInfo, getDim3dSceneTemplateInfo]) {
    fixture.replay.mockImplementationOnce((address, options) => {
      const result = fixture.requestHook!(address, options)
      expect(result.options.headers).toMatchObject({
        Authorization: 'Bearer test-access', 'tenant-id': platformType === 'tenant' ? '2' : '1',
      })
      forwarded.push(result.url)
      return { code: 200, data: {} }
    })
    await load('9007199254740993')
  }
  const root = `/dts-api/api/${platformSegment(platformType)}/dim3d`
  expect(forwarded).toEqual([
    `${root}/template/info/9007199254740993`,
    `${root}/scene/template/info/9007199254740993`,
  ])
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
