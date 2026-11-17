import { afterEach, describe, expect, it, vi } from 'vitest'
import { WeatherSyncQueue } from '../runtime/WeatherSyncQueue'
import { createDefaultEnviroWeatherConfig } from '@/scene-platform/effects/weather'
import { JsonRpcUnityCloudRuntime } from '../runtime/JsonRpcUnityCloudRuntime'
import { createEmptyScene } from '@/scene-core'
import type { RuntimeWeatherConfig, WeatherState } from '../protocol/weather'
import type { UnityTransport } from '../connection/UnityTransport'
import type { UnityRequestEnvelope, UnityEventEnvelope } from '../protocol/types'
import { createSceneDefinition } from '@/scene-platform'
import { createEnviroWeatherEffect } from '@/scene-platform/effects/weather'
import { UnityEditorSceneRuntime } from '../runtime/UnityEditorSceneRuntime'
import { getPersistableWeatherConfig, getRuntimeEnviroWeatherConfig } from '@/integrations/scene/editorSceneWeatherAdapter'

const state = (revision: number, config: RuntimeWeatherConfig | null): WeatherState => ({ weatherRevision: revision, acceptedRevision: revision, targetState: config, effectiveQuality: 'medium', warnings: [], transitionState: 'settled' })
const tick = async () => { await vi.advanceTimersByTimeAsync(150) }
afterEach(() => vi.useRealTimers())

describe('weather complete snapshot queue', () => {
  it('merges rapid changes across fields and sends the final target after the in-flight apply', async () => {
    vi.useFakeTimers()
    let resolve!: (value: WeatherState) => void
    const send = vi.fn((config, revision) => new Promise<WeatherState>(r => { resolve = r }))
    const q = new WeatherSyncQueue(send); q.resume()
    const first = createDefaultEnviroWeatherConfig(); q.set(first); await tick()
    const next = structuredClone(first); next.overrides.clouds.coveragePercent = 0; q.set(next)
    next.overrides.wind.strengthPercent = 0; next.overrides.fog.enabled = false; q.set(next); q.flush()
    expect(send).toHaveBeenCalledTimes(1)
    resolve(state(1, first)); await tick()
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1]?.[0].overrides).toMatchObject({ clouds: { coveragePercent: 0 }, fog: { enabled: false }, wind: { strengthPercent: 0 } })
    expect(q.pending).toBe(true)
    resolve(state(3, next)); await tick(); expect(q.pending).toBe(false); q.dispose()
  })
  it('isolates late acknowledgements/events after scene reset and cancels unsent work on dispose', async () => {
    vi.useFakeTimers()
    let resolve!: (value: WeatherState) => void
    const send = vi.fn(() => new Promise<WeatherState>(r => { resolve = r }))
    const q = new WeatherSyncQueue(send); q.resume(); q.set(createDefaultEnviroWeatherConfig()); await tick()
    q.suspend(); q.reset(); q.set(null, false); q.acknowledge(0, state(0, null))
    resolve(state(1, createDefaultEnviroWeatherConfig())); await tick()
    expect(q.state?.targetState).toBeNull()
    q.acceptEvent(state(1, createDefaultEnviroWeatherConfig())); expect(q.state?.weatherRevision).toBe(0)
    q.resume(); q.set(createDefaultEnviroWeatherConfig()); q.dispose(); await tick(); expect(send).toHaveBeenCalledTimes(1)
  })
  it('keeps failed desired config and retries explicitly; unchanged reload does not increase revision', async () => {
    vi.useFakeTimers()
    const send = vi.fn().mockRejectedValueOnce(new Error('offline')).mockImplementation(async (config, revision) => state(revision, config))
    const q = new WeatherSyncQueue(send); q.resume(); const config = createDefaultEnviroWeatherConfig(); q.set(config); await tick()
    expect(q.error).toBe('offline'); expect(q.pending).toBe(true); await tick(); expect(send).toHaveBeenCalledTimes(1)
    expect(q.set(structuredClone(config), false)).toBe(1)
    q.retry(); await tick(); expect(q.pending).toBe(false); expect(q.config).toEqual(config); q.dispose()
  })
})

