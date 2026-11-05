import type {
  AssetKind,
  AssetRef,
  CameraPath,
  ModelMaterialProfile,
  ModelMaterialRule,
  GisLayerProvider,
  BoundingVolume,
  EffectSpec,
  ModelLodVariant,
  SceneCoordinateSystem,
  SceneChunk,
  SceneDefinition,
  SceneLayer,
  SceneMetadata,
  SceneObject,
  SceneObjectType,
  FirstPersonConfig,
  SceneSettings,
  SceneStreamingConfig,
  SceneStreamingRuntimeContext,
  SceneType,
  RuntimeStreamingOptions,
  StreamingGroup,
} from './types'
import {
  CAMERA_PATH_DEFAULT_TURN_DURATION_MS,
  CAMERA_PATH_TURN_DURATION_RANGE,
  getCameraPathMinimumTotalDurationMs,
} from './cameraPath'
import {
  isLegacyWeatherEffectSpec,
  normalizeWeatherV2Effect,
  validateWeatherV2EffectSpec,
} from '../effects/weather'
import { normalizeBillboardConfig } from './billboard'
import {
  normalizeVegetationSystemDefinition,
  validateVegetationSystemDefinition,
} from './vegetation'
import { validateVolumeHeatmapEffectSpec } from '../effects/volumeHeatmap'
import { validateThreeMapEffectSpec } from '../effects/threeMap'

/**
 * 创建场景定义的输入参数。
 * 约束：这里仅允许领域对象数据，不允许出现 Cesium/Three 引擎对象引用。
 */
export interface CreateSceneDefinitionInput {
  id: string
  name: string
  type: SceneType
  coordinateSystem: SceneCoordinateSystem
  objects?: SceneObject[]
  streaming?: SceneDefinition['streaming']
  layers?: SceneDefinition['layers']
  effects?: SceneDefinition['effects']
  cameraPaths?: CameraPath[]
  /** 可选植被定义；缺失时保持未启用状态，不自动创建空植被系统。 */
  vegetation?: SceneDefinition['vegetation']
  settings?: SceneSettings
  metadata?: SceneMetadata
}

export interface SceneValidationResult {
  issues: string[]
}

type SceneObjectDraft = Partial<SceneObject>
type AssetRefDraft = Partial<AssetRef>
type ModelMaterialProfileDraft = Partial<ModelMaterialProfile>
type ModelMaterialRuleDraft = Partial<ModelMaterialRule>
type ModelLodVariantDraft = Partial<ModelLodVariant>
type SceneChunkDraft = Partial<SceneChunk>
type StreamingGroupDraft = Partial<StreamingGroup>
type RuntimeStreamingOptionsDraft = Partial<RuntimeStreamingOptions>
/**
 * 运行态覆盖在反序列化时同样允许缺失基础字段。
 *
 * `enabled` 在覆盖层中是可选项：缺失时沿用场景公共策略；仅配置某个运行态时，
 * 由策略解析器补齐为“默认关闭 + 指定字段覆盖”，避免把编辑器或预览的临时预算误写成公共值。
 */
type SceneStreamingRuntimeOverridesDraft = Partial<
  Record<SceneStreamingRuntimeContext, RuntimeStreamingOptionsDraft>
>
type SceneStreamingConfigDraft = Partial<Omit<SceneStreamingConfig, 'chunks' | 'groups'>> & {
  chunks?: SceneChunkDraft[]
  groups?: StreamingGroupDraft[]
  runtimeOverrides?: SceneStreamingRuntimeOverridesDraft
}
/**
 * 解析阶段使用的宽松场景草稿类型。
 * streaming 同样需要从完整领域类型中排除后再放宽，
 * 以便兼容层能保留缺失字段和待校验的部分区块元数据，而不会误要求其已满足完整配置。
 */
type SceneDefinitionDraft = Partial<
  Omit<SceneDefinition, 'objects' | 'streaming' | 'vegetation'>
> & {
  objects?: SceneObjectDraft[]
  streaming?: SceneStreamingConfigDraft
  cameraPaths?: unknown
  vegetation?: unknown
}
type SceneEffectDraft = Partial<SceneDefinition['effects'][number]>

/**
 * SceneObject 第一版允许的对象类型集合。
 * 这里先集中校验“能否作为领域对象进入 Store”，对象类型的阶段边界和扩展策略由 B005 继续细化。
 */
const SUPPORTED_SCENE_OBJECT_TYPES = new Set<SceneObjectType>([
  'model',
  'image',
  'primitive',
  'tileset',
  'light',
  'camera',
  'annotation',
  'effect',
  'group',
])

const isValidFirstPersonConfig = (value: unknown): value is FirstPersonConfig => {
  if (!isRecordLike(value)) return false
  const numericFields: Array<keyof FirstPersonConfig> = [
    'height',
    'eyeHeight',
    'collisionRadius',
    'moveSpeed',
    'lookSensitivity',
    'fov',
  ]
  if (typeof value.enabled !== 'boolean' || typeof value.lockPitch !== 'boolean' ||
      typeof value.collisionEnabled !== 'boolean') return false
  if (numericFields.some((field) => typeof value[field] !== 'number' || !Number.isFinite(value[field] as number))) {
    return false
  }
  const height = value.height as number
  const eyeHeight = value.eyeHeight as number
  const collisionRadius = value.collisionRadius as number
  const moveSpeed = value.moveSpeed as number
  const lookSensitivity = value.lookSensitivity as number
  const fov = value.fov as number
  return height > 0 && eyeHeight > 0 && eyeHeight <= height &&
    collisionRadius > 0 && collisionRadius <= height / 2 && moveSpeed >= 0 && lookSensitivity > 0 &&
    fov >= 30 && fov <= 120
}

/**
 * AssetRef 第一版允许的资产类型集合。
 * 这里与 core/types.ts 中的 AssetKind 同步维护，确保 GLB、GLTF、图片等资源
 * 只按“资产形态”分流，不按 Cesium/Three 运行时实现拆成两套资源结构。
 */
const SUPPORTED_ASSET_KINDS = new Set<AssetKind>([
  'unity-model',
  'glb',
  'gltf',
  'image',
  'texture',
  'material',
  'effect',
  'hdr',
  'json',
  'volume-field',
  '3d-tiles',
])

/**
 * SceneLayer 第一版允许的图层类型集合。
 * imagery/terrain/tileset/vector 属于 GIS 数据源图层，可携带 provider/url/asset/options。
 */
const SUPPORTED_LAYER_TYPES = new Set<SceneLayer['type']>([
  'object',
  'imagery',
  'terrain',
  'tileset',
  'vector',
  'effect',
  'annotation',
])

const SUPPORTED_EFFECT_TYPES = new Set<SceneDefinition['effects'][number]['type']>([
  'particle',
  'trail',
  'weather',
  'postprocess',
  'volume-heatmap',
  'three-map',
])

/**
 * GIS 图层数据源提供者集合。
 * 与 core/types.ts 中的 GisLayerProvider 同步维护。
 */
const SUPPORTED_GIS_LAYER_PROVIDERS = new Set<GisLayerProvider>([
  'local',
  'tianditu',
  'amap',
  'google',
  'xyz',
  'wmts',
  'wms',
  'natural-earth',
  'arcgis',
  'geojson',
  'kml',
  'czml',
  '3d-tiles',
])

/**
 * 当前场景数据 schema 版本号。
 * 升级时需同步实现 migration，并在 parseSceneDefinition 中应用。
 */
export const CURRENT_SCENE_SCHEMA_VERSION = 1

const MIN_SUPPORTED_SCENE_SCHEMA_VERSION = 1

/**
 * 无版本旧场景所对应的已知基础版本。
 *
 * 不能把无版本数据直接标记为“当前版本”：当未来 schema 升级时，
 * 这样会跳过从基础版本到新版本的迁移函数，导致旧字段无法被正确转换。
 * 当前首个正式版本为 1；若未来不再支持该版本，应显式提供旧格式迁移器，
 * 而不是把无版本数据误判为较新的格式。
 */
const LEGACY_UNVERSIONED_SCENE_SCHEMA_VERSION = 1

type SceneDefinitionMigration = (scene: SceneDefinitionDraft) => SceneDefinitionDraft

const SCENE_SCHEMA_MIGRATIONS: Partial<Record<number, SceneDefinitionMigration>> = {}

function migrateSceneDefinitionDraft(scene: SceneDefinitionDraft): SceneDefinitionDraft {
  const sourceVersion = scene.schemaVersion
  const version =
    sourceVersion === undefined ? LEGACY_UNVERSIONED_SCENE_SCHEMA_VERSION : sourceVersion

  if (typeof version !== 'number') {
    return scene
  }

  if (!Number.isInteger(version) || version < MIN_SUPPORTED_SCENE_SCHEMA_VERSION) {
    throw new Error(`Unsupported scene definition schemaVersion: ${version}`)
  }

  if (version > CURRENT_SCENE_SCHEMA_VERSION) {
    throw new Error(
      `Scene definition schemaVersion ${version} is newer than supported version ${CURRENT_SCENE_SCHEMA_VERSION}.`,
    )
  }

  // 缺失版本号的旧数据先明确标记为其来源版本，再依次执行后续版本迁移。
  // 这样未来从 v1 升级到 v2 时，无版本场景也会经过 v1 -> v2 的转换。
  let migrated: SceneDefinitionDraft =
    sourceVersion === undefined
      ? {
          ...scene,
          schemaVersion: LEGACY_UNVERSIONED_SCENE_SCHEMA_VERSION,
        }
      : scene
  for (
    let currentVersion = version;
    currentVersion < CURRENT_SCENE_SCHEMA_VERSION;
    currentVersion += 1
  ) {
    const migration = SCENE_SCHEMA_MIGRATIONS[currentVersion]
    if (!migration) {
      throw new Error(`Missing scene definition migration from schemaVersion ${currentVersion}.`)
    }
    migrated = migration(migrated)
  }

  return {
    ...migrated,
    schemaVersion: CURRENT_SCENE_SCHEMA_VERSION,
  }
}

