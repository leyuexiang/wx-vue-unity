import { afterEach, describe, expect, it } from 'vitest'
import { preserveUneditedThreeDDomain, releaseOriginalScenePackages, retainOriginalScenePackages } from '../twoDPackagePreservation'
import { createCommandBus, createDefaultEnviroWeatherConfig, createEnviroWeatherEffect, createSceneDefinition, createSceneStore } from '@/scene-platform'
import { serializeSceneDefinitionToFourPackages, type SceneFourPackagePayload } from '../sceneFourPackage'
import { assembleSceneDefinitionFromRuntimeFragments } from '../sceneRuntimeFragmentAssembler'
import { updateEditorSceneGis } from '../editorSceneGisAdapter'

const sceneId = 'migration-preservation'
const payload = (dependencies: object): SceneFourPackagePayload => ({
  sceneJson: JSON.stringify({ name: '原场景', customSceneExtension: { keep: true } }),
  threeDJson: '{ "objects": [{"instanceId":"三维模型","unknownFutureField":true}], "customRenderer": {"version":9} }',
  twoDJson: JSON.stringify({ canvas: { width: 1920, height: 1080 }, components: [], layerTree: [], customTwoDExtension: true }),
  dependenciesJson: JSON.stringify(dependencies),
})
afterEach(() => releaseOriginalScenePackages(sceneId))

