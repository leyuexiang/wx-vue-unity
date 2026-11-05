import type { SceneCommand } from './types'
import { captureSceneObjectUpdateRollback } from './sceneObjectRollback'

/**
 * 创建对象显隐更新命令。
 *
 * 显隐是场景领域状态，不能只修改 Three 或 Cesium 的运行时对象；否则保存、重开和撤销重做
 * 会各自持有不同结果。命令只更新 SceneStore，RuntimeBridge 会在同一批次内把最终状态同步
 * 给对应 Runtime。每次切换是独立交互。
 */
export function createUpdateObjectVisibilityCommand(
  objectId: string,
  visible: boolean,
): SceneCommand {
  let previousVisible: boolean | undefined
  return {
    name: 'UpdateObjectVisibility',
    captureRollback: (store) => captureSceneObjectUpdateRollback(store, objectId),
    execute: (store) => {
      const current = store.getObject(objectId)
      if (!current) {
        throw new Error(`Object not found: ${objectId}`)
      }
      if (store.isObjectEffectivelyLocked(objectId)) throw new Error('节点已锁定，无法修改显隐')
      previousVisible ??= current.visible
      store.upsertObject({ ...current, visible })
    },
    undo: (store) => {
      // 只恢复自身显隐，保留期间由其他来源更新的名称、变换及配置。
      const current = store.getObject(objectId)
      if (current && previousVisible !== undefined) store.upsertObject({ ...current, visible: previousVisible })
    },
  }
}
