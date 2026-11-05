import {
  createDefaultSceneCoordinateSystem,
  cloneScenePackageJsonValue,
  isScenePackageRecord,
  isSupportedScenePackageType,
  type SceneContainerPackage,
  type SceneDependenciesPackage,
  type SceneFourPackagePayload,
  type ScenePackageJsonObject,
  type SceneThreeDLayerPackage,
  type SceneThreeDTargetPackage,
  type SceneTwoDComponentPackage,
} from './sceneFourPackage'
import {
  createSceneDefinition,
  parseSceneDefinition,
  type AssetRef,
  type BoundingVolume,
  type SceneDefinition,
  type SceneLayer,
  type SceneLightConfig,
  type SceneObject,
  type SceneStreamingConfig,
  type SceneType,
} from '@/scene-platform'
import { getBuiltinSceneAsset, getBuiltinSceneResourceUrl } from './editorBuiltinResourceRegistry'

/** 真实运行态接口返回的通用发布分片。字段均来自 OpenAPI 的实际声明。 */
export interface SceneRuntimePublishedFragment {
  publicationId?: string
  fragmentType?: string
  fragmentKey?: string
  contentJson: string | ScenePackageJsonObject | ScenePackageJsonObject[]
  contentHash?: string
}

export interface AssembleSceneDefinitionOptions {
  /** 宿主接口提供的权威场景标识；sceneJson 内的旧 id 会被无条件忽略。 */
  sceneId?: string
  name?: string
  sceneType?: SceneType
  /**
   * 宿主仓储按稳定资源编号解析出的当前可用地址。
   *
   * 四包正文禁止保存可能过期的授权地址，因此纯组装器只负责把已解析结果合并回 AssetRef，
   * 不在这里发起网络请求，也不依赖具体宿主的资源接口。
   */
  resolvedAssetUrls?: Readonly<Record<string, string>>
}

export interface SceneRuntimeFragmentAssemblyInput {
  manifest: SceneRuntimePublishedFragment
  threeDFragments?: readonly SceneRuntimePublishedFragment[]
  twoDFragments?: readonly SceneRuntimePublishedFragment[]
  behaviorFragments?: readonly SceneRuntimePublishedFragment[]
  assetFragments?: readonly SceneRuntimePublishedFragment[]
  options?: AssembleSceneDefinitionOptions
}

type JsonRecord = Record<string, unknown>

const isRecord = (value: unknown): value is JsonRecord => isScenePackageRecord(value)

const getRecord = (value: unknown): JsonRecord | undefined => (isRecord(value) ? value : undefined)

const getArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

const getString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined

const getBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback

const getNumber = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

const hasOwn = (value: JsonRecord, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key)

const parseContentJson = (fragment: SceneRuntimePublishedFragment, path: string): unknown => {
  if (typeof fragment.contentJson !== 'string') {
    return cloneScenePackageJsonValue(fragment.contentJson, path)
  }
  try {
    return cloneScenePackageJsonValue(JSON.parse(fragment.contentJson), path)
  } catch (error) {
    const message = error instanceof Error ? error.message : '内容不可解析'
    throw new Error(`${path} 不是合法的 contentJson：${message}`)
  }
}

const parseOptionalJsonRecord = (value: unknown, path: string): JsonRecord | undefined => {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') {
    try {
      return getRecord(cloneScenePackageJsonValue(JSON.parse(value), path))
    } catch (error) {
      const message = error instanceof Error ? error.message : '内容不可解析'
      throw new Error(`${path} 不是合法 JSON：${message}`)
    }
  }
  return getRecord(cloneScenePackageJsonValue(value, path))
}

const contentRecord = (fragment: SceneRuntimePublishedFragment, path: string): JsonRecord => {
  const content = parseContentJson(fragment, path)
  return getRecord(content) ?? {}
}

/** 将内容中常见的数组容器统一拍平，兼容清单返回 items/targets 或直接返回单条对象。 */
const collectContentRecords = (content: unknown): JsonRecord[] => {
  if (Array.isArray(content)) return content.flatMap((item) => collectContentRecords(item))
  const record = getRecord(content)
  if (!record) return []

  for (const key of [
    'items',
    'targets',
    'objects',
    'components',
    'instances',
    'resources',
    'assets',
    'behaviors',
    'states',
    'events',
    'dataBindings',
    'deviceBindings',
  ]) {
    if (Array.isArray(record[key])) {
      return record[key].flatMap((item) => collectContentRecords(item))
    }
  }

  return [record]
}

const collectFragmentRecords = (
  fragments: readonly SceneRuntimePublishedFragment[] | undefined,
  path: string,
): JsonRecord[] =>
  (fragments ?? []).flatMap((fragment) => collectContentRecords(parseContentJson(fragment, path)))

interface DependencyFragmentRecords {
  resources: JsonRecord[]
  dataBindings: JsonRecord[]
  behaviors: JsonRecord[]
  deviceBindings: JsonRecord[]
}

/**
 * 每个行为分片只解析一次，再按稳定结构分类。
 *
 * 旧实现会分别以 dataBindings/behaviors/states/events/deviceBindings 读取同一分片，直接数组格式
 * 最多被重复加入五次。集中分类既消除重复解析，也避免把设备绑定误当成行为。
 */
const collectDependencyFragmentRecords = (
  fragments: readonly SceneRuntimePublishedFragment[] | undefined,
): DependencyFragmentRecords => {
  const result: DependencyFragmentRecords = {
    resources: [],
    dataBindings: [],
    behaviors: [],
    deviceBindings: [],
  }
  const appendRecord = (value: unknown) => {
    const record = getRecord(value)
    if (!record) return
    if (
      getString(record.behaviorKey) ||
      record.behaviorType ||
      Array.isArray(record.conditionGroups)
    ) {
      result.behaviors.push(record)
    } else if (getString(record.bindingKey) && (record.deviceId || record.deviceType)) {
      result.deviceBindings.push(record)
    } else if (getString(record.bindingKey) || record.source || record.mappingConfig) {
      result.dataBindings.push(record)
    }
  }

  for (const fragment of fragments ?? []) {
    const content = parseContentJson(fragment, '$.behaviorFragments')
    if (Array.isArray(content)) {
      content.forEach(appendRecord)
      continue
    }
    const record = getRecord(content)
    if (!record) continue
    /**
     * 新实例依赖接口把资源、数据绑定、行为和设备绑定聚合在同一个实例条目中。
     * 资源必须在创建三维对象前进入统一索引，否则对象虽有 resourceRefKeys，仍无法得到运行时资产。
     */
    getArray(record.resources).forEach((item) => {
      const resource = getRecord(item)
      if (resource) result.resources.push(resource)
    })
    getArray(record.dataBindings).forEach((item) => {
      const dependency = getRecord(item)
      if (dependency) result.dataBindings.push(dependency)
    })
    for (const key of ['behaviors', 'states', 'events'] as const) {
      getArray(record[key]).forEach((item) => {
        const dependency = getRecord(item)
        if (dependency) result.behaviors.push(dependency)
      })
    }
    getArray(record.deviceBindings).forEach((item) => {
      const dependency = getRecord(item)
      if (dependency) result.deviceBindings.push(dependency)
    })
    appendRecord(record)
  }
  return result
}

/** 保留分片根记录，供三维区块索引读取 bounds/chunkKey；目标提取另走 collectContentRecords。 */
const collectFragmentRoots = (
  fragments: readonly SceneRuntimePublishedFragment[] | undefined,
  path: string,
): JsonRecord[] =>
  (fragments ?? []).flatMap((fragment) => {
    const content = parseContentJson(fragment, path)
    return Array.isArray(content)
      ? content.flatMap((item) => (isRecord(item) ? [item] : []))
      : isRecord(content)
        ? [content]
        : []
  })

const getSceneType = (
  manifest: JsonRecord,
  sceneContainer: JsonRecord | undefined,
  options: AssembleSceneDefinitionOptions,
): SceneType => {
  if (options.sceneType) return options.sceneType
  const candidate =
    sceneContainer?.sceneType ?? sceneContainer?.type ?? manifest.sceneType ?? manifest.type
  return isSupportedScenePackageType(candidate) ? candidate : 'local3d'
}

const createFallbackTransform = (sceneType: SceneType) =>
  sceneType === 'gis'
    ? {
        kind: 'geo' as const,
        longitude: 0,
        latitude: 0,
        height: 0,
        heading: 0,
        pitch: 0,
        roll: 0,
        scale: 1,
        altitudeMode: 'absolute' as const,
      }
    : {
        kind: 'local' as const,
        position: [0, 0, 0] as [number, number, number],
        rotation: [0, 0, 0] as [number, number, number],
        scale: [1, 1, 1] as [number, number, number],
      }

