import { buildDim3dResourceUrl, getDim3dResourceInfo } from '@/servers/manual/dim3d/api/resource'
import { getDim3dOssFileById } from '@/servers/manual/dim3d/api/oss'
import { readImportedVegetationAddress } from './importVegetationPublication'
import type {
  Dim3dPublishedResourceMeta,
  Dim3dVegetationRuntimeResourcesData,
} from '@/servers/manual/dim3d/api/sceneRuntime'

const ASSET_RESOLVE_CONCURRENCY = 8

/**
 * 当前已确认真实读取契约的资源类型。
 * Unity托管模型按编号由Unity鉴权读取，不查询旧文件地址；其它GIS、效果或体数据也由各自运行时处理。
 */
const RESOLVABLE_ASSET_KINDS = new Set(['glb', 'gltf', 'image'])

type JsonRecord = Record<string, unknown>

interface SceneAssetReference {
  /**
   * 场景实例使用的逻辑资源编号集合。
   * 同一份物理资产可能被历史数据或模板重映射成多个 resourceKey，地址查询仍只能执行一次。
   */
  resourceKeys: string[]
  /** 真实资源服务使用的稳定资产编号。 */
  assetId: string
  kind: string
}

export interface SceneAssetUrlResolverOptions {
  /** 已由植被发布资源接口解析出的地址；普通依赖解析失败时优先复用。 */
  knownAssetUrls?: Readonly<Record<string, string>>
  /**
   * 透传给资源接口的请求选项。公开预览可用它清除管理端鉴权头；编辑器恢复保持默认鉴权。
   */
  requestOptions?: Record<string, unknown>
  /**
   * 允许部分资源地址解析失败并返回已成功解析的地址。
   *
   * 编辑器打开存量场景时必须保留可恢复的对象和二维部件；缺失地址会由上层
   * editorSceneAssetValidation 在打开后提示，并在保存前阻止覆盖服务端数据。
   * 发布预览仍使用默认的严格模式，避免生成不完整的只读运行态。
   */
  allowMissingAssetUrls?: boolean
  /**
   * 四包中的对象/组件引用补充项。
   *
   * 历史发布数据可能遗漏 dependencies.resources，但仍在 threeD/twoD 正文保留资源编号；
   * 调用方把这些正文引用传入后，解析器即可兼容旧数据而不需要把临时地址写回保存包。
   */
  additionalResources?: readonly unknown[]
}

const parseJsonRecord = (value: unknown): JsonRecord | null => {
  if (!value) return null
  if (typeof value === 'string') {
    try {
      return parseJsonRecord(JSON.parse(value))
    } catch {
      return null
    }
  }
  return typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null
}

const getNonEmptyString = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

/** 资源接口明确返回了错误类型或不完整元数据时，不能按暂时网络失败静默降级。 */
class NonRecoverableAssetResolutionError extends Error {}

/** 旧创建器生成的对象级回退键不属于资源市场或对象存储，禁止请求真实资源接口。 */
const isLegacyFallbackAssetReference = (resourceKey: string, assetId: string) =>
  resourceKey === assetId && assetId.endsWith(':asset')

/** 内置看板占位资源由前端注册表提供，不属于对象存储资源，不能发起 OSS 查询。 */
const isBuiltinAssetReference = (resourceKey: string) => resourceKey.startsWith('builtin:')

/**
 * 从依赖包提取根资源与多细节层次资源编号。
 * 同一个资源被多个实例引用时只保留一条查询任务，避免重复网络请求。
 */
