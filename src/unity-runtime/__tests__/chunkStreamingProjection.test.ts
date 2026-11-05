import { describe, expect, it, vi } from 'vitest'
import { createSceneDefinition } from '@/scene-platform'
import { createEmptyScene } from '@/scene-core'
import { projectSceneForUnity } from '../runtime/projectSceneForUnity'
import { JsonRpcUnityCloudRuntime } from '../runtime/JsonRpcUnityCloudRuntime'
import type { UnityTransport } from '../connection/UnityTransport'

describe('Unity草稿分块策略', () => {
  it('保留显式关闭和原区块定义，投影不修改源场景', () => {
    const scene = createSceneDefinition({ id: 'stream', name: '分块策略', type: 'local3d',
      coordinateSystem: { kind: 'local', unit: 'meter', upAxis: 'Y', gridEnabled: true } })
    scene.streaming = { groups: [], chunks: [], options: { enabled: false, maxLoadingJobs: 2, unloadDelayMs: 5000 } }
    const before = JSON.stringify(scene)
    expect(projectSceneForUnity(scene).streaming).toEqual(scene.streaming)
    expect(JSON.stringify(scene)).toBe(before)
  })

  it('按编辑器上下文复用已有覆盖规则', () => {
    const scene = createSceneDefinition({ id: 'stream', name: '分块策略', type: 'local3d',
      coordinateSystem: { kind: 'local', unit: 'meter', upAxis: 'Y', gridEnabled: true } })
    scene.streaming = { groups: [], chunks: [], options: { enabled: true, maxLoadingJobs: 4 },
      runtimeOverrides: { editor: { maxLoadingJobs: 1 }, preview: { maxLoadingJobs: 2 } } }
    expect(projectSceneForUnity(scene).streaming?.options?.maxLoadingJobs).toBe(1)
    expect(scene.streaming.options?.maxLoadingJobs).toBe(4)
  })

  it('经真实协议组装发送策略，不能停留在前端对象', async () => {
    const request = vi.fn(async (method: string, envelope: { requestId: string }) => ({
      protocolVersion: 1, requestId: envelope.requestId, success: true,
      payload: method === 'editor.v1.session.initialize' ? { protocolVersion: 1,
        capabilities: { sceneTypes: ['local3d'], objectTypes: ['model'], gizmoModes: [], features: {} } } : {},
    }))
    const transport = { connect: vi.fn(async () => {}), disconnect: vi.fn(async () => {}),
      request, notify: vi.fn(), subscribe: vi.fn(() => () => {}) } as unknown as UnityTransport
    const runtime = new JsonRpcUnityCloudRuntime(transport)
    await runtime.connect()
    const scene = createEmptyScene('stream')
    scene.streaming = { groups: [], chunks: [], options: { enabled: false } }
    await runtime.loadScene(scene)
    expect(request).toHaveBeenLastCalledWith('editor.v1.scene.loadDraft', expect.objectContaining({
      payload: expect.objectContaining({ streaming: scene.streaming }),
    }))
    await runtime.disconnect()
  })
})
