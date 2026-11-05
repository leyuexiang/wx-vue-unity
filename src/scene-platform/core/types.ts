/**
 * 场景类型。
 * - gis: 地理坐标体系，由 Unity GIS 场景渲染与拾取
 * - local3d: 局部坐标体系，由 Unity 普通三维场景渲染与拾取
 */
export type SceneType = 'gis' | 'local3d'

/**
 * 坐标系统定义。
 * - wgs84: 地理坐标（经纬度 + 高程）
 * - local: 局部坐标（米制/厘米制等）
 */
export type SceneCoordinateSystem =
  | {
      kind: 'wgs84'
      terrainEnabled: boolean
      defaultLongitude: number
      defaultLatitude: number
      defaultHeight: number
    }
  | {
      kind: 'local'
      unit: 'meter' | 'centimeter' | 'millimeter'
      upAxis: 'Y' | 'Z'
      gridEnabled: boolean
    }

export interface SceneViewportGridSettings {
  enabled?: boolean
  size?: number
  divisions?: number
  color?: string
  centerLineColor?: string
  opacity?: number
  fade?: boolean
}

/**
 * 第一版资产类型集合。
 * 这些值只描述源资产形态，不描述 Cesium/Three 的加载产物；
 * 后续新增视频、音频或 GIS 数据源时，需要同步扩展校验、加载器和任务文档。
 */
export type AssetKind =
  | 'glb'
  | 'gltf'
  /** Unity托管模型由稳定资源编号定位，运行时负责鉴权读取当前修订。 */
  | 'unity-model'
  | 'image'
  | 'texture'
  | 'material'
  | 'effect'
  | 'hdr'
  | 'json'
  /** 体积场逻辑资产；实际 raw-grid 或 GIS 体素瓦片由运行时清单选择。 */
  | 'volume-field'
  | '3d-tiles'

/**
 * 可参与模型多细节层次（LOD）切换的资源类型。
 *
 * 资源市场用户模型当前只支持 GLB / GLTF 两种可独立加载的模型文件；图片、材质以及 Cesium
 * 原生三维瓦片不能复用这套实例级 LOD 语义，避免场景流式调度意外干预 GIS 数据图层。
 */
export type ModelAssetKind = Extract<AssetKind, 'glb' | 'gltf'>

/**
 * 资源市场为同一个用户模型提供的一个低细节资产变体。
 *
 * 根 AssetRef 自身始终是细节层级 0；数组中的每项只描述在更远距离时可替换加载的另一个纯数据
 * 资产，不保存 Three Object3D、Cesium Entity、加载进度或缓存句柄。`minimumDistance` 的单位固定为
 * 米：本地场景使用局部米制坐标，GIS 场景使用场景原点 ENU（东、北、天）局部米制坐标，保证两个
 * Runtime 可以按同一阈值解释保存数据。
 */
export interface ModelLodVariant {
  /** 变体资产的稳定资源市场编号；不得与根资产或同组其他变体重复。 */
  id: string
  /** 变体仅允许 GLB / GLTF 用户模型，不能填入影像、地形或原生三维瓦片。 */
  kind: ModelAssetKind
  /** 变体文件的可解析地址；与根资产一样仅保存定位信息。 */
  url: string
  /** 可选资产版本，用于资源缓存失效和发布包比对。 */
  version?: string
  /** 可选内容摘要，用于完整性校验和增量发布。 */
  hash?: string
  /**
   * 相机到对象包围体的距离达到该值（含）时，变体才具备被选择资格，单位为米。
   * 变体数组必须按该值严格递增，Runtime 可以从后向前常数次早停，避免每帧排序。
   */
  minimumDistance: number
  /**
   * 可选屏幕空间半径上限，取投影包围球直径占视口短边的比例，范围为 (0, 1]。
   * 只有 Runtime 已获得可信包围体与视口数据时才会采用它；缺失或计算异常时退回距离阈值，
   * 不能因估算失败错误降低模型细节。
   */
  maximumScreenSpaceRatio?: number
}

/**
 * 引擎中立的模型透明模式。
 *
 * `mask`（裁切透明）适用于树叶、栅栏等二值透明面片；`blend`（混合透明）保留玻璃、水面等连续透明
 * 的创作语义。该类型只描述资产意图，不能直接等同于任一引擎的材质实例。
 */
export type ModelMaterialAlphaMode = 'opaque' | 'mask' | 'blend'

/** 材质规则来源，供资源管理页诊断、人工覆盖和派生资产追溯使用。 */
export type ModelMaterialRuleSource = 'declared' | 'detected' | 'manual'

/**
 * 模型内材质的稳定选择器。
 *
 * GLTF 材质索引是导出文件内的精确定位，名称供人工识别和 Three 运行时兼容匹配。至少有一项时才允许
 * 写入规则，避免把叶片规则误应用到树干、建筑或玻璃等整个模型。
 */
export interface ModelMaterialSelector {
  materialIndex?: number
  materialName?: string
}

/** 单个模型材质的可序列化渲染意图。 */
export interface ModelMaterialRule {
  selector: ModelMaterialSelector
  alphaMode: ModelMaterialAlphaMode
  /** 仅 `mask` 使用；缺失时由运行时使用统一默认阈值。 */
  alphaCutoff?: number
  /** 单张叶片面片通常需要双面渲染，普通实体材质保持原文件默认值。 */
  doubleSided?: boolean
  source: ModelMaterialRuleSource
}

/** 上传预检和资源管理页对材质档案的当前结论。 */
export type ModelMaterialProfileState = 'ready' | 'needs-confirmation' | 'unavailable'

/**
 * 上传后处理生成的规范模型变体。
 *
 * 它是发布清单中的纯地址信息，运行时可优先加载；临时 Blob 地址、纹理、加载器和引擎材质绝不写入此处。
 */
export interface ModelMaterialDerivedAsset {
  url: string
  version?: string
  hash?: string
}

