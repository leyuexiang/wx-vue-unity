import type {
  AssetKind,
  AssetRef,
  SceneType,
  VegetationEditingOptions,
  VegetationElevationSourceDefinition,
  VegetationPlantingRule,
  VegetationLayerDefinition,
  VegetationLayerKind,
  VegetationPublicationRef,
  VegetationQualityPreset,
  VegetationPublicationDensityProfile,
  VegetationSpeciesDefinition,
  VegetationStreamingOptions,
  VegetationSystemDefinition,
  VegetationThreeStreamingOptions,
  VegetationVerticalDatum,
} from './types'

/** 当前植被领域协议版本；该版本独立于场景总协议，便于发布清单按自身节奏演进。 */
export const CURRENT_VEGETATION_SCHEMA_VERSION = 3

/**
 * 植被物种允许的缩放输入边界。
 *
 * 最小值固定为 1，最大值放宽到 30；编辑器的双向范围滑块、场景校验和生成请求都复用这组边界，
 * 避免只修改界面后，30 倍比例仍在领域层被拒绝。
 */
export const VEGETATION_SPECIES_SCALE_RANGE = Object.freeze({ minimum: 1, maximum: 30 })

/** 新增物种和缺失旧字段的保守默认值仍为 1～3，避免升级后历史场景突然出现 30 倍树木。 */
export const VEGETATION_SPECIES_DEFAULT_SCALE_RANGE = Object.freeze({ minimum: 1, maximum: 3 })

/**
 * Cesium 首期的默认业务预算。
 *
 * 512 MB 与 45 帧只作为新建配置的保守基线，运行时仍需结合设备能力映射为实际瓦片参数；这里不能
 * 写入屏幕空间误差、Cesium3DTileset 或显存句柄等引擎细节。
 */
export const DEFAULT_VEGETATION_STREAMING_OPTIONS: Readonly<VegetationStreamingOptions> =
  Object.freeze({
    enabled: true,
    qualityPreset: 'balanced',
    memoryBudgetMB: 512,
    targetFps: 45,
    /** 与普通 GIS 模型保持一致：默认只显示相机一万米内的正式植被。 */
    maximumDisplayDistanceM: 10_000,
    /** 一千米恢复滞回可避免相机在一万米边界附近移动时反复切换显隐。 */
    distanceHysteresisM: 1_000,
  })

/** 新建植被系统的编辑默认值；单次增量面积默认限制为一公顷，避免浏览器预览失控。 */
export const DEFAULT_VEGETATION_EDITING_OPTIONS: Readonly<VegetationEditingOptions> = Object.freeze(
  {
    enabled: false,
    previewEnabled: true,
    maxDeltaAreaM2: 10_000,
    snapToTerrain: true,
  },
)

/** 无地形场景的安全默认值；它只允许平面技术验证，不会伪造海拔植被带。 */
export const DEFAULT_VEGETATION_ELEVATION_SOURCE: Readonly<VegetationElevationSourceDefinition> =
  Object.freeze({
    kind: 'none',
    verticalDatum: 'unknown',
    heightOffsetM: 0,
  })

const SUPPORTED_ASSET_KINDS = new Set<AssetKind>([
  'glb',
  'gltf',
  'image',
  'texture',
  'material',
  'effect',
  'hdr',
  'json',
  '3d-tiles',
])
const SUPPORTED_LAYER_KINDS = new Set<VegetationLayerKind>([
  'forest',
  'grass',
  'rocks',
  'crops',
  'custom',
])
const SUPPORTED_QUALITY_PRESETS = new Set<VegetationQualityPreset>([
  'high',
  'balanced',
  'performance',
])

/**
 * 推荐的单发布包密度比例与聚合边长：高清保留全部实例，均衡保留约四分之三，性能保留约一半。
 * 该常量只描述发布契约，不会在运行时对已生成瓦片做逐株过滤。
 */
export const DEFAULT_VEGETATION_PUBLICATION_DENSITY_PROFILES: Readonly<
  Record<VegetationQualityPreset, VegetationPublicationDensityProfile>
> = Object.freeze({
  high: Object.freeze({ densityRatio: 1, selection: 'stable-subset' as const, tileSizeM: 100 }),
  balanced: Object.freeze({
    densityRatio: 0.75,
    selection: 'stable-subset' as const,
    tileSizeM: 200,
  }),
  performance: Object.freeze({
    densityRatio: 0.55,
    selection: 'stable-subset' as const,
    tileSizeM: 400,
  }),
})

const SUPPORTED_VERTICAL_DATUMS = new Set<VegetationElevationSourceDefinition['verticalDatum']>([
  'ellipsoid',
  'orthometric',
  'unknown',
])
const MAX_VEGETATION_SPECIES = 10_000
const MAX_VEGETATION_RULES = 50_000
/** 单个父规则限制分带数量，防止恶意存档放大校验和编辑成本。 */
const MAX_ALTITUDE_ZONES_PER_RULE = 64
const MAX_RULE_COORDINATES = 100_000
const MAX_DENSITY_PER_HECTARE = 100_000
const MAX_SPACING_M = 10_000
const MAX_MEMORY_BUDGET_MB = 16_384
const MAX_TARGET_FPS = 240
/** 距离上限用于阻止无意义的超大场景值，同时覆盖地球尺度的业务配置。 */
const MAX_DISPLAY_DISTANCE_M = 100_000_000
const MAX_DELTA_AREA_M2 = 100_000_000
const MAX_THREE_LOADING_JOBS = 32
const MAX_THREE_UNLOAD_DELAY_MS = 600_000

type PlainRecord = Record<string, unknown>
type VegetationSystemDraft = Partial<
  Omit<
    VegetationSystemDefinition,
    | 'layers'
    | 'speciesCatalog'
    | 'rules'
    | 'elevationSource'
    | 'streaming'
    | 'editing'
    | 'publication'
  >
> & {
  layers?: unknown
  speciesCatalog?: unknown
  rules?: unknown
  elevationSource?: unknown
  streaming?: unknown
  editing?: unknown
  publication?: unknown
}

/** 创建植被系统时必须由业务明确给出的确定性生成参数。 */
export interface CreateVegetationSystemDefinitionInput {
  seed: number
  ruleSetId: string
  ruleSetVersion: string
  enabled?: boolean
  layers?: VegetationLayerDefinition[]
  speciesCatalog?: VegetationSpeciesDefinition[]
  rules?: VegetationPlantingRule[]
  elevationSource?: VegetationElevationSourceDefinition
  streaming?: Partial<VegetationStreamingOptions>
  editing?: Partial<VegetationEditingOptions>
  publication?: VegetationPublicationRef
}

/** 植被领域校验结果与场景校验保持相同形态，便于场景入口直接合并问题列表。 */
export interface VegetationValidationResult {
  issues: string[]
}

/** 保存包只保留稳定资产编号；运行态仍默认要求已解析的地址，不能借导出放宽渲染约束。 */
export interface VegetationValidationOptions {
  /** 仅在校验持久化正文时设为 false；存在的地址仍必须是非空字符串。 */
  requireAssetUrls?: boolean
}

/** 只接受原型为 Object 或 null 的普通对象，用于隔离引擎类实例与 DOM 对象。 */
function isPlainRecord(value: unknown): value is PlainRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0
}

/**
 * 深度校验纯 JSON 数据，并拒绝循环引用。
 *
 * 植被定义的体量只与图层和物种目录规模相关，不包含单株实例，因此在保存边界执行一次深度遍历的
 * 成本可控；它能阻止函数、Date、Map、Three/Cesium 类实例及非有限数值被 JSON.stringify 静默丢弃。
 */
function isSerializablePlainData(value: unknown, visiting = new WeakSet<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object') return false
  if (visiting.has(value)) return false

  visiting.add(value)
  const serializable = Array.isArray(value)
    ? value.every((item) => isSerializablePlainData(item, visiting))
    : isPlainRecord(value) &&
      Object.values(value).every((item) => isSerializablePlainData(item, visiting))
  visiting.delete(value)
  return serializable
}