function transport(weather: boolean) {
  const events = new Map<string, (value: UnityEventEnvelope<WeatherState>) => void>()
  const request = vi.fn(async (method: string, envelope: UnityRequestEnvelope<any>) => ({
    protocolVersion: 1, requestId: envelope.requestId, success: true,
    payload: method.endsWith('initialize') ? { protocolVersion: 1, capabilities: { sceneTypes: ['local3d', 'gis'], objectTypes: [], gizmoModes: [], features: { 'weather.enviro3': weather } } }
      : method.endsWith('loadDraft') ? { weatherState: state(envelope.payload.environment?.weatherRevision, envelope.payload.environment?.weather) }
      : method.endsWith('apply') ? state(envelope.payload.weatherRevision, envelope.payload.config) : {},
  }))
  const t = { connect: vi.fn(async () => {}), disconnect: vi.fn(async () => {}), request, notify: vi.fn(), subscribe: vi.fn((key, listener) => { events.set(key, listener); return () => events.delete(key) }) } as unknown as UnityTransport
  return { t, request, events }
}
describe('weather editor.v1 contract', () => {
  it('reconnects a fresh protocol session over the same Web player without quitting it', async () => {
    vi.useFakeTimers(); const { t, request } = transport(true)
    const first = new JsonRpcUnityCloudRuntime(t); await first.connect(); await first.loadScene(createEmptyScene('main'))
    const oldSession = request.mock.calls[0]![1].sessionId
    await first.disconnect({ keepTransport: true })
    expect(t.disconnect).not.toHaveBeenCalled()
    const next = new JsonRpcUnityCloudRuntime(t); await next.connect(); await next.loadScene(createEmptyScene('main'))
    const sessions = request.mock.calls.filter(call => call[0].endsWith('initialize'))
    expect(sessions[1]![1].sessionId).not.toBe(oldSession)
    await next.disconnect()
    expect(t.disconnect).toHaveBeenCalledTimes(1)
  })
  it('retries a timed-out weather request with its original requestId, sequence and complete envelope', async () => {
    vi.useFakeTimers(); const { t, request } = transport(true)
    const originalRequest = t.request
    let failed = false
    t.request = vi.fn(async (method, envelope) => {
      if (method === 'editor.v1.weather.apply' && !failed) { failed = true; await originalRequest(method, envelope); throw new Error('timeout') }
      return originalRequest(method, envelope)
    }) as UnityTransport['request']
    const r = new JsonRpcUnityCloudRuntime(t); await r.connect(); await r.loadScene(createEmptyScene('main'))
    r.weather.set(createDefaultEnviroWeatherConfig()); r.weather.flush(); await tick()
    expect(r.weather.error).toBe('timeout'); const first = request.mock.calls.find(call => call[0] === 'editor.v1.weather.apply')![1]
    r.weather.retry(); await tick()
    const calls = request.mock.calls.filter(call => call[0] === 'editor.v1.weather.apply')
    expect(calls).toHaveLength(2); expect(calls[1]![1]).toEqual(first); expect(r.weather.pending).toBe(false)
    await r.disconnect()
  })
  it('does not resurrect a deleted effect from the persisted settings source snapshot', () => {
    const scene = createSceneDefinition({ id: 'delete', name: 'delete', type: 'local3d', coordinateSystem: { kind: 'local', unit: 'meter', upAxis: 'Y', gridEnabled: true } })
    scene.settings.weather = createDefaultEnviroWeatherConfig()
    expect(getPersistableWeatherConfig(scene)).toEqual({})
    expect(getRuntimeEnviroWeatherConfig(scene)).toBeNull()
  })
  it('reprojects objects with the current effect cache after incremental weather edits', async () => {
    const initial = createDefaultEnviroWeatherConfig()
    const scene = createSceneDefinition({ id: 'main', name: 'main', type: 'local3d', coordinateSystem: { kind: 'local', unit: 'meter', upAxis: 'Y', gridEnabled: true } })
    scene.effects = [createEnviroWeatherEffect(initial)]
    const runtime = new UnityEditorSceneRuntime('local3d', { mode: 'cloud', getHost: () => null, onStatus: vi.fn() })
    const loadScene = vi.fn(async () => {})
    Object.assign(runtime, { unity: { loadScene, describeWeather: vi.fn(), capabilities: { features: { 'weather.enviro3': true } }, weather: { set: vi.fn() } } })
    await runtime.loadScene(scene)
    const next = structuredClone(initial); next.presetId = 'snow'
    await runtime.upsertEffect(createEnviroWeatherEffect(next))
    await runtime.upsertObject({ id: 'box', name: 'box', type: 'primitive', visible: true, locked: false, order: 0, transform: { kind: 'local', position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 }, metadata: { editorGeometryType: 'BoxGeometry' } })
    expect(loadScene).toHaveBeenLastCalledWith(expect.objectContaining({ settings: { weather: next } }))
    runtime.removeEffect('weather-main')
    await runtime.upsertObject({ id: 'second', name: 'second', type: 'primitive', visible: true, locked: false, order: 1, transform: { kind: 'local', position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 }, metadata: { editorGeometryType: 'BoxGeometry' } })
    expect(loadScene).toHaveBeenLastCalledWith(expect.objectContaining({ settings: { weather: null } }))
  })
  it('retains edits received after a scene reprojection was queued', async () => {
    vi.useFakeTimers(); const { t, request } = transport(true); const r = new JsonRpcUnityCloudRuntime(t)
    await r.connect(); const scene = createEmptyScene('main'); const initial = createDefaultEnviroWeatherConfig(); scene.settings.weather = initial; await r.loadScene(scene)
    const reproject = r.loadScene(scene)
    const next = structuredClone(initial); next.presetId = 'rain'; r.weather.set(next)
    await reproject
    expect(request.mock.calls[2]![1].payload.environment.weather.presetId).toBe('rain')
    await r.disconnect()
  })
  it('does not send environment or new methods to a player without negotiated capability', async () => {
    vi.useFakeTimers(); const { t, request } = transport(false); const r = new JsonRpcUnityCloudRuntime(t)
    await r.connect(); const scene = createEmptyScene(); scene.settings.weather = createDefaultEnviroWeatherConfig(); await r.loadScene(scene)
    expect(request.mock.calls[1]?.[1].payload.environment).toBeUndefined()
    expect(await r.describeWeather()).toBeNull(); expect(await r.getWeatherState()).toBeNull(); await tick()
    expect(request.mock.calls.map(call => call[0]).filter(method => method.includes('.weather.'))).toEqual([]); await r.disconnect()
  })
  it('sends explicit weather and revision in draft, gates old session/generation events and releases on clear', async () => {
    vi.useFakeTimers(); const { t, request, events } = transport(true); const r = new JsonRpcUnityCloudRuntime(t)
    await r.connect(); const scene = createEmptyScene('main'); scene.settings.weather = createDefaultEnviroWeatherConfig(); await r.loadScene(scene)
    const load = request.mock.calls[1]![1]
    expect(load.payload.environment).toEqual({ weather: scene.settings.weather, weatherRevision: 1 })
    const notify = events.get('editor.v1.weather.state.changed')!
    notify({ ...load, eventId: 'late', type: 'editor.v1.weather.state.changed', sessionId: 'old', payload: state(1, null) })
    expect(r.weather.state?.targetState).toEqual(scene.settings.weather)
    notify({ ...load, eventId: 'late', type: 'editor.v1.weather.state.changed', sceneGeneration: 0, payload: state(1, null) })
    expect(r.weather.state?.targetState).toEqual(scene.settings.weather)
    await r.loadScene(scene); expect(request.mock.calls[2]![1].payload.environment.weatherRevision).toBe(1)
    await r.clearScene(); expect(r.weather.state).toBeNull(); await r.disconnect()
  })
})
