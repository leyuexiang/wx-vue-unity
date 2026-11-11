import {
  cancelDim3dVegetationGenerationTask,
  createDim3dVegetationGenerationTask,
  getDim3dCurrentVegetationPublication,
  getDim3dVegetationGenerationTask,
  listDim3dVegetationPublicationHistory,
  publishDim3dVegetationGenerationTask,
  rollbackDim3dVegetationPublication,
} from '@/servers/manual/dim3d/api/vegetation'
import type {
  Dim3dVegetationGenerationProgress,
  Dim3dVegetationGenerationTaskResponse,
  Dim3dVegetationGenerationTaskStatus,
  Dim3dVegetationPublicationResponse,
} from '@/servers/manual/dim3d/api/vegetation'
import type {
  AssetRef,
  SceneDefinition,
  VegetationAltitudeZoneDefinition,
  VegetationGeoPosition,
  VegetationPlantingRule,
  VegetationSpeciesMixEntry,
  VegetationSystemDefinition,
  VegetationQualityPreset,
  VegetationPublicationDensityProfile,
} from '@/scene-platform/core/types'
import { DEFAULT_VEGETATION_PUBLICATION_DENSITY_PROFILES } from '@/scene-platform/core/vegetation'

export type VegetationGenerationTaskStatus = Dim3dVegetationGenerationTaskStatus

/** 任务执行观测，不进入规则快照；旧生成器或历史任务可缺失。 */
export type VegetationGenerationProgress = Dim3dVegetationGenerationProgress

export type VegetationGenerationTaskResponse = Dim3dVegetationGenerationTaskResponse

export type VegetationPublicationResponse = Dim3dVegetationPublicationResponse

export interface ResolvedVegetationElevationSource {
  /** Java可访问的数字高程模型服务地址；禁止传递仅浏览器可用的临时令牌。 */
  url: string
  /** 数据版本与垂直基准共同冻结高程结果，缺少任一字段时不得发布海拔规则。 */
  version: string
  verticalDatum: Exclude<VegetationSystemDefinition['elevationSource']['verticalDatum'], 'unknown'>
  heightOffsetM?: number
}

export interface BuildVegetationGenerationRequestOptions {
  gridSizeM?: number
  /** 镜头作用域海拔规则必须把当前业务范围冻结为闭合多边形。 */
  generationRegion?: readonly [number, number][]
  elevationSource?: ResolvedVegetationElevationSource
  idempotencyKey?: string
}

interface GenerationSpecies {
  speciesId: string
  assetId: string
  assetUrl: string
  assetVersion?: string
  /** 植被正式生成固定复用资源库已有GLB，不允许在任务链路中触发模型转换。 */
  assetKind: 'glb'
  weight: number
  minimumScale: number
  maximumScale: number
}

type GenerationRule = Record<string, unknown> & {
  ruleId: string
  type: 'polygon' | 'corridor' | 'altitude-zonation'
  layerId: string
  seedOffset: number
}

export interface VegetationGenerationRequest {
  sceneId: string
  ruleVersion: string
  seed: number
  gridSizeM: number
  originLongitude: number
  originLatitude: number
  elevationSource?: ResolvedVegetationElevationSource
  generationRegion?: { polygon: Array<{ longitude: number; latitude: number }> }
  rules: GenerationRule[]
  /** 要求生成器在同一发布包内输出三档稳定子集，而不是生成三套互相独立的数据。 */
  densityProfiles: Record<VegetationQualityPreset, VegetationPublicationDensityProfile>
  /** 动态地块必须裁剪到各自范围；静态任务未确认需要裁剪时不主动发送。 */
  clipToGenerationRegion?: boolean
  /** 仅单地块动态任务使用；九宫格批量协议改由 `tiles[].tileId` 表达。 */
  dynamicTileId?: string
  idempotencyKey?: string
}

const VEGETATION_DENSITY_PRESETS: readonly VegetationQualityPreset[] = [
  'high',
  'balanced',
  'performance',
]

/**
 * 将后端返回的三档地址转换为领域资产引用。
 *
 * 仅遍历固定三个档位，且只在任务完成、发布或预览切换的低频边界调用；浏览器不解析清单、更不会在
 * 运行时逐株裁剪。地址不完整时返回 `undefined`，由旧单入口兼容逻辑接管，避免半套地址被误当成可
 * 严格切换的密度发布。
 */