/** 仅对真实普通对象补齐流式默认值；非法输入原样保留给校验层报告。 */
function normalizeStreamingOptions(value: unknown): unknown {
  if (value === undefined) return { ...DEFAULT_VEGETATION_STREAMING_OPTIONS }
  if (!isPlainRecord(value)) return value

  return {
    ...value,
    enabled:
      value.enabled === undefined ? DEFAULT_VEGETATION_STREAMING_OPTIONS.enabled : value.enabled,
    qualityPreset:
      value.qualityPreset === undefined
        ? DEFAULT_VEGETATION_STREAMING_OPTIONS.qualityPreset
        : value.qualityPreset,
    memoryBudgetMB:
      value.memoryBudgetMB === undefined
        ? DEFAULT_VEGETATION_STREAMING_OPTIONS.memoryBudgetMB
        : value.memoryBudgetMB,
    targetFps:
      value.targetFps === undefined
        ? DEFAULT_VEGETATION_STREAMING_OPTIONS.targetFps
        : value.targetFps,
    maximumDisplayDistanceM:
      value.maximumDisplayDistanceM === undefined
        ? DEFAULT_VEGETATION_STREAMING_OPTIONS.maximumDisplayDistanceM
        : value.maximumDisplayDistanceM,
    distanceHysteresisM:
      value.distanceHysteresisM === undefined
        ? DEFAULT_VEGETATION_STREAMING_OPTIONS.distanceHysteresisM
        : value.distanceHysteresisM,
  }
}

/** 仅补齐安全的编辑默认值；显式 null、数组和类实例必须继续由校验拒绝。 */
function normalizeEditingOptions(value: unknown): unknown {
  if (value === undefined) return { ...DEFAULT_VEGETATION_EDITING_OPTIONS }
  if (!isPlainRecord(value)) return value

  return {
    ...value,
    enabled:
      value.enabled === undefined ? DEFAULT_VEGETATION_EDITING_OPTIONS.enabled : value.enabled,
    previewEnabled:
      value.previewEnabled === undefined
        ? DEFAULT_VEGETATION_EDITING_OPTIONS.previewEnabled
        : value.previewEnabled,
    maxDeltaAreaM2:
      value.maxDeltaAreaM2 === undefined
        ? DEFAULT_VEGETATION_EDITING_OPTIONS.maxDeltaAreaM2
        : value.maxDeltaAreaM2,
    snapToTerrain:
      value.snapToTerrain === undefined
        ? DEFAULT_VEGETATION_EDITING_OPTIONS.snapToTerrain
        : value.snapToTerrain,
  }
}

/** 为早期植被图层补齐不会改变资产或规则语义的展示字段。 */
function normalizeLayer(value: unknown): unknown {
  if (!isPlainRecord(value)) return value
  return {
    ...value,
    visible: value.visible === undefined ? true : value.visible,
    locked: value.locked === undefined ? false : value.locked,
    speciesIds: value.speciesIds === undefined ? [] : value.speciesIds,
    priority: value.priority === undefined ? 0 : value.priority,
  }
}

/** 只补齐资源档案的安全开关和一至三倍默认比例，不猜测资源地址或授权状态。 */
function normalizeSpecies(value: unknown): unknown {
  if (!isPlainRecord(value)) return value
  return {
    ...value,
    enabled: value.enabled === undefined ? false : value.enabled,
    minimumScale:
      value.minimumScale === undefined
        ? VEGETATION_SPECIES_DEFAULT_SCALE_RANGE.minimum
        : value.minimumScale,
    maximumScale:
      value.maximumScale === undefined
        ? VEGETATION_SPECIES_DEFAULT_SCALE_RANGE.maximum
        : value.maximumScale,
  }
}

/**
 * 把第二版单带规则一对一迁移为第三版父规则。
 *
 * 不按几何自动合并旧规则，因为相同区域仍可能拥有不同优先级、启用状态或覆盖关系；一对一迁移
 * 可以完整保留原规则身份与命令引用，同时消除第三版中重复保存的带级根字段。
 */
function migrateAltitudeBandRule(value: PlainRecord): PlainRecord {
  const ruleId = isNonEmptyString(value.id) ? value.id : ''
  return {
    id: value.id,
    name: value.name,
    kind: 'altitude-zonation',
    enabled: value.enabled,
    layerId: value.layerId,
    priority: value.priority,
    seedOffset: value.seedOffset,
    scope: 'polygon',
    polygon: value.polygon,
    gapPolicy: 'reject',
    zones: [
      {
        id: ruleId ? `${ruleId}:zone-1` : '',
        name: '分带 1',
        enabled: true,
        minimumAltitudeM: value.minimumAltitudeM,
        maximumAltitudeM: value.maximumAltitudeM,
        minimumSlopeDegrees: value.minimumSlopeDegrees,
        maximumSlopeDegrees: value.maximumSlopeDegrees,
        densityPerHectare: value.densityPerHectare,
        minimumSpacingM: value.minimumSpacingM,
        upperTransitionWidthM: 0,
        speciesMix: value.speciesMix,
      },
    ],
  }
}

/** 为旧规则补齐安全通用字段，并按来源版本决定是否迁移第二版单海拔带。 */
function normalizePlantingRule(value: unknown, migrateLegacyAltitudeBand: boolean): unknown {
  if (!isPlainRecord(value)) return value
  const normalized = {
    ...value,
    enabled: value.enabled === undefined ? false : value.enabled,
    priority: value.priority === undefined ? 0 : value.priority,
    seedOffset: value.seedOffset === undefined ? 0 : value.seedOffset,
  }
  if (value.kind === 'altitude-band') {
    const normalizedAltitudeBand = {
      ...normalized,
      minimumSlopeDegrees: value.minimumSlopeDegrees === undefined ? 0 : value.minimumSlopeDegrees,
      maximumSlopeDegrees: value.maximumSlopeDegrees === undefined ? 90 : value.maximumSlopeDegrees,
    }
    return migrateLegacyAltitudeBand
      ? migrateAltitudeBandRule(normalizedAltitudeBand)
      : normalizedAltitudeBand
  }
  if (value.kind === 'corridor') {
    return {
      ...normalized,
      startOffsetM: value.startOffsetM === undefined ? 0 : value.startOffsetM,
      endOffsetM: value.endOffsetM === undefined ? 0 : value.endOffsetM,
      alignToPath: value.alignToPath === undefined ? true : value.alignToPath,
    }
  }
  if (value.kind === 'altitude-zonation') {
    return {
      ...normalized,
      /** 第三版规则没有作用域字段；存在区域时保持原有局部规则语义，绝不擅自扩大为全局种植。 */
      scope: value.scope === undefined && value.polygon !== undefined ? 'polygon' : value.scope,
    }
  }
  if (value.kind === 'polygon') {
    return {
      ...normalized,
      distribution: value.distribution === undefined ? 'poisson' : value.distribution,
    }
  }
  return normalized
}

/**
 * 归一化来自场景存档的植被定义。
 *
 * 该函数只补齐字段缺失，不修正显式非法值；顶层非普通对象、错误数组和 null 均原样返回，确保下一步
 * 校验能够暴露数据损坏。植被对象缺少 enabled 时默认关闭，避免旧试验数据在打开场景后意外发起请求。
 */
export function normalizeVegetationSystemDefinition(definition: unknown): unknown {
  if (!isPlainRecord(definition)) return definition

  const draft = definition as VegetationSystemDraft
  /** 缺失版本按第一版解释；只迁移已知旧版本，未来版本保持原样并交由版本校验拒绝。 */
  const migrateLegacyAltitudeBand =
    draft.schemaVersion === undefined || draft.schemaVersion === 1 || draft.schemaVersion === 2
  const layers =
    draft.layers === undefined
      ? []
      : Array.isArray(draft.layers)
        ? draft.layers.map(normalizeLayer)
        : draft.layers
  const speciesCatalog =
    draft.speciesCatalog === undefined
      ? []
      : Array.isArray(draft.speciesCatalog)
        ? draft.speciesCatalog.map(normalizeSpecies)
        : draft.speciesCatalog
  const rules =
    draft.rules === undefined
      ? []
      : Array.isArray(draft.rules)
        ? draft.rules.map((rule) => normalizePlantingRule(rule, migrateLegacyAltitudeBand))
        : draft.rules

  return {
    ...draft,
    schemaVersion: migrateLegacyAltitudeBand
      ? CURRENT_VEGETATION_SCHEMA_VERSION
      : draft.schemaVersion,
    enabled: draft.enabled === undefined ? false : draft.enabled,
    layers,
    speciesCatalog,
    rules,
    elevationSource:
      draft.elevationSource === undefined
        ? { ...DEFAULT_VEGETATION_ELEVATION_SOURCE }
        : draft.elevationSource,
    streaming: normalizeStreamingOptions(draft.streaming),
    editing: normalizeEditingOptions(draft.editing),
  }
}

