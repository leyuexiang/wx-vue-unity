import { describe, expect, it, vi } from 'vitest'
import { createDefaultTransform, createEmptyScene } from '@/scene-core'
import type {
  UnityEventEnvelope,
  UnityRuntimeCapabilities,
  UnityTransport,
} from '@/unity-runtime'
import { JsonRpcUnityCloudRuntime, UNITY_EDITOR_PROTOCOL_VERSION } from '@/unity-runtime'

const capabilities: UnityRuntimeCapabilities = {
  sceneTypes: ['local3d'],
  objectTypes: ['model'],
  gizmoModes: ['translate', 'rotate', 'scale'],
  features: {},
}

type EventListener = (event: UnityEventEnvelope<unknown>) => void

type TransportOptions = {
  capabilities?: UnityRuntimeCapabilities
  responseProtocolVersion?: number
  responseRequestId?: string
  initializeSuccess?: boolean
  gizmoSuccess?: boolean
}

const createTransport = (options: TransportOptions = {}) => {
  const subscribers = new Map<string, EventListener>()
  const request = vi.fn(async (method: string, envelope: { requestId: string }) => ({
    protocolVersion: options.responseProtocolVersion ?? UNITY_EDITOR_PROTOCOL_VERSION,
    requestId: options.responseRequestId ?? envelope.requestId,
    success: method === 'editor.v1.session.initialize'
      ? options.initializeSuccess !== false
      : method !== 'editor.v1.gizmo.mode.set' || options.gizmoSuccess !== false,
    payload: method === 'editor.v1.session.initialize'
      ? {
          protocolVersion: UNITY_EDITOR_PROTOCOL_VERSION,
          capabilities: options.capabilities ?? capabilities,
        }
      : {},
    error: options.initializeSuccess === false
      ? { code: 'INITIALIZE_FAILED', message: '初始化失败' }
      : options.gizmoSuccess === false && method === 'editor.v1.gizmo.mode.set'
        ? { code: 'RUNTIME_BUSY', message: 'Runtime 忙碌' }
        : undefined,
  }))
  const transport: UnityTransport = {
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    request: request as UnityTransport['request'],
    notify: vi.fn(),
    subscribe: vi.fn((type, listener) => {
      subscribers.set(type, listener as EventListener)
      return () => subscribers.delete(type)
    }) as UnityTransport['subscribe'],
  }
  return { transport, request, subscribers }
}

const createEvent = (
  request: ReturnType<typeof vi.fn>,
  overrides: Partial<UnityEventEnvelope<{ instanceId: string | null }>> = {},
): UnityEventEnvelope<{ instanceId: string | null }> => {
  const loadEnvelope = request.mock.calls[1]?.[1] as {
    sessionId: string
    sceneId: string
    sceneGeneration: number
  }
  return {
    protocolVersion: UNITY_EDITOR_PROTOCOL_VERSION,
    sessionId: loadEnvelope.sessionId,
    sceneId: loadEnvelope.sceneId,
    sceneGeneration: loadEnvelope.sceneGeneration,
    eventId: 'event-1',
    type: 'editor.v1.selection.changed',
    payload: { instanceId: 'object-1' },
    ...overrides,
  }
}

