import request from '@/request.ts'
import type {
  SceneDefinition,
  SceneLayer,
  SceneStreamingConfig,
  SceneStreamingRuntimeOverrides,
} from '@/scene-platform/core/types'
import { getDim3dRequestOptions } from './auth'
import { DIM3D_API_PREFIX } from './constants'
import { createSceneFourPackageDocuments } from '@/integrations/scene/sceneFourPackage'

/**
 * 场景类型。`gis` 表示地理信息场景，`local3d` 表示局部三维场景。
 * 两种场景共用同一套保存和运行态读取接口，区别只体现在场景数据及清单内容。
 */
export type Dim3dSceneType = 'gis' | 'local3d'

/** 运行态分片内容的最小 JSON 对象类型；具体字段由后端编译版本决定。 */
export type Dim3dJsonObject = Record<string, unknown>

/** 后端四包外层中的场景容器，字段名与 44 号设计文档保持一致。 */
export interface Dim3dSceneContainer {
  name: string
  sceneType: Dim3dSceneType
  domainSlots: {
    twoD: 'present'
    threeD: 'present'
  }
  /** 场景级请求配置和公共接口随 sceneJson 首包返回。 */
  requestGlobalConfig: Dim3dJsonObject
  publicRequests: unknown[]
  /** 没有实例拥有者的场景动作，不能下沉为实例行为。 */
  sceneActions: unknown[]
}

/** 三维对象的后端轻量索引结构；私有属性统一收纳在 contentJson。 */
export interface Dim3dThreeDTarget {
  instanceId: string
  targetType: string
  name?: string
  visible: boolean
  locked: boolean
  layerKey?: string
  sortNo: number
  transform: unknown
  resourceRefKeys: string[]
  contentJson: Dim3dJsonObject
}

/** 三维图层的后端结构化投影。 */
export interface Dim3dThreeDLayer {
  layerKey: string
  layerType: SceneLayer['type']
  name: string
  visible: boolean
  locked: boolean
  sortNo: number
  provider?: string
  url?: string
  resourceRefKeys?: string[]
  options?: Dim3dJsonObject
  metadata?: Dim3dJsonObject
}

/** 三维流式配置，区块目标单独展开，避免运行时再次遍历完整对象包。 */
export interface Dim3dThreeDStreaming {
  groups: Dim3dJsonObject[]
  chunks: Dim3dJsonObject[]
  chunkTargets: Dim3dJsonObject[]
  options?: SceneStreamingConfig['options']
  runtimeOverrides?: SceneStreamingRuntimeOverrides
}

/** 按设计文档组织的三维包。组件和植被均保留为独立字段，禁止混入普通对象。 */
export interface Dim3dThreeDPackage {
  baseConfig: Dim3dJsonObject
  objects: Dim3dThreeDTarget[]
  components: unknown[]
  layers: Dim3dThreeDLayer[]
  streaming: Dim3dThreeDStreaming
  cameraPaths: unknown[]
  effects?: unknown[]
  vegetation?: Dim3dJsonObject
}

/** 二维包的最小结构；调用方可通过扩展字段保留现有二维画布及组件配置。 */
export interface Dim3dTwoDPackage {
  canvas: Dim3dJsonObject
  components: unknown[]
  layerTree: unknown[]
  [key: string]: unknown
}

/** 依赖包的固定顶层字段；运行时值、令牌和临时资源地址不得写入此包。 */
export interface Dim3dDependenciesPackage {
  resources: unknown[]
  dataBindings: unknown[]
  behaviors: unknown[]
  deviceBindings: unknown[]
  [key: string]: unknown
}

/** 四包的结构化表示，适合编辑器保存前检查和重新读取。 */
export interface Dim3dScenePackages {
  schemaVersion: number
  scene: Dim3dSceneContainer
  threeD: Dim3dThreeDPackage
  twoD: Dim3dTwoDPackage
  dependencies: Dim3dDependenciesPackage
}

/** 允许编辑器补充二维、依赖和三维组件数据；场景编号单独放在 saveAll 请求顶层。 */
export interface Dim3dScenePackageConversionInput {
  scene: SceneDefinition
  twoD?: Partial<Dim3dTwoDPackage>
  dependencies?: Partial<Dim3dDependenciesPackage>
  threeD?: Partial<Dim3dThreeDPackage>
}

/** `saveAll` 的真实请求体；四包字段必须是 JSON 字符串，而不是嵌套对象。 */
export interface Dim3dSceneSaveAllBody {
  sceneId: string
  lockToken: string
  requestId?: string
  baseRevisionNo?: number
  schemaVersion?: number
  sceneJson: string
  threeDJson: string
  twoDJson: string
  dependenciesJson: string
  changeSummary?: string
}

/** 保存接口返回的书签；编号字段统一在适配层归一化为字符串。 */
export interface Dim3dSceneSaveResult {
  sceneId?: string
  revisionId?: string
  revisionNo?: number
  lockVersion?: number
  savedTime?: string
  conflict?: boolean
  conflictRevisionNo?: number
}

/** 保存接口通用响应。业务码和原始消息不在适配层改写。 */
export interface Dim3dSceneSaveAllResponse {
  code?: number
  msg?: string
  data?: Dim3dSceneSaveResult
}

/** 后端运行态分片的原始字段，严格保留真实字段名 `publicationId`。 */
export interface Dim3dPublishedFragment {
  publicationId?: string
  fragmentType?: string
  fragmentKey?: string
  contentJson?: string
  contentHash?: string
}

/** 启动清单接口的真实响应结构。 */
export interface Dim3dPublishedManifestResponse {
  code?: number
  msg?: string
  data?: Dim3dPublishedFragment
}

/** 运行时内部统一使用的分片列表结构；当前由实例依赖接口适配器复用。 */
export interface Dim3dPublishedFragmentListResponse {
  code?: number
  msg?: string
  data?: Dim3dPublishedFragment[]
  /**
   * 实例依赖接口随批次返回的发布级资源元数据字典。
   * 该字段只供运行时解析地址，不会写回四包或场景保存接口。
   */
  resourceMetas?: Dim3dPublishedResourceMeta[]
}

/**
 * 发布预览实例依赖接口返回的资源加载元数据。
 * 模型使用 resourceRelativePath，图片使用 url；assetId 在同一发布版本内全局唯一。
 */
export interface Dim3dPublishedResourceMeta {
  assetId: string
  kind?: string
  resourceName?: string
  resourceType?: string
  resourceFormat?: string
  assetName?: string
  resourceRelativePath?: string
  url?: string
  originalName?: string
  fileSuffix?: string
}

