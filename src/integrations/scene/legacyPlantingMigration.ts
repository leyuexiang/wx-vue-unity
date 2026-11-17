import type {
  VegetationGeoPosition,
  VegetationPlantingRule,
  VegetationSystemDefinition,
} from '@/scene-platform'
import { validateVegetationSystemDefinition } from '@/scene-platform/core/vegetation'

type RecordValue = Record<string, unknown>
const record = (value: unknown): value is RecordValue =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const number = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

/** Import the existing PlantingDataContainer without guessing resource identities or replacing current rules. */
export function migrateLegacyPlantings(
  input: unknown,
  current: VegetationSystemDefinition,
): VegetationSystemDefinition {
  const values = Array.isArray(input)
    ? input
    : record(input) && Array.isArray(input.plantings)
      ? input.plantings
      : null
  if (!values) throw new Error('请选择包含 plantings 数组的旧植被 JSON 文件')
  const next = structuredClone(current)
  const layer = next.layers[0]
  if (!layer) throw new Error('请先创建植被图层')
  const names = new Map<string, string>()
  for (const species of next.speciesCatalog) {
    if (names.has(species.name))
      throw new Error(`物种名称“${species.name}”重复，请重命名后导入`)
    names.set(species.name, species.id)
    names.set(species.id, species.id)
  }
  for (const value of values) {
    if (
      !record(value) ||
      !Array.isArray(value.geoPoints) ||
      !Array.isArray(value.treeTypes)
    )
      throw new Error('旧植被缺少 geoPoints 或 treeTypes')
    const id = String(value.plantingId ?? '').trim()
    if (!id || next.rules.some((rule) => rule.id === id))
      throw new Error(`旧种植区域编号缺失或重复：${id}`)
    const points = value.geoPoints.map((item): VegetationGeoPosition => {
      if (
        !record(item) ||
        typeof item.longitude !== 'number' ||
        typeof item.latitude !== 'number'
      )
        throw new Error('旧植被坐标无效')
      return [item.longitude, item.latitude, number(item.height, 0)]
    })
    const mix = value.treeTypes
      .map((item) => {
        if (!record(item) || typeof item.treeType !== 'string')
          throw new Error('旧植被树种配置无效')
        const speciesId = names.get(item.treeType)
        if (!speciesId)
          throw new Error(`请先添加并命名物种“${item.treeType}”，然后重新导入`)
        return { speciesId, weight: number(item.ratio, 1) }
      })
      .filter((item) => item.weight > 0)
    const base = {
      id,
      name: String(value.plantingName ?? id),
      enabled: value.currentPlantingVisibility !== false,
      layerId: layer.id,
      priority: 0,
      seedOffset: next.rules.length,
      speciesMix: mix,
    }
    const isLine = value.drawMode === 3 || value.drawMode === 'Line'
    let rule: VegetationPlantingRule
    if (isLine) {
      rule = {
        ...base,
        kind: 'corridor',
        path: points,
        side: 'left',
        offsetM: 0,
        spacingM: Math.max(1, number(value.treeSpacing, 5)),
        startOffsetM: 0,
        endOffsetM: 0,
        alignToPath: true,
      }
    } else {
      if (
        points.length &&
        (points[0]![0] !== points[points.length - 1]![0] ||
          points[0]![1] !== points[points.length - 1]![1])
      )
        points.push([...points[0]!] as VegetationGeoPosition)
      rule = {
        ...base,
        kind: 'polygon',
        polygon: { rings: [points] },
        distribution: 'poisson',
        targetCount: Math.max(1, Math.round(number(value.totalTrees, 100))),
        densityPerHectare: 100,
        minimumSpacingM: Math.max(1, number(value.treeSpacing, 5)),
      }
    }
    next.rules.push(rule)
  }
  next.streaming.renderMode = 'instanced'
  const result = validateVegetationSystemDefinition(next, 'gis')
  if (result.issues.length) throw new Error(result.issues[0])
  return next
}