/**
 * 只接受 JSON 普通对象。
 * 这样可以在领域层挡住 Date、DOM 节点、Three/Cesium 类实例等运行时对象，
 * 避免它们被误塞进 SceneDefinition、AssetRef 或 metadata。
 */
function isRecordLike(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }

  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isRemovedLegacyWeatherEffect(effect: unknown): boolean {
  return isLegacyWeatherEffectSpec(effect)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0
}

/**
 * 流式调度中的数量、并发和 LOD 层级都是离散索引。
 * 使用安全整数可避免小数或超大数进入后续数组下标、队列容量和预算计算，
 * 从源头阻止 Runtime 在调度阶段出现不可预测的取整行为。
 */
function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => isNonEmptyString(item))
}

function isNumberTuple3(value: unknown): value is [number, number, number] {
  return Array.isArray(value) && value.length === 3 && value.every((item) => isFiniteNumber(item))
}

/** 校验 Cesium 相机路径，确保持久化数据可被逐帧播放器安全消费。 */
function validateCameraPaths(
  paths: unknown,
  sceneType: SceneType | undefined,
  issues: string[],
): void {
  if (paths === undefined) return
  if (!Array.isArray(paths)) {
    issues.push('Scene cameraPaths must be an array when provided.')
    return
  }
  if (paths.length > 20) issues.push('Scene cameraPaths must contain at most 20 paths.')
  const ids = new Set<string>()
  paths.forEach((path, pathIndex) => {
    const prefix = `Scene camera path at index ${pathIndex}`
    if (!isRecordLike(path)) {
      issues.push(`${prefix} must be a plain object.`)
      return
    }
    const draft = path as Partial<CameraPath>
    if (!isNonEmptyString(draft.id)) issues.push(`${prefix} id is required.`)
    else if (ids.has(draft.id)) issues.push(`${prefix} id must be unique.`)
    else ids.add(draft.id)
    if (!isNonEmptyString(draft.name)) issues.push(`${prefix} name is required.`)
    if (typeof draft.enabled !== 'boolean') issues.push(`${prefix} enabled must be boolean.`)
    if (typeof draft.loop !== 'boolean') issues.push(`${prefix} loop must be boolean.`)
    if (typeof draft.autoPlay !== 'boolean') issues.push(`${prefix} autoPlay must be boolean.`)
    if (
      draft.orientationMode !== undefined &&
      draft.orientationMode !== 'keyframes' &&
      draft.orientationMode !== 'follow-path'
    ) {
      issues.push(`${prefix} orientationMode must be keyframes or follow-path when provided.`)
    }
    if (
      draft.turnDurationMs !== undefined &&
      (!Number.isSafeInteger(draft.turnDurationMs) ||
        draft.turnDurationMs < CAMERA_PATH_TURN_DURATION_RANGE.min ||
        draft.turnDurationMs > CAMERA_PATH_TURN_DURATION_RANGE.max ||
        draft.turnDurationMs % CAMERA_PATH_TURN_DURATION_RANGE.step !== 0)
    ) {
      const turnDurationIssue =
        `${prefix} turnDurationMs must be an integer between ` +
        `${CAMERA_PATH_TURN_DURATION_RANGE.min} and ${CAMERA_PATH_TURN_DURATION_RANGE.max} ` +
        `aligned to ${CAMERA_PATH_TURN_DURATION_RANGE.step}.`
      issues.push(turnDurationIssue)
    }
    if (!isNonNegativeFiniteNumber(draft.durationMs) || draft.durationMs <= 0)
      issues.push(`${prefix} durationMs must be positive.`)
    if (sceneType !== 'gis') issues.push('Camera paths are currently supported only by GIS scenes.')
    if (
      !Array.isArray(draft.waypoints) ||
      draft.waypoints.length < 2 ||
      draft.waypoints.length > 200
    ) {
      issues.push(`${prefix} waypoints must contain 2 to 200 points.`)
      return
    }
    let previousTime = -1
    const waypointIds = new Set<string>()
    draft.waypoints.forEach((waypoint, waypointIndex) => {
      const pointPrefix = `${prefix} waypoint at index ${waypointIndex}`
      if (!isRecordLike(waypoint)) {
        issues.push(`${pointPrefix} must be a plain object.`)
        return
      }
      const point = waypoint as Partial<CameraPath['waypoints'][number]>
      if (point.kind !== 'geo') issues.push(`${pointPrefix} kind must be geo.`)
      if (!isNonEmptyString(point.id)) issues.push(`${pointPrefix} id is required.`)
      else if (waypointIds.has(point.id))
        issues.push(`${pointPrefix} id must be unique within the path.`)
      else waypointIds.add(point.id)
      if (waypointIndex === 0 && point.timeMs !== 0)
        issues.push(`${pointPrefix} timeMs must start at 0.`)
      if (!isNonNegativeFiniteNumber(point.timeMs) || point.timeMs <= previousTime)
        issues.push(`${pointPrefix} timeMs must be strictly increasing.`)
      if (typeof point.timeMs === 'number') previousTime = point.timeMs
      if (!isNumberTuple3(point.destination))
        issues.push(`${pointPrefix} destination must be [longitude, latitude, height].`)
      else if (
        point.destination[0] < -180 ||
        point.destination[0] > 180 ||
        point.destination[1] < -90 ||
        point.destination[1] > 90
      )
        issues.push(`${pointPrefix} destination longitude/latitude is out of range.`)
      const orientation = point.orientation
      if (
        !isRecordLike(orientation) ||
        !isFiniteNumber(orientation.heading) ||
        !isFiniteNumber(orientation.pitch) ||
        !isFiniteNumber(orientation.roll)
      )
        issues.push(`${pointPrefix} orientation must contain finite heading, pitch and roll.`)
      if (point.interpolation !== 'linear' && point.interpolation !== 'ease-in-out')
        issues.push(`${pointPrefix} interpolation must be linear or ease-in-out.`)
    })
    const last = draft.waypoints[draft.waypoints.length - 1] as Partial<
      CameraPath['waypoints'][number]
    >
    /**
     * 路径点时间表示位置到达时刻，末点之后还要保留转向尾段；因此末点不再要求等于总时长，
     * 但总时长必须覆盖“末点时间 + 有效转向时长”。缺失转向字段的历史路径使用兼容默认值，
     * 非法显式值仍只报告转向字段本身的错误，避免校验阶段替用户修改坏数据。
     */
    const hasValidTurnDuration =
      typeof draft.turnDurationMs === 'number' &&
      Number.isSafeInteger(draft.turnDurationMs) &&
      draft.turnDurationMs >= CAMERA_PATH_TURN_DURATION_RANGE.min &&
      draft.turnDurationMs <= CAMERA_PATH_TURN_DURATION_RANGE.max &&
      draft.turnDurationMs % CAMERA_PATH_TURN_DURATION_RANGE.step === 0
    const canValidateTotalDuration =
      typeof last.timeMs === 'number' &&
      Number.isFinite(last.timeMs) &&
      typeof draft.durationMs === 'number' &&
      Number.isFinite(draft.durationMs) &&
      (hasValidTurnDuration || draft.turnDurationMs === undefined)
    if (canValidateTotalDuration) {
      const minimumTotalDuration = getCameraPathMinimumTotalDurationMs(
        last.timeMs!,
        hasValidTurnDuration ? draft.turnDurationMs : CAMERA_PATH_DEFAULT_TURN_DURATION_MS,
      )
      if (draft.durationMs! < minimumTotalDuration) {
        issues.push(
          `${prefix} durationMs must be at least last waypoint timeMs plus turnDurationMs ` +
            `(${minimumTotalDuration}).`,
        )
      }
    }
  })
}

function isSupportedSceneObjectType(value: unknown): value is SceneObjectType {
  return typeof value === 'string' && SUPPORTED_SCENE_OBJECT_TYPES.has(value as SceneObjectType)
}

function isSupportedAssetKind(value: unknown): value is AssetKind {
  return typeof value === 'string' && SUPPORTED_ASSET_KINDS.has(value as AssetKind)
}

/**
 * 多细节层次变体只允许资源市场用户 GLB / GLTF 模型。
 *
 * 此判断独立于通用 AssetKind 校验：通用 AssetRef 仍可描述图片、材质或 GIS 原生三维瓦片，
 * 但它们不能携带实例级模型变体，防止后续 Runtime 把用户模型的距离调度错误应用到瓦片通道。
 */
function isModelAssetKind(value: unknown): value is ModelLodVariant['kind'] {
  return value === 'glb' || value === 'gltf'
}

function isSupportedLayerType(value: unknown): value is SceneLayer['type'] {
  return typeof value === 'string' && SUPPORTED_LAYER_TYPES.has(value as SceneLayer['type'])
}

function isSupportedGisLayerProvider(value: unknown): value is GisLayerProvider {
  return typeof value === 'string' && SUPPORTED_GIS_LAYER_PROVIDERS.has(value as GisLayerProvider)
}

function isGisDataLayerType(value: unknown): boolean {
  return value === 'imagery' || value === 'terrain' || value === 'tileset' || value === 'vector'
}

/**
 * 校验资产元数据是否仍是纯 JSON 数据。
 * 第一版不解析具体模型包围盒或图片尺寸语义，只阻止函数、循环引用和引擎类实例进入保存数据。
 */
function isSerializableMetadataValue(value: unknown, visiting = new WeakSet<object>()): boolean {
  if (value === null) {
    return true
  }

  if (typeof value === 'string' || typeof value === 'boolean') {
    return true
  }

  if (typeof value === 'number') {
    return Number.isFinite(value)
  }

  if (typeof value !== 'object') {
    return false
  }

  if (visiting.has(value)) {
    return false
  }

  visiting.add(value)

  const isSerializable = Array.isArray(value)
    ? value.every((item) => isSerializableMetadataValue(item, visiting))
    : isRecordLike(value) &&
      Object.values(value).every((item) => isSerializableMetadataValue(item, visiting))

  visiting.delete(value)
  return isSerializable
}

