import type {
  AssetRef,
  SceneDefinition,
  SceneLayer,
  SceneObject,
  SceneType,
} from '@/scene-platform'
import { attachDataBindingOverflow } from './dataBindingOverflow'
import { isBuiltinSceneAssetId } from './editorBuiltinResourceRegistry'
import { isProxy, toRaw } from 'vue'
import { projectInstanceDefinition } from '@/scene-core/model/instanceDefinition'

/**
 * 四包协议允许的 JSON 值。
 * 该类型和下方深拷贝函数共同保证持久化数据不包含引擎对象、DOM、函数或循环引用。
 */
export type ScenePackageJsonValue =
  | string
  | number
  | boolean
  | null
  | ScenePackageJsonValue[]
  | Record<string, unknown>
/**
 * TypeScript 无法证明现有 SceneDefinition 扩展对象的每个深层字段都满足递归 JSON 联合，
 * 因此静态类型保持普通对象；运行时由 cloneScenePackageJsonValue 逐层执行严格校验。
 */
export type ScenePackageJsonObject = Record<string, unknown>

export interface SceneContainerPackage {
  schemaVersion: number
  name: string
  sceneType: SceneType
  domainSlots: { twoD: 'present'; threeD: 'present' }
  metadata: ScenePackageJsonObject
  /** 场景级请求默认值随 sceneJson 首包恢复，不属于实例依赖。 */
  requestGlobalConfig: ScenePackageJsonObject
  /** 公共接口完整定义；实例绑定只保存 publicRequestKey。 */
  publicRequests: ScenePackageJsonValue[]
  /** 没有实例拥有者的场景动作。 */
  sceneActions: ScenePackageJsonValue[]
}

export interface SceneThreeDTargetPackage extends ScenePackageJsonObject {
  instanceId: string
  targetType: string
  resourceRefKeys: string[]
  contentJson: ScenePackageJsonObject
}
export interface SceneThreeDLayerPackage extends ScenePackageJsonObject {
  layerKey: string
  layerType: SceneLayer['type']
  name: string
  visible: boolean
  locked: boolean
  sortNo: number
}
export interface SceneThreeDPackage {
  baseConfig: ScenePackageJsonObject
  objects: SceneThreeDTargetPackage[]
  components: SceneThreeDTargetPackage[]
  layers: SceneThreeDLayerPackage[]
  streaming: ScenePackageJsonObject
  cameraPaths: ScenePackageJsonValue[]
  vegetation?: ScenePackageJsonObject
}
export interface SceneTwoDComponentPackage extends ScenePackageJsonObject {
  instanceId: string
  /** 真实父组件实例；缺失表示结构树根级。 */
  parentInstanceId?: string
  componentType: string
  /** 外部地址组件保持空数组；资源市场图片在此保存稳定资源编号。 */
  resourceRefKeys: string[]
  visible: boolean
  locked: boolean
  sortNo: number
  layoutConfig: ScenePackageJsonObject
  styleConfig: ScenePackageJsonObject
  renderConfig: ScenePackageJsonObject
  animationConfig: ScenePackageJsonObject
  contentJson: ScenePackageJsonObject
}
export interface SceneTwoDPackage {
  canvas: ScenePackageJsonObject
  components: SceneTwoDComponentPackage[]
  layerTree: ScenePackageJsonValue[]
}
export interface SceneDependencyOwner extends ScenePackageJsonObject {
  domain: 'twoD' | 'threeD'
  ownerType: string
  instanceId?: string
  ownerKey?: string
}
/**
 * 四包中的普通资源依赖。
 *
 * 植被模型、发布清单、根瓦片、图层瓦片和预览产物均由专用发布资源接口按场景版本提供，
 * 不属于该列表；植被配置和物种 assetId 仍保存在 threeDJson.vegetation 中。
 */
export interface SceneResourcePackage extends ScenePackageJsonObject {
  resourceKey: string
  assetId: string
  kind: string
  owners: SceneDependencyOwner[]
}
export interface SceneDependenciesPackage {
  resources: SceneResourcePackage[]
  dataBindings: ScenePackageJsonValue[]
  behaviors: ScenePackageJsonValue[]
  deviceBindings: ScenePackageJsonValue[]
}
export interface SceneFourPackageDocuments {
  scene: SceneContainerPackage
  threeD: SceneThreeDPackage
  twoD: SceneTwoDPackage
  dependencies: SceneDependenciesPackage
}
/** 后端 `saveAll` 需要的四个 JSON 字符串。 */
export interface SceneFourPackagePayload {
  sceneJson: string
  threeDJson: string
  twoDJson: string
  dependenciesJson: string
}

/** 兼容早期草稿命名，后续调用方可逐步迁移到 Documents。 */
export type SceneFourPackage = SceneFourPackageDocuments
export interface SerializedSceneFourPackage extends SceneFourPackagePayload {
  schemaVersion: number
}

type JsonRecord = Record<string, unknown>
export const isScenePackageRecord = (value: unknown): value is JsonRecord => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
export const isSupportedScenePackageType = (value: unknown): value is SceneType =>
  value === 'gis' || value === 'local3d'

/** 深度复制并严格校验普通 JSON，禁止静默丢弃无法持久化的值。 */
export const cloneScenePackageJsonValue = (
  value: unknown,
  path = '$',
  ancestors = new WeakSet<object>(),
): ScenePackageJsonValue => {
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${path} 只能包含有限数字`)
    return value
  }
  if (typeof value !== 'object') throw new Error(`${path} 包含不可持久化的运行时值`)
  /**
   * 二维仓库中的布局、样式和数据配置可能是 Vue 响应式代理（Proxy）。代理的原始值仍是
   * 合法纯数据，因此先逐层解包再严格校验；Three.js、Cesium、DOM 和自定义类实例仍会被拒绝。
   */
  const source = isProxy(value) ? toRaw(value) : value
  if (ancestors.has(source)) throw new Error(`${path} 存在循环引用`)
  ancestors.add(source)
  try {
    if (Array.isArray(source)) {
      return source.map((item, index) =>
        cloneScenePackageJsonValue(item, `${path}[${index}]`, ancestors),
      )
    }
    if (!isScenePackageRecord(source)) throw new Error(`${path} 必须是普通 JSON 对象`)
    const result: ScenePackageJsonObject = {}
    for (const key of Object.keys(source)) {
      if (source[key] !== undefined)
        result[key] = cloneScenePackageJsonValue(source[key], `${path}.${key}`, ancestors)
    }
    return result
  } finally {
    ancestors.delete(source)
  }
}

const cloneRecord = (value: unknown, path: string): ScenePackageJsonObject => {
  const result = cloneScenePackageJsonValue(value, path)
  if (!isScenePackageRecord(result)) throw new Error(`${path} 必须是普通 JSON 对象`)
  return result as ScenePackageJsonObject
}

/** 二维配置投影时用于表示“该运行时字段不进入持久化 JSON”的内部哨兵。 */
const WIDGET_JSON_OMIT = Symbol('widget-json-omit')
type WidgetJsonCloneResult = ScenePackageJsonValue | typeof WIDGET_JSON_OMIT

/**
 * 判断二维配置中允许展开的非普通对象。
 *
 * 当前真实部件的 component 是 BaseWidgetConfig 的 Config 子类；ECharts 渐变也以类实例存在。
 * 两者都只承载可枚举配置字段，可以在二维适配边界投影为普通对象。其它类实例继续拒绝，避免
 * Three.js、CesiumJS、DOM 或请求句柄借由二维 contentJson 绕过全局安全校验。
 */
const isSupportedWidgetConfigInstance = (value: object, path: string): boolean => {
  const record = value as JsonRecord
  const isWidgetComponent =
    path.endsWith('.component') &&
    isScenePackageRecord(record.attr) &&
    isScenePackageRecord(record.info) &&
    typeof record.option === 'object' &&
    record.option !== null
  const isEchartsGradient =
    (record.type === 'linear' || record.type === 'radial') && Array.isArray(record.colorStops)
  return isWidgetComponent || isEchartsGradient
}

/**
 * 把二维组件配置投影为纯 JSON。
 *
 * 与通用 cloneScenePackageJsonValue 不同，本函数只用于已确认的二维配置边界：
 * - 展开 Config 和 ECharts 渐变中的可枚举数据；
 * - 对象属性中的函数、undefined 和 symbol 是组件实现默认值，不属于用户场景数据，明确省略；
 * - 数组中的不可持久化值会改变索引语义，因此仍然报错；
 * - 其它自定义类和循环引用继续拒绝。
 */
const cloneWidgetConfigJsonValue = (
  value: unknown,
  path: string,
  ancestors = new WeakSet<object>(),
): WidgetJsonCloneResult => {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return WIDGET_JSON_OMIT
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${path} 只能包含有限数字`)
    return value
  }
  if (typeof value !== 'object') throw new Error(`${path} 包含不可持久化的运行时值`)

  const source = isProxy(value) ? toRaw(value) : value
  if (ancestors.has(source)) throw new Error(`${path} 存在循环引用`)
  ancestors.add(source)
  try {
    if (Array.isArray(source)) {
      return source.map((item, index) => {
        const cloned = cloneWidgetConfigJsonValue(item, `${path}[${index}]`, ancestors)
        if (cloned === WIDGET_JSON_OMIT) {
          throw new Error(`${path}[${index}] 包含不可持久化的数组项`)
        }
        return cloned
      })
    }

    const prototype = Object.getPrototypeOf(source)
    const isPlain = prototype === Object.prototype || prototype === null
    if (!isPlain && !isSupportedWidgetConfigInstance(source, path)) {
      throw new Error(`${path} 必须是普通 JSON 对象或受支持的二维配置实例`)
    }

    const result: ScenePackageJsonObject = {}
    for (const key of Object.keys(source)) {
      const cloned = cloneWidgetConfigJsonValue(
        (source as JsonRecord)[key],
        `${path}.${key}`,
        ancestors,
      )
      if (cloned !== WIDGET_JSON_OMIT) result[key] = cloned
    }
    return result
  } finally {
    ancestors.delete(source)
  }
}

