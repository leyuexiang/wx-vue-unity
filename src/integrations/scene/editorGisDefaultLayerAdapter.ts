import type { SceneDefinition, SceneLayer } from '@/scene-platform'
import type { GisTileDataType, ListGisTileRes } from '@/servers/manual/gis/api'
import { appLogger } from '@/utils/logger'

// 部署地址由环境提供；默认走同源网关，避免固定内网主机及 HTTPS 页面的混合内容请求。
export const EDITOR_GIS_SOURCE_HOST = (import.meta.env.VITE_GIS_SOURCE_URL?.trim() || '/gis-source').replace(/\/+$/, '')

export interface EditorGisTileApi {
  /** 与 GIS 接口契约共用数据类型，避免适配器接受后端未定义的查询值。 */
  listGisTile: (dataType: GisTileDataType) => Promise<ListGisTileRes>
}

export interface EditorGisDefaultLayerOptions {
  api?: EditorGisTileApi
}

type GisTileRecord = ListGisTileRes['data'][number]

const DEFAULT_GIS_IMAGERY_LAYER_ID = '__editor-default-local-imagery__'
const RUNTIME_DEFAULT_IMAGERY_LAYER_ID = '__scene-default-imagery__'
const DEFAULT_LOCAL_TILE_MAXIMUM_LEVEL = 17
const DEFAULT_LOCAL_TILE_RECTANGLE_LEVEL = 8
const DEFAULT_LOCAL_TILE_RECTANGLE_LAT_TILE_SPAN = 2

const loadDefaultGisTileApi = async (): Promise<EditorGisTileApi> => {
  const { listGisTile } = await import('@/servers/manual/gis/api')
  return { listGisTile }
}

const isRuntimeFallbackImageryLayer = (layer: SceneLayer): boolean => {
  if (layer.type !== 'imagery') return false

  const provider = layer.provider ?? ''
  const url = layer.url ?? ''
  const layerName = layer.name.toLowerCase()
  const looksLikeFallbackName =
    layer.name.includes('默认') ||
    layer.name.includes('兜底') ||
    layerName.includes('fallback') ||
    layerName.includes('natural earth')

  /**
   * 只移除旧浏览器 GIS 运行时写入的兜底底图，保留用户配置的 Unity GIS 图层。
   * 本地 local 图层即使来自编辑器默认选择，也是公司内网真实切片，不能当作兜底删除；
   * 否则接口短暂不可用时，已保存的本地底图也会被清空，页面又回到星空背景。
   */
  return (
    (layer.metadata?.runtimeFallback === true && provider !== 'local') ||
    layer.id === RUNTIME_DEFAULT_IMAGERY_LAYER_ID ||
    (layer.id === DEFAULT_GIS_IMAGERY_LAYER_ID && provider !== 'local') ||
    provider === 'natural-earth' ||
    url === 'cesium://natural-earth' ||
    (looksLikeFallbackName && provider !== 'local' && (provider === '' || url.startsWith('cesium://')))
  )
}

const hasUserImageryLayer = (scene: Pick<SceneDefinition, 'layers'>): boolean =>
  scene.layers.some((layer) => layer.type === 'imagery' && !isRuntimeFallbackImageryLayer(layer))

const removeRuntimeFallbackImageryLayers = (scene: SceneDefinition): SceneDefinition => ({
  ...scene,
  /**
   * 旧保存数据里可能已经混入运行时兜底影像。
   * 兜底影像只为“不白屏”服务，不能阻止编辑器继续接入项目后端的本地切片。
   */
  layers: scene.layers.filter((layer) => !isRuntimeFallbackImageryLayer(layer)),
})

const resolveTileBaseUrl = (path: string): string =>
  path.startsWith('/')
    ? `${EDITOR_GIS_SOURCE_HOST}${path}`
    : `${EDITOR_GIS_SOURCE_HOST}/${path}`

const toFiniteNumber = (value: unknown): number | null => {
  const numericValue = typeof value === 'string' ? Number(value) : value
  return typeof numericValue === 'number' && Number.isFinite(numericValue) ? numericValue : null
}

const isSuccessCode = (code: unknown): boolean => String(code) === '200'

const getTilePath = (tile: GisTileRecord): string | null => {
  const tileRecord = tile as GisTileRecord & Record<string, unknown>
  const path =
    tileRecord.path ??
    tileRecord.filePath ??
    tileRecord.sourcePath ??
    tileRecord.url

  return typeof path === 'string' && path.trim().length > 0 ? path.trim() : null
}