const collectSceneAssetReferences = (dependenciesJson: unknown): SceneAssetReference[] => {
  const dependencies = parseJsonRecord(dependenciesJson)
  const resources = Array.isArray(dependencies?.resources) ? dependencies.resources : []
  /**
   * 查询缓存按物理 assetId 建立，而不是按 resourceKey 建立。同一资产被多个实例或多个
   * 逻辑资源键复用时，只访问一次资源服务，解析成功后再为所有逻辑键建立运行时别名。
   */
  const references = new Map<string, SceneAssetReference>()

  const append = (
    resourceKey: string | undefined,
    assetId: string | undefined,
    kind: string | undefined,
  ) => {
    const stableAssetId = assetId ?? resourceKey
    if (
      !stableAssetId ||
      !kind ||
      !RESOLVABLE_ASSET_KINDS.has(kind) ||
      stableAssetId.startsWith('unity-model:') ||
      isLegacyFallbackAssetReference(resourceKey ?? stableAssetId, stableAssetId)
    ) {
      return
    }
    const stableResourceKey = resourceKey ?? stableAssetId
    const existing = references.get(stableAssetId)
    if (existing) {
      /** 同一物理编号不允许同时声明为模型和图片，避免因返回顺序不同而调用错误资源域。 */
      if (existing.kind !== kind) {
        throw new Error(`场景资产 ${stableAssetId} 存在冲突资源类型：${existing.kind}、${kind}`)
      }
      if (!existing.resourceKeys.includes(stableResourceKey)) {
        existing.resourceKeys.push(stableResourceKey)
      }
      return
    }
    references.set(stableAssetId, {
      resourceKeys: [stableResourceKey],
      assetId: stableAssetId,
      kind,
    })
  }

  resources.forEach((value) => {
    const resource = parseJsonRecord(value)
    if (!resource) return
    append(
      getNonEmptyString(resource.resourceKey) ?? getNonEmptyString(resource.id),
      getNonEmptyString(resource.assetId),
      getNonEmptyString(resource.kind),
    )

    const lodVariants = Array.isArray(resource.lodVariants) ? resource.lodVariants : []
    lodVariants.forEach((variantValue) => {
      const variant = parseJsonRecord(variantValue)
      append(
        getNonEmptyString(variant?.id),
        getNonEmptyString(variant?.assetId),
        getNonEmptyString(variant?.kind),
      )
    })
  })

  return [...references.values()]
}

/**
 * 直接使用发布预览实例依赖接口返回的资源元数据生成运行时地址索引。
 *
 * 公开与公共带密码预览均只允许使用本函数：模型相对路径在前端拼接文件服务根地址，图片直接
 * 使用响应中的 url。该过程纯内存、无网络请求，不会再访问模型详情或对象存储查询接口。
 */
export const resolvePublishedSceneAssetUrls = (
  dependenciesJson: unknown,
  resourceMetas: readonly Dim3dPublishedResourceMeta[],
  options: Pick<SceneAssetUrlResolverOptions, 'additionalResources' | 'knownAssetUrls'> = {},
): Readonly<Record<string, string>> => {
  const dependencyRecord = parseJsonRecord(dependenciesJson)
  const dependencyResources = Array.isArray(dependencyRecord?.resources)
    ? dependencyRecord.resources
    : []
  const references = collectSceneAssetReferences({
    resources: [...dependencyResources, ...(options.additionalResources ?? [])],
  })
  if (references.length === 0) return {}

  /** 发布级字典按 assetId 一次建索引，避免每个实例、每个逻辑资源键反复扫描元数据数组。 */
  const metaByAssetId = new Map(resourceMetas.map((meta) => [meta.assetId, meta] as const))
  const urls: Record<string, string> = {}
  const failures: string[] = []

  references.forEach((reference) => {
    const meta = metaByAssetId.get(reference.assetId)
    const metaKind = getNonEmptyString(meta?.kind)?.toLowerCase()
    if (metaKind && metaKind !== reference.kind.toLowerCase()) {
      throw new Error(
        `场景资产 ${reference.assetId} 的引用类型 ${reference.kind} 与发布元数据类型 ${metaKind} 不一致`,
      )
    }
    const url = options.knownAssetUrls?.[reference.assetId] ||
      (
      reference.kind === 'image'
        ? getNonEmptyString(meta?.url)
        : reference.kind === 'glb' || reference.kind === 'gltf'
          ? (() => {
              const relativePath = getNonEmptyString(meta?.resourceRelativePath)
              return relativePath ? buildDim3dResourceUrl(relativePath) : undefined
            })()
          : undefined)
    if (!url) {
      failures.push(reference.assetId)
      return
    }
    reference.resourceKeys.forEach((resourceKey) => {
      urls[resourceKey] = url
    })
    urls[reference.assetId] = url
  })

  if (failures.length > 0) {
    throw new Error(`发布预览资源元数据缺少加载地址：${[...new Set(failures)].join('、')}`)
  }
  return urls
}

