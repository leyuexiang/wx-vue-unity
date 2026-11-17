import type {
  EffectSpec,
  CameraPath,
  GeoCameraPathWaypoint,
  SceneDefinition,
  SceneLayer,
  SceneObject,
  SceneSettings,
  SceneStreamingConfig,
  SceneType,
  VegetationGeoPosition,
  VegetationStreamingOptions,
  VegetationSystemDefinition,
} from '../core/types'
import type { RuntimeCapabilities } from './runtimeCapabilities'
import type {
  FrameTarget,
  PickResult,
  PickWorldPoint,
  RuntimeStreamingState,
  RuntimeTerrainHeightSample,
  RuntimeTerrainSamplePosition,
  RuntimeTerrainSamplingCapabilities,
  RuntimeTerrainSamplingOptions,
  RuntimeVegetationPreviewState,
  RuntimeVegetationDiagnostics,
  RuntimeVegetationState,
  SceneCameraState,
  SceneObjectStreamingInteraction,
  ScreenPoint,
} from './runtimeTypes'

/**
 * 交互规则高亮的临时表现参数。
 *
 * 该参数只描述当前运行时的显示效果，绝不写入 SceneStore 或场景保存数据：
 * 规则再次触发、对象删除或 Runtime 销毁时，具体 Runtime 必须自行恢复或释放临时资源。
 * `color` 仅在开启高亮时必填，关闭时允许省略，以便旧配置可单独执行“恢复原样”动作。
 */
export interface ObjectInteractionHighlightOptions {
  enabled: boolean
  color?: string
}

/**
 * 交互规则“移动镜头”的临时运动参数。
 *
 * 两个字段沿用旧动作配置的含义，但只驱动当前 Runtime 的相机和控制器，不写入 SceneStore、
 * 撤销栈或场景保存数据。`transitionTime` 缺失时保持旧执行器的一秒默认过渡；`smoothFactor`
 * 缺失时保持旧执行器的一级平滑。局部三维运行时按对象包围盒补间；GIS 运行时按铯引擎
 * （Cesium）的 `Viewer.flyTo` 实体聚焦接口飞行，平滑值只映射为飞行时长倍率，不能伪造
 * 本地坐标补间。具体 Runtime 不具备对应原生能力时必须返回 false，让调用方完整回退旧端口。
 */
export interface ObjectInteractionMoveCameraOptions {
  transitionTime?: number
  smoothFactor?: number
}

/**
 * 发布运行态对象激活前的异步补全器。
 *
 * 输入只包含本次真正准备创建引擎实例的全局实例编号，输出为补齐资源地址、数据绑定和行为后的
 * 可序列化对象快照。具体运行时只负责在创建引擎对象前调用它，不感知接口、票据或依赖包结构。
 */
export type SceneObjectActivationResolver = (
  objectIds: readonly string[],
) => Promise<readonly SceneObject[]>

/**
 * 正视、侧视、顶视的统一视角标识，不向 Runtime 泄露编辑器枚举。
 *
 * 局部三维按世界轴解释；GIS 按相机当前位置的东、北、天局部坐标系解释：正视为朝北俯视、
 * 侧视为朝东俯视、顶视为垂直向下。两种语义都由各自 Runtime 使用引擎原生相机接口实现。
 */
export type ObjectInteractionViewType = 'front' | 'side' | 'top'

/**
 * 交互规则“切换视角”的临时运动参数。
 *
 * 视角切换只改变当前 Runtime 相机的朝向和位置，不能作为场景持久化相机设置写回。`viewType`
 * 缺失时保持旧动作的正视图默认值；`transitionTime` 缺失时保持旧动作的直接切换默认值。GIS
 * Runtime 使用铯引擎（Cesium）`Camera.flyTo` 或 `Camera.setView` 保持当前位置，仅切换其地理
 * 局部朝向，避免把局部三维的控制器目标或世界坐标写入 GIS 场景。
 */
export interface ObjectInteractionSwitchViewOptions {
  viewType?: ObjectInteractionViewType
  transitionTime?: number
}

