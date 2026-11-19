import { DRAG_MODEL_ENUM, MODEL_ENUM } from '@/enums/index'
import { BUILTIN_SCENE_RESOURCE_KEY } from '@/integrations/scene/editorBuiltinResourceRegistry'
import Control from '@/packages/components/Control'
import Chart from '@/packages/components/Chart'
import Decorate from '@/packages/components/Decorate'
import Widget from '@/packages/components/Widget'
import { VVideoInfo } from '@/packages/components/Widget/Video/config'
import { VPageMenuInfo } from '@/packages/components/Widget/VPageMenu/config'
import {
  createFactoryBottomPageFrameOption,
  createShowroomPageFrameOption,
  createTcmPageFrameOption,
} from '@/packages/components/Widget/VPageMenu/pageFrameTypes'
import { VClockInfo } from '@/packages/components/Decorate/Clock/config'
import { VTimeCommonInfo } from '@/packages/components/Decorate/TimeCommon/config'
import type { WidgetModel } from '@/types/threeScene'
import type { EffectDragItem } from '@/types/threeScene'
import type { LightDragItem } from '@/integrations/scene/editorCreationRouter'
import { createUuid } from '@/utils/uuid'

// 资源卡片只需要稳定标识，不应为生成编号加载三维引擎。
const generateUUID = createUuid

/**
 * 当前开放的基础几何体缩略图取自设计稿「模型板块」图标（节点 2192:2685）。
 *
 * 每个缩略图均从对应 Figma 节点直接导出为透明 PNG；静态 `new URL` 会在构建阶段解析，
 * 避免运行时拼接路径或发起网络请求。配置项只引用固定键，因此替换视觉资源不会触及拖拽模型类型、
 * 默认几何参数和创建行为。
 */
const geometryIcons = {
  box: new URL(`../assets/images/geometry/box.png`, import.meta.url).href,
  capsule: new URL(`../assets/images/geometry/capsule.png`, import.meta.url).href,
  cylinder: new URL(`../assets/images/geometry/cylinder.png`, import.meta.url).href,
  plane: new URL(`../assets/images/geometry/plane.png`, import.meta.url).href,
  sphere: new URL(`../assets/images/geometry/sphere.png`, import.meta.url).href,
} as const

/**
 * 组件面板的 Figma 缩略图映射。
 *
 * 资源均由 Figma「组件板块 icon」（节点 2461:2800）的单个节点以 PNG 直接导出，
 * 保留透明通道且不带画布底色。这里覆盖全部 22 个已设计组件，且仅被系统、三维、
 * 自定义和部件面板复用；图表列表继续使用自身的图表缩略图映射，分类边界保持不变。
 */
const figmaComponentPreviewIcons: Record<string, string> = {
  // 三维和自定义组件。
  VBillboard: new URL('../assets/images/figma-components/billboard.png', import.meta.url).href,
  VMarking: new URL('../assets/images/figma-components/marking.png', import.meta.url).href,
  // 文本组件。
  VTextCommon: new URL('../assets/images/figma-components/text-common.png', import.meta.url).href,
  VTextGradient: new URL('../assets/images/figma-components/text-gradient.png', import.meta.url)
    .href,
  VTextBarrage: new URL('../assets/images/figma-components/text-barrage.png', import.meta.url).href,
  // 控件组件。
  VInput: new URL('../assets/images/figma-components/input.png', import.meta.url).href,
  VSelect: new URL('../assets/images/figma-components/select.png', import.meta.url).href,
  VInputsTab: new URL('../assets/images/figma-components/tab.png', import.meta.url).href,
  VInputsPagination: new URL('../assets/images/figma-components/pagination.png', import.meta.url)
    .href,
  VInputsDate: new URL('../assets/images/figma-components/date.png', import.meta.url).href,
  // 答题测验复用组件目录中的独立缩略图，拖拽入口与组件注册保持同一标识。
  VQuiz: new URL('../packages/components/Widget/assets/images/quiz.svg', import.meta.url).href,
  // “更多”分组：媒体和嵌入组件。
  VImage: new URL('../assets/images/figma-components/image.png', import.meta.url).href,
  VImageCarousel: new URL('../assets/images/figma-components/image-carousel.png', import.meta.url)
    .href,
  VIframe: new URL('../assets/images/figma-components/iframe.png', import.meta.url).href,
  VVideo: new URL('../assets/images/figma-components/video.png', import.meta.url).href,
  // “数字”分组：计数、翻牌和倒计时。
  VNumber: new URL('../assets/images/figma-components/number.png', import.meta.url).href,
  VFlipperNumber: new URL('../assets/images/figma-components/flipper-number.png', import.meta.url)
    .href,
  VCountDown: new URL('../assets/images/figma-components/countdown.png', import.meta.url).href,
  // 表格与时间组件。
  VTableList: new URL('../assets/images/figma-components/table-list.png', import.meta.url).href,
  VTableScrollBoard: new URL(
    '../assets/images/figma-components/table-scrollboard.png',
    import.meta.url,
  ).href,
  VTablesBasic: new URL('../assets/images/figma-components/tables-basic.png', import.meta.url).href,
  VTableZebra: new URL('../assets/images/figma-components/tables-basic.png', import.meta.url).href,
  VTableScroll: new URL('../assets/images/figma-components/table-scrollboard.png', import.meta.url)
    .href,
  VTablePagination: new URL('../assets/images/figma-components/tables-basic.png', import.meta.url)
    .href,
  VClock: new URL('../assets/images/figma-components/clock.png', import.meta.url).href,
  VTimeCommon: new URL('../assets/images/figma-components/time-common.png', import.meta.url).href,
}

