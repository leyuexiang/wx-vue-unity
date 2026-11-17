import { afterEach, describe, expect, it, vi } from 'vitest'
import { authContext } from '@/auth/authContext'
import { IotStateWebSocketClient } from '../websocket'

class TestSocket {
  static instances: TestSocket[] = []
  static OPEN = 1
  static CLOSED = 3
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  sent: string[] = []
  constructor(readonly url: string) { TestSocket.instances.push(this) }
  send(value: string) { this.sent.push(value) }
  close() { this.readyState = 3; this.onclose?.() }
  open() { this.readyState = 1; this.onopen?.() }
  message(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }) }
}

describe('IoT 状态 WebSocket 客户端', () => {
  afterEach(() => { authContext.clear(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers() })
  it('专用路径可配置并保留发布网关前缀', async () => {
    vi.stubGlobal('WebSocket', TestSocket)
    vi.stubEnv('VITE_IOT_STATE_WEBSOCKET_PATH', '/stream/iot')
    authContext.set({ accessToken: 'test-token', clientId: 'web', tenantId: '2', platformType: 'tenant', roles: [], permissions: [] })
    const client = new IotStateWebSocketClient(() => ({ publicationId: 'PUB-20', publicationTicket: 'test-ticket', apiBaseUrl: 'https://example.invalid/edge' }))
    try {
      const pending = client.subscribe({ subscriptionId: 'custom', deviceId: 'd', pointCode: 'p' }, vi.fn())
      const socket = TestSocket.instances.at(-1)!
      expect(new URL(socket.url).pathname).toBe('/edge/stream/iot')
      socket.open()
      await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
      socket.message({ type: 'iot-state-subscribe-ack', content: JSON.stringify({ requestId: 'request-custom', accepted: ['custom'] }) })
      await pending
    } finally { client.dispose() }
  })
  it('拒绝含查询的路径且不创建连接', async () => {
    vi.stubGlobal('WebSocket', TestSocket)
    vi.stubEnv('VITE_IOT_STATE_WEBSOCKET_PATH', '/stream?token=bad')
    authContext.set({ accessToken: 'test-token', clientId: 'web', tenantId: '2', platformType: 'tenant', roles: [], permissions: [] })
    const before = TestSocket.instances.length
    const client = new IotStateWebSocketClient()
    try {
      await expect(client.subscribe({ subscriptionId: 'bad', deviceId: 'd', pointCode: 'p' }, vi.fn())).rejects.toThrow('路径配置无效')
      expect(TestSocket.instances).toHaveLength(before)
    } finally { client.dispose() }
  })
  it('使用认证令牌订阅并分发状态更新', async () => {
    vi.stubGlobal('WebSocket', TestSocket)
    authContext.set({ accessToken: 'token-1', clientId: 'web', tenantId: '2', platformType: 'tenant', roles: [], permissions: [] })
    const client = new IotStateWebSocketClient()
    const received: unknown[] = []
    const pending = client.subscribe({ subscriptionId: 'sub-1', deviceId: 'device-1', pointCode: 'temperature' }, (update) => received.push(update))
    const socket = TestSocket.instances.at(-1)!
    socket.open()
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
    expect(JSON.parse(socket.sent[0]!).type).toBe('iot-state-subscribe')
    socket.message({ type: 'iot-state-subscribe-ack', content: JSON.stringify({ requestId: 'request-sub-1', accepted: ['sub-1'], rejected: [] }) })
    await pending
    expect(new URL(socket.url).pathname).toBe('/dimensions/ws/iot-state')
    socket.message({ type: 'iot-state-update', content: JSON.stringify({ subscriptionId: 'sub-1', eventId: 'event-1', schemaVersion: '1.0', eventTime: '2026-11-13T00:00:00Z', tenantId: 2, deviceId: 'device-1', pointCode: 'temperature', value: 31.2, valueType: 'NUMBER' }) })
    expect(received).toHaveLength(1)
    client.dispose()
  })

  it('发布订阅在续租时使用最新票据，票据失效时注销旧会话', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', TestSocket)
    authContext.set({ accessToken: 'fake', clientId: 'web', tenantId: '2', platformType: 'tenant', roles: [], permissions: [] })
    const client = new IotStateWebSocketClient()
    let ticket = 'initial-test-ticket'
    const pending = client.subscribe({
      subscriptionId: 'published', objectId: 'model', deviceId: 'd', pointCode: 'p',
      publication: () => ticket ? { publicationId: 'PUB-20', publicationTicket: ticket } : null,
    }, vi.fn())
    const socket = TestSocket.instances.at(-1)!
    socket.open()
    try {
      await vi.advanceTimersByTimeAsync(0)
      const frame = (index: number) => JSON.parse(socket.sent[index]!)
      expect(JSON.parse(frame(0).content)).toEqual({
        requestId: 'request-published', publicationId: 'PUB-20', publicationTicket: ticket,
        bindings: [{ subscriptionId: 'published', objectId: 'model', deviceId: 'd', pointCode: 'p' }],
      })
      socket.message({ type: 'iot-state-subscribe-ack', content: JSON.stringify({ requestId: 'request-published', accepted: ['published'] }) })
      await pending
      ticket = 'replacement-test-ticket'
      await vi.advanceTimersByTimeAsync(30000)
      expect(JSON.parse(frame(1).content).publicationTicket).toBe(ticket)
      ticket = ''
      await vi.advanceTimersByTimeAsync(30000)
      expect(frame(2).type).toBe('iot-state-unsubscribe')
      expect(socket.readyState).toBe(TestSocket.CLOSED)
    } finally {
      client.dispose()
    }
  })
})