/** 公开预览植被资源的受控访问描述；相对路径由前端按既有文件服务根地址解析。 */
export interface Dim3dVegetationControlledAccess {
  mode?: string
  relativePath?: string
  resourceName?: string
  resourceType?: string
  resourceFormat?: string
  assetName?: string
}

/** 植被发布资源清单中的单项资源。稳定编号必须与 threeDJson.vegetation 原样一致。 */
export interface Dim3dVegetationRuntimeResource {
  resourceType?:
    | 'SPECIES_MODEL'
    | 'PUBLICATION_MANIFEST'
    | 'PUBLICATION_TILESET'
    | 'LAYER_MANIFEST'
    | 'LAYER_TILESET'
    | 'LAYER_DENSITY_TILESET'
    | 'INCREMENTAL_ASSET'
    | 'SUB_RESOURCE'
    | string
  stableId: string
  referencePath?: string
  kind?: string
  publicationVersion?: string | null
  contentHash?: string | null
  layerId?: string | null
  densityTier?: string | null
  parentStableId?: string | null
  url?: string | null
  subResourceBase?: string | null
  expiresAt?: string | null
  controlledAccess?: Dim3dVegetationControlledAccess | null
  available?: boolean
  unavailableReason?: string | null
}

/** 公开预览植被资源接口的机器结果码。 */
export type Dim3dVegetationRuntimeResourcesCode =
  | 'OK'
  | 'NO_VEGETATION'
  | 'NOT_READY'
  | 'VERSION_MISMATCH'
  | 'RESOURCE_MISSING'
  | 'TICKET_INVALID'
  | 'TICKET_EXPIRED'
  | 'FORBIDDEN'
  | 'PUBLICATION_NOT_FOUND'

/** 公开预览植被资源接口返回的数据主体。 */
export interface Dim3dVegetationRuntimeResourcesData {
  code: Dim3dVegetationRuntimeResourcesCode
  message?: string | null
  publicationId: string
  sceneId?: string
  taskId?: string
  status?: string
  publicationVersion?: string
  ruleVersion?: string
  generatorVersion?: string
  sourceHash?: string
  manifestUrl?: string
  tilesetUrl?: string
  layerTilesetUrls?: Record<string, string>
  layerDensityTilesetUrls?: Record<
    string,
    Partial<Record<'high' | 'balanced' | 'performance', string>>
  >
  instanceCount?: number | string
  tileCount?: number | string
  densityProfiles?: Record<string, Record<string, unknown>>
  resources: Dim3dVegetationRuntimeResource[]
  versionMismatches: Array<Record<string, unknown>>
  warnings: string[]
}

/** 公开预览植被资源接口的真实响应外层。 */
export interface Dim3dVegetationRuntimeResourcesResponse {
  code?: number
  msg?: string
  data?: unknown
}

/**
 * 发布预览完整包及实例依赖接口的通用响应容器。
 *
 * 四份真实开放接口规范都使用 `{ code, msg, data }` 外层；不同接口的 `data` 结构由下方
 * 专用类型和归一化函数校验，禁止继续接受旧分片响应作为兼容输入。
 */
export interface Dim3dPublishedPackageResponse {
  code?: number
  msg?: string
  data?: unknown
}

/** 场景基础、三维、二维三个完整包在真实接口中的响应数据。 */
interface Dim3dPublishedPackageData {
  publicationId?: string
  sceneId?: string
  sceneType?: Dim3dSceneType | null
  sceneJson?: string
  threeDJson?: string
  twoDJson?: string
}

/** 单个实例的真实依赖响应；四类数组元素均为后端保留的单条 JSON 原文。 */
interface Dim3dPublishedDependencyItem {
  instanceId?: string
  resources?: unknown
  dataBindings?: unknown
  behaviors?: unknown
  deviceBindings?: unknown
}

/** 实例依赖接口真实响应数据，items 按全局唯一实例编号聚合。 */
interface Dim3dPublishedDependenciesData {
  publicationId?: string
  items?: unknown
  resourceMetas?: unknown
}

/** 预览会话解析结果；resultCode 是机器码，页面不得根据 msg 文案推断访问分支。 */
export type Dim3dPreviewResolveResultCode =
  | 'OK'
  | 'NOT_FOUND'
  | 'NOT_PUBLISHED'
  | 'EXPIRED'
  | 'NEED_LOGIN'
  | 'NEED_PASSWORD'
  | 'NO_PERMISSION'

/** 公开预览和受限预览共用的访问模式编码。 */
export type Dim3dPreviewAccessMode = 'PUBLIC_SHARE' | 'PUBLIC_ENCRYPT' | 'PERSONAL' | 'ENTERPRISE'

export interface Dim3dScenePreviewResolveData {
  resultCode?: Dim3dPreviewResolveResultCode
  /** 非 OK 响应会按真实接口契约返回一组 null 元数据，调用方只能在 OK 分支消费这些字段。 */
  sceneId?: string | number | null
  sceneCode?: string | null
  accessMode?: Dim3dPreviewAccessMode | null
  tenantId?: string | number | null
  needPassword?: boolean | null
  publicationId?: string | number | null
  ticket?: string | null
}

export interface Dim3dScenePreviewResolveResponse {
  code?: number
  msg?: string
  data?: Dim3dScenePreviewResolveData
}

/** 解析后的分片，content 是 contentJson 解析结果，不改变后端原始字段。 */
export interface Dim3dParsedPublishedFragment<T = unknown> extends Dim3dPublishedFragment {
  content: T
}

/** 按 fragmentKey 建立的不可变本地索引，避免相机移动或组件激活时重复解析 JSON。 */
export interface Dim3dPublishedFragmentIndex {
  readonly [fragmentKey: string]: Dim3dParsedPublishedFragment
}

/** 清单内容中能够识别出的场景类型。后端未返回时保持 undefined，不擅自猜测。 */
export interface Dim3dSceneRuntimeSnapshot {
  publicationId: string
  sceneType?: Dim3dSceneType
  manifest: Dim3dParsedPublishedFragment
  threeDChunks: Dim3dPublishedFragmentIndex
  twoDFragments: Dim3dPublishedFragmentIndex
  behaviors: Dim3dPublishedFragmentIndex
  assets: Dim3dPublishedFragmentIndex
}

/** 请求适配层只接收额外请求选项，方法、鉴权头和 JSON 类型由本文件统一控制。 */
export type Dim3dSceneRuntimeRequestOptions = Record<string, unknown>

/** 只接受普通对象，防止把响应对象、数组或引擎实例误当作四包内容。 */
const isRecord = (value: unknown): value is Dim3dJsonObject => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** 长整型编号统一转成字符串；不安全数字直接拒绝，避免精度已经丢失后继续传递。 */
const normalizeLongId = (value: unknown, fieldName: string): string => {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  throw new Error(`${fieldName} 必须是非空字符串长整型编号。`)
}

