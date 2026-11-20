import type {
  UnityEditorEventType,
  UnityEditorMethod,
  UnityEventEnvelope,
  UnityRequestEnvelope,
  UnityResponseEnvelope,
} from '@/unity-runtime/protocol/types'

export interface UnityTransport {
  connect(): Promise<void>
  disconnect(): Promise<void>
  /** 云端在独立输入通道上发送有序确认标记，网页播放器直接使用本地输入循环。 */
  sendTransformInputMarker?(): number
  request<TRequest, TResponse>(
    method: UnityEditorMethod,
    envelope: UnityRequestEnvelope<TRequest>,
  ): Promise<UnityResponseEnvelope<TResponse>>
  notify<TRequest>(method: UnityEditorMethod, envelope: UnityRequestEnvelope<TRequest>): void
  subscribe<TPayload>(
    type: UnityEditorEventType,
    listener: (event: UnityEventEnvelope<TPayload>) => void,
  ): () => void
}
