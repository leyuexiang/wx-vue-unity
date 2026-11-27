import { expect, it, vi } from 'vitest'

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }))
vi.mock('@/request.ts', () => ({ default: requestMock }))
vi.mock('../auth', () => ({ getDim3dHeaders: () => ({}) }))
vi.mock('../constants', () => ({
  DIM3D_OPERATION_API_PREFIX: '/admin-api',
  DIM3D_PLATFORM_API_PREFIX: '/api',
}))

import { DIM3D_TEMPLATE_TYPE, editDim3dSceneTemplate, getDim3dSceneTemplateInfo, getDim3dTemplateInfo, pageDim3dTemplate } from '../template'
import { createSnapshotTemplateEditPayload } from '@/views/resourceManage/templateManage/templateEditState'

/** 编辑表单用字典类型编码匹配下拉选项，详情的契约枚举需在请求边界转换。 */
it.each([
  ['INDUSTRY', DIM3D_TEMPLATE_TYPE.INDUSTRY],
  ['EXHIBITION', DIM3D_TEMPLATE_TYPE.EXHIBITION],
  [DIM3D_TEMPLATE_TYPE.INDUSTRY, DIM3D_TEMPLATE_TYPE.INDUSTRY],
])('将模板详情类型 %s 回显为 %s', async (templateType, expected) => {
  requestMock.mockResolvedValue({ code: 200, data: { templateType, templateFileId: '9007199254740994' } })
  await expect(getDim3dTemplateInfo('42')).resolves.toMatchObject({
    code: 200,
    data: { templateType: expected, templateFileId: '9007199254740994' },
  })
})

/** 新旧分页都应保留快照模板身份，以便按来源发起管理操作。 */
it('兼容合并列表的根级与内层分页', async () => {
  const row = { id: '42', templateSceneId: '77', recordKind: 'SNAPSHOT' }
  requestMock.mockResolvedValueOnce({ code: 200, total: 1, rows: [row] })
  requestMock.mockResolvedValueOnce({ code: 200, data: { total: 1, list: [row] } })
  const params = { includeSnapshots: true }
  await expect(pageDim3dTemplate(params)).resolves.toMatchObject({ total: 1, rows: [row] })
  expect(requestMock).toHaveBeenLastCalledWith('/api/dim3d/template/page', expect.objectContaining({ params }))
  await expect(pageDim3dTemplate(params)).resolves.toMatchObject({ total: 1, rows: [row] })
})

/** 快照编辑读取轻量详情，用真实目录编号提交空描述与封面文件号。 */
it('快照元数据通过场景模板入口回读与提交', async () => {
  const id = '9007199254740993'
  requestMock.mockResolvedValueOnce({ code: 200, data: { templateType: 'EXHIBITION', coverAssetId: '6001' } })
  await expect(getDim3dSceneTemplateInfo(id, { params: { includeRevision: false } })).resolves.toMatchObject({
    data: { templateType: DIM3D_TEMPLATE_TYPE.EXHIBITION, coverAssetId: '6001' },
  })
  expect(requestMock).toHaveBeenLastCalledWith(`/api/dim3d/scene/template/info/${id}`, expect.objectContaining({
    method: 'GET', params: { includeRevision: false },
  }))

  const payload = createSnapshotTemplateEditPayload({
    templateName: ' 更新后的模板 ', templateDesc: ' ', templateType: DIM3D_TEMPLATE_TYPE.EXHIBITION,
    category: ' NEW ', templateFileId: '', coverImageId: '6002',
  })
  expect(payload).toEqual({
    templateName: '更新后的模板', templateDesc: '', templateType: DIM3D_TEMPLATE_TYPE.EXHIBITION,
    category: 'NEW', coverAssetId: '6002',
  })
  requestMock.mockResolvedValueOnce({ code: 200, data: null })
  await editDim3dSceneTemplate(id, payload!)
  expect(requestMock).toHaveBeenLastCalledWith(`/api/dim3d/scene/template/edit/${id}`, expect.objectContaining({
    method: 'PUT', data: payload,
  }))
})
