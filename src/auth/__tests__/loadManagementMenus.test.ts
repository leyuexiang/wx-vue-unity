import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const transport = vi.hoisted(() => vi.fn())
vi.mock('@/request', () => ({ default: transport }))
beforeEach(() => {
  vi.resetModules(); transport.mockReset()
  vi.stubEnv('VITE_DIM3D_API_MODE', 'admin')
  vi.stubEnv('VITE_DIM3D_SERVER_URL', 'https://service.invalid')
})
afterEach(() => vi.unstubAllEnvs())
const identity = { accessToken: 'fake', clientId: 'web', tenantId: '7', platformType: 'tenant' as const, roles: [], permissions: ['iot:connector:query'] }

it('内嵌补读仅接受菜单，不扩大宿主传来的权限', async () => {
  const { authContext } = await import('../authContext')
  const { loadManagementMenus } = await import('../loadManagementMenus')
  authContext.set(identity)
  transport.mockResolvedValue({ code: 200, data: { permissions: ['*:*:*'],
    menus: [{ id: '1', name: '连接器', component: 'iotManage/connectors/index' }] } })
  await loadManagementMenus()
  expect(authContext.get()?.menus?.[0]?.name).toBe('连接器')
  expect(authContext.get()?.permissions).toEqual(identity.permissions)
  expect(transport).toHaveBeenCalledWith('https://service.invalid/admin-api/system/auth/get-permission-info',
    expect.objectContaining({ skipPlatformPath: true }))
})
it('补读失败关闭入口并保留原身份，不回退全量菜单', async () => {
  const { authContext } = await import('../authContext')
  const { loadManagementMenus } = await import('../loadManagementMenus')
  authContext.set(identity)
  transport.mockRejectedValue(new Error('隔离网络失败'))
  await loadManagementMenus()
  expect(authContext.get()).toMatchObject({ ...identity, menus: [] })
})
it('身份切换后不把迟到菜单装入新账号，已有标准菜单不重复请求', async () => {
  const { authContext } = await import('../authContext')
  const { loadManagementMenus } = await import('../loadManagementMenus')
  let finish!: (value: unknown) => void
  transport.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  authContext.set(identity)
  const pending = loadManagementMenus()
  authContext.set({ ...identity, tenantId: '8', accessToken: 'another-fake', menus: [] })
  finish({ code: 200, data: { menus: [{ id: '1', name: '旧身份菜单' }] } })
  await pending
  expect(authContext.get()?.menus).toEqual([])
  await loadManagementMenus()
  expect(transport).toHaveBeenCalledTimes(1)
})
