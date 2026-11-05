import { DRAG_MODEL_ENUM, MODEL_ENUM } from '@/enums'
import type { ResourceMarketAssetRef } from '@/types/threeScene'
import type { AnnotationPanelConfig, ImagePanelConfig } from '@/types/threeScene'
import { createSnowflakeId } from '@/utils/snowflakeId'
import { createDefaultBillboardConfig, normalizeBillboardConfig } from '../core/billboard'
import type { BillboardConfig } from '../core/types'
import type {
  GeoTransform,
  ModelLodVariant,
  SceneDefinition,
  SceneLightConfig,
  SceneObject,
  SceneObjectType,
  FirstPersonConfig,
} from '../core/types'

type VectorLike = {
  x?: number
  y?: number
  z?: number
}

type LngLatLike = {
  longitude?: number
  latitude?: number
  altitude?: number
}

/**
 * 场景定义可以持久化和事务回滚的最小数据范围。
 *
 * 编辑器拖拽来源可能来自 Vue 的响应式列表；其中的 Proxy 不能被 `structuredClone` 复制。
 * 此类型明确限制快照只保留 JSON 兼容的值，阻断 Vue、DOM、Three.js 等运行时对象进入 SceneStore。
 */
type SerializableEditorModelValue =
  | string
  | number
  | boolean
  | null
  | SerializableEditorModelValue[]
  | { [key: string]: SerializableEditorModelValue }

export type EditorSceneObjectModel = {
  name?: string
  type?: string
  modelType: DRAG_MODEL_ENUM
  icon?: string
  filePath?: string
  fileType?: MODEL_ENUM
  /**
   * 资源市场拖拽时传入的稳定资源身份。
   * 该字段只描述可复用的资源文件，不承载每个场景实例的变换、选中状态等对象级数据。
   */
  resourceAsset?: ResourceMarketAssetRef
  /** 前端随构建发布的资源键；它不对应后端文件编号，保存时由运行时注册表恢复地址。 */
  builtinResourceKey?: string
  imagePath?: string
  defaultImagePath?: string
  /** 组件面板把图片创建入口标记为看板，兼容旧 `DRAG_MODEL_ENUM.Image` 创建协议。 */
  componentKind?: 'billboard'
  /** 看板卡片或恢复快照携带的纯 JSON 配置；写入 SceneObject 前必须通过核心归一化。 */
  billboard?: Partial<BillboardConfig>
  /** 系统灯光卡片只传可序列化预设，不传运行时灯光对象。 */
  light?: Partial<SceneLightConfig>
  firstPerson?: Partial<FirstPersonConfig>
  position?: VectorLike
  rotation?: VectorLike
  scale?: VectorLike
  [key: string]: unknown
}

export interface EditorSceneObjectRuntimeSnapshot {
  engineObjectUuid?: string
  legacyOnlyUuid?: string
  name?: string
  visible?: boolean
  position?: VectorLike
  rotation?: VectorLike
  scale?: VectorLike
  lngLat?: LngLatLike
  offset?: VectorLike
  transparent?: boolean
  /** 运行时真实对象的统一可拾取状态；旧 `userData.isDrag` 只在集成边界读取。 */
  pickable?: boolean
  deviceId?: string
  /**
   * 旧图片对象的面板配置经过可序列化校验后随首次创建快照进入场景主副本。
   * 保持可选字段，确保历史模型与纯三维模型不会为此产生冗余元数据。
   */
  imagePanelConfig?: ImagePanelConfig
  /**
   * 标注的 DOM 图片不能进入场景 JSON；创建快照只保留 URL 或空值，防止持久化循环引用。
   */
  annotationPanelConfig?: Omit<AnnotationPanelConfig, 'backgroundImage'> & {
    backgroundImage: string | null
  }
  /**
   * 打点的实例节点由运行时派生，场景只保存可 JSON 化的父级资源配置以供恢复。
   */
  markingPanelConfig?: Record<string, unknown>
}

export interface EditorSceneObjectMappingOptions {
  objectId?: string
  point?: {
    clientX: number
    clientY: number
  }
  runtimeSnapshot?: EditorSceneObjectRuntimeSnapshot | null
  /**
   * CommandBus 首次创建模型或图片时保留旧运行时按拾取落点计算出的真实变换。
   * 该标记只存活到接入层回写运行时快照为止，避免默认 transform 在首帧覆盖真实位置和缩放。
   */
  preserveRuntimeCreatedTransform?: boolean
}

export interface EditorSceneObjectGisMappingOptions {
  objectId?: string
  point?: {
    clientX: number
    clientY: number
  }
  stageRect?: {
    left: number
    top: number
    width: number
    height: number
  } | null
  scene?: Pick<SceneDefinition, 'coordinateSystem'> | null
  /**
   * GIS Runtime 已解析出的真实拖拽落点。
   *
   * 该值必须是可序列化的经度、纬度、高程，不允许把 Cesium Cartesian3、Entity 或 Viewer 传入
   * SceneStore。存在且数值有效时，它的优先级高于旧的舞台相对位置估算。
   */
  resolvedPosition?: {
    longitude: number
    latitude: number
    height: number
  } | null
  /**
   * 当 Runtime 没有获得可靠世界点时，强制使用场景默认经纬高。
   *
   * GIS 正式拖拽链路开启该选项，避免把“拾取失败”悄悄替换成舞台比例估算；旧调用方不传时仍保留
   * 既有兼容行为，便于历史页面和纯 mapper 测试逐步迁移。
   */
  useSceneDefaultPositionWhenUnresolved?: boolean
}