/**
 * 归一化预览解析返回的发布编号。
 *
 * 预览入口只持有编辑场景 `sceneId`，发布编号必须从 resolve 成功响应取得。若旧网关把
 * `int64 publicationId` 错误序列化为 JSON 数字，浏览器解析后会丢失低位精度，前端不能
 * 用编辑场景编号冒充发布编号，因此对超出安全范围的数字直接拒绝，避免请求错误分片。
 */
const normalizePreviewPublicationId = (value: unknown, fallbackPublicationId: string): string => {
  if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) {
    if (fallbackPublicationId) return fallbackPublicationId
    throw new Error('publicationId 返回为不安全数字，后端必须按字符串传输长整型编号。')
  }
  return normalizeLongId(value, 'publicationId')
}

/** 规范化路径参数，禁止以 number 作为公开接口入参，确保长整型不会先经过不安全转换。 */
const normalizePublicationId = (publicationId: string): string =>
  normalizeLongId(publicationId, 'publicationId')

/** 校验批量接口的字符串数组；数组可以为空，但不能含空字符串或非字符串值。 */
const normalizeKeyList = (keys: readonly string[], fieldName: string): string[] => {
  if (!Array.isArray(keys)) throw new Error(`${fieldName} 必须是字符串数组。`)
  return keys.map((key, index) => {
    if (typeof key !== 'string' || !key.trim()) {
      throw new Error(`${fieldName}[${index}] 必须是非空字符串。`)
    }
    return key.trim()
  })
}

/** 将响应中的编号字段归一化为字符串，兼容网关偶尔返回安全范围内数字的情况。 */
const normalizePublishedFragment = (fragment: Dim3dPublishedFragment): Dim3dPublishedFragment => ({
  ...fragment,
  ...(fragment.publicationId === undefined
    ? {}
    : { publicationId: normalizeLongId(fragment.publicationId, 'publicationId') }),
})

/**
 * 将完整发布包统一包装为运行态内部使用的 fragment 形态。
 *
 * 组装器只需要一个纯 JSON 输入边界；真实接口固定通过 `data.sceneJson`、
 * `data.threeDJson`、`data.twoDJson` 返回原文，因此在这一层严格校验，避免错误响应
 * 被包装成可运行的空场景。GIS 与非 GIS 后续仍共用同一个组装入口。
 */
const normalizePublishedPackageResponse = (
  response: Dim3dPublishedPackageResponse,
  publicationId: string,
  packageField: 'sceneJson' | 'threeDJson' | 'twoDJson',
  fragmentType: 'sceneBasic' | 'threeD' | 'twoD',
): Dim3dPublishedManifestResponse => {
  const data = response.data
  if (data === undefined || data === null) return { code: response.code, msg: response.msg }
  if (!isRecord(data)) throw new Error(`${fragmentType} 接口 data 必须是对象。`)
  const packageData = data as Dim3dPublishedPackageData
  const contentJson = packageData[packageField]
  if (typeof contentJson !== 'string' || !contentJson.trim()) {
    throw new Error(`${fragmentType} 接口缺少非空 ${packageField} 字符串。`)
  }
  return {
    ...response,
    data: {
      publicationId,
      fragmentType,
      fragmentKey: `${publicationId}:${fragmentType}`,
      contentJson,
    },
  }
}

/**
 * 解析真实实例依赖中的单类 JSON 字符串数组。
 *
 * 后端按实例聚合但保留每条依赖原文。这里一次线性遍历完成解析并要求结果为对象，
 * 既避免组装阶段重复 JSON.parse，也防止非法条目被当成“该实例没有依赖”静默丢失。
 */
const parsePublishedDependencyEntries = (value: unknown, label: string): Dim3dJsonObject[] => {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error(`${label} 必须是 JSON 字符串数组。`)
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || !entry.trim()) {
      throw new Error(`${label}[${index}] 必须是非空 JSON 字符串。`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(entry)
    } catch (error) {
      throw new Error(`${label}[${index}] 不是合法 JSON：${String(error)}`)
    }
    if (!isRecord(parsed)) throw new Error(`${label}[${index}] 必须解析为 JSON 对象。`)
    return parsed
  })
}

/**
 * 真实依赖接口返回 `data.items[]`，每项按 instanceId 聚合四类 JSON 字符串数组。
 * 前端在接口适配边界完成严格解析并包装成内部依赖片段，后续统一组装器仍按 owner
 * 恢复二维与三维实例，不要求后端生成旧 fragmentKey/contentJson 协议。
 */
const normalizePublishedDependencyResponse = (
  response: Dim3dPublishedPackageResponse,
  publicationId: string,
): Dim3dPublishedFragmentListResponse => {
  const data = response.data
  if (data === undefined || data === null) return { ...response, data: [] }
  if (!isRecord(data)) throw new Error('实例依赖接口 data 必须是对象。')
  const dependenciesData = data as Dim3dPublishedDependenciesData
  if (!Array.isArray(dependenciesData.items)) {
    throw new Error('实例依赖接口缺少 items 数组。')
  }
  /**
   * 最新公开预览契约将该发布引用的资源元数据一次性放在 resourceMetas 中。
   * 这里只做严格结构校验和字符串净化，不拼接地址，也不把运行时字段混入依赖条目原文。
   */
  const rawResourceMetas = dependenciesData.resourceMetas
  if (rawResourceMetas !== undefined && !Array.isArray(rawResourceMetas)) {
    throw new Error('实例依赖接口 resourceMetas 必须是数组。')
  }
  const resourceMetaIndex = new Map<string, Dim3dPublishedResourceMeta>()
  ;(rawResourceMetas ?? []).forEach((value, index) => {
    if (!isRecord(value)) throw new Error(`实例依赖 resourceMetas[${index}] 必须是对象。`)
    const assetId = typeof value.assetId === 'string' ? value.assetId.trim() : ''
    if (!assetId) throw new Error(`实例依赖 resourceMetas[${index}] 缺少非空 assetId。`)
    if (resourceMetaIndex.has(assetId)) {
      throw new Error(`实例依赖 resourceMetas 存在重复 assetId：${assetId}`)
    }
    const pickString = (key: keyof Dim3dPublishedResourceMeta) => {
      const field = value[key]
      return typeof field === 'string' && field.trim() ? field.trim() : undefined
    }
    resourceMetaIndex.set(assetId, {
      assetId,
      ...(pickString('kind') ? { kind: pickString('kind') } : {}),
      ...(pickString('resourceName') ? { resourceName: pickString('resourceName') } : {}),
      ...(pickString('resourceType') ? { resourceType: pickString('resourceType') } : {}),
      ...(pickString('resourceFormat') ? { resourceFormat: pickString('resourceFormat') } : {}),
      ...(pickString('assetName') ? { assetName: pickString('assetName') } : {}),
      ...(pickString('resourceRelativePath')
        ? { resourceRelativePath: pickString('resourceRelativePath') }
        : {}),
      ...(pickString('url') ? { url: pickString('url') } : {}),
      ...(pickString('originalName') ? { originalName: pickString('originalName') } : {}),
      ...(pickString('fileSuffix') ? { fileSuffix: pickString('fileSuffix') } : {}),
    })
  })
  return {
    ...response,
    resourceMetas: [...resourceMetaIndex.values()],
    data: dependenciesData.items.map((value, index) => {
      if (!isRecord(value)) throw new Error(`实例依赖 items[${index}] 必须是对象。`)
      const item = value as Dim3dPublishedDependencyItem
      const instanceId = typeof item.instanceId === 'string' ? item.instanceId.trim() : ''
      if (!instanceId) throw new Error(`实例依赖 items[${index}] 缺少非空 instanceId。`)
      const content = {
        instanceId,
        resources: parsePublishedDependencyEntries(item.resources, `items[${index}].resources`),
        dataBindings: parsePublishedDependencyEntries(
          item.dataBindings,
          `items[${index}].dataBindings`,
        ),
        behaviors: parsePublishedDependencyEntries(item.behaviors, `items[${index}].behaviors`),
        deviceBindings: parsePublishedDependencyEntries(
          item.deviceBindings,
          `items[${index}].deviceBindings`,
        ),
      }
      return {
        publicationId,
        fragmentType: 'behavior',
        fragmentKey: `instance:${instanceId}`,
        contentJson: JSON.stringify(content),
      }
    }),
  }
}