const cloneWidgetConfigRecord = (value: unknown, path: string): ScenePackageJsonObject => {
  const cloned = cloneWidgetConfigJsonValue(value, path)
  if (cloned === WIDGET_JSON_OMIT || !isScenePackageRecord(cloned)) {
    throw new Error(`${path} 必须是二维配置对象`)
  }
  return cloned
}

const getRecord = (value: unknown): JsonRecord => (isScenePackageRecord(value) ? value : {})
const getArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const getString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined
const getBoolean = (value: unknown, fallback: boolean) =>
  typeof value === 'boolean' ? value : fallback
const getNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined
const hasKeys = (value: unknown) => isScenePackageRecord(value) && Object.keys(value).length > 0

const RESOURCE_RUNTIME_FIELD_KEYS = new Set([
  'url',
  'address',
  'resourceUrl',
  'contentUrl',
  'filePath',
  'defaultImagePath',
  'imagePath',
  'resourceAsset',
  'resourceId',
  'version',
  'expiresAt',
  'token',
  'accessToken',
  'authorization',
])

/**
 * 从资源私有快照中递归移除地址、版本和认证信息。
 *
 * 该函数只用于资源描述和旧编辑器模型快照，不能对普通渲染配置做全局键名过滤：
 * 图表、地理信息图层或业务组件可能合法使用 `url` 作为自身协议字段。限定调用边界可以
 * 在阻止临时地址进入四包的同时，避免误删无关业务配置。
 */
const cloneResourcePersistenceValue = (value: unknown, path: string): ScenePackageJsonValue => {
  const cloned = cloneScenePackageJsonValue(value, path)
  const sanitize = (item: ScenePackageJsonValue): ScenePackageJsonValue => {
    if (Array.isArray(item)) return item.map(sanitize)
    if (!isScenePackageRecord(item)) return item
    return Object.fromEntries(
      Object.entries(item)
        .filter(([key]) => !RESOURCE_RUNTIME_FIELD_KEYS.has(key))
        .map(([key, child]) => [key, sanitize(child as ScenePackageJsonValue)]),
    )
  }
  return sanitize(cloned)
}

const VEGETATION_RUNTIME_FIELD_KEYS = new Set([
  'url',
  'address',
  'resourceUrl',
  'contentUrl',
  'filePath',
  'defaultImagePath',
  'imagePath',
  'resourceAsset',
  'expiresAt',
  'token',
  'accessToken',
  'authorization',
])

/**
 * 所有植被资源都不进入场景依赖包：后端植被预览资源接口会按不可变发布版本统一返回模型、
 * 清单和瓦片地址。
 *
 * `usageType` 是当前保存链路写入的明确标记；资源编号前缀用于清理早期保存数据和未带标记的
 * 历史快照；拥有者判断用于兼容自定义编号的旧资源记录。物种模型也必须过滤，不能因其是 GLB
 * 就作为普通场景资源写入 `dependenciesJson.resources`。
 */
const VEGETATION_RESOURCE_USAGE_TYPES = new Set([
  'vegetation-tileset',
  'vegetation-manifest',
  'vegetation-species-model',
])
const VEGETATION_RESOURCE_KEY_PREFIXES = [
  'vegetation-manifest:',
  'vegetation-tileset:',
  'vegetation-generation-preview:',
] as const

/** 判断依赖记录是否为应由植被发布资源接口提供的任意植被资源。 */
const isVegetationResource = (value: unknown): boolean => {
  const record = getRecord(value)
  const usageType = getString(record.usageType)
  if (usageType && VEGETATION_RESOURCE_USAGE_TYPES.has(usageType)) return true

  const resourceKey = getString(record.resourceKey) ?? getString(record.assetId)
  if (
    resourceKey &&
    VEGETATION_RESOURCE_KEY_PREFIXES.some((prefix) => resourceKey.startsWith(prefix))
  ) {
    return true
  }

  /**
   * 兼容没有 usageType 且使用自定义编号的历史记录：植被系统和图层拥有者下的资源均由植被
   * 专用接口提供。这样即使历史物种模型没有标记，也不会再次被写回依赖包。
   */
  const owners = getArray(record.owners)
  return owners.some((ownerValue) => {
    const owner = getRecord(ownerValue)
    return owner.ownerType === 'vegetation-layer' || owner.ownerType === 'vegetation-system'
  })
}

/**
 * 植被使用专用持久化白名单边界：递归移除运行时地址和认证信息，但保留 `version`、摘要、规则版本
 * 以及资源编号。通用资源净化会删除所有同名 `version` 字段，不能用于完整植被领域对象。
 */
const cloneVegetationPersistenceValue = (value: unknown): ScenePackageJsonValue => {
  const cloned = cloneScenePackageJsonValue(value, '$.threeD.vegetation')
  const sanitize = (item: ScenePackageJsonValue): ScenePackageJsonValue => {
    if (Array.isArray(item)) return item.map(sanitize)
    if (!isScenePackageRecord(item)) return item
    return Object.fromEntries(
      Object.entries(item)
        .filter(([key]) => !VEGETATION_RUNTIME_FIELD_KEYS.has(key))
        .map(([key, child]) => [key, sanitize(child as ScenePackageJsonValue)]),
    )
  }
  return sanitize(cloned)
}

/**
 * 三维目标的 metadata 只保留创建和渲染所需纯配置。
 * 数据、状态、事件和设备绑定会在同一次投影中进入 dependencies；模型快照中的地址、
 * 资源对象及版本仅用于当前内存，重新打开场景时由 SceneObject.asset 补齐。
 */
const sanitizeThreeTargetMetadata = (value: unknown, objectId: string): ScenePackageJsonObject => {
  const metadata = getRecord(value)
  const {
    dataConfig: _dataConfig,
    statusList: _statusList,
    interactiveEvent: _interactiveEvent,
    deviceId: _deviceId,
    deviceBinding: _deviceBinding,
    sceneRuntimeDependencies: _sceneRuntimeDependencies,
    dependencies: _dependencies,
    // Three.js 的对象 uuid 只用于当前渲染引擎内部定位对象，不是可持久化的业务身份。
    // 场景保存后应使用 instanceId 作为跨包、跨运行时稳定的实例身份；场景重新加载时，
    // 引擎会为新创建的对象重新生成 uuid，因此不能把旧 uuid 带入 threeDJson。
    engineObjectUuid: _engineObjectUuid,
    // 旧版对象上的 onlyUuid 同样属于历史运行时兼容字段，既不能替代 instanceId，
    // 也不能进入持久化结构。这里仅从保存投影副本中排除，不修改编辑器内存中的 metadata。
    legacyOnlyUuid: _legacyOnlyUuid,
    ...persistentMetadata
  } = metadata
  const editorModelSnapshot = persistentMetadata.editorModelSnapshot
  if (editorModelSnapshot !== undefined) {
    const snapshot = cloneResourcePersistenceValue(
      editorModelSnapshot,
      `$.threeD.${objectId}.contentJson.metadata.editorModelSnapshot`,
    )
    if (isScenePackageRecord(snapshot)) {
      /** 左侧资源卡片图标属于应用构建产物，加载编辑器配置时会从注册表恢复。 */
      delete snapshot.icon
      persistentMetadata.editorModelSnapshot = snapshot
    } else {
      delete persistentMetadata.editorModelSnapshot
    }
  }
  return persistentMetadata
}