/**
 * 仅替换缩略图地址，并返回独立配置对象，避免修改组件包导出的共享配置。
 * 组件键未包含在 Figma 设计稿时保留其原缩略图，保证扩展组件可正常显示。
 */
const applyFigmaComponentPreviewIcon = <T extends { keyName: string; icon: string }>(
  component: T,
): T => ({
  ...component,
  icon: figmaComponentPreviewIcons[component.keyName] ?? component.icon,
})

/**
 * 基础几何体的新增拖拽入口。因部分类型无法加载，面板仅开放下列五种。
 * 历史场景由自身保存的几何类型恢复，与这份新增入口清单独立。
 */
export const geometryDataList = [
  {
    id: generateUUID(),
    name: '立方体',
    type: 'BoxGeometry',
    width: 1,
    height: 1,
    depth: 1,
    widthSegments: 1,
    heightSegments: 1,
    depthSegments: 1,
    modelType: DRAG_MODEL_ENUM.Geometry,
    icon: geometryIcons.box,
  },
  {
    id: generateUUID(),
    name: '胶囊',
    type: 'CapsuleGeometry',
    radius: 0.5,
    length: 0.5,
    capSegments: 10,
    radialSegments: 10,
    modelType: DRAG_MODEL_ENUM.Geometry,
    icon: geometryIcons.capsule,
  },
  {
    id: generateUUID(),
    name: '圆柱',
    type: 'CylinderGeometry',
    radiusTop: 4,
    radiusBottom: 4,
    height: 8,
    radialSegments: 8,
    heightSegments: 1,
    openEnded: false,
    thetaStart: 0,
    thetaLength: 6.283185307179586,
    modelType: DRAG_MODEL_ENUM.Geometry,
    icon: geometryIcons.cylinder,
  },
  {
    id: generateUUID(),
    name: '平面',
    type: 'PlaneGeometry',
    width: 1,
    height: 1,
    widthSegments: 1,
    heightSegments: 1,
    modelType: DRAG_MODEL_ENUM.Geometry,
    icon: geometryIcons.plane,
  },
  {
    id: generateUUID(),
    name: '球',
    type: 'SphereGeometry',
    radius: 15,
    widthSegments: 32,
    heightSegments: 16,
    phiStart: 0,
    phiLength: 6.283185307179586,
    thetaStart: 0,
    thetaLength: 3.141592653589793,
    modelType: DRAG_MODEL_ENUM.Geometry,
    icon: geometryIcons.sphere,
  },
]

/**
 * 系统资源面板的内置拖拽项。
 *
 * 管道和标注功能暂不对用户开放，因此不在此列表注册；相关运行时能力和既有场景数据仍保留，
 * 以确保历史场景可以正常加载，而不会在资源面板中产生新的管道或标注对象。
 */
