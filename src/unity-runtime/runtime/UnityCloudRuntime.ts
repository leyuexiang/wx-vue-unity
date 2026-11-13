import type { SceneDefinition, SceneObject, SceneTransform } from '@/scene-core'
import type { UnityGizmoMode, UnityRuntimeCapabilities } from '@/unity-runtime/protocol/types'
import type { UnityInteractionActionDto } from '@/unity-runtime/protocol/types'

export interface UnityRuntimeEventMap {
  selectionChanged: { instanceId: string | null }
  objectInteraction: { instanceId: string; eventType: 'click' | 'dblclick' | 'mouseenter' | 'mouseleave' }
  transformPreview: { instanceId: string; transform: SceneTransform }
  transformCommitted: { instanceId: string; transform: SceneTransform }
  sceneProgress: { progress: number; stage?: string }
  sceneLoaded: { sceneId: string }
  sceneFailed: { code: string; message: string }
  runtimeError: { code: string; message: string; fatal?: boolean }
}

export interface UnityCloudRuntime {
  readonly capabilities: UnityRuntimeCapabilities | null
  connect(): Promise<void>
  disconnect(): Promise<void>
  loadScene(scene: SceneDefinition): Promise<void>
  clearScene(): Promise<void>
  createObject(object: SceneObject): Promise<void>
  updateObject(object: SceneObject, options?: { runtimeOnly?: boolean }): Promise<void>
  deleteObject(instanceId: string): Promise<void>
  setSelection(instanceId: string | null): void
  setGizmoMode(mode: UnityGizmoMode): Promise<void>
  setMode(mode: 'edit' | 'preview'): Promise<void>
  /** 在 Unity 草稿模型上执行相机或临时高亮动作，结果确认后才继续动作序列。 */
  executeInteractionAction?(action: UnityInteractionActionDto): Promise<void>
  on<TKey extends keyof UnityRuntimeEventMap>(
    type: TKey,
    listener: (payload: UnityRuntimeEventMap[TKey]) => void,
  ): () => void
}