interface GisPrimitiveStyle {
  shape: 'box' | 'ellipsoid' | 'cylinder' | 'capsule' | 'polyhedron'
  color: string
  outlineColor: string
  dimensions?: [number, number, number]
  radii?: [number, number, number]
  length?: number
  /** 胶囊体中央圆柱段长度，单位为 GIS 米制单位。 */
  capsuleLength?: number
  /** 胶囊体半径，单位为 GIS 米制单位。 */
  capsuleRadius?: number
  /** 胶囊体半球细分数量，用于还原 Three.js 几何质量。 */
  capsuleCapSegments?: number
  /** 胶囊体径向细分数量，用于还原 Three.js 几何质量。 */
  capsuleRadialSegments?: number
  topRadius?: number
  bottomRadius?: number
  /** 多面体类型，如 'DodecahedronGeometry'，用于在 GIS Runtime 中构建自定义 Cesium Geometry */
  polyhedronType?: string
  /** 多面体半径（已经过 GIS 尺寸放大），用于 Gizmo 包围盒和缩放计算 */
  polyhedronRadius?: number
}

interface GisAnnotationStyle {
  text: string
  font: string
  fillColor: string
  outlineColor: string
  outlineWidth: number
}

interface GisDropPosition {
  longitude: number
  latitude: number
  height: number
}

const DEFAULT_GIS_DROP_SPAN_DEGREES = 0.02
const DEFAULT_GIS_PRIMITIVE_COLOR = '#d8e3ff'
const DEFAULT_GIS_PRIMITIVE_OUTLINE_COLOR = '#39c5ff'
const DEFAULT_GIS_ANNOTATION_COLOR = '#ffffff'
const DEFAULT_GIS_ANNOTATION_OUTLINE_COLOR = '#082032'

const toNumber = (value: unknown, fallback: number) => {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

const toVectorTuple = (value: VectorLike | undefined, fallback: [number, number, number]) => {
  return [
    toNumber(value?.x, fallback[0]),
    toNumber(value?.y, fallback[1]),
    toNumber(value?.z, fallback[2]),
  ] as [number, number, number]
}

const toVectorMetadata = (value: VectorLike | undefined) => {
  if (!value) return undefined

  return {
    x: toNumber(value.x, 0),
    y: toNumber(value.y, 0),
    z: toNumber(value.z, 0),
  }
}

const toLngLatMetadata = (value: LngLatLike | undefined) => {
  if (!value) return undefined

  return {
    longitude: toNumber(value.longitude, 0),
    latitude: toNumber(value.latitude, 0),
    altitude: toNumber(value.altitude, 0),
  }
}

const mapObjectType = (modelType: DRAG_MODEL_ENUM): SceneObjectType => {
  switch (modelType) {
    case DRAG_MODEL_ENUM.Geometry:
    case DRAG_MODEL_ENUM.Pipe:
      return 'primitive'
    case DRAG_MODEL_ENUM.Annotation:
    case DRAG_MODEL_ENUM.Marking:
      return 'annotation'
    case DRAG_MODEL_ENUM.Image:
      return 'image'
    case DRAG_MODEL_ENUM.Light:
      return 'light'
    case DRAG_MODEL_ENUM.FirstPerson:
      return 'camera'
    case DRAG_MODEL_ENUM.Widget:
      return 'group'
    default:
      return 'model'
  }
}

/** 新场景对象使用字符串雪花编号，避免前端数值精度丢失并与后端长整型字符串协议一致。 */
const createObjectId = () => createSnowflakeId()

const toNonEmptyString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined

  const normalizedValue = value.trim()
  return normalizedValue || undefined
}

/**
 * 规范化资源市场传入的模型多细节层次（LOD）变体。
 *
 * 资源市场列表可能来自响应式代理或尚未升级的后端接口，因此不能把原数组直接写入 SceneStore。
 * 此处只保留顺序、编号、地址、版本、摘要和阈值均可信的 GLB / GLTF 条目；任一变体异常时仅忽略
 * 该变体，根资产仍可正常创建，避免一次资源配置问题阻塞后续模型拖入。保留的数组已经按距离严格
 * 升序，可让 Runtime 在相机刷新时无需排序或分配临时数组。
 */