export const systemDataList = [
  {
    name: '室内灯光',
    key: 'indoor-light',
    children: [
      {
        id: 'indoor-point-light',
        name: '点光灯',
        modelType: DRAG_MODEL_ENUM.Light,
        light: { kind: 'point', color: '#fff1d6', intensity: 4, range: 8 },
        icon: new URL('../assets/images/scene-left-navigation/point-light.svg', import.meta.url)
          .href,
      } satisfies LightDragItem,
      {
        id: 'indoor-spot-light',
        name: '聚光灯',
        modelType: DRAG_MODEL_ENUM.Light,
        light: {
          kind: 'spot',
          color: '#fff1d6',
          intensity: 6,
          range: 12,
          innerConeAngle: Math.PI / 9,
          outerConeAngle: Math.PI / 6,
        },
        icon: new URL('../assets/images/scene-left-navigation/spot-light.svg', import.meta.url)
          .href,
      } satisfies LightDragItem,
    ],
  },
  {
    name: '相机',
    key: 'camera',
    children: [
      {
        id: 'first-person-camera',
        name: '第一人称',
        modelType: DRAG_MODEL_ENUM.FirstPerson,
        firstPerson: {
          enabled: true,
          height: 1.8,
          eyeHeight: 1.6,
          collisionRadius: 0.3,
          moveSpeed: 3,
          lookSensitivity: 0.0025,
          fov: 75,
          lockPitch: true,
          collisionEnabled: true,
        },
        icon: geometryIcons.capsule,
      },
    ],
  },
  {
    name: '基础几何体',
    key: 'base',
    children: geometryDataList,
  },
  {
    name: '城市',
    key: 'city',
    children: [
      {
        id: generateUUID(),
        name: '城市',
        modelType: DRAG_MODEL_ENUM.Model,
        /** 内置城市模型没有后端文件编号；保存时仅记录该稳定键，运行时再从注册表取得静态地址。 */
        builtinResourceKey: BUILTIN_SCENE_RESOURCE_KEY.CITY_MODEL,
        icon: new URL(`../assets/images/city.png`, import.meta.url).href,
        filePath: 'model/city.glb',
        fileType: MODEL_ENUM.GLB,
      },
    ],
  },
  {
    name: '3D地图',
    key: 'three-map',
    children: [
      {
        id: generateUUID(),
        name: '中国3D地图',
        modelType: DRAG_MODEL_ENUM.Effect,
        effectType: 'three-map',
        presetId: 'china-province-v1',
        icon: new URL(
          '../scene-platform/effects/threeMap/assets/china-three-map-thumbnail.png',
          import.meta.url,
        ).href,
      } satisfies EffectDragItem,
    ],
  },
]

/**
 * 三维看板属于组件/部件，而非系统内置模型。
 *
 * 首版继续复用 Image 的旧创建入口，`componentKind` 让 Scene Platform 在映射阶段生成独立的
 * BillboardConfig；这样既不破坏历史 Sprite 的加载，也能避免系统资源面板继续暴露“图片”入口。
 */
export const billboardComponentDataList = [
  {
    name: '三维',
    key: 'three-dimensional',
    children: [
      {
        id: generateUUID(),
        name: '三维看板',
        type: 'billboard',
        componentKind: 'billboard' as const,
        modelType: DRAG_MODEL_ENUM.Image,
        /** 默认 Logo 属于前端构建资源，不进入 dependencies.resources 或对象存储接口。 */
        builtinResourceKey: BUILTIN_SCENE_RESOURCE_KEY.BILLBOARD_LOGO,
        // 只更新面板预览为 Figma 透明 PNG，不影响运行时 CanvasTexture 看板绘制。
        icon: figmaComponentPreviewIcons.VBillboard,
        /** 旧 Sprite 创建器的可见兜底图；后续 CanvasTexture 看板绘制完成后由 Runtime 覆盖。 */
        defaultImagePath: new URL(`../assets/images/logo.png`, import.meta.url).href,
      },
      {
        id: generateUUID(),
        name: '三维热力场',
        modelType: DRAG_MODEL_ENUM.Effect,
        effectType: 'volume-heatmap' as const,
        // 复用基础立方体缩略图，表达体积盒载体且避免新增无意义的占位图片资源。
        icon: geometryIcons.box,
      } satisfies EffectDragItem,
    ],
  },
]