/**
 * 记录 SceneObject 第一版的兼容默认值。
 * 旧对象可能缺少 visible/locked/metadata 这类可安全补齐的展示字段；
 * id/name/type/transform 会影响对象映射和渲染落点，缺失时仍由校验失败处理。
 */
function applySceneObjectCompatibilityDefaults(object: unknown): SceneObjectDraft {
  if (!isRecordLike(object)) {
    return {}
  }

  const sceneObject = object as SceneObjectDraft
  /**
   * `metadata.pickup` 是早期创建快照的误命名字段，解析边界一次性迁移到 `pickable`。
   * 显式自身锁定与可拾取配置相互独立；仅缺少锁定字段的旧档沿用反向推导。
   */
  const metadata = isRecordLike(sceneObject.metadata) ? { ...sceneObject.metadata } : {}
  const pickable =
    typeof metadata.pickable === 'boolean'
      ? metadata.pickable
      : typeof metadata.pickup === 'boolean'
        ? metadata.pickup
        : undefined
  if (typeof pickable === 'boolean') {
    metadata.pickable = pickable
    delete metadata.pickup
  }

  const editorModelSnapshot = isRecordLike(metadata.editorModelSnapshot)
    ? metadata.editorModelSnapshot
    : undefined
  /**
   * 早期 GIS 创建链路只保存了图片 asset 和编辑器快照，没有写入 billboard 字段。
   * 仅迁移快照明确标记为三维看板的对象，普通历史图片继续保持图片语义，避免扩大兼容范围。
   */
  const isLegacyBillboard = editorModelSnapshot?.componentKind === 'billboard'

  return {
    ...sceneObject,
    visible: sceneObject.visible ?? true,
    locked: sceneObject.locked ?? (typeof pickable === 'boolean' ? !pickable : false),
    metadata,
    /**
     * 配置存在时立即归一化；旧 GIS 看板缺少配置时补齐默认值。
     * 未被编辑器快照明确标记为看板的历史图片不会进入迁移分支。
     */
    ...(sceneObject.billboard !== undefined || isLegacyBillboard
      ? { billboard: normalizeBillboardConfig(sceneObject.billboard) }
      : {}),
  }
}

/**
 * 统一对象列表的兼容默认值。
 * 创建场景和解析旧数据共用这一入口，保证序列化后再解析不会因为默认字段补齐而产生两套对象形态。
 */
function createCompatibleSceneObjects(
  objects: readonly SceneObjectDraft[] | undefined,
): SceneObject[] {
  const nextOrderByLayer = new Map<string, number>()

  return (objects ?? []).map((object) => {
    const normalized = applySceneObjectCompatibilityDefaults(object)
    /**
     * 创建与解析边界统一补齐同组顺序。显式 order 原样保留并推进计数器；缺失时按输入顺序生成，
     * 使新建场景、导入场景和序列化恢复最终都进入同一份稳定字段协议。
     */
    // 有父节点时顺序属于兄弟集合，图层只管理根节点的排序。
    const layerKey = normalized.parentInstanceId ? 'parent:' + normalized.parentInstanceId : 'layer:' + (normalized.layerId || '__root__')
    const nextOrder = nextOrderByLayer.get(layerKey) ?? 0
    const order =
      Number.isInteger(normalized.order) && normalized.order! >= 0 ? normalized.order! : nextOrder
    nextOrderByLayer.set(layerKey, Math.max(nextOrder, order + 1))
    return { ...normalized, order } as SceneObject
  })
}

type SceneLayerDraft = Partial<SceneLayer>

/**
 * 记录 SceneLayer 第一版的兼容默认值。
 * 旧图层可能缺少 visible/locked/order/metadata 等可安全补齐字段；
 * id/name/type 会影响图层映射，缺失时仍由校验失败处理。
 */
function applySceneLayerCompatibilityDefaults(layer: unknown): SceneLayerDraft {
  if (!isRecordLike(layer)) {
    return {}
  }

  const sceneLayer = layer as SceneLayerDraft
  return {
    ...sceneLayer,
    visible: sceneLayer.visible ?? true,
    locked: sceneLayer.locked ?? false,
    order: sceneLayer.order ?? 0,
    options: sceneLayer.options ?? {},
    metadata: sceneLayer.metadata ?? {},
  }
}

/**
 * 统一图层列表的兼容默认值。
 */
function createCompatibleSceneLayers(layers: readonly SceneLayerDraft[] | undefined): SceneLayer[] {
  return (layers ?? []).map((layer) => applySceneLayerCompatibilityDefaults(layer) as SceneLayer)
}

/**
 * 记录流式分组字段的第一版兼容默认值。
 * 这里仅补齐“可安全缺省”的集合字段与策略参数，其余关键语义仍由校验阶段兜底。
 */
function applyStreamingGroupCompatibilityDefaults(group: unknown): StreamingGroupDraft {
  if (!isRecordLike(group)) {
    return {}
  }

  const streamingGroup = group as StreamingGroupDraft
  return {
    ...streamingGroup,
  }
}

function createCompatibleStreamingGroups(groups: unknown): StreamingGroup[] | unknown {
  if (groups === undefined) {
    return []
  }

  // 显式传入的非数组必须保留到校验阶段，不能在兼容层转为空数组。
  // 这能避免错误配置被误判为“旧数据缺字段”并在下次保存时丢失。
  if (!Array.isArray(groups)) {
    return groups
  }

  return groups.map((group) => applyStreamingGroupCompatibilityDefaults(group) as StreamingGroup)
}

/**
 * 记录区块字段的第一版兼容默认值。
 * 旧数据若后续缺少 objectIds / assetIds / tags 这类集合字段，这里统一补齐为空数组，
 * 避免 Runtime 读取区块元数据时出现多套数据形态。
 */
function applySceneChunkCompatibilityDefaults(chunk: unknown): SceneChunkDraft {
  if (!isRecordLike(chunk)) {
    return {}
  }

  const sceneChunk = chunk as SceneChunkDraft
  return {
    ...sceneChunk,
    // 仅补齐缺失字段；null 等显式非法值需要继续交给校验层拒绝。
    objectIds: sceneChunk.objectIds === undefined ? [] : sceneChunk.objectIds,
    assetIds: sceneChunk.assetIds === undefined ? [] : sceneChunk.assetIds,
    tags: sceneChunk.tags === undefined ? [] : sceneChunk.tags,
  }
}

function createCompatibleSceneChunks(chunks: unknown): SceneChunk[] | unknown {
  if (chunks === undefined) {
    return []
  }

  // 与 groups 保持同一原则：只对真实数组补默认值，类型错误保留给统一校验输出。
  if (!Array.isArray(chunks)) {
    return chunks
  }

  return chunks.map((chunk) => applySceneChunkCompatibilityDefaults(chunk) as SceneChunk)
}

/**
 * 记录流式加载配置字段的第一版兼容默认值。
 * 这里把 chunks / groups 统一补齐为空数组，options 缺失则保持 undefined，
 * 这样旧场景仍可按“未启用流式加载”处理，而不是被强制写入默认策略。
 */
function applySceneStreamingCompatibilityDefaults(
  streaming: unknown,
): SceneStreamingConfigDraft | undefined {
  if (!isRecordLike(streaming)) {
    return undefined
  }

  const sceneStreaming = streaming as SceneStreamingConfigDraft
  return {
    ...sceneStreaming,
    chunks: createCompatibleSceneChunks(sceneStreaming.chunks),
    groups: createCompatibleStreamingGroups(sceneStreaming.groups),
  } as SceneStreamingConfigDraft
}

/**
 * 为历史路径补齐姿态来源的兼容默认值。
 *
 * 仅在字段完全缺失时补为 `keyframes`，非法值始终原样保留给后续校验报错；这样既不会改变旧场景的
 * 镜头表现，也不会静默吞掉损坏的持久化数据。转向时长同样只对缺失字段补默认值，null 或越界数值
 * 会原样交给校验。泛型返回原输入类型，便于解析与新场景创建复用同一边界。
 */
function applyCameraPathCompatibilityDefaults<T>(cameraPaths: T): T {
  if (!Array.isArray(cameraPaths)) return cameraPaths
  return cameraPaths.map((path) => {
    if (!isRecordLike(path)) return path
    const needsOrientationDefault = path.orientationMode === undefined
    const needsTurnDurationDefault = path.turnDurationMs === undefined
    const hasValidTurnDuration =
      typeof path.turnDurationMs === 'number' &&
      Number.isSafeInteger(path.turnDurationMs) &&
      path.turnDurationMs >= CAMERA_PATH_TURN_DURATION_RANGE.min &&
      path.turnDurationMs <= CAMERA_PATH_TURN_DURATION_RANGE.max &&
      path.turnDurationMs % CAMERA_PATH_TURN_DURATION_RANGE.step === 0
    const effectiveTurnDuration: number | undefined = needsTurnDurationDefault
      ? CAMERA_PATH_DEFAULT_TURN_DURATION_MS
      : hasValidTurnDuration
        ? (path.turnDurationMs as number)
        : undefined
    const waypoints = path.waypoints
    const lastWaypoint = Array.isArray(waypoints) ? waypoints[waypoints.length - 1] : undefined
    const lastWaypointTimeMs =
      isRecordLike(lastWaypoint) && typeof lastWaypoint.timeMs === 'number'
        ? lastWaypoint.timeMs
        : undefined
    /**
     * 旧路径把末点时间直接当成总时长；补齐转向字段后需要顺延总时长，才能让新播放器保留完整尾段。
     * 仅对有限、正数且转向值有效的路径做兼容调整，非法数据仍原样交给领域校验报错。
     */
    const minimumTotalDuration =
      effectiveTurnDuration !== undefined && lastWaypointTimeMs !== undefined
        ? getCameraPathMinimumTotalDurationMs(lastWaypointTimeMs, effectiveTurnDuration)
        : undefined
    const needsDurationCompatibility =
      minimumTotalDuration !== undefined &&
      typeof path.durationMs === 'number' &&
      Number.isFinite(path.durationMs) &&
      path.durationMs > 0 &&
      path.durationMs < minimumTotalDuration
    /** 所有字段均已满足新语义时直接复用原对象，避免解析阶段创建无意义副本。 */
    if (!needsOrientationDefault && !needsTurnDurationDefault && !needsDurationCompatibility)
      return path
    return {
      ...path,
      ...(needsOrientationDefault ? { orientationMode: 'keyframes' } : {}),
      ...(needsTurnDurationDefault ? { turnDurationMs: CAMERA_PATH_DEFAULT_TURN_DURATION_MS } : {}),
      ...(needsDurationCompatibility ? { durationMs: minimumTotalDuration } : {}),
    }
  }) as T
}