const VEGETATION_RUNTIME_RESOURCE_CODES = new Set<Dim3dVegetationRuntimeResourcesCode>([
  'OK',
  'NO_VEGETATION',
  'NOT_READY',
  'VERSION_MISMATCH',
  'RESOURCE_MISSING',
  'TICKET_INVALID',
  'TICKET_EXPIRED',
  'FORBIDDEN',
  'PUBLICATION_NOT_FOUND',
])

/** 读取植被资源响应中的可选字符串；空字符串统一视为缺失。 */
const readOptionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

/** 归一化植被资源清单中的受控访问对象，避免把未知字段直接带入运行时。 */
const normalizeVegetationControlledAccess = (
  value: unknown,
): Dim3dVegetationControlledAccess | null | undefined => {
  if (value === null || value === undefined) return value === null ? null : undefined
  if (!isRecord(value)) throw new Error('植被资源 controlledAccess 必须是对象。')
  const read = (key: keyof Dim3dVegetationControlledAccess) => readOptionalString(value[key])
  return {
    ...(read('mode') ? { mode: read('mode') } : {}),
    ...(read('relativePath') ? { relativePath: read('relativePath') } : {}),
    ...(read('resourceName') ? { resourceName: read('resourceName') } : {}),
    ...(read('resourceType') ? { resourceType: read('resourceType') } : {}),
    ...(read('resourceFormat') ? { resourceFormat: read('resourceFormat') } : {}),
    ...(read('assetName') ? { assetName: read('assetName') } : {}),
  }
}

/** 归一化单条植被运行时资源，保留不可用占位项供上层给出明确错误。 */
const normalizeVegetationRuntimeResource = (
  value: unknown,
  index: number,
): Dim3dVegetationRuntimeResource => {
  if (!isRecord(value)) throw new Error(`植被资源 resources[${index}] 必须是对象。`)
  const stableId = readOptionalString(value.stableId)
  if (!stableId) throw new Error(`植被资源 resources[${index}] 缺少stableId。`)
  const read = (key: keyof Dim3dVegetationRuntimeResource) => readOptionalString(value[key])
  return {
    ...(read('resourceType') ? { resourceType: read('resourceType') } : {}),
    stableId,
    ...(read('referencePath') ? { referencePath: read('referencePath') } : {}),
    ...(read('kind') ? { kind: read('kind') } : {}),
    ...(Object.prototype.hasOwnProperty.call(value, 'publicationVersion')
      ? { publicationVersion: read('publicationVersion') ?? null }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(value, 'contentHash')
      ? { contentHash: read('contentHash') ?? null }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(value, 'layerId')
      ? { layerId: read('layerId') ?? null }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(value, 'densityTier')
      ? { densityTier: read('densityTier') ?? null }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(value, 'parentStableId')
      ? { parentStableId: read('parentStableId') ?? null }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(value, 'url') ? { url: read('url') ?? null } : {}),
    ...(Object.prototype.hasOwnProperty.call(value, 'subResourceBase')
      ? { subResourceBase: read('subResourceBase') ?? null }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(value, 'expiresAt')
      ? { expiresAt: read('expiresAt') ?? null }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(value, 'controlledAccess')
      ? { controlledAccess: normalizeVegetationControlledAccess(value.controlledAccess) }
      : {}),
    ...(typeof value.available === 'boolean' ? { available: value.available } : {}),
    ...(Object.prototype.hasOwnProperty.call(value, 'unavailableReason')
      ? { unavailableReason: read('unavailableReason') ?? null }
      : {}),
  }
}

/** 归一化图层入口字典，避免把非字符串值当作可加载地址。 */
const normalizeVegetationUrlMap = (value: unknown, fieldName: string) => {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) throw new Error(`植被资源 ${fieldName} 必须是对象。`)
  const result: Record<string, string> = {}
  Object.entries(value).forEach(([key, item]) => {
    const normalizedKey = key.trim()
    const normalizedValue = readOptionalString(item)
    if (normalizedKey && normalizedValue) result[normalizedKey] = normalizedValue
  })
  return result
}

