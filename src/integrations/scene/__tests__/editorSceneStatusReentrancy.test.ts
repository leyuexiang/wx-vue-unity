import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SceneObject, ViewportHost } from '@/scene-platform'
import { createSceneStore } from '@/scene-platform/store/sceneStore'
import { createSceneDefinition } from '@/scene-platform/core/sceneDefinition'
import { createEmptyDataConfig, type AjaxRequestConfig } from '@/types/data-config'
import type { InteractionEvent } from '@/types/threeScene'
import { ACTION_TYPE_ENUM, CONDITION_RULE_TYPE_ENUM, FIXED_VALUE_TYPE_ENUM, JUDGMENT_TYPE_ENUM, OBJECT_TYPE_ENUM } from '@/enums/scenePanelEnum'
import request from '@/request'
import { appLogger } from '@/utils/logger'
import { createEditorSceneObjectBehaviorRuntime } from '../editorSceneObjectBehaviorRuntime'
import { createEditorSceneDataPollingController } from '../editorSceneDataPollingController'
import { setWidgetPreviewState } from '../widgetRuntime/ports'

// 复用实际仓库、数据控制器、条件及动作链；仅网络和引擎确认使用受控边界。
vi.mock('@/request', () => ({ default: vi.fn() }))
vi.mock('@/auth/runtime', async (original) => ({
  ...(await original<typeof import('@/auth/runtime')>()), isEmbeddedMode: () => false,
}))
const network = vi.mocked(request)
const cleanups: Array<() => void> = []
afterEach(() => { cleanups.splice(0).forEach((cleanup) => cleanup()); setWidgetPreviewState(false); vi.restoreAllMocks(); vi.resetAllMocks() })
const drain = async () => { for (let index = 0; index < 250; index += 1) await Promise.resolve() }

const object = (id: string): SceneObject => ({ id, name: id, type: 'model', visible: true, locked: false, order: 0, assetRefs: [],
  transform: { kind: 'local', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } })
const hide = (id: string) => ({ id: `hide-${id}`, actionType: ACTION_TYPE_ENUM.ModelVisibility, actionTargetUuid: id, modelVisibility: false })

