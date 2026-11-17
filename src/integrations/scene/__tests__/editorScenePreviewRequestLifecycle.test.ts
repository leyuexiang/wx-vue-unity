import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick, reactive } from 'vue'
import { useSceneWidgetStore } from '@/stores/sceneEditStore'
import { useSceneRequestStore } from '@/stores/sceneAuxiliaryStores'
import InputConfig from '@/packages/components/Control/VInput/config'
import type { SceneObject, SceneStore, ViewportHost } from '@/scene-platform'
import { createSceneStore } from '@/scene-platform/store/sceneStore'
import { createSceneDefinition } from '@/scene-platform/core/sceneDefinition'
import { createEmptyDataConfig, type AjaxRequestConfig, type PublicRequestConfig } from '@/types/data-config'
import { buildParameterTargetOptions } from '@/utils/dataConfig/interactionRequestParameters'
import request from '@/request'
import { createEditorSceneDataPollingController } from '../editorSceneDataPollingController'
import { passSceneRequestParameters } from '../widgetRuntime/sceneDataRequestActions'
import { setWidgetPreviewState } from '../widgetRuntime/ports'

// 只替换网络和引擎传输边界；仓库、编辑控制器、请求调度和二维映射全部使用实际实现。
vi.mock('@/request', () => ({ default: vi.fn() }))
vi.mock('@/auth/runtime', async (original) => ({
  ...(await original<typeof import('@/auth/runtime')>()),
  isEmbeddedMode: () => false,
}))
const network = vi.mocked(request)
const controllers: ReturnType<typeof createEditorSceneDataPollingController>[] = []
afterEach(() => {
  controllers.splice(0).forEach((controller) => controller.dispose())
  setWidgetPreviewState(false)
  vi.useRealTimers()
  vi.resetAllMocks()
})