/**
 * GLB / GLTF 资产的统一材质档案。
 *
 * 一份档案可描述同一模型中的树干、叶片、玻璃等多个材质规则。原始文件声明优先，自动检测仅补齐缺失
 * 声明；状态为 `needs-confirmation` 或 `unavailable` 时仍保留原始资产地址，不能阻断场景打开。
 */
export interface ModelMaterialProfile {
  version: 1
  state: ModelMaterialProfileState
  rules: ModelMaterialRule[]
  derivedAsset?: ModelMaterialDerivedAsset
}

/**
 * 资产引用：用于统一表示 GLB、GLTF、图片、贴图等资源。
 *
 * 约束：
 * - 这里只保存可序列化的资产定位信息；
 * - 不保存 Three.Texture、Three.Material、Cesium.Entity、Cesium.Model 等运行时对象；
 * - Runtime Adapter 根据 kind 和 url 自行解释成对应引擎资源。
 */
export interface AssetRef {
  /** 资产唯一标识，用于 Store、保存数据和 Runtime 资源缓存建立稳定映射 */
  id: string
  /** 资产类型，保持引擎中立，GLB/GLTF 和图片都使用同一字段表达 */
  kind: AssetKind
  /** 资产定位地址，只保存 URL 或宿主项目可解析的路径，不保存已加载资源实例 */
  url: string
  /** 可选资产版本，用于后续缓存失效和发布包比对 */
  version?: string
  /** 可选内容摘要，用于后续完整性校验和增量发布 */
  hash?: string
  /**
   * 模型材质的可序列化档案，仅 GLB / GLTF 可使用。
   *
   * 统一规则由 Three / Cesium Runtime 分别映射，不能放入 metadata 逃避校验，也不保存运行时材质、纹理
   * 或对象 URL。资源管理页可据此展示自动检测、人工覆盖和需确认状态。
   */
  materialProfile?: ModelMaterialProfile
  /** 可序列化资产元数据，例如图片尺寸、模型轴向提示或来源系统标识 */
  metadata?: Record<string, unknown>
  /**
   * 可选的远距离低细节模型变体，根资产默认作为细节层级 0。
   * 该字段仅适用于资源市场 GLB / GLTF 用户模型，并按 `minimumDistance` 严格升序保存；
   * 不存运行时选中层级，场景恢复后由当前相机重新计算，避免把瞬时状态写入 MySQL 快照。
   */
  modelLodVariants?: ModelLodVariant[]
}

export interface GeoTransform {
  kind: 'geo'
  longitude: number
  latitude: number
  height: number
  /** 地理北向为基准的航向角，单位为弧度；Cesium Runtime 会转换为位置相关的实体朝向。 */
  heading: number
  /** 以局部东、北、天坐标为基准的俯仰角，单位为弧度。 */
  pitch: number
  /** 以局部东、北、天坐标为基准的横滚角，单位为弧度。 */
  roll: number
  /**
   * 可选的局部姿态四元数快照，顺序固定为 `[x, y, z, w]`。
   *
   * Gizmo 的局部旋转以该快照作为连续计算基准，避免在接近俯仰奇异位时反复将欧拉角
   * （heading / pitch / roll）转换回来而产生轴向跳变。航向、俯仰、横滚字段仍会同步保存，
   * 用于兼容既有场景数据、属性面板和 Cesium 的标准接口；缺失本字段时 Runtime 自动由它们还原姿态。
   */
  orientationQuaternion?: [number, number, number, number]
  scale: number | [number, number, number]
  altitudeMode: 'absolute' | 'relativeToGround' | 'clampToGround'
}

export interface LocalTransform {
  kind: 'local'
  position: [number, number, number]
  rotation: [number, number, number]
  scale: number | [number, number, number]
}

export type SceneTransform = GeoTransform | LocalTransform

/**
 * 包围体定义。
 *
 * 约束：
 * - 这里只保存可序列化的几何近似数据，用于 Runtime 做区块调度、视锥剔除和诊断；
 * - GIS 场景优先使用 `region` 表达经纬度范围；
 * - 本地三维场景优先使用 `sphere` 或 `aabb`；
 * - 不保存 Three.Box3、Cesium.BoundingSphere 等引擎对象实例。
 */
export type BoundingVolume =
  | { type: 'sphere'; center: [number, number, number]; radius: number }
  | { type: 'aabb'; min: [number, number, number]; max: [number, number, number] }
  | {
      type: 'region'
      west: number
      south: number
      east: number
      north: number
      minHeight?: number
      maxHeight?: number
    }

/**
 * 场景区块元数据。
 *
 * 约束：
 * - 这里只保存区块与对象/资产的可序列化映射，不保存已加载实例；
 * - chunk 只是 Runtime 流式调度的空间分组，不改变 SceneObject 的领域身份；
 * - `objectIds` / `assetIds` 只建立“属于哪个区块”的索引关系，真实资源生命周期仍由 Runtime 管理；
 * - 同一个 SceneObject 在同一时刻最多只属于一个 chunk；未归属对象默认按“非流式对象”处理，
 *   后续可由 Runtime 构建临时 chunk index 或保持常驻；
 * - 对象与 streaming group 的关系通过 chunk 的 `streamingGroupId` 间接建立，不在 SceneObject 基础字段中重复存储。
 */
export interface SceneChunk {
  id: string
  sceneId: string
  bounds: BoundingVolume
  objectIds: string[]
  assetIds: string[]
  streamingGroupId?: string
  lodLevel?: number
  priority?: number
  tags?: string[]
}

/**
 * 流式分组定义。
 *
 * 约束：
 * - 用于给一组区块声明统一的加载/显隐策略；
 * - `near-camera` 必须同时提供 preload / visible / unload 三个半径，避免不同 Runtime 猜测默认阈值；
 * - 其余模式不参与相机距离调度，因此可以省略半径字段；
 * - `engine-native` 保留给 Cesium 原生 3D Tiles、影像和地形这类已有调度能力的资源；
 * - `always-loaded` 适合当前编辑对象、关键参考对象或必须常驻的基础资源。
 */