export const customDataList = [
  {
    name: '自定义',
    key: 'custom',
    children: [
      {
        id: generateUUID(),
        name: '打点',
        modelType: DRAG_MODEL_ENUM.Marking,
        // 使用 Figma 直接导出的透明 PNG，避免与资源面板卡片背景叠加。
        icon: figmaComponentPreviewIcons.VMarking,
      },
    ],
  },
]

export type WidgetDragItem = WidgetModel & {
  id: string
}

type WidgetPackageGroup = Array<{
  name: string
  key: string
  children: Array<Omit<WidgetModel, 'modelType'>>
}>

const widgetAdapter = (list: WidgetPackageGroup) => {
  return list.map((item) => ({
    ...item,
    // 先应用 Figma 透明 PNG，再补充拖拽实例字段；这样只影响面板预览，不会改动组件运行配置。
    children: item.children.map<WidgetDragItem>((child) => ({
      ...applyFigmaComponentPreviewIcon(child),
      id: generateUUID(),
      modelType: DRAG_MODEL_ENUM.Widget,
    })),
  }))
}

const widgetTextKeyNames = ['VTextCommon', 'VTextGradient', 'VTextBarrage']
/**
 * “控件”分组集中放置输入、选择、翻页、页面切换部件，以及直线进度条这类状态展示控件。
 * 页面菜单与页面分页器只调整资源面板归类，仍沿用各自组件键和 Widget 运行链路，
 * 答题测验也进入此分组；以上归类不改变已有场景持久化数据、页面绑定关系和画布渲染行为。
 */
const widgetControlKeyNames = [
  'VInputsDate',
  'VInputsTab',
  'VInputsPagination',
  'VProgressBar',
  'VPagePagination',
  'VPageMenu',
  'VQuiz',
]
/**
 * “更多”分组只保留这次确认要迁移的媒体/嵌入类部件。
 * 词云已被用户排除，所以这里不能继续收进面板分组，
 * 否则左侧拖拽列表仍会出现一个无法交付的控件入口。
 */
const widgetMoreKeyNames = ['VImage', 'VImageCarousel', 'VIframe', 'VVideo']
const widgetNumberKeyNames = ['VNumber', 'VFlipperNumber', 'VCountDown']
const widgetTableKeyNames = [
  'VTableList',
  'VTableScrollBoard',
  'VTablesBasic',
  'VTableZebra',
  'VTableScroll',
  'VTablePagination',
]

/**
 * “部件”页签按旧项目“信息”分类对齐成：文本 / 控件 / 更多 / 数字 / 表格 / 时间。
 * 其中旧项目的 InputsInput / InputsSelect 继续复用当前仓库已有的 Control 包：
 * - VInput   -> 输入框
 * - VSelect  -> 下拉选择器
 * 页面菜单用于页面切换，和输入、选择、分页同属交互控件，因此收纳在“控件”分组。
 *
 * 按钮也由 Control 包统一注册，使用自己的缩略图并复用已有控件拖拽链路。
 * 这样可以避免为同一类 DOM 控件重复维护两套实现，其余确实缺失的组件再补到 Widget 包里。
 */
