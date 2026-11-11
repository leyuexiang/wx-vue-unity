import type { UnityTransport } from './UnityTransport'
import { authContext } from '@/auth/authContext'
import { decodeUnityRpcResponse } from './decodeUnityRpcResponse'
import { loadVegetationModelCatalog, type VegetationModelChoice } from '../runtime/vegetationModelCatalog'
import type { UnityEditorEventType, UnityEditorMethod, UnityEventEnvelope, UnityRequestEnvelope, UnityResponseEnvelope } from '../protocol/types'

type UnityPlayer = { SendMessage: (target: string, method: string, value: string) => void; Quit: () => Promise<void> }
type StartupStatus = { sessionId: string; status: string }
type StartupApi = {
  getStatus: () => StartupStatus
  submit: (context: object, trustedHost: object) => void
  configureBusiness: (config: object, trustedHost: object) => void
  cancel: () => void
}
type UnityCanvas = HTMLCanvasElement & { jtyfArtStartup?: StartupApi; jtyfBusinessChannelTarget?: string }
type Bootstrap = {
  build: { loaderUrl: string; dataUrl: string; frameworkUrl: string; codeUrl: string; streamingAssetsUrl?: string; threadsRequired?: boolean }
  art: { descriptorBase64: string; descriptorSha256: string; releaseBaseUrl: string; projectId: string; allowedOrigins: string[] }
  business: { projectName: string; apiBaseUrl: string; userId: string; allowedApiOrigins: string[] }
}
type UnityMessage = CustomEvent<{ canvas: HTMLCanvasElement; target: string; message: string }>

declare global {
  interface Window {
    createUnityInstance?: (canvas: HTMLCanvasElement, config: object, progress?: (value: number) => void) => Promise<UnityPlayer>
  }
}

const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {}
let nextCanvasId = 0
const withTimeout = <T>(work: Promise<T>, label: string, ms = 30000): Promise<T> => new Promise((resolve, reject) => {
  const timer = window.setTimeout(() => reject(new Error(`${label}超时`)), ms)
  work.then((value) => { window.clearTimeout(timer); resolve(value) }, (error) => { window.clearTimeout(timer); reject(error) })
})

const loadScript = (url: string): Promise<void> => new Promise((resolve, reject) => {
  const script = document.createElement('script')
  script.src = url
  script.onload = () => resolve()
  script.onerror = () => reject(new Error('Unity Web 加载脚本失败'))
  document.head.append(script)
})

/** Unity Web uses the same editor.v1 JSON-RPC contract as the cloud DataChannel. */
export class WebUnityTransport implements UnityTransport {
  private readonly canvas: UnityCanvas
  private player: UnityPlayer | null = null
  private frameworkObjectUrl: string | null = null
  private target = ''
  private closed = false
  private connectPromise: Promise<void> | null = null
  private artDeployment: Bootstrap['art'] | null = null
  private modelCatalog: Promise<VegetationModelChoice[]> | null = null
  private readonly pending = new Map<string, { resolve: (value: UnityResponseEnvelope<unknown>) => void; reject: (error: Error) => void; timer: number }>()
  private readonly subscribers = new Map<string, Set<(event: UnityEventEnvelope<unknown>) => void>>()

  constructor(private readonly container: HTMLElement, private readonly bootstrapUrl: string, private readonly onStatus?: (message: string) => void) {
    this.canvas = document.createElement('canvas') as UnityCanvas
    // Unity WebGPU resolves its canvas with document.querySelector(`#${canvas.id}`).
    this.canvas.id = `unity-web-canvas-${++nextCanvasId}`
    this.canvas.className = 'unity-web-canvas'
    this.canvas.tabIndex = 0
    this.canvas.addEventListener('pointerdown', () => this.canvas.focus({ preventScroll: true }))
    this.canvas.style.cssText = 'width:100%;height:100%;display:block;outline:none'
    // 与云端视频保持一致，仅禁用当前画布的默认右键菜单，不阻断Unity接收右键旋转事件。
    this.canvas.addEventListener('contextmenu', (event) => event.preventDefault())
  }

  connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise
    this.closed = false
    this.connectPromise = this.start().catch((error) => { this.connectPromise = null; throw error })
    return this.connectPromise
  }

  async listVegetationModels(): Promise<VegetationModelChoice[]> {
    if (this.closed || !this.artDeployment) throw new Error('Unity 模型资源尚未就绪')
    if (!this.modelCatalog) this.modelCatalog = loadVegetationModelCatalog(this.artDeployment).catch(error => {
      this.modelCatalog = null
      throw error
    })
    return this.modelCatalog
  }

  private async start(): Promise<void> {
    this.onStatus?.('读取 Unity Web 部署配置')
    const token = authContext.getAccessToken()
    const clientId = authContext.getClientId()
    const platform = authContext.getPlatformType()
    const tenantId = authContext.get()?.tenantId
    const response = await fetch(this.bootstrapUrl, {
      credentials: 'same-origin', cache: 'no-store',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(clientId ? { ClientId: clientId } : {}),
        ...(tenantId ? { 'tenant-id': tenantId } : {}),
        ...(platform ? { 'X-Unity-Platform': platform } : {}) },
    })
    if (!response.ok) throw new Error(`Unity Web 部署配置读取失败：${response.status}`)
    const bootstrap = await response.json() as Bootstrap
    if (!bootstrap?.build?.loaderUrl || !bootstrap.build.dataUrl || !bootstrap.build.frameworkUrl || !bootstrap.build.codeUrl ||
        !bootstrap.art?.descriptorBase64 || !bootstrap.art.descriptorSha256 || !bootstrap.art.releaseBaseUrl || !bootstrap.art.projectId ||
        !bootstrap.business?.projectName || !bootstrap.business.apiBaseUrl || !bootstrap.business.userId) {
      throw new Error('Unity Web 部署配置缺少构建或启动字段')
    }
    if (bootstrap.build.threadsRequired && (!globalThis.crossOriginIsolated || typeof SharedArrayBuffer === 'undefined')) {
      throw new Error('Unity WebGPU 原生线程需要网页启用跨源隔离（COOP: same-origin；COEP: credentialless 或 require-corp），配置后请完整刷新页面')
    }
    this.artDeployment = bootstrap.art
    let frameworkUrl = bootstrap.build.frameworkUrl
    if (bootstrap.build.threadsRequired && new URL(frameworkUrl, document.baseURI).origin !== window.location.origin) {
      // CORS allows script downloads but not a Worker whose entry URL has another origin.
      // Keep the pthread framework on a page-owned URL; data and WASM retain their deployment URLs.
      const framework = await fetch(frameworkUrl, { credentials: 'omit', cache: 'no-store' })
      if (!framework.ok) throw new Error(`Unity Web 线程框架读取失败：${framework.status}`)
      const source = await framework.text()
      if (this.closed) throw new Error('Unity Web 页面已关闭')
      this.frameworkObjectUrl = URL.createObjectURL(new Blob([source], { type: 'application/javascript' }))
      frameworkUrl = this.frameworkObjectUrl
    }
    this.container.append(this.canvas)
    window.addEventListener('jtyf-message', this.onMessage as EventListener)
    await loadScript(bootstrap.build.loaderUrl)
    if (this.closed) throw new Error('Unity Web 页面已关闭')
    if (!window.createUnityInstance) throw new Error('Unity Web 加载器没有 createUnityInstance')
    this.onStatus?.('加载 Unity Web 构建')
    const loadingPlayer = window.createUnityInstance(this.canvas, {
      dataUrl: bootstrap.build.dataUrl,
      frameworkUrl,
      ...(bootstrap.build.threadsRequired ? { mainScriptUrlOrBlob: frameworkUrl } : {}),
      codeUrl: bootstrap.build.codeUrl,
      streamingAssetsUrl: bootstrap.build.streamingAssetsUrl,
    }, (progress) => this.onStatus?.(`加载 Unity Web 构建 ${Math.round(progress * 100)}%`))
    void loadingPlayer.then((player) => { if (this.closed) void player.Quit() }).catch(() => {})
    const player = await withTimeout(loadingPlayer, 'Unity Web 构建加载', 180000)
    if (this.closed) throw new Error('Unity Web 页面已关闭')
    this.player = player
    await this.startBusiness(bootstrap)
  }

  private async startBusiness(bootstrap: Bootstrap): Promise<void> {
    const api = await withTimeout(new Promise<StartupApi>((resolve) => {
      if (this.canvas.jtyfArtStartup) { resolve(this.canvas.jtyfArtStartup); return }
      const onReady = () => {
        if (!this.canvas.jtyfArtStartup) return
        this.canvas.removeEventListener('jtyf-art-startup-status', onReady)
        resolve(this.canvas.jtyfArtStartup)
      }
      this.canvas.addEventListener('jtyf-art-startup-status', onReady)
    }), 'Unity Web 资源启动桥', 30000)
    const sessionId = api.getStatus().sessionId
    this.onStatus?.('准备 Unity Web 资源与业务')
    api.submit({ schemaVersion: 1, sessionId, descriptorBase64: bootstrap.art.descriptorBase64,
      descriptorSha256: bootstrap.art.descriptorSha256, releaseBaseUrl: bootstrap.art.releaseBaseUrl,
      policy: 'RequireTarget' }, { projectId: bootstrap.art.projectId, allowedOrigins: bootstrap.art.allowedOrigins })
    api.configureBusiness({ schemaVersion: 1, sessionId, projectId: bootstrap.art.projectId,
      projectName: bootstrap.business.projectName, apiBaseUrl: bootstrap.business.apiBaseUrl,
      userId: bootstrap.business.userId }, { allowedApiOrigins: bootstrap.business.allowedApiOrigins })
    await withTimeout(new Promise<void>((resolve, reject) => {
      const inspect = () => {
        const status = api.getStatus().status
        if (status === 'business-ready' && this.canvas.jtyfBusinessChannelTarget) { cleanup(); resolve() }
        else if (status.includes('failed') || status.includes('rejected') || status === 'session-closed') {
          cleanup(); reject(new Error(`Unity Web 启动失败：${status}`))
        } else this.onStatus?.(`Unity Web 启动：${status}`)
      }
      const cleanup = () => {
        this.canvas.removeEventListener('jtyf-art-startup-status', inspect)
        this.canvas.removeEventListener('jtyf-business-ready', inspect)
      }
      this.canvas.addEventListener('jtyf-art-startup-status', inspect)
      this.canvas.addEventListener('jtyf-business-ready', inspect)
      inspect()
    }), 'Unity Web 业务启动', 90000)
    this.target = this.canvas.jtyfBusinessChannelTarget || ''
    if (!this.target) throw new Error('Unity Web 业务通道未就绪')
  }

  async disconnect(): Promise<void> {
    this.closed = true
    this.connectPromise = null
    this.target = ''
    this.artDeployment = null
    this.modelCatalog = null
    window.removeEventListener('jtyf-message', this.onMessage as EventListener)
    for (const pending of this.pending.values()) { window.clearTimeout(pending.timer); pending.reject(new Error('Unity Web 会话已结束')) }
    this.pending.clear()
    this.subscribers.clear()
    this.canvas.jtyfArtStartup?.cancel()
    const player = this.player
    this.player = null
    const frameworkObjectUrl = this.frameworkObjectUrl
    this.frameworkObjectUrl = null
    try { if (player) await player.Quit() }
    finally {
      if (frameworkObjectUrl) URL.revokeObjectURL(frameworkObjectUrl)
      this.canvas.remove()
    }
  }

  private readonly onMessage = (event: UnityMessage) => {
    if (this.closed || event.detail?.canvas !== this.canvas || event.detail.target !== this.target) return
    let value: Record<string, unknown>
    try { value = JSON.parse(event.detail.message) as Record<string, unknown> } catch { return }
    const id = value.id === undefined || value.id === null ? '' : String(value.id)
    const pending = this.pending.get(id)
    if (pending) {
      this.pending.delete(id)
      window.clearTimeout(pending.timer)
      pending.resolve(decodeUnityRpcResponse(value, id))
      return
    }
    const method = String(value.method ?? '')
    if (!method.startsWith('editor.v1.')) return
    const params = asRecord(value.params)
    const envelope = asRecord(params.envelope ?? params)
    const message: UnityEventEnvelope<unknown> = {
      protocolVersion: Number(envelope.protocolVersion ?? 1), sessionId: String(envelope.sessionId ?? ''),
      sceneId: String(envelope.sceneId ?? ''), sceneGeneration: Number(envelope.sceneGeneration ?? 0),
      eventId: String(envelope.eventId ?? ''), type: method as UnityEditorEventType,
      payload: envelope.payload ?? params.payload ?? params,
    }
    this.subscribers.get(method)?.forEach((listener) => listener(message))
  }

  request<TRequest, TResponse>(method: UnityEditorMethod, envelope: UnityRequestEnvelope<TRequest>): Promise<UnityResponseEnvelope<TResponse>> {
    if (!this.player || !this.target || this.closed) return Promise.reject(new Error('Unity Web 业务通道未就绪'))
    const body = JSON.stringify({ jsonrpc: '2.0', method, params: { envelope }, id: envelope.requestId })
    return new Promise((resolve, reject) => {
      const timeoutMs = method === 'editor.v1.scene.loadDraft' ? 120000 : 30000
      const timer = window.setTimeout(() => { this.pending.delete(envelope.requestId); reject(new Error(`Unity Web RPC 超时：${method}`)) }, timeoutMs)
      this.pending.set(envelope.requestId, { resolve: resolve as (value: UnityResponseEnvelope<unknown>) => void, reject, timer })
      try { this.player!.SendMessage(this.target, 'ReceiveMessage', body) }
      catch (error) { window.clearTimeout(timer); this.pending.delete(envelope.requestId); reject(error) }
    })
  }

  notify<TRequest>(method: UnityEditorMethod, envelope: UnityRequestEnvelope<TRequest>): void {
    if (!this.player || !this.target || this.closed) return
    this.player.SendMessage(this.target, 'ReceiveMessage', JSON.stringify({ jsonrpc: '2.0', method, params: { envelope } }))
  }

  subscribe<TPayload>(type: UnityEditorEventType, listener: (event: UnityEventEnvelope<TPayload>) => void): () => void {
    let group = this.subscribers.get(type)
    if (!group) { group = new Set(); this.subscribers.set(type, group) }
    group.add(listener as (event: UnityEventEnvelope<unknown>) => void)
    return () => group?.delete(listener as (event: UnityEventEnvelope<unknown>) => void)
  }
}
