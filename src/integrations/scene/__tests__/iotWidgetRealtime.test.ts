import { afterEach, expect, it, vi } from 'vitest'
import { createEmptyDataConfig } from '@/types/data-config'
import type { WidgetConfig } from '@/stores/sceneEditStore'
import { getIotState } from '@/servers/manual/iot/api'
import { SceneDataPollingRuntime } from '../widgetRuntime/sceneDataPollingRuntime'

const state = vi.hoisted(() => ({ widgets: [] as WidgetConfig[], handlers: new Map<string, (data: any) => void>(), reconnect: new Map<string, () => void>(), unsubscribe: vi.fn(), subscribe: vi.fn() }))
vi.mock('@/stores/sceneEditStore', () => ({ useSceneWidgetStore: () => ({ totalWidgets: state.widgets, bumpWidgetRenderVersion: vi.fn() }) }))
vi.mock('@/servers/manual/iot/api', () => ({ getIotState: vi.fn() }))
vi.mock('@/servers/manual/iot/websocket', () => ({ createIotStateWebSocketClient: () => ({
  subscribe: state.subscribe.mockImplementation(async (request, handler, reconnect) => {
    state.handlers.set(request.subscriptionId, handler)
    state.reconnect.set(request.subscriptionId, reconnect)
    return state.unsubscribe
  }), dispose: vi.fn(),
}) }))

const snapshot = (value: number) => ({ eventId: 'e1', schemaVersion: '1.0', eventTime: '2026-11-17T00:00:00Z', tenantId: 2, deviceId: 'd1', pointCode: 'temperature', value, valueType: 'NUMBER' })
afterEach(() => { state.widgets = []; state.handlers.clear(); state.reconnect.clear(); state.subscribe.mockClear(); state.unsubscribe.mockClear(); vi.mocked(getIotState).mockReset(); vi.useRealTimers() })

it.each(['draft', 'published', 'anonymous'] as const)('二维实时请求按域授权、版本合并、重连补偿并隔离销毁 (%s)', async (mode) => {
  const config = createEmptyDataConfig()
  config.request = { type: 'adapter', config: { adapterId: 'iot-state', config: { deviceId: 'd1', pointCode: 'temperature', delivery: 'websocket', pollIntervalSeconds: 1 } } }
  config.requests![0]!.bindings = [{ kind: 'widget', sourceField: 'value', targetPath: 'value', valueType: 'number' }]
  const widget = { id: 'number', component: { info: { packageName: 'Widget', keyName: 'VNumber' }, option: { value: 0 }, dataConfig: config } } as unknown as WidgetConfig
  state.widgets = [widget]
  vi.mocked(getIotState).mockResolvedValue(snapshot(26.125))
  const runtime = new SceneDataPollingRuntime({ getPublicRequests: () => [], getRequestGlobalConfig: () => ({ requestOriginUrl: '', requestInterval: null, requestIntervalUnit: 'second', requestParams: { Header: {} } }), getRuntimeContext: () => ({ sceneId: '42', publicPreview: mode !== 'draft' }), ...(mode === 'published' ? { getIotPublicationAccess: () => ({ publicationId: 'PUB-10', publicationTicket: 'test-ticket' }) } : {}) })
  try {
    await runtime.start()
    if (mode === 'anonymous') { expect(state.subscribe).not.toHaveBeenCalled(); expect(getIotState).not.toHaveBeenCalled(); return }
    expect(state.subscribe).toHaveBeenCalledTimes(1)
    const request = state.subscribe.mock.calls[0]![0]
    expect(request).toMatchObject({ domain: 'twoD', objectId: 'number', deviceId: 'd1', pointCode: 'temperature' })
    expect(getIotState).toHaveBeenCalledWith('d1', 'temperature', mode === 'published' ? { publicationId: 'PUB-10', publicationTicket: 'test-ticket', domain: 'twoD', objectId: 'number' } : { sceneId: '42', domain: 'twoD', objectId: 'number' })
    expect(widget.component.option.value).toBe(26.125)
    const update = state.handlers.get(request.subscriptionId)!
    update({ ...snapshot(29.5), stateVersion: '002' })
    update({ ...snapshot(12), stateVersion: '001' })
    expect(widget.component.option.value).toBe(29.5)
    await runtime.start()
    expect(state.subscribe).toHaveBeenCalledTimes(1)
    vi.mocked(getIotState).mockResolvedValue(snapshot(31.125))
    state.reconnect.get(request.subscriptionId)!()
    await vi.waitFor(() => expect(widget.component.option.value).toBe(31.125))
    runtime.dispose()
    update({ ...snapshot(99), stateVersion: '003' })
    expect(widget.component.option.value).toBe(31.125)
    expect(state.unsubscribe).toHaveBeenCalledTimes(1)
  } finally { runtime.dispose() }
})