/**
 * 记录对象类字段的第一版兼容默认值。
 * 旧数据可能没有集合字段或 schemaVersion，这里只补“可安全补齐”的容器字段；
 * id/name/type/coordinateSystem 仍属于必填业务语义，缺失时交给校验失败，避免生成无法定位的场景。
 */
function applySceneDefinitionCompatibilityDefaults(
  scene: SceneDefinitionDraft,
): SceneDefinitionDraft {
  const compatibleObjects = Array.isArray(scene.objects)
    ? createCompatibleSceneObjects(scene.objects)
    : scene.objects

  const compatibleLayers = Array.isArray(scene.layers)
    ? createCompatibleSceneLayers(scene.layers)
    : scene.layers
  const compatibleEffects = Array.isArray(scene.effects)
    ? scene.effects
        .filter((effect) => !isRemovedLegacyWeatherEffect(effect))
        .map((effect) => normalizeWeatherV2Effect(effect as SceneDefinition['effects'][number]))
    : scene.effects

  /**
   * 仅把“字段缺失”视为旧场景未启用流式加载。
   * 已提供但不是普通对象的值必须保留到校验阶段报错，不能静默清空；
   * 否则下一次保存会永久丢失坏数据，且调用方无法得知输入格式异常。
   */
  const compatibleStreaming =
    scene.streaming === undefined
      ? undefined
      : isRecordLike(scene.streaming)
        ? applySceneStreamingCompatibilityDefaults(scene.streaming)
        : scene.streaming

  /**
   * 植被协议有独立版本与默认值，但旧场景缺失该字段时必须保持 undefined。
   * 只有已提供的植被普通数据才进入归一化；非法值原样交给领域校验，避免损坏配置被静默吞掉。
   */
  const compatibleVegetation =
    scene.vegetation === undefined
      ? undefined
      : normalizeVegetationSystemDefinition(scene.vegetation)

  return {
    ...scene,
    objects: compatibleObjects ?? [],
    streaming: compatibleStreaming,
    layers: compatibleLayers ?? [],
    effects: compatibleEffects ?? [],
    settings: scene.settings ?? {},
    metadata: scene.metadata ?? {},
    cameraPaths:
      scene.cameraPaths === undefined
        ? []
        : applyCameraPathCompatibilityDefaults(scene.cameraPaths),
    vegetation: compatibleVegetation,
    // 只有字段真正缺失时才补当前版本；null、字符串等非法值应由校验明确拒绝。
    schemaVersion:
      scene.schemaVersion === undefined ? CURRENT_SCENE_SCHEMA_VERSION : scene.schemaVersion,
  }
}

/**
 * 清理流式区块中已经不存在的场景对象引用。
 *
 * 对象删除和旧版本数据迁移都可能先移除 SceneObject，再遗留其自动区块索引；如果这类 JSON
 * 直接进入严格校验，加载会在 Runtime 建立区块索引前失败。这里仅处理“对象编号已不存在”这一
 * 可安全判定的兼容问题：混合区块保留仍存在的编号，全部失效的区块移除；区块其它字段和
 * 非字符串的非法值不静默改写，继续交给领域校验报告。返回原引用表示没有发生任何修复，便于
 * Store 和保存适配器在高频路径避免无意义的场景对象分配。
 */
export function pruneSceneStreamingChunkObjectReferences(
  scene: Pick<SceneDefinition, 'id' | 'objects' | 'streaming'>,
): SceneStreamingConfig | undefined {
  const streaming = scene.streaming
  if (!isRecordLike(streaming) || !Array.isArray(streaming.chunks)) {
    return streaming
  }

  const knownObjectIds = new Set(
    (Array.isArray(scene.objects) ? scene.objects : [])
      .map((object) => (isRecordLike(object) ? object.id : undefined))
      .filter((id): id is string => isNonEmptyString(id)),
  )

  let hasChanges = false
  const chunks = streaming.chunks.flatMap((chunk) => {
    // 非普通对象或非数组 objectIds 必须原样保留，让 validateSceneDefinition 给出明确错误。
    if (!isRecordLike(chunk) || !Array.isArray(chunk.objectIds)) return [chunk]

    const objectIds = chunk.objectIds
    const nextObjectIds = objectIds.filter(
      (objectId) => typeof objectId !== 'string' || knownObjectIds.has(objectId),
    )
    if (nextObjectIds.length === objectIds.length) return [chunk]

    hasChanges = true
    // 只有原区块确实包含对象编号且全部编号失效时才移除；空区块仍可作为手工/引擎元数据保留。
    if (objectIds.length > 0 && nextObjectIds.length === 0) return []
    return [{ ...chunk, objectIds: nextObjectIds }]
  })

  if (!hasChanges) return streaming
  return { ...streaming, chunks } as SceneStreamingConfig
}

/**
 * 创建一个最小 SceneDefinition。
 * 注意：这里只做结构初始化，不做深度校验。
 */
export function createSceneDefinition(input: CreateSceneDefinitionInput): SceneDefinition {
  return {
    id: input.id,
    name: input.name,
    type: input.type,
    coordinateSystem: input.coordinateSystem,
    objects: createCompatibleSceneObjects(input.objects),
    streaming: input.streaming
      ? (applySceneStreamingCompatibilityDefaults(input.streaming) as SceneStreamingConfig)
      : undefined,
    layers: createCompatibleSceneLayers(input.layers),
    effects: input.effects ?? [],
    settings: input.settings ?? {},
    metadata: input.metadata ?? {},
    cameraPaths: applyCameraPathCompatibilityDefaults(input.cameraPaths ?? []),
    vegetation:
      input.vegetation === undefined
        ? undefined
        : (normalizeVegetationSystemDefinition(input.vegetation) as SceneDefinition['vegetation']),
    schemaVersion: CURRENT_SCENE_SCHEMA_VERSION,
  }
}

/**
 * 校验可持久化模型多细节层次（LOD）变体。
 *
 * 根 AssetRef 代表近距离细节层级 0，因此每个低细节变体都必须从大于 0 的距离开始，且数组严格
 * 升序。这个约束让 Runtime 恢复场景时不必重新排序、去重或猜测交叠区间，只需在受控相机刷新中
 * 从后向前寻找第一个满足条件的变体即可。
 */
function validateModelLodVariants(assetRef: AssetRefDraft, prefix: string, issues: string[]) {
  const variants = assetRef.modelLodVariants
  if (variants === undefined) return

  if (!Array.isArray(variants) || variants.length === 0) {
    issues.push(`${prefix} modelLodVariants must be a non-empty array when provided.`)
    return
  }

  if (!isModelAssetKind(assetRef.kind)) {
    issues.push(`${prefix} modelLodVariants are only supported by glb or gltf assets.`)
  }

  const variantIds = new Set<string>()
  let previousMinimumDistance = 0

  variants.forEach((variant, index) => {
    const variantPrefix = `${prefix} modelLodVariants[${index}]`
    if (!isRecordLike(variant)) {
      issues.push(`${variantPrefix} must be a plain object.`)
      return
    }

    const lodVariant = variant as ModelLodVariantDraft
    if (!isNonEmptyString(lodVariant.id)) {
      issues.push(`${variantPrefix} id is required.`)
    } else {
      if (lodVariant.id === assetRef.id) {
        issues.push(`${variantPrefix} id must differ from the root asset id.`)
      }
      if (variantIds.has(lodVariant.id)) {
        issues.push(`${variantPrefix} id must be unique within modelLodVariants.`)
      }
      variantIds.add(lodVariant.id)
    }

    if (!isModelAssetKind(lodVariant.kind)) {
      issues.push(`${variantPrefix} kind must be glb or gltf.`)
    }

    if (!isNonEmptyString(lodVariant.url)) {
      issues.push(`${variantPrefix} url is required.`)
    }

    if (lodVariant.version !== undefined && typeof lodVariant.version !== 'string') {
      issues.push(`${variantPrefix} version must be a string when provided.`)
    }

    if (lodVariant.hash !== undefined && typeof lodVariant.hash !== 'string') {
      issues.push(`${variantPrefix} hash must be a string when provided.`)
    }

    if (!isFiniteNumber(lodVariant.minimumDistance) || lodVariant.minimumDistance <= 0) {
      issues.push(`${variantPrefix} minimumDistance must be a positive finite number.`)
    } else if (lodVariant.minimumDistance <= previousMinimumDistance) {
      issues.push(`${variantPrefix} minimumDistance must be strictly ascending.`)
    } else {
      previousMinimumDistance = lodVariant.minimumDistance
    }

    if (
      lodVariant.maximumScreenSpaceRatio !== undefined &&
      (!isFiniteNumber(lodVariant.maximumScreenSpaceRatio) ||
        lodVariant.maximumScreenSpaceRatio <= 0 ||
        lodVariant.maximumScreenSpaceRatio > 1)
    ) {
      issues.push(`${variantPrefix} maximumScreenSpaceRatio must be within (0, 1].`)
    }
  })
}