const getResourceMarketModelLodVariants = (
  value: unknown,
  rootAssetId: string,
): ModelLodVariant[] | undefined => {
  if (!Array.isArray(value)) return undefined

  const variants: ModelLodVariant[] = []
  const variantIds = new Set<string>()
  let previousMinimumDistance = 0

  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue

    const candidate = item as Partial<ModelLodVariant>
    const id = toNonEmptyString(candidate.id)
    const url = toNonEmptyString(candidate.url)
    const kind = candidate.kind === 'glb' || candidate.kind === 'gltf' ? candidate.kind : undefined
    const minimumDistance = candidate.minimumDistance
    const maximumScreenSpaceRatio = candidate.maximumScreenSpaceRatio

    if (
      !id ||
      id === rootAssetId ||
      variantIds.has(id) ||
      !url ||
      !kind ||
      typeof minimumDistance !== 'number' ||
      !Number.isFinite(minimumDistance) ||
      minimumDistance <= previousMinimumDistance ||
      (maximumScreenSpaceRatio !== undefined &&
        (typeof maximumScreenSpaceRatio !== 'number' ||
          !Number.isFinite(maximumScreenSpaceRatio) ||
          maximumScreenSpaceRatio <= 0 ||
          maximumScreenSpaceRatio > 1))
    ) {
      continue
    }

    const version = toNonEmptyString(candidate.version)
    const hash = toNonEmptyString(candidate.hash)
    variants.push({
      id,
      kind,
      url,
      minimumDistance,
      ...(version ? { version } : {}),
      ...(hash ? { hash } : {}),
      ...(maximumScreenSpaceRatio !== undefined ? { maximumScreenSpaceRatio } : {}),
    })
    variantIds.add(id)
    previousMinimumDistance = minimumDistance
  }

  return variants.length > 0 ? variants : undefined
}

/**
 * 将拖拽模型递归转换为纯数据快照。
 *
 * 不能直接使用 `structuredClone(model)`：Vue 的响应式 Proxy 会抛出 DataCloneError，而拖拽的第一个
 * 模型写入 Store 后，会在第二次命令事务创建快照时使整个创建链路失败。这里按可枚举字段复制，
 * 能自然解包 Proxy，同时过滤函数、DOM、Three.Object3D、循环引用等不可持久化对象。
 * 数组中的不可序列化项以 null 占位，保持参数索引不偏移；对象字段则直接忽略，避免伪造业务配置。
 */
const cloneSerializableEditorModelValue = (
  value: unknown,
  ancestors: WeakSet<object>,
): SerializableEditorModelValue | undefined => {
  if (value === null) return null

  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'object') return undefined

  if (ancestors.has(value)) return undefined
  ancestors.add(value)

  try {
    if (Array.isArray(value)) {
      return value.map((item) => cloneSerializableEditorModelValue(item, ancestors) ?? null)
    }

    /**
     * Vue Proxy 的原型仍是 Object.prototype，可以安全逐字段复制；
     * 原型不是普通对象的值通常是 Window、DOM、Date、Map 或 Three.js 实例，全部禁止进入场景快照。
     */
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return undefined

    const snapshot: { [key: string]: SerializableEditorModelValue } = Object.create(null)
    for (const key of Object.keys(value)) {
      const clonedValue = cloneSerializableEditorModelValue(
        (value as Record<string, unknown>)[key],
        ancestors,
      )
      if (clonedValue !== undefined) snapshot[key] = clonedValue
    }
    return snapshot
  } catch {
    /**
     * 少数第三方 Proxy 的 getter 可能在读取时抛错。
     * 场景快照宁可忽略该不可持久化字段，也不能让一次拖拽阻断后续所有资源创建。
     */
    return undefined
  } finally {
    ancestors.delete(value)
  }
}

/**
 * 生成供 Runtime 恢复和场景保存使用的拖拽模型快照。
 *
 * 返回值与输入脱离引用关系，后续 Vue 列表刷新、卡片状态更新都不会反向污染已创建的场景对象。
 */
const createSerializableEditorModelSnapshot = (
  model: EditorSceneObjectModel,
): EditorSceneObjectModel => {
  const snapshot = cloneSerializableEditorModelValue(model, new WeakSet<object>())
  if (snapshot && !Array.isArray(snapshot)) {
    return snapshot as unknown as EditorSceneObjectModel
  }

  /**
   * 模型类型是创建 Runtime 实例的最低必要字段。
   * 极端输入无法复制时保留该标识，让后续 Runtime 可以安全返回失败结果并回滚本次对象。
   */
  return { modelType: model.modelType }
}

/**
 * 从拖拽快照读取可信的资源市场资产身份。
 *
 * 场景历史数据可能绕过当前 TypeScript 类型直接写入，因此这里再次校验必填的 ID 和 URL。
 * 校验失败时优先使用 builtinResourceKey 恢复内置资源；没有该键的历史创建协议才临时使用
 * `${objectId}:asset` 维持当前编辑会话。保存层会过滤该回退键，加载层也不会对它请求资源接口。
 * 不从路径或原始扩展字段推导哈希，避免把非内容标识写进资源缓存键。
 */
const getResourceMarketAssetRef = (
  model: EditorSceneObjectModel,
): ResourceMarketAssetRef | undefined => {
  const resourceAsset = model.resourceAsset
  const id = toNonEmptyString(resourceAsset?.id)
  const url = toNonEmptyString(resourceAsset?.url)

  if (!id || !url) return undefined

  const version = toNonEmptyString(resourceAsset?.version)
  const modelLodVariants = getResourceMarketModelLodVariants(resourceAsset?.modelLodVariants, id)

  return {
    id,
    url,
    ...(version ? { version } : {}),
    ...(modelLodVariants ? { modelLodVariants } : {}),
  }
}

