import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getTemplateSnapshotLabel, resolveTemplateSnapshotMetadata } from '../templateState'

const { request } = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('@/request.ts', () => ({ default: request }))
vi.mock('@/servers/manual/dim3d/api/auth', () => ({ getDim3dHeaders: () => ({}) }))
vi.mock('@/servers/manual/dim3d/api/constants', () => ({ DIM3D_PLATFORM_API_PREFIX: '/api' }))

beforeEach(() => request.mockReset())

describe('模板卡片及创建弹窗的快照资料', () => {
  it('合并分页缺字段时用模板业务编号补查，并校验返回的快照编号', async () => {
    // 保存范围和来源类型曾被合并列表省略；详情查询不能把快照场景编号当作目录编号。
    const row = { id: '8101', templateSceneId: '8201' }
    request.mockResolvedValueOnce({ data: { templateSceneId: '8201', saveScope: 'TWOD', sceneType: 'gis' } })

    const metadata = await resolveTemplateSnapshotMetadata(row)
    expect(request).toHaveBeenCalledWith('/api/dim3d/scene/template/info/8101', expect.anything())
    expect(metadata).toEqual({ saveScope: 'twoD', sceneType: 'gis' })
    expect(getTemplateSnapshotLabel(metadata)).toBe('2D')

    request.mockResolvedValueOnce({ data: { templateSceneId: '8202', saveScope: 'threeD', sceneType: 'local3d' } })
    const mismatched = await resolveTemplateSnapshotMetadata(row)
    expect(getTemplateSnapshotLabel(mismatched)).toBe('')
  })

  it('保持分页已有的三维范围并补齐来源场景类型', async () => {
    const row = { id: '8102', templateSceneId: '8202', saveScope: 'threeD' as const }
    request.mockResolvedValueOnce({ data: { templateSceneId: '8202', sourceSceneType: ' GIS ' } })

    const metadata = await resolveTemplateSnapshotMetadata(row)
    expect(getTemplateSnapshotLabel(metadata)).toBe('3D · GIS场景')
  })

  it('内容齐全的快照直接生成标签，文件型模板无需读取快照详情', async () => {
    const mixed = await resolveTemplateSnapshotMetadata({
      id: '8103', templateSceneId: '8203', saveScope: 'all', sceneType: 'local3d',
    })
    const file = await resolveTemplateSnapshotMetadata({ id: '8104' })
    expect(getTemplateSnapshotLabel(mixed)).toBe('2D+3D · 非GIS场景')
    expect(getTemplateSnapshotLabel(file)).toBe('')
    expect(request).not.toHaveBeenCalled()
  })
})
