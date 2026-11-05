import type { SceneDefinition } from '@/scene-platform'
import type { PublicRequestConfig, RequestGlobalConfig } from '@/types/data-config'
import { createEmptyRequestGlobalConfig } from '@/types/data-config'
import { useSceneRequestStore } from '@/stores/sceneAuxiliaryStores'
import { getActivePinia } from 'pinia'
import { isEqual } from 'lodash-es'
import { editorSceneOperation } from './editorSceneOperationGate'
import { getActiveSceneViewportHost } from './editorScenePlatformHost'

/**
 * 编辑器场景级请求状态的纯数据快照。
 * 这些字段没有实例拥有者，必须进入 sceneJson，而不是 dependenciesJson。
 */
export interface EditorSceneGlobalStateSnapshot {
  requestGlobalConfig: RequestGlobalConfig
  publicRequests: PublicRequestConfig[]
  sceneActions: unknown[]
}

const cloneValue = <T>(value: T): T => {
  try {
    return structuredClone(value)
  } catch {
    return JSON.parse(JSON.stringify(value)) as T
  }
}

/** 请求弹窗的编辑写入统一历史。场景加载仍直接恢复初始配置。 */
export const updateEditorSceneRequestGlobalConfig = (config: RequestGlobalConfig): boolean => {
  const commandBus = getActiveSceneViewportHost()?.getCommandBus()
  if (!commandBus || editorSceneOperation.value || commandBus.getIsPending()) return false
  const store = useSceneRequestStore()
  const before = cloneValue(store.sceneRequestGlobalConfig)
  const after = cloneValue(config)
  if (isEqual(before, after)) return false
  const apply = store.setSceneRequestGlobalConfig
  try {
    apply(after)
    commandBus.recordExecuted({
      name: '更新场景全局请求配置',
      confirmationScope: 'local',
      execute: () => apply(after),
      undo: () => apply(before),
      captureRollback: () => {
        const current = cloneValue(store.sceneRequestGlobalConfig)
        return () => apply(current)
      },
    })
  } catch (error) {
    apply(before)
    throw error
  }
  return true
}

/** 读取当前编辑器请求仓库；没有活动 Pinia 时返回 null，便于纯领域单测和模板工具运行。 */
export const readEditorSceneGlobalStateSnapshot = (): EditorSceneGlobalStateSnapshot | null => {
  if (!getActivePinia()) return null
  const store = useSceneRequestStore()
  return cloneValue({
    requestGlobalConfig: store.sceneRequestGlobalConfig,
    publicRequests: store.scenePublicRequestList,
    sceneActions: store.sceneActions,
  })
}

/**
 * 将编辑器公共接口转换为 sceneJson 契约。
 * `publicRequestKey` 是跨实例引用的稳定编号，完整请求字段收纳在 `requestConfig` 中；
 * 编辑器内部使用的 `id` 只在恢复到请求仓库时重新展开。
 */
export const serializeScenePublicRequests = (requests: PublicRequestConfig[]) =>
  requests.map(({ id, name, ...requestConfig }) => ({
    publicRequestKey: id,
    name,
    requestConfig: cloneValue(requestConfig),
  }))

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 从 sceneJson 的公共接口定义恢复右侧面板使用的平铺编辑器结构。 */
export const deserializeScenePublicRequests = (value: unknown): PublicRequestConfig[] => {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!isRecord(item)) return []
    const requestConfig = isRecord(item.requestConfig) ? item.requestConfig : item
    const id = String(item.publicRequestKey ?? item.requestKey ?? item.id ?? '').trim()
    if (!id) return []
    const name = String(item.name ?? requestConfig.requestName ?? id)
    return [{ ...cloneValue(requestConfig), id, name } as PublicRequestConfig]
  })
}

/**
 * 从 SceneDefinition 的规范字段读取场景级状态。
 * 加载器已经完成新旧四包优先级选择，这里只保留最后一道旧字段兼容，避免编辑器直接访问依赖包。
 */
export const readSceneGlobalStateFromDefinition = (
  scene: SceneDefinition | null,
): EditorSceneGlobalStateSnapshot => {
  const settings = isRecord(scene?.settings) ? scene.settings : {}
  const dependencies = isRecord(settings.dependencies) ? settings.dependencies : {}
  const legacyRuntime = isRecord(settings.sceneRuntimeDependencies)
    ? settings.sceneRuntimeDependencies
    : {}
  const firstDefined = (...values: unknown[]) => values.find((value) => value !== undefined)
  const requestGlobalConfig = firstDefined(
    settings.requestGlobalConfig,
    dependencies.requestGlobalConfig,
    legacyRuntime.requestGlobalConfig,
  )
  const publicRequests = firstDefined(
    settings.publicRequests,
    dependencies.publicRequests,
    legacyRuntime.publicRequests,
  )
  const sceneActions = firstDefined(
    settings.sceneActions,
    dependencies.sceneActions,
    legacyRuntime.sceneActions,
  )
  return {
    requestGlobalConfig: {
      ...createEmptyRequestGlobalConfig(),
      ...(isRecord(requestGlobalConfig) ? cloneValue(requestGlobalConfig) : {}),
    },
    publicRequests: deserializeScenePublicRequests(publicRequests),
    sceneActions: Array.isArray(sceneActions) ? cloneValue(sceneActions) : [],
  }
}

/** 在场景打开或切换时先恢复请求仓库，避免运行时初始化早于公共接口索引。 */
export const applyEditorSceneGlobalState = (scene: SceneDefinition | null): void => {
  if (!getActivePinia()) return
  const snapshot = readSceneGlobalStateFromDefinition(scene)
  const store = useSceneRequestStore()
  store.setSceneRequestGlobalConfig(snapshot.requestGlobalConfig)
  store.setScenePublicRequestList(snapshot.publicRequests)
  store.setSceneActions(snapshot.sceneActions)
}