it('多请求独立映射，修改一个请求只替换自身订阅，删除组件后拒绝迟到更新', async () => {
  const config = createEmptyDataConfig()
  const first = config.requests![0]!
  first.request = { type: 'adapter', config: { adapterId: 'iot-state', config: { deviceId: 'd1', pointCode: 'temperature', delivery: 'websocket' } } }
  first.bindings = [{ kind: 'widget', targetPath: 'value', sourceField: 'value', valueType: 'number' }]
  config.requests!.push({ ...first, id: 'request-2', dataset: { dimensions: [], source: [] }, request: { type: 'adapter', config: { adapterId: 'iot-state', config: { deviceId: 'd2', pointCode: 'temperature', delivery: 'websocket' } } }, bindings: [{ kind: 'widget', targetPath: 'suffixText', sourceField: 'value', valueType: 'string' }] })
  const widget = { id: 'two-requests', component: { info: { packageName: 'Widget', keyName: 'VNumber' }, option: { value: 0, suffixText: '' }, dataConfig: config } } as unknown as WidgetConfig
  state.widgets = [widget]
  vi.mocked(getIotState).mockImplementation(async deviceId => ({ ...snapshot(deviceId === 'd1' ? 26.125 : 7), deviceId }))
  const runtime = new SceneDataPollingRuntime({ getPublicRequests: () => [], getRequestGlobalConfig: () => ({ requestOriginUrl: '', requestInterval: null, requestIntervalUnit: 'second', requestParams: { Header: {} } }), getRuntimeContext: () => ({ sceneId: '42' }) })
  try {
    await runtime.start()
    expect(state.subscribe).toHaveBeenCalledTimes(2)
    const oldFirst = state.subscribe.mock.calls[0]![0]
    const second = state.subscribe.mock.calls[1]![0]
    state.handlers.get(second.subscriptionId)!({ ...snapshot(9), deviceId: 'd2', stateVersion: '001' })
    expect(widget.component.option).toMatchObject({ value: 26.125, suffixText: 9 })
    widget.component.dataConfig!.requests![0]!.request = { type: 'adapter', config: { adapterId: 'iot-state', config: { deviceId: 'd3', pointCode: 'temperature', delivery: 'websocket' } } }
    await runtime.start()
    expect(state.subscribe).toHaveBeenCalledTimes(3)
    expect(state.unsubscribe).toHaveBeenCalledTimes(1)
    state.handlers.get(oldFirst.subscriptionId)!({ ...snapshot(99), stateVersion: '999' })
    expect(widget.component.option.value).toBe(7)
    expect(widget.component.option.suffixText).toBe(9)
    state.widgets = []
    await runtime.start()
    state.handlers.get(second.subscriptionId)!({ ...snapshot(999), stateVersion: '999' })
    expect(widget.component.option.suffixText).toBe(9)
    expect(state.unsubscribe).toHaveBeenCalledTimes(3)
  } finally { runtime.dispose() }
})

it('配置保存前订阅被拒绝时退避重订阅，确认后才查询快照，销毁后停止重试', async () => {
  vi.useFakeTimers()
  const config = createEmptyDataConfig()
  config.request = { type: 'adapter', config: { adapterId: 'iot-state', config: { deviceId: 'd1', pointCode: 'temperature', delivery: 'websocket' } } }
  config.requests![0]!.bindings = [{ kind: 'widget', targetPath: 'value', sourceField: 'value', valueType: 'number' }]
  const widget = { id: 'saving-widget', component: { info: { packageName: 'Widget', keyName: 'VNumber' }, option: { value: 0 }, dataConfig: config } } as unknown as WidgetConfig
  state.widgets = [widget]
  state.subscribe.mockRejectedValueOnce(new Error('当前保存修订未配置此点位'))
  vi.mocked(getIotState).mockResolvedValue(snapshot(29.5))
  const runtime = new SceneDataPollingRuntime({ getPublicRequests: () => [], getRequestGlobalConfig: () => ({ requestOriginUrl: '', requestInterval: null, requestIntervalUnit: 'second', requestParams: { Header: {} } }), getRuntimeContext: () => ({ sceneId: '42' }) })
  try {
    await runtime.start()
    expect(getIotState).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(state.subscribe).toHaveBeenCalledTimes(2)
    expect(widget.component.option.value).toBe(29.5)
    expect(getIotState).toHaveBeenCalledTimes(1)
    runtime.dispose()
    await vi.advanceTimersByTimeAsync(60000)
    expect(state.subscribe).toHaveBeenCalledTimes(2)
    expect(getIotState).toHaveBeenCalledTimes(1)
  } finally { runtime.dispose() }
})