/** 同时配置二维和三维目标，用受控迟到响应验证真实会话边界。 */
const fixture = (kind: 'ajax' | 'public' = 'ajax', realStore = false) => {
  const shared = {
    id: 'shared', name: '共享查询', requestUrl: '/shared', requestOriginUrl: '',
    requestHttpType: 'GET', requestInterval: 0, requestIntervalUnit: 'second',
    requestContentType: 'default', requestParamsBodyType: 'none', requestSQLContent: { sql: '' },
    requestParams: { Params: { id: '0' }, Header: {}, Body: {} },
  } as PublicRequestConfig
  const config = (id: string) => {
    const result = createEmptyDataConfig()
    result.request = kind === 'public'
      ? { type: 'public', config: { publicRequestId: shared.id } }
      : { type: 'ajax', config: { ...shared, requestUrl: `/${id}` } as AjaxRequestConfig }
    result.bindings = [{ kind: 'widget', targetPath: 'value', sourceField: 'value', valueType: 'string' }]
    return result
  }
  const component = new InputConfig()
  component.dataConfig = config('widget')
  const widgets = useSceneWidgetStore()
  widgets.totalWidgets = [{ id: 'widget', component }]
  useSceneRequestStore().scenePublicRequestList = kind === 'public' ? [shared] : []
  const model: SceneObject = {
    id: 'model', name: '模型', type: 'model', visible: true, locked: false, order: 0, assetRefs: [],
    transform: { kind: 'local', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    metadata: { dataConfig: config('model') },
  }
  const scene = reactive({ id: 'scene-a', objects: [model] })
  let listener: ((event: { type: string }) => void) | undefined
  const upsertObject = vi.fn(async (_object: SceneObject) => {})
  const store = realStore ? createSceneStore(createSceneDefinition({ id: 'scene-a', name: '测试场景', type: 'local3d', objects: [model] })) : {
    getScene: () => scene,
    getObject: (id: string) => scene.objects.find((object) => object.id === id) ?? null,
    subscribe: (callback: typeof listener) => { listener = callback; return () => { listener = undefined } },
  } as unknown as SceneStore
  const host = { getStore: () => store, getRuntime: () => ({ upsertObject }) } as unknown as ViewportHost
  const controller = createEditorSceneDataPollingController({ getViewportHost: () => host, refreshDelayMs: 10 })
  controllers.push(controller)
  network.mockImplementation(async (_url, options) => ({
    data: { value: `数据${(options?.params as Record<string, string>).id}` },
  }))
  const pass = (targetKind: 'widget' | 'object', value: string) => passSceneRequestParameters({
    targetKind, targetId: targetKind === 'widget' ? 'widget' : 'model',
    assignments: [{ targetProperty: buildParameterTargetOptions(config('unused'), [shared])[0].value, value }],
  })
  return { controller, widgets, scene, store, upsertObject, pass, emit: (type: string) => listener?.({ type }) }
}

describe('编辑器请求的预览与删除边界', () => {
  it.each(['ajax', 'public'] as const)('%s 退出后拒绝迟到响应，立即重进也从编辑参数开始', async (kind) => {
    vi.useFakeTimers()
    const f = fixture(kind)
    await f.controller.start()
    setWidgetPreviewState(true)
    const pending: Array<(value: unknown) => void> = []
    network.mockImplementationOnce(() => new Promise((resolve) => pending.push(resolve)))
    if (kind === 'ajax') network.mockImplementationOnce(() => new Promise((resolve) => pending.push(resolve)))
    const work = [f.pass('widget', '7')]
    if (kind === 'ajax') work.push(f.pass('object', '7'))
    await vi.waitFor(() => expect(pending).toHaveLength(kind === 'ajax' ? 2 : 1))
    setWidgetPreviewState(false)
    // 模拟宿主紧接着恢复二维快照，旧请求不得在这之后回写。
    f.widgets.totalWidgets![0].component.option.value = '退出恢复值'
    f.upsertObject.mockClear()
    pending.forEach((resolve) => resolve({ data: { value: '失效旧响应' } }))
    await Promise.all(work)
    expect(f.widgets.totalWidgets![0].component.option.value).toBe('退出恢复值')
    expect(f.upsertObject).not.toHaveBeenCalled()
    network.mockClear()
    // 防抖重建尚未执行就重进，不能复用上一次的传参覆盖或完成屏障。
    await f.controller.start()
    setWidgetPreviewState(true)
    expect(network).toHaveBeenCalledTimes(kind === 'ajax' ? 2 : 1)
    expect(network.mock.calls.every(([, options]) => (options?.params as Record<string, string>).id === '0')).toBe(true)
    expect(f.widgets.totalWidgets![0].component.option.value).toBe('数据0')
    await vi.advanceTimersByTimeAsync(10)
    expect(network).toHaveBeenCalledTimes(kind === 'ajax' ? 2 : 1)
  })

  it.each(['ajax', 'public'] as const)('%s 三维目标删除后、防抖协调之前的迟到响应不能重新创建对象', async (kind) => {
    const f = fixture(kind)
    await f.controller.start()
    let complete!: (value: unknown) => void
    network.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve }))
    const pending = f.pass('object', '7')
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'))
    f.scene.objects = []
    f.emit('objectRemoved')
    f.upsertObject.mockClear()
    complete({ data: { value: '已删除目标的旧响应' } })
    await pending
    expect(f.upsertObject).not.toHaveBeenCalled()
  })

  it.each(['ajax', 'public'] as const)('%s 二维目标同步删除再重加相同编号时，旧请求不能写入已删除组件', async (kind) => {
    const f = fixture(kind)
    await f.controller.start()
    const removed = f.widgets.totalWidgets![0]
    let complete!: (value: unknown) => void
    network.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve }))
    const pending = f.pass('widget', '7')
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'))
    f.widgets.totalWidgets = []
    const component = new InputConfig()
    component.dataConfig = removed.component.dataConfig
    f.widgets.totalWidgets = [{ id: removed.id, component }]
    await nextTick()
    complete({ data: { value: '已删除组件的旧响应' } })
    await pending
    expect(removed.component.option.value).toBe('数据0')
  })

  it('同一宿主切换到相同编号的新场景，清除旧传参并拒绝旧响应', async () => {
    const f = fixture('public')
    await f.controller.start()
    await f.pass('widget', '5')
    let complete!: (value: unknown) => void
    network.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve }))
    const pending = f.pass('object', '7')
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'))
    network.mockClear()
    f.scene.id = 'scene-b'
    f.emit('sceneLoaded')
    await f.controller.start()
    expect(network).toHaveBeenCalledTimes(1)
    expect(network.mock.calls[0][1]?.params).toMatchObject({ id: '0' })
    expect(f.widgets.totalWidgets![0].component.option.value).toBe('数据0')
    f.upsertObject.mockClear()
    complete({ data: { value: '旧场景迟到响应' } })
    await pending
    expect(f.widgets.totalWidgets![0].component.option.value).toBe('数据0')
    expect(f.upsertObject).not.toHaveBeenCalled()
  })

  it('新控制器启动后旧控制器才卸载，不得注销新场景传参入口或写回旧结果', async () => {
    const old = fixture()
    await old.controller.start()
    let complete!: (value: unknown) => void
    network.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve }))
    const pending = old.pass('object', '7')
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'))
    const current = fixture()
    await current.controller.start()
    old.controller.dispose()
    await current.pass('widget', '9')
    expect(current.widgets.totalWidgets![0].component.option.value).toBe('数据9')
    old.upsertObject.mockClear()
    complete({ data: { value: '已卸载场景的响应' } })
    await pending
    expect(old.upsertObject).not.toHaveBeenCalled()
    expect(current.widgets.totalWidgets![0].component.option.value).toBe('数据9')
  })

  it('连续进入退出后销毁，不遗留重建定时器或请求入口', async () => {
    vi.useFakeTimers()
    const f = fixture()
    await f.controller.start()
    for (let index = 0; index < 10; index += 1) {
      setWidgetPreviewState(true)
      await f.pass('widget', `${index + 1}`)
      setWidgetPreviewState(false)
      await f.controller.start()
    }
    f.controller.dispose()
    network.mockClear()
    await f.pass('widget', '99')
    await vi.runAllTimersAsync()
    expect(network).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['ajax', 'public'] as const)('%s 实际仓库批量删除及撤销时，旧请求失效且恢复目标重新请求', async (kind) => {
    const f = fixture(kind, true)
    await f.controller.start()
    let complete!: (value: unknown) => void
    network.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve }))
    const pending = f.pass('object', '7')
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'))
    // 结构面板即使只删除一个节点也使用批次接口，其事件不能用单对象删除替身代替。
    const removed = f.store.removeObjectBatch(new Set(['model']))
    f.upsertObject.mockClear()
    complete({ data: { value: '批量删除后的迟到响应' } })
    await pending
    expect(f.upsertObject).not.toHaveBeenCalled()
    expect(f.store.getObject('model')).toBeNull()
    network.mockClear()
    f.store.restoreObjectBatch(removed, undefined)
    await f.controller.start()
    expect(network).toHaveBeenCalledTimes(kind === 'ajax' ? 1 : 0)
    // 公共订阅恢复复用仍存活的二维订阅缓存；独立请求从配置参数0重新开始。
    if (kind === 'ajax') expect(network.mock.calls[0][1]?.params).toMatchObject({ id: '0' })
    expect(f.upsertObject).toHaveBeenCalledTimes(1)
  })
})
