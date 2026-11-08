import type { SceneRuntime } from '@/scene-platform/runtime/sceneRuntime'
import type {
  Dim3dSceneChunkReadSession,
  Dim3dSceneChunkReadSessionSnapshot,
} from './dim3dSceneChunkReader'

/**
 * 将固定修订分片会话的驻留状态串行投影到 Unity Runtime。
 *
 * 会话只提供已加载实例编号，Runtime 仍持有完整场景快照。旧 Runtime 未实现投影入口时，
 * 控制器保持空操作，避免把分片读取误接到完整 `loadScene` 或保存流程。
 */
export const bindDim3dSceneChunkProjection = (
  session: Dim3dSceneChunkReadSession,
  runtime: SceneRuntime,
) => {
  let disposed = false
  let lastError: unknown
  let pending = Promise.resolve()

  const apply = (state: Dim3dSceneChunkReadSessionSnapshot) => {
    if (disposed || !runtime.applyLoadedInstanceProjection) return
    pending = pending.catch(() => undefined).then(async () => {
      try {
        await runtime.applyLoadedInstanceProjection!(new Set(state.loadedInstanceIds))
      } catch (error) {
        lastError = error
        throw error
      }
    })
  }

  const unsubscribe = session.subscribe(apply)
  return {
    flush: async () => {
      await pending
      if (lastError !== undefined) {
        const error = lastError
        lastError = undefined
        throw error
      }
    },
    dispose: () => {
      disposed = true
      unsubscribe()
    },
  }
}