const getSettings = (scene: SceneDefinition) => getRecord(scene.settings)

const hasOwn = (value: JsonRecord, key: string) => Object.prototype.hasOwnProperty.call(value, key)

/**
 * 把编辑器内部平铺公共接口转换为 sceneJson 契约，同时兼容已是契约结构的历史快照。
 * 该投影只复制接口定义，不读取或执行请求，也不会携带最近响应数据。
 */
const normalizeScenePublicRequests = (value: unknown): ScenePackageJsonValue[] =>
  getArray(value).flatMap((item, index) => {
    const record = getRecord(item)
    const publicRequestKey =
      getString(record.publicRequestKey) ?? getString(record.requestKey) ?? getString(record.id)
    if (!publicRequestKey) return []
    if (hasKeys(record.requestConfig)) {
      return [
        cloneScenePackageJsonValue(
          { ...record, publicRequestKey },
          `$.scene.publicRequests[${index}]`,
        ),
      ]
    }
    const { id: _id, requestKey: _requestKey, name, ...requestConfig } = record
    return [
      cloneScenePackageJsonValue(
        {
          publicRequestKey,
          name: getString(name) ?? publicRequestKey,
          requestConfig,
        },
        `$.scene.publicRequests[${index}]`,
      ),
    ]
  })

/**
 * 场景级请求与动作读取顺序：规范 settings 字段优先，其次是正式旧依赖，最后才是历史运行时镜像。
 * 选择依据是字段是否存在，显式 `{}` 或 `[]` 必须覆盖旧包中的非空值。
 */
const collectSceneGlobalPackage = (scene: SceneDefinition) => {
  const settings = getSettings(scene)
  const dependencies = getRecord(settings.dependencies)
  const historical = getRecord(settings.sceneRuntimeDependencies)
  const pick = (key: string, legacyKey?: string): unknown => {
    if (hasOwn(settings, key)) return settings[key]
    if (hasOwn(dependencies, key)) return dependencies[key]
    if (hasOwn(historical, key)) return historical[key]
    if (legacyKey && hasOwn(settings, legacyKey)) return settings[legacyKey]
    return undefined
  }
  return {
    requestGlobalConfig: cloneRecord(
      pick('requestGlobalConfig') ?? {},
      '$.scene.requestGlobalConfig',
    ),
    publicRequests: normalizeScenePublicRequests(
      pick('publicRequests', 'publicRequestConfig') ?? [],
    ),
    sceneActions: cloneScenePackageJsonValue(
      Array.isArray(pick('sceneActions')) ? pick('sceneActions') : [],
      '$.scene.sceneActions',
    ) as ScenePackageJsonValue[],
  }
}

/**
 * 早期创建器会把实例编号拼接为 `${instanceId}:asset`，但它不是资源市场或 OSS 文件编号。
 * 此类回退键曾被同时写入 resourceKey 和 assetId，导致重开时被当成真实资源调用解析接口。
 * 新保存必须丢弃它；真正的外部图片和模型都需要由资源面板提供独立的稳定 assetId。
 */
const isLegacyFallbackAssetReference = (resourceKey: string, assetId: string) =>
  resourceKey === assetId && assetId.endsWith(':asset')

/**
 * 读取三维看板中图片块和背景图的外部资源引用。
 *
 * 看板对象本身通常使用内置 `builtin:billboard-logo` 作为创建占位，因此不能只扫描
 * `object.asset`。用户在属性面板选择的图片由看板私有字段保存 OSS 编号，必须在这里单独投影，
 * 否则地址会留在 billboard 中却没有 dependencies.resources 可供加载器解析。
 */
const getBillboardImageResourceRefs = (object: SceneObject): AssetRef[] => {
  const billboard = getRecord(object.billboard)
  if (!billboard) return []
  const content = getRecord(billboard.content)
  const refs: AssetRef[] = []
  const seen = new Set<string>()
  const register = (resourceKey: unknown, url: unknown) => {
    const id = getString(resourceKey)
    const resolvedUrl = getString(url)
    /** 市场资源的稳定编号才是保存依据；地址为空时仍必须登记依赖，刷新时再通过 OSS 解析。 */
    if (!id || seen.has(id) || isLegacyFallbackAssetReference(id, id)) return
    seen.add(id)
    refs.push({ id, kind: 'image', url: resolvedUrl ?? '' })
  }

  for (const block of getArray(content.blocks)) {
    const record = getRecord(block)
    if (record?.type === 'image') register(record.imageResourceKey, record.imageSrc)
  }
  const appearance = getRecord(billboard.appearance)
  register(appearance.backgroundImageResourceKey, appearance.backgroundImage)
  return refs
}

/** 只有可解析的外部资源才进入四包 resourceRefKeys；内置看板和图标由组件私有配置恢复。 */
const getPersistentObjectResourceRefKeys = (object: SceneObject): string[] => {
  const keys = [
    ...(object.asset?.id ? [object.asset.id] : []),
    ...getBillboardImageResourceRefs(object).map((asset) => asset.id),
  ]
  return [
    ...new Set(
      keys.filter(
        (assetId) =>
          !isLegacyFallbackAssetReference(assetId, assetId) && !isBuiltinSceneAssetId(assetId),
      ),
    ),
  ]
}

/**
 * 看板的实际图片地址只用于当前运行时绘制，保存时一律由稳定资源编号恢复。
 * 内置看板没有外部编号，仍由注册表补回默认 Logo；历史看板没有编号时暂时保留地址兼容，
 * 但新的资源选择链路必然写入 imageResourceKey/backgroundImageResourceKey 并净化地址。
 */
const sanitizeBillboard = (object: SceneObject): ScenePackageJsonValue | undefined => {
  if (object.billboard === undefined) return undefined
  const billboard = cloneScenePackageJsonValue(
    object.billboard,
    `$.threeD.${object.id}.contentJson.billboard`,
  )
  if (!isScenePackageRecord(billboard)) return billboard
  const content = getRecord(billboard.content)
  const blocks = getArray(content?.blocks)
  const appearance = getRecord(billboard.appearance)
  const isBuiltin = Boolean(object.asset && isBuiltinSceneAssetId(object.asset.id))

  return {
    ...billboard,
    content: {
      ...content,
      blocks: blocks.map((block) => {
        const record = getRecord(block)
        if (record?.type !== 'image') return block
        return record.imageResourceKey || isBuiltin ? { ...record, imageSrc: '' } : block
      }),
    },
    appearance: {
      ...appearance,
      ...(appearance.backgroundImageResourceKey || isBuiltin ? { backgroundImage: null } : {}),
    },
  }
}

const getWidgetSnapshot = (scene: SceneDefinition) => {
  const editor = getRecord(getSettings(scene).editor)
  return getRecord(editor.widgetSceneFragment)
}
const resolveWidgetLayerKey = (id: string, layerTree: readonly unknown[]): string | undefined => {
  for (const node of layerTree) {
    const group = getRecord(node)
    if (group.type === 'group' && getArray(group.children).includes(id)) return getString(group.id)
  }
  return undefined
}