const normalizePathForMatching = (path: string): string => path.replace(/\\/g, '/').toLowerCase()

const trimPathSlashes = (path: string): string => path.replace(/^\/+|\/+$/g, '')

const decodePathForMatching = (path: string): string => {
  try {
    return decodeURIComponent(path)
  } catch {
    return path
  }
}

const normalizeTilePathForMatching = (path: string): string =>
  trimPathSlashes(normalizePathForMatching(decodePathForMatching(path)))

const normalizeLayerUrlPathForMatching = (url?: string): string | null => {
  if (!url) return null

  // 旧场景可能保存另一个部署主机的完整地址，匹配只依赖路径和稳定 tileId。
  try {
    const path = new URL(url, 'https://gis.invalid').pathname
    const prefix = new URL(EDITOR_GIS_SOURCE_HOST, 'https://gis.invalid').pathname.replace(/\/+$/, '')
    return normalizeTilePathForMatching(path.startsWith(`${prefix}/`) ? path.slice(prefix.length) : path)
  } catch {
    return null
  }
}

const isReadyTileDirectory = (tile: GisTileRecord): boolean => {
  const tilePath = getTilePath(tile)
  if (!tilePath) return false

  const normalizedPath = normalizePathForMatching(tilePath)
  const fileName = normalizePathForMatching(String(tile.fileName ?? ''))

  /**
   * 后端列表里会同时出现原始影像文件和已发布切片目录：
   * - 原始 GeoTIFF 仍需要切片，路径里常带 geotiff，不能直接按 /level/x/y.jpg 请求；
   * - 已切片目录通常 sliceFlag=false 或路径包含 /tile/，才是编辑器可直接加载的本地底图。
   */
  if (normalizedPath.includes('/geotiff/') || /\.(tif|tiff)$/.test(fileName)) {
    return false
  }

  return tile.sliceFlag === false || normalizedPath.includes('/tile/')
}

const pickDefaultSatelliteTile = (tiles: readonly GisTileRecord[]): GisTileRecord | null =>
  tiles.find(isReadyTileDirectory) ?? null

const resolveMaximumTileLevel = (tile: GisTileRecord, configuredLimit?: unknown): number => {
  const rawMaximumLevel = toFiniteNumber(tile.level)
  const dataLevel = Math.max(0, Math.floor(rawMaximumLevel ?? DEFAULT_LOCAL_TILE_MAXIMUM_LEVEL))
  const limit = toFiniteNumber(configuredLimit)
  // 数据集层级由接口声明，保留用户已保存的更低上限，不将单一样本的 17 级推广为业务规则。
  return limit !== null && limit >= 0 ? Math.min(dataLevel, Math.floor(limit)) : dataLevel
}

const resolveMinimumTileLevel = (): number => {
  /**
   * 文昌市切片是完整金字塔：0 级瓦片是白底上的极小文昌轮廓，
   * 后续层级逐步展开细节。必须从 0 级开始，Cesium 才能按父级瓦片
   * 逐步细化；如果强行从高层级起算，会把局部瓦片边缘拉伸成条纹。
   */
  return 0
}

const createTileRectangleDegrees = (tile: GisTileRecord): [number, number, number, number] | undefined => {
  const longitude = toFiniteNumber(tile.longitude)
  const latitude = toFiniteNumber(tile.latitude)
  if (longitude === null || latitude === null) return undefined

  const longitudeTileCount = 2 ** (DEFAULT_LOCAL_TILE_RECTANGLE_LEVEL + 1)
  const latitudeTileCount = 2 ** DEFAULT_LOCAL_TILE_RECTANGLE_LEVEL
  const x = Math.floor(((longitude + 180) / 360) * longitudeTileCount)
  const y = Math.floor(((latitude + 90) / 180) * latitudeTileCount)
  const west = (x / longitudeTileCount) * 360 - 180
  const east = ((x + 1) / longitudeTileCount) * 360 - 180
  const south = (y / latitudeTileCount) * 180 - 90
  const north = (
    Math.min(y + DEFAULT_LOCAL_TILE_RECTANGLE_LAT_TILE_SPAN, latitudeTileCount) /
    latitudeTileCount
  ) * 180 - 90

  /**
   * 当前后端只给中心经纬度，没有给真实行政区 bounds。
   * 文昌市低层级瓦片显示为“白底上的城市轮廓”，用 8 级瓦片格生成城市级 rectangle：
   * 既限制影像只出现在文昌周边，又避免把中心点附近的极小 rectangle 拉成十字条纹。
   */
  return [west, south, east, north]
}

