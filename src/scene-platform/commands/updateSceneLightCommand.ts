import type { SceneLightConfig, SceneObject } from '../core/types'
import type { SceneCommand } from './types'
import { captureSceneObjectUpdateRollback } from './sceneObjectRollback'

/** 灯具参数作为单个领域快照更新，撤销后可恢复阴影与光照。 */
export function createUpdateSceneLightCommand(
  objectId: string,
  light: SceneLightConfig,
): SceneCommand {
  let previousObject: SceneObject | null = null
  return {
    name: 'UpdateSceneLight',
    captureRollback: (store) => captureSceneObjectUpdateRollback(store, objectId),
    execute(store) {
      const current = store.getObject(objectId)
      if (!current || current.type !== 'light') throw new Error(`Light not found: ${objectId}`)
      if (store.isObjectEffectivelyLocked(objectId)) throw new Error(`Locked light: ${objectId}`)
      previousObject ??= current
      store.upsertObject({ ...current, light: { ...light } })
    },
    undo(store) {
      if (previousObject) store.upsertObject(previousObject)
    },
  }
}
