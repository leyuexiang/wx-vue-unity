import { describe, expect, it } from 'vitest'
import { createSceneDefinition } from '@/scene-platform'
import { serializeSceneDefinitionToFourPackages } from '../sceneFourPackage'
import { assembleSceneDefinitionFromRuntimeFragments } from '../sceneRuntimeFragmentAssembler'
import { validateEditorSceneAssets } from '../editorSceneAssetValidation'
import { projectSceneForUnity } from '@/unity-runtime/runtime/projectSceneForUnity'

// 托管模型保存编号而非临时下载地址，重开后仍交给Unity鉴权解析当前版本。
describe('Unity托管模型四包恢复', () => {
  it('多个实例共用稳定资源，四包不保存定位符或凭证，重开可再次投影', () => {
    const resourceId = '2117612791529533441'
    const scene = createSceneDefinition({ id: 'scene-managed', name: '资源闭环', type: 'local3d',
      coordinateSystem: { kind: 'local', unit: 'meter', upAxis: 'Y', gridEnabled: true },
      objects: [1, 2].map((index) => ({ id: `car-${index}`, name: `蓝车${index}`, type: 'model', visible: true, locked: false, order: index,
        transform: { kind: 'local', position: [index, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        asset: { id: resourceId, kind: 'unity-model', url: `unity-resource://${resourceId}` } })),
    })
    expect(validateEditorSceneAssets(scene).valid).toBe(true)
    const payload = serializeSceneDefinitionToFourPackages(scene)
    expect(JSON.stringify(payload)).not.toContain('unity-resource://')
    expect(JSON.parse(payload.dependenciesJson).resources).toHaveLength(1)
    const restored = assembleSceneDefinitionFromRuntimeFragments({ manifest: { fragmentType: 'manifest', fragmentKey: scene.id, contentJson: JSON.stringify(payload) }, options: { sceneId: scene.id } })
    expect(restored.objects.map((object) => object.asset)).toEqual(scene.objects.map((object) => object.asset))
    expect(validateEditorSceneAssets(restored).valid).toBe(true)
    expect(projectSceneForUnity(restored).resources).toEqual([{ resourceKey: resourceId, assetId: resourceId, kind: 'unity-model' }])
    restored.objects[0]!.asset!.url = 'https://unrelated.invalid/model.glb'
    expect(validateEditorSceneAssets(restored).valid).toBe(false)
    restored.objects[0]!.asset!.url = `unity-resource://${resourceId}`
    restored.objects[0]!.type = 'image'
    expect(validateEditorSceneAssets(restored).valid).toBe(false)
  })
})
