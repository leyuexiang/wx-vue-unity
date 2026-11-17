import type { GeoCameraPathWaypoint, SceneDefinition, SceneLayer, SceneStore } from '@/scene-platform'
import type { SceneCommand } from '@/scene-platform/commands/types'
import type { ListGisTileRes } from '@/servers/manual/gis/api'
import {
  EDITOR_GIS_SOURCE_HOST, createEditorGisLocalImageryLayerMetadata,
  createEditorGisLocalImageryLayerOptions,
} from './editorGisDefaultLayerAdapter'

export interface EditorGisAppearance {
  terrainExaggeration: number
  brightness: number
  contrast: number
  saturation: number
  originConfigured: boolean
}
export type GisTileRecord = ListGisTileRes['data'][number]
export type GisDataKind = 'terrain' | 'imagery'
export const DEFAULT_GIS_SOURCE = '__startup__'
interface EditorGisImageryPreset {
  id: string
  label: string
  provider: 'local' | 'xyz'
  url: string
  options: Record<string, unknown>
  bounds?: readonly [number, number, number, number]
}
const minioImageryRoot = 'http://192.168.10.120:9000/9tyf/v2.0.0/gis/satellite/tile'
const nasaImageryRoot = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best'
export const EDITOR_GIS_IMAGERY_PRESETS = [
  {
    id: 'preset:minio-wenchang', label: '文昌市影像（MinIO）', provider: 'local',
    url: `${minioImageryRoot}/${encodeURIComponent('文昌市')}`,
    options: { fileExtension: 'jpg', yOrigin: 'tms', minimumLevel: 0, maximumLevel: 17, tileSize: 256 },
    bounds: [110.464782715, 19.351043701, 111.275024414, 20.166778564],
  },
  {
    id: 'preset:minio-nanshan', label: '南山区影像（MinIO）', provider: 'local',
    url: `${minioImageryRoot}/${encodeURIComponent('南山区')}`,
    options: { fileExtension: 'jpg', yOrigin: 'tms', minimumLevel: 0, maximumLevel: 12, tileSize: 256 },
    bounds: [113.779907227, 22.398376465, 114.021606445, 22.656555176],
  },
  {
    id: 'preset:minio-world', label: '全球影像（MinIO）', provider: 'local',
    url: `${minioImageryRoot}/${encodeURIComponent('World_影像')}`,
    options: { fileExtension: 'jpg', yOrigin: 'tms', minimumLevel: 0, maximumLevel: 8, tileSize: 256 },
    bounds: [-180, -90, 180, 90],
  },
  {
    id: 'preset:nasa-blue-marble', label: 'NASA 蓝色大理石（日间）', provider: 'xyz',
    url: `${nasaImageryRoot}/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg`,
    options: { minimumLevel: 0, maximumLevel: 8 },
  },
  {
    id: 'preset:nasa-city-lights', label: 'NASA 全球城市灯光（夜间）', provider: 'xyz',
    url: `${nasaImageryRoot}/VIIRS_CityLights_2012/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg`,
    options: { minimumLevel: 0, maximumLevel: 8 },
  },
] as const satisfies readonly EditorGisImageryPreset[]
type GisImageryPresetId = typeof EDITOR_GIS_IMAGERY_PRESETS[number]['id']
type GisSourceSelection = { kind: GisDataKind; tile: GisTileRecord | null } | { kind: 'imagery'; presetId: GisImageryPresetId }
let editGuard: (() => boolean) | null = null
export const isEditorGisWriteAllowed = () => editGuard?.() !== false
export function setEditorGisEditGuard(guard: () => boolean): () => void {
  editGuard = guard
  return () => { if (editGuard === guard) editGuard = null }
}
export const GIS_NUMERIC_RANGES = {
  terrainExaggeration: { min: 0, max: 10, step: 0.1 },
  brightness: { min: 0, max: 2, step: 0.1 },
  contrast: { min: 0, max: 2, step: 0.1 },
  saturation: { min: 0, max: 2, step: 0.1 },
} as const

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const clone = <T>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value)) as T

