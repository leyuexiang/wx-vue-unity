/**
 * 全局事件类型
 */
export enum MITT_ON_KEY_ENUM {
  PAGE_LOADING = 'pageLoading',
  SCENE_LOADING = 'sceneLoading',
  MODEL_DRAG_START = 'modelDragStart',
  /** 模板使用独立拖拽载荷，禁止被画布当作模型资源创建单个对象。 */
  TEMPLATE_DRAG_START = 'templateDragStart',
  PREVIEW_SCENE = 'previewScene',
  MODEL_DRAG_CANCEL = 'modelDragCancel',
  /** 模板拖拽结束后立即释放卡片载荷，避免下一次普通拖拽误应用旧模板。 */
  TEMPLATE_DRAG_CANCEL = 'templateDragCancel',
  HISTORY_APPLIED = 'historyApplied',
  /** Q/W/E 只传递统一变换语义，工具栏通过 Unity 接口切换操控器。 */
  TRANSFORM_MODE_SHORTCUT = 'transformModeShortcut',
}

/**
 * 模型类型
 */
export enum MODEL_ENUM {
  /** 由 Unity 根据稳定资源编号选择加载器，卡片不依赖具体文件扩展名。 */
  UNITY_MODEL = 'unity-model',
  GLTF = 'gltf',
  GLB = 'glb',
  OBJ = 'obj',
  STL = 'stl',
  USDZ = 'usdz',
}

/**
 * 拖拽模型类型
 */
export enum DRAG_MODEL_ENUM {
  Model = 'model',
  Geometry = 'geometry',
  Light = 'light',
  Annotation = 'annotation',
  Image = 'image',
  CustomModel = 'customModel',
  Marking = 'marking',
  Widget = 'widget',
  Line = 'line',
  Pipe = 'pipe',
  /** 场景级特效拖拽项；不对应 SceneObject，直接写入 SceneStore.effects。 */
  Effect = 'effect',
  /** 第一人称起点；映射为 SceneObject.type = camera。 */
  FirstPerson = 'firstPerson',
}
/**
 * 任务类型
 */
export enum TASK_TYPE_ENUM {
  Path = 'path',
  Transfer = 'transfer',
  Highlight = 'highlight',
  Rotation = 'rotation',
}
