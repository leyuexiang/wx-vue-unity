import {
  FIXED_VALUE_TYPE_ENUM,
  INTERACTIVE_EVENT_ENUM,
  OBJECT_TYPE_ENUM,
  VIEW_TYPE_ENUM,
  JUDGMENT_TYPE_ENUM,
  MODEL_VALUE_TYPE_ENUM,
  DOM_SELECTOR_TYPE_ENUM,
} from '@/enums/scenePanelEnum'
import { ACTION_TYPE_ENUM } from '@/enums/scenePanelEnum'
import type { FixedValueLocation } from './type'

/** 状态与事件共用二维已有的四种触发语义，Unity 预览运行时也回传同一枚举值。 */
export const eventTypeOptions = [
  {
    label: '单击左键时',
    value: INTERACTIVE_EVENT_ENUM.Click,
  },
  {
    label: '双击左键时',
    value: INTERACTIVE_EVENT_ENUM.DoubleClick,
  },
  {
    label: '鼠标移入时',
    value: INTERACTIVE_EVENT_ENUM.MouseEnter,
  },
  {
    label: '鼠标移出时',
    value: INTERACTIVE_EVENT_ENUM.MouseLeave,
  },
]

export const rules = {
  eventName: [{ required: true, message: '请输入事件名称', trigger: 'blur' }],
  eventType: [{ required: true, message: '请选择事件类型', trigger: 'blur' }],
}

export const actionFieldRules = {
  actionType: [{ required: true, message: '请选择动作类型', trigger: 'change' }],
  actionTargetUuid: [{ required: true, message: '请选择动作目标', trigger: 'change' }],
  actionTargetWidgetIds: [{ required: true, message: '请选择部件', trigger: 'change' }],
  // 传参目标必须明确到某个动态请求的已配置参数。
  widgetTargetProperty: [{ required: true, message: '请选择目标请求参数', trigger: 'change' }],
  // 自定义赋值必须选取目标组件当前存在的数据映射字段。
  widgetMappedProperty: [{ required: true, message: '请选择组件映射字段', trigger: 'change' }],
  widgetValueSourceField: [{ required: true, message: '请输入来源字段', trigger: 'blur' }],
  observationTargetUuid: [{ required: true, message: '请选择观察目标', trigger: 'change' }],
  jumpLink: [{ required: true, message: '请输入跳转链接', trigger: 'blur' }],
  sceneUrl: [{ required: true, message: '请输入场景链接', trigger: 'blur' }],
}

/** 三维状态和事件沿用二维的动作表单与动作类型，由各自 Runtime 按能力执行。 */
export const actionTypeOptions = [
  {
    label: '高亮模型',
    value: ACTION_TYPE_ENUM.HighlightModel,
  },
  {
    label: '跳转链接',
    value: ACTION_TYPE_ENUM.JumpLink,
  },
  {
    label: '移动相机',
    value: ACTION_TYPE_ENUM.MoveCamera,
  },
  {
    label: '切换模型可见性',
    value: ACTION_TYPE_ENUM.ModelVisibility,
  },
  {
    // 名称明确表达覆盖目标请求参数并重新获取数据；目标类别在动作表单内选择。
    label: '传参并刷新数据',
    value: ACTION_TYPE_ENUM.PassParameters,
  },
  {
    // 自定义赋值只更新目标组件属性，不触发目标组件的数据请求。
    label: '设置组件映射字段',
    value: ACTION_TYPE_ENUM.SetWidgetProperty,
  },
  {
    label: '切换部件可见性',
    value: ACTION_TYPE_ENUM.WidgetVisibility,
  },
  {
    label: '切换视图',
    value: ACTION_TYPE_ENUM.SwitchView,
  },
  {
    label: '切换第一人称',
    value: ACTION_TYPE_ENUM.ToggleFirstPerson,
  },
  {
    label: '切换场景',
    value: ACTION_TYPE_ENUM.SwitchScene,
  },
]

export const transitionTimeMarks = {
  0: '0s',
  1: '1s',
  2: '2s',
  5: '5s',
}

export const smoothFactorMarks = {
  0: '直接',
  1: '平滑',
  2: '缓慢',
}

export const viewTypeOptions = [
  {
    label: '前视图',
    value: VIEW_TYPE_ENUM.Front,
  },
  {
    label: '侧视图',
    value: VIEW_TYPE_ENUM.Side,
  },
  {
    label: '顶视图',
    value: VIEW_TYPE_ENUM.Top,
  },
]

/**
 * 条件源类型列表。
 * 新增“当前组件数据”后，状态与交互规则就可以直接消费数据面板里
 * 动态请求、公共接口请求在提取路径和过滤器处理后的返回字段。
 */