const fixture = async (options: { feedback?: boolean; target?: string; includeLow?: boolean; peer?: boolean } = {}) => {
  const dataConfig = createEmptyDataConfig()
  dataConfig.request = { type: 'ajax', config: {
    requestUrl: '/sensor', requestHttpType: 'GET', requestInterval: 0, requestIntervalUnit: 'second',
    requestParams: { Params: { id: '0' }, Header: {}, Body: {} },
  } as AjaxRequestConfig }
  const status = (id: string, threshold: number, judgmentType: JUDGMENT_TYPE_ENUM) => ({
    id, statusName: id, isOpen: true, conditionGroupList: [{ id: `group-${id}`, conditionBlokList: [{
      id: `block-${id}`, conditionRuleType: CONDITION_RULE_TYPE_ENUM.All,
      conditionList: [{ id: `condition-${id}`, status: true, sourceObjectType: OBJECT_TYPE_ENUM.ComponentDataValue,
        sourceComponentDataField: 'temperature', targetObjectType: OBJECT_TYPE_ENUM.FixedValue,
        targetFixedValueType: FIXED_VALUE_TYPE_ENUM.Number, targetFixedValue: threshold, judgmentType }],
      actionList: [{ id: `refresh-${id}`, actionType: ACTION_TYPE_ENUM.PassParameters, parameterTargetKind: 'model',
        actionTargetUuid: options.target ?? (options.peer ? 'peer' : 'sensor'), modelParameterMappings: [{ sourceField: 'next', targetProperty: '["request-1","Params",["id"]]' }] }, hide('target')],
    }] }],
  } as unknown as InteractionEvent)
  const sensor = { ...object('sensor'), metadata: { dataConfig,
    statusList: [status('high', 80, JUDGMENT_TYPE_ENUM.GreaterThan), ...(options.includeLow ? [status('low', 30, JUDGMENT_TYPE_ENUM.LessThan)] : [])],
    interactiveEvent: [{ id: 'click', eventName: '单击', eventType: 'click', isOpen: true,
      conditionGroupList: [{ id: 'group-click', conditionBlokList: [{ id: 'block-click', conditionList: [], conditionRuleType: null, actionList: [hide('target'), hide('next-target')] }] }],
    } as unknown as InteractionEvent],
  } }
  const objects = [sensor, object('target'), object('next-target')]
  if (options.peer) {
    const peer = structuredClone(sensor)
    peer.id = peer.name = 'peer'
    for (const rule of peer.metadata.statusList) {
      rule.conditionGroupList![0].conditionBlokList![0].actionList[0]!.actionTargetUuid = 'sensor'
    }
    objects.push(peer)
  }
  const store = createSceneStore(createSceneDefinition({ id: 'status-scene', name: '状态重入', type: 'local3d',
    coordinateSystem: { kind: 'local', unit: 'meter', upAxis: 'Y', gridEnabled: true }, objects }))
  let listener: ((event: { objectId: string; eventType: 'click' }) => void) | undefined
  const setObjectVisibleAsync = vi.fn(async (_id: string, _visible: boolean) => true)
  const runtime = {
    upsertObject: vi.fn(async (_object: SceneObject) => {}), setObjectVisibleAsync,
    subscribeObjectInteraction: (callback: typeof listener) => { listener = callback; return () => { listener = undefined } },
  }
  const host = { getStore: () => store, getRuntime: () => runtime } as unknown as ViewportHost
  const behavior = createEditorSceneObjectBehaviorRuntime({ getViewportHost: () => host })
  const controller = createEditorSceneDataPollingController({ getViewportHost: () => host,
    projectSceneObjectForRuntime: behavior.applyPreviewOverridesToSceneObject, onSceneObjectUpdated: behavior.observeSceneObject })
  cleanups.push(() => { controller.dispose(); behavior.dispose() })
  network.mockImplementation(async (_url, requestOptions) => {
    // 有界替身使失控的反馈链明确失败，不让回归占满微任务队列。
    if (network.mock.calls.length > 12) throw new Error('测试反馈链超过12次请求')
    const temperature = Number((requestOptions?.params as Record<string, string>).id) || 50
    return { data: { temperature, next: options.feedback && temperature >= 80 ? 20 : 90 } }
  })
  await controller.start()
  behavior.preparePreview()
  setWidgetPreviewState(true)
  await behavior.startPreview()
  const publish = (temperature: number, id = 'sensor') => {
    const current = structuredClone(store.getObject(id)!)
    const config = current.metadata!.dataConfig as ReturnType<typeof createEmptyDataConfig>
    const row = { temperature, next: options.feedback && temperature >= 80 ? 20 : 90 }
    config.dataset.source = [row]
    config.requests![0].dataset.source = [row]
    return behavior.observeSceneObject(current)
  }
  return { store, behavior, controller, setObjectVisibleAsync, publish, click: () => listener?.({ objectId: 'sensor', eventType: 'click' }) }
}

