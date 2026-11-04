import type { AssetKind, SceneDefinition, SceneObject } from '@/scene-platform'
import { resolveEditorWidgetSceneFragment } from './editorSceneWidgetSnapshotAdapter'

export type EditorSceneAssetValidationScope = 'object' | 'widget'
export type EditorSceneAssetValidationResourceKind = 'glb-or-gltf' | 'image'

export interface EditorSceneAssetValidationIssue {
  scope: EditorSceneAssetValidationScope
  targetId: string
  targetName: string
  resourceKind: EditorSceneAssetValidationResourceKind
  message: string
}

export interface EditorSceneAssetValidationResult {
  valid: boolean
  issues: EditorSceneAssetValidationIssue[]
  message: string
}

const MODEL_ASSET_KINDS = new Set<AssetKind>(['glb', 'gltf', 'unity-model'])
const IMAGE_ASSET_KINDS = new Set<AssetKind>(['image'])
// 按钮允许没有背景图，但已选择的图片沿用市场资源完整性校验。
const IMAGE_WIDGET_KEY_NAMES = new Set(['VImage', 'VImageCarousel', 'VQuiz', 'VButton'])
const ISSUE_PREVIEW_LIMIT = 3

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const toTrimmedString = (value: unknown) => {
  return typeof value === 'string' ? value.trim() : ''
}

const getAssetKindLabel = (resourceKind: EditorSceneAssetValidationResourceKind) => {
  return resourceKind === 'glb-or-gltf' ? 'GLB/GLTF' : '图片'
}

const createResultMessage = (issues: EditorSceneAssetValidationIssue[]) => {
  if (issues.length === 0) return ''

  const preview = issues
    .slice(0, ISSUE_PREVIEW_LIMIT)
    .map((issue) => issue.message)
    .join('；')
  const restText =
    issues.length > ISSUE_PREVIEW_LIMIT ? `，另有 ${issues.length - ISSUE_PREVIEW_LIMIT} 项` : ''

  return `场景存在 ${issues.length} 项缺失资源：${preview}${restText}`
}

const pushIssue = (
  issues: EditorSceneAssetValidationIssue[],
  issue: Omit<EditorSceneAssetValidationIssue, 'message'>,
) => {
  const resourceLabel = getAssetKindLabel(issue.resourceKind)
  const targetType = issue.scope === 'object' ? '对象' : '二维部件'

  issues.push({
    ...issue,
    message: `${targetType}“${issue.targetName}”缺少${resourceLabel}资源地址`,
  })
}

const getObjectTargetName = (object: SceneObject) => {
  return object.name?.trim() || object.id
}

const validateObjectAsset = (
  object: SceneObject,
  allowedKinds: ReadonlySet<AssetKind>,
  resourceKind: EditorSceneAssetValidationResourceKind,
  issues: EditorSceneAssetValidationIssue[],
) => {
  const targetName = getObjectTargetName(object)
  const asset = object.asset

  // 托管模型只有稳定编号和内部定位符；实际可读性由Unity资源服务鉴权加载确认。
  if (object.type === 'model' && asset?.kind === 'unity-model') {
    const resourceId = String(asset.metadata?.assetId ?? asset.id)
    if (/^[1-9]\d{0,18}$/.test(resourceId) && asset.url === `unity-resource://${resourceId}`) return
    pushIssue(issues, { scope: 'object', targetId: object.id, targetName, resourceKind })
    return
  }

  if (!asset) {
    pushIssue(issues, {
      scope: 'object',
      targetId: object.id,
      targetName,
      resourceKind,
    })
    return
  }

  /**
   * 这里按用户可修复的“资产引用不完整”提示。
   * core 校验仍负责英文结构错误；编辑器适配层负责给保存和打开流程提供中文可读提示。
   */
  if (!toTrimmedString(asset.id) || !toTrimmedString(asset.url)) {
    pushIssue(issues, {
      scope: 'object',
      targetId: object.id,
      targetName,
      resourceKind,
    })
    return
  }

  if (!allowedKinds.has(asset.kind)) {
    issues.push({
      scope: 'object',
      targetId: object.id,
      targetName,
      resourceKind,
      message: `对象“${targetName}”绑定的资源类型不是${getAssetKindLabel(resourceKind)}`,
    })
  }
}

const validateSceneObjectAssets = (
  objects: SceneDefinition['objects'],
  issues: EditorSceneAssetValidationIssue[],
) => {
  objects.forEach((object) => {
    if (object.type === 'model') {
      validateObjectAsset(object, MODEL_ASSET_KINDS, 'glb-or-gltf', issues)
      return
    }

    if (object.type === 'image') {
      /**
       * 三维看板（billboard）使用纯 CanvasTexture 合成绘制，不依赖外部图片 URL，
       * 即使 type='image' 复用 Sprite 创建链路，也不应被 image.asset.url 的必填校验拦截。
       */
      if (object.billboard) {
        return
      }
      validateObjectAsset(object, IMAGE_ASSET_KINDS, 'image', issues)
    }
  })
}

