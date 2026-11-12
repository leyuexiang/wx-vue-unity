import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSceneWidgetStore } from '@/stores/sceneEditStore'
import InputConfig from '@/packages/components/Control/VInput/config'
import type { SceneObject } from '@/scene-platform'
import {
  createEmptyDataConfig,
  createDataConfigRequestItem,
  createEmptyRequestGlobalConfig,
  getDataConfigRequests,
  type PublicRequestConfig,
} from '@/types/data-config'
import { buildParameterTargetOptions } from '@/utils/dataConfig/interactionRequestParameters'
import { SceneDataPollingRuntime } from '../sceneDataPollingRuntime'
import { getSceneRequestParameterSourceConfig } from '../sceneDataRequestActions'
import request from '@/request'

// 仅替换网络边界；共享调度、组件映射、模型快照和事件参数均使用实际实现。
vi.mock('@/request', () => ({ default: vi.fn() }))
vi.mock('@/auth/runtime', async (original) => ({
  ...(await original<typeof import('@/auth/runtime')>()),
  isEmbeddedMode: () => false,
}))
const network = vi.mocked(request)
const runtimes: SceneDataPollingRuntime[] = []
afterEach(() => {
  runtimes.splice(0).forEach((runtime) => runtime.dispose())
  vi.useRealTimers()
  vi.resetAllMocks()
})