export interface StreamingGroup {
  id: string
  mode: 'near-camera' | 'always-loaded' | 'manual' | 'engine-native'
  preloadRadius?: number
  visibleRadius?: number
  unloadRadius?: number
  maxLoadedChunks?: number
  memoryBudgetMB?: number
  priority?: number
}

/**
 * Runtime 流式加载基础选项。
 *
 * 约束：
 * - 这里只表达策略目标，不直接暴露引擎内部缓存对象；
 * - 具体调度状态、加载队列和缓存统计属于 Runtime 内部状态；
 * - 编辑器和保存恢复只读写这些可序列化选项。
 */
export interface RuntimeStreamingOptions {
  enabled: boolean
  targetFps?: number
  maxLoadingJobs?: number
  maxLoadedChunks?: number
  memoryBudgetMB?: number
  unloadDelayMs?: number
  hysteresis?: number
}

/**
 * 场景运行上下文。
 *
 * 编辑器与发布预览都使用同一份 SceneDefinition；此字段仅用于选择同一场景内声明的策略覆盖，
 * 不携带 Runtime、缓存、Cesium Viewer 或 Three.js 对象，因此可以安全随 JSON 保存与恢复。
 */
export type SceneStreamingRuntimeContext = 'editor' | 'preview'

/**
 * 运行上下文的可选策略覆盖。
 *
 * 覆盖只允许修改场景级调度目标。区块、分组、对象归属和资源地址必须始终复用基础配置，避免编辑器
 * 与预览页出现“同一模型属于不同区块”的不可解释状态。
 */
export type SceneStreamingRuntimeOverrides = Partial<
  Record<SceneStreamingRuntimeContext, Partial<RuntimeStreamingOptions>>
>

/**
 * 场景流式元数据。
 *
 * 约束：
 * - `chunks` / `groups` / `options` 都属于场景定义的一部分，可随保存恢复一起持久化；
 * - 旧场景可以缺失该字段，解析时按“未启用流式加载”处理；
 * - 不在这里保存已加载区块、当前可见区块或缓存命中等运行时状态。
 */
export interface SceneStreamingConfig {
  chunks: SceneChunk[]
  groups: StreamingGroup[]
  options?: RuntimeStreamingOptions
  /** 编辑器或发布预览需要不同预算时使用的可序列化覆盖；未配置时两端完全复用 options。 */
  runtimeOverrides?: SceneStreamingRuntimeOverrides
}

export type SceneObjectType =
  | 'model'
  | 'image'
  | 'primitive'
  | 'tileset'
  | 'light'
  | 'camera'
  | 'annotation'
  | 'effect'
  | 'group'

/**
 * 第一人称相机起点的可持久化配置。
 *
 * position/朝向仍由 SceneObject.transform 表达；这里仅保存角色控制器和镜头参数，
 * 不保存相机实例、输入监听或运行时移动位置。
 */
export interface FirstPersonConfig {
  enabled: boolean
  height: number
  eyeHeight: number
  collisionRadius: number
  moveSpeed: number
  lookSensitivity: number
  fov: number
  lockPitch: boolean
  collisionEnabled: boolean
}

/** 双运行时室内灯具的可保存配置；位置和朝向由 SceneObject.transform 表达。 */
export interface SceneLightConfig {
  kind: 'point' | 'spot'
  /** 六位十六进制 RGB。 */
  color: string
  /** 线性强度倍率，0 表示关闭。 */
  intensity: number
  /** 有效照射距离，单位米。 */
  range: number
  /** 是否投射实时阴影；旧场景未设置时只提供补光。 */
  shadows?: boolean
  /** 聚光灯的内外半锥角，单位弧度。 */
  innerConeAngle?: number
  outerConeAngle?: number
}

/** 看板文本块的对齐方式；只支持画布可稳定表达的三种水平对齐。 */
export type BillboardTextAlign = 'left' | 'center' | 'right'

/**
 * 看板内容块的纵向对齐方式。
 *
 * auto 保留旧场景的顺序流式排版；top/center/bottom 分别把当前内容块放到看板内容区的
 * 顶部、垂直居中和底部。paragraph 块紧随可见 image 块且使用 center 时，会以该图片中心为
 * 锚点，便于把段落叠加在图标中部；其他情况仍以看板内容区为参照。该字段与 position 的 Y
 * 偏移叠加，使快捷对齐后仍可精细调整。
 */
export type BillboardVerticalAlign = 'auto' | 'top' | 'center' | 'bottom'

/** 图片块的缩放模式：cover 裁切填充 / contain 等比留白 / stretch 拉伸铺满。 */
export type BillboardImageFit = 'cover' | 'contain' | 'stretch'

/** 文本字形样式；只保留 Canvas 2D 可稳定保存和复现的常规与斜体两种语义。 */
export type BillboardFontStyle = 'normal' | 'italic'

/** 文本装饰；首版只支持无装饰和下划线，避免引入浏览器富文本样式协议。 */
export type BillboardTextDecoration = 'none' | 'underline'

/** 看板文本片段的纯数据样式，不保存 Font、Canvas 或 DOM 实例。 */
export interface BillboardTextRun {
  text: string
  color: string
  fontSize: number
  fontWeight: 'normal' | 'bold'
  /** 可选字段保证旧场景无需迁移；归一化后始终为 normal 或 italic。 */
  fontStyle?: BillboardFontStyle
  /** 可选字段保证旧场景无需迁移；归一化后始终为 none 或 underline。 */
  textDecoration?: BillboardTextDecoration
  /** 字符间距像素，允许轻微负值以满足紧凑标题排版。 */
  letterSpacing?: number
}