/** 创建具有稳定默认预算的植被系统定义；调用方仍可用校验函数检查外部输入。 */
export function createVegetationSystemDefinition(
  input: CreateVegetationSystemDefinitionInput,
): VegetationSystemDefinition {
  const draft: Record<string, unknown> = {
    schemaVersion: CURRENT_VEGETATION_SCHEMA_VERSION,
    enabled: input.enabled ?? true,
    seed: input.seed,
    ruleSetId: input.ruleSetId,
    ruleSetVersion: input.ruleSetVersion,
    layers: input.layers ?? [],
    speciesCatalog: input.speciesCatalog ?? [],
    rules: input.rules ?? [],
    elevationSource: input.elevationSource,
    streaming: input.streaming,
    editing: input.editing,
  }
  // 可选发布引用缺失时不写入 undefined，保证创建结果可以直接通过纯 JSON 序列化门禁。
  if (input.publication !== undefined) draft.publication = input.publication
  return normalizeVegetationSystemDefinition(draft) as VegetationSystemDefinition
}

/**
 * 从系统种子、规则编号和规则偏移派生稳定的 32 位种子。
 *
 * 生成器应把返回值与区块编号继续组合后初始化自己的随机序列；该函数不保存状态、不会读取当前时间，
 * 因而同一份场景快照可以在服务端、构建脚本和测试中得到一致的物种选择与采样顺序。
 */
export function deriveVegetationRuleSeed(
  systemSeed: number,
  ruleId: string,
  seedOffset: number,
): number {
  const input = `${systemSeed}\u0000${ruleId}\u0000${seedOffset}`
  let hash = 2_166_136_261
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }
  return hash >>> 0
}

/** 校验植被使用的资产引用，并按场景类型约束 Cesium 首期发布清单。 */
function validateAssetRef(
  value: unknown,
  prefix: string,
  issues: string[],
  options: { requireCesiumTiles: boolean; requireAssetUrls?: boolean },
): void {
  if (!isPlainRecord(value)) {
    issues.push(`${prefix} must be a plain object.`)
    return
  }

  const asset = value as Partial<AssetRef>
  if (!isNonEmptyString(asset.id)) issues.push(`${prefix} id is required.`)
  if (!SUPPORTED_ASSET_KINDS.has(asset.kind as AssetKind)) {
    issues.push(`${prefix} kind must be a supported asset kind.`)
  } else if (options.requireCesiumTiles && asset.kind !== '3d-tiles') {
    issues.push(`${prefix} kind must be 3d-tiles for a GIS vegetation manifest.`)
  }
  // 持久化会剥离临时地址，只能省略该字段；非法地址值、编号和资源类型仍必须拦截。
  if (!isNonEmptyString(asset.url) && (options.requireAssetUrls !== false || asset.url !== undefined)) {
    issues.push(`${prefix} url is required.`)
  }
  if (asset.version !== undefined && !isNonEmptyString(asset.version)) {
    issues.push(`${prefix} version must be a non-empty string when provided.`)
  }
  if (asset.hash !== undefined && !isNonEmptyString(asset.hash)) {
    issues.push(`${prefix} hash must be a non-empty string when provided.`)
  }
  if (asset.metadata !== undefined && !isPlainRecord(asset.metadata)) {
    issues.push(`${prefix} metadata must be a plain object when provided.`)
  }
}

/** 校验资源市场模型及其距离细节层级；生态海拔规则不在这里表达。 */
function validateVegetationModelAsset(
  value: unknown, prefix: string, issues: string[], requireAssetUrls: boolean,
): void {
  validateAssetRef(value, `${prefix} modelAsset`, issues, { requireCesiumTiles: false, requireAssetUrls })
  if (!isPlainRecord(value)) return

  const asset = value as Partial<AssetRef>
  if (asset.kind !== 'glb' && asset.kind !== 'gltf') {
    issues.push(`${prefix} modelAsset kind must be glb or gltf.`)
  }

  if (asset.modelLodVariants === undefined) return
  if (!Array.isArray(asset.modelLodVariants) || asset.modelLodVariants.length === 0) {
    issues.push(`${prefix} modelAsset modelLodVariants must be a non-empty array when provided.`)
    return
  }

  const seenIds = new Set<string>()
  let previousMinimumDistance = 0
  asset.modelLodVariants.forEach((variant, index) => {
    const variantPrefix = `${prefix} modelAsset modelLodVariants[${index}]`
    if (!isPlainRecord(variant)) {
      issues.push(`${variantPrefix} must be a plain object.`)
      return
    }
    const draft = variant as Record<string, unknown>
    if (!isNonEmptyString(draft.id)) {
      issues.push(`${variantPrefix} id is required.`)
    } else if (draft.id === asset.id || seenIds.has(draft.id)) {
      issues.push(`${variantPrefix} id must be unique within modelAsset modelLodVariants.`)
    } else {
      seenIds.add(draft.id)
    }
    if (draft.kind !== 'glb' && draft.kind !== 'gltf') {
      issues.push(`${variantPrefix} kind must be glb or gltf.`)
    }
    if (!isNonEmptyString(draft.url) && (requireAssetUrls || draft.url !== undefined)) {
      issues.push(`${variantPrefix} url is required.`)
    }
    if (
      !isPositiveFiniteNumber(draft.minimumDistance) ||
      draft.minimumDistance <= previousMinimumDistance
    ) {
      issues.push(`${variantPrefix} minimumDistance must be strictly ascending positive.`)
    } else {
      previousMinimumDistance = draft.minimumDistance
    }
    if (
      draft.maximumScreenSpaceRatio !== undefined &&
      (!isFiniteNumber(draft.maximumScreenSpaceRatio) ||
        draft.maximumScreenSpaceRatio <= 0 ||
        draft.maximumScreenSpaceRatio > 1)
    ) {
      issues.push(`${variantPrefix} maximumScreenSpaceRatio must be within (0, 1].`)
    }
  })
}