const toThreeTarget = (object: SceneObject, sceneId: string): SceneThreeDTargetPackage => {
  const resourceRefKeys = getPersistentObjectResourceRefKeys(object)
  const definition = projectInstanceDefinition(object.metadata?.instanceDefinition, {
    instanceId: object.id, sceneId, name: object.name,
    resourceId: String(object.asset?.metadata?.assetId ?? object.asset?.id ?? '').trim(),
  })
  // 基础名称只取领域对象；配置副本随原三维载荷保存，不在依赖包另存一份。
  const metadata = sanitizeThreeTargetMetadata(definition === undefined ? object.metadata : {
    ...object.metadata, instanceDefinition: definition,
  }, object.id)
  const billboard = sanitizeBillboard(object)
  return {
    instanceId: object.id,
    targetType: object.type,
    name: object.name,
    visible: object.visible,
    locked: object.locked,
    ...(object.layerId ? { layerKey: object.layerId } : {}),
    sortNo: object.order,
    transform: cloneScenePackageJsonValue(object.transform, `$.threeD.${object.id}.transform`),
    resourceRefKeys,
    contentJson: cloneRecord(
      {
        ...(hasKeys(object.style) ? { style: object.style } : {}),
        ...(hasKeys(metadata) ? { metadata } : {}),
        /**
         * 功能性三维组件（例如中国 3D 地图）通过 SceneObject.effect 保存领域配置。
         * 这类对象与模型一样进入 threeD.components，但 effect 不能依赖运行时实例重建，
         * 必须作为组件私有配置随 contentJson 一起持久化，否则重开后会被还原成缺少 effect
         * 的非法 effect 对象，进而触发“场景数据加载失败”。
         */
        ...(object.effect === undefined
          ? {}
          : {
              effect: cloneScenePackageJsonValue(
                object.effect,
                `$.threeD.${object.id}.contentJson.effect`,
              ),
            }),
        ...(object.light === undefined
          ? {}
          : {
              light: cloneScenePackageJsonValue(
                object.light,
                `$.threeD.${object.id}.contentJson.light`,
              ),
            }),
        ...(object.firstPerson === undefined
          ? {}
          : {
              firstPerson: cloneScenePackageJsonValue(
                object.firstPerson,
                `$.threeD.${object.id}.contentJson.firstPerson`,
              ),
            }),
        ...(billboard === undefined ? {} : { billboard }),
      },
      `$.threeD.${object.id}.contentJson`,
    ),
  }
}

const toLayer = (layer: SceneLayer): SceneThreeDLayerPackage => ({
  layerKey: layer.id,
  layerType: layer.type,
  name: layer.name,
  visible: layer.visible,
  locked: layer.locked,
  sortNo: layer.order,
  ...(layer.opacity === undefined ? {} : { opacity: layer.opacity }),
  ...(layer.provider === undefined ? {} : { provider: layer.provider }),
  /**
   * 直连 GIS 图层没有可供资源服务反查的资产编号，URL 或项目路径就是其稳定数据源配置，
   * 必须随四包保存；资产型图层仍只保存 resourceRefKeys，避免把临时签名地址固化进场景。
   */
  ...(layer.asset === undefined && layer.url !== undefined ? { url: layer.url } : {}),
  ...(layer.asset === undefined ? {} : { resourceRefKeys: [layer.asset.id] }),
  ...(layer.options === undefined
    ? {}
    : { options: cloneScenePackageJsonValue(layer.options, `$.threeD.layer.${layer.id}.options`) }),
  ...(layer.metadata === undefined
    ? {}
    : {
        metadata: cloneScenePackageJsonValue(layer.metadata, `$.threeD.layer.${layer.id}.metadata`),
      }),
})

interface WidgetPackageProjection {
  component: SceneTwoDComponentPackage
  dataBindings: ScenePackageJsonValue[]
  behaviors: ScenePackageJsonValue[]
  deviceBindings: ScenePackageJsonValue[]
}

const DATA_INTERVAL_UNIT_MS: Readonly<Record<string, number>> = {
  second: 1000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
}

const createInstanceOwner = (
  domain: SceneDependencyOwner['domain'],
  instanceId: string,
): SceneDependencyOwner => ({
  domain,
  ownerType: 'instance',
  instanceId,
})

/** 将二维／三维实例的多请求配置展开为后端可按拥有者索引的数据绑定。 */
const createInstanceDataBindings = (
  config: JsonRecord,
  instanceId: string,
  domain: SceneDependencyOwner['domain'],
): ScenePackageJsonValue[] => {
  const dataConfig = getRecord(config.dataConfig)
  if (!hasKeys(dataConfig)) return []

  const configuredRequests = getArray(dataConfig.requests)
  const requestItems =
    configuredRequests.length > 0
      ? configuredRequests
      : hasKeys(dataConfig.request)
        ? [
            {
              id: 'request-1',
              name: '请求1',
              request: dataConfig.request,
              extractor: dataConfig.extractor,
              dataset: dataConfig.dataset,
              bindings: dataConfig.bindings,
              filterFn: dataConfig.filterFn,
              deletedAutoMappingTargets: dataConfig.deletedAutoMappingTargets,
            },
          ]
        : []
  const owner = createInstanceOwner(domain, instanceId)

  return requestItems.flatMap((requestValue, index) => {
    const requestItem = getRecord(requestValue)
    const request = getRecord(requestItem.request)
    if (!hasKeys(request)) return []
    const requestType = getString(request.type) ?? 'static'
    const requestConfig = getRecord(request.config)
    const dataset = getRecord(requestItem.dataset)
    const interval = getNumber(requestConfig.requestInterval)
    const intervalUnit = getString(requestConfig.requestIntervalUnit) ?? 'second'
    const intervalMs =
      interval && interval > 0 ? interval * (DATA_INTERVAL_UNIT_MS[intervalUnit] ?? 1000) : 0
    const publicRequestKey = getString(requestConfig.publicRequestId)
    const bindingKey = getString(requestItem.id) ?? `${instanceId}:request:${index + 1}`

    return [
      cloneRecord(
        {
          bindingKey,
          owner,
          source: {
            type: requestType,
            ...(publicRequestKey ? { publicRequestKey } : {}),
            requestConfig,
            staticData:
              requestType === 'static' ? (requestConfig.data ?? getArray(dataset.source)) : null,
          },
          extractorConfig: getRecord(requestItem.extractor),
          schemaConfig: { dimensions: getArray(dataset.dimensions) },
          mappingConfig: {
            bindings: getArray(requestItem.bindings),
            deletedAutoMappingTargets: getArray(requestItem.deletedAutoMappingTargets),
          },
          filterConfig: {
            ...(getString(requestItem.filterFn) ? { filterFn: requestItem.filterFn } : {}),
          },
          refresh: {
            mode: intervalMs > 0 ? 'polling' : 'manual',
            ...(intervalMs > 0 ? { intervalMs } : {}),
          },
          enabled: getBoolean(requestItem.enabled, true),
          sortNo: index,
          // 保存请求项原始纯数据，组装编辑器 SceneDefinition 时可无损恢复多请求面板状态。
          contentJson: {
            requestSnapshot: requestItem,
            dataConfigVersion: getNumber(dataConfig.version) ?? 1,
          },
        },
        `$.dependencies.dataBindings.${bindingKey}`,
      ),
    ]
  })
}

const createBehaviorAction = (value: unknown, path: string): ScenePackageJsonObject => {
  const action = getRecord(value)
  const targets: SceneDependencyOwner[] = []
  const objectTarget = getString(action.actionTargetUuid)
  if (objectTarget) {
    targets.push({ domain: 'threeD', ownerType: 'instance', instanceId: objectTarget })
  }
  for (const widgetTarget of getArray(action.actionTargetWidgetIds).map(getString)) {
    if (widgetTarget) targets.push(createInstanceOwner('twoD', widgetTarget))
  }
  return cloneRecord(
    {
      actionKey: getString(action.id) ?? path,
      actionType: getString(action.actionType) ?? 'custom',
      targets,
      ...(getString(action.observationTargetUuid)
        ? {
            observationTargets: [
              {
                domain: 'threeD',
                ownerType: 'instance',
                instanceId: action.observationTargetUuid,
              },
            ],
          }
        : {}),
      config: action,
    },
    path,
  )
}