const mapAsset = (objectId: string, model: EditorSceneObjectModel): SceneObject['asset'] => {
  if (model.modelType === DRAG_MODEL_ENUM.Image) {
    const resourceAsset = getResourceMarketAssetRef(model)
    /**
     * 三维看板和内置图片使用应用内组件配置恢复，不能伪造 `${objectId}:asset` 写入 dependencies。
     * 只有资源选择器明确提供了 OSS 等外部文件的稳定编号时，才把图片登记为可解析场景资源。
     */
    if (!resourceAsset) {
      const fallbackUrl = model.imagePath || model.defaultImagePath || ''
      return {
        /** 内置键只作为当前会话资产身份，正式保存时由集成层识别并排除资源依赖。 */
        id: model.builtinResourceKey ? `builtin:${model.builtinResourceKey}` : `${objectId}:asset`,
        kind: 'image',
        url: fallbackUrl,
      }
    }

    return {
      id: resourceAsset.id,
      kind: 'image',
      url: resourceAsset.url,
    }
  }

  if (
    (model.modelType === DRAG_MODEL_ENUM.Model ||
      model.modelType === DRAG_MODEL_ENUM.CustomModel) &&
    model.filePath
  ) {
    const resourceAsset = getResourceMarketAssetRef(model)

    if (model.fileType === MODEL_ENUM.UNITY_MODEL) {
      // 仅稳定编号进入场景依赖，地址在重新打开时按现有 Unity 托管规则重建。
      const id = resourceAsset?.id
      if (!id || !/^[1-9]\d{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n ||
        resourceAsset.url !== `unity-resource://${id}`) {
        throw new Error('受控模型缺少有效的稳定资源编号，请刷新资源列表后重试')
      }
      return { id, kind: 'unity-model', url: resourceAsset.url }
    }

    /** 内置模型只允许通过注册表声明资源身份，禁止继续由对象编号生成假文件编号。 */
    if (!resourceAsset) {
      return {
        /** 旧内置模型仍需在当前编辑器会话加载；四包保存时会过滤内置键和伪资源键。 */
        id: model.builtinResourceKey ? `builtin:${model.builtinResourceKey}` : `${objectId}:asset`,
        kind: model.fileType === MODEL_ENUM.GLTF ? 'gltf' : 'glb',
        url: model.filePath,
      }
    }

    return {
      /**
       * 同一资源市场文件的多个场景实例必须使用同一资源 ID，便于后续资源缓存复用。
       * 非资源市场模型必须显式提供 builtinResourceKey；绝不能再把对象编号伪造成资源编号。
       */
      id: resourceAsset.id,
      kind: model.fileType === MODEL_ENUM.GLTF ? 'gltf' : 'glb',
      /** 资源市场地址经校验后优先使用，缺失时保持旧文件路径加载行为。 */
      url: resourceAsset.url,
      /** 版本仅由后端资源字段提供；没有可信版本时不写入。 */
      ...(resourceAsset.version ? { version: resourceAsset.version } : {}),
      /**
       * 低细节变体已经在资源市场映射阶段完成纯数据校验和距离排序。
       * Runtime 仅在后续 LOD 调度任务中读取它；本次创建仍优先加载根资产，避免首次拖入等待所有
       * 变体，也不会干预 Cesium 影像、地形或原生三维瓦片。
       */
      ...(resourceAsset.modelLodVariants
        ? { modelLodVariants: resourceAsset.modelLodVariants }
        : {}),
      metadata: {
        editorFileType: model.fileType,
      },
    }
  }

  if (model.modelType === DRAG_MODEL_ENUM.Marking && model.icon) {
    const resourceAsset = getResourceMarketAssetRef(model)
    /** 内置打点图标没有外部文件编号，保持在组件快照中恢复，不创建不存在的资源市场引用。 */
    if (!resourceAsset) {
      return {
        /** 打点内置图标同样只作为旧运行时当前会话回退值，不进入正式资源依赖。 */
        id: `${objectId}:asset`,
        kind: 'image',
        url: model.icon,
      }
    }
    return {
      id: resourceAsset.id,
      kind: 'image',
      url: resourceAsset.url,
    }
  }

  return undefined
}

const toPositiveNumber = (value: unknown, fallback: number) => {
  const numberValue = toNumber(value, fallback)
  return numberValue > 0 ? numberValue : fallback
}

const toMaterialColor = (model: EditorSceneObjectModel) => {
  const material = model.material
  if (material && typeof material === 'object' && 'color' in material) {
    const color = (material as { color?: unknown }).color
    if (typeof color === 'string' && color.length > 0) return color
  }

  return DEFAULT_GIS_PRIMITIVE_COLOR
}

/**
 * 旧基础几何体的参数是本地三维尺寸，很多默认值只有 1。
 * GIS Entity 以米为单位渲染，直接照搬会在地图视角下几乎不可见；
 * 因此这里只在“拖入 GIS 场景”时做可视化尺寸放大，不影响本地三维旧链路。
 */
const toGisPrimitiveLength = (value: unknown, fallback: number) => {
  const length = toPositiveNumber(value, fallback)
  if (length <= 2) return length * 80
  if (length <= 20) return length * 8
  return length
}

const toUniformTuple = (value: number): [number, number, number] => [value, value, value]

const createGisPrimitiveStyle = (
  model: EditorSceneObjectModel,
): { style: GisPrimitiveStyle; heightOffset: number } => {
  const color = toMaterialColor(model)
  const baseStyle = {
    color,
    outlineColor: DEFAULT_GIS_PRIMITIVE_OUTLINE_COLOR,
  }

  switch (model.type) {
    case 'SphereGeometry': {
      const radius = toGisPrimitiveLength(model.radius, 80)
      return {
        style: {
          ...baseStyle,
          shape: 'ellipsoid',
          radii: toUniformTuple(radius),
        },
        heightOffset: radius,
      }
    }
    case 'DodecahedronGeometry':
    case 'IcosahedronGeometry':
    case 'OctahedronGeometry':
    case 'TetrahedronGeometry': {
      const radius = toGisPrimitiveLength(model.radius, 80)
      return {
        style: {
          ...baseStyle,
          shape: 'polyhedron',
          polyhedronType: model.type,
          polyhedronRadius: radius,
        },
        heightOffset: radius,
      }
    }
    case 'CapsuleGeometry': {
      const radius = toGisPrimitiveLength(model.radius, 40)
      const length = toGisPrimitiveLength(model.length ?? model.height, 40)
      return {
        style: {
          ...baseStyle,
          shape: 'capsule',
          capsuleRadius: radius,
          capsuleLength: length,
          capsuleCapSegments: Math.max(1, Math.floor(toNumber(model.capSegments, 10))),
          capsuleRadialSegments: Math.max(3, Math.floor(toNumber(model.radialSegments, 10))),
        },
        // 胶囊体底部位于中心下方 length / 2 + radius，落点要抬到最低点之上。
        heightOffset: length / 2 + radius,
      }
    }
    case 'CylinderGeometry':
    case 'ConeGeometry': {
      const length = toGisPrimitiveLength(model.height ?? model.length, 120)
      const topRadius =
        model.type === 'ConeGeometry'
          ? 0
          : toGisPrimitiveLength(model.radiusTop ?? model.radius, 40)
      const bottomRadius = toGisPrimitiveLength(model.radiusBottom ?? model.radius, 40)
      return {
        style: {
          ...baseStyle,
          shape: 'cylinder',
          length,
          topRadius,
          bottomRadius,
        },
        heightOffset: length / 2,
      }
    }
    case 'CircleGeometry':
    case 'PlaneGeometry': {
      const width = toGisPrimitiveLength(model.width ?? model.radius, 120)
      const height = toGisPrimitiveLength(model.height ?? model.radius, 120)
      const thickness = 2
      return {
        style: {
          ...baseStyle,
          shape: 'box',
          dimensions: [width, thickness, height],
        },
        heightOffset: thickness / 2,
      }
    }
    case 'TorusGeometry': {
      const radius = toGisPrimitiveLength(model.radius, 120)
      const tube = toGisPrimitiveLength(model.tube, 24)
      return {
        style: {
          ...baseStyle,
          shape: 'ellipsoid',
          radii: [radius + tube, radius + tube, tube],
        },
        heightOffset: tube,
      }
    }
    default: {
      if (model.modelType === DRAG_MODEL_ENUM.Pipe) {
        /**
         * GIS 首版暂不接旧管道路径编辑器。
         * 这里先把管道拖拽映射成一段可选中、可保存的横向基础体，后续再由管道适配器替换为真正路径对象。
         */
        return {
          style: {
            ...baseStyle,
            shape: 'box',
            dimensions: [220, 24, 24],
          },
          heightOffset: 12,
        }
      }

      const dimensions: [number, number, number] = [
        toGisPrimitiveLength(model.width, 100),
        toGisPrimitiveLength(model.depth, 100),
        toGisPrimitiveLength(model.height, 100),
      ]
      return {
        style: {
          ...baseStyle,
          shape: 'box',
          dimensions,
        },
        heightOffset: dimensions[2] / 2,
      }
    }
  }
}

const createGisAnnotationStyle = (model: EditorSceneObjectModel): GisAnnotationStyle => ({
  text: model.name || '标注',
  font: '16px sans-serif',
  fillColor: DEFAULT_GIS_ANNOTATION_COLOR,
  outlineColor: DEFAULT_GIS_ANNOTATION_OUTLINE_COLOR,
  outlineWidth: 2,
})

const getGisDefaultPosition = (options: EditorSceneObjectGisMappingOptions): GisDropPosition => {
  const coordinateSystem = options.scene?.coordinateSystem
  if (coordinateSystem?.kind !== 'wgs84') {
    return {
      longitude: 0,
      latitude: 0,
      height: 0,
    }
  }

  return {
    longitude: coordinateSystem.defaultLongitude,
    latitude: coordinateSystem.defaultLatitude,
    height: coordinateSystem.defaultHeight,
  }
}

/**
 * 校验 Runtime 传入的真实 GIS 落点。
 *
 * 坐标读取发生在 Cesium Runtime，mapper 只接收已经脱离引擎对象的数值快照；这里再次验证有限性，
 * 确保异常深度值不会污染可保存的 `GeoTransform`。
 */
const getResolvedGisDropPosition = (
  options: EditorSceneObjectGisMappingOptions,
): GisDropPosition | null => {
  const position = options.resolvedPosition
  if (!position) return null

  const { longitude, latitude, height } = position
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || !Number.isFinite(height)) {
    return null
  }

  return { longitude, latitude, height }
}