/**
 * 看板内容块；支持 5 种类型：
 * - title：标题（大字号，居中，粗体默认）
 * - paragraph：段落（正常字号，左对齐）
 * - label：标签（单行、带背景色药丸样式，类似 Cesium LabelGraphics 视觉效果）
 * - image：图片块（嵌入图片，支持颜色、尺寸、透明度、圆角和 cover/contain/stretch 缩放）
 * - divider：分割线（纯视觉分隔，无内容）
 *
 * 新增字段全部 optional，旧数据（只有 title/paragraph）零成本兼容。
 */
export interface BillboardContentBlock {
  type: 'title' | 'paragraph' | 'label' | 'image' | 'divider'
  /** 内容块是否参与绘制；缺失时按 true 兼容历史看板，默认段落可显式设为 false。 */
  visible?: boolean
  align: BillboardTextAlign
  /** 缺失时按 auto 兼容旧数据；显式值由六按钮对齐控件写入。 */
  verticalAlign?: BillboardVerticalAlign
  /** 内容块相对自动排版位置的画布像素偏移，顺序为 [X, Y]；缺失时按 [0, 0] 兼容旧数据。 */
  position?: [number, number]
  /** title/paragraph 使用：文本区域宽度（画布像素）；0 或缺失表示沿用内容区自动宽度。 */
  textWidth?: number
  /** title/paragraph/label 使用：文本片段列表。image/divider 不使用。 */
  runs?: BillboardTextRun[]
  /** label 专用：标签背景色（默认 #333333） */
  labelBackground?: string
  /** label 专用：标签圆角半径（默认 4） */
  labelRadius?: number
  /** image 专用：图片 URL 或 data URL */
  imageSrc?: string
  /**
   * image 专用：图片资源的稳定编号。
   *
   * 该编号是四包保存时唯一持久化的资源身份；imageSrc 只允许作为运行时解析后的地址存在，
   * 不应把临时授权地址、对象存储地址或本地构建地址写入场景包。
   */
  imageResourceKey?: string
  /** image 专用：图片着色值，默认白色表示保留原图颜色。 */
  imageColor?: string
  /** image 专用：图片自发光强度，0 表示关闭；范围由领域归一化限制为 0～1。 */
  imageEmissive?: number
  /** image 专用：自发光颜色，默认白色表示沿用原图亮度进行增亮。 */
  imageEmissiveColor?: string
  /** image 专用：图片缩放模式（默认 contain） */
  imageFit?: BillboardImageFit
  /** image 专用：图片目标宽度像素（0 表示填满内容宽度） */
  imageWidth?: number
  /** image 专用：图片块高度像素（0 表示按宽度等比缩放） */
  imageHeight?: number
  /** image 专用：图片透明度（默认 1） */
  imageOpacity?: number
  /** image 专用：图片圆角半径像素（默认 0） */
  imageRadius?: number
  /** divider 专用：分割线颜色（默认 #cccccc） */
  dividerColor?: string
  /** divider 专用：分割线粗细（默认 1） */
  dividerWidth?: number
}

/** 看板可保存的结构化富文本内容。 */
export interface BillboardContent {
  blocks: BillboardContentBlock[]
}

/** 看板外观配置；所有尺寸均为画布逻辑像素，不能写入运行时纹理或图片元素。 */
export interface BillboardAppearance {
  width: number
  height: number
  /** 近距离阈值，单位为场景米；看板在该距离使用 nearScale。 */
  nearDistance: number
  /** 远距离缩放阈值，单位为场景米；看板在该距离使用 farScale。 */
  farDistance: number
  /** 近距离缩放系数；1 表示保持面板基础尺寸。 */
  nearScale: number
  /** 远距离缩放系数；配合透视规则进一步降低远景占用。 */
  farScale: number
  /** 超过此距离后停止提交看板绘制，单位为场景米。 */
  maximumDisplayDistance: number
  padding: [number, number, number, number]
  backgroundColor: string | 'transparent'
  backgroundImage: string | null
  /**
   * 背景图片资源的稳定编号。backgroundImage 只用于运行时显示，保存时由该编号恢复地址。
   */
  backgroundImageResourceKey?: string
  /** 背景图片着色值，默认白色表示保留原图颜色；缺失时由归一化逻辑回退为白色。 */
  backgroundImageColor?: string
  /** 背景图片自发光强度，0 表示关闭；由 Canvas 屏幕混合模拟，不改变透明区域。 */
  backgroundImageEmissive?: number
  /** 背景图片自发光颜色，默认白色；由 Canvas 屏幕混合叠加到原图透明区域内。 */
  backgroundImageEmissiveColor?: string
  borderColor: string
  borderWidth: number
  opacity: number
}

/** 三维看板的第一版纯 JSON 协议，由 Three Runtime 绘制为 CanvasTexture 后挂载到 Sprite。 */
export interface BillboardConfig {
  schemaVersion: 1
  content: BillboardContent
  appearance: BillboardAppearance
}

/**
 * 场景领域对象。
 *
 * 约束：
 * - 这里只记录可持久化、可撤销重做的业务快照；
 * - 不允许保存 Three.Mesh、Cesium.Entity、DOM、函数等运行时对象；
 * - 对象在运行时内的引擎实例映射由 Runtime Adapter 自行维护。
 */