const widgetPackages: WidgetPackageGroup = [
  {
    name: '文本',
    key: 'text',
    children: Widget.filter((item) => widgetTextKeyNames.includes(item.keyName)),
  },
  {
    name: '控件',
    key: 'control',
    children: [
      ...Control,
      ...Widget.filter((item) => widgetControlKeyNames.includes(item.keyName)),
      {
        ...VPageMenuInfo,
        name: '页面框架·底部菜单',
        preset: { option: createFactoryBottomPageFrameOption() },
      },
      {
        ...VPageMenuInfo,
        name: '页面框架·中医馆',
        preset: { option: createTcmPageFrameOption() },
      },
      {
        ...VPageMenuInfo,
        name: '页面框架·孪生展厅',
        preset: { option: createShowroomPageFrameOption() },
      },
    ],
  },
  {
    name: '更多',
    key: 'more',
    children: [
      ...Widget.filter((item) => widgetMoreKeyNames.includes(item.keyName)),
      // 复用视频组件及既有预设合并链路，独立入口无需引入新的场景组件类型。
      ...(['rtsp-webrtc', 'rtsp-mse'] as const).map((playbackProtocol) => ({
        ...VVideoInfo,
        name: playbackProtocol === 'rtsp-webrtc' ? 'RTSP-WebRTC' : 'RTSP-MSE',
        preset: { option: { sourceProtocol: 'rtsp', playbackProtocol } },
      })),
    ],
  },
  {
    name: '数字',
    key: 'number',
    children: Widget.filter((item) => widgetNumberKeyNames.includes(item.keyName)),
  },
  {
    name: '表格',
    key: 'table',
    children: Widget.filter((item) => widgetTableKeyNames.includes(item.keyName)),
  },
  {
    name: '时间',
    key: 'time',
    children: [
      applyFigmaComponentPreviewIcon(VClockInfo),
      applyFigmaComponentPreviewIcon(VTimeCommonInfo),
    ],
  },
]

const isAreaChart = (keyName: string) => keyName.toLowerCase().includes('area')
const isSankeyChart = (keyName: string) => keyName.toLowerCase().includes('sankey')

const chartCategoryMap = [
  {
    name: '柱状图',
    key: 'bar',
    match: (keyName: string) => {
      const normalized = keyName.toLowerCase()
      return normalized.includes('bar') && !normalized.includes('horizontal')
    },
  },
  {
    name: '条形图',
    key: 'horizontal-bar',
    match: (keyName: string) => keyName.toLowerCase().includes('horizontal'),
  },
  {
    name: '仪表盘',
    key: 'gauge',
    match: (keyName: string) => keyName.toLowerCase().includes('gauge'),
  },
  {
    name: '面积图',
    key: 'area',
    match: (keyName: string) => isAreaChart(keyName),
  },
  {
    name: '桑基图',
    key: 'sankey',
    match: (keyName: string) => isSankeyChart(keyName),
  },
  {
    name: '矩形树图',
    key: 'treemap',
    // 矩形树图使用独立分类，避免按名称兜底到折线图并在资源面板中静默错位。
    match: (keyName: string) => keyName.toLowerCase().includes('treemap'),
  },
  {
    name: '折线图',
    key: 'line',
    match: (keyName: string) => {
      const normalized = keyName.toLowerCase()
      return normalized.includes('line') && !isAreaChart(keyName) && !isSankeyChart(keyName)
    },
  },
  {
    name: '饼环图',
    key: 'pie',
    match: (keyName: string) => {
      const normalized = keyName.toLowerCase()
      return normalized.includes('pie') || normalized.includes('donut')
    },
  },
  {
    name: '雷达图',
    key: 'radar',
    match: (keyName: string) => keyName.toLowerCase().includes('radar'),
  },
]

export const WidgetDataList = widgetAdapter(widgetPackages)

export const ChartDataList = chartCategoryMap
  .map((category) => {
    const children = Chart.filter((item) => category.match(item.keyName)).map<WidgetDragItem>(
      (child) => ({
        ...child,
        id: generateUUID(),
        modelType: DRAG_MODEL_ENUM.Widget,
      }),
    )

    return {
      name: category.name,
      key: category.key,
      children,
    }
  })
  .filter((item) => item.children.length > 0)

// 装饰组件分类
const decorateCategoryMap = [
  { name: '边框', key: 'border', match: (k: string) => k.startsWith('VBorder') },
  { name: '装饰', key: 'decorate', match: (k: string) => k.startsWith('VDecorate') },
  {
    name: '更多',
    key: 'more',
    match: (k: string) =>
      !k.startsWith('VBorder') &&
      !k.startsWith('VDecorate') &&
      k !== 'VClock' &&
      k !== 'VTimeCommon',
  },
]

export const DecorateDataList = decorateCategoryMap
  .map((category) => {
    const children = Decorate.filter((item) => category.match(item.keyName)).map<WidgetDragItem>(
      (child) => ({
        ...child,
        id: generateUUID(),
        modelType: DRAG_MODEL_ENUM.Widget,
      }),
    )
    return { name: category.name, key: category.key, children }
  })
  .filter((item) => item.children.length > 0)
