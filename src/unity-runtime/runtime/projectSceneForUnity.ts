import { buildSceneNodeIndex } from '@/scene-platform/core/sceneNodeIndex'
import type { SceneDefinition as EditorScene, SceneObject as EditorObject } from '@/scene-platform'
import { resolveSceneStreamingConfigForRuntime } from '@/scene-platform/core/sceneStreamingPolicy'
import type { SceneDefinition as UnityScene, SceneObject as UnityObject, SceneTransform as UnityTransform } from '@/scene-core'
import { projectInstanceDefinition } from '@/scene-core/model/instanceDefinition'

const primitiveNames: Record<string, string> = {
  BoxGeometry: 'cube', SphereGeometry: 'sphere', CapsuleGeometry: 'capsule',
  CylinderGeometry: 'cylinder', PlaneGeometry: 'plane', CircleGeometry: 'plane',
}

const unityDraftObjectTypes = new Set<EditorObject['type']>(['model', 'primitive', 'group'])

/** Keep objects outside the current Unity protocol in SceneStore and save packages. */
export const isUnityDeferredObject = (object: EditorObject): boolean => !unityDraftObjectTypes.has(object.type)

export const getUnityModelAssetId = (object: EditorObject): string =>
  String(object.asset?.metadata?.assetId ?? object.asset?.id ?? '').trim()

export const getUnityDeferredRenderWarnings = (scene: EditorScene): string[] => {
  const names = [...new Set([
    ...scene.objects.filter(isUnityDeferredObject).map((object) => `${object.name || object.id}（${object.type}）`),
    ...scene.effects.filter((effect) => effect.params.enabled !== false).map((effect) => effect.type),
  ])]
  if (!names.length) return []
  return [`以下对象或特效暂未接入 Unity，配置仍保留：${names.slice(0, 6).join('、')}${names.length > 6 ? `等 ${names.length} 项` : ''}`]
}

const toQuaternion = ([x, y, z]: [number, number, number]): [number, number, number, number] => {
  const cx = Math.cos(x / 2), sx = Math.sin(x / 2)
  const cy = Math.cos(y / 2), sy = Math.sin(y / 2)
  const cz = Math.cos(z / 2), sz = Math.sin(z / 2)
  return [sx * cy * cz + cx * sy * sz, cx * sy * cz - sx * cy * sz,
    cx * cy * sz + sx * sy * cz, cx * cy * cz - sx * sy * sz]
}

const geoQuaternion = (heading: number, pitch: number, roll: number): [number, number, number, number] => {
  // Cesium HeadingPitchRoll: intrinsic Z(-heading), Y(-pitch), X(roll), in ENU.
  const h = -heading / 2, p = -pitch / 2, r = roll / 2
  const ch = Math.cos(h), sh = Math.sin(h), cp = Math.cos(p), sp = Math.sin(p), cr = Math.cos(r), sr = Math.sin(r)
  return [ch * cp * sr - sh * sp * cr, ch * sp * cr + sh * cp * sr,
    sh * cp * cr - ch * sp * sr, ch * cp * cr + sh * sp * sr]
}

const resolveGeoQuaternion = (transform: Extract<EditorObject['transform'], { kind: 'geo' }>): [number, number, number, number] => {
  const computed = geoQuaternion(transform.heading, transform.pitch, transform.roll)
  const snapshot = transform.orientationQuaternion
  // Property panels may change HPR while retaining an older Gizmo snapshot.
  // Keep the precise snapshot only when it still expresses the current angles.
  return snapshot && snapshot.every(Number.isFinite)
    && Math.min(...[1, -1].map((sign) => Math.max(...computed.map((value, i) => Math.abs(value - sign * snapshot[i]!))))) < 1e-6
    ? snapshot : computed
}

export const fromUnityTransform = (value: UnityTransform, previous?: EditorObject['transform']): EditorObject['transform'] => {
  const [x, y, z, w] = value.rotation.value
  if (value.space === 'wgs84') {
    const [longitude, latitude, height] = value.position
    return {
      kind: 'geo', longitude, latitude, height,
      heading: -Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)),
      pitch: -Math.asin(Math.max(-1, Math.min(1, 2 * (w * y - z * x)))),
      roll: Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y)),
      orientationQuaternion: [...value.rotation.value], scale: value.scale,
      altitudeMode: previous?.kind === 'geo' ? previous.altitudeMode : 'absolute',
    }
  }
  // SceneStore/Three use intrinsic XYZ Euler angles in radians.
  const sinY = Math.max(-1, Math.min(1, 2 * (x * z + w * y)))
  const locked = Math.abs(sinY) >= 0.9999999
  return {
    kind: 'local', position: value.position,
    rotation: [locked ? Math.atan2(2 * (y * z + w * x), 1 - 2 * (x * x + z * z))
      : Math.atan2(2 * (w * x - y * z), 1 - 2 * (x * x + y * y)),
    Math.asin(sinY),
    locked ? 0 : Math.atan2(2 * (w * z - x * y), 1 - 2 * (y * y + z * z))],
    scale: value.scale,
  }
}

