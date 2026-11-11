import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCommandBus, createSceneDefinition, createSceneStore } from '@/scene-platform'
import { createRuntimeBridge } from '@/scene-platform/runtime/runtimeBridge'
import { MemorySceneRuntime } from '@/scene-platform/runtime/memory/memorySceneRuntime'
import { UnityEditorSceneRuntime } from '@/unity-runtime/runtime/UnityEditorSceneRuntime'
import { ensureEditorGisDefaultImageryLayer } from '../editorGisDefaultLayerAdapter'
import { projectSceneForUnity } from '@/unity-runtime/runtime/projectSceneForUnity'
import { serializeSceneDefinitionToFourPackages } from '../sceneFourPackage'
import { assembleSceneDefinitionFromRuntimeFragments } from '../sceneRuntimeFragmentAssembler'
import { DEFAULT_GIS_SOURCE, getEditorGisAppearance, getEditorGisBaseLayer, getEditorGisSourceKey, setEditorGisEditGuard, updateEditorSceneGis, type GisTileRecord } from '../editorSceneGisAdapter'

const tile: GisTileRecord = { id: 25, gisName: '测试地图', path: '/tile/wenchang', dataType: 'SATELLITE', coordinate: 'WGS84', level: 17, tileSize: '256', fileName: 'tile', sliceFlag: false, sliceRule: 'TMS', latitude: '19', longitude: '110' }
function setup(type: 'gis' | 'local3d' = 'gis') {
  const store = createSceneStore(createSceneDefinition({ id: 'gis-settings', name: 'GIS', type,
    coordinateSystem: type === 'gis' ? { kind: 'wgs84', defaultLongitude: 104.0668, defaultLatitude: 30.5728, defaultHeight: 12, terrainEnabled: true } : { kind: 'local', unit: 'meter', upAxis: 'Y', gridEnabled: true },
  }))
  const bus = createCommandBus(store)
  return { store, bus, update: (change: Partial<Parameters<typeof updateEditorSceneGis>[0]>) => updateEditorSceneGis({ store, execute: bus.execute, canEdit: () => true, ...change }) }
}
let releaseGuard = () => {}
afterEach(() => { releaseGuard() })