const getWidgetComponent = (widget: unknown) => {
  if (!isRecord(widget)) return null
  const component = widget.component
  return isRecord(component) ? component : null
}

const getWidgetId = (widget: unknown, index: number) => {
  if (!isRecord(widget)) return `widget-${index + 1}`
  return toTrimmedString(widget.id) || `widget-${index + 1}`
}

const getWidgetName = (component: Record<string, unknown>, fallbackId: string) => {
  const info = component.info
  if (!isRecord(info)) return fallbackId

  return toTrimmedString(info.name) || toTrimmedString(info.keyName) || fallbackId
}

const getWidgetKeyName = (component: Record<string, unknown>) => {
  const info = component.info
  return isRecord(info) ? toTrimmedString(info.keyName) : ''
}

const getWidgetOption = (component: Record<string, unknown>) => {
  return isRecord(component.option) ? component.option : null
}

const getImageCarouselRuntimeUrls = (option: Record<string, unknown>) => {
  const optionUrls = Array.isArray(option.options)
    ? option.options
        .map((item) => (isRecord(item) ? toTrimmedString(item.value) : ''))
        .filter(Boolean)
    : []

  if (optionUrls.length > 0) {
    return optionUrls
  }

  return Array.isArray(option.dataset)
    ? option.dataset.map((item) => toTrimmedString(item)).filter(Boolean)
    : []
}

const validateWidgetImageAssets = (
  widgets: unknown[],
  issues: EditorSceneAssetValidationIssue[],
) => {
  widgets.forEach((widget, index) => {
    const component = getWidgetComponent(widget)
    if (!component) return

    const keyName = getWidgetKeyName(component)
    if (!IMAGE_WIDGET_KEY_NAMES.has(keyName)) return

    const targetId = getWidgetId(widget, index)
    const targetName = getWidgetName(component, targetId)
    const option = getWidgetOption(component)

    if (!option) {
      pushIssue(issues, {
        scope: 'widget',
        targetId,
        targetName,
        resourceKind: 'image',
      })
      return
    }

    if (keyName === 'VQuiz' || keyName === 'VButton') {
      /** 测验与按钮图片位允许留空；已配置图片必须包含可用地址，市场图片还必须包含稳定编号。 */
      const images = isRecord(option.images) ? Object.values(option.images) : []
      const hasInvalidConfiguredImage = images.some((value) => {
        if (!isRecord(value)) return false
        const sourceType = toTrimmedString(value.sourceType)
        const url = toTrimmedString(value.value)
        const resourceKey = toTrimmedString(value.resourceKey)
        if (!url && !resourceKey) return false
        return !url || (sourceType === 'resource-market' && !resourceKey)
      })
      if (hasInvalidConfiguredImage) {
        pushIssue(issues, { scope: 'widget', targetId, targetName, resourceKind: 'image' })
      }
      return
    }

    /**
     * 二维图片部件当前有两类：
     * - VImage 外部模式使用 option.value，资源市场模式还必须具备稳定 resourceKey；
     * - VImageCarousel 运行时先消费 options，再回退 dataset。
     * 校验逻辑跟随真实渲染读取顺序，避免配置面板和保存提示判断不一致。
     */
    const hasImageUrl =
      keyName === 'VImage'
        ? Boolean(
            toTrimmedString(option.value) &&
              (toTrimmedString(option.sourceType) !== 'resource-market' ||
                toTrimmedString(option.resourceKey)),
          )
        : getImageCarouselRuntimeUrls(option).length > 0

    if (!hasImageUrl) {
      pushIssue(issues, {
        scope: 'widget',
        targetId,
        targetName,
        resourceKind: 'image',
      })
    }
  })
}

/**
 * 校验编辑器新格式场景里的 GLB/GLTF 和图片资源引用。
 *
 * 边界：
 * - 只检查可序列化快照里是否有资源地址，不发起网络请求；
 * - 保存时用于阻止继续写入坏数据；
 * - 打开时只返回问题，由页面提示用户，避免存量场景被校验直接阻断。
 */
export const validateEditorSceneAssets = (
  scene: SceneDefinition,
): EditorSceneAssetValidationResult => {
  const issues: EditorSceneAssetValidationIssue[] = []

  validateSceneObjectAssets(scene.objects, issues)
  validateWidgetImageAssets(resolveEditorWidgetSceneFragment(scene).widgets, issues)

  return {
    valid: issues.length === 0,
    issues,
    message: createResultMessage(issues),
  }
}

export class EditorSceneAssetValidationError extends Error {
  readonly result: EditorSceneAssetValidationResult

  constructor(result: EditorSceneAssetValidationResult) {
    super(result.message || '场景存在缺失资源')
    this.name = 'EditorSceneAssetValidationError'
    this.result = result
  }
}

export const assertEditorSceneAssetsReady = (scene: SceneDefinition) => {
  const result = validateEditorSceneAssets(scene)
  if (!result.valid) {
    throw new EditorSceneAssetValidationError(result)
  }
}

export const hasEditorSceneAssetValidationIssues = (
  result: EditorSceneAssetValidationResult | undefined,
) => {
  return Boolean(result?.issues.length)
}