function createDensityTilesetAssets(
  urls: Partial<Record<VegetationQualityPreset, string>> | undefined,
  assetIdPrefix: string,
  version: string,
  hash: string,
) {
  if (!urls) return undefined
  const assets: Partial<Record<VegetationQualityPreset, AssetRef>> = {}
  for (const preset of VEGETATION_DENSITY_PRESETS) {
    const url = urls[preset]
    if (!url) return undefined
    assets[preset] = {
      id: `${assetIdPrefix}:${preset}`,
      kind: '3d-tiles',
      url,
      version,
      hash,
    }
  }
  return assets
}

/** 高清入口是旧 `tilesetAsset` 的兼容锚点，运行时始终优先读取完整密度入口。 */
function resolvePrimaryTilesetUrl(
  densityUrls: Partial<Record<VegetationQualityPreset, string>> | undefined,
  legacyUrl: string | undefined,
): string | undefined {
  return densityUrls?.high ?? legacyUrl
}

/** 比较固定三档的已持久化资产，防止后端修正入口后旧场景被错误认定为已同步。 */
function hasMatchingDensityTilesetAssets(
  assets: VegetationSystemDefinition['layers'][number]['densityTilesetAssets'],
  urls: Partial<Record<VegetationQualityPreset, string>> | undefined,
  assetIdPrefix: string,
  version: string,
  hash: string,
): boolean {
  /**
   * 当前版本接口兼容旧响应时可能只返回高清入口，历史接口才带三档地址。
   * 此时不能因为响应缺少可选映射就否定已从历史恢复的三档资产；仅校验三档资产的
   * 稳定编号、版本、摘要和类型，避免重复提示“版本不一致”。
   */
  if (!urls) {
    if (!assets) return true
    return VEGETATION_DENSITY_PRESETS.every((preset) => {
      const actual = assets?.[preset]
      return (
        actual?.id === `${assetIdPrefix}:${preset}` &&
        actual.kind === '3d-tiles' &&
        actual.version === version &&
        actual.hash === hash &&
        Boolean(actual.url)
      )
    })
  }
  const expected = createDensityTilesetAssets(urls, assetIdPrefix, version, hash)
  if (!expected) return assets === undefined
  return VEGETATION_DENSITY_PRESETS.every((preset) => {
    const actual = assets?.[preset]
    const target = expected[preset]
    if (!actual || !target) return false
    return (
      actual.id === target.id &&
      actual.kind === '3d-tiles' &&
      actual.url === target.url &&
      actual.version === target.version &&
      actual.hash === target.hash
    )
  })
}

/**
 * 把领域编辑坐标转为 Java 的显式经纬度点。
 * 第三项人工编辑高程只用于前端山区控制点，不进入生成快照；Python 仍以数字高程模型决定每株植被高度。
 */
function mapPositions(positions: readonly VegetationGeoPosition[]) {
  return positions.map(([longitude, latitude]) => ({ longitude, latitude }))
}

/**
 * 选择发布生成器使用的模型地址。
 *
 * 植被任务只接受资源库已经转换并发布的GLB。普通场景仍可加载GLTF，但这里不得读取派生配置、调用
 * 转换服务或把GLTF静默传给后端，否则同一任务会因外部二进制和纹理依赖产生不可复现结果。
 */
function resolveGenerationAsset(
  asset: AssetRef,
): Pick<GenerationSpecies, 'assetId' | 'assetUrl' | 'assetVersion' | 'assetKind'> {
  if (asset.kind !== 'glb') {
    throw new Error(`植被正式生成只接受已转换并发布的GLB模型：${asset.id}`)
  }
  if (!/^https?:\/\//i.test(asset.url ?? '')) {
    throw new Error('正式瓦片生成需要资源库中可访问的 GLB 模型，请在瓦片模式的物种列表中重新选择模型。')
  }
  return {
    assetId: String(asset.metadata?.assetId ?? asset.id),
    assetUrl: asset.url,
    assetVersion: asset.version,
    assetKind: 'glb',
  }
}

