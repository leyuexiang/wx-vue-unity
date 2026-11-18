import { createEmptyScene } from '@/scene-core'
import { WebUnityTransport } from '@/unity-runtime/connection/WebUnityTransport'
import { JsonRpcUnityCloudRuntime } from '@/unity-runtime/runtime/JsonRpcUnityCloudRuntime'
import { unityRenderConfig } from '@/unity-runtime/renderMode'

// 同页预览串行释放播放器，再允许新实例启动，避免快速关闭、重开导致两个网页播放器并存。
let previousDisposal: Promise<void> = Promise.resolve()

/** 模型预览复用已接入的播放器和业务协议，保持参考项目的弹窗、主题和资源地址契约。 */
export default class RenderScene {
  private readonly transport: WebUnityTransport
  private readonly runtime: JsonRpcUnityCloudRuntime
  private starting: Promise<void> | null = null
  private disposal: Promise<void> | null = null
  private disposed = false
  private ready = false
  private requestVersion = 0

  constructor(private readonly container: HTMLElement, private readonly onStatus: (message: string) => void) {
    this.transport = new WebUnityTransport(container, unityRenderConfig.webgpu.bootstrapUrl, (message) => {
      if (!this.disposed) this.onStatus(message)
    })
    this.runtime = new JsonRpcUnityCloudRuntime(this.transport)
  }

  init(): Promise<void> {
    if (this.starting) return this.starting
    const previous = previousDisposal
    this.starting = previous.then(async () => {
      if (this.disposed) return
      if (!window.isSecureContext || !('gpu' in navigator)) throw new Error('当前浏览器或页面环境不支持网页图形渲染，请使用支持的浏览器与安全地址')
      if (!unityRenderConfig.webgpu.bootstrapUrl) throw new Error('请先配置网页播放器入口')
      await this.runtime.connect()
      if (this.disposed) return
      if (!this.runtime.capabilities?.features['model.preview']) throw new Error('当前网页播放器需要更新后才能预览模型')
      // 独立预览用现有相机协议覆盖网页包的低分辨率默认值。以 1.5 倍分辨率绘制后缩回画布，
      // 平滑模型轮廓和贴图细线；小视口使用此比例平衡画质与开销，普通场景不应用此配置。
      const scene = createEmptyScene(`model-preview-${crypto.randomUUID()}`)
      scene.camera = { antialiasing: { mode: 'ssaa', supersampleScale: 1.5 } }
      await this.runtime.loadScene(scene)
      this.ready = !this.disposed
    })
    return this.starting
  }

  async loadModel(path: string, resourceId?: string): Promise<boolean> {
    const version = ++this.requestVersion
    await this.init()
    if (this.disposed || version !== this.requestVersion) return false
    this.onStatus('正在加载模型')
    if (resourceId) {
      // 当前发布资源由播放器已有提供器校验完整闭包，不能把私有桶路径拼接到旧对象存储。
      await this.runtime.controlModelPreview({ action: 'load', resourceId, background: this.backgroundColor() })
    } else {
      const url = new URL(path, document.baseURI)
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('模型资源地址格式无效')
      await this.runtime.controlModelPreview({ action: 'load', url: url.href, background: this.backgroundColor() })
    }
    return !this.disposed && version === this.requestVersion
  }

  /** 主题颜色只在装载和主题变化时读取；缺省使用浅灰预览底色，避免白色画布与弹窗混为一体。 */
  private backgroundColor(): string {
    const color = getComputedStyle(this.container).getPropertyValue('--model-preview-background').trim()
    return /^#[\da-f]{6}$/i.test(color) ? color : '#f6f8f9'
  }

  async updateBackground(): Promise<void> {
    if (this.ready && !this.disposed) {
      await this.runtime.controlModelPreview({ action: 'background', background: this.backgroundColor() })
    }
  }

  async resetView(): Promise<void> {
    if (this.ready && !this.disposed) await this.runtime.controlModelPreview({ action: 'reset' })
  }

  async clearModel(): Promise<void> {
    this.requestVersion++
    if (this.ready && !this.disposed) await this.runtime.controlModelPreview({ action: 'clear' })
  }

  /** 先终止业务请求与播放器，再清理能力订阅，关闭期间的迟到任务均保持失效。 */
  renderDestroy(): Promise<void> {
    if (this.disposal) return this.disposal
    this.disposed = true
    this.ready = false
    this.requestVersion++
    this.disposal = (async () => {
      try { await this.transport.disconnect() }
      finally {
        await this.starting?.catch(() => undefined)
        await this.runtime.disconnect({ keepTransport: true })
      }
    })()
    previousDisposal = this.disposal.catch(() => undefined)
    return this.disposal
  }
}
