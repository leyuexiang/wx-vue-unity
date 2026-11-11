import type { SceneLayer, VegetationGeoPolygon, VegetationGeoPosition, VegetationPlantingRule, VegetationSystemDefinition } from '@/scene-platform'
import { EDITOR_GIS_SOURCE_HOST, createEditorGisLocalImageryLayerOptions } from './editorGisDefaultLayerAdapter'
import { EDITOR_GIS_IMAGERY_PRESETS, isSelectableGisTile } from './editorSceneGisAdapter'
import { isImageryPlantingRule } from './editorVegetationRegions'

type ImagerySource = Pick<SceneLayer, 'name' | 'provider' | 'url' | 'options'>
type Tile = { x: number; y: number }
type Bounds = { left: number; top: number; right: number; bottom: number }
export type ImageryExclusion = NonNullable<VegetationSystemDefinition['imageryExclusions']>[number]
export interface VegetationImageryPreview {
  preview: string
  coverage: number
  sourceName?: string
  reconstructed?: boolean
  missing?: number
  waterExcluded?: boolean
  manualExcluded?: boolean
  truncated?: boolean
  replaced?: number
}
const maxMercatorLatitude = 85.0511287798066
const maxTiles = 36
const maxRasterSide = 768
const maxPatches = 512

export function vegetationImageryLayer(layers: readonly SceneLayer[]): SceneLayer | undefined {
  return layers.filter(layer => layer.type === 'imagery' && layer.visible)
    .sort((a, b) => b.order - a.order)[0]
}

export function vegetationImageryBox(
  first: VegetationGeoPosition, second: VegetationGeoPosition,
): VegetationGeoPosition[] {
  const west = Math.min(first[0], second[0])
  const east = Math.max(first[0], second[0])
  const south = Math.min(first[1], second[1])
  const north = Math.max(first[1], second[1])
  const height = ((first[2] ?? 0) + (second[2] ?? 0)) / 2
  return [[west, south, height], [east, south, height], [east, north, height], [west, north, height]]
}

function subtractBounds(rectangle: Bounds, exclusion: Bounds): Bounds[] {
  const left = Math.max(rectangle.left, exclusion.left)
  const right = Math.min(rectangle.right, exclusion.right)
  const top = Math.max(rectangle.top, exclusion.top)
  const bottom = Math.min(rectangle.bottom, exclusion.bottom)
  if (left >= right || top >= bottom) return [rectangle]
  return [
    { ...rectangle, bottom: top },
    { ...rectangle, top: bottom },
    { left: rectangle.left, right: left, top, bottom },
    { left: right, right: rectangle.right, top, bottom },
  ].filter(part => part.left < part.right && part.top < part.bottom)
}

export function clipImageryPlantingRule(rule: VegetationPlantingRule, [west, south, east, north]: ImageryExclusion,
  newId: () => string): VegetationPlantingRule[] {
  if (rule.kind !== 'polygon' || !isImageryPlantingRule(rule) || rule.targetCount !== undefined ||
    rule.polygon.rings.length !== 1) return [rule]
  const ring = rule.polygon.rings[0]!
  if (ring.length !== 5) return [rule]
  const corners = ring.slice(0, -1)
  const xs = [...new Set(corners.map(point => point[0]))].sort((a, b) => a - b)
  const ys = [...new Set(corners.map(point => -point[1]))].sort((a, b) => a - b)
  if (xs.length !== 2 || ys.length !== 2 || new Set(corners.map(point => point.slice(0, 2).join(','))).size !== 4 ||
    !corners.every((point, index) => {
      const next = corners[(index + 1) % corners.length]!
      return point[0] === next[0] || point[1] === next[1]
    })) return [rule]
  const rectangle = { left: xs[0]!, right: xs[1]!, top: ys[0]!, bottom: ys[1]! }
  const parts = subtractBounds(rectangle, { left: west, right: east, top: -north, bottom: -south })
  if (parts[0] === rectangle) return [rule]
  return parts.map(({ left, right, top, bottom }, index) => ({
    ...rule,
    id: index === 0 ? rule.id : newId(),
    polygon: { rings: [[[left, -bottom], [right, -bottom], [right, -top], [left, -top], [left, -bottom]]] },
  }))
}