const toTuple3 = (value: unknown, fallback: [number, number, number]): [number, number, number] => {
  if (Array.isArray(value)) {
    return [
      getNumber(value[0], fallback[0]),
      getNumber(value[1], fallback[1]),
      getNumber(value[2], fallback[2]),
    ]
  }
  const record = getRecord(value)
  if (record) {
    return [
      getNumber(record.x, fallback[0]),
      getNumber(record.y, fallback[1]),
      getNumber(record.z, fallback[2]),
    ]
  }
  return fallback
}

const toTransform = (value: unknown, sceneType: SceneType): SceneObject['transform'] => {
  const record = getRecord(value)
  const fallback = createFallbackTransform(sceneType)
  if (!record) return fallback

  if (sceneType === 'gis' || record.kind === 'geo' || record.longitude !== undefined) {
    const orientationQuaternion =
      Array.isArray(record.orientationQuaternion) && record.orientationQuaternion.length === 4
        ? (record.orientationQuaternion.map((item) => getNumber(item)) as [
            number,
            number,
            number,
            number,
          ])
        : undefined
    return {
      kind: 'geo',
      longitude: getNumber(record.longitude ?? getRecord(record.position)?.x, 0),
      latitude: getNumber(record.latitude ?? getRecord(record.position)?.y, 0),
      height: getNumber(record.height ?? record.altitude ?? getRecord(record.position)?.z, 0),
      heading: getNumber(record.heading, 0),
      pitch: getNumber(record.pitch, 0),
      roll: getNumber(record.roll, 0),
      scale:
        typeof record.scale === 'number'
          ? getNumber(record.scale, 1)
          : toTuple3(record.scale, [1, 1, 1]),
      altitudeMode:
        record.altitudeMode === 'relativeToGround' || record.altitudeMode === 'clampToGround'
          ? record.altitudeMode
          : 'absolute',
      ...(orientationQuaternion ? { orientationQuaternion } : {}),
    }
  }

  return {
    kind: 'local',
    position: toTuple3(record.position, [0, 0, 0]),
    rotation: toTuple3(record.rotation, [0, 0, 0]),
    scale:
      typeof record.scale === 'number'
        ? getNumber(record.scale, 1)
        : toTuple3(record.scale, [1, 1, 1]),
  }
}