/** 校验资源市场物种目录并返回稳定编号集合，供规则引用检查复用。 */
function validateSpeciesCatalog(value: unknown, issues: string[], requireAssetUrls: boolean): Set<string> {
  const speciesIds = new Set<string>()
  if (!Array.isArray(value)) {
    issues.push('Vegetation speciesCatalog must be an array.')
    return speciesIds
  }
  if (value.length > MAX_VEGETATION_SPECIES) {
    issues.push(`Vegetation speciesCatalog must contain at most ${MAX_VEGETATION_SPECIES} items.`)
  }

  const speciesCount = Math.min(value.length, MAX_VEGETATION_SPECIES)
  for (let index = 0; index < speciesCount; index += 1) {
    const entry = value[index]
    const prefix = `Vegetation speciesCatalog at index ${index}`
    if (!isPlainRecord(entry)) {
      issues.push(`${prefix} must be a plain object.`)
      continue
    }
    const species = entry as Partial<VegetationSpeciesDefinition>
    if (!isNonEmptyString(species.id)) {
      issues.push(`${prefix} id is required.`)
    } else if (speciesIds.has(species.id)) {
      issues.push(`${prefix} id must be unique.`)
    } else {
      speciesIds.add(species.id)
    }
    if (!isNonEmptyString(species.name)) issues.push(`${prefix} name is required.`)
    if (typeof species.enabled !== 'boolean') issues.push(`${prefix} enabled must be boolean.`)
    validateVegetationModelAsset(species.modelAsset, prefix, issues, requireAssetUrls)
    if (
      !isPositiveFiniteNumber(species.minimumScale) ||
      species.minimumScale < VEGETATION_SPECIES_SCALE_RANGE.minimum ||
      species.minimumScale > VEGETATION_SPECIES_SCALE_RANGE.maximum
    ) {
      issues.push(
        `${prefix} minimumScale must be within ` +
          `[${VEGETATION_SPECIES_SCALE_RANGE.minimum}, ${VEGETATION_SPECIES_SCALE_RANGE.maximum}].`,
      )
    }
    if (
      !isPositiveFiniteNumber(species.maximumScale) ||
      species.maximumScale < VEGETATION_SPECIES_SCALE_RANGE.minimum ||
      species.maximumScale > VEGETATION_SPECIES_SCALE_RANGE.maximum
    ) {
      issues.push(
        `${prefix} maximumScale must be within ` +
          `[${VEGETATION_SPECIES_SCALE_RANGE.minimum}, ${VEGETATION_SPECIES_SCALE_RANGE.maximum}].`,
      )
    }
    if (
      isPositiveFiniteNumber(species.minimumScale) &&
      isPositiveFiniteNumber(species.maximumScale) &&
      species.minimumScale > species.maximumScale
    ) {
      issues.push(`${prefix} minimumScale must be less than or equal to maximumScale.`)
    }
    if (
      species.canopyRadiusM !== undefined &&
      (!isPositiveFiniteNumber(species.canopyRadiusM) || species.canopyRadiusM > MAX_SPACING_M)
    ) {
      issues.push(`${prefix} canopyRadiusM must be within (0, ${MAX_SPACING_M}].`)
    }
    if (species.metadata !== undefined && !isPlainRecord(species.metadata)) {
      issues.push(`${prefix} metadata must be a plain object when provided.`)
    }
  }
  return speciesIds
}

/** 校验地形来源，明确禁止把影像地址误当作高程来源。 */
function validateElevationSource(
  value: unknown,
  issues: string[],
): VegetationElevationSourceDefinition['kind'] {
  const prefix = 'Vegetation elevationSource'
  if (!isPlainRecord(value)) {
    issues.push(`${prefix} must be a plain object.`)
    return 'none'
  }
  const source = value as Record<string, unknown>
  if (
    source.kind !== 'none' &&
    source.kind !== 'scene-terrain' &&
    source.kind !== 'external-dem' &&
    source.kind !== 'constant'
  ) {
    issues.push(`${prefix} kind must be none, scene-terrain, external-dem or constant.`)
    return 'none'
  }
  if (!SUPPORTED_VERTICAL_DATUMS.has(source.verticalDatum as VegetationVerticalDatum)) {
    issues.push(`${prefix} verticalDatum must be ellipsoid, orthometric or unknown.`)
  }
  if (!isFiniteNumber(source.heightOffsetM)) {
    issues.push(`${prefix} heightOffsetM must be a finite number.`)
  }
  if (source.kind === 'none') {
    if (source.verticalDatum !== 'unknown') {
      issues.push(`${prefix} none kind requires unknown verticalDatum.`)
    }
  } else if (source.kind === 'scene-terrain') {
    if (source.layerId !== undefined && !isNonEmptyString(source.layerId)) {
      issues.push(`${prefix} layerId must be a non-empty string when provided.`)
    }
  } else if (source.kind === 'external-dem') {
    if (!isNonEmptyString(source.sourceId)) {
      issues.push(`${prefix} external-dem sourceId is required.`)
    }
    if (source.verticalDatum === 'unknown') {
      issues.push(`${prefix} external-dem requires a known verticalDatum.`)
    }
  } else {
    if (!isFiniteNumber(source.heightM)) {
      issues.push(`${prefix} constant heightM must be a finite number.`)
    }
  }
  return source.kind as VegetationElevationSourceDefinition['kind']
}

/**
 * 校验地理编辑坐标范围。
 *
 * 第三项为可选编辑高程，只服务山区控制点恢复；面积、距离和正式高程仍由生成器投影及高程数据源
 * 计算。允许二元旧坐标可保证已有场景无需迁移，拒绝四元及非有限高程可防止错误数据进入存档。
 */
function validateGeoPosition(value: unknown, prefix: string, issues: string[]): void {
  if (
    !Array.isArray(value) ||
    (value.length !== 2 && value.length !== 3) ||
    !isFiniteNumber(value[0]) ||
    !isFiniteNumber(value[1]) ||
    (value.length === 3 && !isFiniteNumber(value[2]))
  ) {
    issues.push(
      `${prefix} must be a [longitude, latitude] or ` +
        `[longitude, latitude, authoringHeightM] finite coordinate.`,
    )
    return
  }
  if (value[0] < -180 || value[0] > 180)
    issues.push(`${prefix} longitude must be within [-180, 180].`)
  if (value[1] < -90 || value[1] > 90) issues.push(`${prefix} latitude must be within [-90, 90].`)
}

/** 校验闭合多边形和孔洞结构，防止无界几何进入前端预览或发布任务。 */
function validateGeoPolygon(value: unknown, prefix: string, issues: string[]): void {
  if (!isPlainRecord(value) || !Array.isArray(value.rings) || value.rings.length === 0) {
    issues.push(`${prefix} must contain a rings array.`)
    return
  }
  let coordinateCount = 0
  value.rings.forEach((ring, ringIndex) => {
    const ringPrefix = `${prefix} rings[${ringIndex}]`
    if (!Array.isArray(ring) || ring.length < 4) {
      issues.push(`${ringPrefix} must contain at least four coordinates.`)
      return
    }
    coordinateCount += ring.length
    if (coordinateCount <= MAX_RULE_COORDINATES) {
      ring.forEach((position, positionIndex) => {
        validateGeoPosition(position, `${ringPrefix}[${positionIndex}]`, issues)
      })
    }
    const first = ring[0]
    const last = ring[ring.length - 1]
    if (
      !Array.isArray(first) ||
      !Array.isArray(last) ||
      first[0] !== last[0] ||
      first[1] !== last[1]
    ) {
      issues.push(`${ringPrefix} must be closed.`)
    }
  })
  if (coordinateCount > MAX_RULE_COORDINATES) {
    issues.push(`${prefix} must contain at most ${MAX_RULE_COORDINATES} coordinates.`)
  }
}

/** 校验规则物种权重和图层目录引用。 */
function validateSpeciesMix(
  value: unknown,
  prefix: string,
  speciesIds: Set<string>,
  layerSpeciesIds: Set<string> | undefined,
  issues: string[],
): void {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push(`${prefix} speciesMix must be a non-empty array.`)
    return
  }
  const seenIds = new Set<string>()
  const mixCount = Math.min(value.length, MAX_VEGETATION_SPECIES)
  for (let index = 0; index < mixCount; index += 1) {
    const entry = value[index]
    const entryPrefix = `${prefix} speciesMix[${index}]`
    if (!isPlainRecord(entry)) {
      issues.push(`${entryPrefix} must be a plain object.`)
      continue
    }
    const mix = entry as Record<string, unknown>
    if (!isNonEmptyString(mix.speciesId)) {
      issues.push(`${entryPrefix} speciesId is required.`)
    } else {
      if (seenIds.has(mix.speciesId)) issues.push(`${entryPrefix} speciesId must be unique.`)
      seenIds.add(mix.speciesId)
      if (!speciesIds.has(mix.speciesId)) {
        issues.push(`${entryPrefix} speciesId must reference speciesCatalog.`)
      }
      if (layerSpeciesIds && !layerSpeciesIds.has(mix.speciesId)) {
        issues.push(`${entryPrefix} speciesId must be declared by its layer.`)
      }
    }
    if (!isPositiveFiniteNumber(mix.weight)) {
      issues.push(`${entryPrefix} weight must be a positive finite number.`)
    }
  }
}

/**
 * 校验一个父规则内的全部海拔分带。
 *
 * 分带必须按最低海拔升序保存，因此只需和前一带比较即可在线性时间内发现排序、重叠和空隙；
 * 过渡宽度也只依赖当前带与下一带，不需要构造任意两带组合。
 */