/** 把旧面板的“条件组→条件块”结构拍平为后端行为包的条件组。 */
const createBehaviorConditionGroups = (
  behavior: JsonRecord,
  behaviorKey: string,
): ScenePackageJsonValue[] => {
  const result: ScenePackageJsonValue[] = []
  for (const [groupIndex, groupValue] of getArray(behavior.conditionGroupList).entries()) {
    const group = getRecord(groupValue)
    const blocks = getArray(group.conditionBlokList)
    const blockValues = blocks.length > 0 ? blocks : [{}]
    for (const [blockIndex, blockValue] of blockValues.entries()) {
      const block = getRecord(blockValue)
      const conditionGroupKey =
        getString(block.id) ??
        getString(group.id) ??
        `${behaviorKey}:group:${groupIndex + 1}:${blockIndex + 1}`
      result.push(
        cloneRecord(
          {
            conditionGroupKey,
            ...(getString(group.conditionGroupName) ? { name: group.conditionGroupName } : {}),
            conditionRuleType: getString(block.conditionRuleType) ?? 'all',
            conditions: getArray(block.conditionList).map((conditionValue, conditionIndex) => {
              const condition = getRecord(conditionValue)
              return {
                conditionKey:
                  getString(condition.id) ?? `${conditionGroupKey}:condition:${conditionIndex + 1}`,
                enabled: getBoolean(condition.status, true),
                judgment: getString(condition.judgmentType) ?? 'Equal',
                left: {
                  kind: getString(condition.sourceObjectType) ?? 'fixedValue',
                  value: condition.sourceFixedValue ?? null,
                  valueType: getString(condition.sourceFixedValueType),
                },
                right: {
                  kind: getString(condition.targetObjectType) ?? 'fixedValue',
                  value: condition.targetFixedValue ?? null,
                  valueType: getString(condition.targetFixedValueType),
                },
                contentJson: condition,
              }
            }),
            actions: getArray(block.actionList).map((action, actionIndex) =>
              createBehaviorAction(
                action,
                `$.dependencies.behaviors.${behaviorKey}.actions[${actionIndex}]`,
              ),
            ),
          },
          `$.dependencies.behaviors.${behaviorKey}.conditionGroups[${result.length}]`,
        ),
      )
    }
  }
  return result
}

const createInstanceBehaviors = (
  config: JsonRecord,
  instanceId: string,
  domain: SceneDependencyOwner['domain'],
): ScenePackageJsonValue[] => {
  const owner = createInstanceOwner(domain, instanceId)
  const result: ScenePackageJsonValue[] = []
  const append = (value: unknown, index: number, behaviorType: 'status' | 'interaction') => {
    const behavior = getRecord(value)
    const behaviorKey = getString(behavior.id) ?? `${instanceId}:${behaviorType}:${index + 1}`
    result.push(
      cloneRecord(
        {
          behaviorKey,
          owner,
          behaviorType,
          name:
            getString(behaviorType === 'status' ? behavior.statusName : behavior.eventName) ??
            behaviorKey,
          ...(behaviorType === 'interaction' && getString(behavior.eventType)
            ? { eventType: behavior.eventType }
            : {}),
          enabled: getBoolean(behavior.isOpen, true),
          sortNo: index,
          conditionGroups: createBehaviorConditionGroups(behavior, behaviorKey),
          // 原配置仅作为编辑器逆向恢复依据；运行态使用上方结构化字段建立索引。
          contentJson: { legacyConfig: behavior },
        },
        `$.dependencies.behaviors.${behaviorKey}`,
      ),
    )
  }
  getArray(config.statusList).forEach((item, index) => append(item, index, 'status'))
  getArray(config.interactiveEvent).forEach((item, index) => append(item, index, 'interaction'))
  return result
}

/**
 * 将实例上的旧设备编号提升为结构化设备绑定。
 * richer deviceBinding 中的通道和映射字段继续保留，但拥有者与稳定编号始终由当前实例覆盖，
 * 防止旧私有字段伪造跨域归属。
 */
const createInstanceDeviceBindings = (
  config: JsonRecord,
  instanceId: string,
  domain: SceneDependencyOwner['domain'],
): ScenePackageJsonValue[] => {
  const deviceId = getString(config.deviceId)
  const legacyBinding = getRecord(config.deviceBinding)
  if (!deviceId && !hasKeys(legacyBinding)) return []
  const bindingKey = getString(legacyBinding.bindingKey) ?? `${instanceId}:device`
  return [
    cloneRecord(
      {
        ...legacyBinding,
        bindingKey,
        owner: createInstanceOwner(domain, instanceId),
        ...(deviceId ? { deviceId } : {}),
      },
      `$.dependencies.deviceBindings.${bindingKey}`,
    ),
  ]
}

/** 资源市场图片使用的稳定来源标记；历史数据缺失该字段时统一按外部地址处理。 */
const WIDGET_IMAGE_RESOURCE_MARKET_SOURCE = 'resource-market'

/** 测验与按钮按图片槽位遍历可换资源，按稳定编号去重，避免普通态和按下态复用图片时重复登记。 */
const getWidgetImageResourceKeys = (option: JsonRecord) => [
  ...new Set(
    Object.values(getRecord(option.images)).flatMap((value) => {
      const image = getRecord(value)
      const resourceKey = getString(image.resourceKey)
      return getString(image.sourceType) === WIDGET_IMAGE_RESOURCE_MARKET_SOURCE && resourceKey
        ? [resourceKey]
        : []
    }),
  ),
]

/**
 * 净化二维组件的图片资源字段。
 *
 * VImage 的资源市场模式仅保存 sourceType 和 resourceKey，当前解析地址必须清空；外部资源继续
 * 保存 value，并删除可能残留的市场编号。测验和按钮的嵌套图片槽位遵循同一净化协议。
 */
const sanitizeOrdinaryWidgetOption = (componentType: string, option: JsonRecord): JsonRecord => {
  const sanitized = { ...option }
  if (componentType === 'VImage') {
    if (getString(sanitized.sourceType) === WIDGET_IMAGE_RESOURCE_MARKET_SOURCE) {
      sanitized.value = ''
    } else {
      /** 未标记为市场来源的历史配置就是外部资源，不能让陈旧编号改变其保存语义。 */
      delete sanitized.resourceKey
    }
  } else if (componentType === 'VImageCarousel') {
    delete sanitized.resourceKeys
  } else if (componentType === 'VPageMenu') {
    delete sanitized.barBackgroundImageResourceKey
    delete sanitized.buttonBackgroundImageResourceKey
    const background = getRecord(sanitized.background)
    const backgroundResourceKey = getString(background.resourceKey)
    if (backgroundResourceKey) {
      /** 页面框架资源市场图片只保存稳定编号，运行时地址由资源依赖重新解析。 */
      sanitized.background = {
        ...background,
        sourceType: WIDGET_IMAGE_RESOURCE_MARKET_SOURCE,
        value: '',
        resourceKey: backgroundResourceKey,
      }
    }
  } else if (componentType === 'VQuiz' || componentType === 'VButton') {
    // 每个槽位独立净化，不把临时地址写入场景或发布快照，也不修改编辑器原配置。
    const images = getRecord(sanitized.images)
    sanitized.images = Object.fromEntries(
      Object.entries(images).map(([key, value]) => {
        const image = { ...getRecord(value) }
        if (getString(image.sourceType) === WIDGET_IMAGE_RESOURCE_MARKET_SOURCE) {
          image.value = ''
        } else {
          delete image.resourceKey
        }
        return [key, image]
      }),
    )
  }
  return sanitized
}