export interface SceneObject {
  /** 领域对象唯一标识，后续用于 Store、命令、Runtime 映射和保存恢复 */
  id: string
  /** 展示名称，用于对象树、属性面板和调试日志 */
  name: string
  /** 对象类型，只表达业务类别，不绑定具体渲染引擎实现 */
  type: SceneObjectType
  /** 业务父实例编号；缺失表示根节点，独立于图层及空间区块。 */
  parentInstanceId?: string
  /** 仅 light 对象使用；不包含 Cesium/Three 实例。 */
  light?: SceneLightConfig
  /** 仅 camera 对象使用；第一人称相机以该配置区分旧相机对象。 */
  firstPerson?: FirstPersonConfig
  /** 是否可见，由 Runtime Adapter 映射为具体引擎对象的显示状态 */
  visible: boolean
  /** 是否锁定编辑，第一版仅表达领域状态，不在核心层处理 UI 行为 */
  locked: boolean
  /** 所属图层标识；缺失表示暂不归入具体图层 */
  layerId?: string
  /**
   * 对象在所属结构分组内的稳定顺序，从 0 开始连续编号。
   *
   * 该字段是保存接口恢复结构面板与渲染顺序的正式协议，不能只依赖 objects 数组位置；
   * 未归组对象以缺失 layerId 作为同一根级分组，同样独立编号。
   */
  order: number
  /** 对象变换；GIS 场景使用地理变换，本地三维场景使用局部变换 */
  transform: SceneTransform
  /** 可选资产引用，只保存资产定位信息，不保存已加载资源实例 */
  asset?: AssetRef
  /** 功能性三维组件的统一配置；热力场以对象身份参与结构树、基础面板和选择链路。 */
  effect?: EffectSpec
  /**
   * 三维看板的结构化内容与外观。
   *
   * 本地 Three 与地理 Cesium 图片对象都会消费该字段；这里始终保持引擎中立的纯 JSON，不能保存
   * Canvas、CanvasTexture、SpriteMaterial、Sprite 或 Entity 等运行时资源。
   */
  billboard?: BillboardConfig
  /** 可序列化样式扩展，供材质、颜色、透明度等后续能力使用 */
  style?: Record<string, unknown>
  /**
   * 可序列化业务元数据，供旧编辑器映射和业务扩展使用。
   *
   * 建议约定：
   * - `metadata.instance` 可存放实例级业务数据，例如实例编号、标签、状态和参数；
   * - `metadata.instance.hardware` 可存放设备映射信息，例如 `deviceId`、设备类型和通道标识；
   * - 对象若参与流式加载，空间归属由 `SceneDefinition.streaming.chunks[].objectIds` 维护，
   *   不建议在 metadata 中再复制 chunk / group 关系，避免双写不一致；
   * - 若涉及凭证、口令或 Token，应只保存稳定设备标识，不把敏感信息写入场景文件。
   */
  metadata?: Record<string, unknown>
}

/**
 * GIS 图层数据源提供者类型。
 *
 * 约束：
 * - 这里只描述数据来源，不绑定 Cesium/Three 具体实现；
 * - 供应商差异（坐标系偏移、Token、代理）由 Runtime Adapter 内部解释，不写入核心领域逻辑；
 * - 新增供应商时需同步扩展校验集合和 Runtime Adapter。
 */
export type GisLayerProvider =
  | 'local'
  | 'tianditu'
  | 'amap'
  | 'google'
  | 'xyz'
  | 'wmts'
  | 'wms'
  | 'natural-earth'
  | 'arcgis'
  | 'geojson'
  | 'kml'
  | 'czml'
  | '3d-tiles'

/**
 * 场景图层。
 *
 * 约束：
 * - 只保存可序列化的图层配置，不保存 Cesium ImageryLayer、DataSource、Tileset 等引擎对象；
 * - GIS 数据源字段（provider/url/asset/options）只在 type 为 imagery/terrain/tileset/vector 时有意义，
 *   由 Runtime Adapter 自行解释为对应 Cesium Provider 或 DataSource；
 * - 旧数据可能缺少 GIS 数据源字段，解析时保留 undefined，不做猜测填充。
 */
export interface SceneLayer {
  id: string
  name: string
  /**
   * 图层类别。
   * - object: 对象分组图层（仅影响对象树分组，不绑定 GIS 数据源）
   * - imagery: 影像底图图层
   * - terrain: 地形图层
   * - tileset: 3D Tiles 图层
   * - vector: 矢量数据图层（GeoJSON/KML/CZML 等）
   * - effect: 特效图层
   * - annotation: 标注图层
   */
  type: 'object' | 'imagery' | 'terrain' | 'tileset' | 'vector' | 'effect' | 'annotation'
  visible: boolean
  locked: boolean
  opacity?: number
  order: number
  /** GIS 图层数据源提供者；仅当 type 为 imagery/terrain/tileset/vector 时有效 */
  provider?: GisLayerProvider
  /** 数据源定位地址；只保存 URL 或项目可解析路径，不保存已加载引擎对象 */
  url?: string
  /** 可选资产引用，用于本地 GeoJSON/KML/3D Tiles 等文件型数据源 */
  asset?: AssetRef
  /** 可序列化数据源配置，例如 Token、子域、图层名、坐标偏移等供应商参数 */
  options?: Record<string, unknown>
  /** 可序列化图层元数据，供业务扩展使用 */
  metadata?: Record<string, unknown>
}

/** 植被图层的业务分类；分类只用于规则、显隐和预算分组，不映射到具体渲染类。 */
export type VegetationLayerKind = 'forest' | 'grass' | 'rocks' | 'crops' | 'custom'

/**
 * 植被质量档位。
 *
 * 场景只保存稳定的业务档位，Cesium 的屏幕空间误差和缓存字节数等引擎参数由运行时按压测结果映射，
 * 避免存档与某个 Cesium 版本或设备能力绑定。
 */
export type VegetationQualityPreset = 'high' | 'balanced' | 'performance'

/**
 * 单发布包内的密度层级元数据。
 *
 * 生成器使用同一随机种子把低密度层构造成高清层的稳定子集；运行时只切换三维瓦片层级，
 * 不在浏览器内逐株删除实例。`densityRatio` 是目标比例，实际数量仍会受边界、坡度和最小株距影响。
 */
export interface VegetationPublicationDensityProfile {
  densityRatio: number
  selection: 'stable-subset'
  /** 生成器按档位聚合的目标瓦片边长，单位为米；历史发布缺失时表示尚未冻结该参数。 */
  tileSizeM?: number
}