function validateAltitudeZones(
  value: unknown,
  prefix: string,
  gapPolicy: unknown,
  speciesIds: Set<string>,
  layerSpeciesIds: Set<string> | undefined,
  issues: string[],
): void {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push(`${prefix} zones must be a non-empty array.`)
    return
  }
  if (value.length > MAX_ALTITUDE_ZONES_PER_RULE) {
    issues.push(`${prefix} zones must contain at most ${MAX_ALTITUDE_ZONES_PER_RULE} items.`)
  }

  const zoneIds = new Set<string>()
  const zoneCount = Math.min(value.length, MAX_ALTITUDE_ZONES_PER_RULE)
  let previousZone: PlainRecord | undefined
  let previousPrefix = ''

  for (let index = 0; index < zoneCount; index += 1) {
    const entry = value[index]
    const zonePrefix = `${prefix} zones[${index}]`
    if (!isPlainRecord(entry)) {
      issues.push(`${zonePrefix} must be a plain object.`)
      previousZone = undefined
      previousPrefix = ''
      continue
    }
    const zone = entry as PlainRecord

    if (!isNonEmptyString(zone.id)) {
      issues.push(`${zonePrefix} id is required.`)
    } else if (zoneIds.has(zone.id)) {
      issues.push(`${zonePrefix} id must be unique within its rule.`)
    } else {
      zoneIds.add(zone.id)
    }
    if (!isNonEmptyString(zone.name)) issues.push(`${zonePrefix} name is required.`)
    if (typeof zone.enabled !== 'boolean') issues.push(`${zonePrefix} enabled must be boolean.`)

    const hasFiniteAltitudeRange =
      isFiniteNumber(zone.minimumAltitudeM) && isFiniteNumber(zone.maximumAltitudeM)
    if (!hasFiniteAltitudeRange) {
      issues.push(`${zonePrefix} altitude range must be finite.`)
    } else if ((zone.minimumAltitudeM as number) >= (zone.maximumAltitudeM as number)) {
      issues.push(`${zonePrefix} minimumAltitudeM must be less than maximumAltitudeM.`)
    }

    if (
      !isFiniteNumber(zone.minimumSlopeDegrees) ||
      zone.minimumSlopeDegrees < 0 ||
      zone.minimumSlopeDegrees > 90
    ) {
      issues.push(`${zonePrefix} minimumSlopeDegrees must be within [0, 90].`)
    }
    if (
      !isFiniteNumber(zone.maximumSlopeDegrees) ||
      zone.maximumSlopeDegrees < 0 ||
      zone.maximumSlopeDegrees > 90
    ) {
      issues.push(`${zonePrefix} maximumSlopeDegrees must be within [0, 90].`)
    }
    if (
      isFiniteNumber(zone.minimumSlopeDegrees) &&
      isFiniteNumber(zone.maximumSlopeDegrees) &&
      zone.minimumSlopeDegrees > zone.maximumSlopeDegrees
    ) {
      issues.push(
        `${zonePrefix} minimumSlopeDegrees must be less than or equal to maximumSlopeDegrees.`,
      )
    }
    if (
      !isPositiveFiniteNumber(zone.densityPerHectare) ||
      zone.densityPerHectare > MAX_DENSITY_PER_HECTARE
    ) {
      issues.push(`${zonePrefix} densityPerHectare must be within (0, ${MAX_DENSITY_PER_HECTARE}].`)
    }
    if (!isPositiveFiniteNumber(zone.minimumSpacingM) || zone.minimumSpacingM > MAX_SPACING_M) {
      issues.push(`${zonePrefix} minimumSpacingM must be within (0, ${MAX_SPACING_M}].`)
    }
    if (!isFiniteNumber(zone.upperTransitionWidthM) || zone.upperTransitionWidthM < 0) {
      issues.push(`${zonePrefix} upperTransitionWidthM must be a non-negative finite number.`)
    }
    validateSpeciesMix(zone.speciesMix, zonePrefix, speciesIds, layerSpeciesIds, issues)

    if (previousZone) {
      const previousMinimum = previousZone.minimumAltitudeM
      const previousMaximum = previousZone.maximumAltitudeM
      const currentMinimum = zone.minimumAltitudeM
      const currentMaximum = zone.maximumAltitudeM

      if (
        isFiniteNumber(previousMinimum) &&
        isFiniteNumber(currentMinimum) &&
        currentMinimum <= previousMinimum
      ) {
        issues.push(
          `${zonePrefix} minimumAltitudeM must be strictly greater than the previous zone minimumAltitudeM.`,
        )
      }
      if (isFiniteNumber(previousMaximum) && isFiniteNumber(currentMinimum)) {
        if (currentMinimum < previousMaximum) {
          issues.push(`${zonePrefix} altitude range must not overlap the previous zone.`)
        } else if (currentMinimum > previousMaximum && gapPolicy === 'reject') {
          issues.push(`${zonePrefix} altitude gap requires gapPolicy leave-empty.`)
        }

        const transitionWidth = previousZone.upperTransitionWidthM
        if (isFiniteNumber(transitionWidth) && transitionWidth > 0) {
          if (currentMinimum !== previousMaximum) {
            issues.push(
              `${previousPrefix} upperTransitionWidthM requires a shared boundary with the next zone.`,
            )
          } else if (
            isFiniteNumber(previousMinimum) &&
            isFiniteNumber(currentMaximum) &&
            previousMinimum < previousMaximum &&
            currentMinimum < currentMaximum
          ) {
            const maximumTransitionWidth =
              Math.min(previousMaximum - previousMinimum, currentMaximum - currentMinimum) / 2
            if (transitionWidth > maximumTransitionWidth) {
              issues.push(
                `${previousPrefix} upperTransitionWidthM must not exceed ${maximumTransitionWidth}.`,
              )
            }
          }
        }
      }
    }

    previousZone = zone
    previousPrefix = zonePrefix
  }

  const lastZone = value[value.length - 1]
  if (value.length <= MAX_ALTITUDE_ZONES_PER_RULE && isPlainRecord(lastZone)) {
    if (lastZone.upperTransitionWidthM !== 0) {
      issues.push(`${prefix} zones[${value.length - 1}] upperTransitionWidthM must be 0.`)
    }
  }
}

