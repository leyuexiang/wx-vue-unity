import { BusinessPacketDecoder } from './BusinessPacketDecoder'
import { inputDescriptors, wrapInput } from './LegacyInputEncoder'
import { CloudInputSender } from './CloudInputSender'
import { CloudStreamStats, type CloudStreamPerformance } from './cloudStreamStats'
import type { UnityEditorEventType, UnityEditorMethod, UnityEventEnvelope, UnityRequestEnvelope, UnityResponseEnvelope } from '@/unity-runtime/protocol/types'
import type { UnityTransport } from './UnityTransport'
import { decodeUnityRpcResponse } from './decodeUnityRpcResponse'

export type RenderConnectionState = 'connecting' | 'waiting-renderer' | 'negotiating' | 'connected' | 'reconnecting' | 'failed' | 'closed'
export interface LegacySessionConfig {
  signalUrl: string
  appId: string
  sceneKey: string
  macAddress?: string
  connectionId?: string
  type?: 'u3d'
  iceServers?: RTCIceServer[]
  timeoutMs?: number
}
export interface LegacyConnectionSnapshot {
  state: RenderConnectionState
  message: string
  connectionId: string
  videoReady: boolean
  inputReady: boolean
  rpcReady: boolean
  runtimeReady: boolean
  peerState: RTCPeerConnectionState | 'new'
  performance?: CloudStreamPerformance
}
type LegacySignal = { type?: string; name?: string; code?: string; data?: Record<string, unknown>; message?: string; from?: string; connectionId?: string; candidate?: string; sdpMLineIndex?: number; sdpMid?: string }
type SnapshotListener = (snapshot: LegacyConnectionSnapshot) => void

const createId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {}

/** 将 Unity 主动事件还原为带会话和场景代次的统一事件信封。 */
export const parseUnityRuntimeEvent = (method: string, value: Record<string, unknown>): UnityEventEnvelope<unknown> | null => {
  if (!method.startsWith('editor.v1.')) return null
  const params = asRecord(value.params)
  const envelope = asRecord(params.envelope ?? params)
  return {
    protocolVersion: Number(envelope.protocolVersion ?? 1),
    sessionId: String(envelope.sessionId ?? ''),
    sceneId: String(envelope.sceneId ?? ''),
    sceneGeneration: Number(envelope.sceneGeneration ?? 0),
    eventId: String(envelope.eventId ?? createId()),
    type: method as UnityEditorEventType,
    payload: envelope.payload ?? params.payload ?? params,
  }
}

export class LegacyUnityTransport implements UnityTransport {
  private socket: WebSocket | null = null
  private peer: RTCPeerConnection | null = null
  private inputChannel: RTCDataChannel | null = null
  private rpcChannel: RTCDataChannel | null = null
  private transformInputMarker = 0
  private stream = new MediaStream()
  private readonly decoder = new BusinessPacketDecoder()
  private readonly inputSender = new CloudInputSender(() => this.inputChannel)
  private readonly streamStats = new CloudStreamStats()
  private statsTimer: number | null = null
  private statsPoll = 0
  private readonly pending = new Map<string, { resolve: (response: UnityResponseEnvelope<unknown>) => void; reject: (error: Error) => void; timer: number; generation: number }>()
  private readonly subscribers = new Map<string, Set<(event: UnityEventEnvelope<unknown>) => void>>()
  private readonly snapshotListeners = new Set<SnapshotListener>()
  private readonly connectionId: string
  private snapshot: LegacyConnectionSnapshot = { state: 'connecting', message: '正在连接信令…', connectionId: '', videoReady: false, inputReady: false, rpcReady: false, runtimeReady: false, peerState: 'new' }
  private startPromise: Promise<void> | null = null
  private stopped = false
  private registered = false
  private rendererMac = ''
  private disconnectTimer = 0
  private connectionTimer = 0
  private pendingCandidates: RTCIceCandidateInit[] = []
  private descriptionQueue = Promise.resolve()
  private cancelConnect: (() => void) | null = null
  private connectionGeneration = 0
  private activeGeneration = 0
  private teardownPromise: Promise<void> | null = null
  private disconnectAckResolver: (() => void) | null = null

  constructor(private readonly config: LegacySessionConfig, private readonly video: HTMLVideoElement) {
    this.connectionId = config.connectionId?.trim() || createId()
    this.snapshot = { ...this.snapshot, connectionId: this.connectionId }
  }