const resolveTileYOrigin = (tile?: GisTileRecord | null, fallback?: unknown): 'tms' | 'xyz' => {
  const sliceRule = typeof tile?.sliceRule === 'string' ? tile.sliceRule.toLowerCase() : ''
  if (sliceRule.includes('xyz')) return 'xyz'
  if (sliceRule.includes('tms')) return 'tms'
  return typeof fallback === 'string' && fallback.toLowerCase() === 'xyz' ? 'xyz' : 'tms'
}

export const createEditorGisLocalImageryLayerOptions = (
  tile?: GisTileRecord | null,
  previousOptions: Record<string, unknown> = {},
): Record<string, unknown> => {
  const nextOptions: Record<string, unknown> = {
    ...previousOptions,
    fileExtension: typeof previousOptions.fileExtension === 'string'
      ? previousOptions.fileExtension
      : 'jpg',
    yOrigin: resolveTileYOrigin(tile, previousOptions.yOrigin),
  }

  if (!tile) return nextOptions

  const maximumLevel = resolveMaximumTileLevel(tile, previousOptions.maximumLevel)
  const rectangleDegrees = createTileRectangleDegrees(tile)
  nextOptions.tileSize = toFiniteNumber(tile.tileSize) ?? 256
  nextOptions.maximumLevel = maximumLevel
  nextOptions.minimumLevel = resolveMinimumTileLevel()
  nextOptions.fileExtension = 'jpg'
  if (rectangleDegrees) {
    nextOptions.rectangleDegrees = rectangleDegrees
  }

  return nextOptions
}

export const createEditorGisLocalImageryLayerMetadata = (
  tile?: GisTileRecord | null,
  previousMetadata: Record<string, unknown> = {},
): Record<string, unknown> => {
  if (!tile) return { ...previousMetadata }

  return {
    ...previousMetadata,
    source: 'webgis-info',
    tileId: tile.id,
    sliceRule: tile.sliceRule,
    coordinate: tile.coordinate,
    longitude: tile.longitude,
    latitude: tile.latitude,
    credit: tile.gisName || previousMetadata.credit || 'Local TMS',
  }
}

const createDefaultLocalImageryLayer = (tile: GisTileRecord): SceneLayer => {
  const tilePath = getTilePath(tile) ?? ''

  return {
    id: DEFAULT_GIS_IMAGERY_LAYER_ID,
    name: tile.gisName || '默认本地影像',
    type: 'imagery',
    visible: true,
    locked: true,
    opacity: 1,
    order: -100,
    provider: 'local',
    url: resolveTileBaseUrl(tilePath),
    options: createEditorGisLocalImageryLayerOptions(tile),
    metadata: {
      /**
       * 该图层是编辑器按后端影像目录自动补齐的公司内网真实底图。
       * 不能标记 runtimeFallback，否则下次加载会被兜底清理逻辑误删。
       */
      editorDefaultLocalImagery: true,
      ...createEditorGisLocalImageryLayerMetadata(tile),
    },
  }
}

const isLocalImageryLayer = (layer: SceneLayer): boolean =>
  layer.type === 'imagery' && layer.provider === 'local' && !layer.metadata?.imageryPresetId

const normalizeTileId = (value: unknown): string | null => {
  if (typeof value === 'string') return value.trim() || null
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : null
}

interface GisTileLookup {
  byId: ReadonlyMap<string, GisTileRecord>
  byPath: ReadonlyMap<string, GisTileRecord>
}

/**
 * 单次建立切片编号和规范路径索引。
 * 重新打开含多个本地图层的场景时优先执行常数时间查询，避免每个图层重复遍历完整 GIS 列表。
 */
const createGisTileLookup = (tiles: readonly GisTileRecord[]): GisTileLookup => {
  const byId = new Map<string, GisTileRecord>()
  const byPath = new Map<string, GisTileRecord>()

  for (const tile of tiles) {
    const tileId = normalizeTileId(tile.id)
    const tilePath = getTilePath(tile)
    if (tileId) byId.set(tileId, tile)
    if (tilePath) byPath.set(normalizeTilePathForMatching(tilePath), tile)
  }

  return { byId, byPath }
}

