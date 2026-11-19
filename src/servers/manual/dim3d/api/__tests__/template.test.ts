import { expect, it, vi } from 'vitest'

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }))
vi.mock('@/request.ts', () => ({ default: requestMock }))
vi.mock('../auth', () => ({ getDim3dHeaders: () => ({}) }))
vi.mock('../constants', () => ({ DIM3D_OPERATION_API_PREFIX: '/api' }))

import { DIM3D_TEMPLATE_TYPE, getDim3dTemplateInfo, pageDim3dTemplate } from '../template'

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
  await expect(pageDim3dTemplate(params)).resolves.toMatchObject({ total: 1, rows: [row] })
})
