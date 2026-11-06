import { type SceneCommand, type SceneDefinition, type SceneRepository, type ViewportHost } from '@/scene-platform'
import type { Dim3dTemplateSaveScope } from '@/servers/manual/dim3d/api/template'
import {
  loadEditorSceneDefinition,
  loadEditorSceneDefinitionIntoHost,
  type LoadEditorSceneDefinitionOptions,
} from './editorSceneLoadAdapter'
import { createDim3dSceneRepository } from './dim3dSceneRepository'
import { refreshActiveSceneViewportHost } from './editorScenePlatformHost'
import { createDefaultSceneCoordinateSystem, serializeSceneDefinitionToFourPackages } from './sceneFourPackage'
import { retainOriginalScenePackages } from './twoDPackagePreservation'

export interface ApplyEditorDim3dTemplateInput {
  /** 模板快照对应的场景编号；不能使用模板资源业务编号代替。 */
  templateSceneId: string
  /** 列表兼容数据可能缺失该字段；应用前必须由服务层做最终校验。 */
  saveScope?: Dim3dTemplateSaveScope
}

export interface ApplyEditorDim3dTemplateOptions {
  /** 页面卸载后不再覆盖宿主、公共配置或二维仓库。 */
  isActive?: () => boolean
  /** 测试可注入宿主；生产路径使用当前画布持有的真实宿主。 */
  host: ViewportHost
  /** 测试可注入仓储；生产路径通过场景详情接口读取模板当前四包。 */
  repository?: Pick<SceneRepository, 'load'>
  /** 测试可截获二维仓库应用，生产路径使用现有二维组件恢复入口。 */
  applyWidgetFragment?: LoadEditorSceneDefinitionOptions['applyWidgetFragment']
}

/**
 * 把模板场景转换为当前场景的覆盖快照。
 *
 * 模板场景编号只用于读取模板，绝不能进入当前编辑场景；应用后始终换回当前场景编号。
 * 仅二维模板允许跨场景类型，此时清空全部三维域并按当前目标类型创建默认坐标系，避免来源
 * GIS／本地三维配置污染目标场景。仅三维和全部模板必须与当前场景类型一致。
 */
export const createEditorSceneFromTemplate = (
  templateScene: SceneDefinition,
  currentScene: SceneDefinition,
  saveScope: Dim3dTemplateSaveScope,
): SceneDefinition => {
  if (saveScope !== 'twoD' && templateScene.type !== currentScene.type) {
    throw new Error('该模板的三维场景类型与当前场景不一致，无法应用')
  }

  if (saveScope === 'twoD') {
    return {
      ...templateScene,
      id: currentScene.id,
      type: currentScene.type,
      coordinateSystem: createDefaultSceneCoordinateSystem(currentScene.type),
      objects: [],
      layers: [],
      effects: [],
      streaming: {
        groups: [],
        chunks: [],
        options: { enabled: true },
      },
    }
  }

  /**
   * 流式区块会把所属场景编号独立保存在 chunk.sceneId 中。
   * 仅替换 SceneDefinition.id 会让后续保存再次写入模板场景编号，因此存在流式配置时按区块
   * 做一次线性映射；其它字段保持原引用语义，避免为应用模板进行没有必要的整场景深拷贝。
   */
  const streaming = templateScene.streaming
  return {
    ...templateScene,
    id: currentScene.id,
    ...(streaming
      ? {
          streaming: {
            ...streaming,
            chunks: streaming.chunks.map((chunk) => ({
              ...chunk,
              sceneId: currentScene.id,
            })),
          },
        }
      : {}),
  }
}

/**
 * 请求模板四包、解析并整体覆盖当前编辑场景。
 * 请求与解析完成前不修改当前宿主；解析成功后由 ViewportHost 替换运行时，
 * 再恢复二维仓库、场景级请求状态及相机，并登记可异步回放的场景快照命令。
 */
export const applyEditorDim3dTemplate = async (
  input: ApplyEditorDim3dTemplateInput,
  options: ApplyEditorDim3dTemplateOptions,
) => {
  const templateSceneId = input.templateSceneId.trim()
  if (!templateSceneId) throw new Error('当前模板缺少可加载的模板场景编号')
  if (!input.saveScope) throw new Error('当前模板缺少有效的保存范围，无法应用')

  const currentScene = options.host.getStore().getScene()
  const templateLoadResult = await loadEditorSceneDefinition(templateSceneId, {
    repository: options.repository ?? createDim3dSceneRepository(),
  })
  if (!templateLoadResult.scene) throw new Error('模板接口未返回可应用的场景内容')
  if (options.isActive && !options.isActive()) throw new Error('模板应用已随页面关闭取消')

  const appliedScene = createEditorSceneFromTemplate(
    templateLoadResult.scene,
    currentScene,
    input.saveScope,
  )
  const appliedResult = {
    ...templateLoadResult,
    scene: appliedScene,
  }
  let replacementStarted = false
  try {
    replacementStarted = true
    await loadEditorSceneDefinitionIntoHost(currentScene.id, {
      host: options.host,
      preloadedResult: appliedResult,
      applyWidgetFragment: options.applyWidgetFragment,
      isActive: options.isActive,
      preserveHistory: true,
    })
  } catch (error) {
    if (replacementStarted && (!options.isActive || options.isActive())) {
      try {
        /**
         * 场景宿主替换和二维仓库恢复是两个异步步骤。二维片段失败时三维宿主可能已经切换，
         * 必须用应用前的内存草稿回放一次，不能重新读取服务端版本覆盖用户未保存修改。
         */
        await loadEditorSceneDefinitionIntoHost(currentScene.id, {
          host: options.host,
          preloadedResult: { scene: currentScene, loadedBy: 'scene-definition' },
          applyWidgetFragment: options.applyWidgetFragment,
          isActive: options.isActive ?? (() => true),
        })
      } catch {
        // 恢复失败仍保留原始错误，外层操作门禁负责阻止继续编辑并提示重试。
      }
    }
    throw error
  }
  /** 跨类型二维模板会替换宿主内部运行时，主动通知左右面板重新读取当前能力与场景类型。 */
  refreshActiveSceneViewportHost(options.host)

  const commandBus = options.host.getCommandBus?.()
  if (commandBus) {
    const restoreSnapshot = async (action: 'execute' | 'undo' | 'redo') => {
      const targetScene = action === 'undo' ? currentScene : appliedScene
      await loadEditorSceneDefinitionIntoHost(currentScene.id, {
        host: options.host,
        preloadedResult: { scene: targetScene, loadedBy: 'scene-definition' },
        skipSceneReplace: true,
        applyWidgetFragment: options.applyWidgetFragment,
        isActive: options.isActive,
      })
      if (options.isActive && !options.isActive()) throw new Error('模板应用已随页面关闭取消')
      // 撤销或重做后保存必须以当前回放快照作为原始四包基线，不能继续保留另一个历史端点。
      retainOriginalScenePackages(currentScene.id, serializeSceneDefinitionToFourPackages(targetScene))
      refreshActiveSceneViewportHost(options.host)
    }
    const command: SceneCommand = {
      name: '应用场景模板',
      confirmationScope: 'runtime',
      execute: (store) => store.loadScene(appliedScene),
      undo: (store) => store.loadScene(currentScene),
      applyAsync: restoreSnapshot,
    }
    commandBus.recordExecuted(command)
  }
  return appliedScene
}