const toTwoDComponent = (
  value: unknown,
  index: number,
  layerTree: readonly unknown[],
): WidgetPackageProjection | undefined => {
  const widget = cloneWidgetConfigRecord(value, `$.twoD.widgets[${index}]`)
  const component = getRecord(widget.component)
  const info = getRecord(component.info)
  const id = getString(widget.id)
  if (!id) return undefined
  const parentInstanceId = getString(widget.parentId)
  const styles = getRecord(component.styles)
  const layerKey = resolveWidgetLayerKey(id, layerTree)
  const componentType = getString(info.keyName) ?? getString(info.packageName) ?? 'widget'
  const option = getRecord(component.option)
  /** 只有明确选择资源市场且具备稳定编号的二维图片才进入资源依赖，其余组件保持空数组。 */
  const imageResourceKey =
    componentType === 'VImage' &&
    getString(option.sourceType) === WIDGET_IMAGE_RESOURCE_MARKET_SOURCE
      ? getString(option.resourceKey)
      : undefined
  const pageFrameBackgroundResourceKey =
    componentType === 'VPageMenu' ? getString(getRecord(option.background).resourceKey) : undefined
  const resourceRefKeys = [
    ...new Set([
      ...(imageResourceKey ? [imageResourceKey] : []),
      ...(pageFrameBackgroundResourceKey ? [pageFrameBackgroundResourceKey] : []),
      ...(['VQuiz', 'VButton'].includes(componentType) ? getWidgetImageResourceKeys(option) : []),
    ]),
  ]
  const renderConfig = sanitizeOrdinaryWidgetOption(componentType, option)
  const persistentInfo = { ...info }
  /** 组件面板图标来自当前版本组件注册表，不属于场景内容，也不能固化开发机地址。 */
  delete persistentInfo.icon
  const renderOnlyComponent = Object.fromEntries(
    Object.entries(component).filter(
      ([key]) =>
        key !== 'dataConfig' &&
        key !== 'statusList' &&
        key !== 'interactiveEvent' &&
        key !== 'deviceId' &&
        key !== 'deviceBinding' &&
        key !== 'resourceRefKeys' &&
        key !== 'resourceAssets',
    ),
  )
  renderOnlyComponent.info = persistentInfo
  renderOnlyComponent.option = renderConfig
  /** 清理旧版二维资源投影字段，避免历史编号在下一次保存时重新进入四包。 */
  const persistentWidget = { ...widget }
  delete persistentWidget.resourceRefKeys
  delete persistentWidget.resourceAssets
  persistentWidget.component = renderOnlyComponent
  return {
    component: {
      instanceId: id,
      ...(parentInstanceId ? { parentInstanceId } : {}),
      componentType,
      resourceRefKeys,
      visible: getBoolean(component.visible ?? widget.visible, true),
      locked: getBoolean(component.locked ?? widget.locked, false),
      ...(layerKey ? { layerKey } : {}),
      sortNo: index,
      layoutConfig: cloneRecord(component.attr, `$.twoD.components[${index}].layoutConfig`),
      styleConfig: cloneRecord(styles, `$.twoD.components[${index}].styleConfig`),
      renderConfig: cloneRecord(renderConfig, `$.twoD.components[${index}].renderConfig`),
      // 现有部件协议把动画保存为数组，后端二维包要求对象，使用 items 包装而不丢失顺序。
      animationConfig: cloneRecord(
        Array.isArray(styles.animations) ? { items: styles.animations } : (styles.animations ?? {}),
        `$.twoD.components[${index}].animationConfig`,
      ),
      // contentJson 只保留渲染私有字段；数据、状态和事件必须进入 dependencies。
      contentJson: cloneRecord(
        { widget: persistentWidget },
        `$.twoD.components[${index}].contentJson`,
      ),
    } as SceneTwoDComponentPackage,
    dataBindings: createInstanceDataBindings(component, id, 'twoD'),
    behaviors: createInstanceBehaviors(component, id, 'twoD'),
    deviceBindings: createInstanceDeviceBindings(component, id, 'twoD'),
  }
}

const addOwner = (owners: SceneDependencyOwner[], owner: SceneDependencyOwner) => {
  if (
    !owners.some(
      (item) =>
        item.domain === owner.domain &&
        item.ownerType === owner.ownerType &&
        item.instanceId === owner.instanceId &&
        item.ownerKey === owner.ownerKey,
    )
  )
    owners.push(owner)
}

/**
 * 按协议稳定键合并依赖记录，后出现的当前实例投影覆盖旧镜像。
 * 无稳定键的兼容记录不会互相覆盖，避免清理重复数据时误删尚未迁移的业务扩展。
 */
const mergeDependencyRecords = (
  values: readonly ScenePackageJsonValue[],
  keyNames: readonly string[],
): ScenePackageJsonValue[] => {
  const result: ScenePackageJsonValue[] = []
  const indexByKey = new Map<string, number>()
  values.forEach((value) => {
    const record = getRecord(value)
    const stableKey = keyNames.map((name) => getString(record[name])).find(Boolean)
    const owner = getRecord(record.owner)
    const ownerDomain = getString(owner.domain)
    const ownerType = getString(owner.ownerType)
    const ownerId = getString(owner.instanceId) ?? getString(owner.ownerKey)
    /** 同名依赖仅当拥有者也一致时才能覆盖，防止二维、三维同编号互相吞掉。 */
    const key =
      stableKey && ownerDomain && ownerType && ownerId
        ? `${ownerDomain}:${ownerType}:${ownerId}:${stableKey}`
        : stableKey
    if (!key) {
      result.push(value)
      return
    }
    const oldIndex = indexByKey.get(key)
    if (oldIndex === undefined) {
      indexByKey.set(key, result.length)
      result.push(value)
    } else {
      result[oldIndex] = value
    }
  })
  return result
}

