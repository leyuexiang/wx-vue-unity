import { afterEach, expect, it, vi } from 'vitest'
import { getDim3dManagedModelId } from '../resource'

const { request } = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('@/request.ts', () => ({ default: request }))
vi.mock('../auth', () => ({ getDim3dHeaders: () => ({}) }))
afterEach(() => request.mockReset())

it('受管模型保留完整字符串编号，不使用旧对象存储路径', async () => {
  const id = '2122892047650189313'
  request.mockResolvedValue({ code: 200, data: { resourceId: id, contentFormat: 'model.glb.v1' } })
  expect(await getDim3dManagedModelId(id)).toBe(id)
  expect(request.mock.calls[0]?.[0]).toContain(`/dim3d/resources/${id}/current`)
})

it('历史模型明确不存在当前发布时回到原文件地址', async () => {
  request.mockRejectedValue(Object.assign(new Error('不存在'), { code: 404 }))
  expect(await getDim3dManagedModelId('12')).toBeUndefined()
})

it('权限、网络错误和不匹配资源均拒绝降级到旧存储', async () => {
  request.mockRejectedValueOnce(Object.assign(new Error('权限不足'), { status: 403 }))
  await expect(getDim3dManagedModelId('12')).rejects.toThrow('权限不足')
  request.mockResolvedValueOnce({ code: 200, data: { resourceId: '13', contentFormat: 'model.glb.v1' } })
  await expect(getDim3dManagedModelId('12')).rejects.toThrow('发布信息无效')
})