describe('三维状态反馈与真实批次生命周期', () => {
  it('状态动作刷新自身请求，响应回流评估后整条动作链能完成', async () => {
    const f = await fixture()
    let complete = false
    const work = f.publish(90).then(() => { complete = true })
    await drain()
    expect(network).toHaveBeenCalledTimes(2)
    expect(complete).toBe(true)
    await work
    expect(f.setObjectVisibleAsync).toHaveBeenCalledWith('target', false)
  })

  it('同一反馈链高低阈值互相刷新时有界终止，下一次外部变化仍能触发', async () => {
    const warning = vi.spyOn(appLogger, 'warn')
    const f = await fixture({ feedback: true, includeLow: true })
    let complete = false
    const work = f.publish(90).then(() => { complete = true })
    await drain()
    expect(complete).toBe(true)
    expect(network).toHaveBeenCalledTimes(3)
    expect(warning).toHaveBeenCalledTimes(1)
    await work
    const before = network.mock.calls.length
    await f.publish(50)
    const next = f.publish(90)
    await drain()
    await next
    expect(network.mock.calls.length).toBeGreaterThan(before)
  })

  it.each(['批次删除恢复', '单对象删除恢复', '场景重载', '运行时释放'] as const)('%s后旧引擎确认不能继续后续动作', async (ending) => {
    const f = await fixture()
    let confirm!: (applied: boolean) => void
    f.setObjectVisibleAsync.mockImplementationOnce(() => new Promise((resolve) => { confirm = resolve }))
    f.click()
    await drain()
    expect(f.setObjectVisibleAsync).toHaveBeenCalledTimes(1)
    if (ending === '批次删除恢复') {
      const removed = f.store.removeObjectBatch(new Set(['sensor']))
      f.store.restoreObjectBatch(removed, undefined)
    } else if (ending === '单对象删除恢复') {
      const removed = f.store.removeObject('sensor')!
      f.store.upsertObject(removed.removed)
    } else if (ending === '场景重载') {
      f.store.loadScene(structuredClone(f.store.getScene()))
    } else f.behavior.dispose()
    confirm(true)
    await drain()
    expect(f.setObjectVisibleAsync).toHaveBeenCalledTimes(1)
  })

  it('两个模型状态互相传参回流时不互相等待，独立规则仍各执行一次', async () => {
    const f = await fixture({ peer: true })
    let complete = false
    const work = f.publish(90).then(() => { complete = true })
    await drain()
    expect(complete).toBe(true)
    await work
    expect(network).toHaveBeenCalledTimes(4)
    expect(f.setObjectVisibleAsync).toHaveBeenCalledTimes(2)
  })

  it('退出后立即重进不等待旧状态请求，新预览不接受旧响应的后续动作', async () => {
    const f = await fixture()
    let respond!: (value: unknown) => void
    network.mockImplementationOnce(() => new Promise((resolve) => { respond = resolve }))
    const old = f.publish(90)
    await drain()
    expect(respond).toBeTypeOf('function')
    setWidgetPreviewState(false)
    f.behavior.exitPreview()
    f.behavior.preparePreview()
    setWidgetPreviewState(true)
    let ready = false
    const entering = f.behavior.startPreview().then(() => { ready = true })
    await drain()
    expect(ready).toBe(true)
    await entering
    const callsBefore = f.setObjectVisibleAsync.mock.calls.length
    respond({ data: { temperature: 90, next: 90 } })
    await drain()
    await old
    // 本用例直接驱动状态服务；实际退出还由数据控制器停止旧请求。这里检查旧动作链不再续跑。
    expect(f.setObjectVisibleAsync.mock.calls.length).toBe(callsBefore)
  })

  it('引擎确认等待中只合并最新数据，完成后继续读取最终快照并允许下一次阈值边沿', async () => {
    const f = await fixture()
    let confirm!: (applied: boolean) => void
    f.setObjectVisibleAsync.mockImplementationOnce(() => new Promise((resolve) => { confirm = resolve }))
    const work = f.publish(90)
    await drain()
    expect(confirm).toBeTypeOf('function')
    await f.publish(95)
    await f.publish(20)
    confirm(true)
    await drain()
    await work
    // 中间95不重复触发；最终20已让高阈值复位，后续90能够再执行一次。
    expect(network).toHaveBeenCalledTimes(2)
    await f.publish(90)
    expect(network).toHaveBeenCalledTimes(3)
  })

  it('批次删除无关对象不会取消仍存活来源的合法动作链', async () => {
    const f = await fixture()
    f.store.upsertObject(object('unrelated'))
    let confirm!: (applied: boolean) => void
    f.setObjectVisibleAsync.mockImplementationOnce(() => new Promise((resolve) => { confirm = resolve }))
    f.click()
    await drain()
    f.store.removeObjectBatch(new Set(['unrelated']))
    confirm(true)
    await drain()
    expect(f.setObjectVisibleAsync.mock.calls).toEqual([['target', false], ['next-target', false]])
  })

  it('预览中改变请求配置的首轮高温响应，可以触发刷新自身而不等待自身初始化', async () => {
    const f = await fixture()
    const sensor = structuredClone(f.store.getObject('sensor')!)
    const config = sensor.metadata!.dataConfig as ReturnType<typeof createEmptyDataConfig>
    ;(config.requests![0].request.config as AjaxRequestConfig).requestParams.Params.id = '90'
    f.store.upsertObject(sensor)
    let complete = false
    const work = f.controller.start().then(() => { complete = true })
    await drain()
    expect(complete).toBe(true)
    await work
    expect(f.setObjectVisibleAsync).toHaveBeenCalledWith('target', false)
    expect(network.mock.calls.length).toBeLessThanOrEqual(3)
  })

  it('其他对象仍有慢请求时，已完成对象的新阈值边沿不会被旧反馈集合压制', async () => {
    const f = await fixture({ peer: true })
    let respond!: (value: unknown) => void
    network.mockImplementationOnce(() => new Promise((resolve) => { respond = resolve }))
    const slow = f.publish(90, 'peer')
    await drain()
    expect(respond).toBeTypeOf('function')
    await f.publish(90)
    await f.publish(50)
    const before = network.mock.calls.length
    await f.publish(90)
    expect(network.mock.calls.length).toBe(before + 1)
    respond({ data: { temperature: 90, next: 90 } })
    await drain()
    await slow
  })
})