function tilePlan(layer: ImagerySource, box: VegetationGeoPosition[]) {
  const options = layer.options ?? {}
  const local = layer.provider === 'local'
  let template = layer.url
  if (!template || !/^https?:\/\//i.test(template) || layer.provider === 'wms' || layer.provider === 'wmts')
    throw new Error('请在 GIS 配置中选择可读取的本地卫星切片或 XYZ 影像。')
  if (local && !template.includes('{z}')) {
    const extension = typeof options.fileExtension === 'string' ? options.fileExtension : 'jpg'
    const suffixIndex = template.search(/[?#]/)
    const base = suffixIndex < 0 ? template : template.slice(0, suffixIndex)
    const suffix = suffixIndex < 0 ? '' : template.slice(suffixIndex)
    template = base.replace(/\/+$/, '') + '/{z}/{x}/{y}.' + extension + suffix
  }
  if (!template.includes('{z}') || !template.includes('{x}') ||
    !/\{(?:y|reverseY)\}/.test(template) || /\{(?!z\}|x\}|y\}|reverseY\})/.test(template))
    throw new Error('当前影像没有可读取的 XYZ/TMS 瓦片地址。')

  const geographic = local || options.projection === 'EPSG:4326' || options.tilingScheme === 'geographic'
  const tms = options.yOrigin === 'tms' || (local && options.yOrigin !== 'xyz')
  const [west, south] = box[0]!
  const [east, north] = box[2]!
  if (east === west || north === south || east - west > 180)
    throw new Error('请框选一个有效区域，两个角点的经纬度都需要不同。')
  if (!geographic && (south < -maxMercatorLatitude || north > maxMercatorLatitude))
    throw new Error('框选范围超出当前影像的纬度覆盖。')
  const northing = (latitude: number) => geographic
    ? (90 - latitude) / 180
    : (1 - Math.asinh(Math.tan(latitude * Math.PI / 180)) / Math.PI) / 2
  const latitudeAt = (y: number) => geographic
    ? 90 - 180 * y
    : Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI
  const levelOption = (value: unknown, fallback: number) =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 24 ? value : fallback
  const minLevel = levelOption(options.minimumLevel, 0)
  const maxLevel = levelOption(options.maximumLevel, 18)
  const tileSize = typeof options.tileSize === 'number' && options.tileSize >= 64 && options.tileSize <= 1024
    ? options.tileSize : 256
  const widthM = (east - west) * 111320 * Math.cos((north + south) * Math.PI / 360)
  const heightM = (north - south) * 111320

  for (let z = maxLevel; z >= minLevel; z--) {
    const rows = 2 ** z
    const columns = geographic ? rows * 2 : rows
    const bounds: Bounds = {
      left: (west + 180) / 360 * columns, right: (east + 180) / 360 * columns,
      top: Math.max(0, northing(north) * rows), bottom: Math.min(rows, northing(south) * rows),
    }
    const left = Math.floor(bounds.left), top = Math.floor(bounds.top)
    const right = Math.ceil(bounds.right), bottom = Math.ceil(bounds.bottom)
    if ((right - left) * (bottom - top) > maxTiles) continue
    const width = (bounds.right - bounds.left) * tileSize
    const height = (bounds.bottom - bounds.top) * tileSize
    if (Math.min(width, height) < 8 || Math.max(widthM / width, heightM / height) > 25)
      throw new Error('当前影像在框选区域的分辨率过低，请切换更清晰的卫星影像。')
    const scale = Math.min(1, maxRasterSide / Math.max(width, height))
    const rasterWidth = Math.max(1, Math.round(width * scale))
    const rasterHeight = Math.max(1, Math.round(height * scale))
    const tiles: Tile[] = []
    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) tiles.push({ x, y })
    }
    return {
      z, tiles, bounds,
      width: rasterWidth,
      height: rasterHeight,
      pixelPoint: ([longitude, latitude]: VegetationGeoPosition): [number, number] => [
        (longitude - west) / (east - west) * rasterWidth,
        (northing(latitude) * rows - bounds.top) / (bounds.bottom - bounds.top) * rasterHeight,
      ],
      pixelBounds: ([excludedWest, excludedSouth, excludedEast, excludedNorth]: ImageryExclusion): Bounds => ({
        left: (excludedWest - west) / (east - west) * rasterWidth,
        right: (excludedEast - west) / (east - west) * rasterWidth,
        top: (northing(Math.min(north, excludedNorth)) * rows - bounds.top) / (bounds.bottom - bounds.top) * rasterHeight,
        bottom: (northing(Math.max(south, excludedSouth)) * rows - bounds.top) / (bounds.bottom - bounds.top) * rasterHeight,
      }),
      url: ({ x, y }: Tile) => template.replace(/\{(z|x|y|reverseY)\}/g, (_, token: string) =>
        String(token === 'z' ? z : token === 'x' ? x : (token === 'reverseY' || tms ? rows - 1 - y : y))),
      point: (x: number, y: number): VegetationGeoPosition => [
        x === 0 ? west : x === 1 ? east : ((bounds.left + x * (bounds.right - bounds.left)) / columns) * 360 - 180,
        y === 0 ? north : y === 1 ? south : latitudeAt((bounds.top + y * (bounds.bottom - bounds.top)) / rows),
      ],
    }
  }
  throw new Error('框选区域超过可读取的影像范围，请缩小范围。')
}