/** 两个二维组件及一个模型引用相同公共接口，另一个组件引用独立接口。 */
const fixture = (interval = 0) => {
  const shared: PublicRequestConfig = {
    id: 'shared',
    name: '共享查询',
    requestUrl: '/shared',
    requestOriginUrl: '',
    requestHttpType: 'GET',
    requestInterval: interval,
    requestIntervalUnit: 'second',
    requestContentType: 'default',
    requestParamsBodyType: 'none',
    requestSQLContent: { sql: '' },
    requestParams: {
      Params: { id: '0', filter: 'all' },
      Header: {},
      Body: { json: '', xml: '', 'form-data': {}, 'x-www-form-urlencoded': {} },
    },
  }
  const definitions = [shared, { ...shared, id: 'other', requestUrl: '/other' }]
  const config = (publicId = 'shared') => {
    const result = createEmptyDataConfig()
    result.request = { type: 'public', config: { publicRequestId: publicId } }
    result.bindings = [
      { kind: 'widget', targetPath: 'value', sourceField: 'value', valueType: 'string' },
    ]
    return result
  }
  const widget = (id: string, publicId = 'shared') => {
    const component = new InputConfig()
    component.dataConfig = config(publicId)
    return { id, component }
  }
  const a = widget('a')
  const b = widget('b')
  const other = widget('other', 'other')
  const model: SceneObject = {
    id: 'model',
    name: '模型',
    type: 'model',
    visible: true,
    locked: false,
    order: 0,
    assetRefs: [],
    transform: { kind: 'local', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    metadata: { dataConfig: config() },
  }
  const widgets = useSceneWidgetStore()
  widgets.totalWidgets = [a, b, other]
  const applyObject = vi.fn()
  const objects = [model]
  network.mockImplementation(async (_url, options) => ({
    data: { value: `数据${(options?.params as Record<string, string>).id}` },
  }))
  const runtime = new SceneDataPollingRuntime({
    getSceneObjects: () => objects,
    getPublicRequests: () => definitions,
    getRequestGlobalConfig: createEmptyRequestGlobalConfig,
    applySceneObject: applyObject,
  })
  runtimes.push(runtime)
  const pass = (id: string, value: unknown, field = 'id') =>
    runtime.passParameters({
      targetKind: id === 'model' ? 'object' : 'widget',
      targetId: id,
      assignments: [
        {
          targetProperty: buildParameterTargetOptions(config(), definitions).find((option) =>
            option.label.endsWith(` · ${field}`),
          )!.value,
          value,
        },
      ],
    })
  return { a, b, other, model, objects, shared, definitions, runtime, widgets, widget, pass, applyObject }
}

describe('公共接口传参刷新全部订阅者', () => {
  it('共享响应在途时移除部分订阅，只更新存活目标；同编号恢复复用当前结果且不重复请求', async () => {
    const f = fixture()
    await f.runtime.start()
    let complete!: (value: unknown) => void
    network.mockClear()
    network.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve }))
    const pending = f.pass('a', 7)
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'))
    f.widgets.totalWidgets = [f.a, f.other]
    f.objects.splice(0)
    await f.runtime.start()
    f.applyObject.mockClear()
    complete({ data: { value: '共享新值' } })
    await pending
    expect(network).toHaveBeenCalledTimes(1)
    expect(f.a.component.option.value).toBe('共享新值')
    expect(f.b.component.option.value).toBe('数据0')
    expect(f.other.component.option.value).toBe('数据0')
    expect(f.applyObject).not.toHaveBeenCalled()
    expect(getSceneRequestParameterSourceConfig('model')).toBeNull()
    const restored = f.widget('b')
    f.widgets.totalWidgets = [...f.widgets.totalWidgets!, restored]
    f.objects.push(f.model)
    await f.runtime.start()
    // 剩余订阅保留共享响应缓存；恢复订阅只接收当前结果，不复活旧任务也不重发接口。
    expect(network).toHaveBeenCalledTimes(1)
    expect(restored.component.option.value).toBe('共享新值')
    expect(f.applyObject).toHaveBeenCalledTimes(1)
    expect(getSceneRequestParameterSourceConfig('model')?.dataset.source[0]).toEqual({ value: '共享新值' })
  })

  it('同一动作混合公共与独立请求参数时，各请求仅发送一次且相互隔离', async () => {
    const f = fixture()
    f.a.component.dataConfig!.requests!.push(
      createDataConfigRequestItem({
        id: 'local',
        name: '独立查询',
        request: { type: 'ajax', config: { ...f.shared, requestUrl: '/local' } },
      }),
    )
    await f.runtime.start()
    network.mockClear()
    await f.runtime.passParameters({
      targetKind: 'widget',
      targetId: 'a',
      assignments: [
        { targetProperty: '["request-1","Params",["id"],"shared"]', value: 1 },
        { targetProperty: '["local","Params",["id"]]', value: 2 },
      ],
    })
    expect(network.mock.calls.map(([url]) => url).sort()).toEqual(['/local', '/shared'])
    expect(network.mock.calls.find(([url]) => url === '/local')?.[1]?.params).toMatchObject({
      id: '2',
    })
    expect(f.b.component.option.value).toBe('数据1')
    expect(f.other.component.option.value).toBe('数据0')
  })

  it.each(['a', 'b', 'model'])(
    '从任意绑定目标 %s 传参，只请求一次并更新全部二维及三维订阅',
    async (target) => {
      const f = fixture()
      await f.runtime.start()
      const before = JSON.stringify(f.definitions)
      network.mockClear()
      await f.pass(target, '最新值')
      expect(network).toHaveBeenCalledTimes(1)
      expect(network.mock.calls[0][0]).toBe('/shared')
      expect(network.mock.calls[0][1]?.params).toMatchObject({ id: '最新值', filter: 'all' })
      expect(f.a.component.option.value).toBe('数据最新值')
      expect(f.b.component.option.value).toBe('数据最新值')
      expect(getSceneRequestParameterSourceConfig('model')?.dataset.source[0]).toEqual({
        value: '数据最新值',
      })
      expect(f.other.component.option.value).toBe('数据0')
      expect(JSON.stringify(f.definitions)).toBe(before)
      expect(f.a.component.dataConfig!.request.type).toBe('public')
    },
  )

  it('共享参数跨组件累积，轮询及新增订阅沿用新参数，退出会话后恢复配置', async () => {
    vi.useFakeTimers()
    const f = fixture(5)
    await f.runtime.start()
    await f.pass('a', 7)
    await f.pass('b', '', 'filter')
    const newcomer = f.widget('new')
    f.widgets.totalWidgets = [...f.widgets.totalWidgets!, newcomer]
    network.mockClear()
    await f.runtime.start()
    expect(network).not.toHaveBeenCalled()
    expect(newcomer.component.option.value).toBe('数据7')
    await vi.advanceTimersByTimeAsync(5000)
    expect(network.mock.calls.filter(([url]) => url === '/shared')).toHaveLength(1)
    expect(network.mock.calls.find(([url]) => url === '/shared')?.[1]?.params).toMatchObject({
      id: '7',
      filter: '',
    })
    f.runtime.stop()
    network.mockClear()
    await f.runtime.start()
    expect(network.mock.calls.find(([url]) => url === '/shared')?.[1]?.params).toMatchObject({
      id: '0',
      filter: 'all',
    })
  })

  it('公共首轮及连续传参的旧响应迟到时，不能覆盖最新组件结果或新增订阅缓存', async () => {
    const f = fixture()
    const pending: Array<(value: unknown) => void> = []
    network.mockImplementation(async (url) =>
      url === '/shared'
        ? new Promise((resolve) => pending.push(resolve))
        : { data: { value: '其它接口' } },
    )
    const initial = f.runtime.start()
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    const first = f.pass('a', 1)
    const latest = f.pass('b', 2)
    await vi.waitFor(() => expect(pending).toHaveLength(3))
    pending[2]({ data: { value: '最新响应' } })
    await latest
    pending[0]({ data: { value: '初始化旧响应' } })
    pending[1]({ data: { value: '第一次旧响应' } })
    await Promise.all([initial, first])
    expect(f.a.component.option.value).toBe('最新响应')
    expect(f.b.component.option.value).toBe('最新响应')
    expect(getSceneRequestParameterSourceConfig('model')?.dataset.source[0]).toEqual({
      value: '最新响应',
    })
    const newcomer = f.widget('new')
    f.widgets.totalWidgets = [...f.widgets.totalWidgets!, newcomer]
    await f.runtime.start()
    expect(pending).toHaveLength(3)
    expect(newcomer.component.option.value).toBe('最新响应')
  })

  it('公共接口被编辑后废弃会话覆盖，目标改绑后旧映射不发请求', async () => {
    const f = fixture()
    await f.runtime.start()
    await f.pass('a', 6)
    f.shared.requestParams.Params.id = '8'
    await f.runtime.start()
    expect(f.a.component.option.value).toBe('数据8')
    const staleTarget = buildParameterTargetOptions(f.a.component.dataConfig, f.definitions)[0]
      .value
    getDataConfigRequests(f.a.component.dataConfig)[0].request = {
      type: 'public',
      config: { publicRequestId: 'other' },
    }
    await f.runtime.start()
    network.mockClear()
    await f.runtime.passParameters({
      targetKind: 'widget',
      targetId: 'a',
      assignments: [{ targetProperty: staleTarget, value: 9 }],
    })
    expect(network).not.toHaveBeenCalled()
  })

  it('公共请求失败后仍可从另一个绑定目标重试并刷新全部组件', async () => {
    const f = fixture()
    await f.runtime.start()
    network.mockRejectedValueOnce(new Error('测试网络失败'))
    await f.pass('a', 1)
    expect(f.a.component.option.value).toBe('数据0')
    await f.pass('b', 2)
    expect(f.a.component.option.value).toBe('数据2')
    expect(f.b.component.option.value).toBe('数据2')
  })
})
