import type { EffectSpec } from '../core/types'
import type { SceneCommand } from './types'

export interface UpdateWeatherEffectCommandOptions {
  effect: EffectSpec
  mergeKey?: string
}

interface UpdateWeatherEffectCommand extends SceneCommand {
  effectId: string
  mergeKey?: string
  getEffect: () => EffectSpec
}

const isUpdateWeatherEffectCommand = (
  command: SceneCommand,
): command is UpdateWeatherEffectCommand =>
  command.name === 'UpdateWeatherEffect' &&
  typeof (command as Partial<UpdateWeatherEffectCommand>).effectId === 'string' &&
  typeof (command as Partial<UpdateWeatherEffectCommand>).getEffect === 'function'

/**
 * 更新全局天气 effect。
 *
 * 约束：命令只读写 SceneStore.effects，不触碰 Runtime；滑杆连续更新通过 mergeKey
 * 合并撤销栈，但保留第一次执行前的 previous effect 作为 undo 基准。
 */
export function createUpdateWeatherEffectCommand(
  options: UpdateWeatherEffectCommandOptions,
): SceneCommand {
  let previousEffect: EffectSpec | null = null
  let previousEffectIndex: number | null = null
  let nextEffect = options.effect

  const command: UpdateWeatherEffectCommand = {
    name: 'UpdateWeatherEffect',
    effectId: options.effect.id,
    mergeKey: options.mergeKey,
    mergeSession: options.mergeKey,
    getEffect: () => nextEffect,
    execute: (store) => {
      if (!previousEffect) {
        const effects = store.getEffects()
        previousEffect = store.getEffect(nextEffect.id)
        previousEffectIndex = previousEffect
          ? effects.findIndex((effect) => effect.id === nextEffect.id)
          : null
      }
      store.upsertEffect(nextEffect)
    },
    undo: (store) => {
      if (previousEffect) {
        store.insertEffectAt(previousEffect, previousEffectIndex ?? store.getEffects().length)
        return
      }
      store.removeEffect(nextEffect.id)
    },
    mergeWith: (nextCommand) => {
      if (!isUpdateWeatherEffectCommand(nextCommand)) return false
      if (nextCommand.effectId !== command.effectId) return false
      if (!command.mergeKey || !nextCommand.mergeKey) return false
      if (nextCommand.mergeKey !== command.mergeKey) return false
      nextEffect = nextCommand.getEffect()
      return true
    },
  }

  return command
}
