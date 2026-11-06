import type { SceneDefinition, SceneRepository, SceneRuntime } from '@/scene-platform'
import { getActiveSceneViewportHost } from './editorScenePlatformHost'
import { isUnityDeferredObject } from '@/unity-runtime/runtime/projectSceneForUnity'
import type { LegacyScenePanelStateProvider } from './editorSceneSettingsAdapter'
import type { SceneAsyncConfig } from '@/types/threeScene'
import type { WidgetSceneFragment } from './widgetRuntime/widgetSceneFragment'
import type { EditorLegacySceneSaveOptions } from './editorLegacySceneSaveAdapter'
import type { Dim3dSceneSaveAllBody } from '@/servers/manual/dim3d/api/sceneRuntime'
import { captureOriginalScenePackages, preserveUneditedThreeDDomain } from './twoDPackagePreservation'
import { serializeSceneDefinitionToFourPackages } from './sceneFourPackage'
import {
  buildEditorSceneDefinitionBaseSaveSource,
  buildEditorSceneDefinitionSaveSourceFromBase,
} from './editorSceneSaveSourceAdapter'

import {
  prepareEditorSceneSave,
  submitPreparedEditorSceneSave,
  type EditorDim3dSceneSaveBookmark,
  type EditorDim3dSceneSaveContext,
  type EditorDim3dSceneSaveServiceOptions,
} from './editorDim3dSceneSaveService'
import {
  readEditorSceneGlobalStateSnapshot,
  type EditorSceneGlobalStateSnapshot,
} from './editorSceneGlobalStateAdapter'

export interface SaveEditorSceneDefinitionOptions {
  scene?: SceneDefinition | null
  repository?: Pick<SceneRepository, 'save'>
  sceneApi?: LegacyScenePanelStateProvider | null
  /** 可选的 Runtime 相机来源；未注入时自动读取当前活动 ViewportHost。 */
  runtime?: Pick<SceneRuntime, 'getCamera'> | null
  legacySceneConfig?: SceneAsyncConfig | null
  legacySaveOptions?: EditorLegacySceneSaveOptions
  widgetSceneFragment?: WidgetSceneFragment | null
  /** 测试可显式注入；生产保存默认在点击保存的同一时刻读取请求辅助仓库。 */
  sceneGlobalState?: EditorSceneGlobalStateSnapshot | null
  /** 生产保存必需的编辑锁与基准修订，由编辑器根组件注入。 */
  saveContext?: EditorDim3dSceneSaveContext | null
  /** 仅供定向测试注入接口替身或固定幂等键。 */
  dim3dSaveOptions?: EditorDim3dSceneSaveServiceOptions
  /** 保存批次生成后通知调用方释放短期编辑门禁；过期快照在发送前由调用方拒绝。 */
  onPrepared?: (body: Readonly<Dim3dSceneSaveAllBody>) => void
}

/**
 * 采集当前编辑器可持久化快照所需的最小输入。
 * 模板另存与场景保存共用该入口，确保二维部件、场景面板和 SceneStore 在同一条数据链路中合并。
 */
export type CaptureEditorSceneDefinitionOptions = Pick<
  SaveEditorSceneDefinitionOptions,
  'scene' | 'sceneApi' | 'runtime' | 'widgetSceneFragment' | 'sceneGlobalState'
>

export interface EditorSceneDefinitionSaveResult {
  scene: SceneDefinition
  savedBy: 'scene-definition' | 'legacy-scene-async-config'
  /** 只有真实四包整体保存成功时才返回，页面据此更新后端保存书签。 */
  backendBookmark?: EditorDim3dSceneSaveBookmark
}

export const getActiveEditorSceneDefinition = (): SceneDefinition | null => {
  return getActiveSceneViewportHost()?.getStore().getScene() ?? null
}

/**
 * 仅当活动宿主与待保存场景属于同一场景时读取 Runtime。
 *
 * 模板另存和单元测试都可能显式传入 SceneDefinition；如果场景编号或类型不同，不能把当前
 * 页面另一场景的相机误写入目标快照。真实编辑器保存则自动拿到当前 Cesium/Three Runtime。
 */
