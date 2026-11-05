import { getCurrentInstance, inject, onScopeDispose, readonly, shallowRef, type InjectionKey, type Ref } from 'vue'
import { createUpdateSceneSettingsCommand } from '@/scene-platform/commands/updateSceneSettingsCommand'
import { getActiveSceneViewportHost, subscribeActiveSceneViewportHost } from './editorScenePlatformHost'

const serverId = shallowRef('')
/** 发布页注入自己的只读配置；null 表示快照尚未加载，不能提前使用部署默认值。 */
export const sceneMediaServerKey: InjectionKey<Readonly<Ref<string | null>>> = Symbol('sceneMediaServer')
let users = 0
let stopHost: (() => void) | undefined
let stopStore: (() => void) | undefined

/** 场景所有视频共享一次宿主订阅；不在高频播放循环中读取整个场景快照。 */
export const useSceneMediaServer = () => {
  const provided = getCurrentInstance() ? inject(sceneMediaServerKey, null) : null
  if (provided) return provided
  if (users++ === 0) {
    stopHost = subscribeActiveSceneViewportHost(host => {
      stopStore?.()
      const sync = () => {
        const value = host?.getStore().getScene().settings.mediaServerId
        serverId.value = typeof value === 'string' ? value : ''
      }
      sync()
      stopStore = host?.getStore().subscribe(event => {
        if (event.type === 'sceneLoaded' || event.type === 'sceneSettingsUpdated') sync()
      })
    })
  }
  onScopeDispose(() => {
    if (--users === 0) {
      stopStore?.()
      stopHost?.()
      stopStore = stopHost = undefined
      serverId.value = ''
    }
  })
  return readonly(serverId)
}

/** 只保存公开服务器 ID，沿用场景保存与撤销命令，不复制服务端密钥。 */
export const updateSceneMediaServer = (value: string) => {
  const host = getActiveSceneViewportHost()
  if (!host || host.getStore().getScene().settings.mediaServerId === value) return
  host.getCommandBus().execute(createUpdateSceneSettingsCommand({
    settings: { ...host.getStore().getScene().settings, mediaServerId: value },
  }))
}