/** 校验三类首期种植规则，并阻止启用的多海拔分带脱离真实高程来源。 */
function validatePlantingRules(
  value: unknown,
  layerIds: Set<string>,
  layerSpeciesById: Map<string, Set<string>>,
  speciesIds: Set<string>,
  elevationKind: VegetationElevationSourceDefinition['kind'],
  issues: string[],
): void {
  if (!Array.isArray(value)) {
    issues.push('Vegetation rules must be an array.')
    return
  }
  if (value.length > MAX_VEGETATION_RULES) {
    issues.push(`Vegetation rules must contain at most ${MAX_VEGETATION_RULES} items.`)
  }

  const ruleIds = new Set<string>()
  const ruleCount = Math.min(value.length, MAX_VEGETATION_RULES)
  for (let index = 0; index < ruleCount; index += 1) {
    const entry = value[index]
    const prefix = `Vegetation rule at index ${index}`
    if (!isPlainRecord(entry)) {
      issues.push(`${prefix} must be a plain object.`)
      continue
    }
    const rule = entry as Record<string, unknown>
    if (!isNonEmptyString(rule.id)) {
      issues.push(`${prefix} id is required.`)
    } else if (ruleIds.has(rule.id)) {
      issues.push(`${prefix} id must be unique.`)
    } else {
      ruleIds.add(rule.id)
    }
    if (!isNonEmptyString(rule.name)) issues.push(`${prefix} name is required.`)
    if (rule.kind === 'polygon' && rule.imageryRegion !== undefined) {
      const region = rule.imageryRegion
      if (!isPlainRecord(region) || !isNonEmptyString(region.id) || !isNonEmptyString(region.name)) {
        issues.push(`${prefix} imageryRegion must have an id and name.`)
      } else if (region.corners !== undefined) {
        if (!Array.isArray(region.corners) || region.corners.length !== 2) {
          issues.push(`${prefix} imageryRegion must have two corners.`)
        } else {
          for (const corner of region.corners) validateGeoPosition(corner, `${prefix} imageryRegion corner`, issues)
        }
      }
    }
    if (typeof rule.enabled !== 'boolean') issues.push(`${prefix} enabled must be boolean.`)
    if (!isNonEmptyString(rule.layerId)) {
      issues.push(`${prefix} layerId is required.`)
    } else if (!layerIds.has(rule.layerId)) {
      issues.push(`${prefix} layerId must reference a vegetation layer.`)
    }
    if (!Number.isSafeInteger(rule.priority) || (rule.priority as number) < 0) {
      issues.push(`${prefix} priority must be a non-negative safe integer.`)
    }
    if (!Number.isSafeInteger(rule.seedOffset)) {
      issues.push(`${prefix} seedOffset must be a safe integer.`)
    }

    const layerSpeciesIds =
      typeof rule.layerId === 'string' ? layerSpeciesById.get(rule.layerId) : undefined
    if (rule.kind === 'altitude-zonation') {
      const scope = rule.scope ?? (rule.polygon === undefined ? undefined : 'polygon')
      if (scope === 'camera-view') {
        if (rule.polygon !== undefined) {
          issues.push(`${prefix} camera-view scope must not persist a polygon.`)
        }
      } else if (scope === 'polygon') {
        validateGeoPolygon(rule.polygon, `${prefix} polygon`, issues)
      } else {
        issues.push(`${prefix} scope must be camera-view or polygon.`)
      }
      if (rule.gapPolicy !== 'reject' && rule.gapPolicy !== 'leave-empty') {
        issues.push(`${prefix} gapPolicy must be reject or leave-empty.`)
      }
      validateAltitudeZones(rule.zones, prefix, rule.gapPolicy, speciesIds, layerSpeciesIds, issues)
      if (
        rule.enabled === true &&
        elevationKind !== 'scene-terrain' &&
        elevationKind !== 'external-dem'
      ) {
        issues.push(
          `${prefix} enabled altitude-zonation requires scene-terrain or external-dem elevationSource.`,
        )
      }
      continue
    }

    if (rule.kind === 'corridor') {
      validateSpeciesMix(rule.speciesMix, prefix, speciesIds, layerSpeciesIds, issues)
      if (!Array.isArray(rule.path) || rule.path.length < 2) {
        issues.push(`${prefix} path must contain at least two coordinates.`)
      } else {
        rule.path.forEach((position, positionIndex) => {
          validateGeoPosition(position, `${prefix} path[${positionIndex}]`, issues)
        })
      }
      if (rule.side !== 'left' && rule.side !== 'right' && rule.side !== 'both') {
        issues.push(`${prefix} side must be left, right or both.`)
      }
      if (!isFiniteNumber(rule.offsetM) || rule.offsetM < 0 || rule.offsetM > MAX_SPACING_M) {
        issues.push(`${prefix} offsetM must be within [0, ${MAX_SPACING_M}].`)
      }
      if (!isPositiveFiniteNumber(rule.spacingM) || rule.spacingM > MAX_SPACING_M) {
        issues.push(`${prefix} spacingM must be within (0, ${MAX_SPACING_M}].`)
      }
      if (
        !isFiniteNumber(rule.startOffsetM) ||
        rule.startOffsetM < 0 ||
        rule.startOffsetM > MAX_SPACING_M * 1_000
      ) {
        issues.push(`${prefix} startOffsetM must be within [0, ${MAX_SPACING_M * 1_000}].`)
      }
      if (
        !isFiniteNumber(rule.endOffsetM) ||
        rule.endOffsetM < 0 ||
        rule.endOffsetM > MAX_SPACING_M * 1_000
      ) {
        issues.push(`${prefix} endOffsetM must be within [0, ${MAX_SPACING_M * 1_000}].`)
      }
      if (typeof rule.alignToPath !== 'boolean') {
        issues.push(`${prefix} alignToPath must be boolean.`)
      }
      continue
    }

    if (rule.kind === 'polygon') {
      if (rule.targetCount !== undefined && (!Number.isSafeInteger(rule.targetCount) || (rule.targetCount as number) < 1 || (rule.targetCount as number) > 10_000_000)) {
        issues.push(`${prefix} targetCount must be an integer within [1, 10000000].`)
      }
      validateSpeciesMix(rule.speciesMix, prefix, speciesIds, layerSpeciesIds, issues)
      validateGeoPolygon(rule.polygon, `${prefix} polygon`, issues)
      if (
        rule.distribution !== 'poisson' &&
        rule.distribution !== 'grid' &&
        rule.distribution !== 'random'
      ) {
        issues.push(`${prefix} distribution must be poisson, grid or random.`)
      }
      if (
        !isPositiveFiniteNumber(rule.densityPerHectare) ||
        rule.densityPerHectare > MAX_DENSITY_PER_HECTARE
      ) {
        issues.push(`${prefix} densityPerHectare must be within (0, ${MAX_DENSITY_PER_HECTARE}].`)
      }
      if (!isPositiveFiniteNumber(rule.minimumSpacingM) || rule.minimumSpacingM > MAX_SPACING_M) {
        issues.push(`${prefix} minimumSpacingM must be within (0, ${MAX_SPACING_M}].`)
      }
      continue
    }

    issues.push(`${prefix} kind must be altitude-zonation, corridor or polygon.`)
  }
}

/** 校验 Three.js 后续流式参数的空间关系和离散预算，首期不会把它们应用到 Cesium。 */
function validateThreeStreamingOptions(value: unknown, issues: string[]): void {
  const prefix = 'Vegetation streaming three options'
  if (!isPlainRecord(value)) {
    issues.push(`${prefix} must be a plain object when provided.`)
    return
  }

  const options = value as Partial<VegetationThreeStreamingOptions>
  if (!isPositiveFiniteNumber(options.visibleRadius)) {
    issues.push(`${prefix} visibleRadius must be a positive finite number.`)
  }
  if (!isPositiveFiniteNumber(options.preloadRadius)) {
    issues.push(`${prefix} preloadRadius must be a positive finite number.`)
  }
  if (!isPositiveFiniteNumber(options.unloadRadius)) {
    issues.push(`${prefix} unloadRadius must be a positive finite number.`)
  }
  if (
    isFiniteNumber(options.visibleRadius) &&
    isFiniteNumber(options.preloadRadius) &&
    options.preloadRadius < options.visibleRadius
  ) {
    issues.push(`${prefix} preloadRadius must be greater than or equal to visibleRadius.`)
  }
  if (
    isFiniteNumber(options.preloadRadius) &&
    isFiniteNumber(options.unloadRadius) &&
    options.unloadRadius <= options.preloadRadius
  ) {
    issues.push(`${prefix} unloadRadius must be greater than preloadRadius.`)
  }
  if (
    !Number.isSafeInteger(options.unloadDelayMs) ||
    (options.unloadDelayMs as number) < 0 ||
    (options.unloadDelayMs as number) > MAX_THREE_UNLOAD_DELAY_MS
  ) {
    issues.push(
      `${prefix} unloadDelayMs must be a safe integer within [0, ${MAX_THREE_UNLOAD_DELAY_MS}].`,
    )
  }
  if (
    !Number.isSafeInteger(options.maxLoadingJobs) ||
    (options.maxLoadingJobs as number) < 1 ||
    (options.maxLoadingJobs as number) > MAX_THREE_LOADING_JOBS
  ) {
    issues.push(
      `${prefix} maxLoadingJobs must be a safe integer within [1, ${MAX_THREE_LOADING_JOBS}].`,
    )
  }
  if (
    !isFiniteNumber(options.lodHysteresis) ||
    options.lodHysteresis < 0 ||
    options.lodHysteresis > 1
  ) {
    issues.push(`${prefix} lodHysteresis must be within [0, 1].`)
  }
  if (
    !isFiniteNumber(options.densityScale) ||
    options.densityScale <= 0 ||
    options.densityScale > 1
  ) {
    issues.push(`${prefix} densityScale must be within (0, 1].`)
  }
}