const getActiveRuntimeForScene = (
  host: ReturnType<typeof getActiveSceneViewportHost>,
  scene: SceneDefinition,
  sceneWasReadFromHost: boolean,
): Pick<SceneRuntime, 'getCamera'> | null => {
  if (!host) return null

  /** 场景已经从该宿主读取时直接复用宿主 Runtime，避免重复读取 Store。 */
  if (sceneWasReadFromHost) return host.getRuntime()

  const activeScene = host.getStore().getScene()
  if (activeScene.id !== scene.id || activeScene.type !== scene.type) return null

  return host.getRuntime()
}

const captureEditorWidgetSceneFragment = async (
  options: CaptureEditorSceneDefinitionOptions,
): Promise<WidgetSceneFragment | null> => {
  if ('widgetSceneFragment' in options) {
    return options.widgetSceneFragment ?? null
  }

  /**
   * 二维仓库只在真实保存动作中按需读取。
   * 这样保存适配器本身不会在测试或纯数据场景中提前加载 widget 包、图标虚拟模块和旧渲染依赖。
   */
  const { readWidgetSceneFragment } = await import('./widgetRuntime/widgetSceneFragment')
  return readWidgetSceneFragment()
}

/**
 * 基于已采集的场景基础快照合并二维部件，生成纯数据 SceneDefinition。
 * 该函数只读取当前编辑状态，不执行后端保存，供普通保存和另存模板复用同一份组装逻辑。
 */
const captureEditorSceneDefinitionFromBase = async (
  baseSceneSaveSource: SceneDefinition,
  options: CaptureEditorSceneDefinitionOptions,
) => {
  const sceneGlobalState =
    'sceneGlobalState' in options ? options.sceneGlobalState : readEditorSceneGlobalStateSnapshot()
  const widgetSceneFragment = await captureEditorWidgetSceneFragment(options)
  return buildEditorSceneDefinitionSaveSourceFromBase(
    baseSceneSaveSource,
    widgetSceneFragment,
    sceneGlobalState,
  )
}

/**
 * 采集当前编辑器在调用瞬间的不可变持久化快照。
 * 不读取浏览器本地草稿、不调用后端接口，也不修改当前实例场景的保存书签或脏状态。
 */
export const captureEditorSceneDefinitionSnapshot = async (
  options: CaptureEditorSceneDefinitionOptions = {},
): Promise<SceneDefinition> => {
  const activeHost = getActiveSceneViewportHost()
  const sceneWasReadFromHost = options.scene === undefined
  const scene = options.scene ?? activeHost?.getStore().getScene() ?? null
  if (!scene) throw new Error('当前编辑器没有可另存的场景定义')

  const baseSceneSaveSource = buildEditorSceneDefinitionBaseSaveSource(
    scene,
    options.sceneApi,
    options.runtime ?? getActiveRuntimeForScene(activeHost, scene, sceneWasReadFromHost),
  )
  return captureEditorSceneDefinitionFromBase(baseSceneSaveSource, options)
}

/**
 * 保存编辑器当前 SceneDefinition。
 *
 * G002 纯 SceneDefinition 保存仍是新格式主路径。
 * F013 将新格式保存源收敛到 editorSceneSaveSourceAdapter：
 * 新格式只从 SceneDefinition、场景面板纯快照和二维片段构建，不遍历 Three Scene。
 *
 * 当前正式持久化目标是后端四包整体保存接口：
 * - 生产路径必须由编辑器根组件注入锁令牌和基准修订号；
 * - 一次保存只调用一次 saveAll，不再写浏览器本地场景 JSON；
 * - 显式注入 repository 仅服务内存仓储等隔离测试，不作为生产回退；
 * - 用户显式注入旧格式保存参数时，仍保留原有旧格式保护分支供迁移测试使用。
 */
