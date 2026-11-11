import { retainOriginalScenePackages } from './twoDPackagePreservation'
import {
  createSceneDefinition,
  parseSceneDefinition,
  type SceneDefinition,
  type SceneRepository,
  type SceneSummary,
} from '@/scene-platform'
import { getDim3dSceneInfo, type Dim3dSceneDetailVo } from '@/servers/manual/dim3d/api/scene'
import { listDim3dVegetationPublicationHistory } from '@/servers/manual/dim3d/api/vegetation'
import { readPublishedVegetationModelUrls } from './importVegetationPublication'
import { appLogger } from '@/utils/logger'
import { assembleSceneDefinitionFromRuntimeFragments } from './sceneRuntimeFragmentAssembler'
import { mergeDataBindingOverflow } from './dataBindingOverflow'
import { recoverKnownSceneDependenciesJson } from './recoverKnownSceneDependencies'
import {
  collectScenePackageResourceReferences,
  resolveSceneAssetUrls,
} from './sceneAssetUrlResolver'

const parseJsonRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value) return null
  if (typeof value === 'string') {
    try {
      return parseJsonRecord(JSON.parse(value))
    } catch {
      return null
    }
  }
  return typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

const resolveSceneType = (value: unknown): 'gis' | 'local3d' =>
  String(value ?? '')
    .toLowerCase()
    .includes('gis')
    ? 'gis'
    : 'local3d'

/**
 * 新接口的 settings_json 保存坐标、相机和环境配置；其中 coordinateSystem 属于
 * SceneDefinition 根字段。读取时拆出坐标系，避免把它错误嵌套在 settings 中导致校验失败。
 */
const splitRevisionSettings = (settings: Record<string, unknown> | null) => {
  if (!settings) return { coordinateSystem: undefined, settings: undefined }
  const { coordinateSystem, ...sceneSettings } = settings
  return { coordinateSystem, settings: sceneSettings }
}

const FOUR_PACKAGE_FIELD_NAMES = [
  'sceneJson',
  'threeDJson',
  'twoDJson',
  'dependenciesJson',
] as const

const VEGETATION_DENSITY_PRESETS = ['high', 'balanced', 'performance'] as const

/**
 * 保存包只保留植被产物的稳定合成编号，真实入口地址由发布接口返回。
 *
 * 在后端尚未提供聚合资源描述前，编辑态重开只能按保存的发布版本读取历史记录补齐地址。
 * 这里仅生成代码已经定义的编号映射，禁止把最新版本、未知图层或未确认字段写入场景。
 */
interface SavedVegetationPublicationResolution {
  urls: Readonly<Record<string, string>>
  /** 当前场景找不到该发布版本时，说明四包来自复制场景，需回退为编辑态配置。 */
  copiedScene: boolean
}

/**
 * 丢弃复制场景继承的植被发布产物，只保留可编辑的植被配置。
 *
 * 发布产物与 sceneId 和发布历史绑定，复制场景不能继续引用源场景的版本；
 * 规则、图层、物种、圈选区域、流式和编辑配置仍属于场景编辑内容，必须保留。
 */
const stripCopiedVegetationPublication = (threeDJson: string): string => {
  const threeD = parseJsonRecord(threeDJson)
  const vegetation = parseJsonRecord(threeD?.vegetation)
  if (!threeD || !vegetation) return threeDJson

  const layers = Array.isArray(vegetation.layers)
    ? vegetation.layers.map((value) => {
        const layer = parseJsonRecord(value)
        if (!layer) return value
        const {
          manifestAsset: _manifestAsset,
          tilesetAsset: _tilesetAsset,
          densityTilesetAssets: _densityTilesetAssets,
          ...authoringLayer
        } = layer
        return authoringLayer
      })
    : vegetation.layers
  const { publication: _publication, ...authoringVegetation } = vegetation

  return JSON.stringify({
    ...threeD,
    vegetation: {
      ...authoringVegetation,
      layers,
    },
  })
}