/** 校验跨运行时质量档位；Cesium 专属参数不属于这个持久化对象。 */
function validateStreamingOptions(value: unknown, issues: string[]): void {
  const prefix = 'Vegetation streaming options'
  if (!isPlainRecord(value)) {
    issues.push(`${prefix} must be a plain object.`)
    return
  }

  const options = value as Partial<VegetationStreamingOptions>
  if (options.renderMode !== undefined && !['instanced', 'published-tiles'].includes(options.renderMode)) {
    issues.push(`${prefix} renderMode must be instanced or published-tiles.`)
  }
  if (typeof options.enabled !== 'boolean') issues.push(`${prefix} enabled must be boolean.`)
  if (!SUPPORTED_QUALITY_PRESETS.has(options.qualityPreset as VegetationQualityPreset)) {
    issues.push(`${prefix} qualityPreset must be high, balanced or performance.`)
  }
  if (
    !Number.isSafeInteger(options.memoryBudgetMB) ||
    (options.memoryBudgetMB as number) < 1 ||
    (options.memoryBudgetMB as number) > MAX_MEMORY_BUDGET_MB
  ) {
    issues.push(
      `${prefix} memoryBudgetMB must be a safe integer within [1, ${MAX_MEMORY_BUDGET_MB}].`,
    )
  }
  if (!isPositiveFiniteNumber(options.targetFps) || options.targetFps > MAX_TARGET_FPS) {
    issues.push(`${prefix} targetFps must be within (0, ${MAX_TARGET_FPS}].`)
  }
  if (
    !isPositiveFiniteNumber(options.maximumDisplayDistanceM) ||
    options.maximumDisplayDistanceM > MAX_DISPLAY_DISTANCE_M
  ) {
    issues.push(`${prefix} maximumDisplayDistanceM must be within (0, ${MAX_DISPLAY_DISTANCE_M}].`)
  }
  if (
    !isFiniteNumber(options.distanceHysteresisM) ||
    options.distanceHysteresisM < 0 ||
    options.distanceHysteresisM > MAX_DISPLAY_DISTANCE_M
  ) {
    issues.push(`${prefix} distanceHysteresisM must be within [0, ${MAX_DISPLAY_DISTANCE_M}].`)
  } else if (
    isPositiveFiniteNumber(options.maximumDisplayDistanceM) &&
    options.distanceHysteresisM >= options.maximumDisplayDistanceM
  ) {
    issues.push(`${prefix} distanceHysteresisM must be less than maximumDisplayDistanceM.`)
  }
  if (options.three !== undefined) validateThreeStreamingOptions(options.three, issues)
}

/** 校验编辑面积预算和地形贴合开关，防止无界增量进入浏览器临时预览。 */
function validateEditingOptions(value: unknown, issues: string[]): void {
  const prefix = 'Vegetation editing options'
  if (!isPlainRecord(value)) {
    issues.push(`${prefix} must be a plain object.`)
    return
  }

  const options = value as Partial<VegetationEditingOptions>
  if (typeof options.enabled !== 'boolean') issues.push(`${prefix} enabled must be boolean.`)
  if (typeof options.previewEnabled !== 'boolean') {
    issues.push(`${prefix} previewEnabled must be boolean.`)
  }
  if (
    !isPositiveFiniteNumber(options.maxDeltaAreaM2) ||
    options.maxDeltaAreaM2 > MAX_DELTA_AREA_M2
  ) {
    issues.push(`${prefix} maxDeltaAreaM2 must be within (0, ${MAX_DELTA_AREA_M2}].`)
  }
  if (typeof options.snapToTerrain !== 'boolean') {
    issues.push(`${prefix} snapToTerrain must be boolean.`)
  }
}

/** 校验已发布清单的不可变版本信息。 */
function validatePublication(
  value: unknown,
  sceneType: SceneType | undefined,
  issues: string[],
  requireAssetUrls: boolean,
): void {
  const prefix = 'Vegetation publication'
  if (!isPlainRecord(value)) {
    issues.push(`${prefix} must be a plain object when provided.`)
    return
  }

  const publication = value as Partial<VegetationPublicationRef>
  if (!isNonEmptyString(publication.version)) issues.push(`${prefix} version is required.`)
  if (publication.ruleVersion !== undefined && !isNonEmptyString(publication.ruleVersion)) {
    issues.push(`${prefix} ruleVersion must be a non-empty string when provided.`)
  }
  validateAssetRef(publication.manifestAsset, `${prefix} manifestAsset`, issues, {
    requireAssetUrls,
    // 旧场景没有tilesetAsset时，manifestAsset仍按旧版三维瓦片入口校验。
    requireCesiumTiles: sceneType === 'gis' && publication.tilesetAsset === undefined,
  })
  if (publication.tilesetAsset !== undefined) {
    validateAssetRef(publication.tilesetAsset, `${prefix} tilesetAsset`, issues, {
      requireAssetUrls,
      requireCesiumTiles: sceneType === 'gis',
    })
  }
  if (
    !isNonEmptyString(publication.generatedAt) ||
    !Number.isFinite(Date.parse(publication.generatedAt))
  ) {
    issues.push(`${prefix} generatedAt must be a valid date-time string.`)
  }
  if (!isNonEmptyString(publication.sourceHash)) issues.push(`${prefix} sourceHash is required.`)
  if (publication.densityProfiles !== undefined) {
    if (!isPlainRecord(publication.densityProfiles)) {
      issues.push(`${prefix} densityProfiles must be a plain object when provided.`)
    } else {
      for (const preset of ['high', 'balanced', 'performance'] as const) {
        const profile = publication.densityProfiles[preset]
        if (profile === undefined) continue
        if (!isPlainRecord(profile)) {
          issues.push(`${prefix} densityProfiles.${preset} must be a plain object.`)
          continue
        }
        const typedProfile = profile as Partial<VegetationPublicationDensityProfile>
        if (
          typeof typedProfile.densityRatio !== 'number' ||
          !Number.isFinite(typedProfile.densityRatio) ||
          typedProfile.densityRatio <= 0 ||
          typedProfile.densityRatio > 1
        ) {
          issues.push(`${prefix} densityProfiles.${preset}.densityRatio must be within (0, 1].`)
        }
        if (typedProfile.selection !== 'stable-subset') {
          issues.push(`${prefix} densityProfiles.${preset}.selection must be stable-subset.`)
        }
        if (
          typedProfile.tileSizeM !== undefined &&
          (typeof typedProfile.tileSizeM !== 'number' ||
            !Number.isFinite(typedProfile.tileSizeM) ||
            typedProfile.tileSizeM < 1 ||
            typedProfile.tileSizeM > 10_000)
        ) {
          issues.push(`${prefix} densityProfiles.${preset}.tileSizeM must be within [1, 10000].`)
        }
      }
    }
  }
}

/**
 * 校验植被系统领域定义。
 *
 * `sceneType` 仅用于约束 GIS 场景的清单必须指向 Cesium 三维瓦片；本地三维场景允许先保存统一
 * 协议，但当前版本不承诺对应 Three.js 运行时能力。
 * 文件导出可关闭地址必填检查，稳定引用、规则、版本和所有其他约束仍完整执行。
 */