/**
 * 单个图层在同一发布包内的三档三维瓦片入口。
 *
 * 三个入口分别只引用对应密度的数据：高清为全部实例，均衡和性能为高清实例的固定子集。运行时切换
 * 档位时必须整体替换入口，不能只调大屏幕空间误差后继续让 Cesium 自动细化到高清叶子瓦片。
 * 字段保持可选，用于兼容尚未重新发布的历史植被场景。
 */
export type VegetationLayerDensityTilesetAssets = Partial<Record<VegetationQualityPreset, AssetRef>>

/**
 * 单个植被图层的可持久化定义。
 *
 * 图层只引用发布清单与物种编号，不保存已加载瓦片、实例矩阵或引擎对象；同一图层内的物种编号必须
 * 唯一，运行时可据此直接建立物种索引，无需在加载阶段重复去重。
 *
 * 规则编制早于首份三维瓦片发布，因此 `manifestAsset` 允许在草稿阶段缺失。缺失时图层仍可保存物种
 * 和规则，但 Cesium 运行时必须忽略它且不能发起网络请求；生成器发布成功后再原子写入清单引用。
 */
export interface VegetationLayerDefinition {
  id: string
  name: string
  visible: boolean
  locked: boolean
  kind: VegetationLayerKind
  manifestAsset?: AssetRef
  /** Cesium直接加载的tileset.json；旧场景缺失时运行时兼容读取3d-tiles类型的manifestAsset。 */
  tilesetAsset?: AssetRef
  /**
   * 单发布包的三档独立入口。新发布必须同时写入 high、balanced、performance 三项；运行时优先按
   * 当前质量档位读取该映射，`tilesetAsset` 仅作为旧发布和不支持多档入口时的兼容回退。
   */
  densityTilesetAssets?: VegetationLayerDensityTilesetAssets
  deltaAsset?: AssetRef
  speciesIds: string[]
  priority: number
}

/** 植被生成使用的高程基准；未知基准只允许无高程或停用规则，不能参与海拔带发布。 */
export type VegetationVerticalDatum = 'ellipsoid' | 'orthometric' | 'unknown'

/**
 * 植被生成的高程来源。
 *
 * `scene-terrain` 复用场景当前地形服务，`external-dem` 由后端通过稳定数据源编号解析数字高程模型，
 * `constant` 只用于无地形的平面技术验证。这里不保存访问令牌、Cesium TerrainProvider 或栅格对象。
 */
export type VegetationElevationSourceDefinition =
  | {
      kind: 'none'
      verticalDatum: 'unknown'
      heightOffsetM: number
    }
  | {
      kind: 'scene-terrain'
      /** 场景存在多个地形配置时指定图层；缺失表示使用当前激活的场景地形。 */
      layerId?: string
      /**
       * 公共在线地形经常不声明垂直基准，因此编辑预览允许保留 unknown；发布校验会继续要求显式确认，
       * 防止同一海拔带在椭球高和正常高之间产生系统偏移。
       */
      verticalDatum: VegetationVerticalDatum
      heightOffsetM: number
    }
  | {
      kind: 'external-dem'
      /** 后端可解析的数据源编号，避免把带鉴权参数的高程地址写入场景。 */
      sourceId: string
      verticalDatum: Exclude<VegetationVerticalDatum, 'unknown'>
      heightOffsetM: number
    }
  | {
      kind: 'constant'
      heightM: number
      verticalDatum: VegetationVerticalDatum
      heightOffsetM: number
    }

/**
 * 资源市场中的一个植被物种档案。
 *
 * `modelAsset` 的根资源与 `modelLodVariants` 只表达按观察距离切换的渲染细节层级；物种适用海拔必须
 * 由种植规则表达，禁止用模型细节层级代替生态植被带。模型实例和已加载材质不进入该结构。
 */
export interface VegetationSpeciesDefinition {
  id: string
  name: string
  enabled: boolean
  modelAsset: AssetRef
  /**
   * 物种实例的统一最小缩放比例，当前产品范围为 1～30；圈选、行道树和海拔带都读取同一配置。
   * 缩放属于物种档案而不是种植规则，避免同一物种因规则类型不同出现不一致的树体大小。
   */
  minimumScale: number
  /** 物种实例的统一最大缩放比例，必须不小于 minimumScale，且与最小比例共同限制在 1～30。 */
  maximumScale: number
  /** 冠幅用于生成阶段计算最小安全株距；缺失时由具体种植规则显式给出株距。 */
  canopyRadiusM?: number
  /** 仅保存授权、来源和业务标签等纯数据，不保存资源市场组件或运行时对象。 */
  metadata?: Record<string, unknown>
}

/** 规则内的物种权重；同一规则中物种编号唯一，权重由生成器归一化后选择。 */
export interface VegetationSpeciesMixEntry {
  speciesId: string
  weight: number
}

/**
 * 世界大地坐标系植被编辑点。
 *
 * 前两项经纬度决定正式生成的平面范围；第三项是可选的编辑控制点椭球高程，用于山区绘制时恢复
 * 立方体、连线和天向操纵轴。发布适配器会明确剥离第三项，正式植被高程仍统一由
 * VegetationElevationSourceDefinition 和数字高程模型解析，避免人工控制点高程污染实例落地结果。
 */
export type VegetationGeoPosition = [longitude: number, latitude: number, authoringHeightM?: number]

/**
 * 植被地理多边形。
 *
 * 第一条环为外环，后续环为孔洞；每条环必须闭合。坐标沿用地理数据交换常用的经度、纬度顺序，
 * 面积、缓冲和采样由生成器投影到当地米制坐标后计算，禁止直接拿经纬度差值当米使用。
 */
export interface VegetationGeoPolygon {
  rings: VegetationGeoPosition[][]
}

