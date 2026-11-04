import { afterEach, expect, it, vi } from 'vitest'
import { authContext } from '@/auth/authContext'
import { JsonRpcUnityCloudRuntime } from '../runtime/JsonRpcUnityCloudRuntime'
import type { UnityTransport } from '../connection/UnityTransport'

afterEach(() => { authContext.clear(); vi.unstubAllEnvs() })

it('初始化携带本次登录身份和HTTPS根来源，并拒绝无效配置与失效身份', async () => {
  vi.stubEnv('VITE_UNITY_RESOURCE_API_ORIGIN', 'https://api.invalid/')
  vi.stubEnv('VITE_UNITY_RESOURCE_DOWNLOAD_ORIGINS', 'https://files.invalid/')
  authContext.set({ tenantId: '2', accessToken: 'Bearer fake-access', clientId: 'admin-api', roles: [], permissions: [], platformType: 'tenant' })
  const request = vi.fn(async (_method, envelope) => ({ protocolVersion: 1, requestId: envelope.requestId, success: true,
    payload: { protocolVersion: 1, capabilities: { sceneTypes: ['local3d'], objectTypes: ['model'], gizmoModes: [], features: {} } } }))
  const transport = { connect: vi.fn(), disconnect: vi.fn(), subscribe: () => () => {}, notify: vi.fn(), request } as unknown as UnityTransport
  await new JsonRpcUnityCloudRuntime(transport).connect()
  expect(request).toHaveBeenCalledWith('editor.v1.session.initialize', expect.objectContaining({ payload: expect.objectContaining({ resourceAuth: {
    apiBaseUrl: 'https://api.invalid', tenantId: '2', accessToken: 'fake-access', downloadOrigins: ['https://files.invalid'],
  } }) }))
  vi.stubEnv('VITE_UNITY_RESOURCE_API_ORIGIN', 'https://api.invalid/api')
  await expect(new JsonRpcUnityCloudRuntime(transport).connect()).rejects.toThrow('HTTPS根来源')
  vi.stubEnv('VITE_UNITY_RESOURCE_API_ORIGIN', 'https://api.invalid')
  authContext.clear()
  await expect(new JsonRpcUnityCloudRuntime(transport).connect()).rejects.toThrow('有效登录身份')
})
