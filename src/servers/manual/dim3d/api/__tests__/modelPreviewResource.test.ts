import { afterEach, expect, it, vi } from 'vitest'
import { getDim3dModelFileAccess } from '../resource'

const { request } = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('@/request.ts', () => ({ default: request }))
vi.mock('../auth', () => ({ getDim3dHeaders: () => ({}) }))
vi.mock('../constants', () => ({
  DIM3D_ADMIN_API: true,
  DIM3D_AMM_PREFIX: 'https://legacy.invalid/amm/',
  DIM3D_API_PREFIX: '/admin-api',
  DIM3D_PLATFORM_API_PREFIX: '/api',
}))
afterEach(() => request.mockReset())

it('受管模型保留完整字符串编号，不使用旧对象存储路径', async () => {
  const id = '2122892047650189313'
  request.mockResolvedValue({ code: 200, data: { id, accessMode: 'MANAGED', resourceRelativePath: 'private/model.glb' } })
  expect(await getDim3dModelFileAccess(id)).toEqual({ id, accessMode: 'MANAGED' })
  expect(request.mock.calls[0]?.[0]).toBe(`/api/dim3d/model/file-access/${id}`)
  expect(request.mock.calls[0]?.[1].skipPlatformPath).toBeFalsy()
})

it('只有服务端明确返回历史访问方式才拼接可信相对路径', async () => {
  request.mockResolvedValue({ code: 200, data: { id: '12', accessMode: 'LEGACY', resourceRelativePath: 'models/tree.glb' } })
  expect(await getDim3dModelFileAccess('12')).toEqual({
    id: '12', accessMode: 'LEGACY', url: 'https://legacy.invalid/amm/models/tree.glb',
  })
})

/** 新旧服务并行期间，目录已上线的模型仍可通过旧版受管发布记录加载。 */
it('文件访问接口返回 405 时，用同编号的当前模型发布确认受管访问方式', async () => {
  const id = '2122892047650189313'
  request.mockRejectedValueOnce({ code: 405 })
  request.mockResolvedValueOnce({ code: 200, data: { resourceId: id, contentFormat: 'model.glb.v1' } })

  expect(await getDim3dModelFileAccess(id)).toEqual({ id, accessMode: 'MANAGED' })
  expect(request).toHaveBeenNthCalledWith(2, `/admin-api/dim3d/resources/${id}/current`, expect.anything())
})

/** 旧接口也必须证明资源身份和模型格式，无法确认时不得尝试对象存储地址。 */
it('405 兼容路径遇到无效发布时拒绝加载', async () => {
  request.mockResolvedValueOnce({ code: 405 })
  request.mockResolvedValueOnce({ code: 200, data: { resourceId: '12', contentFormat: 'image.png.v1' } })

  await expect(getDim3dModelFileAccess('12')).rejects.toThrow('访问方式无效')
  expect(request).toHaveBeenCalledTimes(2)
})

it('权限、网络错误和不匹配资源均拒绝降级到旧存储', async () => {
  request.mockRejectedValueOnce(Object.assign(new Error('权限不足'), { status: 403 }))
  await expect(getDim3dModelFileAccess('12')).rejects.toThrow('权限不足')
  request.mockResolvedValueOnce({ code: 200, data: { id: '13', accessMode: 'MANAGED' } })
  await expect(getDim3dModelFileAccess('12')).rejects.toThrow('访问方式无效')
  request.mockResolvedValueOnce({ code: 404, msg: '文件不可见' })
  await expect(getDim3dModelFileAccess('12')).rejects.toThrow('文件不可见')
  expect(request).toHaveBeenCalledTimes(3)
})
