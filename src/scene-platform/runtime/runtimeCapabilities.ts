import type { SceneType } from '../core/types'

/**
 * RuntimeCapabilities 用于描述当前 Runtime “具备哪些能力”。
 *
 * UI 和工具栏应该依赖能力显隐，而不是依赖 SceneType 写死两套界面。
 */
export interface RuntimeCapabilities {
  transform: {
    geo: boolean
    local: boolean
    terrainClamp: boolean
  }
  rendering: {
    imagery: boolean
    terrain: boolean
    tileset: boolean
    realtimeShadow: boolean
    /** 室内模型的局部灯光编辑能力。系统资源面板仅在显式启用时显示灯光卡片。 */
    indoorLocalLights?: boolean
    /**
     * 是否具备通用场景后处理管线。
     * 天气适配器内部的后处理阶段不计入此能力；通用后处理任务完成前，
     * 默认 Runtime 必须保持关闭，避免界面开放尚未接通的配置。
     */
    postProcess: boolean
  }
  editing: {
    objectPick: boolean
    areaPick: boolean
    gizmo: boolean
    snapping: boolean
    /** 是否显示标注创建入口；真实创建仍由具体 Runtime 或兼容适配层承载。 */
    annotation: boolean
    /** 是否显示测量工具入口；测距、测角等细分能力由工具实现继续判断。 */
    measure: boolean
  }
  assets: {
    glb: boolean
    tiles3d: boolean
    particles: boolean
  }
  /**
   * 资源流式加载能力。
   *
   * 这里区分平台管理的 SceneChunk 与引擎原生瓦片：
   * - 平台托管区块用于普通 SceneObject 的加载、卸载与缓存；
   * - 原生瓦片用于 Cesium 影像、地形和 3D Tiles 等已由引擎维护的调度链路；
   * 两者不能互相推导，避免 UI 因原生瓦片能力而错误开放通用 chunk 配置。
   */
  streaming: {
    /** 是否已实际调度 SceneDefinition.streaming 中的平台自定义区块。 */
    chunkScheduling: boolean
    /** 是否委托具体引擎调度影像、地形、3D Tiles 等原生瓦片资源。 */
    nativeTileStreaming: boolean
  }
  /**
   * 可见性剔除能力。
   *
   * 字段只描述 Runtime 已接入的实际行为，不把 Three / Cesium 引擎内部的默认实现
   * 误报成平台自定义 chunk 的剔除能力；后续调度器和诊断层据此决定是否开放配置与统计。
   */
  culling: {
    /** 是否对平台自定义区块执行视锥剔除。 */
    chunkFrustum: boolean
    /** 是否由引擎对原生瓦片执行视锥裁剪。 */
    nativeTileFrustum: boolean
    /** 是否已实现平台定义的保守遮挡剔除规则。 */
    conservativeOcclusion: boolean
  }
  /**
   * 场景特效能力。
   *
   * 该组字段只描述 Runtime 已接入的天气渲染链路；它与流式 / 剔除能力独立，
   * 防止 UI 因某个引擎的原生调度存在而误判天气、云层或阴影是否可用。
   */
  effects: {
    weather: boolean
    weatherRuntime: boolean
    atmosphere: boolean
    fog: boolean
    clouds: boolean
    cloudShadow: boolean
    lightShafts: boolean
    rain: boolean
    snow: boolean
    /** Cesium-only rain impact and wet-surface capabilities. Undefined means unsupported/unknown. */
    rainRipples?: boolean
    wetSurface?: boolean
    puddleReflection?: boolean
    screenSpaceDepth?: boolean
    /** 是否支持本地或 GIS 的三维体积热力场渲染；具体子能力由 Runtime 自身继续裁剪。 */
    volumeHeatmap: boolean
    /** 是否支持中国 3D 地图独立呈现器接管整个视口。 */
    threeMapTakeover: boolean
  }
}

/**
 * 创建默认的流式能力声明。
 *
 * 默认全部关闭，确保 BaseSceneRuntime 与 MemoryRuntime 不会仅因场景类型而虚报
 * 已具备真实加载、卸载或缓存能力；具体引擎 Runtime 只能在对应实现已落地时显式开启。
 */
function createDefaultStreamingCapabilities(): RuntimeCapabilities['streaming'] {
  return {
    chunkScheduling: false,
    nativeTileStreaming: false,
  }
}

/**
 * 创建默认的剔除能力声明。
 *
 * 每次调用返回独立对象，避免某个 Runtime 修改嵌套字段后污染其他 Runtime 实例的能力快照。
 */
function createDefaultCullingCapabilities(): RuntimeCapabilities['culling'] {
  return {
    chunkFrustum: false,
    nativeTileFrustum: false,
    conservativeOcclusion: false,
  }
}

/**
 * 生成一份“最小能力”声明。
 *
 * 第一阶段目的是把架构边界跑通，所以能力声明也先只保 MVP。
 * 流式与剔除默认均为 false；真实 Runtime 必须在实际接入对应链路后显式开启，
 * 不能把“已有索引工具”或“场景类型匹配”误认为“已经支持调度”。
 */
export function createDefaultRuntimeCapabilities(type: SceneType): RuntimeCapabilities {
  if (type === 'gis') {
    return {
      transform: { geo: true, local: false, terrainClamp: true },
      rendering: {
        imagery: true,
        terrain: true,
        tileset: true,
        realtimeShadow: true,
        // Cesium Runtime enables this only after it detects the pinned engine patch and depth picking.
        indoorLocalLights: false,
        // 通用后处理任务尚未落地；天气专用阶段不计入此能力。
        postProcess: false,
      },
      editing: {
        objectPick: true,
        areaPick: false,
        gizmo: false,
        snapping: false,
        /**
         * GIS Runtime 已用 Cesium Entity 承载基础标注。
         * 这里放开入口，资源面板可复用同一套标注拖拽，不再回落到旧 Three 场景。
         */
        annotation: true,
        measure: false,
      },
      assets: { glb: true, tiles3d: true, particles: false },
      streaming: createDefaultStreamingCapabilities(),
      culling: createDefaultCullingCapabilities(),
      effects: {
        weather: true,
        weatherRuntime: true,
        atmosphere: true,
        fog: true,
        clouds: true,
        cloudShadow: true,
        lightShafts: true,
        rain: false,
        snow: false,
        rainRipples: false,
        wetSurface: false,
        puddleReflection: false,
        screenSpaceDepth: false,
        volumeHeatmap: false,
        threeMapTakeover: true,
      },
    }
  }

  return {
    transform: { geo: false, local: true, terrainClamp: false },
    rendering: {
      imagery: false,
      terrain: false,
      tileset: false,
      realtimeShadow: true,
      indoorLocalLights: true,
      // 通用后处理任务尚未落地；天气专用阶段不计入此能力。
      postProcess: false,
    },
    editing: {
      objectPick: true,
      areaPick: true,
      gizmo: true,
      snapping: true,
      annotation: false,
      measure: false,
    },
    assets: { glb: true, tiles3d: false, particles: true },
    streaming: createDefaultStreamingCapabilities(),
    culling: createDefaultCullingCapabilities(),
    effects: {
      weather: true,
      weatherRuntime: false,
      atmosphere: false,
      fog: false,
      clouds: false,
      cloudShadow: false,
      lightShafts: false,
      rain: false,
      snow: false,
      rainRipples: false,
      wetSurface: false,
      puddleReflection: false,
      screenSpaceDepth: false,
      volumeHeatmap: true,
      threeMapTakeover: true,
    },
  }
}
