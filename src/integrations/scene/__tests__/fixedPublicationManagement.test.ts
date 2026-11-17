import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { authContext as AuthContext } from '@/auth/authContext'
let authContext: typeof AuthContext
const { transport } = vi.hoisted(() => ({ transport: vi.fn() }))
vi.mock('@/request.ts', () => ({ default: transport }))
beforeEach(async () => {
  vi.resetModules(); transport.mockReset()
  authContext = (await import('@/auth/authContext')).authContext
  vi.stubEnv('VITE_DIM3D_SERVER_URL', '/dts-api')
  authContext.set({ accessToken: 'test-login', clientId: 'web', tenantId: '2', platformType: 'tenant', roles: ['tenant_admin'], permissions: [] })
})
afterEach(() => { authContext.clear(); vi.unstubAllEnvs(); vi.useRealTimers() })

it('发布确认保持字符串编号、保存修订和稳定请求号，拒绝错误发布回执', async () => {
  const api = await import('../fixedPublicationManagement')
  const sceneId = '2122269441737682946'
  transport.mockResolvedValueOnce({ code: 200, data: { sceneId, publicationId: 'PUB-10', revisionNo: 5, status: 'PUBLISHED', alreadyPublished: true } })
  expect((await api.publishCurrentScene(sceneId, 5, 'request-stable')).alreadyPublished).toBe(true)
  expect(transport).toHaveBeenCalledWith('/dts-api/admin-api/dim3d/scene/publication/publish-current', expect.objectContaining({ method: 'POST', params: { sceneId, revisionNo: 5, requestId: 'request-stable' } }))
  transport.mockResolvedValueOnce({ code: 200, data: { sceneId: '999', publicationId: 'PUB-10', revisionNo: 5, status: 'PUBLISHED' } })
  await expect(api.publishCurrentScene(sceneId, 5, 'request-stable')).rejects.toThrow('发布回执')
})

it('签发只读凭证不进入地址，身份切换后丢弃迟到凭证', async () => {
  const api = await import('../fixedPublicationManagement')
  let complete!: (data: unknown) => void
  transport.mockReturnValueOnce(new Promise(resolve => { complete = resolve }))
  const pending = api.issuePublicationTicket('PUB-10', 300)
  authContext.set({ accessToken: 'another-login', clientId: 'web', tenantId: '3', platformType: 'tenant', roles: [], permissions: [] })
  complete({ code: 200, data: { publicationId: 'PUB-10', ticketId: 'TKT-11', token: 'a'.repeat(43), scope: 'READ', expiresInSeconds: 300 } })
  await expect(pending).rejects.toThrow('登录状态已变化')
  expect(transport.mock.calls[0]![0]).not.toContain('a'.repeat(43))
})

it('失败重试复用请求号，重复提交隔离，关闭后迟到回执不能恢复窗口', async () => {
  const { createFixedPublicationDialogController } = await import('../fixedPublicationDialogController')
  const publish = vi.fn().mockRejectedValueOnce(new Error('网络中断')).mockResolvedValueOnce({ sceneId: '101', publicationId: 'PUB-10', revisionNo: 5, status: 'PUBLISHED', alreadyPublished: false })
  const controller = createFixedPublicationDialogController({
    capabilities: async () => ({ protocol: 'fixed-ticket-v1', accessModes: [{ value: 'TICKET', label: '受控访问' }], ticketDefaultSeconds: 300, ticketMinSeconds: 60, ticketMaxSeconds: 3600 }),
    scene: async () => ({ sceneId: '101', name: '试运行场景', currentRevision: { revisionNo: 5 } }), publish,
    issue: vi.fn(), revokeTicket: vi.fn(), requestId: () => 'same-request',
  })
  await controller.load('101')
  expect(await controller.publish()).toBe(false)
  expect(await controller.publish()).toBe(true)
  expect(publish.mock.calls.map(args => args.slice(0, 3))).toEqual([['101', 5, 'same-request'], ['101', 5, 'same-request']])
  let resolve!: (value: unknown) => void
  publish.mockReturnValueOnce(new Promise(done => { resolve = done }))
  await controller.load('101')
  const pending = controller.publish()
  expect(await controller.publish()).toBe(false)
  expect(publish).toHaveBeenCalledTimes(3)
  controller.close()
  resolve({ sceneId: '101', publicationId: 'PUB-12', revisionNo: 5, status: 'PUBLISHED' })
  expect(await pending).toBe(false)
  expect(controller.state.publication).toBeNull()
})

it('关闭或凭证到期清空内存，切换目标时丢弃迟到读取结果', async () => {
  vi.useFakeTimers()
  const { createFixedPublicationDialogController } = await import('../fixedPublicationDialogController')
  const controller = createFixedPublicationDialogController({
    capabilities: async () => ({ protocol: 'fixed-ticket-v1', accessModes: [{ value: 'TICKET', label: '受控访问' }], ticketDefaultSeconds: 60, ticketMinSeconds: 60, ticketMaxSeconds: 3600 }),
    scene: async id => ({ sceneId: id, name: id, currentRevision: { revisionNo: 1 } }),
    publish: async id => ({ sceneId: id, publicationId: 'PUB-10', revisionNo: 1, status: 'PUBLISHED', alreadyPublished: false }),
    issue: async () => ({ publicationId: 'PUB-10', ticketId: 'TKT-11', token: 'a'.repeat(43), scope: 'READ', expiresInSeconds: 60 }), revokeTicket: vi.fn(), requestId: () => 'test-request',
  })
  await controller.load('101'); await controller.publish(); await controller.issue()
  expect(controller.state.ticket?.token).toHaveLength(43)
  await vi.advanceTimersByTimeAsync(60000)
  expect(controller.state.ticket).toBeNull()
  await controller.issue(); controller.close()
  expect(controller.state.ticket).toBeNull()
  expect(vi.getTimerCount()).toBe(0)
})

it('预览续期只替换内存凭证，停止后不继续签发，失败到期则撤下运行态', async () => {
  vi.useFakeTimers()
  const { renewManagedPreviewTicket } = await import('../fixedPublicationManagement')
  const initial = { publicationId: 'PUB-10', ticketId: 'TKT-11', token: 'a'.repeat(43), scope: 'READ' as const, expiresInSeconds: 60 }
  const issue = vi.fn().mockResolvedValueOnce({ ...initial, token: 'b'.repeat(43) }).mockRejectedValue(new Error('续期暂不可用'))
  const onTicket = vi.fn(), onExpired = vi.fn()
  const stop = renewManagedPreviewTicket(initial, { issue, onTicket, onExpired })
  await vi.advanceTimersByTimeAsync(30000)
  expect(onTicket).toHaveBeenCalledWith(expect.objectContaining({ token: 'b'.repeat(43) }))
  expect(onExpired).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(60000)
  expect(onExpired).toHaveBeenCalledTimes(1)
  const calls = issue.mock.calls.length
  stop(); await vi.advanceTimersByTimeAsync(120000)
  expect(issue).toHaveBeenCalledTimes(calls)
})
