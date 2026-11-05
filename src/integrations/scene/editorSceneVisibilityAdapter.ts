import {
  createUpdateObjectVisibilityCommand,
  type CommandBus,
  type SceneStore,
} from '@/scene-platform'

export type SceneVisibilityUpdateSkipReason =
  | 'missing-store'
  | 'missing-object-id'
  | 'missing-object'
  | 'unchanged-visible'
  | 'locked-object'

export type SceneVisibilityUpdateResult =
  | {
      status: 'applied'
      objectId: string
      visible: boolean
    }
  | {
      status: 'skipped'
      reason: SceneVisibilityUpdateSkipReason
    }

export interface ApplySceneObjectVisibilityOptions {
  commandBus?: Pick<CommandBus, 'execute'> | null
  store?: SceneStore | null
  objectId?: string | null
  visible: boolean
}

export interface ApplyLegacySceneObjectVisibilityOptions {
  objectId?: string | null
  visible: boolean
  getCurrentVisible: (objectId: string) => boolean | null
  toggleVisible: (objectId: string) => boolean
}

/**
 * 将编辑器显隐状态写入统一场景平台。
 *
 * 已迁移对象必须优先经过 CommandBus，这样显隐可以和变换一样进入统一撤销重做，
 * RuntimeBridge 再监听 Store 事件同步 Runtime。没有 CommandBus 的独立适配器测试或
 * 过渡调用仍允许直接写 Store；页面层不能因此重新把旧 sceneApi 当成主写入口。
 */
export const applySceneObjectVisibilityToStore = ({
  commandBus,
  store,
  objectId,
  visible,
}: ApplySceneObjectVisibilityOptions): SceneVisibilityUpdateResult => {
  if (!store) return { status: 'skipped', reason: 'missing-store' }
  if (!objectId) return { status: 'skipped', reason: 'missing-object-id' }

  const object = store.getObject(objectId)
  if (!object) return { status: 'skipped', reason: 'missing-object' }

  if (object.visible === visible) {
    return { status: 'skipped', reason: 'unchanged-visible' }
  }
  // 直接写存储的兼容入口也遵守同一编辑约束，不能绕过父链锁定。
  if (store.isObjectEffectivelyLocked(objectId)) return { status: 'skipped', reason: 'locked-object' }

  if (commandBus) {
    commandBus.execute(createUpdateObjectVisibilityCommand(objectId, visible))
    return {
      status: 'applied',
      objectId,
      visible,
    }
  }

  store.upsertObject({
    ...object,
    visible,
  })

  return {
    status: 'applied',
    objectId,
    visible,
  }
}

/**
 * 将显隐写入旧渲染链路。
 *
 * 右侧基础面板的显隐不能再走旧 `updateObjectBaseInfo`，因为该旧接口会同时写回位置和旋转；
 * 当 SceneStore 快照暂时落后于真实 Three 对象时，会把模型拉回旧位置。
 * 这里仅在当前真实显隐与目标值不一致时调用旧显隐切换函数，保证不触碰对象变换。
 */
export const applyLegacySceneObjectVisibility = ({
  objectId,
  visible,
  getCurrentVisible,
  toggleVisible,
}: ApplyLegacySceneObjectVisibilityOptions): SceneVisibilityUpdateResult => {
  if (!objectId) return { status: 'skipped', reason: 'missing-object-id' }

  const currentVisible = getCurrentVisible(objectId)
  if (currentVisible === null) return { status: 'skipped', reason: 'missing-object' }
  if (currentVisible === visible) return { status: 'skipped', reason: 'unchanged-visible' }

  const updated = toggleVisible(objectId)
  if (!updated) return { status: 'skipped', reason: 'missing-object' }

  return {
    status: 'applied',
    objectId,
    visible,
  }
}
