import type { SceneDefinition, SceneRepository, ViewportHost } from '@/scene-platform'
import { getActiveSceneViewportHost } from './editorScenePlatformHost'
import { createDim3dSceneRepository } from './dim3dSceneRepository'
import { applyEditorSceneCameraToRuntime } from './editorSceneSettingsAdapter'
import type { EditorGisTileApi } from './editorGisDefaultLayerAdapter'
import {
  applyEditorWidgetSceneFragment,
  removeEditorWidgetMirrorObjects,
  type EditorWidgetSceneFragmentApplier,
} from './editorSceneWidgetSnapshotAdapter'
import {
  validateEditorSceneAssets,
  type EditorSceneAssetValidationResult,
} from './editorSceneAssetValidation'
import { applyEditorSceneGlobalState } from './editorSceneGlobalStateAdapter'

export interface LoadEditorSceneDefinitionOptions {
  repository?: Pick<SceneRepository, 'load'>
  applyWidgetFragment?: EditorWidgetSceneFragmentApplier
  gisTileApi?: EditorGisTileApi
}

export interface LoadEditorSceneDefinitionIntoHostOptions extends LoadEditorSceneDefinitionOptions {
  host?: (Pick<ViewportHost, 'replaceScene'> & Partial<Pick<ViewportHost, 'getRuntime'>>) | null
  /**
   * 页面挂载前已经读取过的场景定义结果。
   * 复用该结果可以避免为判断旧/新格式而额外请求一次后端，也保证 Runtime 初始化和后续恢复使用同一份快照。
   */
  preloadedResult?: EditorSceneDefinitionLoadResult
  /**
   * 预读的新 SceneDefinition 已作为 ViewportHost 初始场景并在 mount 中完成 RuntimeBridge 同步时设为 true。
   * 此时只补齐 widget 与相机副作用，不能再次 replaceScene，否则会重复创建首屏附近模型。
   */
  skipSceneReplace?: boolean
  /** 整场景导入可在异步替换期间卸载；失效后禁止继续恢复二维仓库和相机。 */
  isActive?: () => boolean
  /** 模板历史命令恢复时保留已有命令栈；普通打开和文件导入仍清空旧场景历史。 */
  preserveHistory?: boolean
}

export interface EditorSceneDefinitionLoadResult {
  scene: SceneDefinition | null
  loadedBy: 'scene-definition' | 'empty'
  assetValidation?: EditorSceneAssetValidationResult
}

/**
 * 编辑器默认读取 dim3d 当前编辑修订。
 *
 * 浏览器本地场景仓储已移除；调用方未注入测试仓储时只能从真实详情接口恢复，避免旧本地
 * JSON 遮蔽服务端最新数据。预览仍由专用加载器读取不可变发布快照，不复用当前编辑修订。
 */
const editorSceneRepository = createDim3dSceneRepository()

/**
 * 从已注入的新场景仓库加载并解析 SceneDefinition。
 *
 * G003 只处理纯领域数据恢复：
 * - 反序列化和校验继续复用 SceneRepository 抽象；
 * - 不读取旧 sceneApi，也不把旧 SceneAsyncConfig 迁移为新结构；
 * - 旧格式迁移和重新打开完整一致性继续留给 G004。
 */
export const loadEditorSceneDefinition = async (
  sceneId: string,
  options: LoadEditorSceneDefinitionOptions = {},
): Promise<EditorSceneDefinitionLoadResult> => {
  const scene = await (options.repository ?? editorSceneRepository).load(sceneId)
  // 二维阶段只清理已知二维镜像，不生成 GIS 默认图层、测试方块或新的三维流式配置。
  const sanitizedScene = scene ? removeEditorWidgetMirrorObjects(scene) : null

  /**
   * 打开场景时只返回资产校验结果，不在适配器里中断加载。
   * 存量数据可能已有缺失资源，页面需要能先恢复可见部分，再提示用户补齐。
   */
  const assetValidation = sanitizedScene ? validateEditorSceneAssets(sanitizedScene) : undefined

  return {
    /** 第一阶段保留未编辑的三维领域数据，不执行旧浏览器引擎的几何修复与默认对象生成。 */
    scene: sanitizedScene,
    loadedBy: scene ? 'scene-definition' : 'empty',
    ...(assetValidation && !assetValidation.valid ? { assetValidation } : {}),
  }
}

/**
 * 将加载到的 SceneDefinition 写入当前编辑器平台宿主。
 *
 * replaceScene 会触发 Store 和 RuntimeBridge 同步；这里不直接操作 Store，
 * 避免页面层越过 ViewportHost 生命周期边界。
 */
export const loadEditorSceneDefinitionIntoHost = async (
  sceneId: string,
  options: LoadEditorSceneDefinitionIntoHostOptions = {},
): Promise<EditorSceneDefinitionLoadResult> => {
  const host = options.host ?? getActiveSceneViewportHost()
  if (!host) {
    throw new Error('当前编辑器没有可加载场景定义的平台宿主')
  }

  const result = options.preloadedResult ?? (await loadEditorSceneDefinition(sceneId, options))
  if (options.isActive && !options.isActive()) return result
  /**
   * 公共接口索引和全局请求配置必须先于宿主及二维组件恢复。
   * 空场景也会写入默认值，防止连续打开场景时沿用上一场景的请求状态。
   */
  applyEditorSceneGlobalState(result.scene)
  if (result.scene) {
    /**
     * 首屏预读成功时，ViewportHost 已以同一份 SceneDefinition 建立 Runtime，重复 replaceScene 会触发第二次
     * loadScene。流式场景下这会造成重复模型创建和不必要的网络请求，因此仅在未预装时替换场景。
     */
    if (!options.skipSceneReplace) {
      await host.replaceScene(result.scene, { preserveHistory: options.preserveHistory })
    }
    if (options.isActive && !options.isActive()) return result
    /**
     * 新格式下二维部件片段不属于平台核心对象树。
     * replaceScene 只恢复 SceneStore；这里单独恢复 widget 仓库，保证刷新后画布和“部件”结构区
     * 能继续消费 widgets/widgetLayerTree，而不是只剩 SceneStore 中的二维镜像对象。
     */
    await applyEditorWidgetSceneFragment(result.scene, options.applyWidgetFragment, options.isActive)
    if (options.isActive && !options.isActive()) return result
    await applyEditorSceneCameraToRuntime(result.scene, host.getRuntime?.() ?? null)
  }

  return result
}

export const loadActiveEditorSceneDefinition = loadEditorSceneDefinitionIntoHost