describe('JsonRpcUnityCloudRuntime', () => {
  it('includes native vegetation in snapshots and explicitly clears it in later scenes', async () => {
    const { transport, request } = createTransport({ capabilities: { ...capabilities, features: { 'vegetation.instanced': true } } })
    const runtime = new JsonRpcUnityCloudRuntime(transport)
    await runtime.connect()
    const scene = createEmptyScene('forest')
    const definition = { enabled: true, ruleSetId: 'forest' }
    scene.settings.vegetation = definition
    await runtime.loadScene(scene)
    expect(request).toHaveBeenLastCalledWith('editor.v1.scene.loadDraft', expect.objectContaining({ payload: expect.objectContaining({ vegetation: definition }) }))
    await runtime.loadScene(createEmptyScene('empty'))
    expect(request).toHaveBeenLastCalledWith('editor.v1.scene.loadDraft', expect.objectContaining({ payload: expect.objectContaining({ vegetation: null }) }))
    await runtime.controlVegetation({ action: 'get' })
    expect(request).toHaveBeenLastCalledWith('editor.v1.vegetation.control', expect.objectContaining({ sceneId: 'empty', sceneGeneration: 2, payload: { action: 'get' } }))
  })

  it('keeps old players compatible and explains why native vegetation controls need an update', async () => {
    const { transport, request } = createTransport()
    const runtime = new JsonRpcUnityCloudRuntime(transport)
    await runtime.connect()
    const scene = createEmptyScene('legacy')
    scene.settings.vegetation = { enabled: true }
    await runtime.loadScene(scene)
    const payload = (request.mock.calls.at(-1)?.[1] as unknown as { payload: Record<string, unknown> }).payload
    expect(payload).not.toHaveProperty('vegetation')
    await expect(runtime.controlVegetation({ action: 'get' })).rejects.toThrow('播放器需要更新')
    expect(request).not.toHaveBeenCalledWith('editor.v1.vegetation.control', expect.anything())
  })

  it('can apply camera settings while a live camera read is awaiting its response', async () => {
    const { transport, request } = createTransport({ capabilities: { ...capabilities, features: { 'camera.control': true } } })
    const runtime = new JsonRpcUnityCloudRuntime(transport)
    await runtime.connect()
    await runtime.loadScene(createEmptyScene('camera'))
    const reply = request.getMockImplementation()!
    let finishRead!: () => void
    const readGate = new Promise<void>(resolve => { finishRead = resolve })
    request.mockImplementationOnce(async (...args) => {
      await readGate
      return reply(...args)
    })

    const read = runtime.controlCamera({ action: 'get' })
    await Promise.resolve()
    const edit = runtime.controlCamera({ action: 'apply', config: { fov: 45 } })
    try {
      await vi.waitFor(() => expect(request).toHaveBeenLastCalledWith('editor.v1.camera.control', expect.objectContaining({
        payload: { action: 'apply', config: { fov: 45 } },
      })))
    } finally {
      finishRead()
      await Promise.all([read, edit])
    }
  })

  it('sends geographic origins and layers to a GIS-capable player', async () => {
    const { transport, request } = createTransport({ capabilities: { ...capabilities, sceneTypes: ['local3d', 'gis'] } })
    const runtime = new JsonRpcUnityCloudRuntime(transport)
    await runtime.connect()
    const scene = createEmptyScene('geo')
    scene.type = 'gis'
    scene.geospatial = { origin: [110, 19, 0], terrainEnabled: false, layers: [] }
    await runtime.loadScene(scene)
    expect(request).toHaveBeenLastCalledWith('editor.v1.scene.loadDraft', expect.objectContaining({
      payload: expect.objectContaining({ sceneType: 'gis', geospatial: scene.geospatial }),
    }))
  })

  it('rejects a GIS scene before sending it to an older local-only player', async () => {
    const { transport, request } = createTransport()
    const runtime = new JsonRpcUnityCloudRuntime(transport)
    await runtime.connect()
    const scene = createEmptyScene('geo')
    scene.type = 'gis'
    await expect(runtime.loadScene(scene)).rejects.toThrow('请更新对应端的播放器')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('negotiates capabilities and sends a versioned scene load', async () => {
    const { transport, request } = createTransport()
    const runtime = new JsonRpcUnityCloudRuntime(transport)
    await runtime.connect()
    await runtime.loadScene(createEmptyScene('scene-1'))
    expect(runtime.capabilities?.sceneTypes).toEqual(['local3d'])
    expect(request).toHaveBeenNthCalledWith(
      2,
      'editor.v1.scene.loadDraft',
      expect.objectContaining({
        protocolVersion: UNITY_EDITOR_PROTOCOL_VERSION,
        sceneId: 'scene-1',
        sceneGeneration: 1,
        payload: {
          sceneId: 'scene-1',
          revisionNo: 0,
          sceneType: 'local3d',
          objects: [],
          resources: [],
        },
      }),
    )
  })

  it('sends supported gizmo modes to Unity and keeps select mode local', async () => {
    const { transport, request } = createTransport()
    const runtime = new JsonRpcUnityCloudRuntime(transport)
    await runtime.connect()

    await runtime.setGizmoMode('select')
    expect(request).toHaveBeenCalledOnce()

    await runtime.setGizmoMode('rotate')
    expect(request).toHaveBeenNthCalledWith(
      2,
      'editor.v1.gizmo.mode.set',
      expect.objectContaining({ payload: { mode: 'rotate' } }),
    )

    await runtime.setGizmoMode('scale')
    expect(request).toHaveBeenNthCalledWith(
      3,
      'editor.v1.gizmo.mode.set',
      expect.objectContaining({ payload: { mode: 'scale' } }),
    )
  })

  it('rejects gizmo modes that Unity did not advertise', async () => {
    const { transport, request } = createTransport()
    const runtime = new JsonRpcUnityCloudRuntime(transport)
    await runtime.connect()
    runtime.capabilities = { ...capabilities, gizmoModes: ['translate'] }

    await expect(runtime.setGizmoMode('rotate')).rejects.toThrow('不支持 Gizmo 模式')
    expect(request).toHaveBeenCalledOnce()
  })

  it('reports Unity failures when changing gizmo mode', async () => {
    const { transport } = createTransport({ gizmoSuccess: false })
    const runtime = new JsonRpcUnityCloudRuntime(transport)
    await runtime.connect()
    await expect(runtime.setGizmoMode('translate')).rejects.toThrow('Runtime 忙碌')
  })

  it('loads and clears the current Unity scene without changing the web scene store', async () => {
    const { transport, request } = createTransport()
    const runtime = new JsonRpcUnityCloudRuntime(transport)
    await runtime.connect()
    await runtime.loadScene(createEmptyScene('scene-1'))
    await runtime.clearScene()
    expect(request).toHaveBeenNthCalledWith(3, 'editor.v1.scene.clear', expect.objectContaining({
      sceneId: 'scene-1',
      sceneGeneration: 2,
      payload: {},
    }))
  })

  it('sends selection and object transform edits against the current scene generation', async () => {
    const { transport, request } = createTransport()
    const runtime = new JsonRpcUnityCloudRuntime(transport)
    const scene = createEmptyScene('scene-1')
    const object = {
      instanceId: 'object-1',
      objectType: 'primitive' as const,
      name: '演示立方体',
      visible: true,
      locked: false,
      transform: createDefaultTransform(),
      resourceRefKeys: [],
      properties: { primitiveType: 'cube' },
    }
    scene.objects.push(object)

    await runtime.connect()
    await runtime.loadScene(scene)
    runtime.setSelection(object.instanceId)
    await runtime.updateObject({ ...object, transform: { ...object.transform, position: [1, 2, 3] } })

    expect(transport.notify).toHaveBeenCalledWith('editor.v1.selection.set', expect.objectContaining({
      sceneId: 'scene-1',
      sceneGeneration: 1,
      payload: { instanceId: 'object-1' },
    }))
    expect(request).toHaveBeenNthCalledWith(3, 'editor.v1.object.update', expect.objectContaining({
      sceneId: 'scene-1',
      sceneGeneration: 1,
      payload: expect.objectContaining({ instanceId: 'object-1', transform: expect.objectContaining({ position: [1, 2, 3] }) }),
    }))
  })

  it('disconnects and removes event subscriptions when initialization fails', async () => {
    const { transport, subscribers } = createTransport({ initializeSuccess: false })
    const runtime = new JsonRpcUnityCloudRuntime(transport)
    await expect(runtime.connect()).rejects.toThrow('初始化失败')
    expect(transport.disconnect).toHaveBeenCalledOnce()
    expect(subscribers.size).toBe(0)
    expect(runtime.capabilities).toBeNull()
  })

  it('rejects mismatched response protocol versions and request ids', async () => {
    const wrongVersion = createTransport({ responseProtocolVersion: 2 })
    await expect(new JsonRpcUnityCloudRuntime(wrongVersion.transport).connect())
      .rejects.toThrow('响应协议版本不兼容')

    const wrongRequest = createTransport({ responseRequestId: 'wrong-request' })
    await expect(new JsonRpcUnityCloudRuntime(wrongRequest.transport).connect())
      .rejects.toThrow('requestId')
  })

  it('accepts only current protocol, session and scene generation events', async () => {
    const { transport, request, subscribers } = createTransport()
    const runtime = new JsonRpcUnityCloudRuntime(transport)
    const listener = vi.fn()
    runtime.on('selectionChanged', listener)
    await runtime.connect()
    await runtime.loadScene(createEmptyScene('scene-1'))

    const selectionListener = subscribers.get('editor.v1.selection.changed')
    expect(selectionListener).toBeDefined()
    selectionListener?.(createEvent(request))
    selectionListener?.(createEvent(request, { protocolVersion: 2 }))
    selectionListener?.(createEvent(request, { sceneGeneration: 0 }))
    selectionListener?.(createEvent(request, { sessionId: 'stale-session' }))

    expect(listener).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledWith({ instanceId: 'object-1' })
  })

  it('routes only current-session Unity preview clicks to the object interaction event', async () => {
    const { transport, request, subscribers } = createTransport()
    const runtime = new JsonRpcUnityCloudRuntime(transport)
    const listener = vi.fn()
    runtime.on('objectInteraction', listener)
    await runtime.connect()
    await runtime.loadScene(createEmptyScene('scene-1'))

    const clickListener = subscribers.get('editor.v1.object.interaction')
    expect(clickListener).toBeDefined()
    const current = createEvent(request)
    clickListener?.({ ...current, type: 'editor.v1.object.interaction', payload: { instanceId: 'object-1', eventType: 'click' } })
    clickListener?.({ ...current, type: 'editor.v1.object.interaction', sceneGeneration: 0, payload: { instanceId: 'object-1', eventType: 'click' } })

    expect(listener).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledWith({ instanceId: 'object-1', eventType: 'click' })
  })

  it('sends edit and preview mode changes through the negotiated Unity command channel', async () => {
    const { transport, request } = createTransport()
    const runtime = new JsonRpcUnityCloudRuntime(transport)
    await runtime.connect()
    await runtime.loadScene(createEmptyScene('scene-1'))
    await runtime.setMode('preview')

    expect(request).toHaveBeenLastCalledWith('editor.v1.runtime.mode.set', expect.objectContaining({
      sceneId: 'scene-1',
      sceneGeneration: 1,
      payload: { mode: 'preview' },
    }))
  })
})