/** 校验并归一化公开预览植被资源响应，同时绑定请求中的发布快照编号。 */
const normalizeVegetationRuntimeResourcesResponse = (
  response: Dim3dVegetationRuntimeResourcesResponse,
  publicationId: string,
): Dim3dVegetationRuntimeResourcesData => {
  if (response.code !== undefined && response.code !== 200) {
    throw new Error(
      response.msg?.trim() || `植被运行时资源请求失败，业务码：${String(response.code)}`,
    )
  }
  if (!isRecord(response.data)) throw new Error('植被运行时资源接口缺少data对象。')
  const data = response.data
  const code = readOptionalString(data.code)
  if (
    !code ||
    !VEGETATION_RUNTIME_RESOURCE_CODES.has(code as Dim3dVegetationRuntimeResourcesCode)
  ) {
    throw new Error(`植被运行时资源接口返回未知结果码：${String(code)}`)
  }
  const responsePublicationId = normalizeLongId(data.publicationId, '植被资源publicationId')
  if (responsePublicationId !== publicationId) {
    throw new Error('植被运行时资源响应的publicationId与当前预览不一致。')
  }
  if (!Array.isArray(data.resources)) {
    throw new Error('植被运行时资源接口 resources 必须是数组。')
  }
  const resources = data.resources.map(normalizeVegetationRuntimeResource)
  const resourceIds = new Set<string>()
  resources.forEach((resource) => {
    if (resourceIds.has(resource.stableId)) {
      throw new Error(`植被运行时资源存在重复stableId：${resource.stableId}`)
    }
    resourceIds.add(resource.stableId)
  })
  const versionMismatches = data.versionMismatches
  if (versionMismatches !== undefined && !Array.isArray(versionMismatches)) {
    throw new Error('植被运行时资源 versionMismatches 必须是数组。')
  }
  const warnings = data.warnings
  if (warnings !== undefined && !Array.isArray(warnings)) {
    throw new Error('植被运行时资源 warnings 必须是数组。')
  }
  const normalizedWarnings = (warnings ?? []).map((warning, index) => {
    const normalized = readOptionalString(warning)
    if (!normalized) throw new Error(`植被运行时资源 warnings[${index}] 必须是非空字符串。`)
    return normalized
  })
  const read = (key: string) => readOptionalString(data[key])
  return {
    code: code as Dim3dVegetationRuntimeResourcesCode,
    ...(read('message') ? { message: read('message') } : {}),
    publicationId: responsePublicationId,
    ...(read('sceneId') ? { sceneId: read('sceneId') } : {}),
    ...(read('taskId') ? { taskId: read('taskId') } : {}),
    ...(read('status') ? { status: read('status') } : {}),
    ...(read('publicationVersion') ? { publicationVersion: read('publicationVersion') } : {}),
    ...(read('ruleVersion') ? { ruleVersion: read('ruleVersion') } : {}),
    ...(read('generatorVersion') ? { generatorVersion: read('generatorVersion') } : {}),
    ...(read('sourceHash') ? { sourceHash: read('sourceHash') } : {}),
    ...(read('manifestUrl') ? { manifestUrl: read('manifestUrl') } : {}),
    ...(read('tilesetUrl') ? { tilesetUrl: read('tilesetUrl') } : {}),
    ...(normalizeVegetationUrlMap(data.layerTilesetUrls, 'layerTilesetUrls')
      ? { layerTilesetUrls: normalizeVegetationUrlMap(data.layerTilesetUrls, 'layerTilesetUrls') }
      : {}),
    ...(data.layerDensityTilesetUrls !== undefined
      ? {
          layerDensityTilesetUrls:
            data.layerDensityTilesetUrls as Dim3dVegetationRuntimeResourcesData['layerDensityTilesetUrls'],
        }
      : {}),
    ...(typeof data.instanceCount === 'number' || typeof data.instanceCount === 'string'
      ? { instanceCount: data.instanceCount }
      : {}),
    ...(typeof data.tileCount === 'number' || typeof data.tileCount === 'string'
      ? { tileCount: data.tileCount }
      : {}),
    ...(isRecord(data.densityProfiles)
      ? { densityProfiles: data.densityProfiles as Record<string, Record<string, unknown>> }
      : {}),
    resources,
    versionMismatches: (versionMismatches ?? []).filter(isRecord),
    warnings: normalizedWarnings,
  }
}

/** 读取发布快照中的场景基础包；后端只返回 sceneJson 原文，不做字段投影。 */
export async function getDim3dPublishedSceneBasic(
  publicationId: string,
  options: Dim3dSceneRuntimeRequestOptions = {},
) {
  const response = await sceneRuntimeRequest<Dim3dPublishedPackageResponse>(
    `/dim3d/scene/published/${encodeURIComponent(normalizePublicationId(publicationId))}/sceneBasic`,
    'GET',
    options,
  )
  return normalizePublishedPackageResponse(
    response,
    normalizePublicationId(publicationId),
    'sceneJson',
    'sceneBasic',
  )
}

/** 读取发布快照中的完整三维包；GIS 与非 GIS 场景共用此接口。 */
export async function getDim3dPublishedThreeD(
  publicationId: string,
  options: Dim3dSceneRuntimeRequestOptions = {},
) {
  const response = await sceneRuntimeRequest<Dim3dPublishedPackageResponse>(
    `/dim3d/scene/published/${encodeURIComponent(normalizePublicationId(publicationId))}/threeD`,
    'GET',
    options,
  )
  return normalizePublishedPackageResponse(
    response,
    normalizePublicationId(publicationId),
    'threeDJson',
    'threeD',
  )
}

/** 读取发布快照中的完整二维包；二维画布配置与组件结构一次性恢复。 */
export async function getDim3dPublishedTwoD(
  publicationId: string,
  options: Dim3dSceneRuntimeRequestOptions = {},
) {
  const response = await sceneRuntimeRequest<Dim3dPublishedPackageResponse>(
    `/dim3d/scene/published/${encodeURIComponent(normalizePublicationId(publicationId))}/twoD`,
    'GET',
    options,
  )
  return normalizePublishedPackageResponse(
    response,
    normalizePublicationId(publicationId),
    'twoDJson',
    'twoD',
  )
}

/** 按发布编号和实例编号批量读取实例依赖；请求体不携带域字段。 */
export async function getDim3dPublishedDependencies(
  publicationId: string,
  instanceIds: readonly string[],
  options: Dim3dSceneRuntimeRequestOptions = {},
) {
  const normalizedPublicationId = normalizePublicationId(publicationId)
  const response = await sceneRuntimeRequest<Dim3dPublishedPackageResponse>(
    `/dim3d/scene/published/${encodeURIComponent(normalizedPublicationId)}/dependencies:batch-get`,
    'POST',
    { ...options, data: normalizeKeyList(instanceIds, 'instanceIds') },
  )
  return normalizePublishedDependencyResponse(response, normalizedPublicationId)
}

/** 保存书签中的场景编号和修订编号按字符串处理，其他 int32 字段保持数字。 */
const normalizeSaveResponse = (response: Dim3dSceneSaveAllResponse): Dim3dSceneSaveAllResponse => ({
  ...response,
  ...(response.data
    ? {
        data: {
          ...response.data,
          ...(response.data.sceneId === undefined
            ? {}
            : { sceneId: normalizeLongId(response.data.sceneId, 'sceneId') }),
          ...(response.data.revisionId === undefined
            ? {}
            : { revisionId: normalizeLongId(response.data.revisionId, 'revisionId') }),
        },
      }
    : {}),
})

/** 将额外请求头转为普通对象；只用于合并非鉴权扩展头，不接管三维鉴权头。 */
const getAdditionalHeaders = (options: Dim3dSceneRuntimeRequestOptions) =>
  isRecord(options.headers) ? options.headers : {}