describe('二维编辑的三维无损保存保护', () => {
  it('Unity 已接管的实例变换能保存重开，同时保留原始实例和未知扩展', () => {
    const before = payload({ resources: [{ resourceKey: 'grass', owners: [{ domain: 'threeD', instanceId: '三维模型' }] }] })
    before.threeDJson = JSON.stringify({ objects: [
      { instanceId: '三维模型', unknownFutureField: true, transform: { kind: 'local', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
      { instanceId: '未接管模型', unknownFutureField: true },
    ], customRenderer: { version: 9 } })
    retainOriginalScenePackages(sceneId, before)
    const transform = { kind: 'local', position: [2, 0.5, 3], rotation: [0, 0.5, 0], scale: [1.5, 2, 1.25] }
    const generated = { ...before, threeDJson: JSON.stringify({ objects: [
      { instanceId: '三维模型', transform }, { instanceId: '未接管模型', transform },
    ] }) }
    const saved = preserveUneditedThreeDDomain(sceneId, generated, new Set(['三维模型']))
    expect(JSON.parse(saved.threeDJson)).toEqual({ objects: [
      { instanceId: '三维模型', unknownFutureField: true, transform },
      { instanceId: '未接管模型', unknownFutureField: true },
    ], customRenderer: { version: 9 } })
    expect(JSON.parse(saved.dependenciesJson).resources).toEqual(JSON.parse(before.dependenciesJson).resources)
    expect(preserveUneditedThreeDDomain(sceneId, generated).threeDJson).toBe(before.threeDJson)
  })
  it('persists Enviro edits and deletion through the production preservation path without replacing GIS or extensions', () => {
    const original = payload({ resources: [] })
    const originalThreeD = { ...JSON.parse(original.threeDJson), baseConfig: { weather: {}, gisLayers: [{ vendor: 'cesium' }], future: { keep: true } } }
    original.threeDJson = JSON.stringify(originalThreeD)
    retainOriginalScenePackages(sceneId, original)
    const config = createDefaultEnviroWeatherConfig(); config.presetId = 'snow'; config.overrides.clouds.enabled = false
    const scene = createSceneDefinition({ id: sceneId, name: '天气', type: 'local3d',
      coordinateSystem: { kind: 'local', unit: 'meter', upAxis: 'Y', gridEnabled: true }, effects: [createEnviroWeatherEffect(config)] })
    const result = preserveUneditedThreeDDomain(sceneId, serializeSceneDefinitionToFourPackages(scene))
    expect(JSON.parse(result.threeDJson)).toEqual({ ...originalThreeD, baseConfig: { ...originalThreeD.baseConfig, weather: config } })
    const restored = assembleSceneDefinitionFromRuntimeFragments({ manifest: { fragmentType: 'manifest', contentJson: JSON.stringify(result) }, options: { sceneId } })
    expect(restored.effects[0]?.params).toEqual(config)
    retainOriginalScenePackages(sceneId, result)
    scene.effects = []
    const deleted = preserveUneditedThreeDDomain(sceneId, serializeSceneDefinitionToFourPackages(scene))
    expect(JSON.parse(deleted.threeDJson).baseConfig.weather).toEqual({})
    expect(JSON.parse(deleted.threeDJson).objects).toEqual(originalThreeD.objects)
  })

  it('保存 GIS 改动时从两处图层记录移除旧底图，并保留其他图层和扩展', () => {
    const scene = createSceneDefinition({ id: sceneId, name: 'GIS', type: 'gis',
      coordinateSystem: { kind: 'wgs84', defaultLongitude: 110, defaultLatitude: 19, defaultHeight: 0, terrainEnabled: true } })
    const layer = { type: 'imagery' as const, visible: true, locked: true, provider: 'xyz', url: 'https://example.test/{z}/{x}/{y}' }
    scene.layers = [
      { ...layer, id: 'base', name: '底图', order: 0 },
      { ...layer, id: 'overlay', name: '叠加图层', order: 1 },
    ]
    const original = serializeSceneDefinitionToFourPackages(scene)
    const originalThreeD = JSON.parse(original.threeDJson)
    originalThreeD.baseConfig.future = { keep: true }
    originalThreeD.layers[1].futureLayer = 'keep'
    original.threeDJson = JSON.stringify(originalThreeD)
    retainOriginalScenePackages(sceneId, original)
    const store = createSceneStore(scene)
    const bus = createCommandBus(store)
    updateEditorSceneGis({ store, execute: bus.execute, canEdit: () => true,
      source: { kind: 'imagery', tile: null }, origin: { longitude: 111, latitude: 20 }, appearance: { contrast: 1.3 } })

    const saved = preserveUneditedThreeDDomain(sceneId, serializeSceneDefinitionToFourPackages(store.getScene()),
      undefined, undefined, undefined, store.captureSaveEdits())
    const threeD = JSON.parse(saved.threeDJson)
    expect(threeD.baseConfig).toMatchObject({ future: { keep: true }, settings: { three: { gis: { contrast: 1.3, imagerySourceId: null } } } })
    expect(threeD.layers).toMatchObject([{ layerKey: 'overlay', futureLayer: 'keep' }])
    const restored = assembleSceneDefinitionFromRuntimeFragments({ manifest: { fragmentType: 'manifest', contentJson: JSON.stringify(saved) }, options: { sceneId } })
    expect(restored.coordinateSystem).toMatchObject({ defaultLongitude: 111, defaultLatitude: 20 })
    expect(restored.layers.map(layer => layer.id)).toEqual(['overlay'])
  })

  it('三维原文和未知扩展字段不受二维修改影响', () => {
    const before = payload({ futureDependency: { keep: true }, behaviors: [{ owner: { domain: 'threeD', instanceId: '三维模型' }, privateData: 42 }] })
    retainOriginalScenePackages(sceneId, before)
    const generated = { ...payload({ behaviors: [{ owner: { domain: 'twoD', instanceId: '二维按钮' }, click: true }] }),
      threeDJson: '{}', sceneJson: '{"name":"修改名称"}', twoDJson: '{"components":[{"instanceId":"二维按钮"}]}' }
    const result = preserveUneditedThreeDDomain(sceneId, generated)
    expect(result.threeDJson).toBe(before.threeDJson)
    expect(JSON.parse(result.sceneJson)).toEqual({ name: '修改名称', customSceneExtension: { keep: true } })
    expect(JSON.parse(result.twoDJson).customTwoDExtension).toBe(true)
    expect(JSON.parse(result.dependenciesJson).behaviors).toHaveLength(2)
    expect(JSON.parse(result.dependenciesJson).futureDependency).toEqual({ keep: true })
  })

  it('删除二维资源引用时保留共享资源的三维拥有者', () => {
    const owner3d = { domain: 'threeD', ownerType: 'instance', instanceId: '三维模型' }
    const owner2d = { domain: 'twoD', ownerType: 'instance', instanceId: '已删除部件' }
    retainOriginalScenePackages(sceneId, payload({ resources: [{ resourceKey: '共享图片', assetId: '图片编号', owners: [owner3d, owner2d] }] }))
    const result = preserveUneditedThreeDDomain(sceneId, payload({ resources: [] }))
    expect(JSON.parse(result.dependenciesJson).resources).toEqual([{ resourceKey: '共享图片', assetId: '图片编号', owners: [owner3d] }])
  })

  it('当前二维拥有者和原有三维拥有者合并到同一资源', () => {
    const owner3d = { domain: 'threeD', instanceId: '三维模型' }
    const owner2d = { domain: 'twoD', instanceId: '新图片' }
    retainOriginalScenePackages(sceneId, payload({ resources: [{ resourceKey: '共享图片', assetId: '编号', unknown: 1, owners: [owner3d] }] }))
    const result = preserveUneditedThreeDDomain(sceneId, payload({ resources: [{ resourceKey: '共享图片', assetId: '编号', owners: [owner2d] }] }))
    expect(JSON.parse(result.dependenciesJson).resources).toEqual([{ resourceKey: '共享图片', assetId: '编号', unknown: 1, owners: [owner3d, owner2d] }])
  })

  it('没有原始混合场景时不保留上一张场景的数据，损坏数据禁止进入编辑', () => {
    const generated = payload({ resources: [] })
    expect(preserveUneditedThreeDDomain(sceneId, generated)).toBe(generated)
    expect(() => retainOriginalScenePackages(sceneId, { ...generated, threeDJson: '[' })).toThrow()
  })

  it('追加新模型、几何体和共享依赖，同时原样保留旧三维目标与未知配置', () => {
    const oldOwner = { domain: 'threeD', instanceId: '三维模型' }
    const newOwner = { domain: 'threeD', instanceId: '新增模型' }
    const twoDOwner = { domain: 'twoD', instanceId: '二维图片' }
    const before = payload({ resources: [{ resourceKey: '共享资源', assetId: '编号', unknown: true, owners: [oldOwner] }] })
    retainOriginalScenePackages(sceneId, before)
    const generated = { ...payload({
      resources: [{ resourceKey: '共享资源', assetId: '编号', owners: [oldOwner, newOwner, twoDOwner] }],
      behaviors: [{ owner: newOwner, eventType: 'click' }],
    }), threeDJson: JSON.stringify({ objects: [
      { instanceId: '三维模型', unknownFutureField: false },
      { instanceId: '新增模型', layerKey: '新图层', transform: { position: [1, 2, 3] } },
    ], components: [{ instanceId: '新增几何体' }], layers: [{ layerKey: '新图层', name: '分组' }], customRenderer: {} }) }
    const saved = preserveUneditedThreeDDomain(sceneId, generated)
    const threeD = JSON.parse(saved.threeDJson)
    expect(threeD.objects).toEqual([
      { instanceId: '三维模型', unknownFutureField: true },
      { instanceId: '新增模型', layerKey: '新图层', transform: { position: [1, 2, 3] } },
    ])
    expect(threeD.components).toEqual([{ instanceId: '新增几何体' }])
    expect(threeD.layers).toEqual([{ layerKey: '新图层', name: '分组' }])
    expect(threeD.customRenderer).toEqual({ version: 9 })
    expect(JSON.parse(saved.dependenciesJson).resources).toEqual([
      { resourceKey: '共享资源', assetId: '编号', unknown: true, owners: [oldOwner, newOwner, twoDOwner] },
    ])
    expect(JSON.parse(saved.dependenciesJson).behaviors).toEqual([{ owner: newOwner, eventType: 'click' }])
    // 所有新增实例撤销后恢复原三维原文，且不会把已撤销实例的依赖带回下次保存。
    const undone = preserveUneditedThreeDDomain(sceneId, payload({ resources: [] }))
    expect(undone.threeDJson).toBe(before.threeDJson)
    expect(JSON.parse(undone.dependenciesJson).resources[0].owners).toEqual([oldOwner])
  })
})