/** 通过编号索引一次物种目录，规则映射阶段不再对目录做重复线性查询。 */
function createSpeciesMapper(definition: VegetationSystemDefinition) {
  const speciesById = new Map(definition.speciesCatalog.map((species) => [species.id, species]))
  return (mix: readonly VegetationSpeciesMixEntry[]): GenerationSpecies[] =>
    mix.map((entry) => {
      const species = speciesById.get(entry.speciesId)
      if (!species || !species.enabled) {
        throw new Error(`植被规则引用了不存在或已停用的物种：${entry.speciesId}`)
      }
      return {
        speciesId: species.id,
        ...resolveGenerationAsset(species.modelAsset),
        weight: entry.weight,
        minimumScale: species.minimumScale,
        maximumScale: species.maximumScale,
      }
    })
}

function mapAltitudeZone(
  zone: VegetationAltitudeZoneDefinition,
  mapSpecies: (mix: readonly VegetationSpeciesMixEntry[]) => GenerationSpecies[],
) {
  return {
    zoneId: zone.id,
    minimumAltitudeM: zone.minimumAltitudeM,
    maximumAltitudeM: zone.maximumAltitudeM,
    minimumSlopeDegrees: zone.minimumSlopeDegrees,
    maximumSlopeDegrees: zone.maximumSlopeDegrees,
    densityPerHectare: zone.densityPerHectare,
    minimumSpacingM: zone.minimumSpacingM,
    upperTransitionWidthM: zone.upperTransitionWidthM,
    species: mapSpecies(zone.speciesMix),
  }
}

/** 把前端判别联合映射成Java/Python共享的三类冻结规则协议。 */
function mapRule(
  rule: VegetationPlantingRule,
  mapSpecies: (mix: readonly VegetationSpeciesMixEntry[]) => GenerationSpecies[],
): GenerationRule {
  const common = {
    ruleId: rule.id,
    type: rule.kind,
    layerId: rule.layerId,
    seedOffset: rule.seedOffset,
  }
  if (rule.kind === 'corridor') {
    return {
      ...common,
      path: mapPositions(rule.path),
      side: rule.side,
      offsetM: rule.offsetM,
      spacingM: rule.spacingM,
      startOffsetM: rule.startOffsetM,
      endOffsetM: rule.endOffsetM,
      alignToPath: rule.alignToPath,
      species: mapSpecies(rule.speciesMix),
    }
  }
  if (rule.kind === 'polygon') {
    if (rule.polygon.rings.length !== 1) throw new Error('正式植被生成暂不支持多边形孔洞。')
    if (rule.targetCount !== undefined) throw new Error('当前正式生成服务按密度生成，请清空目标株数后再生成瓦片。')
    return {
      ...common,
      polygon: mapPositions(rule.polygon.rings[0]),
      distribution: rule.distribution,
      densityPerHectare: rule.densityPerHectare,
      minimumSpacingM: rule.minimumSpacingM,
      species: mapSpecies(rule.speciesMix),
    }
  }
  if (rule.scope === 'polygon' && rule.polygon?.rings.length !== 1) {
    throw new Error('正式海拔植被生成暂不支持多边形孔洞。')
  }
  return {
    ...common,
    scope: rule.scope ?? (rule.polygon ? 'polygon' : 'camera-view'),
    ...(rule.polygon ? { polygon: mapPositions(rule.polygon.rings[0]) } : {}),
    gapPolicy: rule.gapPolicy,
    zones: rule.zones
      .filter((zone) => zone.enabled)
      .map((zone) => mapAltitudeZone(zone, mapSpecies)),
  }
}

/** 从首个有几何的规则取得稳定地块原点，调用方也可在未来扩展为场景级固定原点。 */
function resolveOrigin(
  rules: readonly VegetationPlantingRule[],
  generationRegion?: readonly [number, number][],
): [number, number] {
  for (const rule of rules) {
    const point = rule.kind === 'corridor' ? rule.path[0] : rule.polygon?.rings[0]?.[0]
    if (point) return [point[0], point[1]]
  }
  /** 镜头作用域海拔规则没有持久化 polygon，正式范围冻结后由其首点提供稳定地块原点。 */
  const regionPoint = generationRegion?.[0]
  if (regionPoint) return [regionPoint[0], regionPoint[1]]
  throw new Error('植被规则没有可用于确定地块原点的业务范围。')
}