/** 运行时回传的三维业务交互；编辑态的模型拾取仍由 selectionChanged 单独处理。 */
export interface SceneObjectInteractionEvent {
  objectId: string
  eventType: 'click' | 'dblclick' | 'mouseenter' | 'mouseleave'
}

/** 相机路径点三维操控器只开放位置移动和姿态旋转两种明确模式。 */
export type CameraPathWaypointGizmoMode = 'translate' | 'rotate'

/**
 * 路径点平移操控器的可拾取手柄。
 *
 * X/Y/Z 对应当地东、北、天单轴移动；XY/YZ/XZ 对应同一当地坐标系中的双轴平移方片。该公共类型只
 * 传递可序列化的编辑意图，不暴露 Cesium 或 Three.js 的实体、图元和数学对象。
 */
export type CameraPathWaypointTranslationHandle = 'x' | 'y' | 'z' | 'xy' | 'yz' | 'xz'

/** 路径点姿态字段与场景旋转环的一一映射，禁止界面层使用含义不明的 X/Y/Z 猜测姿态。 */
export type CameraPathWaypointOrientationAxis = 'heading' | 'pitch' | 'roll'

/**
 * 路径点拖拽的完整临时预览。
 *
 * 移动和旋转共用这一值类型结果，使画布在松开时只提交一次包含位置与姿态的命令；运行时内部的
 * Entity、矩阵和射线不会越过公共接口进入状态仓库。
 */
export interface CameraPathWaypointDragPreview {
  readonly destination: GeoCameraPathWaypoint['destination']
  readonly orientation: GeoCameraPathWaypoint['orientation']
}

/** 植被控制点支持当地东、北、天三根单轴以及水平面移动，满足平地和山区圈选编辑。 */
export type VegetationGeometryPointTranslationHandle = 'x' | 'y' | 'z' | 'xy'

/** 正在绘制的植被几何临时快照；会话编号和点位均只服务编辑态，不进入场景定义。 */
export interface VegetationGeometryEditingSnapshot {
  readonly sessionId: number
  readonly geometryKind: 'polyline' | 'polygon'
  readonly points: readonly VegetationGeoPosition[]
}

/** 植被控制点的拾取结果；缺少 axis 表示只命中立方体本体，需要先选中但不立即自由拖动。 */
export interface VegetationGeometryPointHit {
  readonly sessionId: number
  readonly pointIndex: number
  readonly axis?: VegetationGeometryPointTranslationHandle
}

/** 拖动预览返回经纬度及可选编辑高程；发布时会剥离高程，正式落地仍由高程数据源决定。 */
export interface VegetationGeometryPointDragPreview {
  readonly position: VegetationGeoPosition
}

/**
 * 统一 Runtime 接口。
 *
 * 约束：
 * - Runtime 只负责“渲染与交互能力”，不拥有业务状态真源；
 * - UI 与命令系统不直接依赖具体引擎（Cesium/Three），只依赖此接口；
 * - 业务状态由 SceneStore 拥有，Runtime 只是被动同步表现层状态。
 */
export interface SceneRuntime {
  readonly id: string
  readonly type: SceneType
  readonly capabilities: RuntimeCapabilities

  /**
   * 订阅发布运行态对象真实挂载/释放事件。
   * 事件只描述稳定 instanceId，不暴露引擎对象；编辑态不注册该订阅，因此不会污染 Store。
   */
  subscribeObjectLifecycle?: (
    listener: (event: { type: 'mounted' | 'unmounted'; objectId: string }) => void,
  ) => () => void

  /**
   * 注入发布运行态对象激活补全器。
   * 编辑态不注入该能力；发布态在二维组件显示或三维区块激活时才读取对应实例依赖。
   */
  setObjectActivationResolver?: (resolver: SceneObjectActivationResolver | null) => void

  mount: (container: HTMLElement) => Promise<void>
  dispose: () => void

  /**
   * 暂停或恢复底层引擎的持续渲染。
   *
   * 中国 3D 地图接管期间只停止帧提交并隐藏底层画布，不销毁对象、不改变相机、不写回 Store。
   * 重复传入同一状态必须保持幂等，恢复后最多启动一条新的动画链。
   */
  setRenderingSuspended: (suspended: boolean) => void

