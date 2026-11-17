import { beforeEach, describe, expect, it, vi } from 'vitest'

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }))

vi.mock('@/request.ts', () => ({
  default: requestMock,
}))

vi.mock('../auth', () => ({
  getDim3dHeaders: () => ({ Authorization: 'Bearer test-token', ClientId: 'test-client' }),
}))

// 请求契约测试固定同源前缀，避免开发者本机环境文件改变测试断言。
vi.mock('../constants', () => ({ DIM3D_OPERATION_API_PREFIX: '/api' }))

import { addDim3dIcon, editDim3dIcon, pageDim3dIcon } from '../icon'

describe('阶段四图标分页响应适配', () => {
  beforeEach(() => {
    requestMock.mockReset()
  })

  it.each([
    [401, '当前登录已过期，请重新登录'],
    [403, '图片列表接口禁止访问'],
  ] as const)('不会把业务 %i 空 data 误判成空列表', async (code, message) => {
    requestMock.mockResolvedValue({ code, msg: message, data: null })

    await expect(pageDim3dIcon({ pageNum: 1, pageSize: 10 })).rejects.toMatchObject({
      code,
      status: code,
      message,
    })
  })

  it('使用 operation 前缀、临时鉴权头和原始分页参数请求列表', async () => {
    requestMock.mockResolvedValue({ code: 200, total: 0, rows: [] })
    const params = {
      pageNum: 2,
      pageSize: 20,
      iconName: '测试图标',
      category: 'EQUIPMENT',
      resourceBelong: 'SYSTEM' as const,
      status: 'ONLINE' as const,
    }

    await pageDim3dIcon(params)

    // 单元测试不注入部署服务器，接口应从同源 `/api` 派生，避免测试重新固化真实 IP。
    expect(requestMock).toHaveBeenCalledWith(
      '/api/dim3d/icon/page',
      expect.objectContaining({
        method: 'GET',
        params,
        headers: { Authorization: 'Bearer test-token', ClientId: 'test-client' },
        passAuth: true,
      }),
    )
  })

  it('保留合法的 total=0、rows=[] 空列表响应', async () => {
    requestMock.mockResolvedValue({ code: 200, total: 0, rows: [] })

    await expect(pageDim3dIcon({ pageNum: 1, pageSize: 10 })).resolves.toEqual({
      code: 200,
      total: 0,
      rows: [],
    })
  })

  it('缺少分页字段时报告响应格式异常，不渲染成 0 条数据', async () => {
    requestMock.mockResolvedValue({ code: 200, data: null })

    await expect(pageDim3dIcon({ pageNum: 1, pageSize: 10 })).rejects.toMatchObject({
      code: 200,
      status: 200,
      message: '图片列表接口返回格式异常',
    })
  })

  it('将当前后端的 data.list 分页投影为页面 rows，保留字符串文件编号', async () => {
    const row = { id: '9223372036854770000', iconFileId: '9223372036854770001' }
    requestMock.mockResolvedValue({ code: 200, data: { total: 1, list: [row] } })
    await expect(pageDim3dIcon({ pageNum: 1, pageSize: 10 })).resolves.toMatchObject({
      total: 1,
      rows: [row],
    })
  })

  it('新增回执保留服务端字符串编号', async () => {
    requestMock.mockResolvedValue({ code: 200, data: '9223372036854770000' })
    await expect(addDim3dIcon({ iconName: '设备', category: 'DEVICE_ICON', resourceBelong: 'MINE', iconFileId: '17' }))
      .resolves.toMatchObject({ code: 200, data: '9223372036854770000' })
  })

  it('新增和编辑遇到自定义业务错误时保留表单并返回真实原因', async () => {
    const body = { iconName: '设备', category: 'DEVICE_ICON', resourceBelong: 'MINE' as const, iconFileId: '17' }
    requestMock.mockResolvedValue({ code: 1600001, msg: '无权维护系统资源', data: null })
    await expect(addDim3dIcon(body)).rejects.toMatchObject({ code: 1600001, message: '无权维护系统资源' })
    await expect(editDim3dIcon('18', body)).rejects.toMatchObject({ code: 1600001, message: '无权维护系统资源' })
  })
})
