export enum EnumSceneResourceType {
  Element = 'element',
  Component = 'component',
}

export enum EnumSceneElementKey {
  Box = 'Box',
  Sphere = 'Sphere',
  Model = 'Model',
  Plane = 'Plane',
  Sprite = 'Sprite',
  Annotation = 'Annotation',
}
export enum EnumSceneComponentKey {
  Dot = 'Dot',
}

export enum SCENE_PANEL_ENUM {
  Base = 'base',
  Animation = 'animation',
  Camera = 'camera',
  Data = 'data',
  /** 场景级植被系统入口；光照参数已归并至天气系统。 */
  Vegetation = 'vegetation',
  Scene = 'scene',
  Weather = 'weather',
  Interaction = 'interaction',
  Status = 'status',
}

export enum TRANSFORM_CONTROLS_ENUM {
  Translate = 'translate',
  Rotate = 'rotate',
  Scale = 'scale',
}

export enum MEASURE_ENUM {
  Angle = 'Angle',
  Distance = 'Distance',
}

export enum INTERACTIVE_EVENT_ENUM {
  Click = 'click',
  DoubleClick = 'dblclick',
  MouseEnter = 'mouseenter',
  MouseLeave = 'mouseleave',
}

export enum VIEW_TYPE_ENUM {
  Front = 'front',
  Side = 'side',
  Top = 'top',
}

export enum ACTION_TYPE_ENUM {
  HighlightModel = 'highlightModel',
  MoveCamera = 'moveCamera',
  JumpLink = 'jumpLink',
  SwitchScene = 'switchScene',
  SwitchView = 'switchView',
  /** 由当前预览宿主切换第一人称。 */
  ToggleFirstPerson = 'toggleFirstPerson',
  ModelVisibility = 'modelVisibility',
  /** 切换模型显隐并把触发源数据字段写入目标模型属性。 */
  // 统一传参入口；旧枚举仅用于读取历史配置。
  PassParameters = 'passParameters',
  /** 将自定义内容写入二维组件已配置的数据映射字段。 */
  SetWidgetProperty = 'setWidgetProperty',
  ModelVisibilityWithValue = 'modelVisibilityWithValue',
  WidgetVisibility = 'widgetVisibility',
  /** 切换部件显隐并把触发部件的数据字段写入目标部件属性。 */
  WidgetVisibilityWithValue = 'widgetVisibilityWithValue',
}

export enum OBJECT_TYPE_ENUM {
  FixedValue = 'fixedValue',
  ModelValue = 'modelValue',
  UrlParamValue = 'urlParamValue',
  DomValue = 'domValue',
  DatasetValue = 'datasetValue',
  ComponentDataValue = 'componentDataValue',
  WidgetRuntimeValue = 'widgetRuntimeValue',
}

export enum JUDGMENT_TYPE_ENUM {
  // 等于
  Equal = 'Equal',
  // 不等于
  NotEqual = 'NotEqual',
  // 大于
  GreaterThan = 'GreaterThan',
  // 小于
  LessThan = 'LessThan',
  // 大于等于
  GreaterThanOrEqual = 'GreaterThanOrEqual',
  // 小于等于
  LessThanOrEqual = 'LessThanOrEqual',
}

export enum FIXED_VALUE_TYPE_ENUM {
  String = 'String',
  Number = 'Number',
  Boolean = 'Boolean',
  JSON = 'JSON',
}

export enum MODEL_VALUE_TYPE_ENUM {
  Visibility = 'Visibility',
  Position = 'Position',
  Rotation = 'Rotation',
  Scale = 'Scale',
}

export enum DOM_SELECTOR_TYPE_ENUM {
  // 文本内容
  TextContent = 'textContent',
  // 输入值
  InputValue = 'inputValue',
  // 是否选中
  IsChecked = 'isChecked',
  // 是否被选中
  IsSelected = 'isSelected',
  // HTML内容
  HTML = 'html',
}

export enum CONDITION_RULE_TYPE_ENUM {
  All = 'all',
  One = 'one',
}