describe('GIS base settings', () => {
  it('persists appearance, sources and origin through four packages and projects them into Unity', () => {
    const { store, update } = setup()
    update({ appearance: { brightness: 1.3, contrast: 0.7, saturation: 0, terrainExaggeration: 4 } })
    update({ origin: { longitude: 110.75, latitude: 19.62 } })
    update({ source: { kind: 'imagery', tile } })
    update({ source: { kind: 'terrain', tile: { ...tile, id: 26, path: '/elevation/test' } } })
    const payload = serializeSceneDefinitionToFourPackages(store.getScene())
    const restored = assembleSceneDefinitionFromRuntimeFragments({
      manifest: { fragmentType: 'manifest', fragmentKey: store.getScene().id, contentJson: JSON.stringify(payload) }, options: { sceneId: store.getScene().id },
    })
    expect(getEditorGisAppearance(restored)).toEqual({ brightness: 1.3, contrast: 0.7, saturation: 0, terrainExaggeration: 4, originConfigured: true })
    expect(projectSceneForUnity(restored).geospatial).toMatchObject({ origin: [110.75, 19.62, 12], terrainEnabled: true, appearance: getEditorGisAppearance(restored),
      layers: [expect.objectContaining({ type: 'imagery', url: expect.stringContaining('/tile/wenchang') }), expect.objectContaining({ type: 'terrain', url: expect.stringContaining('/elevation/test') })],
    })
  })

  it('undoes each user change, keeps unrelated settings, and skips no-op origin commits', () => {
    const { store, bus, update } = setup()
    update({ origin: { longitude: 110, latitude: 19 } })
    update({ origin: { longitude: 110, latitude: 19 } })
    expect(bus.getUndoSize()).toBe(1)
    update({ appearance: { brightness: 1.4 } })
    store.updateSceneSettings({ ...store.getScene().settings, unrelated: 'keep' })
    expect(bus.undo()).toBe(true)
    expect(getEditorGisAppearance(store.getScene()).brightness).toBe(1)
    expect(store.getScene().settings.unrelated).toBe('keep')
    bus.undo()
    expect(store.getScene().coordinateSystem).toMatchObject({ defaultLongitude: 104.0668, defaultLatitude: 30.5728 })
    expect(getEditorGisAppearance(store.getScene()).originConfigured).toBe(false)
    bus.redo(); bus.redo()
    expect(getEditorGisAppearance(store.getScene()).brightness).toBe(1.4)
  })

  it('switches between built-in imagery presets and persists the selected source', () => {
    const { store, bus, update } = setup()
    update({ source: { kind: 'terrain', tile: { ...tile, id: 26, path: '/elevation/test' } } })
    update({ source: { kind: 'imagery', tile } })
    update({ source: { kind: 'imagery', presetId: 'preset:nasa-blue-marble' } })
    update({ source: { kind: 'imagery', presetId: 'preset:nasa-city-lights' } })
    expect(bus.undo()).toBe(true)
    expect(getEditorGisSourceKey(getEditorGisBaseLayer(store.getScene(), 'imagery'))).toBe('preset:nasa-blue-marble')
    expect(bus.redo()).toBe(true)

    const payload = serializeSceneDefinitionToFourPackages(store.getScene())
    const restored = assembleSceneDefinitionFromRuntimeFragments({
      manifest: { fragmentType: 'manifest', fragmentKey: store.getScene().id, contentJson: JSON.stringify(payload) }, options: { sceneId: store.getScene().id },
    })
    expect(getEditorGisSourceKey(getEditorGisBaseLayer(restored, 'imagery'))).toBe('preset:nasa-city-lights')
    expect(projectSceneForUnity(restored).geospatial?.layers.filter(layer => layer.type === 'imagery')).toEqual([
      expect.objectContaining({ provider: 'xyz', url: expect.stringContaining('/VIIRS_CityLights_2012/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg'), options: { minimumLevel: 0, maximumLevel: 8 } }),
    ])

    update({ source: { kind: 'imagery', tile: null } })
    expect(getEditorGisSourceKey(getEditorGisBaseLayer(store.getScene(), 'imagery'))).toBe(DEFAULT_GIS_SOURCE)
    expect(store.getScene().layers.map(layer => layer.type)).toEqual(['terrain'])
  })

  it.each(['cloud', 'webgpu'] as const)('visits regional imagery after loading and keeps global imagery at the current view (%s)', async mode => {
    const { store, update } = setup()
    const runtime = new UnityEditorSceneRuntime('gis', { mode, getHost: () => null, onStatus: vi.fn() })
    const unity = {
      capabilities: { features: { 'camera.control': true } },
      loadScene: vi.fn(async () => {}), controlCamera: vi.fn(async () => ({})),
    }
    Object.assign(runtime, { unity })
    await runtime.loadScene(store.getScene())
    update({ source: { kind: 'imagery', presetId: 'preset:minio-wenchang' } })
    await runtime.loadScene(store.getScene())
    expect(unity.controlCamera).toHaveBeenLastCalledWith({ action: 'visit', waypoint: expect.objectContaining({
      destination: [expect.closeTo(110.8699035645), expect.closeTo(19.7589111325), expect.any(Number)],
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    }) })
    expect(unity.loadScene.mock.invocationCallOrder.at(-1)).toBeLessThan(unity.controlCamera.mock.invocationCallOrder.at(-1)!)
    update({ appearance: { brightness: 1.2 } })
    await runtime.loadScene(store.getScene())
    expect(unity.controlCamera).toHaveBeenCalledTimes(1)
    update({ source: { kind: 'imagery', presetId: 'preset:minio-nanshan' } })
    await runtime.loadScene(store.getScene())
    expect(unity.controlCamera).toHaveBeenCalledTimes(2)
    for (const presetId of ['preset:minio-world', 'preset:nasa-blue-marble', 'preset:nasa-city-lights'] as const) {
      update({ source: { kind: 'imagery', presetId } })
      await runtime.loadScene(store.getScene())
    }
    update({ source: { kind: 'imagery', tile: null } })
    await runtime.loadScene(store.getScene())
    expect(unity.controlCamera).toHaveBeenCalledTimes(2)
    expect(store.getScene().coordinateSystem).toMatchObject({ defaultLongitude: 104.0668, defaultLatitude: 30.5728 })
  })

  it('preserves verified MinIO addresses and zoom limits when reopening saved scenes', async () => {
    const { store, update } = setup()
    update({ source: { kind: 'imagery', presetId: 'preset:minio-nanshan' } })
    const api = { listGisTile: vi.fn(async () => ({ code: 200, msg: '', data: [tile] })) }
    const restored = await ensureEditorGisDefaultImageryLayer(structuredClone(store.getScene()), { api })
    expect(getEditorGisBaseLayer(restored, 'imagery')).toMatchObject({
      provider: 'local', url: expect.stringContaining('192.168.10.120:9000/9tyf/'), options: { maximumLevel: 12 },
    })
    expect(api.listGisTile).not.toHaveBeenCalled()
  })

  it('restores default sources without removing extra overlays, object layers or changing the origin', () => {
    const { store, bus, update } = setup()
    store.upsertLayer({ id: 'group', name: '分组', type: 'object', order: 5, visible: true, locked: false })
    update({ source: { kind: 'imagery', tile } })
    const baseId = store.getScene().layers.find(l => l.type === 'imagery')!.id
    store.upsertLayer({ id: 'overlay', name: 'Overlay', type: 'imagery', order: 10, visible: true, locked: false, provider: 'xyz', url: 'https://map.test/{z}/{x}/{y}' })
    update({ source: { kind: 'imagery', tile: null } })
    expect(store.getScene().layers.map(l => l.id)).toEqual(['group', 'overlay'])
    expect(store.getScene().coordinateSystem).toMatchObject({ defaultLongitude: 104.0668 })
    bus.undo()
    expect(store.getScene().layers.map(l => l.id)).toEqual(['group', baseId, 'overlay'])
  })

  it('rejects local scenes, read-only mode, lost locks, non-finite values and invalid coordinates', () => {
    expect(() => setup('local3d').update({ appearance: { contrast: 1 } })).toThrow('仅 GIS')
    const { store, update, bus } = setup()
    expect(() => update({ appearance: { contrast: NaN } })).toThrow('范围')
    expect(() => update({ origin: { longitude: 181, latitude: 0 } })).toThrow('经纬度')
    expect(() => update({ source: { kind: 'imagery', tile: { ...tile, fileName: 'raw.tif' } } })).toThrow('切片')
    releaseGuard = setEditorGisEditGuard(() => false)
    expect(() => update({ appearance: { contrast: 1 } })).toThrow('权限')
    releaseGuard()
    store.updateSceneSettings({ readOnly: true })
    expect(() => update({ appearance: { contrast: 1 } })).toThrow('权限')
    expect(bus.getUndoSize()).toBe(0)
  })

  it('coalesces GIS changes into one runtime load with the latest weather and preserves selection', async () => {
    const { store, update, bus } = setup()
    const runtime = new MemorySceneRuntime('gis')
    const load = vi.spyOn(runtime, 'loadScene')
    const bridge = createRuntimeBridge(store, runtime)
    bridge.start(); await bridge.flush(); load.mockClear()
    update({ appearance: { terrainExaggeration: 2 } })
    update({ source: { kind: 'imagery', tile } })
    await bridge.flush()
    expect(load).toHaveBeenCalledTimes(1)
    expect(load.mock.calls[0]![0].layers[0]?.metadata?.tileId).toBe(25)
    bus.undo(); await bridge.flush()
    expect(load.mock.calls[1]![0].layers).toEqual([])
    bridge.stop()
  })
})