/**
 * 将公开预览植被资源接口返回的发布入口和资源清单转换为稳定编号地址表。
 *
 * 植被四包只保留 stableId，发布入口由顶层字段按当前快照绑定，模型等补充资源由 resources
 * 按 stableId 关联。地址只供当前预览组装器使用，不回写 threeDJson 或模板数据。
 */
export const resolvePublishedVegetationAssetUrls = (
  threeDContent: unknown,
  response: Dim3dVegetationRuntimeResourcesData,
): Readonly<Record<string, string>> => {
  if (response.code !== 'OK') return {}
  const threeD = parseJsonRecord(threeDContent)
  const vegetation = parseJsonRecord(threeD?.vegetation)
  const publication = parseJsonRecord(vegetation?.publication)
  if (!vegetation || !publication) return {}

  const urls: Record<string, string> = {}
  const appendAssetUrl = (asset: unknown, url: unknown) => {
    const record = parseJsonRecord(asset)
    const id = getNonEmptyString(record?.id) ?? getNonEmptyString(record?.assetId)
    const normalizedUrl = getNonEmptyString(url)
    if (id && normalizedUrl) urls[id] = normalizedUrl
  }

  /** 先绑定发布接口的聚合入口，资源清单中更具体的受控地址随后覆盖同一编号。 */
  appendAssetUrl(publication.manifestAsset, response.manifestUrl)
  appendAssetUrl(publication.tilesetAsset, response.tilesetUrl)

  const layers = Array.isArray(vegetation.layers) ? vegetation.layers : []
  const layerTilesetUrls = response.layerTilesetUrls ?? {}
  const densityTilesetUrls = response.layerDensityTilesetUrls ?? {}
  layers.forEach((layerValue) => {
    const layer = parseJsonRecord(layerValue)
    if (!layer) return
    const layerId = getNonEmptyString(layer.id)
    if (!layerId) return
    appendAssetUrl(layer.manifestAsset, response.manifestUrl)
    appendAssetUrl(
      layer.tilesetAsset,
      layerTilesetUrls[layerId] ?? (layers.length === 1 ? response.tilesetUrl : undefined),
    )
    const layerDensityUrls = densityTilesetUrls[layerId]
    const densityAssets = parseJsonRecord(layer.densityTilesetAssets)
    if (densityAssets) {
      ;(['high', 'balanced', 'performance'] as const).forEach((preset) => {
        appendAssetUrl(densityAssets[preset], layerDensityUrls?.[preset])
      })
    }
  })

  response.resources.forEach((resource) => {
    if (resource.available === false) return
    const controlledAccess = resource.controlledAccess
    const relativeUrl =
      controlledAccess?.mode === 'RELATIVE_PATH'
        ? buildDim3dResourceUrl(controlledAccess.relativePath ?? '')
        : ''
    const url = getNonEmptyString(resource.url) ?? relativeUrl
    if (url) urls[resource.stableId] = url
  })
  return urls
}

/**
 * 从三维/二维正文提取资源市场引用。
 * 这里只读取稳定编号，不读取正文里的 URL，保证市场资源始终通过 OSS 接口获取最新地址。
 */