export function getEditorGisAppearance(scene: SceneDefinition): EditorGisAppearance {
  const saved = record(record(scene.settings.three).gis)
  const value = (key: keyof typeof GIS_NUMERIC_RANGES) => {
    const range = GIS_NUMERIC_RANGES[key]
    return typeof saved[key] === 'number' && Number.isFinite(saved[key])
      ? Math.min(range.max, Math.max(range.min, saved[key])) : 1
  }
  return {
    terrainExaggeration: value('terrainExaggeration'), brightness: value('brightness'),
    contrast: value('contrast'), saturation: value('saturation'), originConfigured: saved.originConfigured === true,
  }
}

/** The first visible surface layer is the base; additional overlays are preserved. */
export function getEditorGisBaseLayer(scene: SceneDefinition, kind: GisDataKind) {
  const saved = record(record(scene.settings.three).gis)
  const key = `${kind}SourceId`
  if (Object.prototype.hasOwnProperty.call(saved, key))
    return scene.layers.find(layer => layer.type === kind && layer.id === saved[key])
  return scene.layers.filter(layer => layer.type === kind).sort((a, b) => a.order - b.order)
    .find(layer => layer.visible) ?? scene.layers.find(layer => layer.type === kind)
}

export function getEditorGisSourceKey(layer?: SceneLayer): string {
  if (!layer) return DEFAULT_GIS_SOURCE
  const { imageryPresetId, tileId } = layer.metadata ?? {}
  if (layer.type === 'imagery' && typeof imageryPresetId === 'string') return imageryPresetId
  return typeof tileId === 'number' || typeof tileId === 'string' ? String(tileId) : `layer:${layer.id}`
}

/** Regional imagery frames its coverage. Global sources leave the live camera alone. */
export function getEditorGisImageryCameraTarget(layer?: SceneLayer): GeoCameraPathWaypoint | null {
  if (!layer || layer.type !== 'imagery') return null
  const preset: EditorGisImageryPreset | undefined = EDITOR_GIS_IMAGERY_PRESETS.find(item => item.id === getEditorGisSourceKey(layer))
  if (preset && !preset.bounds) return null
  if (/全球|world/i.test(`${layer.name} ${layer.url ?? ''}`)) return null
  const bounds = preset?.bounds ?? layer.options?.rectangleDegrees
  let longitude: number, latitude: number, height = 10000
  if (Array.isArray(bounds) && bounds.length === 4 && bounds.every(value => typeof value === 'number' && Number.isFinite(value))) {
    const [west, south, east, north] = bounds as [number, number, number, number]
    if (west < -180 || east > 180 || south < -90 || north > 90 || west >= east || south >= north) return null
    if (east - west >= 350 && north - south >= 170) return null
    longitude = (west + east) / 2
    latitude = (south + north) / 2
    // At a 60-degree vertical FOV this leaves a margin around the larger coverage span.
    const span = Math.max((east - west) * Math.cos(latitude * Math.PI / 180), north - south) * 111320
    height = Math.max(2000, span * 1.2)
  } else {
    const metadata = layer.metadata ?? {}
    if (metadata.longitude == null || metadata.latitude == null || String(metadata.longitude).trim() === '' || String(metadata.latitude).trim() === '') return null
    longitude = Number(metadata.longitude)
    latitude = Number(metadata.latitude)
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || Math.abs(longitude) > 180 || Math.abs(latitude) > 90) return null
  }
  return {
    kind: 'geo', id: layer.id, timeMs: 0, destination: [longitude, latitude, height],
    orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 }, interpolation: 'linear',
  }
}

export function isSelectableGisTile(tile: GisTileRecord, kind: GisDataKind): boolean {
  if (!tile.path?.trim()) return false
  if (kind === 'terrain') return !/\.(tif|tiff|zip)$/i.test(tile.path)
  return !/\.(tif|tiff)$/i.test(tile.fileName ?? '') && !tile.path.includes('/geotiff/') &&
    (tile.sliceFlag === false || tile.path.includes('/tile/'))
}

interface GisSnapshot {
  coordinateSystem: SceneDefinition['coordinateSystem']
  layers: SceneLayer[]
  appearance: unknown
}
const dataLayer = (layer: SceneLayer) => ['terrain', 'imagery', 'tileset', 'vector'].includes(layer.type)
const snapshot = (scene: SceneDefinition): GisSnapshot => ({
  coordinateSystem: clone(scene.coordinateSystem),
  layers: clone(scene.layers.filter(dataLayer)),
  appearance: clone(record(scene.settings.three).gis),
})