/**
 * 运行态接口统一请求入口。
 * 接口文件只维护不带平台段的基础路径；请求层会根据当前鉴权上下文插入
 * `operation` 或 `tenant/web`。三维专用鉴权头和 `passAuth` 仍在这里统一配置，
 * 避免独立模式被管理端令牌拦截器覆盖。
 */
const sceneRuntimeRequest = <T>(
  path: string,
  method: 'GET' | 'POST' | 'PUT',
  options: Dim3dSceneRuntimeRequestOptions = {},
) => {
  const { headers: additionalHeaders, ...requestOptions } = options
  const defaultOptions = getDim3dRequestOptions('application/json')
  return request<T>(`${DIM3D_API_PREFIX}${path}`, {
    ...requestOptions,
    method,
    ...defaultOptions,
    headers: {
      ...getAdditionalHeaders({ headers: additionalHeaders }),
      ...defaultOptions.headers,
    },
    passAuth: true,
  })
}

/**
 * 预览六接口的专用请求入口。
 *
 * 预览会话通过 `resolve` 返回的票据鉴权，不复用 sceneRuntimeRequest 的业务请求体处理；
 * 接口本身仍属于三维第一方服务，必须把无平台段地址交给统一请求层：匿名公开预览按
 * 独立模式默认走 `operation`，已恢复租户上下文的仅个人/企业内部预览走 `tenant/web`。
 * 预览票据继续作为查询参数传递，平台上下文只负责路由分流和宿主鉴权头注入；业务层
 * 不再硬编码平台路径，避免受限预览把租户令牌发送到运营端接口。
 */
const scenePreviewRequest = <T>(
  path: string,
  method: 'GET' | 'POST',
  options: Dim3dSceneRuntimeRequestOptions = {},
) => {
  const { headers: additionalHeaders, ...requestOptions } = options
  const previewHeaders = Object.fromEntries(
    Object.entries(getAdditionalHeaders({ headers: additionalHeaders })).filter(
      ([name]) => !['authorization', 'clientid'].includes(name.toLowerCase()),
    ),
  )
  return request<T>(`${DIM3D_API_PREFIX}${path}`, {
    ...requestOptions,
    method,
    headers: {
      'Content-Type': 'application/json',
      ...previewHeaders,
    },
    // 保留 passAuth 以避免独立模式刷新登录令牌；内嵌模式下请求层仍会注入父页面令牌。
    passAuth: true,
    // 不设置 skipPlatformPath：租户受限预览必须由统一请求层改写为 tenant/web。
    // 公开/公开加密预览使用独立 ticket，401 不触发父页面登录失效通知。
    publicPreview: true,
  })
}

/**
 * 公开预览数据请求入口。
 *
 * 票据只由调用方的当前预览会话持有，并作为查询参数传递；该函数不缓存、持久化或记录票据，
 * 避免短期授权信息泄漏到草稿、模板、地址栏或跨场景缓存。
 */
const scenePreviewFragmentRequest = <T>(
  path: string,
  method: 'GET' | 'POST',
  ticket: string,
  options: Dim3dSceneRuntimeRequestOptions = {},
) => {
  const normalizedTicket = typeof ticket === 'string' ? ticket.trim() : ''
  if (!normalizedTicket) throw new Error('预览 ticket 必须是非空字符串。')
  const { params, ...requestOptions } = options
  return scenePreviewRequest<T>(path, method, {
    ...requestOptions,
    params: { ...(isRecord(params) ? params : {}), ticket: normalizedTicket },
  })
}

/**
 * 将领域层 SceneDefinition 转换为后端约定的四包结构。
 * GIS 和 local3d 使用相同的外层结构；GIS 额外在 baseConfig.gisLayers 保留非对象图层，
 * local3d 则明确发送空数组，避免运行态误把局部三维场景当作地图场景。
 */
export function convertSceneDefinitionToDim3dPackages(
  input: Dim3dScenePackageConversionInput,
): Dim3dScenePackages {
  /**
   * 四包结构只能有一个权威转换器。
   * 接口层复用编辑器集成层已经完成严格 JSON 校验、二维 Config 投影及行为归属映射的结果，
   * 避免此前两套转换逻辑对同一 SceneDefinition 生成不同 dependencies/resources 内容。
   */
  const defaults = createSceneFourPackageDocuments(input.scene) as unknown as Dim3dScenePackages
  const {
    requestGlobalConfig: _legacyRequestGlobalConfig,
    publicRequests: _legacyPublicRequests,
    sceneActions: _legacySceneActions,
    ...dependencyOverrides
  } = input.dependencies ?? {}

  return {
    schemaVersion: input.scene.schemaVersion,
    scene: defaults.scene,
    threeD: {
      ...defaults.threeD,
      ...(input.threeD || {}),
      baseConfig: { ...defaults.threeD.baseConfig, ...(input.threeD?.baseConfig || {}) },
    },
    twoD: { ...defaults.twoD, ...(input.twoD || {}) },
    /**
     * 接口层也执行一次字段级净化，防止旧调用方通过扩展对象把场景级配置重新塞回依赖包。
     * 三项配置的权威来源始终是 input.scene，经统一四包投影写入 sceneJson。
     */
    dependencies: { ...defaults.dependencies, ...dependencyOverrides },
  }
}

/** 把四包结构序列化成 saveAll 所需的四个 JSON 字符串，并验证序列化结果非空。 */
export function serializeDim3dScenePackages(packages: Dim3dScenePackages) {
  const serialize = (name: string, value: unknown) => {
    try {
      const serialized = JSON.stringify(value)
      if (!serialized) throw new Error(`${name} 序列化结果为空。`)
      return serialized
    } catch (error) {
      throw new Error(`${name} 不是可持久化的合法 JSON：${String(error)}`)
    }
  }
  return {
    schemaVersion: packages.schemaVersion,
    sceneJson: serialize('sceneJson', packages.scene),
    threeDJson: serialize('threeDJson', packages.threeD),
    twoDJson: serialize('twoDJson', packages.twoD),
    dependenciesJson: serialize('dependenciesJson', packages.dependencies),
  }
}

/** 根据当前场景、编辑锁令牌和可选保存元数据生成唯一的 saveAll 请求体。 */
export function createDim3dSceneSaveAllBody(
  input: Dim3dScenePackageConversionInput & {
    /** 当前路由/锁上下文提供的权威场景编号，禁止从可复制的 SceneDefinition 中推断。 */
    sceneId: string
  },
  lockToken: string,
  options: Pick<Dim3dSceneSaveAllBody, 'requestId' | 'baseRevisionNo' | 'changeSummary'> = {},
): Dim3dSceneSaveAllBody {
  if (typeof lockToken !== 'string' || !lockToken.trim()) {
    throw new Error('lockToken 必须是非空字符串。')
  }
  const packages = convertSceneDefinitionToDim3dPackages(input)
  const serialized = serializeDim3dScenePackages(packages)
  return {
    sceneId: normalizeLongId(input.sceneId, 'sceneId'),
    lockToken: lockToken.trim(),
    ...options,
    ...serialized,
  }
}

