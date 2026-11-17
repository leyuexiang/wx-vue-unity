import { describe, expect, it } from 'vitest'
import { createSceneDefinition } from '@/scene-platform'
import { serializeSceneDefinitionToFourPackages } from '@/integrations/scene/sceneFourPackage'
import { decodeUnityRpcResponse } from '../connection/decodeUnityRpcResponse'
import { fromUnityTransform, getUnityDeferredRenderWarnings, projectObjectForUnity, projectSceneForUnity, projectSceneForUnityLoadedInstances } from '../runtime/projectSceneForUnity'

describe('dual Unity render contract', () => {
  it('只读分片投影补齐父级链，但不改写完整场景', () => {
    const scene = createSceneDefinition({ id: 'chunk-scene', name: 'Chunk scene', type: 'local3d',
      coordinateSystem: { kind: 'local', unit: 'meter', upAxis: 'Y', gridEnabled: true } })
    const transform = { kind: 'local' as const, position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: 1 }
    scene.objects = [
      { id: 'parent', name: 'Parent', type: 'group', visible: true, locked: false, order: 0, transform },
      { id: 'child', name: 'Child', type: 'primitive', visible: true, locked: false, order: 0, parentInstanceId: 'parent', transform, metadata: { editorGeometryType: 'BoxGeometry' } },
      { id: 'other', name: 'Other', type: 'primitive', visible: true, locked: false, order: 1, transform, metadata: { editorGeometryType: 'BoxGeometry' } },
    ]
    const projected = projectSceneForUnityLoadedInstances(scene, new Set(['child']))
    expect(projected.objects.map((object) => object.instanceId)).toEqual(['parent', 'child'])
    expect(scene.objects.map((object) => object.id)).toEqual(['parent', 'child', 'other'])
  })

  it('projects legacy GIS camera settings without changing the saved camera or path', () => {
    const scene = createSceneDefinition({ id: 'camera-gis', name: 'GIS', type: 'gis',
      coordinateSystem: { kind: 'wgs84', defaultLongitude: 110, defaultLatitude: 19, defaultHeight: 0, terrainEnabled: false } })
    const orientation = { heading: 0.3, pitch: -0.5, roll: 0 }
    scene.settings = { camera: { kind: 'cesium', destination: [110, 19, 800], orientation, fov: 45, near: 0.5, far: 1e8 },
      rendering: { antialias: false } }
    scene.cameraPaths = [{ id: 'route', name: '巡视', enabled: true, loop: false, autoPlay: true, durationMs: 4500,
      waypoints: [
        { id: 'first', kind: 'geo', destination: [110, 19, 800], orientation, timeMs: 0, interpolation: 'linear' },
        { id: 'last', kind: 'geo', destination: [110.1, 19.1, 850], orientation, timeMs: 3000, interpolation: 'ease-in-out' },
      ] }]
    expect(projectSceneForUnity(scene).camera).toEqual({ position: [110, 19, 800], orientation, fov: 45,
      near: 0.5, far: 1e8, antialiasing: { mode: 'none' } })
    const saved = JSON.parse(serializeSceneDefinitionToFourPackages(scene).threeDJson)
    expect(saved.baseConfig.camera).toEqual(scene.settings.camera)
    expect(saved.baseConfig.settings.rendering).toEqual(scene.settings.rendering)
    expect(saved.cameraPaths).toEqual(scene.cameraPaths)
  })

  it.each(['gis', 'local3d'] as const)('loads a mixed %s scene without losing deferred cameras or other objects from save packages', (type) => {
    const scene = createSceneDefinition({ id: 'mixed', name: 'Mixed', type,
      coordinateSystem: type === 'gis' ? { kind: 'wgs84', defaultLongitude: 110, defaultLatitude: 19, defaultHeight: 0, terrainEnabled: false }
        : { kind: 'local', unit: 'meter', upAxis: 'Y', gridEnabled: true } })
    const transform = type === 'gis'
      ? { kind: 'geo' as const, longitude: 110, latitude: 19, height: 0, heading: 0, pitch: 0, roll: 0, scale: 1, altitudeMode: 'absolute' as const }
      : { kind: 'local' as const, position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: 1 }
    scene.objects = ['camera', 'effect', 'image', 'tileset', 'light', 'annotation', 'group', 'primitive'].map((objectType, order) => ({
      id: objectType, name: objectType, type: objectType as typeof scene.objects[number]['type'], visible: true, locked: false, order, transform,
      ...(objectType === 'primitive' ? { metadata: { editorGeometryType: 'BoxGeometry' } } : {}),
      ...(objectType === 'camera' ? { firstPerson: { enabled: true, height: 1.8, eyeHeight: 1.6, collisionRadius: 0.3, moveSpeed: 2, lookSensitivity: 1, fov: 60, lockPitch: false, collisionEnabled: false } } : {}),
    }))
    const saved = serializeSceneDefinitionToFourPackages(scene)
    const draft = projectSceneForUnity(scene)
    expect(draft.objects.map((object) => object.instanceId)).toEqual(['group', 'primitive'])
    expect(serializeSceneDefinitionToFourPackages(scene)).toEqual(saved)
    const savedCamera = JSON.parse(saved.threeDJson).components.find((object: { instanceId: string }) => object.instanceId === 'camera')
    expect(savedCamera.contentJson.firstPerson).toMatchObject({ enabled: true, fov: 60 })
    const warnings = getUnityDeferredRenderWarnings(scene).join()
    for (const objectType of ['camera', 'effect', 'image', 'tileset', 'light', 'annotation']) expect(warnings).toContain(`（${objectType}）`)
  })
  it('loads GIS content with saved effects and reports the deferred effects without altering saved data', () => {
    const scene = createSceneDefinition({ id: 'gis-effects', name: 'GIS with effects', type: 'gis', coordinateSystem: {
      kind: 'wgs84', defaultLongitude: 110, defaultLatitude: 19, defaultHeight: 0, terrainEnabled: false,
    } })
    const transform = { kind: 'geo' as const, longitude: 110, latitude: 19, height: 5, heading: 0, pitch: 0, roll: 0, scale: 1, altitudeMode: 'absolute' as const }
    scene.objects = [
      { id: 'box', name: 'Box', type: 'primitive', visible: true, locked: false, order: 0, transform, metadata: { editorGeometryType: 'BoxGeometry' } },
      { id: 'heat', name: '体积热力图', type: 'effect', visible: true, locked: false, order: 1, transform,
        effect: { id: 'heat', type: 'volume-heatmap', params: { enabled: true, name: '原有配置' } } },
    ]
    scene.effects = [{ id: 'weather-main', type: 'weather', params: { enabled: true, mode: 'cloudy' } }]
    const saved = JSON.stringify(scene)
    expect(projectSceneForUnity(scene).objects.map((object) => object.instanceId)).toEqual(['box'])
    expect(getUnityDeferredRenderWarnings(scene).join()).toContain('体积热力图')
    expect(getUnityDeferredRenderWarnings(scene).join()).toContain('weather')
    expect(JSON.stringify(scene)).toBe(saved)
  })
  it('projects editor objects into the Unity draft payload shared by cloud and WebGPU', () => {
    const scene = createSceneDefinition({ id: '9007199254740993', name: 'Test', type: 'local3d',
      coordinateSystem: { kind: 'local', unit: 'meter', upAxis: 'Y', gridEnabled: true } })
    scene.objects = [{ id: 'box', name: 'Box', type: 'primitive', visible: true, locked: false, order: 0,
      transform: { kind: 'local', position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] },
      metadata: { editorGeometryType: 'BoxGeometry' } }]
    const draft = projectSceneForUnity(scene)
    expect(draft.id).toBe('9007199254740993')
    expect(draft.objects[0]).toMatchObject({ instanceId: 'box', objectType: 'primitive',
      properties: { primitiveType: 'cube' }, transform: { rotation: { value: [0, 0, 0, 1] } } })
  })

  it('把拾取状态和设备编号投影到 Unity，且拾取状态独立于锁定状态', () => {
    const object = {
      id: 'box', name: '模型', type: 'primitive' as const, visible: true, locked: true, order: 0,
      transform: { kind: 'local' as const, position: [0, 0, 0] as [number, number, number],
        rotation: [0, 0, 0] as [number, number, number], scale: 1 },
      metadata: { editorGeometryType: 'BoxGeometry', pickable: false, deviceId: '设备-001' },
    }

    expect(projectObjectForUnity(object)).toMatchObject({
      locked: true,
      properties: { primitiveType: 'cube', pickable: false, deviceId: '设备-001' },
    })
    expect(projectObjectForUnity({ ...object, locked: false })).toMatchObject({
      locked: false,
      properties: { pickable: false },
    })
  })

  it('unwraps the response shape emitted by Unity BusinessChannel', () => {
    const envelope = { protocolVersion: 1, requestId: 'req-1', success: true,
      payload: { protocolVersion: 1, capabilities: { sceneTypes: ['local3d'] } } }
    expect(decodeUnityRpcResponse({ id: 'req-1', result: JSON.stringify(envelope) }, 'req-1')).toEqual(envelope)
    expect(decodeUnityRpcResponse({ id: 'req-1', result: { Result: JSON.stringify(envelope) } }, 'req-1')).toEqual(envelope)
    expect(decodeUnityRpcResponse({ id: 'req-1', result: envelope }, 'req-1')).toEqual(envelope)
  })

  it('round trips Three XYZ rotations through Unity quaternions', () => {
    const rotation: [number, number, number] = [0.3, -0.4, 0.7]
    const object = { id: 'box', name: 'Box', type: 'primitive' as const, visible: true,
      locked: false, order: 0, transform: { kind: 'local' as const,
        position: [1, 2, 3] as [number, number, number], rotation, scale: [1, 1, 1] as [number, number, number] },
      metadata: { editorGeometryType: 'BoxGeometry' } }
    const restored = fromUnityTransform(projectObjectForUnity(object).transform)
    if (restored.kind !== 'local') throw new Error('local transform expected')
    restored.rotation.forEach((value, index) => expect(value).toBeCloseTo(rotation[index], 6))
  })

  it('carries GIS origin and layer sources through the shared draft without changing the editor scene', () => {
    const scene = createSceneDefinition({ id: 'gis', name: 'GIS', type: 'gis',
      coordinateSystem: { kind: 'wgs84', defaultLongitude: 110.75, defaultLatitude: 19.62, defaultHeight: 0, terrainEnabled: true } })
    scene.layers = [
      { id: 'imagery', name: '影像', type: 'imagery', provider: 'local', url: 'https://example.test/tiles', visible: true, locked: true, order: 0,
        options: { yOrigin: 'tms', fileExtension: 'jpg', maximumLevel: 17 } },
      { id: 'objects', name: '对象', type: 'object', visible: true, locked: false, order: 1 },
    ]
    const before = JSON.stringify(scene)
    const draft = projectSceneForUnity(scene)
    expect(draft.type).toBe('gis')
    expect(draft.geospatial).toEqual({ origin: [110.75, 19.62, 0], terrainEnabled: true,
      layers: [{ id: 'imagery', name: '影像', type: 'imagery', provider: 'local', url: 'https://example.test/tiles', visible: true, order: 0,
        options: { yOrigin: 'tms', fileExtension: 'jpg', maximumLevel: 17 } }] })
    expect(JSON.stringify(scene)).toBe(before)
  })

  it.each([[0, 0, 0], [0.7, -0.3, 0.2], [-2, 0.8, -1.1]])('round trips geographic heading/pitch/roll %j', (heading, pitch, roll) => {
    const object = { id: 'geo', name: 'Geo', type: 'primitive' as const, visible: true, locked: false, order: 0,
      transform: { kind: 'geo' as const, longitude: 110.75123456789, latitude: 19.62123456789, height: 12.34567,
        heading, pitch, roll, altitudeMode: 'absolute' as const, scale: [2, 3, 4] as [number, number, number] },
      metadata: { editorGeometryType: 'BoxGeometry' } }
    const projected = projectObjectForUnity(object)
    expect(projected.transform.space).toBe('wgs84')
    const restored = fromUnityTransform(projected.transform, object.transform)
    if (restored.kind !== 'geo') throw new Error('geo transform expected')
    expect(restored.longitude).toBe(object.transform.longitude)
    expect(restored.latitude).toBe(object.transform.latitude)
    expect(restored.height).toBe(object.transform.height)
    expect(restored.heading).toBeCloseTo(heading, 8)
    expect(restored.pitch).toBeCloseTo(pitch, 8)
    expect(restored.roll).toBeCloseTo(roll, 8)
    expect(projectObjectForUnity({ ...object, transform: restored }).transform).toEqual(projected.transform)
  })

  it('rejects geographic objects in a local scene instead of treating degrees as metres', () => {
    const scene = createSceneDefinition({ id: 'bad', name: 'Bad', type: 'local3d', coordinateSystem: { kind: 'local', unit: 'meter', upAxis: 'Y', gridEnabled: true } })
    scene.objects = [{ id: 'geo', name: 'Geo', type: 'group', visible: true, locked: false, order: 0,
      transform: { kind: 'geo', longitude: 110, latitude: 19, height: 0, heading: 0, pitch: 0, roll: 0, scale: 1, altitudeMode: 'absolute' } }]
    expect(() => projectSceneForUnity(scene)).toThrow('坐标类型与场景不一致')
  })

  it('honors edited heading even when the property panel retained an old quaternion snapshot', () => {
    const object = { id: 'geo', name: 'Geo', type: 'group' as const, visible: true, locked: false, order: 0,
      transform: { kind: 'geo' as const, longitude: 110, latitude: 19, height: 0, heading: Math.PI / 2, pitch: 0, roll: 0,
        orientationQuaternion: [0, 0, 0, 1] as [number, number, number, number], scale: 1, altitudeMode: 'absolute' as const } }
    const projected = projectObjectForUnity(object)
    expect(projected.transform.rotation.value[2]).toBeCloseTo(-Math.SQRT1_2)
    const restored = fromUnityTransform(projected.transform)
    if (restored.kind !== 'geo') throw new Error('geo transform expected')
    expect(restored.heading).toBeCloseTo(Math.PI / 2)
  })
})