/** 三类首期种植规则共享的稳定字段；物种混合只属于具体生成规则。 */
export interface VegetationPlantingRuleBase {
  id: string
  name: string
  enabled: boolean
  layerId: string
  priority: number
  /** 与系统全局种子共同派生规则随机序列，不保存运行时随机数生成器状态。 */
  seedOffset: number
}

/** 行道树、圈选规则以及旧版海拔规则的物种混合字段。 */
export interface VegetationSpeciesPlantingRuleBase extends VegetationPlantingRuleBase {
  speciesMix: VegetationSpeciesMixEntry[]
}

/**
 * 第二版单海拔带规则的迁移输入。
 *
 * 该类型仅用于读取旧场景并迁移到 `VegetationAltitudeZonationRule`，不属于当前规则联合，
 * 避免新代码继续创建会重复保存几何的旧结构。
 */
/** @deprecated 请使用 VegetationAltitudeZonationRule。 */
export interface VegetationAltitudeBandRule extends VegetationSpeciesPlantingRuleBase {
  kind: 'altitude-band'
  polygon: VegetationGeoPolygon
  minimumAltitudeM: number
  maximumAltitudeM: number
  minimumSlopeDegrees: number
  maximumSlopeDegrees: number
  densityPerHectare: number
  minimumSpacingM: number
}

/** 一个海拔分带的完整生成参数；区间按左闭右开解释，最后一带包含最高端点。 */
export interface VegetationAltitudeZoneDefinition {
  id: string
  name: string
  enabled: boolean
  minimumAltitudeM: number
  maximumAltitudeM: number
  minimumSlopeDegrees: number
  maximumSlopeDegrees: number
  densityPerHectare: number
  minimumSpacingM: number
  /** 与下一分带共同边界两侧的混合总宽度；最后一带必须为 0。 */
  upperTransitionWidthM: number
  /** 同一分带内物种编号唯一，权重必须为正数。 */
  speciesMix: VegetationSpeciesMixEntry[]
}

/** 相邻海拔分带存在空隙时的处理策略。 */
export type VegetationAltitudeGapPolicy = 'reject' | 'leave-empty'

/**
 * 多海拔分带父规则。
 *
 * `camera-view` 表示规则全局有效，运行时只把镜头可见地表当作流式加载窗口，不把临时镜头边界写入
 * 场景；`polygon` 保留给历史存档和需要明确业务边界的人工规划。旧版规则可能暂时缺少 scope，读取时
 * 由是否存在 polygon 归一化，不要求用户重新绘制。
 */
export interface VegetationAltitudeZonationRule extends VegetationPlantingRuleBase {
  kind: 'altitude-zonation'
  scope?: 'camera-view' | 'polygon'
  polygon?: VegetationGeoPolygon
  gapPolicy: VegetationAltitudeGapPolicy
  zones: VegetationAltitudeZoneDefinition[]
}

/** 行道树路径两侧的生成规则；路径由用户绘制或从道路中心线导入。 */
export interface VegetationCorridorRule extends VegetationSpeciesPlantingRuleBase {
  kind: 'corridor'
  path: VegetationGeoPosition[]
  side: 'left' | 'right' | 'both'
  offsetM: number
  spacingM: number
  startOffsetM: number
  endOffsetM: number
  alignToPath: boolean
}

/** 圈选种树规则；密度决定目标数量，最小株距用于限制局部拥挤。 */
export interface VegetationPolygonRule extends VegetationSpeciesPlantingRuleBase {
  kind: 'polygon'
  polygon: VegetationGeoPolygon
  distribution: 'poisson' | 'grid' | 'random'
  densityPerHectare: number
  minimumSpacingM: number
}

/** 可持久化种植规则联合；生成器按 kind 分派，避免用可选字段拼接不完整规则。 */
export type VegetationPlantingRule =
  | VegetationAltitudeZonationRule
  | VegetationCorridorRule
  | VegetationPolygonRule

/**
 * Three.js 后续兼容阶段使用的植被流式参数。
 *
 * 这些参数只控制 Three.js 植被区块与批次，不得映射到 Cesium 原生三维瓦片缓存，也不得覆盖普通
 * 场景模型的 `SceneDefinition.streaming` 配置。
 */
export interface VegetationThreeStreamingOptions {
  preloadRadius: number
  visibleRadius: number
  unloadRadius: number
  unloadDelayMs: number
  maxLoadingJobs: number
  lodHysteresis: number
  densityScale: number
}

/** 跨运行时共享的植被质量与资源预算，仅保存可复现的业务配置。 */
export interface VegetationStreamingOptions {
  enabled: boolean
  qualityPreset: VegetationQualityPreset
  memoryBudgetMB: number
  targetFps: number
  /** 正式植被瓦片集包围球表面到相机的最大可见距离，超过该距离后整层隐藏。 */
  maximumDisplayDistanceM: number
  /** 从隐藏状态恢复显示时向内收缩的距离，避免相机在边界附近移动造成频繁闪烁。 */
  distanceHysteresisM: number
  /** Three.js 专属参数缺失时，不影响 Cesium 首期加载、版本切换和发布。 */
  three?: VegetationThreeStreamingOptions
}

/** 植被画笔和增量预览的持久化边界，不包含临时图元、事件监听器或任务句柄。 */
export interface VegetationEditingOptions {
  enabled: boolean
  previewEnabled: boolean
  maxDeltaAreaM2: number
  snapToTerrain: boolean
}