/**
 * 校验模型材质档案。
 *
 * 档案只允许表达可序列化的“材质意图”和派生资产定位信息；解析出的贴图、Three Material、Cesium Model
 * 等运行时对象仍必须留在各自 Runtime，不能借由 `materialProfile` 绕过场景数据边界。
 */
function validateModelMaterialProfile(assetRef: AssetRefDraft, prefix: string, issues: string[]) {
  const profile = assetRef.materialProfile
  if (profile === undefined) return

  if (!isModelAssetKind(assetRef.kind)) {
    issues.push(`${prefix} materialProfile is only supported by glb or gltf assets.`)
  }
  if (!isRecordLike(profile)) {
    issues.push(`${prefix} materialProfile must be a plain object when provided.`)
    return
  }

  const draft = profile as ModelMaterialProfileDraft
  if (draft.version !== 1) {
    issues.push(`${prefix} materialProfile version must be 1.`)
  }
  if (
    draft.state !== 'ready' &&
    draft.state !== 'needs-confirmation' &&
    draft.state !== 'unavailable'
  ) {
    issues.push(`${prefix} materialProfile state is invalid.`)
  }
  if (!Array.isArray(draft.rules)) {
    issues.push(`${prefix} materialProfile rules must be an array.`)
  } else {
    draft.rules.forEach((rule, index) => {
      const rulePrefix = `${prefix} materialProfile rules[${index}]`
      if (!isRecordLike(rule)) {
        issues.push(`${rulePrefix} must be a plain object.`)
        return
      }
      const materialRule = rule as ModelMaterialRuleDraft
      const selector = materialRule.selector
      if (!isRecordLike(selector)) {
        issues.push(`${rulePrefix} selector must be a plain object.`)
      } else {
        const materialIndex = selector.materialIndex
        const materialName = selector.materialName
        const hasIndex = Number.isInteger(materialIndex) && (materialIndex as number) >= 0
        const hasName = isNonEmptyString(materialName)
        if (!hasIndex && !hasName) {
          issues.push(`${rulePrefix} selector requires materialIndex or materialName.`)
        }
      }
      if (
        materialRule.alphaMode !== 'opaque' &&
        materialRule.alphaMode !== 'mask' &&
        materialRule.alphaMode !== 'blend'
      ) {
        issues.push(`${rulePrefix} alphaMode is invalid.`)
      }
      if (
        materialRule.source !== 'declared' &&
        materialRule.source !== 'detected' &&
        materialRule.source !== 'manual'
      ) {
        issues.push(`${rulePrefix} source is invalid.`)
      }
      if (
        materialRule.alphaCutoff !== undefined &&
        (!isFiniteNumber(materialRule.alphaCutoff) ||
          materialRule.alphaCutoff < 0 ||
          materialRule.alphaCutoff > 1)
      ) {
        issues.push(`${rulePrefix} alphaCutoff must be within [0, 1].`)
      }
      if (materialRule.doubleSided !== undefined && typeof materialRule.doubleSided !== 'boolean') {
        issues.push(`${rulePrefix} doubleSided must be a boolean when provided.`)
      }
    })
  }

  const derivedAsset = draft.derivedAsset
  if (derivedAsset !== undefined) {
    if (!isRecordLike(derivedAsset) || !isNonEmptyString(derivedAsset.url)) {
      issues.push(`${prefix} materialProfile derivedAsset url is required when provided.`)
    } else {
      if (derivedAsset.version !== undefined && typeof derivedAsset.version !== 'string') {
        issues.push(
          `${prefix} materialProfile derivedAsset version must be a string when provided.`,
        )
      }
      if (derivedAsset.hash !== undefined && typeof derivedAsset.hash !== 'string') {
        issues.push(`${prefix} materialProfile derivedAsset hash must be a string when provided.`)
      }
    }
  }
}

/**
 * 校验 AssetRef 的字段边界。
 * 资产引用必须只携带 id、kind、url、可选的低细节变体等纯数据，禁止把已加载的纹理、材质、模型或
 * 引擎对象放入场景快照。
 */
function validateAssetRef(asset: unknown, prefix: string, issues: string[]) {
  if (!isRecordLike(asset)) {
    issues.push(`${prefix} must be a plain object when provided.`)
    return
  }

  const assetRef = asset as AssetRefDraft

  if (!isNonEmptyString(assetRef.id)) {
    issues.push(`${prefix} id is required.`)
  }

  if (!isSupportedAssetKind(assetRef.kind)) {
    issues.push(`${prefix} kind must be a supported asset kind.`)
  }

  if (!isNonEmptyString(assetRef.url)) {
    issues.push(`${prefix} url is required.`)
  }

  if (assetRef.version !== undefined && typeof assetRef.version !== 'string') {
    issues.push(`${prefix} version must be a string when provided.`)
  }

  if (assetRef.hash !== undefined && typeof assetRef.hash !== 'string') {
    issues.push(`${prefix} hash must be a string when provided.`)
  }

  if (assetRef.metadata !== undefined && !isRecordLike(assetRef.metadata)) {
    issues.push(`${prefix} metadata must be a plain object when provided.`)
    return
  }

  if (assetRef.metadata !== undefined && !isSerializableMetadataValue(assetRef.metadata)) {
    issues.push(`${prefix} metadata must be serializable plain data.`)
  }

  validateModelLodVariants(assetRef, prefix, issues)
  validateModelMaterialProfile(assetRef, prefix, issues)
}

/**
 * 校验 SceneObject 第一版字段边界。
 * 这里同时调用 AssetRef 字段校验，确保对象挂载的资产引用仍然是纯领域数据。
 */
function validateSceneObject(
  object: SceneObjectDraft,
  objectIndex: number,
  sceneType: SceneType | undefined,
  issues: string[],
) {
  const prefix = `Scene object at index ${objectIndex}`

  if (!object.id) {
    issues.push(`${prefix} id is required.`)
  }

  if (!object.name) {
    issues.push(`${prefix} name is required.`)
  }

  if (!isSupportedSceneObjectType(object.type)) {
    issues.push(`${prefix} type must be a supported scene object type.`)
  }

  if (typeof object.visible !== 'boolean') {
    issues.push(`${prefix} visible must be a boolean.`)
  }

  if (typeof object.locked !== 'boolean') {
    issues.push(`${prefix} locked must be a boolean.`)
  }

  if (!Number.isInteger(object.order) || object.order! < 0) {
    issues.push(`${prefix} order must be a non-negative integer.`)
  }

  if (object.layerId !== undefined && !isNonEmptyString(object.layerId)) {
    issues.push(`${prefix} layerId must be a non-empty string when provided.`)
  }

  if (!object.transform || !isRecordLike(object.transform)) {
    issues.push(`${prefix} transform is required.`)
    return
  }

  /**
   * 局部姿态四元数是 GIS Gizmo 的可选连续旋转快照。
   * 历史场景没有该字段仍由 heading / pitch / roll 兼容恢复；一旦提供则必须是有限、非零的四元组，
   * 否则 Runtime 无法安全归一化，可能在下一次局部轴旋转时把无效姿态传播到模型和辅助器。
   */
  if (object.transform.kind === 'geo') {
    const orientationQuaternion = object.transform.orientationQuaternion
    if (orientationQuaternion !== undefined) {
      const isQuaternionTuple =
        Array.isArray(orientationQuaternion) &&
        orientationQuaternion.length === 4 &&
        orientationQuaternion.every(
          (component) => typeof component === 'number' && Number.isFinite(component),
        )
      const quaternionLength = isQuaternionTuple ? Math.hypot(...orientationQuaternion) : 0
      if (!isQuaternionTuple || quaternionLength <= Number.EPSILON) {
        issues.push(
          `${prefix} geo transform orientationQuaternion must be a finite non-zero [x, y, z, w] tuple when provided.`,
        )
      }
    }
  }

  if (object.asset !== undefined) {
    validateAssetRef(object.asset, `${prefix} asset`, issues)
  }

  if (object.type === 'light') {
    const light = object.light
    if (!light || (light.kind !== 'point' && light.kind !== 'spot')) {
      issues.push(`${prefix} light kind must be point or spot.`)
    } else {
      if (!/^#[0-9a-fA-F]{6}$/.test(light.color)) {
        issues.push(`${prefix} light color must be a six-digit hex color.`)
      }
      if (!Number.isFinite(light.intensity) || light.intensity < 0 || light.intensity > 100) {
        issues.push(`${prefix} light intensity must be between 0 and 100.`)
      }
      if (!Number.isFinite(light.range) || light.range <= 0 || light.range > 1000) {
        issues.push(`${prefix} light range must be between 0 and 1000 meters.`)
      }
      if (light.shadows !== undefined && typeof light.shadows !== 'boolean') {
        issues.push(`${prefix} light shadows must be a boolean.`)
      }
      if (light.kind === 'spot') {
        if (
          !Number.isFinite(light.innerConeAngle) ||
          !Number.isFinite(light.outerConeAngle) ||
          light.innerConeAngle! < 0 ||
          light.outerConeAngle! > Math.PI / 2 ||
          light.innerConeAngle! >= light.outerConeAngle!
        ) {
          issues.push(`${prefix} spotlight cone angles must satisfy 0 <= inner < outer <= π/2.`)
        }
      }
    }
  }

  if (object.type === 'camera') {
    if (object.firstPerson !== undefined && !isValidFirstPersonConfig(object.firstPerson)) {
      issues.push(`${prefix} firstPerson must be a valid first-person camera configuration.`)
    }
  } else if (object.firstPerson !== undefined) {
    issues.push(`${prefix} firstPerson is only valid for camera objects.`)
  }

  if (object.style !== undefined && !isRecordLike(object.style)) {
    issues.push(`${prefix} style must be a plain object when provided.`)
  }

  if (object.metadata !== undefined && !isRecordLike(object.metadata)) {
    issues.push(`${prefix} metadata must be a plain object when provided.`)
  }

  if (object.type === 'effect') {
    if (!object.effect || !isRecordLike(object.effect)) {
      issues.push(`${prefix} effect is required for effect objects.`)
    } else {
      issues.push(...validateThreeMapEffectSpec(object.effect as EffectSpec, `${prefix} effect`))
      issues.push(...validateVolumeHeatmapEffectSpec(object.effect as EffectSpec, `${prefix} effect`))
    }
  }

  if (sceneType === 'gis' && object.transform.kind !== 'geo') {
    issues.push('GIS scene objects must use geo transforms.')
  }

  if (sceneType === 'local3d' && object.transform.kind !== 'local') {
    issues.push('Local 3D scene objects must use local transforms.')
  }
}