  private isCurrent(generation: number): boolean {
    return !this.stopped && generation === this.activeGeneration
  }

  private waitForSocketClose(socket: WebSocket | null, timeoutMs = 1200): Promise<void> {
    if (!socket || socket.readyState === WebSocket.CLOSED) return Promise.resolve()
    return new Promise((resolve) => {
      let settled = false
      const finish = () => { if (settled) return; settled = true; window.clearTimeout(timer); resolve() }
      const timer = window.setTimeout(finish, timeoutMs)
      socket.addEventListener('close', finish, { once: true })
    })
  }

  private waitForPeerClose(peer: RTCPeerConnection | null, timeoutMs = 500): Promise<void> {
    if (!peer || peer.connectionState === 'closed') return Promise.resolve()
    return new Promise((resolve) => {
      let settled = false
      const finish = () => { if (settled) return; settled = true; window.clearTimeout(timer); resolve() }
      const timer = window.setTimeout(finish, timeoutMs)
      peer.addEventListener('connectionstatechange', () => { if (peer.connectionState === 'closed') finish() }, { once: true })
    })
  }

  async connect(): Promise<void> {
    if (this.teardownPromise) await this.teardownPromise
    if (this.snapshot.state === 'connected' || this.snapshot.state === 'waiting-renderer' || this.snapshot.state === 'negotiating') return
    if (this.startPromise) return this.startPromise
    let url: URL
    try { url = new URL(this.config.signalUrl) } catch { throw new Error('信令地址格式无效') }
    if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error('信令地址必须使用 ws:// 或 wss://')
    if (!this.config.appId.trim() || !this.config.sceneKey.trim()) throw new Error('appId 和 sceneKey 不能为空')
    if (this.config.connectionId !== undefined && !this.config.connectionId.trim()) throw new Error('固定 ClientID 不能为空')
    if (globalThis.location?.protocol === 'https:' && url.protocol === 'ws:') throw new Error('HTTPS 页面不能连接明文 WS，请配置 WSS')
    this.stopped = false
    this.descriptionQueue = Promise.resolve()
    this.activeGeneration = ++this.connectionGeneration
    const generation = this.activeGeneration
    this.inputSender.reset()
    this.streamStats.reset()
    delete this.video.dataset.cloudStats
    this.startPromise = this.openSignaling(generation)
    try { await this.startPromise } catch (error) { if (this.isCurrent(generation)) this.fail(error instanceof Error ? error.message : '连接失败'); throw error }
  }

