import type { SceneObject, SceneResource, UnityGeospatialScene } from '@/scene-core'
import type { SceneStreamingConfig } from '@/scene-platform/core/types'

export const UNITY_EDITOR_PROTOCOL_VERSION = 1 as const
export const UNITY_EDITOR_CLIENT = 'web-unity' as const

export const UNITY_EDITOR_ERROR_CODES = {
  ProtocolVersionUnsupported: 'PROTOCOL_VERSION_UNSUPPORTED',
  InvalidEnvelope: 'INVALID_ENVELOPE',
  SessionNotReady: 'SESSION_NOT_READY',
  SceneGenerationMismatch: 'SCENE_GENERATION_MISMATCH',
  SceneNotFound: 'SCENE_NOT_FOUND',
  CapabilityUnsupported: 'CAPABILITY_UNSUPPORTED',
  RuntimeBusy: 'RUNTIME_BUSY',
  RuntimeTeardown: 'RUNTIME_TEARDOWN',
  InvalidPayload: 'INVALID_PAYLOAD',
} as const

export type UnityEditorErrorCode = typeof UNITY_EDITOR_ERROR_CODES[keyof typeof UNITY_EDITOR_ERROR_CODES]

export type UnityRuntimeMode = 'edit' | 'preview'
export type UnityGizmoMode = 'select' | 'translate' | 'rotate' | 'scale'
export type UnityTransformSpace = 'local' | 'wgs84'
export type UnityRotationKind = 'quaternion'

export interface UnityTransformDto {
  space: UnityTransformSpace
  position: [number, number, number]
  rotation: { kind: UnityRotationKind; value: [number, number, number, number] }
  scale: [number, number, number]
}

export interface UnitySessionInitializePayload {
  client: typeof UNITY_EDITOR_CLIENT
  supportedProtocolVersions: readonly [typeof UNITY_EDITOR_PROTOCOL_VERSION]
  /** 资源服务真实鉴权上下文，令 Unity 按 resourceId 查询当前发布并下载。 */
  resourceAuth?: {
    apiBaseUrl: string
    tenantId: string
    accessToken: string
    downloadOrigins: readonly string[]
  }
}

export interface UnitySessionInitializeResponse {
  protocolVersion: typeof UNITY_EDITOR_PROTOCOL_VERSION
  runtimeVersion: string
  capabilities: UnityRuntimeCapabilities
}

export interface UnitySceneSnapshotDto {
  sceneId: string
  revisionNo: number
  sceneType: 'local3d' | 'gis'
  objects: SceneObject[]
  resources: SceneResource[]
  geospatial?: UnityGeospatialScene
  streaming?: SceneStreamingConfig
}

export interface UnityRequestEnvelope<T = unknown> {
  protocolVersion: typeof UNITY_EDITOR_PROTOCOL_VERSION
  sessionId: string
  sceneId: string
  sceneGeneration: number
  requestId: string
  clientSequence: number
  payload: T
}

export interface UnityResponseEnvelope<T = unknown> {
  protocolVersion: number
  requestId: string
  success: boolean
  payload?: T
  error?: { code: string; message: string; details?: unknown }
}

export interface UnityEventEnvelope<T = unknown> {
  protocolVersion: number
  sessionId: string
  sceneId: string
  sceneGeneration: number
  eventId: string
  type: UnityEditorEventType
  payload: T
}

export type UnityEditorMethod =
  | 'editor.v1.session.initialize'
  | 'editor.v1.scene.loadDraft'
  | 'editor.v1.scene.pickWorldPosition'
  | 'editor.v1.scene.clear'
  | 'editor.v1.object.create'
  | 'editor.v1.object.update'
  | 'editor.v1.object.transform.set'
  | 'editor.v1.object.delete'
  | 'editor.v1.selection.set'
  | 'editor.v1.gizmo.mode.set'
  | 'editor.v1.runtime.mode.set'
  | 'editor.v1.interaction.action'

/** 只传递可序列化动作参数；Unity 运行时根据稳定实例编号解析草稿对象。 */
export type UnityInteractionActionDto =
  | { actionType: 'highlightModel'; instanceId: string; enabled: boolean; color?: string }
  | {
      actionType: 'moveCamera'
      instanceId: string
      transitionTime?: number
      smoothFactor?: number
    }
  | {
      actionType: 'switchView'
      viewType?: 'front' | 'side' | 'top'
      transitionTime?: number
    }

export type UnityEditorEventType =
  | 'editor.v1.runtime.ready'
  | 'editor.v1.scene.progress'
  | 'editor.v1.scene.loaded'
  | 'editor.v1.scene.failed'
  | 'editor.v1.selection.changed'
  | 'editor.v1.object.interaction'
  | 'editor.v1.transform.preview'
  | 'editor.v1.transform.committed'
  | 'editor.v1.runtime.warning'
  | 'editor.v1.runtime.error'
  | 'editor.v1.runtime.metrics'

export interface UnityRuntimeCapabilities {
  sceneTypes: Array<'local3d' | 'gis'>
  objectTypes: string[]
  gizmoModes: Array<'translate' | 'rotate' | 'scale'>
  features: Record<string, boolean>
}
