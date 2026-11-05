import type { VolumeHeatmapEffectSpec } from '../effects/volumeHeatmap'
import type { EffectSpec, SceneObject, SceneTransform } from '../core/types'
import type { SceneCommand } from './types'

/** 三维热力场参数更新命令；mergeKey 用于合并滑块连续输入。 */
export interface UpdateVolumeHeatmapEffectCommandOptions {
  effect: VolumeHeatmapEffectSpec
  objectId?: string
  /** GIS 面板修改经纬高时，与体积锚点在同一条撤销记录中更新对象地理变换。 */
  transform?: SceneTransform
  mergeKey?: string
}

interface UpdateVolumeHeatmapCommand extends SceneCommand {
  effectId: string
  objectId?: string
  getTransform: () => SceneTransform | undefined
  mergeKey?: string
  getEffect: () => VolumeHeatmapEffectSpec
}

const isUpdateVolumeHeatmapCommand = (
  command: SceneCommand,
): command is UpdateVolumeHeatmapCommand =>
  command.name === 'UpdateVolumeHeatmapEffect' &&
  typeof (command as Partial<UpdateVolumeHeatmapCommand>).getEffect === 'function'

/**
 * 更新三维热力场领域参数。
 * 只保存小型效果快照，不触碰纹理或体素数组；RuntimeBridge 会把参数增量同步到现有材质。
 */
export const createUpdateVolumeHeatmapEffectCommand = ({
  effect,
  objectId,
  transform,
  mergeKey,
}: UpdateVolumeHeatmapEffectCommandOptions): SceneCommand => {
  let previousEffect: EffectSpec | null = null
  let previousObject: SceneObject | null = null
  let previousIndex = -1
  let nextEffect = effect
  let nextTransform = transform
  const command: UpdateVolumeHeatmapCommand = {
    name: 'UpdateVolumeHeatmapEffect',
    effectId: effect.id,
    objectId,
    getTransform: () => nextTransform,
    mergeKey,
    mergeSession: mergeKey,
    getEffect: () => nextEffect,
    execute: (store) => {
      if (previousEffect === null) {
        previousEffect = store.getEffect(effect.id)
        previousIndex = previousEffect
          ? store.getEffects().findIndex((item) => item.id === effect.id)
          : -1
      }
      const targetObject = objectId ? store.getObject(objectId) : null
      if (objectId && previousObject === null) previousObject = targetObject
      if (targetObject) {
        store.upsertObject({
          ...targetObject,
          name: String(nextEffect.params.name ?? '三维热力场'),
          visible: nextEffect.params.enabled,
          locked: nextEffect.params.pickable === false,
          /** 通用“可拾取”字段以对象元数据为真源，供结构树和基础面板稳定复用。 */
          metadata: {
            ...targetObject.metadata,
            pickable: nextEffect.params.pickable,
          },
          ...(nextTransform ? { transform: nextTransform } : {}),
          effect: nextEffect,
        })
      } else {
        store.upsertEffect(nextEffect)
      }
    },
    undo: (store) => {
      if (objectId) {
        if (previousObject) store.upsertObject(previousObject)
        return
      }
      if (previousEffect) {
        store.insertEffectAt(
          previousEffect,
          previousIndex >= 0 ? previousIndex : store.getEffects().length,
        )
      } else {
        store.removeEffect(effect.id)
      }
    },
    mergeWith: (nextCommand) => {
      if (!isUpdateVolumeHeatmapCommand(nextCommand)) return false
      if (
        nextCommand.effectId !== command.effectId ||
        !command.mergeKey ||
        command.mergeKey !== nextCommand.mergeKey
      )
        return false
      nextEffect = nextCommand.getEffect()
      nextTransform = nextCommand.getTransform()
      return true
    },
  }
  return command
}