  /**
   * 切换运行时编辑能力。
   *
   * 发布预览在加载场景前调用此入口，Runtime 必须关闭并清理所有编辑辅助器（Gizmo）。
   * 该能力是可选的，以兼容尚未接入编辑工具的轻量 Runtime。
   */
  setEditingEnabled?: (enabled: boolean) => void | Promise<void>

  loadScene: (scene: SceneDefinition) => Promise<void>
  /**
   * 只替换引擎表现中的驻留实例集合，不改变完整场景快照或保存数据。
   * 不支持分片表现的旧 Runtime 保持未实现，由调用方继续使用完整场景加载。
   */
  applyLoadedInstanceProjection?: (loadedInstanceIds: ReadonlySet<string>) => Promise<void>
  /**
   * 场景设置增量应用。旧 Runtime 可以暂不实现，桥接层会安全跳过；
   * 已接入的 Runtime 必须避免把单个表单输入退化为完整 loadScene。
   */
  updateSceneSettings?: (settings: SceneSettings) => Promise<void>
  /** GIS 数据图层变更；对象分组仍通过对象增量投影。 */
  updateSceneLayers?: (layers: SceneLayer[]) => Promise<void>
  /**
   * 增量更新场景流式区块索引。
   *
   * 该入口只替换运行时的区块元数据并重新协调相机，不得清空或重建已有引擎对象。
   * 未实现此能力的旧 Runtime 由 RuntimeBridge 回退到完整场景同步。
   */
  updateSceneStreaming?: (streaming: SceneStreamingConfig | undefined) => Promise<void>
  /** 相机路径仅由支持该能力的 Runtime 实现；Three/Memory 保持未支持边界。 */
  updateCameraPaths?: (cameraPaths: CameraPath[]) => Promise<void>
  /**
   * 从当前 GIS 视口的中心可见表面生成安全的相机路径点。
   *
   * 返回值只包含可保存的经纬高，不会向面板暴露 Cesium Viewer、地表实体或深度缓冲对象。未实现的
   * Runtime 或当前画面没有可拾取地表时返回 null，调用方可保留既有相机快照回退逻辑。
   */
  captureCameraPathWaypoint?: () => Promise<GeoCameraPathWaypoint['destination'] | null>
  /**
   * 设置编辑器中的临时路径点选中态。
   *
   * 该状态只驱动 Runtime 辅助图元的高亮，不进入 SceneStore、命令历史或 SceneDefinition，
   * 因此不会被保存、撤销重做或跨场景恢复。传入 null 时清除当前高亮。
   */
  setSelectedCameraPathWaypoint?: (selection: { pathId: string; waypointId: string } | null) => void
  /** 读取或切换当前路径点操控器模式；不支持路径编辑的运行时可保持未实现。 */
  getCameraPathWaypointGizmoMode?: () => CameraPathWaypointGizmoMode
  setCameraPathWaypointGizmoMode?: (mode: CameraPathWaypointGizmoMode) => void
  pickCameraPathWaypoint?: (point: ScreenPoint) => {
    pathId: string
    waypointId: string
    axis?: CameraPathWaypointTranslationHandle
    orientationAxis?: CameraPathWaypointOrientationAxis
  } | null
  beginCameraPathWaypointDrag?: (options: {
    pathId: string
    waypointId: string
    axis?: CameraPathWaypointTranslationHandle
    orientationAxis?: CameraPathWaypointOrientationAxis
    point: ScreenPoint
  }) => Promise<boolean>
  updateCameraPathWaypointDrag?: (point: ScreenPoint) => CameraPathWaypointDragPreview | null
  endCameraPathWaypointDrag?: () => CameraPathWaypointDragPreview | null
  cancelCameraPathWaypointDrag?: () => void
  /**
   * 同步正在绘制的植被区域辅助层。
   *
   * 实现必须增量复用控制点和连线，传入 null 时完整释放临时实体、拾取状态和操纵器会话。
   */
  updateVegetationGeometryEditing?: (
    snapshot: VegetationGeometryEditingSnapshot | null,
  ) => Promise<void>
  setSelectedVegetationGeometryPoint?: (
    selection: {
      sessionId: number
      pointIndex: number
    } | null,
  ) => void
  pickVegetationGeometryPoint?: (point: ScreenPoint) => VegetationGeometryPointHit | null
  beginVegetationGeometryPointDrag?: (
    options: VegetationGeometryPointHit & {
      axis: VegetationGeometryPointTranslationHandle
      point: ScreenPoint
    },
  ) => Promise<boolean>
  updateVegetationGeometryPointDrag?: (
    point: ScreenPoint,
  ) => VegetationGeometryPointDragPreview | null
  endVegetationGeometryPointDrag?: () => VegetationGeometryPointDragPreview | null
  cancelVegetationGeometryPointDrag?: () => void
  playCameraPath?: (pathId: string) => boolean
  stopCameraPath?: () => void
  /** 清空领域缓存并等待引擎对象、图层等异步资源完成释放。 */
  /**
   * 清空领域缓存和引擎资源。
   *
   * 历史流式运行时的释放过程是同步的，而新运行时允许等待异步资源销毁；调用方一律使用
   * `await` 串行化，因此接口同时兼容两种安全实现，避免为了类型迁移引入无意义的微任务。
   */
  clearScene: () => void | Promise<void>