function isSmoothWaterPixel(image: ImageData, x: number, y: number) {
  const { width, height, data } = image
  const offset = (y * width + x) * 4
  const red = data[offset]!, green = data[offset + 1]!, blue = data[offset + 2]!
  if (data[offset + 3]! < 250 || green < 12 || green > 120 || green - red < -3 || blue - red < 3)
    return false
  const blueWater = blue >= green - 5
  // Algae or sediment can give ponds a muted green cast. Require an even
  // smoother surface in that case to preserve the surrounding crowns.
  if (!blueWater && (green - blue > 16 || green - red > 32)) return false
  // Check a wider neighbourhood than the canopy texture test. Calm water stays
  // locally smooth even when ripples or isolated reflections add texture to the cell.
  const limit = blueWater ? 7 : 4
  const horizontal = data[(y * width + Math.min(width - 1, x + 1)) * 4 + 1]!
  const vertical = data[(Math.min(height - 1, y + 1) * width + x) * 4 + 1]!
  if (Math.abs(green - horizontal) > limit || Math.abs(green - vertical) > limit) return false
  const west = data[(y * width + Math.max(0, x - 2)) * 4 + 1]!
  const east = data[(y * width + Math.min(width - 1, x + 2)) * 4 + 1]!
  const north = data[(Math.max(0, y - 2) * width + x) * 4 + 1]!
  const south = data[(Math.min(height - 1, y + 2) * width + x) * 4 + 1]!
  const range = Math.max(green, west, east, north, south) - Math.min(green, west, east, north, south)
  return range <= limit
}

