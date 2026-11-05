import { describe, expect, it, vi } from 'vitest'
import { createSceneDefinition, type SceneObject } from '@/scene-platform'
import type { SceneDefinition as UnityScene } from '@/scene-core'
import { serializeSceneDefinitionToFourPackages } from '@/integrations/scene/sceneFourPackage'
import { UnityEditorSceneRuntime } from '../runtime/UnityEditorSceneRuntime'

const missingId = '2113165756231753730'
const createFixture = (mode: 'cloud' | 'webgpu' = 'webgpu') => {
  const onWarnings = vi.fn()
  const runtime = new UnityEditorSceneRuntime('gis', { mode, getHost: () => null, onStatus: vi.fn(), onWarnings })
  const scene = createSceneDefinition({ id: 'gis', name: 'GIS', type: 'gis', coordinateSystem: {
    kind: 'wgs84', defaultLongitude: 110, defaultLatitude: 19, defaultHeight: 0, terrainEnabled: false,
  } })
  const transform: SceneObject['transform'] = { kind: 'geo', longitude: 110, latitude: 19, height: 0,
    heading: 0, pitch: 0, roll: 0, scale: 1, altitudeMode: 'absolute' }
  scene.objects = [
    { id: 'missing', name: '用户模型', type: 'model', visible: true, locked: false, order: 0, transform,
      asset: { id: 'user-model-resource', kind: 'glb', url: 'https://example.test/model.glb', metadata: { assetId: missingId } } },
    { id: 'published', name: '已发布模型', type: 'model', visible: true, locked: false, order: 1, transform,
      asset: { id: 'published-resource', kind: 'glb', url: 'https://example.test/published.glb', metadata: { assetId: '1' } } },
    { id: 'box', name: 'Box', type: 'primitive', visible: true, locked: false, order: 2, transform, metadata: { editorGeometryType: 'BoxGeometry' } },
  ]
  const unity = { loadScene: vi.fn(async (draft: UnityScene) => {
    if (draft.resources.some((resource) => resource.assetId === missingId)) throw new Error(`当前美术版本不存在资源键: ${missingId}`)
  }), updateObject: vi.fn(async () => {}), setSelection: vi.fn() }
  Object.assign(runtime, { unity })
  return { runtime, scene, unity, onWarnings }
}