  /** 运行态属性更新只应用到引擎，不能触发用户编辑事件。 */
  upsertObject: (object: SceneObject, options?: { runtimeOnly?: boolean }) => Promise<void>
  /** 删除对象。返回 Promise，确保引擎异步销毁完成后才开始下一项同步。 */
  /**
   * 删除对象。同步运行时可立即完成，异步运行时可返回 Promise；桥接层会逐个等待完成，
   * 防止切场景或删除后同一对象被过期回调重新挂载。
   */
  removeObject: (objectId: string) => void | Promise<void>
  upsertEffect: (effect: EffectSpec) => Promise<void>
  removeEffect: (effectId: string) => void
  /**
   * 立即设置对象显隐。
   * 返回 true 表示当前 Runtime 已实际接管目标；返回 false 时调用方必须保留旧执行器回退。
   */
  setObjectVisible: (objectId: string, visible: boolean) => boolean
  /** 可等待地应用真实引擎显隐；仅实现该能力的运行时可供三维业务动作调用。 */
  setObjectVisibleAsync?: (objectId: string, visible: boolean) => Promise<boolean>
  /** 发布预览中的用户交互通知；没有业务事件能力的运行时保持未实现。 */
  subscribeObjectInteraction?: (
    listener: (event: SceneObjectInteractionEvent) => void,
  ) => () => void
  /**
   * 可恢复的交互规则高亮能力。
   *
   * 并非所有 Runtime 都具备与旧 Three 材质改色等价的实现，因此保留为可选能力；
   * 调用方必须在方法不存在或返回 false 时回退兼容执行器，不能臆造跨引擎表现。
   * 返回 true 表示 Runtime 已接管动作（包括有效的关闭高亮空操作）。
   */
  setObjectInteractionHighlight?: (
    objectId: string,
    options: ObjectInteractionHighlightOptions,
  ) => boolean | Promise<boolean>
  /**
   * 将当前相机临时聚焦到指定对象。
   *
   * 局部三维使用对象包围盒与控制器补间；GIS 使用铯引擎（Cesium）`Viewer.flyTo` 聚焦领域
   * 对象对应的实体。返回 true 表示动作已被接管，false 表示调用方必须完整回退旧执行器，
   * 不能部分执行两套镜头运动。
   */
  moveCameraToObject?: (
    objectId: string,
    options?: ObjectInteractionMoveCameraOptions,
  ) => boolean | Promise<boolean>
  /**
   * 将当前相机切换为正视、侧视或顶视。
   *
   * 局部三维保持旧控制器语义；GIS 使用铯引擎（Cesium）相机在当前位置按东、北、天局部
   * 坐标切换朝向。只有 Runtime 能保证对应引擎的相机和补间语义时才能返回 true；否则必须
   * 完整回退旧执行器。
   */
  switchCameraView?: (options?: ObjectInteractionSwitchViewOptions) => boolean | Promise<boolean>
  setSelectedObject: (objectId: string | null) => void
  /**
   * 接收编辑器发出的对象临时交互意图。
   *
   * 此入口只传递“编辑／拖拽开始或结束”的语义，不能传入区块、缓存、固定保护句柄或引擎对象。
   * 交互状态仅属于 Runtime 内存，不能反向写入 Store 或 SceneDefinition；具体 Runtime 可在后续
   * 将它映射为用户模型区块的 pin 保护。
   */
  setObjectStreamingInteraction: (
    objectId: string,
    interaction: SceneObjectStreamingInteraction,
  ) => void

