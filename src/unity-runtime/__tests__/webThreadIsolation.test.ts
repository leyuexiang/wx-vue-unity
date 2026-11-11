import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebUnityTransport } from '../connection/WebUnityTransport'

const bootstrap = {
  build: { threadsRequired: true, loaderUrl: '/player.loader.js', dataUrl: '/player.data', frameworkUrl: '/player.framework.js', codeUrl: '/player.wasm' },
  art: { projectId: 'test', descriptorBase64: 'test', descriptorSha256: 'test', releaseBaseUrl: '/art/', allowedOrigins: [] },
  business: { projectName: 'test', apiBaseUrl: '/api', userId: 'test', allowedApiOrigins: [] },
}

describe('Unity native thread prerequisites', () => {
  const appendPlayer = vi.fn()
  const appendLoader = vi.fn(() => { throw new Error('loader reached') })
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => bootstrap }))
    // 画布已注册右键菜单拦截；模拟元素需具备浏览器事件接口，才能继续验证线程隔离前置条件。
    vi.stubGlobal('document', { baseURI: 'http://app.test/', createElement: () => ({ style: {}, remove: vi.fn(), addEventListener: vi.fn(), focus: vi.fn() }), head: { append: appendLoader } })
    vi.stubGlobal('window', { location: { origin: 'http://app.test' }, addEventListener: vi.fn(), removeEventListener: vi.fn() })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('reports missing page isolation before downloading the player', async () => {
    vi.stubGlobal('crossOriginIsolated', false)
    const transport = new WebUnityTransport({ append: appendPlayer } as unknown as HTMLElement, '/bootstrap')
    await expect(transport.connect()).rejects.toThrow('COOP: same-origin')
    expect(appendPlayer).not.toHaveBeenCalled()
    expect(appendLoader).not.toHaveBeenCalled()
  })

  it('reports unavailable shared memory even when the page claims isolation', async () => {
    vi.stubGlobal('crossOriginIsolated', true)
    vi.stubGlobal('SharedArrayBuffer', undefined)
    const transport = new WebUnityTransport({ append: appendPlayer } as unknown as HTMLElement, '/bootstrap')
    await expect(transport.connect()).rejects.toThrow('跨源隔离')
    expect(appendLoader).not.toHaveBeenCalled()
  })

  it('allows the player loader when isolated shared memory is available', async () => {
    vi.stubGlobal('crossOriginIsolated', true)
    const transport = new WebUnityTransport({ append: appendPlayer } as unknown as HTMLElement, '/bootstrap')
    await expect(transport.connect()).rejects.toThrow('loader reached')
    expect(appendPlayer).toHaveBeenCalledOnce()
    expect(appendLoader).toHaveBeenCalledOnce()
  })

  it('loads a cross-origin pthread framework without credentials and releases its page-owned URL', async () => {
    vi.stubGlobal('crossOriginIsolated', true)
    const frameworkUrl = 'https://player.test/player.framework.js'
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ...bootstrap, build: { ...bootstrap.build, frameworkUrl } }) })
      .mockResolvedValueOnce({ ok: true, text: async () => '// test pthread framework' })
    vi.stubGlobal('fetch', fetchMock)
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:http://app.test/framework')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    try {
      const transport = new WebUnityTransport({ append: appendPlayer } as unknown as HTMLElement, '/bootstrap')
      await expect(transport.connect()).rejects.toThrow('loader reached')
      expect(fetchMock).toHaveBeenNthCalledWith(2, frameworkUrl, { credentials: 'omit', cache: 'no-store' })
      expect(create).toHaveBeenCalledOnce()
      await transport.disconnect()
      expect(revoke).toHaveBeenCalledWith('blob:http://app.test/framework')
    } finally { create.mockRestore(); revoke.mockRestore() }
  })
})
