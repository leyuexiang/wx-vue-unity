import { describe, expect, it, vi } from 'vitest'
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
  constructor() { TestSocket.instances.push(this) }
  send(value: string) { this.sent.push(value) }
  close() { this.readyState = 3; this.onclose?.() }
  open() { this.readyState = 1; this.onopen?.() }
  message(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }) }
}

describe('IoT 状态 WebSocket 客户端', () => {
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
    socket.message({ type: 'iot-state-update', content: JSON.stringify({ subscriptionId: 'sub-1', eventId: 'event-1', schemaVersion: '1.0', eventTime: '2026-11-13T00:00:00Z', tenantId: 2, deviceId: 'device-1', pointCode: 'temperature', value: 31.2, valueType: 'NUMBER' }) })
    expect(received).toHaveLength(1)
    client.dispose()
  })
})