const resolveSavedVegetationPublicationUrls = async (
  sceneId: string,
  threeDJson: unknown,
  resolvedAssetUrls: Readonly<Record<string, string>>,
): Promise<SavedVegetationPublicationResolution> => {
  const threeD = parseJsonRecord(threeDJson)
  const vegetation = parseJsonRecord(threeD?.vegetation)
  const publication = parseJsonRecord(vegetation?.publication)
  const publicationVersion =
    typeof publication?.version === 'string' && publication.version.trim()
      ? publication.version.trim()
      : ''
  if (!publicationVersion) return { urls: {}, copiedScene: false }

  const publicationManifestAsset = parseJsonRecord(publication?.manifestAsset)
  const publicationTilesetAsset = parseJsonRecord(publication?.tilesetAsset)
  const hasUrl = (value: unknown) => typeof value === 'string' && value.trim().length > 0
  const layerRecords = Array.isArray(vegetation?.layers)
    ? vegetation.layers
        .map((value) => parseJsonRecord(value))
        .filter((value): value is Record<string, unknown> => value !== null)
    : []
  const hasMissingPublicationUrl =
    !hasUrl(publicationManifestAsset?.url) ||
    !hasUrl(publicationTilesetAsset?.url) ||
    layerRecords.some((layer) => {
      const manifestAsset = parseJsonRecord(layer.manifestAsset)
      const tilesetAsset = parseJsonRecord(layer.tilesetAsset)
      const densityAssets = parseJsonRecord(layer.densityTilesetAssets)
      return (
        !hasUrl(manifestAsset?.url) ||
        !hasUrl(tilesetAsset?.url) ||
        (densityAssets !== null &&
          VEGETATION_DENSITY_PRESETS.some((preset) => {
            const asset = parseJsonRecord(densityAssets[preset])
            return !hasUrl(asset?.url)
          }))
      )
    })
  if (!hasMissingPublicationUrl) return { urls: {}, copiedScene: false }

  const history = await listDim3dVegetationPublicationHistory(sceneId)
  const matchedPublication = history.find(
    (item) => item.sceneId === sceneId && item.publicationVersion === publicationVersion,
  )
  if (!matchedPublication) {
    return { urls: {}, copiedScene: true }
  }

  const urls: Record<string, string> = {}
  const manifestId = `vegetation-manifest:${sceneId}:${publicationVersion}`
  const rootTilesetId = `vegetation-tileset:${sceneId}:${publicationVersion}`
  urls[manifestId] = matchedPublication.manifestUrl
  urls[rootTilesetId] = matchedPublication.tilesetUrl

  const unresolvedModels = (Array.isArray(vegetation?.speciesCatalog) ? vegetation.speciesCatalog : [])
    .flatMap(value => {
      const model = parseJsonRecord(parseJsonRecord(value)?.modelAsset)
      const key = typeof model?.id === 'string' ? model.id : ''
      const metadata = parseJsonRecord(model?.metadata)
      const assetId = typeof metadata?.assetId === 'string' ? metadata.assetId : key
      return key && !resolvedAssetUrls[key] && !hasUrl(model?.url) && !hasUrl(metadata?.publicVegetationSource)
        ? [{ key, assetId }] : []
    })
  if (unresolvedModels.length) {
    try {
      const models = await readPublishedVegetationModelUrls(matchedPublication.manifestUrl)
      for (const { key, assetId } of unresolvedModels) {
        const url = models.get(assetId)
        if (url) urls[key] = url
      }
    } catch (error) {
      appLogger.warn('Dim3dSceneRepository', '植被发布清单无法补全物种地址', { sceneId, error })
    }
  }

  layerRecords.forEach((layer) => {
    const layerId = typeof layer.id === 'string' && layer.id.trim() ? layer.id.trim() : ''
    if (!layerId) return
    const layerTilesetUrl =
      matchedPublication.layerTilesetUrls[layerId] ??
      (layerRecords.length === 1 ? matchedPublication.tilesetUrl : undefined)
    urls[`vegetation-manifest:${sceneId}:${publicationVersion}`] = matchedPublication.manifestUrl
    if (layerTilesetUrl) {
      urls[`vegetation-tileset:${sceneId}:${publicationVersion}:${layerId}`] = layerTilesetUrl
    }
    const densityUrls = matchedPublication.layerDensityTilesetUrls?.[layerId]
    VEGETATION_DENSITY_PRESETS.forEach((preset) => {
      const densityUrl = densityUrls?.[preset]
      if (densityUrl) {
        urls[`vegetation-tileset:${sceneId}:${publicationVersion}:${layerId}:${preset}`] =
          densityUrl
      }
    })
  })

  return { urls, copiedScene: false }
}

/**
 * 从当前真实详情接口返回的四包修订恢复 SceneDefinition。
 *
 * 只要后端返回了任意四包字段，就必须要求四包同时存在并整体组装；缺包或坏包直接报错，
 * 禁止继续退化成最小空场景，否则用户会把“后端数据损坏”误认为“场景本来为空”并再次覆盖保存。
 */