/** 构造只包含已启用规则的不可变任务快照；生成器版本由Java服务端覆盖。 */
export function buildVegetationGenerationRequest(
  scene: Pick<SceneDefinition, 'id' | 'vegetation'>,
  options: BuildVegetationGenerationRequestOptions = {},
): VegetationGenerationRequest {
  const definition = scene.vegetation
  if (!definition) throw new Error('当前场景尚未创建植被系统。')
  const rules = definition.rules.filter((rule) => rule.enabled)
  if (rules.length === 0) throw new Error('当前场景没有已启用的植被规则。')
  const hasAltitudeRule = rules.some((rule) => rule.kind === 'altitude-zonation')
  if (hasAltitudeRule && !options.elevationSource) {
    throw new Error('海拔植被生成需要后端可访问的数字高程模型地址、版本和垂直基准。')
  }
  const hasCameraRule = rules.some(
    (rule) => rule.kind === 'altitude-zonation' && !rule.polygon && rule.scope !== 'polygon',
  )
  if (hasCameraRule && !options.generationRegion) {
    throw new Error('镜头作用域海拔规则发布前必须冻结正式生成范围。')
  }

  const [originLongitude, originLatitude] = resolveOrigin(rules, options.generationRegion)
  const mapSpecies = createSpeciesMapper(definition)
  return {
    sceneId: scene.id,
    ruleVersion: definition.ruleSetVersion,
    seed: definition.seed,
    gridSizeM: options.gridSizeM ?? 100,
    originLongitude,
    originLatitude,
    ...(options.elevationSource ? { elevationSource: options.elevationSource } : {}),
    ...(options.generationRegion
      ? { generationRegion: { polygon: mapPositions(options.generationRegion) } }
      : {}),
    rules: rules.map((rule) => mapRule(rule, mapSpecies)),
    densityProfiles: { ...DEFAULT_VEGETATION_PUBLICATION_DENSITY_PROFILES },
    ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
  }
}

export function createVegetationGenerationTask(body: VegetationGenerationRequest) {
  return createDim3dVegetationGenerationTask(body)
}

/** 查询跟随编辑会话取消；不改变服务端任务自身状态。 */
export function getVegetationGenerationTask(taskId: string, signal?: AbortSignal) {
  return getDim3dVegetationGenerationTask(taskId, signal)
}

export function cancelVegetationGenerationTask(taskId: string) {
  return cancelDim3dVegetationGenerationTask(taskId)
}

export function publishVegetationGenerationTask(taskId: string) {
  return publishDim3dVegetationGenerationTask(taskId)
}

export function getCurrentVegetationPublication(sceneId: string) {
  return getDim3dCurrentVegetationPublication(sceneId)
}

export function listVegetationPublicationHistory(sceneId: string) {
  return listDim3dVegetationPublicationHistory(sceneId)
}

export function rollbackVegetationPublication(sceneId: string, publicationVersion: string) {
  return rollbackDim3dVegetationPublication(sceneId, publicationVersion)
}

/**
 * 判断Java返回的稳定发布引用是否已完整写入当前场景定义。
 *
 * 该检查只做一次图层线性遍历，并通过编号直接读取后端图层地址；除版本和地址外还比较规则版本、
 * 清单、哈希与资产编号，避免后端修正同版本元数据后被误判为无需同步。未发布图层必须没有旧资产，
 * 否则运行时会继续叠加上一版本的数据。
 */