  private openSignaling(generation: number): Promise<void> {
    this.update({ state: 'connecting', message: '正在连接旧版 WebSocket 信令…', videoReady: false, inputReady: false, rpcReady: false, runtimeReady: false })
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.config.signalUrl)
      this.socket = socket
      let settled = false
      const fail = (error: Error) => {
        if (!this.isCurrent(generation)) return
        if (!settled) { settled = true; window.clearTimeout(this.connectionTimer); this.cancelConnect = null; reject(error) }
        this.fail(error.message)
      }
      this.cancelConnect = () => { if (this.isCurrent(generation) && !settled) { settled = true; reject(new Error('连接已取消')) } }
      this.connectionTimer = window.setTimeout(() => fail(new Error('连接信令超时')), this.config.timeoutMs ?? 15000)
      socket.onopen = () => {
        if (!this.isCurrent(generation)) { socket.close(); return }
        if (this.stopped) { socket.close(); return }
        socket.send(JSON.stringify({ type: 'connect', name: 'Client', data: { connectionId: this.connectionId, appId: this.config.appId, type: this.config.type ?? 'u3d', sceneKey: this.config.sceneKey, ...(this.config.macAddress ? { macAddress: this.config.macAddress } : {}) } }))
        this.update({ state: 'waiting-renderer', message: '信令已连接，等待 Launcher 启动 Unity…' })
        if (!settled) { settled = true; window.clearTimeout(this.connectionTimer); this.cancelConnect = null; resolve() }
        this.connectionTimer = window.setTimeout(() => this.fail('等待 Renderer / WebRTC 就绪超时，请检查 Launcher 和 Unity 日志'), 90000)
      }
      socket.onmessage = (event) => {
        if (String(event.data) === 'ping') { if (this.isCurrent(generation)) socket.send('pong'); return }
        let message: LegacySignal
        try { message = JSON.parse(String(event.data)) as LegacySignal }
        catch (error) { if (this.isCurrent(generation)) this.fail(error instanceof Error ? error.message : '信令消息解析失败'); return }
        if (message.type === 'disconnectAck') {
          this.disconnectAckResolver?.()
          return
        }
        if (!this.isCurrent(generation)) return
        this.onSignal(message, generation)
      }
      socket.onerror = () => { if (this.isCurrent(generation)) fail(new Error('WebSocket 信令连接失败')) }
      socket.onclose = () => {
        if (!this.isCurrent(generation)) return
        if (!settled) fail(new Error('信令连接在建立前关闭'))
        else this.fail('信令连接已断开')
      }
    })
  }

  private onSignal(message: LegacySignal, generation: number): void {
    if (!this.isCurrent(generation)) return
    const type = message.type ?? ''
    if (type === 'config' || type === 'heartbeatDetection') return
    if (type === 'disconnectAck') {
      if (String(message.connectionId ?? '') === this.connectionId) this.disconnectAckResolver?.()
      return
    }
    if (type === 'connect') {
      const data = asRecord(message.data)
      if (String(data.ClientID ?? '') !== this.connectionId) return
      this.rendererMac = String(data.RendererPlatformID ?? '')
      this.registered = true
      this.update({ state: 'negotiating', message: 'Unity Renderer 已注册，正在建立 WebRTC…' })
      void this.createPeer(generation).catch((error) => this.fail(String(error)))
      return
    }
    if (type === 'answer') {
      const data = asRecord(message.data)
      this.enqueueDescription(generation, String(message.from ?? data.connectionId ?? ''), { type: 'answer', sdp: String(data.sdp ?? '') })
      return
    }
    if (type === 'offer') {
      const data = asRecord(message.data)
      this.enqueueDescription(generation, String(message.from ?? data.connectionId ?? ''), { type: 'offer', sdp: String(data.sdp ?? '') })
      return
    }
    if (type === 'candidate' || type === 'iceCandidate') {
      const data = asRecord(message.data)
      const candidate = String(data.candidate ?? message.candidate ?? '')
      const from = String(message.from ?? data.connectionId ?? '')
      if (from !== this.connectionId || !this.isCurrent(generation)) return
      if (this.pendingCandidates.length > 256) throw new Error('ICE 候选过多')
      if (candidate) {
        const init: RTCIceCandidateInit = { candidate, sdpMLineIndex: data.sdpMLineIndex == null ? null : Number(data.sdpMLineIndex), sdpMid: data.sdpMid == null ? null : String(data.sdpMid) }
        if (!this.peer?.remoteDescription) this.pendingCandidates.push(init)
        else void this.peer.addIceCandidate(init).catch((error) => this.fail(`ICE 候选失败：${String(error)}`))
      }
      return
    }
    if (type === 'rendererUnregister' || type === 'launcherUnregister' || type === 'launcherTempClose' || type === 'WSClose' || type === 'error') {
      this.fail(String(message.message ?? `信令错误：${type}`))
      return
    }
  }

  private async createPeer(generation: number): Promise<void> {
    if (!this.isCurrent(generation) || !this.registered || this.peer) return
    const peer = new RTCPeerConnection({ iceServers: this.config.iceServers ?? [] })
    this.peer = peer
    peer.addTransceiver('video', { direction: 'recvonly' })
    peer.addTransceiver('audio', { direction: 'recvonly' })
    peer.ontrack = (event) => {
      if (!this.isCurrent(generation) || this.peer !== peer) return
      const tracks = event.streams[0]?.getTracks() ?? [event.track]
      for (const track of tracks) if (!this.stream.getTracks().some((item) => item.id === track.id)) this.stream.addTrack(track)
      this.video.srcObject = this.stream
      if (event.track.kind === 'video') {
        event.track.onended = () => { this.stream.removeTrack(event.track); this.update({ videoReady: false }) }
        event.track.onmute = () => this.update({ videoReady: false })
        event.track.onunmute = () => this.update({ message: '视频轨道可用，等待首帧播放' })
        this.update({ message: '已收到 Unity 视频轨道，等待首帧…' })
      }
      void this.video.play().catch(() => this.update({ message: '已收到视频轨道；点击画面以允许浏览器播放' }))
    }
    peer.onicecandidate = ({ candidate }) => { if (candidate && this.isCurrent(generation) && this.peer === peer) this.sendSignal('candidate', { candidate: candidate.candidate, sdpMLineIndex: candidate.sdpMLineIndex, sdpMid: candidate.sdpMid, connectionId: this.connectionId }, this.connectionId) }
    peer.onconnectionstatechange = () => {
      if (!this.isCurrent(generation) || this.peer !== peer) return
      this.update({ peerState: peer.connectionState })
      if (peer.connectionState === 'connected') { window.clearTimeout(this.disconnectTimer); window.clearTimeout(this.connectionTimer); this.startPerformanceStats(peer, generation); this.update({ state: 'connected', message: 'WebRTC 已连接；编辑协议仍需单独验证' }) }
      else if (peer.connectionState === 'failed') this.fail('WebRTC Peer 连接失败')
      else if (peer.connectionState === 'disconnected') { window.clearTimeout(this.disconnectTimer); this.disconnectTimer = window.setTimeout(() => { if (peer.connectionState === 'disconnected') this.fail('WebRTC 网络断开') }, 5000) }
    }
    this.inputChannel = peer.createDataChannel('input')
    this.inputChannel.binaryType = 'arraybuffer'
    this.inputChannel.onopen = () => {
      if (!this.isCurrent(generation) || this.inputChannel?.readyState !== 'open') return
      this.update({ inputReady: true, message: '输入通道已就绪' })
      window.setTimeout(() => {
        if (!this.isCurrent(generation) || this.inputChannel?.readyState !== 'open') return
        inputDescriptors().forEach((packet) => this.inputChannel?.send(packet))
      }, 750)
    }
    this.inputChannel.onclose = () => { if (this.isCurrent(generation)) this.update({ inputReady: false }) }
    this.rpcChannel = peer.createDataChannel('rpc')
    this.rpcChannel.binaryType = 'arraybuffer'
    this.rpcChannel.onopen = () => { if (this.isCurrent(generation)) this.update({ rpcReady: true, message: 'RPC 通道已就绪，等待 Runtime 初始化…' }) }
    this.rpcChannel.onclose = () => { if (this.isCurrent(generation)) this.update({ rpcReady: false, runtimeReady: false }) }
    this.rpcChannel.onmessage = (event) => this.onRpcMessage(generation, event.data)
    try {
      const offer = await peer.createOffer()
      await peer.setLocalDescription(offer)
      if (!this.isCurrent(generation) || this.peer !== peer) return
      this.sendSignal('offer', { side: 'Client', connectionId: this.connectionId, sdp: peer.localDescription?.sdp ?? offer.sdp, RendererPlatformID: this.rendererMac }, this.connectionId)
    } catch (error) { this.fail(error instanceof Error ? error.message : '创建 WebRTC Offer 失败') }
  }

  private sendSignal(type: string, data: Record<string, unknown>, from: string): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return
    this.socket.send(JSON.stringify({ type, from, name: 'Client', data }))
  }

  private enqueueDescription(generation: number, from: string, description: RTCSessionDescriptionInit): void {
    this.descriptionQueue = this.descriptionQueue
      .catch(() => undefined)
      .then(() => this.applyDescription(generation, from, description))
  }

  private async applyDescription(generation: number, from: string, description: RTCSessionDescriptionInit): Promise<void> {
    const peer = this.peer
    if (!this.isCurrent(generation) || !peer || !from || from !== this.connectionId) return
    try {
      await peer.setRemoteDescription(description)
      if (!this.isCurrent(generation) || this.peer !== peer) return
      for (const candidate of this.pendingCandidates.splice(0)) await peer.addIceCandidate(candidate)
      if (description.type === 'offer') {
        await peer.setLocalDescription(await peer.createAnswer())
        if (!this.isCurrent(generation) || this.peer !== peer) return
        this.sendSignal('answer', { sdp: peer.localDescription?.sdp ?? '', connectionId: this.connectionId }, this.connectionId)
      }
    } catch (error) { if (this.isCurrent(generation)) this.fail(error instanceof Error ? error.message : '应用远端 SDP 失败') }
  }

  sendPointerInput(event: MouseEvent | WheelEvent, rect: DOMRect): void {
    this.inputSender.pointer(event, rect, this.video.videoWidth, this.video.videoHeight)
  }

  sendKeyboardInput(event: KeyboardEvent): void {
    this.inputSender.keyboard(event)
  }

  sendReleaseInput(): void {
    this.inputSender.release()
  }

  markVideoPlaying(): void { if (!this.stopped) this.update({ videoReady: true }) }
  markRuntimeReady(): void { if (!this.stopped) this.update({ runtimeReady: true, message: 'Unity editor.v1 Runtime 已就绪' }) }

  private startPerformanceStats(peer: RTCPeerConnection, generation: number): void {
    if (this.statsTimer !== null) window.clearTimeout(this.statsTimer)
    const poll = ++this.statsPoll
    const active = () => this.isCurrent(generation) && this.peer === peer && this.statsPoll === poll
    const sample = async () => {
      this.statsTimer = null
      try {
        const report = await peer.getStats()
        if (!active()) return
        const performance = this.streamStats.read(report, this.inputChannel?.bufferedAmount ?? 0)
        if (performance) {
          this.video.dataset.cloudStats = JSON.stringify(performance)
          this.update({ performance })
        }
      } catch { /* Diagnostic sampling must not interrupt the session. */ }
      if (active()) this.statsTimer = window.setTimeout(() => { void sample() }, 1000)
    }
    this.statsTimer = window.setTimeout(() => { void sample() }, 1000)
  }

  private onRpcMessage(generation: number, data: unknown): void {
    if (!this.isCurrent(generation)) return
    try {
      if (typeof data === 'string') { this.handleRpcJson(data, generation); return }
      if (!(data instanceof ArrayBuffer)) return
      const json = this.decoder.decode(data)
      if (json && this.isCurrent(generation)) this.handleRpcJson(json, generation)
    } catch (error) { if (this.isCurrent(generation)) this.fail(error instanceof Error ? error.message : 'RPC 响应解析失败') }
  }
  private handleRpcJson(text: string, generation: number): void {
    if (!this.isCurrent(generation)) return
    const normalizedText = text.trim()
    // 旧版 Unity 可能复用 RPC 通道发送 FBX 等二进制帧；非 JSON 帧不应让整个会话进入失败态。
    if (!normalizedText.startsWith('{')) return
    let value: Record<string, unknown>
    try {
      value = JSON.parse(normalizedText) as Record<string, unknown>
    } catch {
      return
    }
    const id = typeof value.id === 'string' || typeof value.id === 'number' ? String(value.id) : undefined
    if (id && this.pending.has(id)) {
      const pending = this.pending.get(id)!
      if (pending.generation !== generation) return
      this.pending.delete(id)
      window.clearTimeout(pending.timer)
      pending.resolve(decodeUnityRpcResponse(value, id))
      return
    }
    const method = String(value.method ?? '')
    if (method.startsWith('editor.v1.')) {
      const event = parseUnityRuntimeEvent(method, value)
      if (event) this.subscribers.get(method)?.forEach((listener) => listener(event))
      if (method === 'editor.v1.runtime.ready') this.update({ runtimeReady: true, message: 'Unity Runtime 已就绪' })
      if (method === 'editor.v1.runtime.error' && asRecord(event?.payload).fatal === true) {
        this.fail(String(asRecord(event?.payload).message ?? 'Unity 业务初始化失败，请检查播放器日志'))
      }
    }
  }

  async request<TRequest, TResponse>(method: UnityEditorMethod, envelope: UnityRequestEnvelope<TRequest>): Promise<UnityResponseEnvelope<TResponse>> {
    const channel = this.rpcChannel
    if (!channel || channel.readyState !== 'open') throw new Error('Unity RPC DataChannel 尚未就绪')
    const id = envelope.requestId
    const request = { jsonrpc: '2.0', method, params: { envelope }, id }
    const body = JSON.stringify(request)
    // Unity's existing receiver accepts whole JSON only; do not invent browser->Unity fragmentation.
    if (new TextEncoder().encode(body).length > 10240) throw new Error('旧版 Unity 接收器仅支持 10 KB 内请求')
    if (channel.bufferedAmount > 256 * 1024) throw new Error('RPC 通道拥塞，请稍后重试')
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => { this.pending.delete(id); reject(new Error(`Unity RPC 超时：${method}`)) }, 15000)
      this.pending.set(id, { resolve: resolve as (response: UnityResponseEnvelope<unknown>) => void, reject, timer, generation: this.activeGeneration })
      try { channel.send(body) } catch (error) { window.clearTimeout(timer); this.pending.delete(id); reject(error) }
    })
  }
  sendTransformInputMarker(): number {
    const channel = this.inputChannel
    if (!channel || channel.readyState !== 'open') throw new Error('三维输入通道尚未就绪，无法确认对象变换')
    // 与鼠标松手包走同一个有序通道。消息类型 11 由播放器扩展，不产生鼠标或键盘操作。
    const marker = this.transformInputMarker = this.transformInputMarker % 0x7fffffff + 1
    const packet = wrapInput(11, new Uint8Array(0))
    new DataView(packet).setInt32(0, marker, true)
    channel.send(packet)
    return marker
  }
  notify<TRequest>(method: UnityEditorMethod, envelope: UnityRequestEnvelope<TRequest>): void {
    if (this.rpcChannel?.readyState === 'open') this.rpcChannel.send(JSON.stringify({ jsonrpc: '2.0', method, params: { envelope } }))
  }
  subscribe<TPayload>(type: UnityEditorEventType, listener: (event: UnityEventEnvelope<TPayload>) => void): () => void {
    let group = this.subscribers.get(type); if (!group) { group = new Set(); this.subscribers.set(type, group) }
    group.add(listener as (event: UnityEventEnvelope<unknown>) => void)
    return () => group?.delete(listener as (event: UnityEventEnvelope<unknown>) => void)
  }

  onSnapshot(listener: SnapshotListener): () => void {
    this.snapshotListeners.add(listener)
    listener(this.snapshot)
    return () => this.snapshotListeners.delete(listener)
  }

  private update(patch: Partial<LegacyConnectionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    this.snapshotListeners.forEach((listener) => listener(this.snapshot))
  }

  private async stopInternal(message = '会话已关闭', notifyServer = true, finalState: 'closed' | 'failed' = 'closed'): Promise<void> {
    if (this.teardownPromise) return this.teardownPromise
    this.stopped = true
    this.activeGeneration = ++this.connectionGeneration
    window.clearTimeout(this.disconnectTimer)
    window.clearTimeout(this.connectionTimer)
    if (this.statsTimer !== null) window.clearTimeout(this.statsTimer)
    this.statsTimer = null
    this.statsPoll++
    delete this.video.dataset.cloudStats
    this.cancelConnect?.()
    this.cancelConnect = null
    this.sendReleaseInput()

    const socket = this.socket
    const peer = this.peer
    const inputChannel = this.inputChannel
    const rpcChannel = this.rpcChannel
    const teardownId = createId()
    const teardownPromise = (async () => {
      let ackResolver: (() => void) | null = null
      const ackPromise = new Promise<void>((resolve) => { ackResolver = resolve })
      this.disconnectAckResolver = ackResolver
      if (notifyServer && socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'disconnect', name: 'Client', connectionId: this.connectionId, teardownId }))
        await Promise.race([ackPromise, this.waitForSocketClose(socket, 1200)])
      }
      this.disconnectAckResolver = null
      inputChannel?.close()
      rpcChannel?.close()
      peer?.close()
      await this.waitForPeerClose(peer)
      await this.waitForSocketClose(socket)
      this.socket = null
      this.inputChannel = null
      this.rpcChannel = null
      this.peer = null
      this.registered = false
      this.video.srcObject = null
      this.stream.getTracks().forEach((track) => track.stop())
      this.stream = new MediaStream()
      this.decoder.reset()
      this.pendingCandidates = []
      this.pending.forEach((pending) => { window.clearTimeout(pending.timer); pending.reject(new Error('Unity 会话已断开')) })
      this.pending.clear()
      this.startPromise = null
      socket?.close()
      // 直接发布最终状态：异常断开不能先发 closed，否则初始化等待器会提前销毁订阅，漏掉后续失败通知。
      this.update({ state: finalState, message, videoReady: false, inputReady: false, rpcReady: false, runtimeReady: false, peerState: 'new', performance: undefined })
    })()
    this.teardownPromise = teardownPromise
    try { await teardownPromise } finally { if (this.teardownPromise === teardownPromise) this.teardownPromise = null }
  }

  private fail(message: string): void {
    if (this.stopped) return
    // 连接协商失败也要通知信令端释放固定 ClientID 对应的旧 Peer，避免下一次重连收到迟到的 SDP。
    void this.stopInternal(message, true, 'failed')
  }
  async disconnect(): Promise<void> {
    await this.stopInternal()
  }
}
