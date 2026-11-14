import { authContext } from '@/auth/authContext'
import { DIM3D_SERVER_URL } from '@/servers/manual/dim3d/api/constants'
import type { IotStateSnapshot } from './api'

export interface IotStateSubscription {
  subscriptionId: string
  sceneId?: string
  objectId?: string
  deviceId: string
  pointCode: string
}

export interface IotStateUpdate extends IotStateSnapshot {
  subscriptionId: string
  sceneId?: string
  objectId?: string
  stateVersion?: string
}

type UpdateHandler = (update: IotStateUpdate) => void
type PendingRequest = {
  resolve: () => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const toWebSocketUrl = (token: string, tenantId?: string) => {
  // 无浏览器 location 时（例如单元测试或 SSR）仍使用可解析的占位根地址；
  // 真实部署优先沿用环境配置，其次使用当前页面同源地址。
  const base = DIM3D_SERVER_URL || globalThis.location?.origin || 'http://localhost'
  const url = new URL(base, globalThis.location?.href || 'http://localhost')
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = `${url.pathname.replace(/\/$/, '')}/dimensions/ws`
  url.search = ''
  url.searchParams.set('token', token)
  if (tenantId) url.searchParams.set('tenant-id', tenantId)
  return url.toString()
}

/** 复用三维服务现有认证 WebSocket，管理 IoT 状态订阅和断线重连。 */
export class IotStateWebSocketClient {
  private socket: WebSocket | null = null
  private opening: Promise<void> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private renewalTimer: ReturnType<typeof setInterval> | null = null
  private reconnectAttempt = 0
  private disposed = false
  private readonly subscriptions = new Map<string, {
    request: IotStateSubscription; handler: UpdateHandler; onReconnect?: () => void
  }>()
  private readonly pendingRequests = new Map<string, PendingRequest>()

  async subscribe(request: IotStateSubscription, handler: UpdateHandler, onReconnect?: () => void): Promise<() => void> {
    this.disposed = false
    this.subscriptions.set(request.subscriptionId, { request, handler, onReconnect })
    try {
      await this.ensureConnected()
    } catch (error) {
      this.subscriptions.delete(request.subscriptionId)
      throw error
    }
    const requestId = `request-${request.subscriptionId}`
    const acknowledged = new Promise<void>((resolve, reject) => {
      const timer = globalThis.setTimeout(() => {
        this.pendingRequests.delete(requestId)
        reject(new Error('物联网 WebSocket 订阅确认超时'))
      }, 3000)
      this.pendingRequests.set(requestId, {
        resolve,
        reject,
        timer,
      })
    })
    this.send('iot-state-subscribe', {
      requestId,
      sceneId: request.sceneId,
      bindings: [request],
    })
    await acknowledged.catch((error) => {
      this.subscriptions.delete(request.subscriptionId)
      throw error
    })
    this.ensureRenewal()
    return () => this.unsubscribe(request.subscriptionId)
  }

  dispose(): void {
    this.disposed = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    if (this.renewalTimer) clearInterval(this.renewalTimer)
    this.renewalTimer = null
    this.subscriptions.clear()
    this.pendingRequests.forEach(({ timer, reject }) => {
      globalThis.clearTimeout(timer)
      reject(new Error('物联网 WebSocket 客户端已释放'))
    })
    this.pendingRequests.clear()
    this.socket?.close()
    this.socket = null
    this.opening = null
  }

  private async ensureConnected(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return
    if (this.opening) return this.opening
    const identity = authContext.get()
    if (!identity?.accessToken) throw new Error('物联网实时订阅需要登录')
    this.opening = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(toWebSocketUrl(identity.accessToken, identity.tenantId))
      this.socket = socket
      const timeout = globalThis.setTimeout(() => {
        socket.close()
        reject(new Error('物联网 WebSocket 连接超时'))
      }, 5000)
      socket.onopen = () => {
        globalThis.clearTimeout(timeout)
        this.reconnectAttempt = 0
        resolve()
      }
      socket.onmessage = (event) => this.handleMessage(String(event.data))
      socket.onerror = () => {
        globalThis.clearTimeout(timeout)
        reject(new Error('物联网 WebSocket 连接失败'))
      }
      socket.onclose = () => {
        globalThis.clearTimeout(timeout)
        reject(new Error('物联网 WebSocket 连接已断开'))
        if (this.socket !== socket) return
        this.pendingRequests.forEach(({ timer, reject }) => {
          globalThis.clearTimeout(timer)
          reject(new Error('物联网 WebSocket 连接已断开'))
        })
        this.pendingRequests.clear()
        if (this.socket === socket) this.socket = null
        this.opening = null
        if (!this.disposed && this.subscriptions.size) this.scheduleReconnect()
      }
    }).finally(() => {
      this.opening = null
    })
    return this.opening
  }

  private scheduleReconnect() {
    if (this.reconnectTimer || this.disposed) return
    const delay = Math.min(30000, 1000 * 2 ** this.reconnectAttempt++)
    this.reconnectTimer = globalThis.setTimeout(() => {
      this.reconnectTimer = null
      void this.ensureConnected()
        .then(() => this.subscriptions.forEach(({ request }) => this.send('iot-state-subscribe', {
          requestId: `reconnect-${request.subscriptionId}`,
          sceneId: request.sceneId,
          bindings: [request],
        })))
        .catch(() => this.scheduleReconnect())
    }, delay)
  }

  private unsubscribe(subscriptionId: string) {
    const current = this.subscriptions.get(subscriptionId)
    if (!current) return
    this.subscriptions.delete(subscriptionId)
    this.send('iot-state-unsubscribe', { subscriptionIds: [subscriptionId] })
    if (!this.subscriptions.size) this.dispose()
  }

  /** 订阅租约默认九十秒，客户端每三十秒重发订阅帧完成续期。 */
  private ensureRenewal() {
    if (this.renewalTimer || !this.subscriptions.size) return
    this.renewalTimer = setInterval(() => {
      this.subscriptions.forEach(({ request }) => {
        this.send('iot-state-subscribe', {
          requestId: `request-${request.subscriptionId}`,
          sceneId: request.sceneId,
          bindings: [request],
        })
      })
    }, 30000)
  }

  private send(type: string, content: unknown) {
    if (this.socket?.readyState !== WebSocket.OPEN) return
    this.socket.send(JSON.stringify({ type, content: JSON.stringify(content) }))
  }

  private handleMessage(raw: string) {
    if (raw === 'ping') {
      this.socket?.send('pong')
      return
    }
    let frame: { type?: string; content?: string }
    try {
      frame = JSON.parse(raw) as { type?: string; content?: string }
    } catch {
      return
    }
    if (!frame.content) return
    if (frame.type === 'iot-state-subscribe-ack' || frame.type === 'iot-state-subscribe-error') {
      let response: { requestId?: string; accepted?: string[]; rejected?: unknown[]; message?: string }
      try {
        response = JSON.parse(frame.content) as typeof response
      } catch {
        return
      }
      if (!response.requestId) return
      const pending = this.pendingRequests.get(response.requestId)
      if (!pending) {
        // 重连和续租都走订阅确认，只有服务端接受的会话才读取补偿快照。
        if (frame.type === 'iot-state-subscribe-ack' && response.requestId.startsWith('reconnect-')) {
          const id = response.requestId.slice('reconnect-'.length)
          if (response.accepted?.includes(id)) this.subscriptions.get(id)?.onReconnect?.()
        }
        return
      }
      this.pendingRequests.delete(response.requestId)
      globalThis.clearTimeout(pending.timer)
      if (frame.type === 'iot-state-subscribe-ack' && (response.accepted ?? []).length > 0) {
        pending.resolve()
      } else {
        pending.reject(new Error(response.message || '物联网 WebSocket 订阅被拒绝'))
      }
      return
    }
    if (frame.type !== 'iot-state-update') return
    let update: IotStateUpdate
    try {
      update = JSON.parse(frame.content) as IotStateUpdate
    } catch {
      return
    }
    this.subscriptions.get(update.subscriptionId)?.handler(update)
  }
}

export const createIotStateWebSocketClient = () => new IotStateWebSocketClient()