export function isVegetationPublicationApplied(
  definition: VegetationSystemDefinition,
  publication: VegetationPublicationResponse,
): boolean {
  const version = publication.publicationVersion
  const manifestId = `vegetation-manifest:${publication.sceneId}:${version}`
  const persistedPublication = definition.publication
  const densityProfilesMatch =
    publication.densityProfiles === undefined ||
    JSON.stringify(persistedPublication?.densityProfiles ?? null) ===
      JSON.stringify(publication.densityProfiles)
  if (
    persistedPublication?.version !== version ||
    persistedPublication.ruleVersion !== publication.ruleVersion ||
    persistedPublication.manifestAsset?.id !== manifestId ||
    persistedPublication.manifestAsset.kind !== 'json' ||
    persistedPublication.manifestAsset.url !== publication.manifestUrl ||
    persistedPublication.manifestAsset.version !== version ||
    persistedPublication.manifestAsset.hash !== publication.sourceHash ||
    persistedPublication.tilesetAsset?.id !==
      `vegetation-tileset:${publication.sceneId}:${version}` ||
    persistedPublication.tilesetAsset.kind !== '3d-tiles' ||
    persistedPublication.tilesetAsset.url !== publication.tilesetUrl ||
    persistedPublication.tilesetAsset.version !== version ||
    persistedPublication.tilesetAsset.hash !== publication.sourceHash ||
    !densityProfilesMatch
  ) {
    return false
  }

  /** 单图层稳定发布与临时任务保持相同兼容口径，避免场景重开后因逐层映射缺失退回 0 个图层。 */
  const singleLayerFallback = definition.layers.length === 1 ? publication.tilesetUrl : undefined
  return definition.layers.every((layer) => {
    const densityUrls = publication.layerDensityTilesetUrls?.[layer.id]
    const tilesetUrl = resolvePrimaryTilesetUrl(
      densityUrls,
      publication.layerTilesetUrls[layer.id] ?? singleLayerFallback,
    )
    const densityAssetPrefix = `vegetation-tileset:${publication.sceneId}:${version}:${layer.id}`
    if (!tilesetUrl) {
      return !layer.manifestAsset && !layer.tilesetAsset && !layer.densityTilesetAssets
    }
    return (
      layer.manifestAsset?.id === manifestId &&
      layer.manifestAsset.kind === 'json' &&
      layer.manifestAsset.url === publication.manifestUrl &&
      layer.manifestAsset.version === version &&
      layer.manifestAsset.hash === publication.sourceHash &&
      layer.tilesetAsset?.id ===
        `vegetation-tileset:${publication.sceneId}:${version}:${layer.id}` &&
      layer.tilesetAsset.kind === '3d-tiles' &&
      layer.tilesetAsset.url === tilesetUrl &&
      layer.tilesetAsset.version === version &&
      layer.tilesetAsset.hash === publication.sourceHash &&
      hasMatchingDensityTilesetAssets(
        layer.densityTilesetAssets,
        densityUrls,
        densityAssetPrefix,
        version,
        publication.sourceHash,
      )
    )
  })
}

/**
 * 把Java当前版本映射回场景领域定义。业务清单与Cesium入口分字段保存，每图层仅绑定自己的
 * tileset地址；不存在于响应中的草稿图层保持未发布状态，不会误加载整场景根瓦片。
 */
export function applyVegetationPublication(
  definition: VegetationSystemDefinition,
  publication: VegetationPublicationResponse,
): VegetationSystemDefinition {
  const version = publication.publicationVersion
  /**
   * 单图层可以安全复用整场入口；多图层必须逐层精确匹配，禁止把同一根瓦片重复绑定到多个图层。
   * 即使后端映射里混有已删除图层编号，当前唯一图层仍可使用整场入口恢复稳定发布结果。
   */
  const singleLayerFallback = definition.layers.length === 1 ? publication.tilesetUrl : undefined
  const layers = definition.layers.map((layer) => {
    const densityUrls = publication.layerDensityTilesetUrls?.[layer.id]
    const tilesetUrl = resolvePrimaryTilesetUrl(
      densityUrls,
      publication.layerTilesetUrls[layer.id] ?? singleLayerFallback,
    )
    if (!tilesetUrl) {
      // 可序列化领域对象不能显式保存undefined，因此通过解构真正移除上一版本资产字段。
      const {
        manifestAsset: _manifestAsset,
        tilesetAsset: _tilesetAsset,
        densityTilesetAssets: _densityTilesetAssets,
        ...draftLayer
      } = layer
      return draftLayer
    }
    const densityAssetPrefix = `vegetation-tileset:${publication.sceneId}:${version}:${layer.id}`
    const densityTilesetAssets = createDensityTilesetAssets(
      densityUrls,
      densityAssetPrefix,
      version,
      publication.sourceHash,
    )
    /** 先移除旧映射，再按本次发布完整写入，避免服务端降级时遗留过期低密度入口。 */
    const { densityTilesetAssets: _previousDensityTilesetAssets, ...baseLayer } = layer
    return {
      ...baseLayer,
      manifestAsset: {
        id: `vegetation-manifest:${publication.sceneId}:${version}`,
        kind: 'json' as const,
        url: publication.manifestUrl,
        version,
        hash: publication.sourceHash,
      },
      tilesetAsset: {
        id: densityAssetPrefix,
        kind: '3d-tiles' as const,
        url: tilesetUrl,
        version,
        hash: publication.sourceHash,
      },
      ...(densityTilesetAssets ? { densityTilesetAssets } : {}),
    }
  })
  return {
    ...definition,
    layers,
    publication: {
      version,
      /** 持久化Java实际发布的冻结规则版本，场景重开后仍能判断当前规则是否已有对应生成结果。 */
      ruleVersion: publication.ruleVersion,
      manifestAsset: {
        id: `vegetation-manifest:${publication.sceneId}:${version}`,
        kind: 'json',
        url: publication.manifestUrl,
        version,
        hash: publication.sourceHash,
      },
      tilesetAsset: {
        id: `vegetation-tileset:${publication.sceneId}:${version}`,
        kind: '3d-tiles',
        url: publication.tilesetUrl,
        version,
        hash: publication.sourceHash,
      },
      generatedAt: new Date().toISOString(),
      sourceHash: publication.sourceHash,
      ...(publication.densityProfiles ? { densityProfiles: publication.densityProfiles } : {}),
    },
  }
}