const collectDependencies = (
  scene: SceneDefinition,
  projectedTwoDComponents: readonly SceneTwoDComponentPackage[],
  projectedDataBindings: ScenePackageJsonValue[],
  projectedBehaviors: ScenePackageJsonValue[],
  projectedDeviceBindings: ScenePackageJsonValue[],
): SceneDependenciesPackage => {
  const resources = new Map<string, SceneResourcePackage>()
  const settings = getSettings(scene)
  /**
   * 已组装的新场景把正式依赖保存于 settings.dependencies。仅当它不存在时，才读取历史镜像，
   * 以支持“历史脏数据加载后重新保存自动净化”；一旦正式包存在，旧镜像绝不能再次合并。
   */
  const source = isScenePackageRecord(settings.dependencies)
    ? settings.dependencies
    : getRecord(settings.sceneRuntimeDependencies)
  /**
   * 新格式场景加载时，dependencies 中的数据绑定、行为和设备绑定已经按拥有者恢复到
   * 当前二维/三维实例；保存时必须以本轮实例投影为唯一权威来源，不能再次把旧镜像合并进来。
   * 旧格式场景没有正式 dependencies 包，才读取 sceneRuntimeDependencies 作为兼容回退。
   */
  const hasFormalDependencyPackage = isScenePackageRecord(settings.dependencies)

  /**
   * 记录旧版本二维资源投影使用过的编号。重新保存时，这些资源若没有三维拥有者必须移除，
   * 但不能影响三维模型或三维看板仍在使用的同一资源。
   */
  const legacyTwoDResourceKeys = new Set<string>()
  for (const widgetValue of getArray(getWidgetSnapshot(scene)?.widgets)) {
    const widget = getRecord(widgetValue)
    const component = getRecord(widget?.component)
    const option = getRecord(component?.option)
    const keys = [
      ...getArray(widget?.resourceRefKeys),
      ...getArray(component?.resourceRefKeys),
      getString(option?.resourceKey),
      ...getArray(option?.resourceKeys).map(getString),
      getString(option?.barBackgroundImageResourceKey),
      getString(option?.buttonBackgroundImageResourceKey),
      getString(getRecord(option?.background).resourceKey),
      // 多图片槽位的旧投影也要参与清理，避免替换按钮背景后残留无拥有者资源。
      ...getWidgetImageResourceKeys(option),
    ]
    keys.map(getString).forEach((key) => {
      if (key) legacyTwoDResourceKeys.add(key)
    })
  }

  /**
   * 重新保存已加载场景时先接收规范依赖包中的资源描述，再由当前领域对象补充拥有者。
   * 历史资源记录可能带地址或版本，因此必须先净化，不能因为它来自 dependencies 就默认可信。
   */
  for (const value of getArray(source.resources)) {
    /**
     * 重新保存历史场景时先清掉全部植被资源，避免旧依赖记录绕过当前登记逻辑再次写回资源包。
     * 预览和发布资源由后端按场景发布快照返回，保存包只保留普通场景资源依赖。
     */
    if (isVegetationResource(value)) continue
    const sanitized = cloneResourcePersistenceValue(value, '$.dependencies.resources[]')
    if (!isScenePackageRecord(sanitized)) continue
    const resourceKey = getString(sanitized.resourceKey) ?? getString(sanitized.assetId)
    const assetId = getString(sanitized.assetId) ?? resourceKey
    const kind = getString(sanitized.kind)
    if (
      !resourceKey ||
      !assetId ||
      !kind ||
      isLegacyFallbackAssetReference(resourceKey, assetId) ||
      isBuiltinSceneAssetId(assetId)
    ) {
      continue
    }
    const owners = getArray(sanitized.owners)
      .map((owner) => getRecord(owner))
      .filter((owner) => getString(owner.domain) && getString(owner.ownerType))
      .map((owner) => owner as SceneDependencyOwner)
    const persistentOwners = owners.filter(
      (owner) => !(owner.domain === 'twoD' && owner.ownerType === 'instance'),
    )
    /** 旧二维普通组件资源不再属于 dependencies；无拥有者时仅按历史编号集合判断。 */
    if (
      (owners.length > 0 && persistentOwners.length === 0) ||
      (owners.length === 0 && legacyTwoDResourceKeys.has(resourceKey))
    ) {
      continue
    }
    resources.set(resourceKey, {
      ...sanitized,
      resourceKey,
      assetId,
      kind,
      owners: persistentOwners,
    })
  }

  const register = (asset: AssetRef, owner: SceneDependencyOwner, usageType?: string) => {
    /**
     * 防御旧内存快照中的对象级回退键，避免本轮保存再次固化已知坏数据。
     * 正常模型、用户图片和图标会使用资源服务提供的独立 assetId，不会命中此分支。
     */
    if (
      isLegacyFallbackAssetReference(asset.id, asset.id) ||
      isBuiltinSceneAssetId(asset.id) ||
      isVegetationResource({
        resourceKey: asset.id,
        assetId: asset.id,
        kind: asset.kind,
        usageType,
      })
    )
      return
    const old = resources.get(asset.id)
    if (old) {
      addOwner(old.owners, owner)
      old.kind = asset.kind
      if (asset.hash) old.contentHash = asset.hash
      return
    }
    resources.set(asset.id, {
      resourceKey: asset.id,
      assetId: asset.id,
      kind: asset.kind,
      /**
       * 资源包只保存稳定编号和摘要。AssetRef.url 可能是临时授权地址，必须在编辑或运行态
       * 通过资源解析接口按 assetId 重新获取，不能写进场景快照形成过期地址或泄露签名参数。
       */
      ...(asset.hash ? { contentHash: asset.hash } : {}),
      ...(asset.materialProfile
        ? {
            materialRules: cloneScenePackageJsonValue(
              asset.materialProfile.rules,
              `$.dependencies.resources.${asset.id}.materialRules`,
            ),
          }
        : {}),
      ...(asset.metadata
        ? {
            metadata: cloneResourcePersistenceValue(
              asset.metadata,
              `$.dependencies.resources.${asset.id}.metadata`,
            ),
          }
        : {}),
      ...(usageType ? { usageType } : {}),
      ...(asset.modelLodVariants
        ? {
            lodVariants: asset.modelLodVariants.map((variant) => ({
              assetId: variant.id,
              kind: variant.kind,
              minimumDistance: variant.minimumDistance,
              ...(variant.hash ? { contentHash: variant.hash } : {}),
              ...(variant.maximumScreenSpaceRatio === undefined
                ? {}
                : { maximumScreenSpaceRatio: variant.maximumScreenSpaceRatio }),
            })),
          }
        : {}),
      owners: [owner],
    })
  }
  for (const object of scene.objects) {
    const owner = { domain: 'threeD' as const, ownerType: 'instance', instanceId: object.id }
    if (object.asset) register(object.asset, owner)
    for (const asset of getBillboardImageResourceRefs(object)) register(asset, owner)
  }
  /**
   * 二维图片和页面框架背景的资源市场模式与三维看板共用同一 OSS 解析契约。
   * 这里只线性扫描一次部件列表并登记稳定编号；当前 URL 仅满足 AssetRef 的运行时形态，register
   * 会在写入 dependencies 时主动丢弃它。
   */
  /**
   * 资源依赖以最终二维投影为准，而不是再次读取编辑器快照。
   * 这样即使快照经过组装、字段净化或旧格式迁移，保存包中已落地的 resourceRefKeys 仍一定会生成
   * 对应 dependencies.resources；同时保留快照回退逻辑兼容未经过投影的历史场景。
   */
  const projectedMarketImages = projectedTwoDComponents
    .filter(
      (component) =>
        component.componentType === 'VImage' ||
        component.componentType === 'VPageMenu' ||
        component.componentType === 'VQuiz' ||
        component.componentType === 'VButton',
    )
    .map((component) => ({
      instanceId: component.instanceId,
      componentType: component.componentType,
      option: getRecord(component.renderConfig),
    }))
  for (const [index, widgetValue] of [
    ...projectedMarketImages,
    ...getArray(getWidgetSnapshot(scene)?.widgets).map((value) => {
      const widget = getRecord(value)
      const component = getRecord(widget.component)
      return {
        instanceId: getString(widget.id),
        componentType: getString(getRecord(component.info).keyName),
        option: getRecord(component.option),
      }
    }),
  ].entries()) {
    const option = widgetValue.option
    const componentType = widgetValue.componentType
    const background = getRecord(option.background)
    const isPageFrame = componentType === 'VPageMenu'
    if (componentType === 'VQuiz' || componentType === 'VButton') {
      const instanceId = getString(widgetValue.instanceId) ?? `widget-${index + 1}`
      const seenResourceKeys = new Set<string>()
      /** 测验与按钮的各图片位按稳定编号建立依赖，同一实例重用编号只登记一次。 */
      for (const imageValue of Object.values(getRecord(option.images) ?? {})) {
        const image = getRecord(imageValue)
        const resourceKey = getString(image?.resourceKey)
        if (
          !image ||
          getString(image.sourceType) !== WIDGET_IMAGE_RESOURCE_MARKET_SOURCE ||
          !resourceKey ||
          seenResourceKeys.has(resourceKey)
        ) {
          continue
        }
        seenResourceKeys.add(resourceKey)
        register(
          { id: resourceKey, kind: 'image', url: getString(image?.value) ?? '' },
          { domain: 'twoD', ownerType: 'instance', instanceId },
        )
      }
      continue
    }
    if (!isPageFrame && getString(option.sourceType) !== WIDGET_IMAGE_RESOURCE_MARKET_SOURCE) {
      continue
    }
    const resourceKey = isPageFrame
      ? getString(background.resourceKey)
      : getString(option.resourceKey)
    if (!resourceKey) continue
    const instanceId = getString(widgetValue.instanceId) ?? `widget-${index + 1}`
    register(
      {
        id: resourceKey,
        kind: 'image',
        url: isPageFrame ? (getString(background.value) ?? '') : (getString(option.value) ?? ''),
      },
      { domain: 'twoD', ownerType: 'instance', instanceId },
    )
  }
  for (const layer of scene.layers)
    if (layer.asset)
      register(layer.asset, { domain: 'threeD', ownerType: 'layer', ownerKey: layer.id })
  for (const effect of scene.effects)
    for (const asset of effect.assetRefs ?? [])
      register(asset, { domain: 'threeD', ownerType: 'effect', ownerKey: effect.id })
  /**
   * 植被资源不在这里登记。threeDJson.vegetation 只保存规则、物种和发布版本引用，模型、清单及瓦片
   * 地址由后端植被预览资源接口在运行时按发布快照返回，避免 dependencies.resources 形成第二份来源。
   */
  const readArray = (...keys: string[]) =>
    keys.map((key) => source[key] ?? settings[key]).find(Array.isArray) ?? []
  const sceneDataBindings = cloneScenePackageJsonValue(
    hasFormalDependencyPackage ? [] : readArray('dataBindings', 'dataConfig'),
    '$.dependencies.dataBindings',
  ) as ScenePackageJsonValue[]
  const sceneBehaviors = cloneScenePackageJsonValue(
    hasFormalDependencyPackage ? [] : readArray('behaviors', 'behaviorConfig', 'taskEventConfig'),
    '$.dependencies.behaviors',
  ) as ScenePackageJsonValue[]
  return {
    resources: Array.from(resources.values()),
    dataBindings: mergeDependencyRecords(
      [...sceneDataBindings, ...projectedDataBindings],
      ['bindingKey', 'id'],
    ),
    behaviors: mergeDependencyRecords(
      [...sceneBehaviors, ...projectedBehaviors],
      ['behaviorKey', 'id'],
    ),
    deviceBindings: mergeDependencyRecords(
      [
        ...(cloneScenePackageJsonValue(
          hasFormalDependencyPackage ? [] : readArray('deviceBindings'),
          '$.dependencies.deviceBindings',
        ) as ScenePackageJsonValue[]),
        ...projectedDeviceBindings,
      ],
      ['bindingKey', 'id'],
    ),
  }
}