/**
 * 校验 SceneLayer 第一版字段边界。
 * GIS 数据源图层（imagery/terrain/tileset/vector）可携带 provider/url/asset/options；
 * 校验只保证字段类型和可序列化性，不校验供应商参数语义。
 */
function validateSceneLayer(layer: SceneLayerDraft, layerIndex: number, issues: string[]) {
  const prefix = `Scene layer at index ${layerIndex}`

  if (!isNonEmptyString(layer.id)) {
    issues.push(`${prefix} id is required.`)
  }

  if (!isNonEmptyString(layer.name)) {
    issues.push(`${prefix} name is required.`)
  }

  if (!isSupportedLayerType(layer.type)) {
    issues.push(`${prefix} type must be a supported layer type.`)
  }

  if (typeof layer.visible !== 'boolean') {
    issues.push(`${prefix} visible must be a boolean.`)
  }

  if (typeof layer.locked !== 'boolean') {
    issues.push(`${prefix} locked must be a boolean.`)
  }

  if (typeof layer.order !== 'number' || !Number.isFinite(layer.order)) {
    issues.push(`${prefix} order must be a finite number.`)
  }

  if (layer.type === 'object' && (!Number.isInteger(layer.order) || layer.order! < 0)) {
    issues.push(`${prefix} object layer order must be a non-negative integer.`)
  }

  if (layer.opacity !== undefined) {
    if (typeof layer.opacity !== 'number' || !Number.isFinite(layer.opacity)) {
      issues.push(`${prefix} opacity must be a finite number when provided.`)
    }
  }

  // GIS 数据源字段校验
  if (isGisDataLayerType(layer.type)) {
    if (!isSupportedGisLayerProvider(layer.provider)) {
      issues.push(`${prefix} provider is required for GIS data layers.`)
    }

    const localTileId = isRecordLike(layer.metadata) ? layer.metadata.tileId : undefined
    /**
     * 历史四包曾遗漏本地 GIS 图层地址，但仍保留了后端稳定切片编号。
     * 该编号允许编辑器在领域解析后查询 GIS 列表并补回当前服务地址；其它提供者仍必须携带 URL 或资产。
     */
    const hasRecoverableLocalTileReference =
      layer.provider === 'local' &&
      ((typeof localTileId === 'string' && localTileId.trim().length > 0) ||
        (typeof localTileId === 'number' && Number.isFinite(localTileId)))

    if (!layer.url && !layer.asset && !hasRecoverableLocalTileReference) {
      issues.push(`${prefix} url or asset is required for GIS data layers.`)
    }
  }

  if (layer.provider !== undefined && !isSupportedGisLayerProvider(layer.provider)) {
    issues.push(`${prefix} provider must be a supported GIS layer provider when provided.`)
  }

  if (layer.url !== undefined && !isNonEmptyString(layer.url)) {
    issues.push(`${prefix} url must be a non-empty string when provided.`)
  }

  if (layer.asset !== undefined) {
    validateAssetRef(layer.asset, `${prefix} asset`, issues)
  }

  if (layer.options !== undefined && !isRecordLike(layer.options)) {
    issues.push(`${prefix} options must be a plain object when provided.`)
    return
  }

  if (layer.options !== undefined && !isSerializableMetadataValue(layer.options)) {
    issues.push(`${prefix} options must be serializable plain data.`)
  }

  if (layer.metadata !== undefined && !isRecordLike(layer.metadata)) {
    issues.push(`${prefix} metadata must be a plain object when provided.`)
    return
  }

  if (layer.metadata !== undefined && !isSerializableMetadataValue(layer.metadata)) {
    issues.push(`${prefix} metadata must be serializable plain data.`)
  }
}

function validateBoundingVolume(
  bounds: Partial<BoundingVolume> | undefined,
  prefix: string,
  issues: string[],
) {
  if (!bounds || !isRecordLike(bounds)) {
    issues.push(`${prefix} bounds is required.`)
    return
  }

  if (bounds.type === 'sphere') {
    if (!isNumberTuple3(bounds.center)) {
      issues.push(`${prefix} sphere center must be a tuple of 3 finite numbers.`)
    }

    if (!isNonNegativeFiniteNumber(bounds.radius)) {
      issues.push(`${prefix} sphere radius must be a non-negative finite number.`)
    }

    return
  }

  if (bounds.type === 'aabb') {
    if (!isNumberTuple3(bounds.min)) {
      issues.push(`${prefix} aabb min must be a tuple of 3 finite numbers.`)
    }

    if (!isNumberTuple3(bounds.max)) {
      issues.push(`${prefix} aabb max must be a tuple of 3 finite numbers.`)
    }

    // AABB 的每个最小坐标都必须不大于对应最大坐标，
    // 否则后续 Three Box3 / 视锥求交会得到反向或空的空间范围。
    if (
      isNumberTuple3(bounds.min) &&
      isNumberTuple3(bounds.max) &&
      (bounds.min[0] > bounds.max[0] ||
        bounds.min[1] > bounds.max[1] ||
        bounds.min[2] > bounds.max[2])
    ) {
      issues.push(`${prefix} aabb min must not exceed max on any axis.`)
    }

    return
  }

  if (bounds.type === 'region') {
    if (!isFiniteNumber(bounds.west)) {
      issues.push(`${prefix} region west must be a finite number.`)
    }

    if (!isFiniteNumber(bounds.south)) {
      issues.push(`${prefix} region south must be a finite number.`)
    }

    if (!isFiniteNumber(bounds.east)) {
      issues.push(`${prefix} region east must be a finite number.`)
    }

    if (!isFiniteNumber(bounds.north)) {
      issues.push(`${prefix} region north must be a finite number.`)
    }

    if (bounds.minHeight !== undefined && !isFiniteNumber(bounds.minHeight)) {
      issues.push(`${prefix} region minHeight must be a finite number when provided.`)
    }

    if (bounds.maxHeight !== undefined && !isFiniteNumber(bounds.maxHeight)) {
      issues.push(`${prefix} region maxHeight must be a finite number when provided.`)
    }

    // region 的经度允许跨日期变更线，因此不强制 west <= east；
    // 纬度和高度没有该语义，必须保持从小到大的有效范围。
    if (
      isFiniteNumber(bounds.south) &&
      isFiniteNumber(bounds.north) &&
      bounds.south > bounds.north
    ) {
      issues.push(`${prefix} region south must not exceed north.`)
    }

    if (
      isFiniteNumber(bounds.minHeight) &&
      isFiniteNumber(bounds.maxHeight) &&
      bounds.minHeight > bounds.maxHeight
    ) {
      issues.push(`${prefix} region minHeight must not exceed maxHeight.`)
    }

    return
  }

  issues.push(`${prefix} bounds type must be sphere, aabb or region.`)
}

function validateSceneChunk(chunk: SceneChunkDraft, chunkIndex: number, issues: string[]) {
  const prefix = `Scene streaming chunk at index ${chunkIndex}`

  if (!isNonEmptyString(chunk.id)) {
    issues.push(`${prefix} id is required.`)
  }

  if (!isNonEmptyString(chunk.sceneId)) {
    issues.push(`${prefix} sceneId is required.`)
  }

  validateBoundingVolume(chunk.bounds as Partial<BoundingVolume> | undefined, prefix, issues)

  if (!isStringArray(chunk.objectIds)) {
    issues.push(`${prefix} objectIds must be an array of non-empty strings.`)
  }

  if (!isStringArray(chunk.assetIds)) {
    issues.push(`${prefix} assetIds must be an array of non-empty strings.`)
  }

  // 同一区块重复引用同一对象或资产会导致后续对象映射、引用计数和缓存预算被重复累计。
  // 在领域层拒绝重复值，避免 Runtime 额外承担数据去重和错误恢复职责。
  if (isStringArray(chunk.objectIds) && new Set(chunk.objectIds).size !== chunk.objectIds.length) {
    issues.push(`${prefix} objectIds must not contain duplicate ids.`)
  }

  if (isStringArray(chunk.assetIds) && new Set(chunk.assetIds).size !== chunk.assetIds.length) {
    issues.push(`${prefix} assetIds must not contain duplicate ids.`)
  }

  if (chunk.streamingGroupId !== undefined && !isNonEmptyString(chunk.streamingGroupId)) {
    issues.push(`${prefix} streamingGroupId must be a non-empty string when provided.`)
  }

  if (chunk.lodLevel !== undefined && !isNonNegativeSafeInteger(chunk.lodLevel)) {
    issues.push(`${prefix} lodLevel must be a non-negative safe integer when provided.`)
  }

  if (chunk.priority !== undefined && !isFiniteNumber(chunk.priority)) {
    issues.push(`${prefix} priority must be a finite number when provided.`)
  }

  if (chunk.tags !== undefined && !isStringArray(chunk.tags)) {
    issues.push(`${prefix} tags must be an array of non-empty strings when provided.`)
  }
}