const mapStagePointToGisPosition = (
  options: EditorSceneObjectGisMappingOptions,
): GisDropPosition => {
  const resolvedPosition = getResolvedGisDropPosition(options)
  if (resolvedPosition) return resolvedPosition

  const defaultPosition = getGisDefaultPosition(options)
  if (options.useSceneDefaultPositionWhenUnresolved) {
    return defaultPosition
  }

  const { point, stageRect } = options

  if (!point || !stageRect || stageRect.width <= 0 || stageRect.height <= 0) {
    return defaultPosition
  }

  const normalizedX = (point.clientX - stageRect.left) / stageRect.width - 0.5
  const normalizedY = (point.clientY - stageRect.top) / stageRect.height - 0.5
  const latitudeSpan = DEFAULT_GIS_DROP_SPAN_DEGREES * (stageRect.height / stageRect.width)

  /**
   * 历史 GIS 调用方尚未接入 Runtime 世界点拾取时，才使用舞台相对位置在场景原点附近估算经纬度。
   * 正式 `SceneCanvas` 链路会传入 `resolvedPosition`；若拾取失败则显式启用场景默认坐标回退，
   * 因此该兼容分支不会再把新拖拽静默映射为近似坐标。
   */
  return {
    longitude: defaultPosition.longitude + normalizedX * DEFAULT_GIS_DROP_SPAN_DEGREES,
    latitude: defaultPosition.latitude - normalizedY * latitudeSpan,
    height: defaultPosition.height,
  }
}