const findMatchingTileRecord = (layer: SceneLayer, lookup: GisTileLookup): GisTileRecord | null => {
  /**
   * 新旧四包都保留 tileId，它不受服务主机和目录调整影响，因此必须优先于 URL 匹配。
   * 这也是修复已保存但缺失 URL 的历史本地图层所需的恢复入口。
   */
  const tileId = normalizeTileId(layer.metadata?.tileId)
  if (tileId) {
    const tile = lookup.byId.get(tileId)
    if (tile) return tile
  }

  const layerPath = normalizeLayerUrlPathForMatching(layer.url ?? layer.asset?.url)
  if (!layerPath) return null

  const exactTile = lookup.byPath.get(layerPath)
  if (exactTile) return exactTile

  /** 兼容历史数据只保存部分目录的情况；常规编号或完整路径命中时不会进入该线性兜底。 */
  for (const [normalizedTilePath, tile] of lookup.byPath) {
    if (
      layerPath.endsWith(`/${normalizedTilePath}`) ||
      normalizedTilePath.endsWith(`/${layerPath}`)
    ) {
      return tile
    }
  }
  return null
}

const enrichLocalImageryLayersFromTiles = (
  scene: SceneDefinition,
  tiles: readonly GisTileRecord[],
): SceneDefinition => {
  let changed = false
  const lookup = createGisTileLookup(tiles)

  const layers = scene.layers.map((layer) => {
    if (!isLocalImageryLayer(layer)) return layer

    const tile = findMatchingTileRecord(layer, lookup)
    if (!tile) return layer
    const tilePath = getTilePath(tile)
    if (!tilePath) return layer

    changed = true
    return {
      ...layer,
      /** 历史四包可能仅有 tileId；这里使用接口返回的最新目录补回本次运行所需地址。 */
      url: resolveTileBaseUrl(tilePath),
      options: createEditorGisLocalImageryLayerOptions(tile, layer.options ?? {}),
      metadata: createEditorGisLocalImageryLayerMetadata(tile, layer.metadata ?? {}),
    }
  })

  return changed ? { ...scene, layers } : scene
}

const applyTileOrigin = (scene: SceneDefinition, tile: GisTileRecord): SceneDefinition => {
  if (scene.coordinateSystem.kind !== 'wgs84') return scene

  const longitude = toFiniteNumber(tile.longitude)
  const latitude = toFiniteNumber(tile.latitude)
  if (longitude === null || latitude === null) return scene

  /**
   * 旧 GIS 面板在选择影像后会飞到影像记录的经纬度。
   * 新平台没有直接操作旧 sceneApi，因此这里把该经纬度写入默认坐标系统，
   * 让 Unity GIS 的地理原点与默认相机直接定位到本地切片区域。
   */
  return {
    ...scene,
    coordinateSystem: {
      ...scene.coordinateSystem,
      defaultLongitude: longitude,
      defaultLatitude: latitude,
    },
  }
}

/**
 * 规范化 GIS 场景影像配置。
 *
 * 空 GIS 场景不主动请求或选择本地切片，由 Unity 创建椭球地表；
 * 本地切片只有在用户主动配置并保存到场景定义后，才允许通过 GIS 数据接口补齐层级和范围。
 * 这样可避免把某一条临时本地数据误当成所有新场景的默认底图。
 */
export const ensureEditorGisDefaultImageryLayer = async (
  scene: SceneDefinition,
  options: EditorGisDefaultLayerOptions = {},
): Promise<SceneDefinition> => {
  if (scene.type !== 'gis') return scene

  const sceneWithoutRuntimeFallback = removeRuntimeFallbackImageryLayers(scene)
  const shouldEnrichLocalImagery = sceneWithoutRuntimeFallback.layers.some(isLocalImageryLayer)
  if (!shouldEnrichLocalImagery) {
    return sceneWithoutRuntimeFallback
  }

  try {
    const api = options.api ?? await loadDefaultGisTileApi()
    const response = await api.listGisTile('SATELLITE')
    const readyTiles = isSuccessCode(response.code)
      ? (response.data ?? []).filter(isReadyTileDirectory)
      : []
    const sceneWithEnrichedLocalImagery = shouldEnrichLocalImagery
      ? enrichLocalImageryLayersFromTiles(sceneWithoutRuntimeFallback, readyTiles)
      : sceneWithoutRuntimeFallback

    return sceneWithEnrichedLocalImagery
  } catch (error) {
    appLogger.warn('editorGisDefaultLayerAdapter', '补齐本地 GIS 影像配置失败，保留已保存图层配置', error)
    return sceneWithoutRuntimeFallback
  }
}
