// 平台类型（区分场景）
export const PLATFORM_TYPE = '3d-web'

// 资源来源
export const RES_FROM_PLATFORM = 'BABYLON_WEB'

// 输入框文本长度
export const INPUT_MAX_LEN = 128

// 存储桶名称
export const MINIO_BUCKET_NAME = '9tyf'

/**
 * 颜色选择器预设色统一收敛到场景编辑器主色调。
 * 这一组颜色以冷蓝、青色、辅助手势绿和少量告警橙为主，
 * 既能覆盖状态高亮、边框、文字等常见场景，又不会跳出当前项目的深色科技主题。
 */
export const PREDEFINE_COLORS = [
  '#61e8ff',
  '#4da3ff',
  '#2f76ff',
  '#164b88',
  '#0d2e52',
  '#8cf0c7',
  '#41d6a4',
  '#ff9b5e',
  '#ffb36f',
  '#f6fbff',
  'rgba(97, 232, 255, 0.72)',
  'rgba(77, 163, 255, 0.72)',
  'rgba(47, 118, 255, 0.52)',
  'rgba(140, 240, 199, 0.48)',
]

/** minio 上传图片类型 */
export const UPLOAD_IMG_TYPE_MAP = {
  Res: 'res', // 模型管理图
  Icon: 'icon', // 图标管理图
  Scene: 'scene', // 场景管理图
  ResBind: 'resBind', // 场景中部分资源（平面、精灵图等）绑定的图
}

// 需要更新模型属性
export const NEED_UPDATE_MODEL_PROPERTY: Record<
  'visible' | 'position' | 'rotation' | 'scaling',
  string
> = {
  visible: 'visible',
  position: 'position',
  rotation: 'rotation',
  scaling: 'scaling',
}

export const SCENE_EDITOR_BRAND_CONFIG = {
  // 默认品牌与公开目录中的运行时配置保持一致，配置文件加载失败时仍能展示正确的平台标识。
  softwareName: '道地药材溯源平台',
  projectNameFallback: 'Scene Editor',
  // 使用相对 public 资源路径，运行时由品牌配置加载器按 BASE_URL 解析，兼容 /dts/ 子路径部署。
  logoSrc: 'images/scene-editor-brand-logo.png',
  logoAlt: '道地药材溯源平台标识',
} as const
