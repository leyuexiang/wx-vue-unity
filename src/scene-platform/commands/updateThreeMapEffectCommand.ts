import type { EffectSpec, SceneObject } from '../core/types'
import type { ThreeMapEffectSpec } from '../effects/threeMap'
import { normalizeThreeMapParams } from '../effects/threeMap'
import type { SceneCommand } from './types'

export interface UpdateThreeMapEffectCommandOptions {
  objectId: string
  effect: ThreeMapEffectSpec
  mergeKey?: string
}

interface UpdateThreeMapCommand extends SceneCommand {
  objectId: string
  mergeKey?: string
  getEffect: () => ThreeMapEffectSpec
}

const isUpdateThreeMapCommand = (command: SceneCommand): command is UpdateThreeMapCommand =>
  command.name === 'UpdateThreeMapEffect' &&
  typeof (command as Partial<UpdateThreeMapCommand>).getEffect === 'function'

/** 地图所有参数先归一化，再以单一对象快照进入 CommandBus。 */
export function createUpdateThreeMapEffectCommand({
  objectId,
  effect,
  mergeKey,
}: UpdateThreeMapEffectCommandOptions): SceneCommand {
  let previousObject: SceneObject | null = null
  let nextEffect: ThreeMapEffectSpec = {
    ...effect,
    params: normalizeThreeMapParams(effect.params),
  }
  const command: UpdateThreeMapCommand = {
    name: 'UpdateThreeMapEffect',
    objectId,
    mergeKey,
    mergeSession: mergeKey,
    getEffect: () => nextEffect,
    execute: (store) => {
      const current = store.getObject(objectId)
      if (!current) return
      previousObject ??= current
      store.upsertObject({ ...current, effect: nextEffect })
    },
    undo: (store) => {
      if (previousObject) store.upsertObject(previousObject)
    },
    mergeWith: (next) => {
      if (!isUpdateThreeMapCommand(next)) return false
      if (!mergeKey || next.mergeKey !== mergeKey || next.objectId !== objectId) return false
      nextEffect = next.getEffect()
      return true
    },
  }
  return command
}

export const isThreeMapEffect = (effect: EffectSpec | undefined): effect is ThreeMapEffectSpec =>
  effect?.type === 'three-map'