const SUPPORTED_ASSET_KINDS = new Set<AssetRef['kind']>([
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

const toAssetRef = (
  value: unknown,
  resolvedAssetUrls: Readonly<Record<string, string>> = {},
): AssetRef | undefined => {
  const record = getRecord(value)
  if (!record) return undefined
  const resourceKey =
    getString(record.resourceKey) ?? getString(record.assetId) ?? getString(record.id)
  const assetId = getString(record.assetId) ?? resourceKey
  if (!resourceKey || !assetId) return undefined
  // Unity模型不读取历史文件地址；用稳定编号生成会话内定位符，由Unity解析当前修订。
  const unityLocator = record.kind === 'unity-model' && /^[1-9]\d{0,18}$/.test(assetId)
    ? `unity-resource://${assetId}` : undefined
  /**
   * 当前会话重新解析出的地址优先级最高；保存包中的地址只用于兼容尚未迁移的历史快照。
   * resourceKey 与 assetId 允许不同，因此两个稳定编号都参与命中，不能让历史过期地址覆盖新结果。
   */
  const url =
    unityLocator ??
    getString(resolvedAssetUrls[resourceKey]) ??
    getString(resolvedAssetUrls[assetId]) ??
    getString(record.url) ??
    getString(record.address) ??
    getString(record.resourceUrl) ??
    getString(record.contentUrl) ??
    getString(record.path)
  if (!url) return undefined

  const kindValue = getString(record.kind)
  const kind = SUPPORTED_ASSET_KINDS.has(kindValue as AssetRef['kind'])
    ? (kindValue as AssetRef['kind'])
    : 'json'
  const lodVariants = getArray(record.lodVariants)
    .map((variant) => {
      const item = getRecord(variant)
      const variantId = getString(item?.assetId) ?? getString(item?.id)
      const variantUrl =
        (variantId ? getString(resolvedAssetUrls[variantId]) : undefined) ??
        getString(item?.url) ??
        getString(item?.address) ??
        getString(item?.resourceUrl)
      const minimumDistance = item?.minimumDistance
      if (!variantId || !variantUrl || typeof minimumDistance !== 'number') return undefined
      return {
        id: variantId,
        kind: (item?.kind === 'gltf' ? 'gltf' : 'glb') as 'glb' | 'gltf',
        url: variantUrl,
        minimumDistance,
        ...(getString(item?.contentHash) ? { hash: getString(item?.contentHash) } : {}),
        ...(typeof item?.maximumScreenSpaceRatio === 'number'
          ? { maximumScreenSpaceRatio: item.maximumScreenSpaceRatio }
          : {}),
      }
    })
    .filter((item): item is NonNullable<typeof item> => item !== undefined)

  return {
    id: resourceKey,
    kind,
    url,
    /** 资源版本是稳定恢复信息；重新补地址时必须保留，不能退化为仅有编号和URL。 */
    ...(getString(record.version) ? { version: getString(record.version) } : {}),
    ...(getString(record.contentHash) ? { hash: getString(record.contentHash) } : {}),
    ...(isRecord(record.metadata) || assetId !== resourceKey
      ? { metadata: { ...(isRecord(record.metadata) ? record.metadata : {}), assetId } }
      : {}),
    ...(lodVariants.length > 0 ? { modelLodVariants: lodVariants } : {}),
  }
}

/** 按稳定资源编号补齐单个植被资产地址，同时保留植被包内的版本和摘要。 */
const hydrateVegetationAsset = (
  value: unknown,
  resourceIndex: ReadonlyMap<string, AssetRef>,
  resolvedAssetUrls: Readonly<Record<string, string>> = {},
): JsonRecord | undefined => {
  const record = getRecord(value)
  const resourceKey = getString(record?.id) ?? getString(record?.resourceKey)
  if (!record || !resourceKey) return undefined
  const indexed = resourceIndex.get(resourceKey)
  const resolvedUrl = getString(resolvedAssetUrls[resourceKey]) ?? indexed?.url
  if (!resolvedUrl) return record
  return {
    ...record,
    url: resolvedUrl,
    ...(indexed?.kind ? { kind: indexed.kind } : {}),
    ...(getString(record.version)
      ? { version: record.version }
      : indexed?.version
        ? { version: indexed.version }
        : {}),
    ...(getString(record.hash)
      ? { hash: record.hash }
      : indexed?.hash
        ? { hash: indexed.hash }
        : {}),
  }
}

/**
 * 植被资源必须在领域校验和运行时创建之前补齐。这里只遍历物种、图层和发布引用，不接触规则几何，
 * 因而恢复成本随资源关系增长，不随植被株数增长。
 */
const hydrateVegetationDefinition = (
  value: unknown,
  resourceIndex: ReadonlyMap<string, AssetRef>,
  resolvedAssetUrls: Readonly<Record<string, string>> = {},
): JsonRecord | undefined => {
  const vegetation = getRecord(value)
  if (!vegetation) return undefined
  const hydrateAsset = (asset: unknown) =>
    hydrateVegetationAsset(asset, resourceIndex, resolvedAssetUrls)
  const layers = getArray(vegetation.layers).map((value) => {
    const layer = getRecord(value) ?? {}
    const densityAssets = getRecord(layer.densityTilesetAssets)
    return {
      ...layer,
      ...(layer.manifestAsset ? { manifestAsset: hydrateAsset(layer.manifestAsset) } : {}),
      ...(layer.tilesetAsset ? { tilesetAsset: hydrateAsset(layer.tilesetAsset) } : {}),
      ...(layer.deltaAsset ? { deltaAsset: hydrateAsset(layer.deltaAsset) } : {}),
      ...(densityAssets
        ? {
            densityTilesetAssets: Object.fromEntries(
              Object.entries(densityAssets).map(([preset, asset]) => [preset, hydrateAsset(asset)]),
            ),
          }
        : {}),
    }
  })
  const speciesCatalog = getArray(vegetation.speciesCatalog).map((value) => {
    const species = getRecord(value) ?? {}
    return {
      ...species,
      ...(species.modelAsset ? { modelAsset: hydrateAsset(species.modelAsset) } : {}),
    }
  })
  const publication = getRecord(vegetation.publication)
  return {
    ...vegetation,
    layers,
    speciesCatalog,
    ...(publication
      ? {
          publication: {
            ...publication,
            ...(publication.manifestAsset
              ? { manifestAsset: hydrateAsset(publication.manifestAsset) }
              : {}),
            ...(publication.tilesetAsset
              ? { tilesetAsset: hydrateAsset(publication.tilesetAsset) }
              : {}),
          },
        }
      : {}),
  }
}

const createResourceIndex = (
  records: readonly JsonRecord[],
  resolvedAssetUrls: Readonly<Record<string, string>> = {},
): Map<string, AssetRef> => {
  const result = new Map<string, AssetRef>()
  for (const record of records) {
    const asset = toAssetRef(record, resolvedAssetUrls)
    if (!asset) continue
    const resourceKey = getString(record.resourceKey) ?? asset.id
    const assetId = getString(record.assetId)
    result.set(resourceKey, asset)
    if (assetId) result.set(assetId, asset)
  }
  return result
}

const getContentRecord = (value: unknown): JsonRecord => {
  if (typeof value === 'string') return parseOptionalJsonRecord(value, '$.contentJson') ?? {}
  return getRecord(value) ?? {}
}

/** 收集测验和按钮图片位使用的资源编号，恢复场景时按各槽位的稳定编号查找地址。 */
const getWidgetImageResourceKeys = (value: unknown) => {
  const images = getRecord(value)
  if (!images) return []
  return [
    ...new Set(
      Object.values(images).flatMap((item) => {
        const image = getRecord(item)
        if (!image) return []
        const resourceKey = getString(image.resourceKey)
        return getString(image.sourceType) === 'resource-market' && resourceKey ? [resourceKey] : []
      }),
    ),
  ]
}

const normalizeTargetType = (value: unknown): SceneObject['type'] | undefined => {
  const type = getString(value)
  if (!type) return undefined
  if (type === 'pipe') return 'primitive'
  if (
    type === 'model' ||
    type === 'image' ||
    type === 'primitive' ||
    type === 'tileset' ||
    type === 'light' ||
    type === 'camera' ||
    type === 'annotation' ||
    type === 'effect' ||
    type === 'group'
  )
    return type
  return undefined
}

/**
 * 看板图片地址只在组装运行态对象时补回。
 *
 * 外部图片通过图片资源编号在依赖索引中取得已解析的 OSS 地址；内置看板没有外部资源记录，
 * 则通过注册表恢复默认图片。补全只作用于新建的 SceneObject，不回写四包原文或依赖包。
 */
const hydrateBillboardImageSources = (
  billboard: JsonRecord,
  builtinResourceKey: unknown,
  resourceIndex: ReadonlyMap<string, AssetRef>,
  resolvedAssetUrls: Readonly<Record<string, string>> = {},
): JsonRecord => {
  const builtinUrl = getBuiltinSceneResourceUrl(builtinResourceKey)
  const content = getRecord(billboard.content)
  const blocks = getArray(content?.blocks)
  /** 历史看板可能完全缺少 appearance；使用空对象兼容，不在这里制造默认视觉值。 */
  const appearance = getRecord(billboard.appearance) ?? {}
  const hydratedBlocks = blocks.map((block) => {
    const record = getRecord(block)
    if (!record || record.type !== 'image') return block
    const resourceKey = getString(record.imageResourceKey)
    const resourceUrl = resourceKey
      ? (getString(resourceIndex.get(resourceKey)?.url) ??
        getString(resolvedAssetUrls[resourceKey]))
      : undefined
    if (resourceUrl) return { ...record, imageSrc: resourceUrl }
    if (builtinUrl && !getString(record.imageSrc)) return { ...record, imageSrc: builtinUrl }
    return block
  })
  const backgroundResourceKey = getString(appearance.backgroundImageResourceKey)
  const backgroundResourceUrl = backgroundResourceKey
    ? (getString(resourceIndex.get(backgroundResourceKey)?.url) ??
      getString(resolvedAssetUrls[backgroundResourceKey]))
    : undefined
  const hydratedAppearance = backgroundResourceUrl
    ? { ...appearance, backgroundImage: backgroundResourceUrl }
    : appearance

  if (
    hydratedBlocks.every((block, index) => block === blocks[index]) &&
    hydratedAppearance === appearance
  ) {
    return billboard
  }

  return {
    ...billboard,
    content: {
      ...content,
      blocks: hydratedBlocks,
    },
    appearance: hydratedAppearance,
  }
}

const toSceneObject = (
  target: JsonRecord,
  sceneType: SceneType,
  resourceIndex: ReadonlyMap<string, AssetRef>,
  resolvedAssetUrls: Readonly<Record<string, string>> = {},
): SceneObject | undefined => {
  const id = getString(target.instanceId) ?? getString(target.id)
  const type = normalizeTargetType(target.targetType ?? target.componentType ?? target.type)
  if (!id || !type) return undefined
  const content = getContentRecord(target.contentJson)
  const resourceKeys = getArray(target.resourceRefKeys ?? target.resourceKeys)
    .map(getString)
    .filter((item): item is string => item !== undefined)
  /**
   * 兼容依赖包遗漏但正文仍保留编号的历史三维图片：资源解析器已取得最新地址时，
   * 直接在内存中构造图片 AssetRef；该对象只参与本次运行时，不会反向写入保存包。
   */
  const asset = resourceKeys
    .map(
      (key) =>
        resourceIndex.get(key) ??
        (type === 'image' && getString(resolvedAssetUrls[key])
          ? ({ id: key, kind: 'image', url: resolvedAssetUrls[key] } as AssetRef)
          : undefined),
    )
    .find((item) => item !== undefined)
  const metadata = getRecord(content.metadata) ?? getRecord(target.metadata)
  const style = getRecord(content.style) ?? getRecord(target.style)
  /** 三维功能组件的领域配置保存在 contentJson.effect 中，兼容旧快照中的直接 effect 字段。 */
  const effect = getRecord(content.effect) ?? getRecord(target.effect)
  const firstPerson = getRecord(content.firstPerson) ?? getRecord(target.firstPerson)
  const billboard = getRecord(content.billboard) ?? getRecord(target.billboard)
  const layerId = getString(target.layerKey) ?? getString(target.layerId)
  /**
   * 旧四包没有保存 light，只在创建快照中留下灯具预设。先恢复这批存量灯具，
   * 新四包则始终使用独立保存的 light 配置，避免面板修改后被创建时的预设覆盖。
   */
  const savedLight = getRecord(content.light) ?? getRecord(target.light)
  const lightPreset = getRecord(getRecord(metadata?.editorModelSnapshot)?.light)
  const lightKind = lightPreset?.kind === 'spot' ? 'spot' : 'point'
  const legacyLight: SceneLightConfig = {
    kind: lightKind,
    color: getString(lightPreset?.color) ?? '#fff1d6',
    intensity: getNumber(lightPreset?.intensity, lightKind === 'point' ? 4 : 6),
    range: getNumber(lightPreset?.range, lightKind === 'point' ? 8 : 12),
    ...(lightKind === 'spot'
      ? {
          innerConeAngle: getNumber(lightPreset?.innerConeAngle, Math.PI / 9),
          outerConeAngle: getNumber(lightPreset?.outerConeAngle, Math.PI / 6),
        }
      : {}),
  }

  /** 无正式依赖引用的内置对象由前端注册表恢复；它不会写回四包或 dependencies。 */
  const builtinAsset = getBuiltinSceneAsset(
    getRecord(metadata?.editorModelSnapshot)?.builtinResourceKey,
  )
  const hydratedBillboard = isRecord(billboard)
    ? hydrateBillboardImageSources(
        billboard,
        getRecord(metadata?.editorModelSnapshot)?.builtinResourceKey,
        resourceIndex,
        resolvedAssetUrls,
      )
    : undefined

  // 显式锁定优先；缺少该字段的旧四包仍沿可拾取/旧别名推导初始自身值。
  const legacyPickable = typeof metadata?.pickable === 'boolean' ? metadata.pickable
    : typeof metadata?.pickup === 'boolean' ? metadata.pickup : undefined

  return {
    id,
    name: getString(target.name) ?? id,
    type,
    visible: getBoolean(
      target.visible ?? target.initialOwnVisible ?? target.initialEffectiveVisible,
      true,
    ),
    locked: getBoolean(target.locked, legacyPickable === false),
    ...(layerId ? { layerId } : {}),
    // 恢复业务父级，避免四包往返后节点被静默提升到根级。
    ...(getString(target.parentInstanceId) ? { parentInstanceId: getString(target.parentInstanceId)! } : {}),
    order: Math.max(0, Math.floor(getNumber(target.sortNo ?? target.order, 0))),
    transform: toTransform(target.transform, sceneType),
    /**
     * 内置看板的创建资产必须优先于其内容图片资源；否则 resourceRefKeys 中第一张用户图片会被
     * 误当成看板对象自身资产，导致 Runtime 用内容图替换默认看板载体。
     */
    ...((builtinAsset ?? asset) ? { asset: builtinAsset ?? asset } : {}),
    // 这里只做容器级收窄；看板的完整结构由末尾 parseSceneDefinition 统一校验。
    ...(hydratedBillboard
      ? { billboard: hydratedBillboard as unknown as SceneObject['billboard'] }
      : {}),
    ...(isRecord(style) ? { style } : {}),
    ...(isRecord(effect) ? { effect: effect as unknown as SceneObject['effect'] } : {}),
    ...(type === 'light'
      ? { light: (savedLight ?? legacyLight) as unknown as SceneLightConfig }
      : {}),
    ...(type === 'camera' && isRecord(firstPerson)
      ? { firstPerson: firstPerson as unknown as SceneObject['firstPerson'] }
      : {}),
    ...(isRecord(metadata) ? { metadata } : {}),
  }
}

const mergeTargets = (records: readonly JsonRecord[]): JsonRecord[] => {
  const byId = new Map<string, JsonRecord>()
  for (const record of records) {
    const id = getString(record.instanceId) ?? getString(record.id)
    if (!id) continue
    byId.set(id, { ...(byId.get(id) ?? {}), ...record })
  }
  return Array.from(byId.values())
}

const toSceneLayerType = (value: unknown): SceneLayer['type'] | undefined => {
  const type = getString(value)
  if (
    type === 'object' ||
    type === 'imagery' ||
    type === 'terrain' ||
    type === 'tileset' ||
    type === 'vector' ||
    type === 'effect' ||
    type === 'annotation'
  )
    return type
  return undefined
}

const toSceneLayer = (
  layer: JsonRecord,
  resourceIndex: ReadonlyMap<string, AssetRef>,
): SceneLayer | undefined => {
  const id = getString(layer.layerKey) ?? getString(layer.id)
  const type = toSceneLayerType(layer.layerType ?? layer.type)
  if (!id || !type) return undefined
  const resourceKey = getString(getArray(layer.resourceRefKeys)[0])
  const provider = getString(layer.provider)
  const url = getString(layer.url)
  return {
    id,
    name: getString(layer.name) ?? id,
    type,
    visible: getBoolean(layer.visible, true),
    locked: getBoolean(layer.locked, false),
    order: getNumber(layer.sortNo ?? layer.order, 0),
    ...(typeof layer.opacity === 'number' ? { opacity: layer.opacity } : {}),
    ...(provider ? { provider: provider as SceneLayer['provider'] } : {}),
    ...(url ? { url } : {}),
    ...(resourceKey && resourceIndex.has(resourceKey)
      ? { asset: resourceIndex.get(resourceKey) }
      : {}),
    ...(isRecord(layer.options) ? { options: layer.options } : {}),
    ...(isRecord(layer.metadata) ? { metadata: layer.metadata } : {}),
  }
}

const mergeLayers = (layers: readonly SceneLayer[]): SceneLayer[] => {
  const byId = new Map<string, SceneLayer>()
  for (const layer of layers) byId.set(layer.id, { ...(byId.get(layer.id) ?? {}), ...layer })
  return Array.from(byId.values()).sort((left, right) => left.order - right.order)
}

const isBoundingVolume = (value: unknown): value is BoundingVolume => {
  const record = getRecord(value)
  if (!record || typeof record.type !== 'string') return false
  if (record.type === 'sphere')
    return Array.isArray(record.center) && typeof record.radius === 'number'
  if (record.type === 'aabb') return Array.isArray(record.min) && Array.isArray(record.max)
  return (
    record.type === 'region' &&
    typeof record.west === 'number' &&
    typeof record.south === 'number' &&
    typeof record.east === 'number' &&
    typeof record.north === 'number'
  )
}

/** 将后端 groupKey 兼容映射为领域层要求的 id，避免运行态分片无法通过流式校验。 */
const toStreamingGroup = (value: unknown): SceneStreamingConfig['groups'][number] | undefined => {
  const group = getRecord(value) ?? {}
  const id = getString(group.id) ?? getString(group.groupKey)
  const mode = group.mode
  if (
    !id ||
    (mode !== 'near-camera' &&
      mode !== 'always-loaded' &&
      mode !== 'manual' &&
      mode !== 'engine-native')
  )
    return undefined
  return {
    id,
    mode,
    ...(typeof group.preloadRadius === 'number' ? { preloadRadius: group.preloadRadius } : {}),
    ...(typeof group.visibleRadius === 'number' ? { visibleRadius: group.visibleRadius } : {}),
    ...(typeof group.unloadRadius === 'number' ? { unloadRadius: group.unloadRadius } : {}),
    ...(typeof group.maxLoadedChunks === 'number'
      ? { maxLoadedChunks: group.maxLoadedChunks }
      : {}),
    ...(typeof group.memoryBudgetMB === 'number' ? { memoryBudgetMB: group.memoryBudgetMB } : {}),
    ...(typeof group.priority === 'number' ? { priority: group.priority } : {}),
  }
}

const createStreamingConfig = (
  sceneId: string,
  source: unknown,
  chunkRecords: readonly JsonRecord[],
): SceneStreamingConfig | undefined => {
  const sourceRecord = getRecord(source)
  const sourceGroups = getArray(sourceRecord?.groups)
  const sourceChunks = getArray(sourceRecord?.chunks)
  const groups = sourceGroups
    .map(toStreamingGroup)
    .filter((group): group is SceneStreamingConfig['groups'][number] => group !== undefined)
  const chunks = sourceChunks.length > 0 ? sourceChunks : chunkRecords
  const normalizedChunks = chunks.flatMap((item) => {
    const chunk = getRecord(item)
    if (!chunk) return []
    const id = getString(chunk.chunkKey) ?? getString(chunk.id)
    const bounds = chunk.bounds ?? chunk.boundingVolume
    if (!id || !isBoundingVolume(bounds)) return []
    const targets = getArray(chunk.targets ?? chunk.chunkTargets)
    const objectIds = getArray(chunk.objectIds)
      .map(getString)
      .filter((value): value is string => value !== undefined)
    const targetObjectIds = targets
      .map((target) => getString(getRecord(target)?.instanceId) ?? getString(getRecord(target)?.id))
      .filter((value): value is string => value !== undefined)
    const assetIds = getArray(chunk.assetIds ?? chunk.resourceRefKeys)
      .map(getString)
      .filter((value): value is string => value !== undefined)
    const streamingGroupId = getString(chunk.streamingGroupId ?? chunk.streamingGroupKey)
    return [
      {
        id,
        sceneId,
        bounds,
        objectIds: Array.from(new Set([...objectIds, ...targetObjectIds])),
        assetIds: Array.from(new Set(assetIds)),
        ...(streamingGroupId ? { streamingGroupId } : {}),
        ...(typeof chunk.lodLevel === 'number' ? { lodLevel: chunk.lodLevel } : {}),
        ...(typeof chunk.priority === 'number' ? { priority: chunk.priority } : {}),
        ...(Array.isArray(chunk.tags)
          ? { tags: chunk.tags.filter((tag): tag is string => typeof tag === 'string') }
          : {}),
      },
    ]
  })
  if (normalizedChunks.length === 0 && groups.length === 0 && !sourceRecord) return undefined
  return {
    chunks: normalizedChunks,
    groups,
    ...(isRecord(sourceRecord?.options)
      ? { options: sourceRecord.options as unknown as SceneStreamingConfig['options'] }
      : {}),
    ...(isRecord(sourceRecord?.runtimeOverrides)
      ? {
          runtimeOverrides:
            sourceRecord.runtimeOverrides as unknown as SceneStreamingConfig['runtimeOverrides'],
        }
      : {}),
  }
}

/**
 * 把结构化二维组件还原为旧画布可识别的 Widget 快照，并在此边界补齐资源地址。
 *
 * 外部图片地址属于组件正文；资源市场图片则通过 `resourceRefKeys` 在本边界补回运行时地址。
 * 解析后的地址绝不回写 dependencies 或四包原文。
 * 即便 contentJson 已有完整 widget，也必须先经过本函数，才能兼容历史净化数据。
 */
const toWidget = (
  component: JsonRecord,
  index: number,
  resourceIndex: ReadonlyMap<string, AssetRef>,
  resolvedAssetUrls: Readonly<Record<string, string>> = {},
): JsonRecord | undefined => {
  const id = getString(component.instanceId) ?? getString(component.id)
  if (!id) return undefined
  const content = getContentRecord(component.contentJson)
  const existingWidget = getRecord(content.widget) ?? getRecord(component.widget)
  const existingWidgetComponent = getRecord(existingWidget?.component)
  const existingWidgetInfo = getRecord(existingWidgetComponent?.info)
  const existingWidgetOption = getRecord(existingWidgetComponent?.option)
  const legacyPageFrameBackgroundKey =
    getString(existingWidgetInfo?.keyName) === 'VPageMenu'
      ? getString(getRecord(existingWidgetOption?.background)?.resourceKey)
      : undefined
  const legacyImageSlotResourceKeys =
    ['VQuiz', 'VButton'].includes(getString(existingWidgetInfo?.keyName) ?? '')
      ? getWidgetImageResourceKeys(existingWidgetOption?.images)
      : []
  const resourceRefKeys = [
    ...new Set(
      getArray(component.resourceRefKeys ?? component.resourceKeys)
        .map(getString)
        .filter((value): value is string => value !== undefined)
        .concat(legacyPageFrameBackgroundKey ? [legacyPageFrameBackgroundKey] : [])
        .concat(legacyImageSlotResourceKeys),
    ),
  ]
    .map(getString)
    .filter((value): value is string => value !== undefined)
  const resourceAssets = resourceRefKeys
    .map(
      (key) =>
        resourceIndex.get(key) ??
        (getString(resolvedAssetUrls[key])
          ? ({ id: key, kind: 'image', url: resolvedAssetUrls[key] } as AssetRef)
          : undefined),
    )
    .filter((asset): asset is AssetRef => asset !== undefined)

  const hydrateWidgetResourceUrls = (widget: JsonRecord): JsonRecord => {
    const widgetComponent = getRecord(widget.component)
    if (!widgetComponent || resourceAssets.length === 0) return widget
    const info = getRecord(widgetComponent.info)
    const componentType = getString(info?.keyName) ?? getString(component.componentType)
    const option = { ...getRecord(widgetComponent.option) }
    if (componentType === 'VImage') {
      const isResourceMarket = getString(option.sourceType) === 'resource-market'
      const imageResourceKey = getString(option.resourceKey) ?? resourceRefKeys[0]
      const resourceUrl = imageResourceKey
        ? (resourceIndex.get(imageResourceKey)?.url ?? resolvedAssetUrls[imageResourceKey])
        : resourceAssets[0]?.url
      if (isResourceMarket) {
        /** 市场模式始终以当前编号解析结果为准，避免旧签名地址覆盖资源服务返回的新地址。 */
        if (imageResourceKey) option.resourceKey = imageResourceKey
        if (resourceUrl) option.value = resourceUrl
      } else if (!getString(option.value) && resourceUrl) {
        /** 未声明来源的历史二维图片保留旧依赖回退，已有外部地址仍拥有最高优先级。 */
        option.value = resourceUrl
      }
    } else if (componentType === 'VVideo') {
      /** 视频仍沿用历史依赖兼容：只有正文地址缺失时才补回。 */
      if (!getString(option.value)) option.value = resourceAssets[0].url
    } else if (componentType === 'VImageCarousel') {
      /**
       * resourceRefKeys 是资源集合，option.resourceKeys 才是轮播槽位序列。
       * 优先按槽位编号恢复可保留重复图片；历史包没有该字段时再回退到资源集合顺序。
       */
      const slotResourceKeys = getArray(option.resourceKeys)
        .map(getString)
        .filter((value): value is string => value !== undefined)
      const directUrls = [
        ...getArray(option.dataset).map(getString),
        ...getArray(option.options).map((item) => getString(getRecord(item)?.value)),
      ].filter((url): url is string => Boolean(url))
      const urls = directUrls.length
        ? directUrls
        : (slotResourceKeys.length > 0 ? slotResourceKeys : resourceRefKeys)
            .map((key) => resourceIndex.get(key)?.url)
            .filter((url): url is string => typeof url === 'string' && Boolean(url.trim()))
      if (directUrls.length === 0) {
        option.dataset = urls
        option.options = urls.map((url, resourceIndex) => ({
          label: `图片${resourceIndex + 1}`,
          value: url,
        }))
      }
    } else if (componentType === 'VPageMenu') {
      /**
       * 页面菜单的导航栏和按钮是两个独立图片槽位，必须按各自稳定键匹配，不能依赖数组顺序；
       * 这样同一图片复用或后端资源去重后仍能恢复到正确位置。
       */
      const barResourceKey = getString(option.barBackgroundImageResourceKey)
      const buttonResourceKey = getString(option.buttonBackgroundImageResourceKey)
      const barUrl = barResourceKey ? resourceIndex.get(barResourceKey)?.url : undefined
      const buttonUrl = buttonResourceKey ? resourceIndex.get(buttonResourceKey)?.url : undefined
      /** 页面菜单两个图片槽位分别回退，已有外部地址不能被历史依赖覆盖。 */
      if (barUrl && !getString(option.barBackgroundImage)) option.barBackgroundImage = barUrl
      if (buttonUrl && !getString(option.buttonBackgroundImage)) {
        option.buttonBackgroundImage = buttonUrl
      }

      /** 页面框架外边框图片使用嵌套 background.resourceKey，加载时按资源编号恢复最新地址。 */
      const background = getRecord(option.background) ?? {}
      const backgroundResourceKey =
        getString(background.resourceKey) ??
        (getString(background.sourceType) === 'resource-market' ? resourceRefKeys[0] : undefined)
      const backgroundUrl = backgroundResourceKey
        ? (resourceIndex.get(backgroundResourceKey)?.url ??
          resolvedAssetUrls[backgroundResourceKey])
        : undefined
      if (backgroundResourceKey) {
        option.background = {
          ...background,
          sourceType: 'resource-market',
          resourceKey: backgroundResourceKey,
          ...(backgroundUrl ? { value: backgroundUrl } : {}),
        }
      }
    } else if (componentType === 'VQuiz' || componentType === 'VButton') {
      /** 测验和按钮各图片槽位按自己的稳定编号回填，同图复用或资源列表重排不改变槽位。 */
      const images = getRecord(option.images) ?? {}
      option.images = Object.fromEntries(
        Object.entries(images).map(([key, value]) => {
          const image = { ...getRecord(value) }
          if (getString(image.sourceType) !== 'resource-market') return [key, image]
          const resourceKey = getString(image.resourceKey)
          const resourceUrl = resourceKey
            ? (resourceIndex.get(resourceKey)?.url ?? resolvedAssetUrls[resourceKey])
            : undefined
          return [
            key,
            {
              ...image,
              ...(resourceKey ? { resourceKey } : {}),
              ...(resourceUrl ? { value: resourceUrl } : { value: '' }),
            },
          ]
        }),
      )
    }
    return {
      ...widget,
      /** 解析地址只存在于本次组装结果；市场图片下一次保存仍会再次清空地址。 */
      resourceRefKeys: [...resourceRefKeys],
      component: {
        ...widgetComponent,
        resourceRefKeys: [...resourceRefKeys],
        option,
      },
    }
  }

  const parentId = getString(component.parentInstanceId)
  if (existingWidget) {
    return hydrateWidgetResourceUrls({
      ...existingWidget,
      ...(parentId ? { parentId } : {}),
    })
  }

  const layout = getRecord(component.layoutConfig) ?? {}
  const style = getRecord(component.styleConfig) ?? {}
  const render = getRecord(component.renderConfig) ?? {}
  const animation = getRecord(component.animationConfig) ?? {}
  /**
   * 后端结构化二维布局使用 left/top/width/height，现有画布组件使用 l/t/w/h。
   * 兼容转换只在分片组装边界执行一次，避免 LayerDOM 和每个具体组件在渲染阶段重复判断双字段。
   */
  const normalizedLayout = {
    ...layout,
    l: getNumber(layout.l ?? layout.left, 0),
    t: getNumber(layout.t ?? layout.top, 0),
    w: Math.max(0, getNumber(layout.w ?? layout.width, 0)),
    h: Math.max(0, getNumber(layout.h ?? layout.height, 0)),
    zIndex: getNumber(layout.zIndex, index),
  }
  const componentType = getString(component.componentType) ?? 'widget'
  const packageName =
    getString(component.packageName) ?? getString(component.componentPackage) ?? componentType
  return hydrateWidgetResourceUrls({
    id,
    ...(parentId ? { parentId } : {}),
    resourceRefKeys: [...resourceRefKeys],
    component: {
      attr: normalizedLayout,
      info: {
        name: getString(component.name) ?? id,
        keyName: componentType,
        /**
         * 结构化回退优先消费后端明确包名；历史数据缺失时保留旧同名回退，不在此处按前缀猜包。
         * 正式发布编译仍应通过 contentJson.widget 保存准确的 Chart/Widget/Decorate/Control。
         */
        packageName,
        icon: '',
      },
      resourceRefKeys: [...resourceRefKeys],
      /** 显隐和锁定属于现有二维运行时 option，不能放在组件根级后被画布忽略。 */
      option: {
        ...render,
        visible: getBoolean(component.visible, true),
        locked: getBoolean(component.locked, false),
      },
      styles: { ...style, animations: animation },
      // 未知组件私有字段保留在 contentJson 中，后续具体部件适配器再解释。
      runtimeFragmentIndex: index,
    },
  })
}

const createTwoDFragment = (
  seed: JsonRecord,
  fragments: readonly SceneRuntimePublishedFragment[] | undefined,
): JsonRecord => {
  const fragmentComponents = collectFragmentRecords(fragments, '$.twoDFragments')
  const components = mergeTargets([
    ...getArray(seed.components)
      .map((item) => getRecord(item))
      .filter((item): item is JsonRecord => item !== undefined),
    ...fragmentComponents,
  ])
  return {
    canvas: getRecord(seed.canvas) ?? {},
    components,
    layerTree: getArray(seed.layerTree),
  }
}

/** 依赖记录的稳定键必须包含 owner，二维、三维可以合法复用同一个局部编号。 */
const getDependencyStableKey = (
  record: JsonRecord,
  keyNames: readonly string[],
): string | undefined => {
  const key = keyNames.map((name) => getString(record[name])).find(Boolean)
  if (!key) return undefined
  const owner = getRecord(record.owner)
  const domain = getString(owner?.domain)
  const ownerType = getString(owner?.ownerType)
  const instanceId = getString(owner?.instanceId) ?? getString(owner?.ownerKey)
  return domain && ownerType && instanceId ? `${domain}:${ownerType}:${instanceId}:${key}` : key
}

/** 资源按 resourceKey 聚合，同时合并所有合法拥有者，避免多分片导致资源条目重复。 */
const mergeResourceRecords = (records: readonly JsonRecord[]): JsonRecord[] => {
  const byResourceKey = new Map<string, JsonRecord>()
  for (const record of records) {
    const resourceKey =
      getString(record.resourceKey) ?? getString(record.assetId) ?? getString(record.id)
    if (!resourceKey) continue
    const previous = byResourceKey.get(resourceKey)
    if (!previous) {
      byResourceKey.set(resourceKey, { ...record, resourceKey })
      continue
    }
    const owners = new Map<string, JsonRecord>()
    for (const ownerValue of [...getArray(previous.owners), ...getArray(record.owners)]) {
      const owner = getRecord(ownerValue)
      const domain = getString(owner?.domain)
      const ownerType = getString(owner?.ownerType)
      const ownerId = getString(owner?.instanceId) ?? getString(owner?.ownerKey)
      if (owner && domain && ownerType && ownerId)
        owners.set(`${domain}:${ownerType}:${ownerId}`, owner)
    }
    byResourceKey.set(resourceKey, {
      ...previous,
      ...record,
      resourceKey,
      owners: Array.from(owners.values()),
    })
  }
  return Array.from(byResourceKey.values())
}

const mergeDependencyEntries = (
  values: readonly JsonRecord[],
  keyNames: readonly string[],
): JsonRecord[] => {
  const byKey = new Map<string, JsonRecord>()
  const anonymous: JsonRecord[] = []
  for (const record of values) {
    const key = getDependencyStableKey(record, keyNames)
    if (key) byKey.set(key, record)
    else anonymous.push(record)
  }
  return [...byKey.values(), ...anonymous]
}

const mergeDependencies = (
  seed: JsonRecord,
  dependencyFragments: DependencyFragmentRecords,
  assetRecords: readonly JsonRecord[],
): SceneDependenciesPackage => {
  const asArray = (key: string) => getArray(seed[key])
  const resources = mergeResourceRecords([
    ...getArray(seed.resources)
      .map((item) => getRecord(item))
      .filter((item): item is JsonRecord => item !== undefined),
    ...dependencyFragments.resources,
    ...assetRecords,
  ])
  return {
    resources: resources as SceneDependenciesPackage['resources'],
    dataBindings: cloneScenePackageJsonValue(
      mergeDependencyEntries(
        [...asArray('dataBindings'), ...dependencyFragments.dataBindings]
          .map((item) => getRecord(item))
          .filter((item): item is JsonRecord => item !== undefined),
        ['bindingKey', 'id'],
      ),
      '$.dependencies.dataBindings',
    ) as SceneDependenciesPackage['dataBindings'],
    behaviors: cloneScenePackageJsonValue(
      mergeDependencyEntries(
        [...asArray('behaviors'), ...dependencyFragments.behaviors]
          .map((item) => getRecord(item))
          .filter((item): item is JsonRecord => item !== undefined),
        ['behaviorKey', 'id'],
      ),
      '$.dependencies.behaviors',
    ) as SceneDependenciesPackage['behaviors'],
    deviceBindings: cloneScenePackageJsonValue(
      mergeDependencyEntries(
        [...asArray('deviceBindings'), ...dependencyFragments.deviceBindings]
          .map((item) => getRecord(item))
          .filter((item): item is JsonRecord => item !== undefined),
        ['bindingKey', 'id'],
      ),
      '$.dependencies.deviceBindings',
    ) as SceneDependenciesPackage['deviceBindings'],
  }
}

/**
 * 逐字段选择场景级定义：sceneJson 显式字段优先，缺失时才读取旧依赖包。
 * 不能使用真假值判断，因为空对象和空数组表示用户已经明确清空，必须覆盖历史非空数据。
 */
const readSceneGlobalPackage = (
  sceneContainer: JsonRecord,
  legacySource: JsonRecord,
): Pick<SceneContainerPackage, 'requestGlobalConfig' | 'publicRequests' | 'sceneActions'> => {
  const pick = (key: string): unknown =>
    hasOwn(sceneContainer, key) ? sceneContainer[key] : legacySource[key]
  const requestGlobalConfigValue = pick('requestGlobalConfig')
  const publicRequestsValue = pick('publicRequests')
  const sceneActionsValue = pick('sceneActions')
  if (requestGlobalConfigValue !== undefined && !isRecord(requestGlobalConfigValue)) {
    throw new Error('sceneJson.requestGlobalConfig 必须是对象')
  }
  if (publicRequestsValue !== undefined && !Array.isArray(publicRequestsValue)) {
    throw new Error('sceneJson.publicRequests 必须是数组')
  }
  if (sceneActionsValue !== undefined && !Array.isArray(sceneActionsValue)) {
    throw new Error('sceneJson.sceneActions 必须是数组')
  }
  return {
    requestGlobalConfig: cloneScenePackageJsonValue(
      requestGlobalConfigValue ?? {},
      '$.scene.requestGlobalConfig',
    ) as SceneContainerPackage['requestGlobalConfig'],
    publicRequests: cloneScenePackageJsonValue(
      publicRequestsValue ?? [],
      '$.scene.publicRequests',
    ) as SceneContainerPackage['publicRequests'],
    sceneActions: cloneScenePackageJsonValue(
      sceneActionsValue ?? [],
      '$.scene.sceneActions',
    ) as SceneContainerPackage['sceneActions'],
  }
}

interface WidgetDependencyIndex {
  dataBindingsByInstance: Map<string, JsonRecord[]>
  behaviorsByInstance: Map<string, JsonRecord[]>
  deviceBindingsByInstance: Map<string, JsonRecord[]>
}

const appendIndexedRecord = (
  index: Map<string, JsonRecord[]>,
  instanceId: string,
  record: JsonRecord,
) => {
  const records = index.get(instanceId)
  if (records) records.push(record)
  else index.set(instanceId, [record])
}

/**
 * 为二维组件建立依赖索引。
 * 索引键同时包含域、拥有者类型和实例编号，避免二维、三维恰好使用同一编号时发生串包。
 * 数据绑定、行为和设备绑定只各扫描一次，避免组件数与依赖数形成嵌套遍历。
 */
const createWidgetDependencyIndex = (
  dependencies: SceneDependenciesPackage,
): WidgetDependencyIndex => {
  const dataBindingsByInstance = new Map<string, JsonRecord[]>()
  const behaviorsByInstance = new Map<string, JsonRecord[]>()
  const deviceBindingsByInstance = new Map<string, JsonRecord[]>()
  const appendTwoDInstanceRecord = (index: Map<string, JsonRecord[]>, record: JsonRecord) => {
    const owner = getRecord(record.owner)
    if (owner?.domain !== 'twoD' || owner.ownerType !== 'instance') return
    const instanceId = getString(owner.instanceId)
    if (instanceId) appendIndexedRecord(index, instanceId, record)
  }

  for (const value of dependencies.dataBindings) {
    const binding = getRecord(value)
    if (binding) appendTwoDInstanceRecord(dataBindingsByInstance, binding)
  }
  for (const value of dependencies.behaviors) {
    const behavior = getRecord(value)
    if (behavior) appendTwoDInstanceRecord(behaviorsByInstance, behavior)
  }
  for (const value of dependencies.deviceBindings) {
    const binding = getRecord(value)
    if (binding) appendTwoDInstanceRecord(deviceBindingsByInstance, binding)
  }

  return { dataBindingsByInstance, behaviorsByInstance, deviceBindingsByInstance }
}

/** 从结构化数据绑定的可逆快照恢复现有二维数据面板协议。 */
const restoreWidgetDataConfig = (bindings: readonly JsonRecord[]): JsonRecord | undefined => {
  const ordered = [...bindings].sort(
    (left, right) => getNumber(left.sortNo, 0) - getNumber(right.sortNo, 0),
  )
  const requestSnapshots = ordered
    .map((binding) => getRecord(getContentRecord(binding.contentJson).requestSnapshot))
    .filter((request): request is JsonRecord => request !== undefined)
  const firstRequest = requestSnapshots[0]
  if (!firstRequest) return undefined
  const firstContent = getContentRecord(ordered[0]?.contentJson)

  return {
    version: getNumber(firstContent.dataConfigVersion, 1),
    requests: requestSnapshots,
    // 根级字段是旧面板兼容镜像；以排序后的首个请求重建，后续编辑仍以 requests 为权威来源。
    request: getRecord(firstRequest.request) ?? {},
    extractor: getRecord(firstRequest.extractor) ?? {},
    dataset: getRecord(firstRequest.dataset) ?? { dimensions: [], source: [] },
    bindings: getArray(firstRequest.bindings),
    ...(getString(firstRequest.filterFn) ? { filterFn: firstRequest.filterFn } : {}),
    deletedAutoMappingTargets: getArray(firstRequest.deletedAutoMappingTargets),
  }
}

/**
 * 将运行态依赖重新合并到二维组件私有配置。
 * twoD 分片只负责渲染，数据、状态和事件从 dependencies/behavior 分片按拥有者恢复。
 */
const applyWidgetDependencies = (
  widgets: readonly JsonRecord[],
  dependencies: SceneDependenciesPackage,
): JsonRecord[] => {
  const index = createWidgetDependencyIndex(dependencies)
  return widgets.map((widget) => {
    const id = getString(widget.id)
    const component = getRecord(widget.component)
    if (!id || !component) return widget

    const dataConfig = restoreWidgetDataConfig(index.dataBindingsByInstance.get(id) ?? [])
    const statusList: JsonRecord[] = []
    const interactiveEvent: JsonRecord[] = []
    const behaviors = [...(index.behaviorsByInstance.get(id) ?? [])].sort(
      (left, right) => getNumber(left.sortNo, 0) - getNumber(right.sortNo, 0),
    )
    for (const behavior of behaviors) {
      const legacyConfig = getRecord(getContentRecord(behavior.contentJson).legacyConfig)
      if (!legacyConfig) continue
      if (behavior.behaviorType === 'status') statusList.push(legacyConfig)
      else if (behavior.behaviorType === 'interaction') interactiveEvent.push(legacyConfig)
    }
    const deviceBindings = index.deviceBindingsByInstance.get(id) ?? []
    const firstDeviceBinding = deviceBindings[0]

    return {
      ...widget,
      component: {
        ...component,
        ...(dataConfig ? { dataConfig } : {}),
        ...(statusList.length > 0 ? { statusList } : {}),
        ...(interactiveEvent.length > 0 ? { interactiveEvent } : {}),
        /** 旧二维面板只识别单个 deviceBinding；完整数组仍在 settings.dependencies 中保留。 */
        ...(firstDeviceBinding ? { deviceBinding: firstDeviceBinding } : {}),
        ...(getString(firstDeviceBinding?.deviceId)
          ? { deviceId: firstDeviceBinding.deviceId }
          : {}),
      },
    }
  })
}

/**
 * 将首次激活的行为分片恢复到三维对象的运行时元数据。
 * 元数据只写入 Runtime 自有 SceneObject 快照，不会回写编辑器 Store 或发布正文。
 */
const applyObjectDependencies = (
  objects: readonly SceneObject[],
  dependencies: SceneDependenciesPackage,
): SceneObject[] => {
  const dataByOwner = new Map<string, JsonRecord[]>()
  const behaviorByOwner = new Map<string, JsonRecord[]>()
  const deviceByOwner = new Map<string, JsonRecord[]>()
  const appendThreeDInstanceRecord = (index: Map<string, JsonRecord[]>, record: JsonRecord) => {
    const owner = getRecord(record.owner)
    if (owner?.domain !== 'threeD' || owner.ownerType !== 'instance') return
    const instanceId = getString(owner.instanceId)
    if (instanceId) appendIndexedRecord(index, instanceId, record)
  }
  for (const value of dependencies.dataBindings) {
    const record = getRecord(value)
    if (record) appendThreeDInstanceRecord(dataByOwner, record)
  }
  for (const value of dependencies.behaviors) {
    const record = getRecord(value)
    if (record) appendThreeDInstanceRecord(behaviorByOwner, record)
  }
  for (const value of dependencies.deviceBindings) {
    const record = getRecord(value)
    if (record) appendThreeDInstanceRecord(deviceByOwner, record)
  }
  return objects.map((object) => {
    const data = dataByOwner.get(object.id) ?? []
    const behavior = [...(behaviorByOwner.get(object.id) ?? [])].sort(
      (left, right) => getNumber(left.sortNo, 0) - getNumber(right.sortNo, 0),
    )
    const deviceBindings = deviceByOwner.get(object.id) ?? []
    if (!data.length && !behavior.length && !deviceBindings.length) return object
    const metadata = isRecord(object.metadata) ? object.metadata : {}
    const statusList: unknown[] = []
    const interactiveEvent: unknown[] = []
    behavior.forEach((item) => {
      const legacy = getRecord(getContentRecord(item.contentJson).legacyConfig)
      if (!legacy) return
      if (item.behaviorType === 'status') statusList.push(legacy)
      if (item.behaviorType === 'interaction') interactiveEvent.push(legacy)
    })
    return {
      ...object,
      metadata: {
        ...metadata,
        ...(data.length ? { dataConfig: restoreWidgetDataConfig(data) } : {}),
        ...(statusList.length ? { statusList } : {}),
        ...(interactiveEvent.length ? { interactiveEvent } : {}),
        ...(deviceBindings[0] ? { deviceBinding: deviceBindings[0] } : {}),
        ...(getString(deviceBindings[0]?.deviceId) ? { deviceId: deviceBindings[0].deviceId } : {}),
      },
    }
  })
}

const getPackagedDocument = (
  manifest: JsonRecord,
  key: keyof SceneFourPackagePayload,
): JsonRecord | undefined => parseOptionalJsonRecord(manifest[key], `$.manifest.${key}`)

/** 在组装前校验分片元数据，避免相同键的后返回内容静默覆盖先返回内容。 */
const validateFragmentKeys = (input: SceneRuntimeFragmentAssemblyInput) => {
  const fragments = [
    input.manifest,
    ...(input.threeDFragments ?? []),
    ...(input.twoDFragments ?? []),
    ...(input.behaviorFragments ?? []),
    ...(input.assetFragments ?? []),
  ]
  /** 分片缓存键由 fragmentType + fragmentKey 组成；不同类型允许复用同一个 fragmentKey。 */
  const seenKeys = new Set<string>()
  const publicationId = input.manifest.publicationId
  for (const fragment of fragments) {
    if (publicationId && fragment.publicationId && fragment.publicationId !== publicationId) {
      throw new Error('分片 publicationId 与清单不一致')
    }
    const key = getString(fragment.fragmentKey)
    if (!key) continue
    const typedKey = `${getString(fragment.fragmentType) ?? 'unknown'}:${key}`
    if (seenKeys.has(typedKey)) throw new Error(`存在重复 fragmentKey：${key}`)
    seenKeys.add(typedKey)
  }
}

/**
 * 把运行态清单和通用分片组装成编辑器/预览可消费的 SceneDefinition。
 *
 * 编辑器和预览传入的标识虽然对应不同数据源，但加载协议相同；本函数只消费接口返回的纯 JSON，
 * 不创建也不接收 Three.js/Cesium 对象。真实 OpenAPI 没有声明 contentJson 的内部结构，因此这里
 * 同时支持设计文档中的 baseConfig/targets/components 结构和后端可能返回的 items 容器。正式 dependencies
 * 会保留在 `settings.dependencies` 供再次保存使用；历史 `sceneRuntimeDependencies` 只在正式包缺失时作为
 * 一次性兼容输入，组装完成后不会再写回三维设置。
 */
export const assembleSceneDefinitionFromRuntimeFragments = (
  input: SceneRuntimeFragmentAssemblyInput,
): SceneDefinition => {
  validateFragmentKeys(input)
  const manifestContent = contentRecord(input.manifest, '$.manifest.contentJson')
  const packagedScene = getPackagedDocument(manifestContent, 'sceneJson')
  const packagedThreeD = getPackagedDocument(manifestContent, 'threeDJson')
  const packagedTwoD = getPackagedDocument(manifestContent, 'twoDJson')
  const packagedDependencies = getPackagedDocument(manifestContent, 'dependenciesJson')

  const sceneContainer = getRecord(packagedScene ?? manifestContent.scene) ?? manifestContent
  const sceneType = getSceneType(manifestContent, sceneContainer, input.options ?? {})
  const threeDSeed = getRecord(packagedThreeD ?? manifestContent.threeD) ?? manifestContent
  const baseConfig = getRecord(threeDSeed.baseConfig) ?? {}
  const twoDSeed = getRecord(packagedTwoD ?? manifestContent.twoD) ?? {}
  const formalDependencySeed = getRecord(packagedDependencies ?? manifestContent.dependencies)
  const historicalDependencySeed = getRecord(
    getRecord(baseConfig.settings)?.sceneRuntimeDependencies,
  )
  /** 正式依赖包存在时绝不混入旧镜像，避免已修复场景因历史脏数据再次串包。 */
  const dependencySeed = formalDependencySeed ?? historicalDependencySeed ?? {}
  /** 正式旧依赖存在时只从该包迁移场景级字段；不存在时才允许读取历史三维镜像。 */
  const legacySceneGlobalSource = formalDependencySeed ?? historicalDependencySeed ?? {}
  const sceneGlobalPackage = readSceneGlobalPackage(sceneContainer, legacySceneGlobalSource)
  const sceneId =
    input.options?.sceneId ??
    getString(manifestContent.sceneId) ??
    getString(input.manifest.publicationId) ??
    ''
  if (!sceneId) throw new Error('运行态清单缺少可用于还原 SceneDefinition 的场景标识')
  const sceneName =
    input.options?.name ??
    getString(sceneContainer.name) ??
    getString(manifestContent.name) ??
    '未命名场景'

  const assetRecords = [
    ...getArray(dependencySeed.resources)
      .map((item) => getRecord(item))
      .filter((item): item is JsonRecord => item !== undefined),
    ...collectFragmentRecords(input.assetFragments, '$.assetFragments'),
  ]
  /**
   * 实例依赖现在是资源描述的正式来源，必须先合并全部依赖再创建资源索引。
   * 该索引同时供三维对象、GIS 图层和二维组件使用，避免只给二维补资源而三维模型仍为空地址。
   */
  const dependencyFragments = collectDependencyFragmentRecords(input.behaviorFragments)
  const dependencyRecords = mergeDependencies(dependencySeed, dependencyFragments, assetRecords)
  const resourceIndex = createResourceIndex(
    dependencyRecords.resources
      .map((item) => getRecord(item))
      .filter((item): item is JsonRecord => item !== undefined),
    input.options?.resolvedAssetUrls,
  )

  const targetRecords = mergeTargets([
    ...getArray(threeDSeed.objects)
      .map((item) => getRecord(item))
      .filter((item): item is JsonRecord => item !== undefined),
    ...getArray(threeDSeed.components)
      .map((item) => getRecord(item))
      .filter((item): item is JsonRecord => item !== undefined),
    ...collectContentRecords(getArray(manifestContent.instances)),
    ...collectFragmentRecords(input.threeDFragments, '$.threeDFragments'),
  ])
  const objects = targetRecords
    .map((target) =>
      toSceneObject(target, sceneType, resourceIndex, input.options?.resolvedAssetUrls),
    )
    .filter((object): object is SceneObject => object !== undefined)
    .sort((left, right) => left.order - right.order)

  const layerRecords = [
    ...getArray(threeDSeed.layers)
      .map((item) => getRecord(item))
      .filter((item): item is JsonRecord => item !== undefined),
    ...getArray(baseConfig.gisLayers)
      .map((item) => getRecord(item))
      .filter((item): item is JsonRecord => item !== undefined),
  ]
  const layers = mergeLayers(
    layerRecords
      .map((layer) => toSceneLayer(layer, resourceIndex))
      .filter((layer): layer is SceneLayer => layer !== undefined),
  )

  const chunkRecords = collectFragmentRoots(input.threeDFragments, '$.threeDFragments')
  const streaming = createStreamingConfig(
    sceneId,
    threeDSeed.streaming ?? baseConfig.streaming,
    chunkRecords,
  )
  const twoDFragment = createTwoDFragment(twoDSeed, input.twoDFragments)
  const rawWidgetComponents = getArray(twoDFragment.components)
    .map((component, index) =>
      toWidget(getRecord(component) ?? {}, index, resourceIndex, input.options?.resolvedAssetUrls),
    )
    .filter((widget): widget is JsonRecord => widget !== undefined)
  const widgetComponents = applyWidgetDependencies(rawWidgetComponents, dependencyRecords)
  const restoredObjects = applyObjectDependencies(objects, dependencyRecords)
  const restoredVegetation = hydrateVegetationDefinition(
    threeDSeed.vegetation,
    resourceIndex,
    input.options?.resolvedAssetUrls,
  )

  const baseSettings = getRecord(baseConfig.settings) ?? {}
  const {
    sceneRuntimeDependencies: _historicalRuntimeDependencies,
    dependencies: _embeddedDependencies,
    ...persistentBaseSettings
  } = baseSettings
  const settings: JsonRecord = {
    /** 历史镜像和内嵌规范依赖都先从三维设置剔除，再在下方写入唯一的规范依赖位置。 */
    ...persistentBaseSettings,
    /**
     * 规范依赖是编辑器再次保存时的唯一内部来源；保存器白名单会明确排除它，因而不会回流 threeD。
     * 运行时地址已经写入 AssetRef，本对象本身仍保持纯 JSON，不包含引擎对象或请求句柄。
     */
    dependencies: dependencyRecords,
    /** 场景级请求定义放在独立规范位置，编辑器可在实例依赖尚未加载时立即恢复。 */
    requestGlobalConfig: sceneGlobalPackage.requestGlobalConfig,
    publicRequests: sceneGlobalPackage.publicRequests,
    sceneActions: sceneGlobalPackage.sceneActions,
    editor: {
      ...(getRecord(persistentBaseSettings.editor) ?? {}),
      widgetSceneFragment: {
        widgets: widgetComponents,
        widgetLayerTree: getArray(twoDFragment.layerTree),
        ...(isRecord(twoDFragment.canvas) && Object.keys(twoDFragment.canvas).length > 0
          ? { widgetCanvas: twoDFragment.canvas }
          : {}),
      },
    },
    ...(getRecord(baseConfig.scene) ? { scene: baseConfig.scene } : {}),
    ...(getRecord(baseConfig.camera) ? { camera: baseConfig.camera } : {}),
    ...(getRecord(baseConfig.weather) ? { weather: baseConfig.weather } : {}),
  }

  const coordinateSystem =
    getRecord(baseConfig.coordinateSystem) ?? getRecord(manifestContent.coordinateSystem)
  const metadata = getRecord(sceneContainer.metadata) ?? getRecord(manifestContent.metadata) ?? {}
  const candidate = {
    id: sceneId,
    name: sceneName,
    type: sceneType,
    coordinateSystem: coordinateSystem ?? createDefaultSceneCoordinateSystem(sceneType),
    objects: restoredObjects,
    ...(streaming ? { streaming } : {}),
    layers,
    effects: Array.isArray(threeDSeed.effects) ? threeDSeed.effects : [],
    settings,
    metadata,
    cameraPaths: Array.isArray(threeDSeed.cameraPaths) ? threeDSeed.cameraPaths : [],
    ...(restoredVegetation ? { vegetation: restoredVegetation } : {}),
    schemaVersion: getNumber(manifestContent.schemaVersion ?? sceneContainer.schemaVersion, 1),
  }

  // 通过核心解析器完成最终的 GIS/local3d 变换校验和默认值归一化，避免组装器维护第二套领域校验。
  return parseSceneDefinition(JSON.stringify(createSceneDefinition(candidate as never)))
}

/** 语义更短的别名，便于编辑器和预览加载适配器按“组装”语义调用。 */
export const assembleSceneDefinitionFromFragments = assembleSceneDefinitionFromRuntimeFragments