function validateStreamingGroup(group: StreamingGroupDraft, groupIndex: number, issues: string[]) {
  const prefix = `Scene streaming group at index ${groupIndex}`

  if (!isNonEmptyString(group.id)) {
    issues.push(`${prefix} id is required.`)
  }

  if (
    group.mode !== 'near-camera' &&
    group.mode !== 'always-loaded' &&
    group.mode !== 'manual' &&
    group.mode !== 'engine-native'
  ) {
    issues.push(`${prefix} mode must be near-camera, always-loaded, manual or engine-native.`)
  }

  if (group.preloadRadius !== undefined && !isNonNegativeFiniteNumber(group.preloadRadius)) {
    issues.push(`${prefix} preloadRadius must be a non-negative finite number when provided.`)
  }

  if (group.visibleRadius !== undefined && !isNonNegativeFiniteNumber(group.visibleRadius)) {
    issues.push(`${prefix} visibleRadius must be a non-negative finite number when provided.`)
  }

  if (group.unloadRadius !== undefined && !isNonNegativeFiniteNumber(group.unloadRadius)) {
    issues.push(`${prefix} unloadRadius must be a non-negative finite number when provided.`)
  }

  // 当前第一期不为 near-camera 隐式猜测距离默认值。
  // 三个半径必须一起持久化，才能让 Three / Cesium Runtime 使用同一份可解释的调度策略。
  if (
    group.mode === 'near-camera' &&
    (group.preloadRadius === undefined ||
      group.visibleRadius === undefined ||
      group.unloadRadius === undefined)
  ) {
    issues.push(
      `${prefix} near-camera mode requires preloadRadius, visibleRadius and unloadRadius.`,
    )
  }

  if (group.maxLoadedChunks !== undefined && !isNonNegativeSafeInteger(group.maxLoadedChunks)) {
    issues.push(`${prefix} maxLoadedChunks must be a non-negative safe integer when provided.`)
  }

  if (group.memoryBudgetMB !== undefined && !isNonNegativeFiniteNumber(group.memoryBudgetMB)) {
    issues.push(`${prefix} memoryBudgetMB must be a non-negative finite number when provided.`)
  }

  if (group.priority !== undefined && !isFiniteNumber(group.priority)) {
    issues.push(`${prefix} priority must be a finite number when provided.`)
  }

  // 三半径形成加载、可见和卸载的滞回区间，
  // 关系反转会导致区块在相机边界附近反复加载和卸载。
  if (
    isNonNegativeFiniteNumber(group.preloadRadius) &&
    isNonNegativeFiniteNumber(group.visibleRadius) &&
    group.preloadRadius < group.visibleRadius
  ) {
    issues.push(`${prefix} preloadRadius must be greater than or equal to visibleRadius.`)
  }

  if (
    isNonNegativeFiniteNumber(group.unloadRadius) &&
    isNonNegativeFiniteNumber(group.preloadRadius) &&
    group.unloadRadius <= group.preloadRadius
  ) {
    issues.push(`${prefix} unloadRadius must be greater than preloadRadius.`)
  }
}

function validateRuntimeStreamingOptions(
  options: RuntimeStreamingOptionsDraft | undefined,
  issues: string[],
  label = 'Scene streaming options',
  requireEnabled = true,
) {
  if (options === undefined) {
    return
  }

  if (!isRecordLike(options)) {
    issues.push(`${label} must be a plain object when provided.`)
    return
  }

  if (requireEnabled && typeof options.enabled !== 'boolean') {
    issues.push(`${label} enabled must be a boolean.`)
  } else if (
    !requireEnabled &&
    options.enabled !== undefined &&
    typeof options.enabled !== 'boolean'
  ) {
    issues.push(`${label} enabled must be a boolean when provided.`)
  }

  if (options.targetFps !== undefined && !isNonNegativeFiniteNumber(options.targetFps)) {
    issues.push(`${label} targetFps must be a non-negative finite number when provided.`)
  }

  if (options.maxLoadingJobs !== undefined && !isNonNegativeSafeInteger(options.maxLoadingJobs)) {
    issues.push(`${label} maxLoadingJobs must be a non-negative safe integer when provided.`)
  }

  if (options.maxLoadedChunks !== undefined && !isNonNegativeSafeInteger(options.maxLoadedChunks)) {
    issues.push(`${label} maxLoadedChunks must be a non-negative safe integer when provided.`)
  }

  if (options.memoryBudgetMB !== undefined && !isNonNegativeFiniteNumber(options.memoryBudgetMB)) {
    issues.push(`${label} memoryBudgetMB must be a non-negative finite number when provided.`)
  }

  if (options.unloadDelayMs !== undefined && !isNonNegativeFiniteNumber(options.unloadDelayMs)) {
    issues.push(`${label} unloadDelayMs must be a non-negative finite number when provided.`)
  }

  if (options.hysteresis !== undefined && !isNonNegativeFiniteNumber(options.hysteresis)) {
    issues.push(`${label} hysteresis must be a non-negative finite number when provided.`)
  }
}

/**
 * 校验编辑器／预览覆盖层。
 *
 * 区块、分组和对象归属始终是同一份场景空间索引，只有资源调度预算允许按运行态变化；
 * 因而这里明确拒绝未知上下文和非对象值，避免 JSON 拼写错误静默失效。
 */
function validateSceneStreamingRuntimeOverrides(
  overrides: SceneStreamingRuntimeOverridesDraft | undefined,
  issues: string[],
) {
  if (overrides === undefined) return

  if (!isRecordLike(overrides)) {
    issues.push('Scene streaming runtimeOverrides must be a plain object when provided.')
    return
  }

  const supportedContexts: SceneStreamingRuntimeContext[] = ['editor', 'preview']
  for (const context of supportedContexts) {
    validateRuntimeStreamingOptions(
      overrides[context],
      issues,
      `Scene streaming runtimeOverrides ${context}`,
      false,
    )
  }

  for (const key of Object.keys(overrides)) {
    if (!supportedContexts.includes(key as SceneStreamingRuntimeContext)) {
      issues.push('Scene streaming runtimeOverrides only supports editor or preview keys.')
      break
    }
  }
}

function validateSceneStreaming(
  streaming: SceneStreamingConfigDraft | undefined,
  sceneId: string | undefined,
  objects: readonly SceneObjectDraft[] | undefined,
  issues: string[],
) {
  if (streaming === undefined) {
    return
  }

  if (!isRecordLike(streaming)) {
    issues.push('Scene definition streaming must be a plain object when provided.')
    return
  }

  if (!Array.isArray(streaming.chunks)) {
    issues.push('Scene definition streaming chunks must be an array.')
  }

  if (!Array.isArray(streaming.groups)) {
    issues.push('Scene definition streaming groups must be an array.')
  }

  const knownObjectIds = new Set(
    (Array.isArray(objects) ? objects : [])
      .map((object) => object.id)
      .filter((id): id is string => isNonEmptyString(id)),
  )
  const seenChunkIds = new Set<string>()
  const objectChunkAssignments = new Map<string, string>()
  for (const [index, chunk] of (Array.isArray(streaming.chunks)
    ? streaming.chunks
    : []
  ).entries()) {
    validateSceneChunk(chunk, index, issues)

    if (isNonEmptyString(chunk.id)) {
      if (seenChunkIds.has(chunk.id)) {
        issues.push(`Scene streaming chunk id "${chunk.id}" must be unique within a scene.`)
      } else {
        seenChunkIds.add(chunk.id)
      }
    }

    if (sceneId && isNonEmptyString(chunk.sceneId) && chunk.sceneId !== sceneId) {
      issues.push(`Scene streaming chunk "${chunk.id}" sceneId must match scene definition id.`)
    }

    if (Array.isArray(chunk.objectIds)) {
      for (const objectId of chunk.objectIds) {
        if (!knownObjectIds.has(objectId)) {
          issues.push(
            `Scene streaming chunk "${chunk.id}" references unknown scene object "${objectId}".`,
          )
          continue
        }

        const assignedChunkId = objectChunkAssignments.get(objectId)
        if (assignedChunkId && assignedChunkId !== chunk.id) {
          issues.push(
            `Scene object "${objectId}" can belong to only one streaming chunk, ` +
              `but is referenced by "${assignedChunkId}" and "${chunk.id}".`,
          )
          continue
        }

        if (isNonEmptyString(chunk.id)) {
          objectChunkAssignments.set(objectId, chunk.id)
        }
      }
    }
  }

  const seenGroupIds = new Set<string>()
  for (const [index, group] of (Array.isArray(streaming.groups)
    ? streaming.groups
    : []
  ).entries()) {
    validateStreamingGroup(group, index, issues)

    if (isNonEmptyString(group.id)) {
      if (seenGroupIds.has(group.id)) {
        issues.push(`Scene streaming group id "${group.id}" must be unique within a scene.`)
      } else {
        seenGroupIds.add(group.id)
      }
    }
  }

  for (const chunk of Array.isArray(streaming.chunks) ? streaming.chunks : []) {
    if (
      chunk.streamingGroupId !== undefined &&
      isNonEmptyString(chunk.streamingGroupId) &&
      !seenGroupIds.has(chunk.streamingGroupId)
    ) {
      issues.push(
        `Scene streaming chunk "${chunk.id}" references unknown streaming group "${chunk.streamingGroupId}".`,
      )
    }
  }

  validateRuntimeStreamingOptions(streaming.options, issues)
  validateSceneStreamingRuntimeOverrides(streaming.runtimeOverrides, issues)
}

/**
 * 校验场景特效的通用字段与天气规格。
 *
 * 流式配置和特效配置都属于可序列化领域数据，但两者分别服务于 Runtime 调度与效果适配：
 * 这里保持独立校验，避免天气参数异常掩盖区块索引问题，或反向耦合两条 Runtime 实现链路。
 */