function expandWaterMask(fractions: Float32Array, roughWater: Float32Array, columns: number, rows: number) {
  const core = Uint8Array.from(fractions, fraction => Number(fraction >= 0.32))
  const water = core.slice()
  const at = (mask: Uint8Array, column: number, row: number) =>
    column >= 0 && column < columns && row >= 0 && row < rows ? mask[row * columns + column]! : 0
  // Water with ripples has a similar colour to the calm part of the pond,
  // even when its texture fails the smooth-water test.
  for (let step = 0; step < 2; step++) {
    const previous = water.slice()
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const index = row * columns + column
        if (roughWater[index]! >= 0.76 && (at(previous, column - 1, row) ||
          at(previous, column + 1, row) || at(previous, column, row - 1) || at(previous, column, row + 1)))
          water[index] = 1
      }
    }
  }
  const surface = water.slice()
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const index = row * columns + column
      const west = at(surface, column - 1, row), east = at(surface, column + 1, row)
      const north = at(surface, column, row - 1), south = at(surface, column, row + 1)
      const neighbours = west + east + north + south
      if (neighbours >= 3 || (neighbours && fractions[index]! >= 0.10) ||
        (fractions[index]! >= 0.05 && (west && east || north && south))) water[index] = 1
    }
  }

  // Flood from the frame boundary. Reflections can span many cells, but an
  // opening wholly enclosed by the connected pond surface still belongs to it.
  const exterior = new Uint8Array(water.length)
  const queue: number[] = []
  const visit = (index: number) => {
    if (water[index] || exterior[index]) return
    exterior[index] = 1
    queue.push(index)
  }
  for (let column = 0; column < columns; column++) {
    visit(column)
    visit((rows - 1) * columns + column)
  }
  for (let row = 1; row < rows - 1; row++) {
    visit(row * columns)
    visit((row + 1) * columns - 1)
  }
  for (let head = 0; head < queue.length; head++) {
    const index = queue[head]!, column = index % columns
    if (column > 0) visit(index - 1)
    if (column < columns - 1) visit(index + 1)
    if (index >= columns) visit(index - columns)
    if (index < water.length - columns) visit(index + columns)
  }
  for (let index = 0; index < water.length; index++) {
    if (!exterior[index]) water[index] = 1
  }
  return water
}

function classifyVegetationRaster(image: ImageData) {
  const { width, height, data } = image
  const cellSize = Math.max(6, Math.ceil(Math.max(width, height) / 64))
  const columns = Math.ceil(width / cellSize)
  const rows = Math.ceil(height / cellSize)
  const vegetation = new Uint8Array(rows * columns)
  const canopy = new Uint8Array(width * height)
  const exposedSurface = new Uint8Array(width * height)
  const mixedSurface = new Uint8Array(rows * columns)
  const waterFraction = new Float32Array(rows * columns)
  const roughWaterFraction = new Float32Array(rows * columns)
  const water: Bounds[] = []
  const cellBounds = (column: number, row: number): Bounds => ({
    left: Math.floor(column * width / columns), right: Math.floor((column + 1) * width / columns),
    top: Math.floor(row * height / rows), bottom: Math.floor((row + 1) * height / rows),
  })

  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const { left, right, top, bottom } = cellBounds(column, row)
      const index = row * columns + column
      let greenPixels = 0, canopyPixels = 0, texture = 0, waterPixels = 0, roughWaterPixels = 0
      for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++) {
          if (isSmoothWaterPixel(image, x, y)) waterPixels++
          const pixel = y * width + x
          const offset = pixel * 4
          const red = data[offset]!, green = data[offset + 1]!, blue = data[offset + 2]!
          if (data[offset + 3]! >= 250 && green >= 12 && green <= 110 &&
            blue >= green + 3 && green - red >= -3 && green - red <= 11) roughWaterPixels++
          // Warm, neutral, and bright blue surfaces can appear next to crowns
          // within the same cell. Keep dark, inconclusive pixels as shadows.
          if (data[offset + 3]! < 250 || (red >= 65 && red - green > 4) ||
            (green >= 92 && Math.max(red, green, blue) - Math.min(red, green, blue) <= 12) ||
            (green >= 70 && blue - green > 28)) {
            exposedSurface[pixel] = 1
            mixedSurface[index] = 1
            continue
          }
          if (green < 26 || green - red < 4) continue
          const greenLeaf = green - blue >= 6 && (2 * green - red - blue) / (red + green + blue) >= 0.08
          // Shadowed crowns can have a blue-green cast. Their cell still needs texture.
          const shadedLeaf = green <= 110 && blue - green <= 22 && green - blue <= 12
          if (!greenLeaf && !shadedLeaf) continue
          if (greenLeaf) greenPixels++
          canopy[pixel] = 1
          canopyPixels++
          if (x + 1 < right) texture += Math.abs(green - data[offset + 5]!)
          if (y + 1 < bottom) texture += Math.abs(green - data[offset + width * 4 + 1]!)
        }
      }
      const area = (right - left) * (bottom - top)
      waterFraction[index] = waterPixels / area
      roughWaterFraction[index] = roughWaterPixels / area
      vegetation[index] = Number(greenPixels >= area * 0.75 || canopyPixels >= area * 0.65 && texture >= area * 9)
    }
  }

  const waterMask = expandWaterMask(waterFraction, roughWaterFraction, columns, rows)
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const index = row * columns + column
      if (waterMask[index]) {
        vegetation[index] = 0
        water.push(cellBounds(column, row))
      }
    }
  }

  const patches: Bounds[] = []
  let previous = new Map<string, Bounds>()
  const fineRows = rows * 2, fineColumns = columns * 2
  const containsCanopyWithoutExposedSurface = (left: number, right: number, top: number, bottom: number) => {
    let leaves = 0
    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) {
        const pixel = y * width + x
        if (exposedSurface[pixel]) return false
        leaves += canopy[pixel]!
      }
    }
    return leaves * 2 >= (right - left) * (bottom - top)
  }

  // Check smaller rectangles inside the positive cells. A cell dominated by
  // foliage can also contain part of a roof, road, or other exposed surface.
  for (let row = 0; row < fineRows; row++) {
    const top = Math.floor(row * height / fineRows)
    const bottom = Math.floor((row + 1) * height / fineRows)
    const current = new Map<string, Bounds>()
    let start: number | undefined
    for (let column = 0; column <= fineColumns; column++) {
      const left = Math.floor(column * width / fineColumns)
      const right = Math.floor((column + 1) * width / fineColumns)
      const index = Math.floor(row / 2) * columns + Math.floor(column / 2)
      // Leave a half-cell setback along banks. The other half of a narrow
      // bank remains available where the aerial imagery supports it.
      const touchesWater = (column % 2 === 0
        ? column > 0 && waterMask[index - 1]
        : column + 1 < fineColumns && waterMask[index + 1]) ||
        (row % 2 === 0
          ? row > 0 && waterMask[index - columns]
          : row + 1 < fineRows && waterMask[index + columns])
      if (column < fineColumns && vegetation[index] &&
        !touchesWater && (!mixedSurface[index] || containsCanopyWithoutExposedSurface(left, right, top, bottom))) {
        start ??= left
        continue
      }
      if (start !== undefined) {
        const key = `${start}:${left}`
        const patch = previous.get(key) ?? { left: start, top, right: left, bottom }
        if (!previous.has(key)) patches.push(patch)
        patch.bottom = bottom
        current.set(key, patch)
        start = undefined
      }
    }
    previous = current
  }
  return { patches, water }
}

