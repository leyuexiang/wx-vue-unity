import type { VegetationPlantingRule, VegetationPolygonRule } from '@/scene-platform'

type SingleRuleRegion = {
  id: string
  name: string
  kind: VegetationPlantingRule['kind']
  rule: VegetationPlantingRule
}
export type ImageryRegion = {
  id: string
  name: string
  kind: 'imagery'
  patches: VegetationPolygonRule[]
}

const legacyImageryName = /^影像植被区 (\d+)$/

export function isImageryPlantingRule(rule: VegetationPlantingRule): boolean {
  return rule.kind === 'polygon' && (
    !!rule.imageryRegion || rule.id.startsWith('imagery-planting-') || legacyImageryName.test(rule.name)
  )
}

export function listVegetationRegions(rules: readonly VegetationPlantingRule[]) {
  const regions: (SingleRuleRegion | ImageryRegion)[] = []
  const imageryRegions = new Map<string, ImageryRegion>()
  let previousLegacy: { region: ImageryRegion; offset: number; ordinal: number } | undefined

  for (const rule of rules) {
    if (rule.kind !== 'polygon' || !isImageryPlantingRule(rule)) {
      regions.push({ id: rule.id, name: rule.name, kind: rule.kind, rule })
      previousLegacy = undefined
      continue
    }

    if (rule.imageryRegion) {
      const id = `imagery:${rule.imageryRegion.id}`
      const existing = imageryRegions.get(id)
      if (existing) existing.patches.push(rule)
      else {
        const region: ImageryRegion = { id, name: rule.imageryRegion.name, kind: 'imagery', patches: [rule] }
        imageryRegions.set(id, region)
        regions.push(region)
      }
      previousLegacy = undefined
      continue
    }

    // 旧存档没有框选 ID。生成时斑块编号和随机偏移同步递增，禁种裁剪保留原编号与偏移。
    const ordinal = Number(legacyImageryName.exec(rule.name)?.[1])
    const offset = rule.seedOffset - ordinal
    if (previousLegacy && previousLegacy.offset === offset && ordinal >= previousLegacy.ordinal) {
      previousLegacy.region.patches.push(rule)
      previousLegacy.ordinal = ordinal
    } else {
      const region: ImageryRegion = {
        id: `imagery:${rule.id}`,
        name: Number.isFinite(ordinal) ? '影像种植区' : rule.name,
        kind: 'imagery',
        patches: [rule],
      }
      regions.push(region)
      previousLegacy = { region, offset, ordinal }
    }
  }
  return regions
}