  pick: (point: ScreenPoint) => Promise<PickResult | null>
  /**
   * 将屏幕坐标解析为可序列化世界坐标。
   *
   * 该接口与 `pick()` 分离：前者允许点击空白地表或模型表面而不要求命中已有领域对象，
   * 后者只负责“命中对象编号”的编辑器选择语义。无稳定坐标时返回 null，调用方自行选择
   * 场景默认坐标等业务回退，Runtime 不会伪造 `0,0,0`。
   */
  pickWorldPosition: (point: ScreenPoint) => Promise<PickWorldPoint | null>
  /** 第一人称脚下的地面落点；忽略模型屋顶等深度表面。 */
  pickGroundPosition?: (point: ScreenPoint) => Promise<PickWorldPoint | null>
  /** 室内灯具只接受真实深度表面，并向相机侧偏移，避免落在墙体或屋顶内部。 */
  pickIndoorLightPosition?: (point: ScreenPoint) => Promise<PickWorldPoint | null>
  /** 视野内的真实阴影预算是否还能容纳一个新灯具。 */
  canPlaceIndoorLight?: (position: readonly [number, number, number]) => boolean

  /** 第一人称行走碰撞查询；返回 false 时预览必须停在当前位置。 */
  canMoveFirstPerson?: (options: {
    position: readonly [number, number, number]
    height: number
    radius: number
    objectId?: string
    movement?: readonly [number, number]
  }) => boolean
  /** 当前 Runtime 是否已具备可用的第一人称碰撞查询。 */
  isFirstPersonCollisionAvailable?: () => boolean
  /** 第一人称接管镜头时关闭普通相机输入，退出后恢复原状态。 */
  setFirstPersonInputEnabled?: (enabled: boolean) => void
  /** 第一人称运行时的高频相机更新；必须只改原生相机，不触发场景流式重算。 */
  setFirstPersonPose?: (options: {
    position: readonly [number, number, number]
    heading: number
    pitch: number
    eyeHeight: number
    fov: number
  }) => void
  /** 第一人称连续漫游时降低临时绘制成本；退出后恢复进入前的渲染质量。 */
  setFirstPersonPerformanceMode?: (enabled: boolean) => void
  /** GIS 运行时直接更新原生 frustum；退出第一人称时由 Runtime 恢复旧视角。 */
  setFirstPersonFov?: (fovDegrees: number) => void

  /**
   * 查询当前真实地形的采样能力。
   *
   * 该快照只描述数字高程模型是否可采样，不把影像、三维瓦片表面或椭球零高程计入可用能力。
   * 查询同步且无副作用，界面可据此决定是否开放海拔分带预览。
   */
  getTerrainSamplingCapabilities: () => RuntimeTerrainSamplingCapabilities

  /**
   * 按输入顺序批量采样当前真实地形。
   *
   * Runtime 负责限量、分批和场景代次校验；此接口服务小范围编辑预览与抽检，不能在浏览器中按
   * 每一株植被调用。正式发布必须由生成端读取同源、同版本的数字高程模型。
   */
  sampleTerrainHeights: (
    positions: readonly RuntimeTerrainSamplePosition[],
    options?: RuntimeTerrainSamplingOptions,
  ) => Promise<RuntimeTerrainHeightSample[]>
  frame: (target?: FrameTarget) => Promise<void>

  setCamera: (camera: SceneCameraState) => Promise<void>
  getCamera: () => SceneCameraState
  /**
   * 订阅底层相机变化。
   *
   * Cesium 相机由用户拖拽、缩放或程序动画驱动时不会产生 SceneStore 事件，属性面板如果只监听
   * Store 就会继续显示旧快照。Runtime 通过该可选订阅把引擎事件转成无引擎细节的通知；返回值
   * 用于面板卸载或宿主切换时解绑，未实现该能力的 Runtime 保持兼容。
   */
  subscribeCameraChanged?: (listener: () => void) => () => void