async function loadVegetationImageryRaster(layer: ImagerySource, box: VegetationGeoPosition[], cancellation: AbortSignal) {
  const plan = tilePlan(layer, box)
  const timeout = AbortSignal.timeout(25000)
  const signal = AbortSignal.any([cancellation, timeout])
  const canvas = document.createElement('canvas')
  canvas.width = plan.width
  canvas.height = plan.height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('当前浏览器无法处理影像。')
  const xScale = plan.width / (plan.bounds.right - plan.bounds.left)
  const yScale = plan.height / (plan.bounds.bottom - plan.bounds.top)
  const pending = plan.tiles.values()
  let missing = 0
  let loaded = 0

  await Promise.all(Array.from({ length: 4 }, async () => {
    for (const tile of pending) {
      try {
        signal.throwIfAborted()
        const response = await fetch(plan.url(tile), { signal, credentials: 'omit' })
        if (response.status === 404) { missing++; continue }
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const bitmap = await createImageBitmap(await response.blob())
        try {
          signal.throwIfAborted()
          const x = Math.round((tile.x - plan.bounds.left) * xScale)
          const y = Math.round((tile.y - plan.bounds.top) * yScale)
          const right = Math.round((tile.x + 1 - plan.bounds.left) * xScale)
          const bottom = Math.round((tile.y + 1 - plan.bounds.top) * yScale)
          context.drawImage(bitmap, x, y, right - x, bottom - y)
          loaded++
        } finally {
          bitmap.close()
        }
      } catch {
        cancellation.throwIfAborted()
        if (timeout.aborted) throw new Error('读取影像超时，请缩小范围或检查影像服务。')
        throw new Error('读取影像失败，请检查影像地址、跨域权限及 HTTP/HTTPS 配置。')
      }
    }
  }))
  if (!loaded) throw new Error('当前影像没有覆盖框选区域，请重新框选或切换影像。')
  return { canvas, context, plan, missing }
}