export const collectScenePackageResourceReferences = (
  ...packages: readonly unknown[]
): JsonRecord[] => {
  const result: JsonRecord[] = []
  const append = (value: unknown) => {
    const record = parseJsonRecord(value)
    if (!record) return
    const appendTarget = (target: unknown) => {
      const item = parseJsonRecord(target)
      if (!item) return
      const targetType = getNonEmptyString(item.targetType) ?? getNonEmptyString(item.componentType)
      const renderConfig = parseJsonRecord(item.renderConfig)
      const isMarketWidget =
        targetType === 'VImage' && getNonEmptyString(renderConfig?.sourceType) === 'resource-market'
      const refs = Array.isArray(item.resourceRefKeys) ? item.resourceRefKeys : []
      if (targetType === 'image' || isMarketWidget)
        refs.forEach((key) => {
          const resourceKey = getNonEmptyString(key)
          if (resourceKey && !isBuiltinAssetReference(resourceKey))
            result.push({ resourceKey, assetId: resourceKey, kind: 'image' })
        })
      if (isMarketWidget) {
        const resourceKey = getNonEmptyString(renderConfig?.resourceKey)
        if (resourceKey && !isBuiltinAssetReference(resourceKey))
          result.push({ resourceKey, assetId: resourceKey, kind: 'image' })
      }
      if (targetType === 'VButton') {
        // 发布态二维正文先到、实例依赖后到；两个背景槽位可直接补充稳定编号参与资源解析。
        const images = parseJsonRecord(renderConfig?.images)
        for (const slot of Object.values(images ?? {})) {
          const image = parseJsonRecord(slot)
          if (getNonEmptyString(image?.sourceType) !== 'resource-market') continue
          const resourceKey = getNonEmptyString(image?.resourceKey)
          if (resourceKey && !isBuiltinAssetReference(resourceKey)) {
            result.push({ resourceKey, assetId: resourceKey, kind: 'image' })
          }
        }
      }
      const content = parseJsonRecord(item.contentJson)
      const billboard = parseJsonRecord(content?.billboard) ?? parseJsonRecord(item.billboard)
      const billboardContent = parseJsonRecord(billboard?.content)
      const blocks = Array.isArray(billboardContent?.blocks) ? billboardContent.blocks : []
      blocks.forEach((block) => {
        const blockRecord = parseJsonRecord(block)
        const resourceKey = getNonEmptyString(blockRecord?.imageResourceKey)
        if (resourceKey && !isBuiltinAssetReference(resourceKey))
          result.push({ resourceKey, assetId: resourceKey, kind: 'image' })
      })
      const appearance = parseJsonRecord(billboard?.appearance)
      const backgroundKey = getNonEmptyString(appearance?.backgroundImageResourceKey)
      if (backgroundKey && !isBuiltinAssetReference(backgroundKey))
        result.push({ resourceKey: backgroundKey, assetId: backgroundKey, kind: 'image' })
    }
    ;['objects', 'components'].forEach((key) => {
      const items = Array.isArray(record[key]) ? record[key] : []
      items.forEach(appendTarget)
    })

    /**
     * 按三维包物种 assetId 补齐树种和 LOD 模型地址，兼容尚未登记原生依赖的历史场景。
     * 这里只提取 GLB/GLTF 物种模型；清单和瓦片属于植被发布资源接口的职责，
     * 不能把合成编号送入普通模型资源接口。
     */
    const vegetation = parseJsonRecord(record.vegetation)
    const speciesCatalog = Array.isArray(vegetation?.speciesCatalog)
      ? vegetation.speciesCatalog
      : []
    speciesCatalog.forEach((speciesValue) => {
      const species = parseJsonRecord(speciesValue)
      const modelAsset = parseJsonRecord(species?.modelAsset)
      const metadata = parseJsonRecord(modelAsset?.metadata)
      if (readImportedVegetationAddress(metadata?.publicVegetationSource)) return
      const resourceKey =
        getNonEmptyString(modelAsset?.resourceKey) ?? getNonEmptyString(modelAsset?.id)
      if (resourceKey?.startsWith('unity-model:')) return
      const assetId = getNonEmptyString(modelAsset?.assetId) ??
        (resourceKey && /^[1-9]\d*$/.test(resourceKey) ? resourceKey : getNonEmptyString(metadata?.assetId) ?? resourceKey)
      const kind = getNonEmptyString(modelAsset?.kind)
      if (resourceKey && assetId && (kind === 'glb' || kind === 'gltf')) {
        result.push({ resourceKey, assetId, kind })
      }
      const variants = Array.isArray(modelAsset?.modelLodVariants) ? modelAsset.modelLodVariants : []
      for (const value of variants) {
        const variant = parseJsonRecord(value)
        const id = getNonEmptyString(variant?.id)
        const variantKind = getNonEmptyString(variant?.kind)
        if (id && (variantKind === 'glb' || variantKind === 'gltf')) result.push({ resourceKey: id, assetId: id, kind: variantKind })
      }
    })
  }
  packages.forEach(append)
  return result
}