/**
 * 构造“已生成、未发布”的临时运行时定义。
 *
 * 生成任务成功后，Java 已经返回了 Python 实际产出的 tileset.json 地址；编辑器应直接预览这份
 * 正式结果，而不是继续显示最多 64 株的本地抽样模型。该函数只返回内存副本，调用方不得把结果
 * 通过命令写入 SceneStore，只有后续发布接口返回稳定版本后才能持久化。
 *
 * 当任务只返回整场景入口时，单图层场景允许使用 tilesetUrl 作为回退；多图层场景必须使用逐图层
 * 地址，避免把整场景根瓦片重复挂载到多个图层。
 */
export function applyVegetationGenerationPreview(
  definition: VegetationSystemDefinition,
  task: Pick<
    VegetationGenerationTaskResponse,
    | 'taskId'
    | 'publicationVersion'
    | 'sourceHash'
    | 'tilesetUrl'
    | 'layerTilesetUrls'
    | 'layerDensityTilesetUrls'
    | 'densityProfiles'
  >,
): VegetationSystemDefinition {
  const version = task.publicationVersion ?? `generation-${task.taskId}`
  const hash = task.sourceHash ?? `task:${task.taskId}`
  const layerUrls = task.layerTilesetUrls ?? {}
  const layerDensityUrls = task.layerDensityTilesetUrls ?? {}
  /**
   * 单图层任务只要返回整场入口就允许回退，不能因为响应里同时夹带未知或旧图层编号而放弃真实结果。
   * 多图层仍禁止使用整场入口兜底，否则同一根瓦片会被重复挂载到多个业务图层。
   */
  const singleLayerFallback = definition.layers.length === 1 ? task.tilesetUrl : undefined

  const layers = definition.layers.map((layer) => {
    const densityUrls = layerDensityUrls[layer.id]
    const tilesetUrl = resolvePrimaryTilesetUrl(
      densityUrls,
      layerUrls[layer.id] ?? singleLayerFallback,
    )
    if (!tilesetUrl) {
      /** 临时预览不能混入旧发布版本，否则用户会误以为新任务已生成全部图层。 */
      const {
        manifestAsset: _manifestAsset,
        tilesetAsset: _tilesetAsset,
        densityTilesetAssets: _densityTilesetAssets,
        ...draftLayer
      } = layer
      return draftLayer
    }
    const densityAssetPrefix = `vegetation-generation-preview:${task.taskId}:${layer.id}`
    const densityTilesetAssets = createDensityTilesetAssets(
      densityUrls,
      densityAssetPrefix,
      version,
      hash,
    )
    const { densityTilesetAssets: _previousDensityTilesetAssets, ...baseLayer } = layer
    return {
      ...baseLayer,
      tilesetAsset: {
        /** 临时资产以任务号隔离；发布后由稳定场景资产编号原子替换，不能提前冒充已发布资源。 */
        id: `vegetation-generation-preview:${task.taskId}:${layer.id}`,
        kind: '3d-tiles' as const,
        url: tilesetUrl,
        version,
        hash,
      },
      ...(densityTilesetAssets ? { densityTilesetAssets } : {}),
    }
  })

  // 临时预览不写入 publication；密度清单只有稳定发布响应返回后才进入场景存档。
  return { ...definition, layers }
}