/** 解析 saveAll 返回的四个 JSON 字符串，供编辑器恢复结构化快照并继续做领域校验。 */
export function parseDim3dScenePackages(input: {
  schemaVersion?: number
  sceneJson: string
  threeDJson: string
  twoDJson: string
  dependenciesJson: string
}): Dim3dScenePackages {
  const parseObject = (name: string, serialized: string): Dim3dJsonObject => {
    if (typeof serialized !== 'string' || !serialized.trim()) {
      throw new Error(`${name} 必须是非空 JSON 字符串。`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(serialized)
    } catch (error) {
      throw new Error(`${name} 不是合法 JSON：${String(error)}`)
    }
    if (!isRecord(parsed)) throw new Error(`${name} 必须是 JSON 对象。`)
    return parsed
  }
  const parsedScene = parseObject('sceneJson', input.sceneJson)
  /** 旧包即使仍携带根级 id，也在解析边界直接丢弃，避免它继续向领域层传播。 */
  const { id: _discardedLegacySceneId, ...sceneWithoutId } = parsedScene
  const scene = sceneWithoutId as unknown as Dim3dSceneContainer
  const threeD = parseObject('threeDJson', input.threeDJson) as unknown as Dim3dThreeDPackage
  const twoD = parseObject('twoDJson', input.twoDJson) as unknown as Dim3dTwoDPackage
  const dependencies = parseObject(
    'dependenciesJson',
    input.dependenciesJson,
  ) as unknown as Dim3dDependenciesPackage
  if (scene.sceneType !== 'gis' && scene.sceneType !== 'local3d') {
    throw new Error('sceneJson.sceneType 必须是 gis 或 local3d。')
  }
  if (scene.domainSlots?.twoD !== 'present' || scene.domainSlots?.threeD !== 'present') {
    throw new Error('sceneJson.domainSlots 必须同时声明 twoD 和 threeD 为 present。')
  }
  /** 场景主键只存在于接口顶层；sceneJson 只校验自身负责的可复制场景内容。 */
  if (!scene.name) throw new Error('sceneJson 必须包含非空 name。')
  return {
    schemaVersion: input.schemaVersion ?? 1,
    scene,
    threeD,
    twoD,
    dependencies,
  }
}

/** 保存当前编辑场景；四包只通过同一个 saveAll 请求提交，失败时不伪造本地成功书签。 */
export async function saveAllDim3dScene(
  body: Dim3dSceneSaveAllBody,
  options: Dim3dSceneRuntimeRequestOptions = {},
) {
  const normalizedBody: Dim3dSceneSaveAllBody = {
    ...body,
    sceneId: normalizeLongId(body.sceneId, 'sceneId'),
    lockToken: typeof body.lockToken === 'string' ? body.lockToken.trim() : '',
  }
  if (!normalizedBody.lockToken) throw new Error('lockToken 必须是非空字符串。')
  const response = await sceneRuntimeRequest<Dim3dSceneSaveAllResponse>(
    '/dim3d/scene/saveAll',
    'PUT',
    { ...options, data: normalizedBody },
  )
  return normalizeSaveResponse(response)
}

/**
 * 按编辑场景编号解析当前公开预览会话。
 *
 * 后端 query 名称和语义均为 sceneId；调用方必须传入编辑场景编号。仅 PUBLIC_SHARE 与
 * PUBLIC_ENCRYPT 会进入后续发布预览数据链路，四个数据接口使用本响应中的 publicationId：
 * 前者不提交 password，后者由调用方在用户确认后传入 password。PERSONAL、ENTERPRISE 的登录跳转
 * 保留 resultCode，不在此处回退公开接口。
 */
export async function resolveDim3dScenePreview(
  sceneId: string,
  password?: string,
  options: Dim3dSceneRuntimeRequestOptions = {},
) {
  const normalizedSceneId = normalizeLongId(sceneId, 'sceneId')
  const normalizedPassword = typeof password === 'string' ? password.trim() : ''
  const { params, ...requestOptions } = options
  const response = await scenePreviewRequest<Dim3dScenePreviewResolveResponse>(
    '/dim3d/scenePreview/resolve',
    'GET',
    {
      ...requestOptions,
      params: {
        ...(isRecord(params) ? params : {}),
        // 接口字段和取值均为编辑场景编号；发布编号只从成功响应中读取。
        sceneId: normalizedSceneId,
        ...(normalizedPassword ? { password: normalizedPassword } : {}),
      },
    },
  )
  const data = response.data
  return {
    ...response,
    ...(data
      ? {
          data: {
            ...data,
            // resolve 返回的 sceneId 仅是响应元数据，预览链路不会用它构造任何请求；
            // 保留原值可避免后端同样以超大 JSON 数字返回时再次触发精度阻断。
            /**
             * publicationId 只在 resultCode=OK 时参与后续发布预览数据请求。NOT_FOUND、NEED_PASSWORD
             * 等业务分支的真实响应会返回 null，必须原样交给访问层处理机器码，不能让编号
             * 归一化异常覆盖真实访问状态；OK 但编号为空时则由会话层给出“缺少编号或票据”。
             */
            ...(data.resultCode !== 'OK' || data.publicationId == null
              ? {}
              : {
                  publicationId: normalizePreviewPublicationId(data.publicationId, ''),
                }),
          },
        }
      : {}),
  }
}

/** 公开预览读取完整 sceneJson；票据只存在当前预览会话内存。 */
export async function getDim3dScenePreviewBasic(
  publicationId: string,
  ticket: string,
  options: Dim3dSceneRuntimeRequestOptions = {},
) {
  const normalizedPublicationId = normalizePublicationId(publicationId)
  const response = await scenePreviewFragmentRequest<Dim3dPublishedPackageResponse>(
    `/dim3d/scenePreview/published/${encodeURIComponent(normalizedPublicationId)}/sceneBasic`,
    'GET',
    ticket,
    options,
  )
  return normalizePublishedPackageResponse(
    response,
    normalizedPublicationId,
    'sceneJson',
    'sceneBasic',
  )
}

/** 公开预览读取完整 threeDJson；GIS 与非 GIS 由后续场景类型选择 Runtime。 */
export async function getDim3dScenePreviewThreeD(
  publicationId: string,
  ticket: string,
  options: Dim3dSceneRuntimeRequestOptions = {},
) {
  const normalizedPublicationId = normalizePublicationId(publicationId)
  const response = await scenePreviewFragmentRequest<Dim3dPublishedPackageResponse>(
    `/dim3d/scenePreview/published/${encodeURIComponent(normalizedPublicationId)}/threeD`,
    'GET',
    ticket,
    options,
  )
  return normalizePublishedPackageResponse(
    response,
    normalizedPublicationId,
    'threeDJson',
    'threeD',
  )
}

/** 公开预览读取完整 twoDJson；组件是否实例化由前端根据显隐状态决定。 */
export async function getDim3dScenePreviewTwoD(
  publicationId: string,
  ticket: string,
  options: Dim3dSceneRuntimeRequestOptions = {},
) {
  const normalizedPublicationId = normalizePublicationId(publicationId)
  const response = await scenePreviewFragmentRequest<Dim3dPublishedPackageResponse>(
    `/dim3d/scenePreview/published/${encodeURIComponent(normalizedPublicationId)}/twoD`,
    'GET',
    ticket,
    options,
  )
  return normalizePublishedPackageResponse(response, normalizedPublicationId, 'twoDJson', 'twoD')
}

/** 公开预览按实例编号批量读取依赖；不携带域字段。 */
export async function getDim3dScenePreviewDependencies(
  publicationId: string,
  ticket: string,
  instanceIds: readonly string[],
  options: Dim3dSceneRuntimeRequestOptions = {},
) {
  const normalizedPublicationId = normalizePublicationId(publicationId)
  const response = await scenePreviewFragmentRequest<Dim3dPublishedPackageResponse>(
    `/dim3d/scenePreview/published/${encodeURIComponent(normalizedPublicationId)}/dependenciesByinstances`,
    'POST',
    ticket,
    { ...options, data: normalizeKeyList(instanceIds, 'instanceIds') },
  )
  return normalizePublishedDependencyResponse(response, normalizedPublicationId)
}

/** 公开预览读取发布快照绑定的植被运行时资源，并与同一票据和发布编号绑定。 */
export async function getDim3dScenePreviewVegetationResources(
  publicationId: string,
  ticket: string,
  resourceKeys?: readonly string[],
  options: Dim3dSceneRuntimeRequestOptions = {},
) {
  const normalizedPublicationId = normalizePublicationId(publicationId)
  const normalizedOptions =
    resourceKeys === undefined
      ? options
      : { ...options, data: normalizeKeyList(resourceKeys, 'resourceKeys') }
  const response = await scenePreviewFragmentRequest<Dim3dVegetationRuntimeResourcesResponse>(
    `/dim3d/scenePreview/published/${encodeURIComponent(normalizedPublicationId)}/vegetation/resources`,
    'POST',
    ticket,
    normalizedOptions,
  )
  return normalizeVegetationRuntimeResourcesResponse(response, normalizedPublicationId)
}

/** 解析单个发布分片的 contentJson；非法内容必须显式失败，不能伪装成空分片。 */
const parsePublishedFragment = (
  fragment: Dim3dPublishedFragment,
  label: string,
): Dim3dParsedPublishedFragment => {
  if (!fragment.contentJson?.trim()) throw new Error(`${label} 缺少合法的 contentJson。`)
  let content: unknown
  try {
    content = JSON.parse(fragment.contentJson)
  } catch (error) {
    throw new Error(`${label} 的 contentJson 不是合法 JSON：${String(error)}`)
  }
  return { ...normalizePublishedFragment(fragment), content }
}

/** 按 fragmentKey 建立索引并拒绝重复键，防止后返回的分片静默覆盖先返回的内容。 */
const createFragmentIndex = (
  fragments: readonly Dim3dPublishedFragment[] = [],
  publicationId: string,
  fragmentType: string,
): Dim3dPublishedFragmentIndex => {
  const index: Record<string, Dim3dParsedPublishedFragment> = {}
  fragments.forEach((fragment, itemIndex) => {
    if (fragment.publicationId !== undefined && fragment.publicationId !== publicationId) {
      throw new Error(`${fragmentType}[${itemIndex}] 的 publicationId 与当前清单不一致。`)
    }
    if (!fragment.fragmentKey?.trim()) {
      throw new Error(`${fragmentType}[${itemIndex}] 缺少 fragmentKey，无法建立分片索引。`)
    }
    const key = fragment.fragmentKey.trim()
    if (index[key]) throw new Error(`${fragmentType} 存在重复 fragmentKey：${key}。`)
    index[key] = parsePublishedFragment(fragment, `${fragmentType}[${itemIndex}]`)
  })
  return index
}

/** 从清单内容读取 sceneType；兼容清单直接返回或包在 scene 容器中的两种结构。 */
const readSceneType = (content: unknown): Dim3dSceneType | undefined => {
  if (!isRecord(content)) return undefined
  const direct = content.sceneType
  if (direct === 'gis' || direct === 'local3d') return direct
  const nested = isRecord(content.scene) ? content.scene.sceneType : undefined
  return nested === 'gis' || nested === 'local3d' ? nested : undefined
}

/**
 * 组装清单和四类运行态分片。
 * 组装只做一次 JSON 解析并按键建立索引；GIS 与 local3d 不分叉接口，场景类型由清单内容决定。
 */
export function assembleDim3dSceneRuntime(input: {
  publicationId: string
  manifest: Dim3dPublishedFragment
  sceneType?: Dim3dSceneType
  threeDChunks?: readonly Dim3dPublishedFragment[]
  twoDFragments?: readonly Dim3dPublishedFragment[]
  behaviors?: readonly Dim3dPublishedFragment[]
  assets?: readonly Dim3dPublishedFragment[]
}): Dim3dSceneRuntimeSnapshot {
  const publicationId = normalizePublicationId(input.publicationId)
  if (
    input.manifest.publicationId !== undefined &&
    input.manifest.publicationId !== publicationId
  ) {
    throw new Error('manifest 的 publicationId 与请求标识不一致。')
  }
  const manifest = parsePublishedFragment(input.manifest, 'manifest')
  const manifestSceneType = readSceneType(manifest.content)
  if (input.sceneType && manifestSceneType && input.sceneType !== manifestSceneType) {
    throw new Error('manifest 返回的 sceneType 与调用方场景类型不一致。')
  }
  return {
    publicationId,
    sceneType: manifestSceneType || input.sceneType,
    manifest,
    threeDChunks: createFragmentIndex(input.threeDChunks, publicationId, 'threeDChunks'),
    twoDFragments: createFragmentIndex(input.twoDFragments, publicationId, 'twoDFragments'),
    behaviors: createFragmentIndex(input.behaviors, publicationId, 'behaviors'),
    assets: createFragmentIndex(input.assets, publicationId, 'assets'),
  }
}