function validateSceneEffect(effect: SceneEffectDraft, effectIndex: number, issues: string[]) {
  const prefix = `Scene effect at index ${effectIndex}`

  if (!isNonEmptyString(effect.id)) {
    issues.push(`${prefix} id is required.`)
  }

  if (!SUPPORTED_EFFECT_TYPES.has(effect.type as SceneDefinition['effects'][number]['type'])) {
    issues.push(`${prefix} type must be a supported effect type.`)
  }

  if (!isRecordLike(effect.params)) {
    issues.push(`${prefix} params must be a plain object.`)
    return
  }

  issues.push(...validateWeatherV2EffectSpec(effect as SceneDefinition['effects'][number], prefix))
  issues.push(...validateVolumeHeatmapEffectSpec(effect as SceneDefinition['effects'][number], prefix))
  issues.push(...validateThreeMapEffectSpec(effect as SceneDefinition['effects'][number], prefix))
}

/**
 * 领域校验。
 * 第一阶段先把最关键的字段完整性与 GIS / Local 边界校验收敛在这里，
 * 避免上层出现“引擎差异分裂”或把半结构化数据透传给 Runtime。
 */
export function validateSceneDefinition(scene: SceneDefinitionDraft): SceneValidationResult {
  const issues: string[] = []
  const hasSupportedType = scene.type === 'gis' || scene.type === 'local3d'

  if (!scene.id) {
    issues.push('Scene definition id is required.')
  }

  if (!scene.name) {
    issues.push('Scene definition name is required.')
  }

  if (!hasSupportedType) {
    issues.push('Scene definition type must be gis or local3d.')
  }

  if (!scene.coordinateSystem) {
    issues.push('Scene definition coordinate system is required.')
  }

  if (!Array.isArray(scene.objects)) {
    issues.push('Scene definition objects must be an array.')
  }

  if (!Array.isArray(scene.layers)) {
    issues.push('Scene definition layers must be an array.')
  }

  if (!Array.isArray(scene.effects)) {
    issues.push('Scene definition effects must be an array.')
  }

  if (!isRecordLike(scene.settings)) {
    issues.push('Scene definition settings must be a plain object.')
  }

  if (!isRecordLike(scene.metadata)) {
    issues.push('Scene definition metadata must be a plain object.')
  }

  if (typeof scene.schemaVersion !== 'number') {
    issues.push('Scene definition schemaVersion must be a number.')
  } else if (
    !Number.isInteger(scene.schemaVersion) ||
    scene.schemaVersion < MIN_SUPPORTED_SCENE_SCHEMA_VERSION
  ) {
    issues.push(
      [
        'Scene definition schemaVersion must be an integer greater than or equal to',
        `${MIN_SUPPORTED_SCENE_SCHEMA_VERSION}.`,
      ].join(' '),
    )
  } else if (scene.schemaVersion > CURRENT_SCENE_SCHEMA_VERSION) {
    issues.push(
      [
        `Scene definition schemaVersion ${scene.schemaVersion} is newer than supported version`,
        `${CURRENT_SCENE_SCHEMA_VERSION}.`,
      ].join(' '),
    )
  }

  if (scene.type === 'gis' && scene.coordinateSystem && scene.coordinateSystem.kind !== 'wgs84') {
    issues.push('GIS scene must use a wgs84 coordinate system.')
  }

  if (
    scene.type === 'local3d' &&
    scene.coordinateSystem &&
    scene.coordinateSystem.kind !== 'local'
  ) {
    issues.push('Local 3D scene must use a local coordinate system.')
  }

  const seenObjectIds = new Set<string>()
  for (const [index, object] of (Array.isArray(scene.objects) ? scene.objects : []).entries()) {
    validateSceneObject(object, index, scene.type, issues)
    if (!object.id) continue

    if (seenObjectIds.has(object.id)) {
      issues.push(`Scene object id "${object.id}" must be unique within a scene.`)
      continue
    }

    seenObjectIds.add(object.id)
  }

  const firstPersonObjects = (Array.isArray(scene.objects) ? scene.objects : []).filter(
    (object) => object.type === 'camera' && object.firstPerson !== undefined,
  )
  if (firstPersonObjects.length > 1) {
    issues.push('A scene can contain at most one first-person camera.')
  }

  validateSceneStreaming(scene.streaming, scene.id, scene.objects, issues)
  validateCameraPaths(scene.cameraPaths, scene.type, issues)
  if (scene.vegetation !== undefined) {
    issues.push(...validateVegetationSystemDefinition(scene.vegetation, scene.type).issues)
  }

  const seenLayerIds = new Set<string>()
  const layerById = new Map<string, SceneLayerDraft>()
  for (const [index, layer] of (Array.isArray(scene.layers) ? scene.layers : []).entries()) {
    validateSceneLayer(layer, index, issues)
    if (!layer.id) continue

    if (seenLayerIds.has(layer.id)) {
      issues.push(`Scene layer id "${layer.id}" must be unique within a scene.`)
      continue
    }

    seenLayerIds.add(layer.id)
    layerById.set(layer.id, layer)
  }

  /**
   * 对象分组关系必须在图层集合完整建索引后校验，避免对象声明顺序影响引用判断。
   * layerId 只允许指向 object 图层；GIS 数据图层不能被结构面板误当成对象分组。
   */
  const objectOrdersByLayer = new Map<string, number[]>()
  for (const object of Array.isArray(scene.objects) ? scene.objects : []) {
    if (isNonEmptyString(object.layerId)) {
      const targetLayer = layerById.get(object.layerId)
      if (!targetLayer) {
        issues.push(
          `Scene object "${object.id || '<unknown>'}" references unknown layer "${object.layerId}".`,
        )
      } else if (targetLayer.type !== 'object') {
        issues.push(
          `Scene object "${object.id || '<unknown>'}" layerId "${object.layerId}" must reference an object layer.`,
        )
      }
    }

    // 业务兄弟允许同值，使用实例编号打破平局。旧根级图层继续要求唯一顺序。
    if (!object.parentInstanceId && Number.isInteger(object.order) && object.order! >= 0) {
      const layerKey = isNonEmptyString(object.layerId) ? object.layerId : '__root__'
      const orders = objectOrdersByLayer.get(layerKey) ?? []
      orders.push(object.order!)
      objectOrdersByLayer.set(layerKey, orders)
    }
  }

  /** 同组 order 只要求唯一；允许接口保留编号空洞，下一次真实重排时再由 Store 连续归一化。 */
  objectOrdersByLayer.forEach((orders, layerKey) => {
    if (new Set(orders).size !== orders.length) {
      const label = layerKey === '__root__' ? 'root' : layerKey
      issues.push(`Scene object orders in layer "${label}" must be unique.`)
    }
  })

  const objectLayerOrders = (Array.isArray(scene.layers) ? scene.layers : [])
    .filter(
      (layer) => layer.type === 'object' && Number.isInteger(layer.order) && layer.order! >= 0,
    )
    .map((layer) => layer.order!)
  if (new Set(objectLayerOrders).size !== objectLayerOrders.length) {
    issues.push('Scene object layer orders must be unique.')
  }

  for (const [index, effect] of (Array.isArray(scene.effects) ? scene.effects : []).entries()) {
    validateSceneEffect(effect, index, issues)
  }

  return { issues }
}

/**
 * 序列化为 JSON 字符串。
 * 约束：输出必须可持久化，不能包含引擎运行时对象。
 */
export function serializeSceneDefinition(scene: SceneDefinition): string {
  return JSON.stringify(scene, null, 2)
}

/**
 * 从 JSON 字符串解析并校验 SceneDefinition。
 */
export function parseSceneDefinition(serialized: string): SceneDefinition {
  const parsed = JSON.parse(serialized) as SceneDefinitionDraft
  const migrated = migrateSceneDefinitionDraft(parsed)
  const normalized = applySceneDefinitionCompatibilityDefaults(migrated)
  /**
   * 解析旧持久化数据时先修复删除对象遗留的区块索引，再执行严格领域校验；否则未知 objectId
   * 会在这里直接阻断场景恢复，编辑器层没有机会调用自己的兼容适配器。
   */
  const repairedStreaming = pruneSceneStreamingChunkObjectReferences(
    normalized as Pick<SceneDefinition, 'id' | 'objects' | 'streaming'>,
  )
  const repaired =
    repairedStreaming === normalized.streaming
      ? normalized
      : {
          ...normalized,
          streaming: repairedStreaming,
        }
  const validation = validateSceneDefinition(repaired)

  if (validation.issues.length > 0) {
    throw new Error(`Invalid scene definition: ${validation.issues.join(' ')}`)
  }

  return repaired as SceneDefinition
}

export interface SceneDefinitionMigrationInput {
  sourceKind:
    | 'scene-definition-json'
    | 'scene-definition-object'
    | 'legacy-render-scene'
    | 'legacy-gis'
  data: unknown
}

export interface SceneDefinitionMigrationResult {
  scene: SceneDefinition
  warnings: string[]
}

/**
 * 老数据迁移到 SceneDefinition 的统一入口。
 * 当前先支持已是 SceneDefinition 的 JSON / plain object 重新解析和版本迁移；
 * 旧 renderScene / GIS 私有结构后续在这里按 sourceKind 增量补转换器。
 */
export function migrateLegacySceneDefinition(
  input: SceneDefinitionMigrationInput,
): SceneDefinitionMigrationResult {
  if (input.sourceKind === 'scene-definition-json') {
    if (typeof input.data !== 'string') {
      throw new Error('scene-definition-json migration data must be a JSON string.')
    }

    return {
      scene: parseSceneDefinition(input.data),
      warnings: [],
    }
  }

  if (input.sourceKind === 'scene-definition-object') {
    if (!isRecordLike(input.data)) {
      throw new Error('scene-definition-object migration data must be a plain object.')
    }

    return {
      scene: parseSceneDefinition(JSON.stringify(input.data)),
      warnings: [],
    }
  }

  throw new Error(`Legacy scene migration for source "${input.sourceKind}" is not implemented yet.`)
}
