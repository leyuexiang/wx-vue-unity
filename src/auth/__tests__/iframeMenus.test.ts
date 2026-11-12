import { expect, it, vi } from 'vitest'
import { createIframeAuthProvider } from '../iframeAuthProvider'

it('只有来源及窗口校验通过的宿主响应能提供菜单，快照不共享原始引用', async () => {
  let handler!: (event: unknown) => void
  const parent = { postMessage: vi.fn() }
  const fakeWindow = {
    parent, addEventListener: (_: string, listener: typeof handler) => { handler = listener },
    removeEventListener: vi.fn(),
  } as unknown as Window
  const provider = createIframeAuthProvider({ parentOrigin: 'https://host.invalid', window: fakeWindow,
    requestIdFactory: () => 'menu-test' })
  try {
    const pending = provider.initialize()
    const menus = [{ id: '1', name: '资料中心', children: [{ id: '2', name: '模型', component: 'resourceManage/modelManage/index' }] }]
    const data = { type: 'XR_CENTER_AUTH', requestId: 'menu-test', accessToken: 'fake', clientId: 'web',
      platformType: 'operation', permissions: ['dim3d:model:query'], roles: [], menus }
    handler({ origin: 'https://untrusted.invalid', source: parent, data })
    expect(provider.getContext()).toBeNull()
    handler({ origin: 'https://host.invalid', source: {}, data })
    expect(provider.getContext()).toBeNull()
    handler({ origin: 'https://host.invalid', source: parent, data })
    const context = await pending
    menus[0]!.name = '外部修改'
    expect(context.menus?.[0]?.name).toBe('资料中心')
    expect(context.permissions).toEqual(['dim3d:model:query'])
  } finally { provider.destroy() }
})