export const projectObjectForUnity = (object: EditorObject, sceneId?: string): UnityObject => {
  const transform = object.transform
  if (transform.kind === 'geo') {
    if (transform.altitudeMode !== 'absolute') throw new Error(`GIS 对象 ${object.name} 暂不支持贴地或相对地形高度，请使用绝对高度`)
    if (![transform.longitude, transform.latitude, transform.height, transform.heading, transform.pitch, transform.roll].every(Number.isFinite)
      || Math.abs(transform.longitude) > 180 || Math.abs(transform.latitude) > 90) throw new Error(`GIS 对象 ${object.name} 的地理坐标无效`)
  }
  if (isUnityDeferredObject(object)) {
    throw new Error(`当前 Unity 渲染暂不支持对象类型：${object.type}`)
  }
  const resourceKey = object.asset?.id?.trim()
  if (object.type === 'model' && !resourceKey) throw new Error(`模型 ${object.name} 缺少稳定资产编号`)
  const geometryName = String(object.metadata?.editorGeometryType ?? '')
  const primitiveType = primitiveNames[geometryName]
  if (object.type === 'primitive' && !primitiveType) {
    throw new Error(`当前 Unity 渲染暂不支持几何体：${geometryName || object.name}`)
  }
  const pickable = object.metadata?.pickable
  const deviceId = object.metadata?.deviceId
  const instanceDefinition = projectInstanceDefinition(object.metadata?.instanceDefinition, {
    instanceId: object.id, resourceId: getUnityModelAssetId(object), name: object.name, sceneId,
  })
  return {
    instanceId: object.id, objectType: object.type as UnityObject['objectType'], name: object.name,
    // 本地变换沿业务父级解释，顺序使用现有领域order，不另建存档字段。
    ...(object.parentInstanceId ? { parentInstanceId: object.parentInstanceId } : {}),
    siblingOrder: object.order,
    visible: object.visible, locked: object.locked,
    transform: { space: transform.kind === 'geo' ? 'wgs84' : 'local',
      position: transform.kind === 'geo' ? [transform.longitude, transform.latitude, transform.height] : transform.position,
      rotation: { kind: 'quaternion', value: transform.kind === 'geo'
        ? resolveGeoQuaternion(transform)
        : toQuaternion(transform.rotation) },
      scale: typeof transform.scale === 'number' ? [transform.scale, transform.scale, transform.scale] : transform.scale },
    resourceRefKeys: resourceKey ? [resourceKey] : [],
    // 拾取状态与编辑锁分开传输；没有历史字段的对象默认允许画布拾取。
    properties: {
      ...(primitiveType ? { primitiveType } : {}),
      pickable: typeof pickable === 'boolean' ? pickable : true,
      ...(typeof deviceId === 'string' ? { deviceId } : {}),
      ...(instanceDefinition === undefined ? {} : { instanceDefinition }),
    },
  }
}

export const projectSceneForUnity = (scene: EditorScene): UnityScene => {
  if (scene.type === 'gis' && scene.coordinateSystem.kind !== 'wgs84') throw new Error('GIS 场景必须使用 WGS84 坐标系')
  const index = buildSceneNodeIndex(scene.objects)
  const renderObjects = scene.objects.filter((object) => !isUnityDeferredObject(object))
  const renderedIds = new Set(renderObjects.map((object) => object.id))
  for (const object of renderObjects) {
    const parent = index.parentById.get(object.id)
    if (parent && (scene.type === 'gis' || !renderedIds.has(parent))) throw new Error('当前运行端不支持地理父子变换或未接入类型作为父节点')
  }
  for (const object of renderObjects) {
    if ((scene.type === 'gis') !== (object.transform.kind === 'geo')) throw new Error(`对象 ${object.name} 的坐标类型与场景不一致`)
  }
  const objects = renderObjects.map((object) => projectObjectForUnity(object, scene.id))
  const resources = new Map<string, UnityScene['resources'][number]>()
  scene.objects.forEach((object) => {
    if (object.type !== 'model' || !object.asset) return
    resources.set(object.asset.id, {
      resourceKey: object.asset.id,
      assetId: getUnityModelAssetId(object),
      kind: object.asset.kind,
    })
  })
  return {
    schemaVersion: 1, id: scene.id, name: scene.name, type: scene.type, revisionNo: 0,
    ...(scene.coordinateSystem.kind === 'wgs84' ? { geospatial: {
      origin: [scene.coordinateSystem.defaultLongitude, scene.coordinateSystem.defaultLatitude, scene.coordinateSystem.defaultHeight] as [number, number, number],
      terrainEnabled: scene.coordinateSystem.terrainEnabled,
      layers: scene.layers.filter((layer) => ['imagery', 'terrain', 'tileset', 'vector'].includes(layer.type)).map((layer) => ({
        id: layer.id, name: layer.name, type: layer.type as 'imagery' | 'terrain' | 'tileset' | 'vector',
        visible: layer.visible, order: layer.order,
        ...(layer.provider ? { provider: layer.provider } : {}),
        ...(layer.url ?? layer.asset?.url ? { url: layer.url ?? layer.asset?.url } : {}),
        ...(layer.opacity !== undefined ? { opacity: layer.opacity } : {}),
        ...(layer.options ? { options: layer.options } : {}),
      })),
    } } : {}),
    objects, resources: [...resources.values()], settings: {},
    // 复用编辑器的持久化定义与覆盖规则；缺失保持兼容，显式关闭不能在引擎侧丢失。
    ...(scene.streaming ? { streaming: resolveSceneStreamingConfigForRuntime(scene.streaming, 'editor') } : {}),
    twoD: { canvas: {}, components: [], layerTree: [] },
    dependencies: { dataBindings: [], behaviors: [], deviceBindings: [] },
  }
}