/** 将 SceneDefinition 按设计拆成四个纯数据包；GIS/local3d 共用同一转换链路。 */
export const createSceneFourPackageDocuments = (
  scene: SceneDefinition,
): SceneFourPackageDocuments => {
  const layerTree = getArray(getWidgetSnapshot(scene).widgetLayerTree)
  const widgets = getArray(getWidgetSnapshot(scene).widgets)
  const twoDComponents: SceneTwoDComponentPackage[] = []
  const projectedDataBindings: ScenePackageJsonValue[] = []
  const projectedBehaviors: ScenePackageJsonValue[] = []
  const projectedDeviceBindings: ScenePackageJsonValue[] = []
  widgets.forEach((item, index) => {
    const projection = toTwoDComponent(item, index, layerTree)
    if (!projection) return
    twoDComponents.push(projection.component)
    projectedDataBindings.push(...projection.dataBindings)
    projectedBehaviors.push(...projection.behaviors)
    projectedDeviceBindings.push(...projection.deviceBindings)
  })

  /**
   * 三维面板暂时把依赖编辑态放在 SceneObject.metadata；保存边界只扫描对象一次，
   * 同时生成三类依赖，避免为数据、行为和设备分别遍历整棵对象列表。
   */
  for (const object of scene.objects) {
    const metadata = getRecord(object.metadata)
    projectedDataBindings.push(...createInstanceDataBindings(metadata, object.id, 'threeD'))
    projectedBehaviors.push(...createInstanceBehaviors(metadata, object.id, 'threeD'))
    projectedDeviceBindings.push(...createInstanceDeviceBindings(metadata, object.id, 'threeD'))
  }
  const settings = getSettings(scene)
  const editor = getRecord(settings.editor)
  const widgetCanvas = getRecord(getWidgetSnapshot(scene).widgetCanvas ?? editor.widgetCanvas)
  const scenePanel = getRecord(editor.scenePanel)
  /** 场景级定义只投影一次，避免对大型公共接口列表重复深复制。 */
  const sceneGlobalPackage = collectSceneGlobalPackage(scene)
  /**
   * 三维基础设置使用显式白名单，禁止把加载器注入的 dependencies、发布状态、运行模式或
   * 二维快照再次带回 threeD。新增可持久化设置必须在这里明确评审后加入。
   */
  const threeDBaseSettings = {
    ...(hasKeys(settings.three) ? { three: settings.three } : {}),
    ...(hasKeys(scenePanel) ? { editor: { scenePanel } } : {}),
  }
  const gisLayers = scene.layers.filter((layer) =>
    ['imagery', 'terrain', 'tileset', 'vector'].includes(layer.type),
  )
  return attachDataBindingOverflow({
    scene: {
      schemaVersion: scene.schemaVersion,
      /**
       * 场景主键由 saveAll 请求顶层的 sceneId 承载，不能复制进 sceneJson。
       * 复制场景时后端不会解析并重写包内字段，若在此保存 id，会让副本永久携带源场景编号。
       */
      name: scene.name,
      sceneType: scene.type,
      domainSlots: { twoD: 'present', threeD: 'present' },
      metadata: cloneRecord(scene.metadata, '$.scene.metadata'),
      ...sceneGlobalPackage,
    },
    threeD: {
      baseConfig: cloneRecord(
        {
          scene: settings.scene ?? {},
          camera: settings.camera ?? {},
          weather: settings.weather ?? {},
          coordinateSystem: scene.coordinateSystem,
          gisLayers: gisLayers.map(toLayer),
          // 二维快照由 twoD/dependencies 负责；这里只保留其它场景及编辑器设置。
          settings: threeDBaseSettings,
        },
        '$.threeD.baseConfig',
      ),
      objects: scene.objects
        .filter((object) => object.type === 'model' || object.type === 'tileset')
        .map((object) => toThreeTarget(object, scene.id)),
      components: scene.objects
        .filter((object) => object.type !== 'model' && object.type !== 'tileset')
        .map((object) => toThreeTarget(object, scene.id)),
      layers: scene.layers.map(toLayer),
      streaming: cloneRecord(
        scene.streaming ?? { groups: [], chunks: [], chunkTargets: [] },
        '$.threeD.streaming',
      ),
      cameraPaths: cloneScenePackageJsonValue(
        scene.cameraPaths ?? [],
        '$.threeD.cameraPaths',
      ) as ScenePackageJsonValue[],
      ...(scene.vegetation
        ? {
            /** 植被专用净化保留业务版本和摘要，只剥离当前会话的资源地址与认证信息。 */
            vegetation: cloneRecord(
              cloneVegetationPersistenceValue(scene.vegetation),
              '$.threeD.vegetation',
            ),
          }
        : {}),
    },
    twoD: {
      canvas: cloneRecord(widgetCanvas, '$.twoD.canvas'),
      components: twoDComponents,
      layerTree: cloneScenePackageJsonValue(
        layerTree,
        '$.twoD.layerTree',
      ) as ScenePackageJsonValue[],
    },
    dependencies: collectDependencies(
      scene,
      twoDComponents,
      projectedDataBindings,
      projectedBehaviors,
      projectedDeviceBindings,
    ),
  })
}

const stringify = (value: unknown, path: string) =>
  JSON.stringify(cloneScenePackageJsonValue(value, path))

/** 序列化已经完成投影或模板裁剪的四包文档，保证所有保存入口共用同一严格 JSON 边界。 */
export const serializeSceneFourPackageDocuments = (
  documents: SceneFourPackageDocuments,
): SceneFourPackagePayload => ({
  sceneJson: stringify(documents.scene, '$.sceneJson'),
  threeDJson: stringify(documents.threeD, '$.threeDJson'),
  twoDJson: stringify(documents.twoD, '$.twoDJson'),
  dependenciesJson: stringify(documents.dependencies, '$.dependenciesJson'),
})

/** 为 `PUT /dim3d/scene/saveAll` 生成四个 JSON 字符串。 */
export const serializeSceneDefinitionToFourPackages = (
  scene: SceneDefinition,
): SceneFourPackagePayload =>
  serializeSceneFourPackageDocuments(createSceneFourPackageDocuments(scene))
export const sceneDefinitionToFourPackages = serializeSceneDefinitionToFourPackages

/** 兼容早期草稿 API。 */
export const createSceneFourPackage = createSceneFourPackageDocuments
export const serializeSceneFourPackage = (scene: SceneDefinition): SerializedSceneFourPackage => ({
  ...serializeSceneDefinitionToFourPackages(scene),
  schemaVersion: scene.schemaVersion,
})

/** 解析四包字符串为结构化文档；领域还原由运行态组装器负责。 */
export const parseSceneFourPackagePayload = (
  payload: SceneFourPackagePayload,
): SceneFourPackageDocuments => {
  const parse = (value: string, path: string) => {
    try {
      return cloneRecord(JSON.parse(value), path)
    } catch (error) {
      throw new Error(`${path} 解析失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const parsedScene = parse(payload.sceneJson, '$.sceneJson')
  /** 历史包中的根级 id 不再属于四包契约，解析时直接剥离而不是仅在组装时忽略。 */
  const { id: _discardedLegacySceneId, ...sceneWithoutId } = parsedScene
  return {
    scene: sceneWithoutId as unknown as SceneContainerPackage,
    threeD: parse(payload.threeDJson, '$.threeDJson') as unknown as SceneThreeDPackage,
    twoD: parse(payload.twoDJson, '$.twoDJson') as unknown as SceneTwoDPackage,
    dependencies: parse(
      payload.dependenciesJson,
      '$.dependenciesJson',
    ) as unknown as SceneDependenciesPackage,
  }
}

export const createDefaultSceneCoordinateSystem = (sceneType: SceneType) =>
  sceneType === 'gis'
    ? {
        kind: 'wgs84' as const,
        terrainEnabled: false,
        defaultLongitude: 104.0668,
        defaultLatitude: 30.5728,
        defaultHeight: 0,
      }
    : { kind: 'local' as const, unit: 'meter' as const, upAxis: 'Y' as const, gridEnabled: true }