// 场景文件导入复用同一恢复链路，确保资源解析、数据依赖和植被复制规则与正常打开一致。
export const parseFourPackageRevision = async (
  detail: Dim3dSceneDetailVo,
  revision: NonNullable<Dim3dSceneDetailVo['currentRevision']>,
  /** 文件导入属于内容复制，直接使用复制场景的植被清理规则，不查询或继承来源发布。 */
  options: { copyVegetation?: boolean } = {},
): Promise<SceneDefinition | null> => {
  const presentFields = FOUR_PACKAGE_FIELD_NAMES.filter(
    (fieldName) => typeof revision[fieldName] === 'string' && revision[fieldName]!.trim(),
  )
  if (presentFields.length === 0) return null
  if (presentFields.length !== FOUR_PACKAGE_FIELD_NAMES.length) {
    const missingFields = FOUR_PACKAGE_FIELD_NAMES.filter(
      (fieldName) => !presentFields.includes(fieldName),
    )
    throw new Error(
      `场景 ${String(detail.sceneId ?? '')} 的当前修订缺少四包字段：${missingFields.join('、')}`,
    )
  }

  try {
    const recoveredDependencies = await recoverKnownSceneDependenciesJson(
      String(detail.sceneId ?? ''),
      String(revision.revisionId ?? ''),
      String(revision.dependenciesJson),
    )
    const mergedDependencies = mergeDataBindingOverflow(
      String(revision.sceneJson),
      recoveredDependencies.json,
    )
    if (recoveredDependencies.recovered || mergedDependencies.merged) {
      appLogger.warn('Dim3dSceneRepository', '已在内存中修复当前场景修订的数据绑定 JSON，请重新保存场景', {
        sceneId: detail.sceneId,
        revisionId: revision.revisionId,
      })
    }
    /**
     * 旧版本保存可能只把市场资源编号写入 threeD/twoD 正文，遗漏 dependencies.resources。
     * 先从两个职责包补采编号，再统一交给资源解析器按 OSS 接口获取最新地址；正文地址不会被读取为
     * 持久化值，也不会回写到四包。
     */
    const resolvedAssetUrls = await resolveSceneAssetUrls(mergedDependencies.dependenciesJson, {
      /**
       * 编辑器打开存量场景时允许个别资产暂时不可用。解析器会保留已经成功补全的地址，
       * 未解析项继续以无地址引用进入 SceneDefinition，由打开提示和保存前校验负责处理，
       * 避免一个坏资源把整份场景降级成空基线。
       */
      allowMissingAssetUrls: true,
      additionalResources: collectScenePackageResourceReferences(
        parseJsonRecord(revision.threeDJson),
        parseJsonRecord(revision.twoDJson),
      ),
    })
    /**
     * 普通模型和图片继续走资源服务；植被发布产物按保存版本从发布历史补齐，避免把合成编号
     * 误送到模型详情接口，也避免用服务端当前最新版本覆盖场景保存版本。
     */
    let savedVegetationUrls: Readonly<Record<string, string>> = {}
    let copiedSceneVegetation = options.copyVegetation === true
    try {
      if (!copiedSceneVegetation) {
        const vegetationPublication = await resolveSavedVegetationPublicationUrls(
          String(detail.sceneId ?? ''),
          revision.threeDJson,
          resolvedAssetUrls,
        )
        savedVegetationUrls = vegetationPublication.urls
        copiedSceneVegetation = vegetationPublication.copiedScene
      }
    } catch (error) {
      /**
       * 植被发布历史是可选的运行时资产补全来源。历史接口暂时不可用时，仍恢复四包
       * 中的场景、二维组件和规则数据；对应植被资产保持缺失状态，不能让一条产物地址
       * 失败清空整份编辑场景。发布版本不存在时由上层按复制场景处理，不改用其他版本。
       */
      appLogger.warn('Dim3dSceneRepository', '植被发布产物地址补全失败，保留场景其余内容', {
        sceneId: detail.sceneId,
        error,
      })
    }
    return assembleSceneDefinitionFromRuntimeFragments({
      manifest: {
        fragmentType: 'manifest',
        fragmentKey: `scene-revision:${String(revision.revisionId ?? detail.sceneId ?? '')}`,
        contentJson: JSON.stringify({
          schemaVersion: revision.schemaVersion,
          sceneJson: revision.sceneJson,
          threeDJson: copiedSceneVegetation
            ? stripCopiedVegetationPublication(String(revision.threeDJson))
            : revision.threeDJson,
          twoDJson: revision.twoDJson,
          dependenciesJson: mergedDependencies.dependenciesJson,
        }),
      },
      options: {
        /**
         * 四包是可复制内容，不再携带场景主键；详情接口返回的 sceneId 是唯一权威来源。
         * 即使旧 sceneJson 中仍残留 id，组装器也必须使用这里注入的当前场景编号。
         */
        sceneId: String(detail.sceneId ?? ''),
        // 管理页改名不一定重写四包，详情名称才是目标管理名称；文件覆盖也沿用同一口径。
        ...(detail.name?.trim() ? { name: detail.name } : {}),
        resolvedAssetUrls: { ...resolvedAssetUrls, ...savedVegetationUrls },
      },
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`场景 ${String(detail.sceneId ?? '')} 的四包修订无法还原：${reason}`)
  }
}

/** 从新场景详情中的版本快照构造编辑器领域对象；不读取旧 projectEngineering 字段。 */
const parseRevision = async (
  detail: Dim3dSceneDetailVo,
  revisionKind: 'current' | 'published',
): Promise<SceneDefinition> => {
  const revision = revisionKind === 'published' ? detail.publishedRevision : detail.currentRevision
  if (revision) {
    // 二维阶段必须在任何字段净化、资源解析前保全原始三维与依赖，保存时按域合并。
    if (FOUR_PACKAGE_FIELD_NAMES.every(key => typeof revision[key] === 'string')) {
      retainOriginalScenePackages(String(detail.sceneId), {
        sceneJson: revision.sceneJson!, threeDJson: revision.threeDJson!,
        twoDJson: revision.twoDJson!, dependenciesJson: revision.dependenciesJson!,
      })
    }
    const fourPackageScene = await parseFourPackageRevision(detail, revision)
    if (fourPackageScene) return fourPackageScene
  }

  /** 四包完全不存在时才兼容早期 definitionJson/settingsJson 详情契约。 */
  const definition = parseJsonRecord(revision?.definitionJson)
  const settings = parseJsonRecord(revision?.settingsJson)
  const splitSettings = splitRevisionSettings(settings)
  const coordinateSystem = definition?.coordinateSystem ?? splitSettings.coordinateSystem
  const candidate: Record<string, unknown> | null = definition
    ? {
        ...definition,
        ...(coordinateSystem ? { coordinateSystem } : {}),
        ...(settings || definition.settings
          ? { settings: splitSettings.settings ?? definition.settings ?? {} }
          : {}),
      }
    : null

  if (candidate) {
    try {
      const parsed = parseSceneDefinition(
        JSON.stringify({
          ...candidate,
          id: String(detail.sceneId ?? ''),
          name: String(detail.name ?? candidate.name ?? '未命名场景'),
          type: resolveSceneType(detail.sceneType ?? candidate.type),
        }),
      )
      return parsed
    } catch {
      // 版本快照字段不完整时使用下方最小场景定义，保证新建场景仍可进入编辑器。
    }
  }

  return createSceneDefinition({
    id: String(detail.sceneId ?? ''),
    name: String(detail.name ?? '未命名场景'),
    type: resolveSceneType(detail.sceneType),
    coordinateSystem:
      resolveSceneType(detail.sceneType) === 'gis'
        ? {
            kind: 'wgs84',
            terrainEnabled: false,
            defaultLongitude: 104.0668,
            defaultLatitude: 30.5728,
            defaultHeight: 0,
          }
        : { kind: 'local', unit: 'meter', upAxis: 'Y', gridEnabled: true },
  })
}

export interface Dim3dSceneRepositoryOptions {
  /** 预览只读取已发布版本，编辑器默认读取当前编辑版本。 */
  revision?: 'current' | 'published'
}

/** 新场景服务仓库：所有场景编号保持字符串，不再兼容旧 Integer 场景接口。 */
export const createDim3dSceneRepository = (
  options: Dim3dSceneRepositoryOptions = {},
): SceneRepository => ({
  save: async () => {
    throw new Error('新场景定义保存接口尚未开放')
  },
  load: async (id) => {
    const response = await getDim3dSceneInfo(id)
    /** 只有明确的业务成功响应才允许构造场景，避免网关空响应被误判为“新建空场景”。 */
    if (response.code !== 200) {
      throw new Error(response.msg?.trim() || `加载场景失败，业务码：${String(response.code)}`)
    }
    // 预览只允许展示已发布版本；没有发布快照时返回空，禁止把编辑草稿误当成公开内容。
    if (options.revision === 'published' && !response.data?.publishedRevision) return null
    // 请求编号是权威身份；过渡接口省略 sceneId 时仍必须按当前编号保全四包。
    return response.data ? await parseRevision({ ...response.data, sceneId: response.data.sceneId || id }, options.revision ?? 'current') : null
  },
  list: async (): Promise<SceneSummary[]> => [],
  delete: async () => undefined,
})