const createGisTransform = (
  position: GisDropPosition,
  heightOffset = 0,
  scale: GeoTransform['scale'] = 1,
): GeoTransform => ({
  kind: 'geo',
  longitude: position.longitude,
  latitude: position.latitude,
  height: position.height + heightOffset,
  heading: 0,
  pitch: 0,
  roll: 0,
  scale,
  altitudeMode: 'absolute',
})

const createGisModelScale = (model: EditorSceneObjectModel): GeoTransform['scale'] => {
  if (model.scale) {
    return toVectorTuple(model.scale, [1, 1, 1])
  }

  /**
   * 新建模型实例必须与本地三维使用同一份领域默认值，即原始一倍缩放。
   * 尺寸适配属于资源制作或用户显式变换职责，不能在 GIS 映射层隐式放大；否则属性面板、保存数据
   * 与再次打开场景时都会把非用户设置的 20 倍误认为真实缩放。仅当资源模型明确传入 scale 时保留其值。
   */
  return 1
}

/**
 * 把旧编辑器拖拽模型映射为 scene-platform 领域对象。
 * 这里不创建 Three/Cesium 实例，只记录可 undo/redo、可持久化的业务对象快照。
 */
export function mapEditorCreationToSceneObject(
  model: EditorSceneObjectModel,
  options: EditorSceneObjectMappingOptions = {},
): SceneObject {
  const objectId = options.objectId ?? createObjectId()
  const runtimeSnapshot = options.runtimeSnapshot ?? null
  const runtimeLngLat = toLngLatMetadata(runtimeSnapshot?.lngLat)
  const runtimeOffset = toVectorMetadata(runtimeSnapshot?.offset)

  const object: SceneObject = {
    id: objectId,
    name: runtimeSnapshot?.name || model.name || '未命名对象',
    type: mapObjectType(model.modelType),
    visible: runtimeSnapshot?.visible ?? true,
    /** 旧创建入口没有独立锁定来源，初始值沿原可拾取快照推导；领域保存后两者独立。 */
    locked: runtimeSnapshot?.pickable === false,
    /** 新对象尚未确定最终同组位置，命令写入 Store 后会按实际插入位置连续重编号。 */
    order: 0,
    transform: {
      kind: 'local',
      position: toVectorTuple(runtimeSnapshot?.position ?? model.position, [0, 0, 0]),
      rotation: toVectorTuple(runtimeSnapshot?.rotation ?? model.rotation, [0, 0, 0]),
      scale: toVectorTuple(runtimeSnapshot?.scale ?? model.scale, [1, 1, 1]),
    },
    metadata: {
      editorModelType: model.modelType,
      editorGeometryType: model.type,
      /**
       * 场景事务使用 structuredClone 保存回滚快照。
       * 这里必须写入纯数据副本，不能把资源面板的 Vue 响应式 Proxy 直接存入 SceneStore。
       */
      editorModelSnapshot: createSerializableEditorModelSnapshot(model),
      dropPoint: options.point,
      /** 新对象默认可拾取，避免旧 Sprite 缺失 isDrag 时被交互层过滤。 */
      pickable: runtimeSnapshot?.pickable ?? true,
    },
  }

  if (model.modelType === DRAG_MODEL_ENUM.FirstPerson) {
    object.firstPerson = {
      enabled: model.firstPerson?.enabled ?? true,
      height: model.firstPerson?.height ?? 1.8,
      eyeHeight: model.firstPerson?.eyeHeight ?? 1.6,
      collisionRadius: model.firstPerson?.collisionRadius ?? 0.3,
      moveSpeed: model.firstPerson?.moveSpeed ?? 3,
      lookSensitivity: model.firstPerson?.lookSensitivity ?? 0.0025,
      fov: model.firstPerson?.fov ?? 75,
      lockPitch: model.firstPerson?.lockPitch ?? true,
      collisionEnabled: model.firstPerson?.collisionEnabled ?? true,
    }
    object.metadata = {
      ...object.metadata,
      firstPerson: true,
      pickable: true,
    }
  }

  if (model.modelType === DRAG_MODEL_ENUM.Light) {
    const kind = model.light?.kind === 'spot' ? 'spot' : 'point'
    object.light = {
      kind,
      color: model.light?.color ?? '#fff1d6',
      intensity: model.light?.intensity ?? (kind === 'point' ? 4 : 6),
      range: model.light?.range ?? (kind === 'point' ? 8 : 12),
      shadows: model.light?.shadows ?? false,
      ...(kind === 'spot'
        ? {
            innerConeAngle: model.light?.innerConeAngle ?? Math.PI / 9,
            outerConeAngle: model.light?.outerConeAngle ?? Math.PI / 6,
          }
        : {}),
    }
  }

  /**
   * 资源拖拽的命令主链路会先将领域对象交给 Runtime 创建真实 Object3D。
   * 旧创建器会基于鼠标落点和包围盒修正 transform，因此首轮同步必须暂时跳过默认 transform；
   * SceneCanvas 在 RuntimeBridge 完成后会带真实快照再次 upsert，此标记不会进入最终保存数据。
   */
  if (options.preserveRuntimeCreatedTransform) {
    object.metadata = {
      ...object.metadata,
      preserveRuntimeCreatedTransform: true,
    }
  }

  /**
   * 拖拽创建时旧 renderScene 会根据落点和模型包围盒二次计算真实位置、缩放和经纬高。
   * 这些值暂未进入平台核心字段，所以先作为可序列化元数据保存，保证属性面板和保存恢复不再读到拖拽卡片默认值。
   */
  if (runtimeLngLat) {
    object.metadata = {
      ...object.metadata,
      lngLat: runtimeLngLat,
    }
  }

  if (runtimeOffset) {
    object.metadata = {
      ...object.metadata,
      offset: runtimeOffset,
    }
  }

  if (typeof runtimeSnapshot?.deviceId === 'string') {
    object.metadata = {
      ...object.metadata,
      deviceId: runtimeSnapshot.deviceId,
    }
  }

  /**
   * 旧链路已经创建出真实 THREE.Object3D 时，必须把引擎 uuid 带进平台对象。
   * Runtime 只使用该字段建立 SceneObject.id 到旧 Object3D.uuid 的映射，
   * 不会把真实 THREE.Object3D 暴露给 Store 或页面组件。
   */
  if (typeof runtimeSnapshot?.engineObjectUuid === 'string') {
    object.metadata = {
      ...object.metadata,
      engineObjectUuid: runtimeSnapshot.engineObjectUuid,
    }
  }

  if (typeof runtimeSnapshot?.legacyOnlyUuid === 'string') {
    object.metadata = {
      ...object.metadata,
      legacyOnlyUuid: runtimeSnapshot.legacyOnlyUuid,
    }
  }

  if (typeof runtimeSnapshot?.transparent === 'boolean') {
    object.style = {
      ...object.style,
      transparent: runtimeSnapshot.transparent,
    }
  }

  const asset = mapAsset(objectId, model)
  if (asset) {
    object.asset = asset
  }

  if (model.componentKind === 'billboard') {
    /**
     * 新建看板直接携带结构化默认内容和外观，保存恢复不依赖旧 Sprite.userData.options。
     * 没有显式看板配置时，把图片创建入口的默认图标作为独立图片块写入 Canvas，使标题可排在
     * 图标上方、段落可在图标中部显示；已有配置仍只经过 normalizeBillboardConfig，避免覆盖用户内容。
     */
    object.billboard = model.billboard
      ? normalizeBillboardConfig(model.billboard)
      : createDefaultBillboardConfig(model.imagePath || model.defaultImagePath)
  }

  return object
}

