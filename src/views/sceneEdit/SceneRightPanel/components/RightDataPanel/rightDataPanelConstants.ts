import { TABLE_WIDGET_KEY_NAMES } from '@/packages/components/Widget/shared/tableRuntime'

export type SelectionKind = 'none' | 'object' | 'three-map' | 'marking' | 'widget'

export type BindingOption = {
  /** 固定目标使用协议字段，自定义人工目标允许使用任意非空路径。 */
  targetPath: string
  label: string
  /** 自定义人工行的稳定键；固定目标不设置。 */
  key?: string
  /** 自定义人工行的来源字段；按稳定键读取，避免多个空目标行互相显示。 */
  sourceField?: string
}

/**
 * 右侧数据面板允许用户为对象、打点和 widget 选择不同数据来源。
 * 这里统一抽出请求方式选项，避免组件主体继续堆积静态配置。
 */
export const RIGHT_DATA_PANEL_REQUEST_TYPE_OPTIONS = [
  { label: '静态数据', value: 'static' },
  { label: '动态请求', value: 'ajax' },
  { label: '公共接口', value: 'public' },
  { label: '数据集', value: 'dataset' },
  { label: '扩展数据源', value: 'adapter' },
] as const

/**
 * 普通三维对象支持的基础属性映射。
 */
export const RIGHT_DATA_PANEL_OBJECT_BINDINGS: BindingOption[] = [
  { targetPath: 'visible', label: 'visible' },
  { targetPath: 'position', label: 'position' },
  { targetPath: 'rotation', label: 'rotation' },
  { targetPath: 'scale', label: 'scale' },
]

/**
 * 打点实例支持的实例级属性映射。
 */
export const RIGHT_DATA_PANEL_MARKING_BINDINGS: BindingOption[] = [
  { targetPath: 'position', label: '实例位置' },
  { targetPath: 'rotation', label: '实例旋转' },
  { targetPath: 'scale', label: '实例缩放' },
  { targetPath: 'visible', label: '实例显隐' },
]

/**
 * 单值型 widget 只暴露 value 映射。
 */
export const RIGHT_DATA_PANEL_INPUT_WIDGET_BINDINGS: BindingOption[] = [
  { targetPath: 'value', label: 'value' },
]

/**
 * 列表型 widget 需要同时支持 value 和 options。
 */
export const RIGHT_DATA_PANEL_SELECT_WIDGET_BINDINGS: BindingOption[] = [
  { targetPath: 'value', label: 'value' },
  { targetPath: 'options', label: 'options' },
]

/**
 * 分页器的三个基础数值都会参与业务数据绑定。
 * 单独维护分页器映射集合，避免把 total、pageSize 暴露给文字、输入框等普通单值组件。
 */
export const RIGHT_DATA_PANEL_PAGINATION_WIDGET_BINDINGS: BindingOption[] = [
  { targetPath: 'value', label: 'value' },
  { targetPath: 'total', label: 'total' },
  { targetPath: 'pageSize', label: 'pageSize' },
]

/** 页面框架统一数据入口；内部子节点不创建独立请求或轮询器。 */
export const RIGHT_DATA_PANEL_PAGE_FRAME_BINDINGS: BindingOption[] = [
  { targetPath: 'title.text', label: '主标题' },
  { targetPath: 'title.subtitle', label: '副标题' },
  { targetPath: 'logo.imageUrl', label: 'Logo 图片' },
  { targetPath: 'logo.text', label: 'Logo 文案' },
  { targetPath: 'menuItems', label: '菜单数组' },
  { targetPath: 'weather.temperature', label: '天气温度' },
  { targetPath: 'weather.condition', label: '天气状况' },
  { targetPath: 'weather.icon', label: '天气图标（地址/编码）' },
  { targetPath: 'weather.iconUrl', label: '天气图标地址' },
  { targetPath: 'weather.iconName', label: '天气图标库编码' },
  { targetPath: 'time.date', label: '日期' },
  { targetPath: 'time.time', label: '时间' },
  { targetPath: 'account.name', label: '管理员名称' },
  { targetPath: 'account.avatarUrl', label: '管理员头像' },
  { targetPath: 'account.role', label: '管理员角色' },
]

export const RIGHT_DATA_PANEL_PAGE_FRAME_WIDGET_KEY_NAME = 'VPageMenu'

export const RIGHT_DATA_PANEL_PAGINATION_WIDGET_KEY_NAME = 'VInputsPagination'

/** 测验专属数据目标：将完整题库数组作为一项映射整体传入，保留题目与选项嵌套结构。 */
export const RIGHT_DATA_PANEL_QUIZ_WIDGET_KEY_NAME = 'VQuiz'
export const RIGHT_DATA_PANEL_QUIZ_BINDINGS: BindingOption[] = [
  { targetPath: 'quizId', label: '测验编号' },
  { targetPath: 'title', label: '测验标题' },
  { targetPath: 'total', label: '题目总数' },
  { targetPath: 'questions', label: '完整题库' },
]

/**
 * 这些部件可以消费一组列表项：
 * - VSelect：下拉选择器
 * - VInputsTab：标签选择器
 * - VImageCarousel：图片轮播
 *
 * 其中下拉和标签的 options 行由当前数据字段动态决定；
 * 图片轮播始终按列表型部件暴露 options。
 */
export const RIGHT_DATA_PANEL_OPTION_WIDGET_KEY_NAMES = new Set([
  'VSelect',
  'VInputsTab',
  'VImageCarousel',
])

export const RIGHT_DATA_PANEL_DYNAMIC_OPTION_WIDGET_KEY_NAMES = new Set(['VSelect', 'VInputsTab'])

/**
 * 表格类部件直接消费整张数据表，不需要用户再把某个字段映射到 value。
 */
export const RIGHT_DATA_PANEL_TABLE_WIDGET_KEY_NAMES = new Set<string>(TABLE_WIDGET_KEY_NAMES)

/** 根据表格当前列定义生成可映射目标。目标键必须与运行时最终行字段一致。 */
export const createTableBindingTargets = (
  keyName: string | undefined,
  option: Record<string, unknown> | undefined,
): BindingOption[] => {
  if (!keyName) return []
  if (keyName === 'VTableList')
    return [
      { targetPath: 'name', label: '名称' },
      { targetPath: 'value', label: '数值' },
    ]
  if (keyName === 'VTableScrollBoard') {
    const header = Array.isArray(option?.header) ? option.header : []
    return header.map((item, index) => {
      const targetPath = String(item || `列${index + 1}`)
      return { targetPath, label: targetPath }
    })
  }
  const dataset = option?.dataset as
    | { dimensions?: Array<{ key?: string; title?: string }> }
    | undefined
  return (dataset?.dimensions || [])
    .filter((item) => item?.key)
    .map((item) => ({ targetPath: item.key as string, label: item.title || (item.key as string) }))
}
