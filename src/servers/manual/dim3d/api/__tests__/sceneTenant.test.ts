import { expect, it, vi } from 'vitest'

const { transport } = vi.hoisted(() => ({ transport: vi.fn() }))
vi.mock('@/request.ts', () => ({ default: transport }))
vi.mock('../auth', () => ({ getDim3dHeaders: () => ({}) }))
vi.mock('../constants', () => ({
  DIM3D_ADMIN_API: true,
  DIM3D_OPERATION_API_PREFIX: '/dts-api/admin-api',
}))

import { createOperationTenantSelectOptions, pageOperationTenants } from '../tenant'

/** 搜索走系统分页并保全租户长编号，选择后可用于场景授权。 */
it('使用系统租户分页生成真实选项', async () => {
  transport.mockResolvedValueOnce({
    code: 200,
    data: { total: 1, list: [{ id: '9007199254740993', name: '目标租户' }] },
  })
  const page = await pageOperationTenants({ searchValue: '目标', pageNum: 2, pageSize: 10 })
  expect(transport).toHaveBeenCalledWith(
    '/dts-api/admin-api/system/tenant/page',
    expect.objectContaining({
      params: { name: '目标', pageNo: 2, pageSize: 10, status: 0 },
      skipPlatformPath: true,
    }),
  )
  expect(page.total).toBe(1)
  expect(createOperationTenantSelectOptions(page.rows)).toEqual([
    { value: '9007199254740993', label: '目标租户' },
  ])
})

it('保留系统权限失败提示', async () => {
  transport.mockResolvedValueOnce({ code: 403, msg: '无权查询租户' })
  await expect(pageOperationTenants({})).rejects.toThrow('无权查询租户')
})