  /**
   * 查询 Runtime 当前流式状态的只读快照。
   * 查询必须同步、无副作用且不触发引擎遍历；未支持或未接入稳定统计的通道通过辨识字段明确返回。
   */
  getStreamingState: () => RuntimeStreamingState

  /**
   * 查询植被专属运行状态；普通模型区块和通用 GIS 图层不得混入该快照。
   * 不支持植被的运行时返回 unsupported，界面无需读取具体引擎实例判断能力。
   */
  getVegetationState: () => RuntimeVegetationState

  /**
   * 确认当前运行时已挂载目标植被定义中的至少一个正式图层。
   *
   * 该能力比较可序列化图层编号和资产入口，不向页面暴露引擎瓦片集；未实现的运行时由调用方回退
   * 到固定深度加载统计。
   */
  hasLoadedVegetationDefinition?: (vegetation: VegetationSystemDefinition | undefined) => boolean

  /**
   * 增量替换植被运行时配置。
   *
   * RuntimeBridge 只在发布清单、可见性或 Cesium 质量预算发生变化时调用；物种比例、种植规则和
   * 高程生成输入的编辑不会触发已发布瓦片重载。不支持植被的 Runtime 可以省略该接口。
   */
  updateVegetation?: (vegetation: VegetationSystemDefinition | undefined) => Promise<void>

  /**
   * 原位更新正式植被的距离裁剪阈值。
   *
   * 该入口与发布清单替换分离，调整显示距离时不得销毁或重新请求三维瓦片；运行时应立即使用当前
   * 相机位置重新计算图层显隐。不支持原位更新的运行时可省略，桥接层会回退完整植被更新。
   */
  updateVegetationDisplayDistance?: (
    options: Pick<VegetationStreamingOptions, 'maximumDisplayDistanceM' | 'distanceHysteresisM'>,
  ) => Promise<void>

  /**
   * 更新当前活动正式植被的质量档位与缓存预算。
   *
   * 新版运行时可基于当前活动定义原子切换同一发布包内的密度入口；旧发布则只修改公开细节层级和
   * 缓存属性。尤其在“已生成、未发布”的核对阶段，调用方必须保留任务返回的临时正式结果，不能
   * 退回场景中旧的稳定发布版本。
   */
  updateVegetationRenderingOptions?: (
    options: Pick<VegetationStreamingOptions, 'qualityPreset' | 'memoryBudgetMB'>,
  ) => Promise<void>

  /**
   * 增量重建编辑态植被预览。
   *
   * 该入口与正式三维瓦片更新完全分离；实现必须限制临时实例数量，并在规则、场景或 Runtime 生命周期
   * 变化时取消迟到任务、释放模型。未实现编辑预览的 Runtime 可以省略该接口。
   */
  updateVegetationPreview?: (vegetation: VegetationSystemDefinition | undefined) => Promise<void>

  /** 查询编辑态植被预览状态；未实现的 Runtime 可以省略并由界面显示未支持。 */
  getVegetationPreviewState?: () => RuntimeVegetationPreviewState

  /** 查询植被性能诊断；只返回固定深度计数，不触发引擎遍历或写入场景数据。 */
  getVegetationDiagnostics?: () => RuntimeVegetationDiagnostics

  /** 等待当前预览任务结束，仅供界面状态收敛和自动化测试，不参与每帧渲染。 */
  waitForVegetationPreview?: () => Promise<void>

  /**
   * 增量同步一个植被图层的运行时显隐。
   * 调用前必须先更新 SceneStore 中的 VegetationSystemDefinition；该方法只更新表现层，不反写领域状态。
   */
  setVegetationLayerVisible?: (
    layerId: VegetationSystemDefinition['layers'][number]['id'],
    visible: boolean,
  ) => boolean

  /** 查询某个对象是否存在于当前 Runtime 中（用于测试和状态断言）。 */
  hasObject: (objectId: string) => boolean
  /** Runtime 是否已被 dispose。dispose 后不应再执行任何操作。 */
  readonly isDisposed: boolean
}