/** 模型文件通过资源详情接口解析，且严格校验编号、类型与相对路径。 */
const resolveModelAssetUrl = async (
  assetId: string,
  requestOptions: Record<string, unknown>,
): Promise<string> => {
  const response = await getDim3dResourceInfo(assetId, {
    suppressNotFoundNotification: true,
    ...requestOptions,
  })
  const responseId = getNonEmptyString(response.data?.id)
  const resourceType = getNonEmptyString(response.data?.resourceType)?.toUpperCase()
  const relativePath = getNonEmptyString(response.data?.resourceRelativePath)
  if (
    response.code !== 200 ||
    responseId !== assetId ||
    resourceType !== 'MODEL' ||
    !relativePath
  ) {
    /** 没有返回资源正文时视为暂时缺失；返回了同编号但类型错误的正文则属于数据冲突。 */
    if (response.code === 200 && responseId) {
      throw new NonRecoverableAssetResolutionError(`场景资源地址解析失败：${assetId}`)
    }
    return ''
  }
  return buildDim3dResourceUrl(relativePath)
}

/** 图片和图标通过对象存储编号解析，并对响应数组执行精确编号匹配。 */
const resolveOssAssetUrl = async (
  assetId: string,
  requestOptions: Record<string, unknown>,
): Promise<string> => {
  const response = await getDim3dOssFileById(assetId, {
    suppressNotFoundNotification: true,
    ...requestOptions,
  })
  if (response.code !== 200 || !Array.isArray(response.data)) {
    if (response.code === 200 && response.data !== undefined && response.data !== null) {
      throw new NonRecoverableAssetResolutionError(`场景资源地址解析失败：${assetId}`)
    }
    return ''
  }
  const file = response.data.find((item) => String(item.ossId ?? '').trim() === assetId)
  const url = getNonEmptyString(file?.url)
  /** 返回数组但没有目标编号时按缺失资源处理，不阻断整份编辑场景。 */
  return url ?? ''
}

/**
 * 根据依赖资源描述补全当前会话的运行时地址。
 *
 * 四包和实例依赖都不持久化地址。本函数以固定并发数查询已确认的资源域，同时为 resourceKey
 * 与 assetId 建立映射；返回对象仅供场景组装使用，调用方不得回写任何保存包。
 */
export const resolveSceneAssetUrls = async (
  dependenciesJson: unknown,
  options: SceneAssetUrlResolverOptions = {},
): Promise<Readonly<Record<string, string>>> => {
  const dependencyRecord = parseJsonRecord(dependenciesJson)
  const dependencyResources = Array.isArray(dependencyRecord?.resources)
    ? dependencyRecord.resources
    : []
  const references = collectSceneAssetReferences({
    resources: [...dependencyResources, ...(options.additionalResources ?? [])],
  })
  if (references.length === 0) return {}

  const requestOptions = options.requestOptions ?? {}
  const resolvedUrls: Array<string | undefined> = Array(references.length)
  const failures: string[] = []
  const nonRecoverableFailures: string[] = []
  let cursor = 0

  const worker = async () => {
    while (cursor < references.length) {
      const index = cursor++
      const reference = references[index]
      const assetId = reference.assetId
      try {
        const url =
          reference.kind === 'glb' || reference.kind === 'gltf'
            ? await resolveModelAssetUrl(assetId, requestOptions)
            : reference.kind === 'image'
              ? await resolveOssAssetUrl(assetId, requestOptions)
              : ''
        if (!url) {
          failures.push(assetId)
          continue
        }
        resolvedUrls[index] = url
      } catch (error) {
        if (error instanceof NonRecoverableAssetResolutionError) {
          nonRecoverableFailures.push(assetId)
        } else {
          failures.push(assetId)
        }
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(ASSET_RESOLVE_CONCURRENCY, references.length) }, worker),
  )
  if (nonRecoverableFailures.length > 0) {
    throw new Error(
      `场景资源地址解析失败：${[...new Set(nonRecoverableFailures)].join('、')}`,
    )
  }
  if (failures.length > 0 && !options.allowMissingAssetUrls) {
    throw new Error(`场景资源地址解析失败：${[...new Set(failures)].join('、')}`)
  }

  const urls: Record<string, string> = {}
  resolvedUrls.forEach((url, index) => {
    if (!url) return
    const reference = references[index]
    /** 同时登记逻辑资源键和物理资产键，组装器可兼容 resourceKey 与 assetId 不同的历史数据。 */
    reference.resourceKeys.forEach((resourceKey) => {
      urls[resourceKey] = url
    })
    urls[reference.assetId] = url
  })
  return urls
}
