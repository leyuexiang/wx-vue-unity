import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSceneDefinition, mapEditorCreationToSceneObject } from '@/scene-platform'
import { loadDim3dModelGroups } from '@/views/sceneEdit/SceneLeftPanel/components/ResourcePanel/modelResource'
import { projectSceneForUnity } from '@/unity-runtime/runtime/projectSceneForUnity'
import { validateEditorSceneAssets } from '../editorSceneAssetValidation'
import { saveEditorSceneToDim3d } from '../editorDim3dSceneSaveService'
import { assembleSceneDefinitionFromRuntimeFragments } from '../sceneRuntimeFragmentAssembler'
import { resolveSceneAssetUrls } from '../sceneAssetUrlResolver'

const api = vi.hoisted(() => ({ page: vi.fn(), detail: vi.fn(), file: vi.fn() }))
vi.mock('@/servers/manual/dim3d/api/model', () => ({ pageDim3dModel: api.page, getDim3dModelInfo: api.detail }))
vi.mock('@/servers/manual/dim3d/api/resource', () => ({
  getDim3dResourceInfo: api.file,
  buildDim3dResourceUrl: (path: string) => `https://legacy.invalid/${path}`,
}))
vi.mock('@/servers/manual/dim3d/api/dictionary', () => ({
  getDim3dModelCategoryDictionary: async () => ({ data: [] }),
  createDim3dModelCategoryLabelMap: () => new Map(),
  getDim3dModelCategoryLabel: (_: unknown, code: string) => code,
}))

const resourceId = '9007199254740993'
const legacyFileId = '9007199254740997'
const signedUrl = 'https://private.invalid/model.glb?signature=temporary'

describe('受控发布模型从资源市场进入场景', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    api.file.mockResolvedValue({ code: 200, data: { id: legacyFileId, resourceType: 'MODEL', resourceRelativePath: 'car.glb' } })
  })

  it('使用目录关联加载草地，四包保存并重开后恢复位置、缩放及稳定资源身份', async () => {
    api.page.mockResolvedValue({ rows: [{ id: '11', resourceId, modelName: '草地', category: '植被', modelFileId: legacyFileId, modelFileUrl: signedUrl }] })
    const groups = await loadDim3dModelGroups('SYSTEM')
    expect(api.page).toHaveBeenCalledWith(expect.objectContaining({ resourceBelong: 'SYSTEM', status: 'ONLINE' }))
    expect(api.detail).not.toHaveBeenCalled()
    expect(api.file).not.toHaveBeenCalled()
    const object = mapEditorCreationToSceneObject(groups[0]!.children[0]!, { point: { clientX: 20, clientY: 10 } })!
    expect(object.asset).toMatchObject({ id: resourceId, kind: 'unity-model', url: `unity-resource://${resourceId}` })
    object.transform = { kind: 'local', position: [2, 3, 4], rotation: [0, 0.5, 0], scale: [1, 2, 3] }
    const scene = createSceneDefinition({ id: '2089645792212000769', name: '草地联调', type: 'local3d',
      coordinateSystem: { kind: 'local', unit: 'meter', upAxis: 'Y', gridEnabled: true }, objects: [object] })
    const saveAll = vi.fn(async (body: { sceneId: string }) => ({ code: 200, data: { sceneId: body.sceneId, conflict: false } }))
    await saveEditorSceneToDim3d(scene, { sceneId: scene.id, lockToken: 'test-lock' }, { saveAll, createRequestId: () => 'market-round-trip' })
    const packages = saveAll.mock.calls[0]![0] as unknown as { dependenciesJson: string }
    expect(JSON.stringify(packages)).not.toMatch(/unity-resource:\/\/|private\.invalid|signature=|9007199254740997/)
    expect(await resolveSceneAssetUrls(packages.dependenciesJson)).toEqual({})
    const reopened = assembleSceneDefinitionFromRuntimeFragments({ manifest: { fragmentType: 'manifest', fragmentKey: scene.id,
      contentJson: JSON.stringify(packages) }, options: { sceneId: scene.id } })
    expect(validateEditorSceneAssets(reopened).valid).toBe(true)
    expect(reopened.objects[0]!.transform).toEqual(object.transform)
    expect(projectSceneForUnity(reopened).resources).toEqual([{ resourceKey: resourceId, assetId: resourceId, kind: 'unity-model' }])
    expect(api.file).not.toHaveBeenCalled()
  })

  it('兼容仅详情返回关联以及旧文件目录，拒绝失真的大整数关联', async () => {
    api.page.mockResolvedValue({ rows: [
      { id: '12', modelName: '详情关联', category: '模型' },
      { id: '13', modelName: '历史模型', modelFileId: legacyFileId, category: '模型' },
      { id: '14', modelName: '无效关联', resourceId: Number(resourceId), modelFileId: legacyFileId, category: '模型' },
    ] })
    api.detail.mockResolvedValue({ code: 200, data: { id: '12', resourceId } })
    const groups = await loadDim3dModelGroups('MINE')
    expect(groups[0]!.children.map(({ name, filePath }) => [name, filePath])).toEqual([
      ['详情关联', `unity-resource://${resourceId}`], ['历史模型', 'https://legacy.invalid/car.glb'],
    ])
    expect(api.file).toHaveBeenCalledTimes(1)
    expect(api.file).toHaveBeenCalledWith(legacyFileId, expect.anything())
  })
})
