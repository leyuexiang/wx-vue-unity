import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const { request } = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('@/request.ts', () => ({ default: request }))
vi.mock('@/servers/manual/dim3d/api/auth', () => ({ getDim3dHeaders: () => ({}) }))
beforeEach(() => { vi.resetModules(); request.mockReset(); vi.stubEnv('VITE_DIM3D_API_MODE', 'admin') })
afterEach(() => { vi.unstubAllEnvs() })

describe('148场景契约适配', () => {
  it('只将有令牌的成功加锁和有到期时间的成功续约转换为可编辑状态', async () => {
    const api = await import('@/servers/manual/dim3d/api/scene')
    request.mockResolvedValueOnce({ code: 200, data: { locked: true, lockToken: 'test-lock' } })
    expect((await api.lockDim3dScene('1', 'client')).data?.locked).toBe(false)
    request.mockResolvedValueOnce({ code: 200, data: { locked: true, expireTime: '2099-01-01' } })
    expect((await api.heartbeatDim3dScene('1', { lockToken: 'test-lock' })).data?.locked).toBe(false)
    request.mockResolvedValueOnce({ code: 409, data: { locked: true } })
    expect((await api.lockDim3dScene('1', 'client')).data?.locked).toBe(true)
    request.mockResolvedValueOnce({ code: 200, data: { locked: true } })
    expect((await api.heartbeatDim3dScene('1', { lockToken: 'test-lock' })).data?.locked).toBe(true)
  })
  it('合并同时发起的字典读取并按真实字段和类型分流', async () => {
    const api = await import('@/servers/manual/dim3d/api/dictionary')
    request.mockResolvedValueOnce({ code: 200, data: [
      { dictType: 'dim3d_scene_category', label: '测试分类', value: 'TEST' },
      { dictType: 'dim3d_model_category', label: '测试模型', value: 'MODEL' },
    ] })
    const [scene, model] = await Promise.all([api.getDim3dSceneCategoryDictionary(), api.getDim3dModelCategoryDictionary()])
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0]![0]).toContain('/admin-api/system/dict-data/simple-list')
    expect(scene.data).toEqual([{ dictType: 'dim3d_scene_category', dictLabel: '测试分类', dictValue: 'TEST' }])
    expect(model.data?.[0]?.dictValue).toBe('MODEL')
  })
})
