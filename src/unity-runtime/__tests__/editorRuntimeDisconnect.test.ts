import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LegacyConnectionSnapshot } from '../connection/LegacyUnityTransport'
import { UnityEditorSceneRuntime } from '../runtime/UnityEditorSceneRuntime'

const source = vi.hoisted(() => ({ listeners: new Set<(snapshot: LegacyConnectionSnapshot) => void>() }))
const snapshot: LegacyConnectionSnapshot = {
  state: 'connected', message: '已连接', connectionId: 'test', videoReady: true,
  inputReady: true, rpcReady: true, runtimeReady: true, peerState: 'connected',
}

// 只替换传输边界，仍执行真实运行时挂载、订阅和销毁，确认退出通知不依赖状态提示文字。
vi.mock('../connection/LegacyUnityTransport', () => ({ LegacyUnityTransport: class {
  onSnapshot(listener: (value: LegacyConnectionSnapshot) => void) {
    source.listeners.add(listener)
    listener(snapshot)
    return () => source.listeners.delete(listener)
  }
  async connect() {}
  async disconnect() {}
} }))
vi.mock('../runtime/JsonRpcUnityCloudRuntime', () => ({ JsonRpcUnityCloudRuntime: class {
  // 补齐正式能力协商字段，挂载时同时验证模型入口只依赖播放器声明的对象能力。
  capabilities = { sceneTypes: ['local3d'], objectTypes: ['model', 'primitive', 'group'], features: {} }
  async connect() {}
  async disconnect() {}
  on() { return () => {} }
} }))

describe('编辑运行时断开通知', () => {
  beforeEach(() => {
    source.listeners.clear()
    // 云画面拖动会注册窗口级释放监听，测试窗口提供同样的事件接口。
    vi.stubGlobal('window', { setTimeout, clearTimeout, addEventListener: vi.fn(), removeEventListener: vi.fn() })
    vi.stubGlobal('document', { createElement: () => ({ style: {}, addEventListener: vi.fn(), remove: vi.fn() }) })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('只对确认失败通知编辑页，短暂抖动和主动销毁均不触发', async () => {
    const onDisconnected = vi.fn()
    const runtime = new UnityEditorSceneRuntime('local3d', {
      mode: 'cloud', cloudConfig: { signalUrl: 'ws://test.invalid', appId: '1', sceneKey: 'test' },
      getHost: () => null, onStatus: vi.fn(), onDisconnected,
    })
    await runtime.mount({ append: vi.fn() } as unknown as HTMLElement)
    expect(runtime.capabilities.assets.glb).toBe(true)
    const emit = (patch: Partial<LegacyConnectionSnapshot>) => source.listeners.forEach((listener) => listener({ ...snapshot, ...patch }))
    emit({ peerState: 'disconnected' })
    emit({ state: 'closed' })
    expect(onDisconnected).not.toHaveBeenCalled()
    emit({ state: 'failed', message: '渲染机进程已关闭' })
    expect(onDisconnected).toHaveBeenCalledExactlyOnceWith('渲染机进程已关闭')
    runtime.dispose()
    expect(window.removeEventListener).toHaveBeenCalledWith('mouseup', expect.any(Function), true)
    emit({ state: 'failed' })
    expect(onDisconnected).toHaveBeenCalledOnce()
    expect(source.listeners.size).toBe(0)
  })
})