/**
 * 把旧编辑器拖拽资源映射为 GIS SceneObject。
 *
 * 这条路径不再调用旧 renderScene 创建对象：
 * - GIS Runtime 已经接管 Cesium 视口，旧本地三维 sceneApi 没有可用落点；
 * - 统一 Store 需要先拿到 SceneObject，结构面板和 Runtime 再从同一个对象源刷新。
 */
export function mapEditorCreationToGisSceneObject(
  model: EditorSceneObjectModel,
  options: EditorSceneObjectGisMappingOptions = {},
): SceneObject | null {
  if (model.modelType === DRAG_MODEL_ENUM.Widget) return null

  if (model.modelType === DRAG_MODEL_ENUM.Light && !getResolvedGisDropPosition(options)) {
    return null
  }

  const objectId = options.objectId ?? createObjectId()
  const dropPosition = mapStagePointToGisPosition(options)
  const hasResolvedPosition = getResolvedGisDropPosition(options) !== null
  const isGisAssetModel =
    model.modelType === DRAG_MODEL_ENUM.Model || model.modelType === DRAG_MODEL_ENUM.CustomModel
  const primitive =
    model.modelType === DRAG_MODEL_ENUM.Geometry || model.modelType === DRAG_MODEL_ENUM.Pipe
      ? createGisPrimitiveStyle(model)
      : null
  const annotation =
    model.modelType === DRAG_MODEL_ENUM.Annotation || model.modelType === DRAG_MODEL_ENUM.Marking
      ? createGisAnnotationStyle(model)
      : null
  /**
   * 对资源市场 GLB / GLTF，真实地表/模型拾取成功时必须把 `GeoTransform.height` 保持为鼠标命中的
   * 实际高程，不能再叠加历史 20 米视觉偏移，否则属性面板与保存数据不再代表用户放置的位置。
   *
   * 基础几何体的位置是几何中心、标注也需要脱离地表显示，仍沿用各自的必要高度偏移；取点失败的
   * 模型保留旧偏移，避免历史场景默认坐标路径突然产生埋地回归。
   */
  const heightOffset =
    (hasResolvedPosition && isGisAssetModel) ||
    model.modelType === DRAG_MODEL_ENUM.Light ||
    model.modelType === DRAG_MODEL_ENUM.FirstPerson
      ? 0
      : (primitive?.heightOffset ?? (annotation ? 20 : 20))

  const object: SceneObject = {
    id: objectId,
    name: model.name || '未命名对象',
    type: mapObjectType(model.modelType),
    visible: true,
    locked: false,
    /** GIS 对象同样由统一 Store 在落组时生成最终顺序。 */
    order: 0,
    transform: createGisTransform(
      dropPosition,
      heightOffset,
      isGisAssetModel ? createGisModelScale(model) : 1,
    ),
    metadata: {
      editorModelType: model.modelType,
      editorGeometryType: model.type,
      /**
       * GIS 创建同样写入统一 SceneStore，因此复用纯数据快照边界。
       * `runtime-world-position` 表示经纬高来自 Cesium Runtime 的一次真实落点读取；其余值均为显式
       * 回退或历史兼容路径。这里仅处理用户拖入的场景模型元数据，不涉及 Cesium 的影像、地形或瓦片数据。
       */
      editorModelSnapshot: createSerializableEditorModelSnapshot(model),
      dropPoint: options.point,
      gisDropMapping: hasResolvedPosition
        ? 'runtime-world-position'
        : options.useSceneDefaultPositionWhenUnresolved
          ? 'scene-default'
          : 'stage-relative',
    },
  }

  if (model.modelType === DRAG_MODEL_ENUM.FirstPerson) {
    object.firstPerson = {
      enabled: model.firstPerson?.enabled ?? true,
      height: model.firstPerson?.height ?? 1.8,
      eyeHeight: model.firstPerson?.eyeHeight ?? 1.6,
      collisionRadius: model.firstPerson?.collisionRadius ?? 0.3,
      moveSpeed: model.firstPerson?.moveSpeed ?? 3,
      lookSensitivity: model.firstPerson?.lookSensitivity ?? 0.0025,
      fov: model.firstPerson?.fov ?? 75,
      lockPitch: model.firstPerson?.lockPitch ?? true,
      collisionEnabled: model.firstPerson?.collisionEnabled ?? true,
    }
    object.metadata = { ...object.metadata, firstPerson: true, pickable: true }
  }

  if (model.modelType === DRAG_MODEL_ENUM.Light) {
    const kind = model.light?.kind === 'spot' ? 'spot' : 'point'
    if (kind === 'spot' && object.transform.kind === 'geo') {
      object.transform.pitch = -Math.PI / 2
    }
    object.light = {
      kind,
      color: model.light?.color ?? '#fff1d6',
      intensity: model.light?.intensity ?? (kind === 'point' ? 4 : 6),
      range: model.light?.range ?? (kind === 'point' ? 8 : 12),
      shadows: model.light?.shadows ?? false,
      ...(kind === 'spot'
        ? {
            innerConeAngle: model.light?.innerConeAngle ?? Math.PI / 9,
            outerConeAngle: model.light?.outerConeAngle ?? Math.PI / 6,
          }
        : {}),
    }
  }

  if (primitive) {
    object.style = {
      ...object.style,
      gisPrimitive: primitive.style,
    }
  }

  if (annotation) {
    object.style = {
      ...object.style,
      gisAnnotation: annotation,
    }
  }

  const asset = mapAsset(objectId, model)
  if (asset) {
    object.asset = asset
  }

  if (model.componentKind === 'billboard') {
    /**
     * GIS 与本地三维必须写入同一份领域看板配置。Cesium Runtime 以该字段判断是否把图片资产
     * 绘制为富文本 Canvas；无显式配置时同样注入默认图标图片块，保证双 Runtime 的内容顺序一致。
     * 这里在创建边界完成归一化，避免 Runtime 每帧校验配置或维护 GIS 专属的默认值分支。
     */
    object.billboard = model.billboard
      ? normalizeBillboardConfig(model.billboard)
      : createDefaultBillboardConfig(model.imagePath || model.defaultImagePath)
  }

  return object
}