/** One GIS transaction keeps source, appearance, origin and undo history consistent. */
export function updateEditorSceneGis(options: {
  store: SceneStore
  execute: (command: SceneCommand) => unknown
  canEdit: () => boolean
  appearance?: Partial<Omit<EditorGisAppearance, 'originConfigured'>>
  origin?: { longitude: number; latitude: number }
  source?: GisSourceSelection
}): void {
  const scene = options.store.getScene()
  if (scene.type !== 'gis' || scene.coordinateSystem.kind !== 'wgs84') throw new Error('仅 GIS 场景支持地理配置。')
  if (!isEditorGisWriteAllowed() || !options.canEdit() || scene.settings.readOnly === true) throw new Error('当前场景没有编辑权限。')
  const previous = snapshot(scene)
  const next = snapshot(scene)
  const appearance = getEditorGisAppearance(scene)
  if (options.appearance) {
    for (const [key, value] of Object.entries(options.appearance)) {
      const range = GIS_NUMERIC_RANGES[key as keyof typeof GIS_NUMERIC_RANGES]
      if (!range || !Number.isFinite(value) || value < range.min || value > range.max) throw new Error('GIS 参数超出有效范围。')
    }
    next.appearance = { ...record(previous.appearance), ...appearance, ...options.appearance }
  }
  if (options.origin) {
    const { longitude, latitude } = options.origin
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || Math.abs(longitude) > 180 || Math.abs(latitude) > 90)
      throw new Error('请输入有效经纬度（经度 -180～180，纬度 -90～90）。')
    next.coordinateSystem = { ...scene.coordinateSystem, defaultLongitude: longitude, defaultLatitude: latitude }
    next.appearance = { ...appearance, ...record(next.appearance), originConfigured: true }
  }
  if (options.source) {
    const { kind } = options.source
    const current = getEditorGisBaseLayer(scene, kind)
    if (current) next.layers = next.layers.filter(layer => layer.id !== current.id)
    const id = current?.id ?? `__editor-base-${kind}__`
    const base = { id, type: kind, visible: true, locked: true, opacity: 1, order: current?.order ?? -100 }
    let sourceId: string | null = null
    if ('presetId' in options.source) {
      const presetId = options.source.presetId
      const preset: EditorGisImageryPreset | undefined = EDITOR_GIS_IMAGERY_PRESETS.find(item => item.id === presetId)
      if (!preset) throw new Error('该影像选项不可用。')
      next.layers.push({
        ...base, name: preset.label, provider: preset.provider, url: preset.url,
        options: clone(preset.options), metadata: { imageryPresetId: preset.id },
      })
      sourceId = id
    } else if (options.source.tile) {
      const tile = options.source.tile
      if (!isSelectableGisTile(tile, kind)) throw new Error('该数据尚未发布为可用切片。')
      const path = tile.path.trim()
      const url = /^https?:\/\//i.test(path) ? path : `${EDITOR_GIS_SOURCE_HOST}/${path.replace(/^\/+/, '')}`
      next.layers.push({
        ...base, name: tile.gisName || (kind === 'terrain' ? '高程' : '影像'), provider: 'local', url,
        options: kind === 'imagery' ? createEditorGisLocalImageryLayerOptions(tile) : {},
        metadata: createEditorGisLocalImageryLayerMetadata(tile),
      })
      sourceId = id
    }
    next.appearance = { ...appearance, ...record(next.appearance),
      [`${kind}SourceId`]: sourceId }
    // Default elevation means the authored StartScene terrain, rather than an ellipsoid override.
    if (kind === 'terrain' && next.coordinateSystem.kind === 'wgs84')
      next.coordinateSystem = { ...next.coordinateSystem, terrainEnabled: true }
  }
  if (JSON.stringify(previous) === JSON.stringify(next)) return
  const apply = (store: SceneStore, state: GisSnapshot) => {
    const current = store.getScene()
    const three = { ...record(current.settings.three) }
    if (state.appearance === undefined) delete three.gis
    else three.gis = clone(state.appearance)
    const settings = { ...current.settings }
    if (Object.keys(three).length) settings.three = three
    else delete settings.three
    store.updateSceneGisConfig({
      coordinateSystem: clone(state.coordinateSystem),
      layers: [...current.layers.filter(layer => !dataLayer(layer)), ...clone(state.layers)], settings,
    })
  }
  options.execute({ name: 'UpdateSceneGisConfig', execute: store => apply(store, next), undo: store => apply(store, previous) })
}