export function validateVegetationSystemDefinition(
  definition: unknown,
  sceneType?: SceneType,
  options: VegetationValidationOptions = {},
): VegetationValidationResult {
  const issues: string[] = []
  if (!isPlainRecord(definition)) {
    return { issues: ['Vegetation system definition must be a plain object.'] }
  }
  if (!isSerializablePlainData(definition)) {
    issues.push('Vegetation system definition must contain only serializable plain data.')
  }

  const draft = definition as VegetationSystemDraft
  if (draft.schemaVersion !== CURRENT_VEGETATION_SCHEMA_VERSION) {
    issues.push(`Vegetation system schemaVersion must be ${CURRENT_VEGETATION_SCHEMA_VERSION}.`)
  }
  if (typeof draft.enabled !== 'boolean') {
    issues.push('Vegetation system enabled must be boolean.')
  }
  if (!Number.isSafeInteger(draft.seed)) {
    issues.push('Vegetation system seed must be a safe integer.')
  }
  if (!isNonEmptyString(draft.ruleSetId)) {
    issues.push('Vegetation system ruleSetId is required.')
  }
  if (!isNonEmptyString(draft.ruleSetVersion)) {
    issues.push('Vegetation system ruleSetVersion is required.')
  }

  const requireAssetUrls = options.requireAssetUrls !== false
  const speciesIds = validateSpeciesCatalog(draft.speciesCatalog, issues, requireAssetUrls)
  const elevationKind = validateElevationSource(draft.elevationSource, issues)
  const layerSpeciesById = new Map<string, Set<string>>()
  const layerIds = new Set<string>()

  if (!Array.isArray(draft.layers)) {
    issues.push('Vegetation system layers must be an array.')
  } else {
    draft.layers.forEach((value, index) => {
      const prefix = `Vegetation layer at index ${index}`
      if (!isPlainRecord(value)) {
        issues.push(`${prefix} must be a plain object.`)
        return
      }

      const layer = value as Partial<VegetationLayerDefinition>
      if (!isNonEmptyString(layer.id)) {
        issues.push(`${prefix} id is required.`)
      } else if (layerIds.has(layer.id)) {
        issues.push(`${prefix} id must be unique.`)
      } else {
        layerIds.add(layer.id)
      }
      if (!isNonEmptyString(layer.name)) issues.push(`${prefix} name is required.`)
      if (typeof layer.visible !== 'boolean') issues.push(`${prefix} visible must be boolean.`)
      if (typeof layer.locked !== 'boolean') issues.push(`${prefix} locked must be boolean.`)
      if (!SUPPORTED_LAYER_KINDS.has(layer.kind as VegetationLayerKind)) {
        issues.push(`${prefix} kind must be a supported vegetation layer kind.`)
      }

      /**
       * 未生成首份植被数据时允许保存草稿图层。只要清单已经存在，就继续执行完整资产与 GIS
       * 三维瓦片类型校验，防止用普通模型地址伪装已发布图层。
       */
      if (layer.manifestAsset !== undefined) {
        validateAssetRef(layer.manifestAsset, `${prefix} manifestAsset`, issues, {
          requireAssetUrls,
          // 兼容旧存档：新字段缺失时manifestAsset仍必须是Cesium三维瓦片入口。
          requireCesiumTiles: sceneType === 'gis' && layer.tilesetAsset === undefined,
        })
      }
      if (layer.tilesetAsset !== undefined) {
        validateAssetRef(layer.tilesetAsset, `${prefix} tilesetAsset`, issues, {
          requireAssetUrls,
          requireCesiumTiles: sceneType === 'gis',
        })
      }
      /**
       * 多档入口只保存三维瓦片资产，不允许把普通模型、清单或运行时对象混入。这里逐档校验的成本只
       * 与固定三档数量有关，不会随瓦片或实例数量增长；字段可缺失以兼容旧发布。
       */
      if (layer.densityTilesetAssets !== undefined) {
        if (!isPlainRecord(layer.densityTilesetAssets)) {
          issues.push(`${prefix} densityTilesetAssets must be a plain object when provided.`)
        } else {
          for (const preset of ['high', 'balanced', 'performance'] as const) {
            const asset = layer.densityTilesetAssets[preset]
            if (asset === undefined) {
              /** 半套入口无法保证档位切换的密度上限，必须整体拒绝并回退旧单入口协议。 */
              issues.push(`${prefix} densityTilesetAssets.${preset} is required when provided.`)
              continue
            }
            validateAssetRef(asset, `${prefix} densityTilesetAssets.${preset}`, issues, {
              requireAssetUrls,
              requireCesiumTiles: sceneType === 'gis',
            })
          }
        }
      }
      if (layer.deltaAsset !== undefined) {
        validateAssetRef(layer.deltaAsset, `${prefix} deltaAsset`, issues, {
          requireAssetUrls,
          requireCesiumTiles: false,
        })
      }

      if (!Array.isArray(layer.speciesIds) || layer.speciesIds.length === 0) {
        issues.push(`${prefix} speciesIds must be a non-empty array.`)
      } else {
        const layerSpeciesIds = new Set<string>()
        layer.speciesIds.forEach((speciesId, speciesIndex) => {
          if (!isNonEmptyString(speciesId)) {
            issues.push(`${prefix} speciesIds[${speciesIndex}] must be a non-empty string.`)
          } else if (layerSpeciesIds.has(speciesId)) {
            issues.push(`${prefix} speciesIds must not contain duplicate ids.`)
          } else {
            layerSpeciesIds.add(speciesId)
            if (!speciesIds.has(speciesId)) {
              issues.push(`${prefix} speciesIds[${speciesIndex}] must reference speciesCatalog.`)
            }
          }
        })
        if (typeof layer.id === 'string') layerSpeciesById.set(layer.id, layerSpeciesIds)
      }

      if (!Number.isSafeInteger(layer.priority) || (layer.priority as number) < 0) {
        issues.push(`${prefix} priority must be a non-negative safe integer.`)
      }
    })
  }

  validatePlantingRules(draft.rules, layerIds, layerSpeciesById, speciesIds, elevationKind, issues)
  if (draft.imageryExclusions !== undefined && (!Array.isArray(draft.imageryExclusions) ||
    !draft.imageryExclusions.every(box => Array.isArray(box) && box.length === 4 &&
      box.every(isFiniteNumber) && box[0] >= -180 && box[2] <= 180 &&
      box[1] >= -90 && box[3] <= 90 && box[0] < box[2] && box[1] < box[3] && box[2] - box[0] <= 180)))
    issues.push('影像禁种范围必须是有效的地理矩形。')

  /**
   * 未知垂直基准只影响结果可复现性，不应阻断浏览器编辑预览；一旦携带发布引用，就必须在发布前确认
   * 椭球高或正常高，避免把临时公共地形结果固化为不可追溯资产。
   */
  if (
    draft.publication !== undefined &&
    isPlainRecord(draft.elevationSource) &&
    draft.elevationSource.verticalDatum === 'unknown' &&
    Array.isArray(draft.rules) &&
    draft.rules.some(
      (rule) => isPlainRecord(rule) && rule.kind === 'altitude-zonation' && rule.enabled === true,
    )
  ) {
    issues.push(
      'Vegetation publication with enabled altitude-zonation requires a known verticalDatum.',
    )
  }

  validateStreamingOptions(draft.streaming, issues)
  validateEditingOptions(draft.editing, issues)
  if (isPlainRecord(draft.streaming) && draft.streaming.renderMode === 'instanced') {
    if (sceneType !== 'gis') issues.push('原生植被需要 GIS 场景。')
    if ((draft.streaming.memoryBudgetMB as number) < 16) issues.push('原生植被内存预算至少为 16 MB。')
    if (isPlainRecord(draft.elevationSource) && draft.elevationSource.kind === 'external-dem')
      issues.push('原生植被请使用场景地形或固定椭球高程。')
    if (isPlainRecord(draft.elevationSource) && draft.elevationSource.verticalDatum === 'orthometric')
      issues.push('原生植被高程采用椭球高，请转换正常高后导入。')
    if (Array.isArray(draft.speciesCatalog) && draft.speciesCatalog.length > 64)
      issues.push('原生植被最多支持 64 个物种。')
    if (Array.isArray(draft.rules)) for (const rule of draft.rules) {
      if (!isPlainRecord(rule)) continue
      const spacing = rule.kind === 'corridor' ? rule.spacingM : rule.minimumSpacingM
      if (typeof spacing === 'number' && spacing < 1) issues.push('原生植被的最小株距为 1 米。')
      const settings = rule.kind === 'altitude-zonation' && Array.isArray(rule.zones) ? rule.zones : [rule]
      for (const zone of settings) if (isPlainRecord(zone)) {
        if (typeof zone.minimumSpacingM === 'number' && zone.minimumSpacingM < 1) issues.push('原生植被的最小株距为 1 米。')
        if (typeof zone.densityPerHectare === 'number' && zone.densityPerHectare > 10000)
          issues.push('原生植被密度上限为每公顷 10,000 株。')
      }
    }
  }
  if (draft.publication !== undefined) {
    validatePublication(draft.publication, sceneType, issues, requireAssetUrls)
  }

  return { issues }
}
