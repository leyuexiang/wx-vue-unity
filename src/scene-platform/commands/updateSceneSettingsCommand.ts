import type { SceneSettings } from '../core/types'
import type { SceneCommand } from './types'

export interface UpdateSceneSettingsCommandOptions {
  settings: SceneSettings
  /** 相同合并键的高频输入只保留一条撤销记录。 */
  mergeKey?: string
}

interface UpdateSceneSettingsCommand extends SceneCommand {
  mergeKey?: string
  getSettings: () => SceneSettings
}

function isUpdateSceneSettingsCommand(
  command: SceneCommand,
): command is UpdateSceneSettingsCommand {
  return (
    command.name === 'UpdateSceneSettings' &&
    typeof (command as Partial<UpdateSceneSettingsCommand>).getSettings === 'function'
  )
}

/**
 * 更新 SceneDefinition.settings 的可撤销命令。
 *
 * 命令只写 SceneStore；RuntimeBridge 会收到 sceneSettingsUpdated 并调用 Runtime 的可选增量接口。
 * 这样颜色、光照、相机表单不再借助旧 SceneCommand 或整场景 reload 来刷新画布。
 */
export function createUpdateSceneSettingsCommand(
  options: UpdateSceneSettingsCommandOptions,
): SceneCommand {
  let previousSettings: SceneSettings | null = null
  let nextSettings = options.settings

  const command: UpdateSceneSettingsCommand = {
    name: 'UpdateSceneSettings',
    mergeKey: options.mergeKey,
    mergeSession: options.mergeKey,
    getSettings: () => nextSettings,
    execute: (store) => {
      if (!previousSettings) previousSettings = store.getScene().settings
      store.updateSceneSettings(nextSettings)
    },
    undo: (store) => {
      if (previousSettings) store.updateSceneSettings(previousSettings)
    },
    mergeWith: (nextCommand) => {
      if (!isUpdateSceneSettingsCommand(nextCommand)) return false
      if (!command.mergeKey || command.mergeKey !== nextCommand.mergeKey) return false
      nextSettings = nextCommand.getSettings()
      return true
    },
  }

  return command
}