/** 已发布植被清单的稳定引用；加载进度、当前瓦片和失败状态属于运行时临时数据。 */
export interface VegetationPublicationRef {
  version: string
  /** 生成任务冻结的规则版本；旧存档可缺失，新发布必须写入以识别规则变更后的过期结果。 */
  ruleVersion?: string
  /** 业务生成清单，用于审计规则、地块和实例统计，不直接交给Cesium加载。 */
  manifestAsset: AssetRef
  /** 整场景三维瓦片入口；图层运行时优先使用各图层自己的tilesetAsset。 */
  tilesetAsset?: AssetRef
  generatedAt: string
  sourceHash: string
  /**
   * 单个发布包包含的三档密度说明。旧发布没有该字段时仍可加载，但不能宣称已具备密度切换能力。
   */
  densityProfiles?: Partial<Record<VegetationQualityPreset, VegetationPublicationDensityProfile>>
}

/**
 * 植被系统的场景级定义。
 *
 * 这里只保存确定性生成所需的规则、版本、图层和发布引用。单株植被不创建 `SceneObject`，Three.js
 * 实例化网格、Cesium 三维瓦片集以及两套运行时缓存均不得写入该结构。
 */
export interface VegetationSystemDefinition {
  schemaVersion: number
  enabled: boolean
  seed: number
  ruleSetId: string
  ruleSetVersion: string
  layers: VegetationLayerDefinition[]
  /** 资源市场植被模型的场景级稳定目录；图层和规则只保存物种编号。 */
  speciesCatalog: VegetationSpeciesDefinition[]
  /** 海拔带、行道树和圈选种树规则；单株结果由发布生成器按区块派生。 */
  rules: VegetationPlantingRule[]
  /** 生成高程来源与垂直基准；影像底图不能替代该数据。 */
  elevationSource: VegetationElevationSourceDefinition
  streaming: VegetationStreamingOptions
  editing: VegetationEditingOptions
  publication?: VegetationPublicationRef
}

/** 一个植被区块的轻量索引记录；实例矩阵保存在 dataUrl 指向的外部二进制资源中。 */
export interface VegetationChunkRecord {
  id: string
  layerId: string
  bounds: BoundingVolume
  dataUrl: string
  dataHash: string
  byteSize: number
  instanceCount: number
  speciesIds: string[]
  lodLevels: number[]
  sourceVersion: string
  tags?: string[]
}

/** 运行时只读批次键；相同键的实例可共享几何体与材质。 */
export interface VegetationBatchKey {
  chunkId: string
  speciesId: string
  lodLevel: number
  materialVariant: string
}

/**
 * 植被编辑的可撤销增量操作。
 *
 * 增量只描述受影响区域与规则，不直接改写基础植被二进制；提交发布后由服务端重建受影响瓦片。
 */
export interface VegetationDeltaOperation {
  id: string
  layerId: string
  chunkIds: string[]
  operation: 'paint' | 'erase' | 'replace'
  polygon: number[][]
  speciesIds?: string[]
  densityScale?: number
  seed: number
  createdAt: string
}

export interface EffectSpec {
  id: string
  type: 'particle' | 'trail' | 'weather' | 'postprocess' | 'volume-heatmap' | 'three-map'
  /** 独立效果协议的版本；旧效果可继续缺失。 */
  schemaVersion?: number
  /** 内置效果预设的稳定编号；禁止使用显示名称作为运行时分支条件。 */
  presetId?: string
  anchor?: Record<string, unknown>
  params: Record<string, unknown>
  assetRefs?: AssetRef[]
}

export type SceneSettings = Record<string, unknown>
export type SceneMetadata = Record<string, unknown>

/** Cesium 地理相机路径点。角度统一使用弧度，位置使用 WGS84 经度、纬度和米制高程。 */
export interface GeoCameraPathWaypoint {
  kind: 'geo'
  id: string
  timeMs: number
  destination: [number, number, number]
  orientation: {
    heading: number
    pitch: number
    roll: number
  }
  interpolation: 'linear' | 'ease-in-out'
}

/**
 * 相机路径播放时的姿态来源。
 *
 * `keyframes` 表示继续插值路径点内保存的航向、俯仰和横滚；`follow-path` 表示运行时根据路径
 * 位置的行进方向计算航向和俯仰，而横滚仍沿用关键帧。该字段保留为可选，以兼容历史路径，缺失时
 * 在场景解析边界归一化为 `keyframes`。
 */
export type CameraPathOrientationMode = 'keyframes' | 'follow-path'

/** 可持久化的相机路径定义；播放进度和选中点属于 Runtime 临时状态，不写入此结构。 */
export interface CameraPath {
  id: string
  name: string
  enabled: boolean
  loop: boolean
  autoPlay: boolean
  /** 路径级姿态来源；缺失时按兼容规则使用路径点内保存的手工姿态。 */
  orientationMode?: CameraPathOrientationMode
  /**
   * 两种姿态模式都使用的转向窗口，单位为毫秒；缺失时在解析边界补默认值。
   * 总时长必须至少覆盖末个路径点时间与这段转向尾时长。
   */
  turnDurationMs?: number
  /** 完整播放总时长，包含路径点到达时间和最后姿态转向的尾段。 */
  durationMs: number
  waypoints: GeoCameraPathWaypoint[]
}

export interface SceneDefinition {
  id: string
  name: string
  type: SceneType
  coordinateSystem: SceneCoordinateSystem
  /** 对象数组按“图层 order + 对象 order”缓存排列；持久化顺序以两级 order 字段为准。 */
  objects: SceneObject[]
  /** 可选流式加载元数据；缺失表示当前场景未启用区块化流式调度。 */
  streaming?: SceneStreamingConfig
  layers: SceneLayer[]
  effects: EffectSpec[]
  settings: SceneSettings
  metadata: SceneMetadata
  /** 相机路径领域数据；旧场景缺失时按空数组兼容。 */
  cameraPaths?: CameraPath[]
  /** 可选植被领域数据；旧场景缺失时保持 undefined，表示未启用植被系统。 */
  vegetation?: VegetationSystemDefinition
  /**
   * 场景数据 schema 版本号。
   * - 用于持久化时的版本迁移；
   * - 新建场景默认为 1，老数据反序列化时若缺失则视为 1。
   */
  schemaVersion: number
}
