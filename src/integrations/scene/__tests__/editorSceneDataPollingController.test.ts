import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick, reactive } from 'vue'
import type { ViewportHost } from '@/scene-platform'
import type { WidgetConfig } from '@/stores/sceneEditStore'
import TextConfig from '@/packages/components/Widget/TextCommon/config'
import { createEmptyDataConfig, createEmptyRequestGlobalConfig, type ComponentDataConfig, type StaticRequestConfig, type PublicRequestConfig, type RequestGlobalConfig } from '@/types/data-config'
import { createEditorSceneDataPollingController } from '../editorSceneDataPollingController'
import { setWidgetPreviewState } from '../widgetRuntime/ports'

/** 隔离网络执行，只检验真实响应式配置是否触发唯一调度器，避免把结果回填误判成配置修改。 */
const fixture = vi.hoisted(() => ({
  widgets: {} as { totalWidgets: WidgetConfig[] },
  requests: {} as { scenePublicRequestList: PublicRequestConfig[]; sceneRequestGlobalConfig: RequestGlobalConfig },
  scene: {} as { id: string; objects: Array<{ id: string; metadata?: Record<string, unknown> }> },
  getSceneObjects: null as (() => readonly unknown[]) | null,
  start: vi.fn(), stop: vi.fn(), dispose: vi.fn(),
}))
vi.mock('@/stores/sceneEditStore', () => ({ useSceneWidgetStore: () => fixture.widgets }))
vi.mock('@/stores/sceneAuxiliaryStores', () => ({
  useSceneDataStore: () => ({ sceneDataset: [] }),
  useSceneRequestStore: () => fixture.requests,
}))
vi.mock('../widgetRuntime', () => ({ SceneDataPollingRuntime: class {
  constructor(options: { getSceneObjects?: () => readonly unknown[] }) {
    fixture.getSceneObjects = options.getSceneObjects ?? (() => [])
  }
  start = fixture.start
  stop = fixture.stop
  dispose = fixture.dispose
} }))

describe('二维编辑器数据配置监听', () => {
  let controller: ReturnType<typeof createEditorSceneDataPollingController> | undefined
  afterEach(() => { controller?.dispose(); setWidgetPreviewState(false); vi.useRealTimers(); vi.clearAllMocks() })

  const setup = async () => {
    vi.useFakeTimers()
    const component = new TextConfig()
    component.dataConfig = createEmptyDataConfig([{ value: '初始' }])
    fixture.widgets = reactive({ totalWidgets: [{ id: 'text-1', component }] })
    fixture.requests = reactive({ scenePublicRequestList: [], sceneRequestGlobalConfig: createEmptyRequestGlobalConfig() })
    const modelConfig = createEmptyDataConfig([{ value: '模型初始值' }])
    fixture.scene = reactive({
      id: 'scene-1',
      objects: [{ id: 'model-1', metadata: { dataConfig: modelConfig } }],
    })
    const host = {
      getStore: () => ({ getScene: () => fixture.scene, subscribe: () => () => {} }),
      getRuntime: () => ({ upsertObject: vi.fn() }),
    } as unknown as ViewportHost
    controller = createEditorSceneDataPollingController({ getViewportHost: () => host, refreshDelayMs: 10 })
    await controller.start()
    expect(fixture.start).toHaveBeenCalledTimes(1)
  }

  it('面板原位修改静态数据及全局接口地址后重新调度', async () => {
    await setup()
    const request = fixture.widgets.totalWidgets[0]!.component.dataConfig!.requests![0]!.request
    ;(request.config as StaticRequestConfig).data = [{ value: '更新' }]
    await nextTick()
    await vi.advanceTimersByTimeAsync(10)
    expect(fixture.start).toHaveBeenCalledTimes(2)
    fixture.requests.sceneRequestGlobalConfig.requestOriginUrl = 'https://example.test'
    await nextTick()
    await vi.advanceTimersByTimeAsync(10)
    expect(fixture.start).toHaveBeenCalledTimes(3)
  })

  it('请求结果回填不重启任务，销毁后配置修改不再调度', async () => {
    await setup()
    const request = fixture.widgets.totalWidgets[0]!.component.dataConfig!.requests![0]!
    request.dataset.source = [{ value: '远程结果' }]
    await nextTick()
    await vi.advanceTimersByTimeAsync(10)
    expect(fixture.start).toHaveBeenCalledTimes(1)
    controller!.dispose()
    ;(request.request.config as StaticRequestConfig).data = []
    await nextTick()
    await vi.advanceTimersByTimeAsync(10)
    expect(fixture.start).toHaveBeenCalledTimes(1)
    expect(fixture.dispose).toHaveBeenCalledTimes(1)
  })

  it('三维对象的数据配置参与任务签名并触发调度', async () => {
    await setup()
    expect(fixture.getSceneObjects?.()).toHaveLength(1)

    // 三维请求修改必须重启共享调度器，保证响应映射到当前 Unity Runtime。
    const dataConfig = fixture.scene.objects[0]!.metadata!.dataConfig as ComponentDataConfig
    const request = dataConfig.requests![0]!.request
    ;(request.config as StaticRequestConfig).data = [{ value: '模型更新值' }]
    await nextTick()
    await vi.advanceTimersByTimeAsync(10)

    expect(fixture.start).toHaveBeenCalledTimes(2)
  })

  it('进入预览时等待相同配置已经开始的刷新，不重复创建请求任务', async () => {
    await setup()
    let complete!: () => void
    fixture.start.mockImplementationOnce(() => new Promise<void>((resolve) => { complete = resolve }))
    const config = fixture.scene.objects[0]!.metadata!.dataConfig as ComponentDataConfig
    ;(config.requests![0]!.request.config as StaticRequestConfig).data = [{ value: '预览最新值' }]
    await nextTick()
    vi.advanceTimersByTime(10)
    let ready = false
    const entering = controller!.start().then(() => { ready = true })
    await Promise.resolve()
    await Promise.resolve()
    expect(ready).toBe(false)
    expect(fixture.start).toHaveBeenCalledTimes(2)
    complete()
    await entering
    expect(ready).toBe(true)
  })

  it('退出预览同步失效旧请求，再按编辑配置重建，销毁后不再响应模式切换', async () => {
    await setup()
    setWidgetPreviewState(true)
    setWidgetPreviewState(false)
    // 必须先于二维快照恢复同步停止；等待防抖窗口会留下旧响应覆盖编辑态的空隙。
    expect(fixture.stop).toHaveBeenCalledTimes(1)
    expect(fixture.start).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(10)
    expect(fixture.start).toHaveBeenCalledTimes(2)
    controller!.dispose()
    setWidgetPreviewState(true)
    setWidgetPreviewState(false)
    expect(fixture.stop).toHaveBeenCalledTimes(1)
  })
})