export const saveEditorSceneDefinition = async (
  options: SaveEditorSceneDefinitionOptions = {},
): Promise<EditorSceneDefinitionSaveResult> => {
  const activeHost = getActiveSceneViewportHost()
  const sceneWasReadFromHost = options.scene === undefined
  const scene = options.scene ?? activeHost?.getStore().getScene() ?? null
  if (!scene) {
    throw new Error('当前编辑器没有可保存的场景定义')
  }

  const baseSceneSaveSource = buildEditorSceneDefinitionBaseSaveSource(
    scene,
    options.sceneApi,
    options.runtime ?? getActiveRuntimeForScene(activeHost, scene, sceneWasReadFromHost),
  )

  // 旧场景未转换为正式四包时禁止覆盖；第一阶段不从旧引擎实例重建三维数据。
  if (options.legacySaveOptions || 'legacySceneConfig' in options) throw new Error('旧格式场景需先转换为完整四包')

  // 与场景快照同时固定编辑范围，等待采集时的新命令属于下一次保存。
  const usesUnityRuntime = sceneWasReadFromHost && activeHost?.getRuntime().id.startsWith('unity-')
  const editableHierarchyIds = usesUnityRuntime && activeHost
    ? new Set(activeHost.getStore().getHierarchyEditedIds()) : undefined
  const deletedObjectIds = sceneWasReadFromHost && activeHost
    ? new Set(activeHost.getStore().getDeletedObjectIds()) : undefined
  const saveEdits = sceneWasReadFromHost ? activeHost?.getStore().captureSaveEdits() : undefined
  const saveContext = options.saveContext ? { ...options.saveContext } : null
  const originalPackages = captureOriginalScenePackages(saveContext?.sceneId ?? scene.id)
  const sceneToSave = await captureEditorSceneDefinitionFromBase(baseSceneSaveSource, options)

  if (options.repository) {
    /** 显式仓储只用于隔离测试和平台契约验证，生产调用不会进入该分支。 */
    await options.repository.save(sceneToSave)
    return {
      scene: sceneToSave,
      savedBy: 'scene-definition',
    }
  }

  if (!saveContext) {
    throw new Error('当前场景缺少后端保存上下文，无法保存。')
  }
  const body = prepareEditorSceneSave(
    sceneToSave,
    saveContext,
    {
      ...options.dim3dSaveOptions,
      originalPackages,
      ...(editableHierarchyIds?.size ? { editableHierarchyIds } : {}),
      ...(deletedObjectIds?.size ? { deletedObjectIds } : {}),
      ...(saveEdits ? { saveEdits } : {}),
      // 仅当前 Unity 会话已接管的对象开放变换保存，按对象编号匹配原始四包。
      ...(usesUnityRuntime ? {
        editableTransformIds: new Set(sceneToSave.objects.filter(object => !isUnityDeferredObject(object)).map(object => object.id)),
      } : {}),
    },
  )
  options.onPrepared?.(body)
  const backendBookmark = await submitPreparedEditorSceneSave(body, options.dim3dSaveOptions?.saveAll)

  return {
    scene: sceneToSave,
    savedBy: 'scene-definition',
    backendBookmark,
  }
}

export const saveActiveEditorSceneDefinition = saveEditorSceneDefinition

/** 失锁后导出当前内存草稿，沿用保存的合并许可，不包含租约或任何请求身份。 */
export const captureEditorSceneDraftPackages = async (options: CaptureEditorSceneDefinitionOptions = {}) => {
  const host = getActiveSceneViewportHost()
  if (!host) throw new Error('当前没有可导出的编辑草稿')
  const store = host.getStore()
  const source = store.getScene()
  const original = captureOriginalScenePackages(source.id)
  const edits = store.captureSaveEdits()
  const deleted = new Set(store.getDeletedObjectIds())
  const hierarchy = new Set(store.getHierarchyEditedIds())
  const runtime = host.getRuntime()
  const scene = await captureEditorSceneDefinitionSnapshot({ ...options, scene: source, runtime })
  const editableTransforms = runtime.id.startsWith('unity-')
    ? new Set(scene.objects.filter(object => !isUnityDeferredObject(object)).map(object => object.id))
    : undefined
  return { name: scene.name, payload: {
    schemaVersion: scene.schemaVersion,
    ...preserveUneditedThreeDDomain(source.id, serializeSceneDefinitionToFourPackages(scene),
      editableTransforms, hierarchy, deleted, edits, original),
  } }
}