export const objectTypeOptions = [
  {
    label: '固定值',
    value: OBJECT_TYPE_ENUM.FixedValue,
  },
  {
    label: '模型属性',
    value: OBJECT_TYPE_ENUM.ModelValue,
  },
  {
    label: 'URL参数值',
    value: OBJECT_TYPE_ENUM.UrlParamValue,
  },
  {
    label: 'DOM值',
    value: OBJECT_TYPE_ENUM.DomValue,
  },
  {
    label: '数据集值',
    value: OBJECT_TYPE_ENUM.DatasetValue,
  },
  {
    label: '当前组件数据',
    value: OBJECT_TYPE_ENUM.ComponentDataValue,
  },
]

/**
 * 当前部件值只对少数“有明确运行时值语义”的部件开放。
 * 这样规则面板不会把图片、轮播图之类纯展示部件误暴露成可比较值来源。
 */
export const widgetRuntimeSupportKeyNameSet = new Set([
  'VInputsTab',
  // 页面菜单把当前点击项的稳定节点 ID 写入 value，可直接参与状态条件和后续交互编排。
  'VPageMenu',
  'VSelect',
  'VInputsDate',
  'VTextCommon',
  'VInput',
  'VInputsPagination',
  // 页面分页器写入当前页签的事件值，交互规则可据此为每个页签执行不同跳转链接。
  'VPagePagination',
  'VNumber',
  'VFlipperNumber',
  'VCountDown',
])

/**
 * 当前阶段统一只暴露一个运行时字段 value：
 * - 文本 / 输入框 / 选择器：当前值
 * - 页面菜单：当前点击菜单的稳定节点 ID
 * - 数字分页器：当前页
 * - 页面分页器：当前页签事件值
 * - 数字计数器 / 数字翻牌：当前显示值
 * - 倒计时：当前剩余秒数
 */
export const widgetRuntimeFieldOptions = [
  {
    label: '当前值',
    value: 'value',
  },
]

/**
 * “当前部件值”是动态入口，只有支持的部件才会在弹窗里追加此选项。
 * 单独抽成常量后，规则弹窗与校验逻辑都能复用同一份文案。
 */
export const widgetRuntimeObjectTypeOption = {
  label: '当前部件值',
  value: OBJECT_TYPE_ENUM.WidgetRuntimeValue,
}

export const isWidgetRuntimeSupportedKeyName = (keyName?: string | null) =>
  Boolean(keyName && widgetRuntimeSupportKeyNameSet.has(keyName))

export const fixedValueTypeOptions = [
  {
    label: '字符串',
    value: FIXED_VALUE_TYPE_ENUM.String,
  },
  {
    label: '数字',
    value: FIXED_VALUE_TYPE_ENUM.Number,
  },
  {
    label: '布尔值',
    value: FIXED_VALUE_TYPE_ENUM.Boolean,
  },
  {
    label: 'JSON',
    value: FIXED_VALUE_TYPE_ENUM.JSON,
  },
]

export const judgmentTypeOptions = [
  {
    label: '等于',
    value: JUDGMENT_TYPE_ENUM.Equal,
  },
  {
    label: '不等于',
    value: JUDGMENT_TYPE_ENUM.NotEqual,
  },
  {
    label: '大于',
    value: JUDGMENT_TYPE_ENUM.GreaterThan,
  },
  {
    label: '小于',
    value: JUDGMENT_TYPE_ENUM.LessThan,
  },
  {
    label: '大于等于',
    value: JUDGMENT_TYPE_ENUM.GreaterThanOrEqual,
  },
  {
    label: '小于等于',
    value: JUDGMENT_TYPE_ENUM.LessThanOrEqual,
  },
]

export const modelValueTypeOptions = [
  {
    label: '模型显隐',
    value: MODEL_VALUE_TYPE_ENUM.Visibility,
  },
  {
    label: '模型位置',
    value: MODEL_VALUE_TYPE_ENUM.Position,
  },
  {
    label: '模型旋转',
    value: MODEL_VALUE_TYPE_ENUM.Rotation,
  },
  {
    label: '模型缩放',
    value: MODEL_VALUE_TYPE_ENUM.Scale,
  },
]

export const domSelectorTypeOptions = [
  {
    label: '文本内容',
    value: DOM_SELECTOR_TYPE_ENUM.TextContent,
  },
  {
    label: '输入值',
    value: DOM_SELECTOR_TYPE_ENUM.InputValue,
  },
  {
    label: '是否选中',
    value: DOM_SELECTOR_TYPE_ENUM.IsChecked,
  },
  {
    label: '是否被选中',
    value: DOM_SELECTOR_TYPE_ENUM.IsSelected,
  },
  {
    label: 'HTML内容',
    value: DOM_SELECTOR_TYPE_ENUM.HTML,
  },
]

export const fixedValueFieldMap: Record<
  FixedValueLocation,
  {
    valueKey: 'sourceFixedValue' | 'targetFixedValue'
    textKey: 'sourceUrlParamsName' | 'targetUrlParamsName'
  }
> = {
  source: {
    valueKey: 'sourceFixedValue',
    textKey: 'sourceUrlParamsName',
  },
  target: {
    valueKey: 'targetFixedValue',
    textKey: 'targetUrlParamsName',
  },
}

export const rulesTypeMap = {
  all: '满足所有条件',
  one: '满足任一条件',
}
