import type { SceneDefinition } from '../core/types'
import type { SceneRepository } from '../persistence/sceneRepository'
import { createSceneStore, type SceneStore } from '../store/sceneStore'
import { createCommandBus, type CommandBus } from '../store/commandBus'
import { createRuntimeBridge, type RuntimeBridge } from '../runtime/runtimeBridge'
import { MemorySceneRuntime } from '../runtime/memory/memorySceneRuntime'
import type { SceneRuntime } from '../runtime/sceneRuntime'
import type { SceneObjectStreamingInteraction } from '../runtime/runtimeTypes'

/** 二维宿主只编排领域状态与历史；实际三维运行时在第二阶段通过工厂注入。 */
export interface ViewportHostOptions {
  container: HTMLElement
  scene: SceneDefinition
  runtimeFactory?: (scene: SceneDefinition) => SceneRuntime
  repository?: SceneRepository
}
export interface ViewportHost {
  mount: () => Promise<void>
  replaceScene: (scene: SceneDefinition, options?: { preserveHistory?: boolean }) => Promise<void>
  getStore: () => SceneStore
  getRuntime: () => SceneRuntime
  getCommandBus: () => CommandBus
  getBridge: () => RuntimeBridge
  resetThreeMapCamera: (view: unknown) => boolean
  setObjectVisible: (objectId: string, visible: boolean) => boolean
  restorePreviewState: () => void
  setObjectStreamingInteraction: (objectId: string, interaction: SceneObjectStreamingInteraction) => void
  dispose: () => void
}

/**
 * 复用来源唯一状态仓库与命令历史，内存运行时只保存可序列化快照，不创建图形上下文。
 * 无引擎阶段不接受三维表现动作，避免把内存快照变更误报为真实三维执行成功。
 */
export function createViewportHost(options: ViewportHostOptions): ViewportHost {
  const store = createSceneStore(options.scene)
  const commandBus = createCommandBus(store)
  const runtime = options.runtimeFactory?.(options.scene) ?? new MemorySceneRuntime(options.scene.type)
  const bridge = createRuntimeBridge(store, runtime)
  let disposed = false
  return {
    async mount() { await runtime.mount(options.container); bridge.start(); await bridge.flush() },
    async replaceScene(scene, replaceOptions) {
      if (disposed) throw new Error('二维宿主已销毁')
      if (!replaceOptions?.preserveHistory) commandBus.clear()
      store.loadScene(scene)
      await bridge.flush()
    },
    getStore: () => store, getRuntime: () => runtime,
    getCommandBus: () => commandBus, getBridge: () => bridge,
    resetThreeMapCamera: () => false, setObjectVisible: () => false,
    restorePreviewState: () => undefined,
    setObjectStreamingInteraction: (id, interaction) => bridge.setObjectStreamingInteraction(id, interaction),
    dispose() {
      if (disposed) return
      disposed = true
      bridge.stop()
      commandBus.clear()
      runtime.dispose()
    },
  }
}
