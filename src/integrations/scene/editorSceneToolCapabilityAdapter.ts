import { DRAG_MODEL_ENUM } from '@/enums'
import type { RuntimeCapabilities, ViewportHost } from '@/scene-platform'

export interface EditorSceneDragItemWithCapability {
  modelType?: unknown
  effectType?: unknown
}

export interface EditorSceneDragGroupWithCapability<
  TItem extends EditorSceneDragItemWithCapability = EditorSceneDragItemWithCapability,
> {
  children?: TItem[]
  [key: string]: unknown
}

/**
 * 从活动 ViewportHost 提取当前 Runtime 能力声明。
 *
 * 编辑器组件只关心“入口是否可用”，不应该知道 Runtime 的具体类型。
 * 这里把 host.getRuntime().capabilities 收口到一个薄适配器，避免工具栏、资源面板到处散落字段路径。
 */
export const getEditorSceneRuntimeCapabilities = (
  host?: Pick<ViewportHost, 'getRuntime'> | null,
): RuntimeCapabilities | null => host?.getRuntime().capabilities ?? null

/**
 * 判断当前 Runtime 是否支持编辑器测量入口。
 *
 * null 表示 ViewportHost 尚未挂载或已销毁，此时按不可用处理，避免 UI 暴露无法执行的旧 sceneApi 动作。
 */
export const canUseEditorSceneMeasure = (
  capabilities: RuntimeCapabilities | null | undefined,
): boolean => capabilities?.editing.measure === true

/**
 * 判断当前 Runtime 是否支持创建标注对象。
 *
 * 标注入口仍由旧 renderScene 承载，但显隐决策必须看 Runtime 能力，
 * 这样 GIS Runtime 未实现对应适配前不会暴露一个拖拽后无效果的入口。
 */
export const canUseEditorSceneAnnotation = (
  capabilities: RuntimeCapabilities | null | undefined,
): boolean => capabilities?.editing.annotation === true

/** 第一人称资源始终可见，只有声明支持的播放器才能接收拖入操作。 */
export const getFirstPersonDragDisabledReason = (
  capabilities: RuntimeCapabilities | null | undefined,
): string | undefined => {
  const supported = capabilities?.editing.firstPerson
  if (supported === true) return undefined
  return supported === false
    ? '当前播放器不支持第一人称，请更新播放器后重试。'
    : '连接支持第一人称的三维播放器后可拖入。'
}

/**
 * 过滤顶部测量按钮列表。
 *
 * 按整组能力开关处理，避免每个测量类型都重复读取能力字段。
 */
export const filterEditorSceneMeasureTools = <TTool>(
  tools: readonly TTool[],
  capabilities: RuntimeCapabilities | null | undefined,
): TTool[] => (canUseEditorSceneMeasure(capabilities) ? [...tools] : [])

const isEditorSceneDragItemVisible = (
  item: EditorSceneDragItemWithCapability,
  capabilities: RuntimeCapabilities | null | undefined,
): boolean => {
  if (item.modelType === DRAG_MODEL_ENUM.Effect && item.effectType === 'three-map') {
    return capabilities?.effects.threeMapTakeover === true
  }
  if (item.modelType === DRAG_MODEL_ENUM.Effect && item.effectType === 'volume-heatmap') {
    return capabilities?.effects.volumeHeatmap === true
  }
  if (item.modelType === DRAG_MODEL_ENUM.Light) {
    return capabilities?.rendering.indoorLocalLights === true
  }
  if (capabilities?.transform.geo === true && capabilities.transform.local === false) {
    /**
     * GIS Runtime 使用经纬高变换。
     * 基础几何体、管道、打点都已经由平台对象映射为 Cesium Entity，可以保留；
     * 仍未落地的能力继续通过 RuntimeCapabilities 过滤，避免资源面板写死场景类型。
     */
    if (
      (item.modelType === DRAG_MODEL_ENUM.Model || item.modelType === DRAG_MODEL_ENUM.CustomModel) &&
      !capabilities.assets.glb
    ) {
      return false
    }
  }

  if (item.modelType === DRAG_MODEL_ENUM.Annotation) {
    return canUseEditorSceneAnnotation(capabilities)
  }

  return true
}

/**
 * 过滤资源面板拖拽分组。
 *
 * 性能策略：
 * - 没有 children 的分组原样复用；
 * - 子项未变化时复用原分组引用；
 * - 只有被能力隐藏的分组才浅拷贝，避免搜索和渲染阶段产生多余对象。
 */
export const filterEditorSceneDragGroupsByRuntimeCapabilities = <
  TGroup extends EditorSceneDragGroupWithCapability,
>(
  groups: readonly TGroup[],
  capabilities: RuntimeCapabilities | null | undefined,
): TGroup[] =>
  groups.reduce<TGroup[]>((result, group) => {
    if (!group.children) {
      result.push(group)
      return result
    }

    const visibleChildren = group.children.filter((item) =>
      isEditorSceneDragItemVisible(item, capabilities),
    )
    if (visibleChildren.length === 0) return result

    result.push(
      visibleChildren.length === group.children.length
        ? group
        : ({
            ...group,
            children: visibleChildren,
          } as TGroup),
    )
    return result
  }, [])