describe('missing models in a Unity art release', () => {
  it.each(['cloud', 'webgpu'] as const)('keeps a missing model in saved data and renders the available scene (%s)', async (mode) => {
    const { runtime, scene, unity, onWarnings } = createFixture(mode)
    const saved = serializeSceneDefinitionToFourPackages(scene)
    await runtime.loadScene(scene)
    expect(unity.loadScene).toHaveBeenCalledTimes(2)
    const rendered = unity.loadScene.mock.calls[1]![0]
    expect(rendered.objects.map((object) => object.instanceId)).toEqual(['published', 'box'])
    expect(rendered.resources.map((resource) => resource.assetId)).toEqual(['1'])
    expect(runtime.hasObject('missing')).toBe(true)
    expect(serializeSceneDefinitionToFourPackages(scene)).toEqual(saved)
    expect(onWarnings).toHaveBeenLastCalledWith([expect.stringContaining(`用户模型（资源 ${missingId}）`)])
    runtime.setSelectedObject('missing')
    expect(unity.setSelection).toHaveBeenLastCalledWith(null)
    await runtime.upsertObject({ ...scene.objects[0]!, name: '更名模型' })
    expect(unity.updateObject).not.toHaveBeenCalled()
    expect(onWarnings).toHaveBeenLastCalledWith([expect.stringContaining('更名模型')])
    await runtime.updateSceneLayers([])
    expect(unity.loadScene).toHaveBeenCalledTimes(3)
    expect(unity.loadScene.mock.calls[2]![0].objects.map((object) => object.instanceId)).toEqual(['published', 'box'])
    runtime.removeObject('missing')
    expect(onWarnings).toHaveBeenLastCalledWith([])
    expect(unity.loadScene).toHaveBeenCalledTimes(3)
  })

  it('保留缺失父模型的子树数据，资源恢复后一起提交', async () => {
    const { scene, unity } = createFixture()
    const runtime = new UnityEditorSceneRuntime('local3d', { mode: 'webgpu', getHost: () => null, onStatus: vi.fn() })
    Object.assign(runtime, { unity })
    const local = createSceneDefinition({ id: 'local', name: '本地场景', type: 'local3d',
      coordinateSystem: { kind: 'local', unit: 'meter', upAxis: 'Y', gridEnabled: true },
      objects: scene.objects.map((object) => ({ ...object,
        ...(object.id === 'box' ? { parentInstanceId: 'missing' } : {}),
        transform: { kind: 'local', position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 },
      })),
    })
    await runtime.loadScene(local)
    expect(unity.loadScene.mock.calls[1]![0].objects.map((object) => object.instanceId)).toEqual(['published'])
    expect(runtime.hasObject('box')).toBe(true)
    runtime.setSelectedObject('box')
    expect(unity.setSelection).toHaveBeenLastCalledWith(null)
    const parent = local.objects[0]!
    await runtime.upsertObject({ ...parent, asset: { ...parent.asset!, metadata: { assetId: '1' } } })
    expect(unity.loadScene.mock.calls[2]![0].objects.find((object) => object.instanceId === 'box')?.parentInstanceId).toBe('missing')
  })

  it('accepts the canonical model/ prefix emitted by a resource catalog', async () => {
    const { runtime, scene, unity } = createFixture()
    unity.loadScene.mockImplementation(async (draft) => {
      if (draft.resources.some((resource) => resource.assetId === missingId)) throw new Error(`当前美术版本不存在资源键: model/${missingId}`)
    })
    await runtime.loadScene(scene)
    expect(unity.loadScene).toHaveBeenCalledTimes(2)
  })

  it.each(['资源包完整性校验失败', '资源请求超时', '当前美术版本不存在资源键: unknown-id'])('does not hide an unrelated failure: %s', async (message) => {
    const { runtime, scene, unity } = createFixture()
    unity.loadScene.mockRejectedValue(new Error(message))
    await expect(runtime.loadScene(scene)).rejects.toThrow(message)
    expect(unity.loadScene).toHaveBeenCalledTimes(1)
    expect(runtime.hasObject('missing')).toBe(false)
  })

  it('removes each missing resource at most once even when the release is missing every model', async () => {
    const { runtime, scene, unity } = createFixture()
    unity.loadScene.mockImplementation(async (draft) => {
      if (draft.resources.length) throw new Error(`当前美术版本不存在资源键: ${draft.resources[0]!.assetId}`)
    })
    await runtime.loadScene(scene)
    expect(unity.loadScene).toHaveBeenCalledTimes(3)
    expect(unity.loadScene.mock.calls[2]![0].objects.map((object) => object.instanceId)).toEqual(['box'])
  })

  it('reloads a model when its resource mapping changes and can restore a previously missing model', async () => {
    const { runtime, scene, unity, onWarnings } = createFixture()
    await runtime.loadScene(scene)
    const remapped = { ...scene.objects[0]!, asset: { ...scene.objects[0]!.asset!, metadata: { assetId: '1' } } }
    await runtime.upsertObject(remapped)
    expect(unity.loadScene.mock.calls[2]![0].objects.map((object) => object.instanceId)).toEqual(['missing', 'published', 'box'])
    expect(onWarnings).toHaveBeenLastCalledWith([])
    await runtime.upsertObject({ ...remapped, asset: scene.objects[0]!.asset })
    expect(unity.loadScene.mock.calls[3]![0].objects.map((object) => object.instanceId)).toEqual(['published', 'box'])
    expect(onWarnings).toHaveBeenLastCalledWith([expect.stringContaining(missingId)])
    expect(unity.updateObject).not.toHaveBeenCalled()
  })
})