export async function recognizeVegetationImagery(
  layer: ImagerySource, box: VegetationGeoPosition[], cancellation: AbortSignal,
  exclusions: readonly ImageryExclusion[] = [],
) {
  const { canvas, context, plan, missing } = await loadVegetationImageryRaster(layer, box, cancellation)
  const { patches, water } = classifyVegetationRaster(context.getImageData(0, 0, plan.width, plan.height))
  const [west, south] = box[0]!, [east, north] = box[2]!
  const excluded = exclusions.filter(bounds => bounds[0] < east && bounds[2] > west && bounds[1] < north && bounds[3] > south)
    .map(plan.pixelBounds)
  let planting = patches
  for (const bounds of excluded) planting = planting.flatMap(patch => subtractBounds(patch, bounds))
  const patchArea = ({ left, right, top, bottom }: Bounds) => (right - left) * (bottom - top)
  const truncated = planting.length > maxPatches
  if (truncated) planting = planting.sort((a, b) => patchArea(b) - patchArea(a)).slice(0, maxPatches)
  const coverage = planting.reduce((area, patch) => area + patchArea(patch), 0) / (plan.width * plan.height)
  context.fillStyle = 'rgba(56, 159, 245, 0.45)'
  for (const { left, right, top, bottom } of water) {
    context.fillRect(left, top, right - left, bottom - top)
  }
  context.fillStyle = 'rgba(255, 175, 55, 0.45)'
  for (const { left, right, top, bottom } of excluded) {
    context.fillRect(left, top, right - left, bottom - top)
  }
  context.fillStyle = 'rgba(68, 255, 152, 0.5)'
  const rings = planting.map(({ left, right, top, bottom }) => {
    context.fillRect(left, top, right - left, bottom - top)
    const sw = plan.point(left / plan.width, bottom / plan.height)
    return [sw, plan.point(right / plan.width, bottom / plan.height),
      plan.point(right / plan.width, top / plan.height), plan.point(left / plan.width, top / plan.height), sw]
  })
  return { rings, coverage, missing, waterExcluded: water.length > 0, manualExcluded: excluded.length > 0,
    truncated, sourceName: layer.name,
    preview: canvas.toDataURL('image/jpeg', 0.85) }
}

function coversBox(bounds: unknown, box: VegetationGeoPosition[]) {
  if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isFinite)) return false
  const [west, south] = box[0]!
  const [east, north] = box[2]!
  return west >= bounds[0] && south >= bounds[1] && east <= bounds[2] && north <= bounds[3]
}

async function readVegetationSelection<T extends { missing: number }>(
  layer: SceneLayer | undefined, box: VegetationGeoPosition[], signal: AbortSignal,
  read: (source: ImagerySource) => Promise<T>,
) {
  if (layer) return read(layer)
  if (box[0]![0] === box[2]![0] || box[0]![1] === box[2]![1] || box[2]![0] - box[0]![0] > 180)
    throw new Error('请框选一个有效区域，两个角点的经纬度都需要不同。')

  async function trySource(source: ImagerySource) {
    try {
      const result = await read(source)
      // The directory bounds can be approximate, so automatic selection requires every requested tile.
      return result.missing === 0 ? result : undefined
    } catch {
      signal.throwIfAborted()
    }
  }

  for (const preset of EDITOR_GIS_IMAGERY_PRESETS) {
    if (!('bounds' in preset) || preset.options.maximumLevel < 12 || !coversBox(preset.bounds, box)) continue
    const result = await trySource({ ...preset, name: preset.label })
    if (result) return result
  }

  const { listGisTile } = await import('@/servers/manual/gis/api')
  const directory = await listGisTile('SATELLITE', signal).catch(() => undefined)
  signal.throwIfAborted()
  if (String(directory?.code) === '200') {
    const candidates = (directory?.data ?? []).filter(tile => isSelectableGisTile(tile, 'imagery'))
      .map(tile => {
        const path = tile.path.trim()
        return {
          name: tile.gisName || '卫星影像',
          provider: 'local' as const,
          url: /^https?:\/\//i.test(path) ? path : `${EDITOR_GIS_SOURCE_HOST}/${path.replace(/^\/+/, '')}`,
          options: createEditorGisLocalImageryLayerOptions(tile),
        }
      })
      .filter(source => coversBox(source.options.rectangleDegrees, box))
      .sort((a, b) => Number(b.options.maximumLevel) - Number(a.options.maximumLevel))
    for (const source of candidates) {
      const result = await trySource(source)
      if (result) return result
    }
  }
  throw new Error('框内没有找到可读取的卫星影像。可在「基础 → 影像配置」选择覆盖该区域的影像，再重新框选。')
}

export function recognizeVegetationSelection(
  layer: SceneLayer | undefined, box: VegetationGeoPosition[], signal: AbortSignal,
  exclusions: readonly ImageryExclusion[] = [],
) {
  return readVegetationSelection(layer, box, signal, source => recognizeVegetationImagery(source, box, signal, exclusions))
}

function paintSavedPlanting(
  context: CanvasRenderingContext2D,
  project: (point: VegetationGeoPosition) => [number, number],
  polygons: readonly VegetationGeoPolygon[],
  exclusions: readonly ImageryExclusion[],
) {
  const { width, height } = context.canvas
  context.fillStyle = 'rgba(255, 175, 55, 0.45)'
  for (const [west, south, east, north] of exclusions) {
    const [left, top] = project([west, north])
    const [right, bottom] = project([east, south])
    context.fillRect(left, top, right - left, bottom - top)
  }
  context.fillStyle = 'rgba(68, 255, 152, 0.5)'
  let area = 0
  for (const polygon of polygons) {
    context.beginPath()
    polygon.rings.forEach((ring, index) => {
      if (ring.length < 3) return
      const points = ring.map(project)
      let twiceArea = 0
      points.forEach(([x, y], offset) => {
        if (offset === 0) context.moveTo(x, y)
        else context.lineTo(x, y)
        const [nextX, nextY] = points[(offset + 1) % points.length]!
        twiceArea += x * nextY - nextX * y
      })
      context.closePath()
      area += (index === 0 ? 1 : -1) * Math.abs(twiceArea) / 2
    })
    context.fill('evenodd')
  }
  return Math.max(0, Math.min(1, area / (width * height)))
}

export function drawVegetationRegionPreview(
  box: VegetationGeoPosition[], polygons: readonly VegetationGeoPolygon[], exclusions: readonly ImageryExclusion[],
): VegetationImageryPreview | undefined {
  const [west, south] = box[0]!, [east, north] = box[2]!
  const width = (east - west) * Math.cos((south + north) * Math.PI / 360)
  const height = north - south
  const scale = 320 / Math.max(width, height)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  const context = canvas.getContext('2d')
  if (!context) return
  context.fillStyle = '#131c26'
  context.fillRect(0, 0, canvas.width, canvas.height)
  const coverage = paintSavedPlanting(context, ([longitude, latitude]) => [
    (longitude - west) / (east - west) * canvas.width,
    (north - latitude) / (north - south) * canvas.height,
  ], polygons, exclusions)
  return { preview: canvas.toDataURL('image/png'), coverage, reconstructed: true, manualExcluded: exclusions.length > 0 }
}

export function loadVegetationRegionPreview(
  layer: SceneLayer | undefined, box: VegetationGeoPosition[], signal: AbortSignal,
  polygons: readonly VegetationGeoPolygon[], exclusions: readonly ImageryExclusion[],
) {
  return readVegetationSelection(layer, box, signal, async source => {
    const { canvas, context, plan, missing } = await loadVegetationImageryRaster(source, box, signal)
    const coverage = paintSavedPlanting(context, plan.pixelPoint, polygons, exclusions)
    return { preview: canvas.toDataURL('image/jpeg', 0.85), coverage, sourceName: source.name, missing,
      reconstructed: true, manualExcluded: exclusions.length > 0 }
  })
}
