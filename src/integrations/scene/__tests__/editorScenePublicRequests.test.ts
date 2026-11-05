import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createSceneDefinition, createViewportHost, type ViewportHost } from '@/scene-platform'
import { createEmptyDataConfig, createEmptyRequestGlobalConfig, type PublicRequestConfig } from '@/types/data-config'
import { createEmptyPublicRequest } from '@/views/sceneEdit/SceneRightPanel/components/RightDataPanel/rightDataPanelDataHelpers'
import TextConfig from '@/packages/components/Widget/TextCommon/config'
import { useSceneRequestStore, useSceneWidgetStore } from '@/stores/sceneEditStore'
import { clearActiveSceneViewportHost, setActiveSceneViewportHost } from '../editorScenePlatformHost'
import { updateEditorScenePublicRequests } from '../editorScenePublicRequestAdapter'
import { dispatchEditorHistory } from '../editorSceneUndoRedoAdapter'
import { createEditorSceneSaveStateTracker } from '../editorSceneSaveState'
import { serializeSceneDefinitionToFourPackages, type SceneFourPackagePayload } from '../sceneFourPackage'
import { saveEditorSceneDefinition } from '../editorSceneSaveAdapter'
import { retainOriginalScenePackages, releaseOriginalScenePackages } from '../twoDPackagePreservation'

const sceneId = '8151'
const publicRequest = (id: string, name: string): PublicRequestConfig => ({ ...createEmptyPublicRequest(), id, name })
const binding = (id: string | null) => {
  const config = createEmptyDataConfig()
  config.request = { type: 'public', config: { publicRequestId: id } }
  return config
}
let active: ViewportHost | undefined
const setup = async () => {
  setActivePinia(createPinia())
  const scene = createSceneDefinition({
    id: sceneId, name: '公共请求联合历史', type: 'local3d',
    coordinateSystem: { kind: 'local', unit: 'meter', upAxis: 'Y', gridEnabled: true },
    objects: [{ id: 'node', name: '模型', type: 'group', visible: true, locked: false, order: 0,
      transform: { kind: 'local', position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 },
      metadata: { dataConfig: binding(null) } }],
  })
  const host = createViewportHost({ container: {} as HTMLElement, scene })
  active = host
  await host.mount()
  setActiveSceneViewportHost(host)
  const widgets = useSceneWidgetStore()
  const component = new TextConfig()
  component.dataConfig = binding(null)
  widgets.totalWidgets = [{ id: 'widget', component }]
  const tracker = createEditorSceneSaveStateTracker()
  tracker.bindStore(host.getStore(), host.getCommandBus())
  return { host, widgets, requests: useSceneRequestStore(), store: host.getStore(),
    commandBus: host.getCommandBus(), onError: vi.fn(), tracker }
}
afterEach(() => {
  clearActiveSceneViewportHost()
  active?.dispose()
  releaseOriginalScenePackages(sceneId)
  vi.restoreAllMocks()
})

describe('公共请求列表和实例绑定的联合历史', () => {
  it('新增和当前二维绑定只登记一步，撤销重做及正式保存保持同一请求编号', async () => {
    const options = await setup()
    const { requests, widgets, commandBus, tracker } = options
    const request = publicRequest('public-a', '接口甲')
    const defaults = { ...createEmptyRequestGlobalConfig(), requestOriginUrl: 'https://example.test' }
    try {
      expect(await updateEditorScenePublicRequests([request], { kind: 'widget', id: 'widget', dataConfig: binding(request.id) }, defaults)).toBe(true)
      expect(commandBus.getUndoSize()).toBe(1)
      expect(tracker.getSnapshot()).toMatchObject({ dirty: true, revision: 1 })
      expect(await dispatchEditorHistory('undo', options)).toBe(true)
      expect(requests.scenePublicRequestList).toEqual([])
      expect(requests.sceneRequestGlobalConfig).toEqual(createEmptyRequestGlobalConfig())
      expect(widgets.getWidgetById('widget')?.component.dataConfig?.request.config).toEqual({ publicRequestId: null })
      expect(await dispatchEditorHistory('redo', options)).toBe(true)
      expect(requests.scenePublicRequestList).toEqual([request])
      expect(requests.sceneRequestGlobalConfig).toEqual(defaults)
      expect(widgets.getWidgetById('widget')?.component.dataConfig?.request.config).toEqual({ publicRequestId: 'public-a' })
      const saveAll = vi.fn(async (_body: SceneFourPackagePayload) => ({ code: 200, data: { sceneId, conflict: false } }))
      await saveEditorSceneDefinition({ saveContext: { sceneId, lockToken: 'test' }, dim3dSaveOptions: { saveAll } })
      const body = saveAll.mock.lastCall![0]
      expect(JSON.parse(body.sceneJson).publicRequests).toEqual([expect.objectContaining({ publicRequestKey: 'public-a' })])
      expect(JSON.parse(body.dependenciesJson).dataBindings).toContainEqual(expect.objectContaining({
        owner: expect.objectContaining({ instanceId: 'widget' }),
        source: expect.objectContaining({ publicRequestKey: 'public-a' }),
      }))
      // 模拟原档已包含公共接口及绑定，删除后不能被保全逻辑重新补回。
      retainOriginalScenePackages(sceneId, {
        sceneJson: body.sceneJson, threeDJson: body.threeDJson,
        twoDJson: body.twoDJson, dependenciesJson: body.dependenciesJson,
      })
      expect(await updateEditorScenePublicRequests([], { kind: 'widget', id: 'widget', dataConfig: binding(null) })).toBe(true)
      expect(commandBus.getUndoSize()).toBe(2)
      expect(requests.scenePublicRequestList).toEqual([])
      expect(await dispatchEditorHistory('undo', options)).toBe(true)
      expect(requests.scenePublicRequestList[0]?.id).toBe('public-a')
      expect(widgets.getWidgetById('widget')?.component.dataConfig?.request.config).toEqual({ publicRequestId: 'public-a' })
      const steps = commandBus.getUndoSize()
      const changedRequest = { ...request, name: '改名接口', requestUrl: '/changed' }
      expect(await updateEditorScenePublicRequests([changedRequest])).toBe(true)
      expect(commandBus.getUndoSize()).toBe(steps + 1)
      expect(await dispatchEditorHistory('undo', options)).toBe(true)
      expect(requests.scenePublicRequestList).toEqual([request])
    } finally { tracker.dispose() }
  })

  it('其他实例或原档中的绑定阻止删除，联合写入整体回退', async () => {
    const options = await setup()
    const { requests, store, widgets, commandBus, tracker } = options
    const request = publicRequest('shared', '共享接口')
    requests.setScenePublicRequestList([request])
    store.upsertObject({ ...store.getObject('node')!, metadata: { dataConfig: binding('shared') } })
    const beforeWidgets = widgets.createWidgetHistorySnapshot(['widget'])
    const revision = tracker.getSnapshot().revision
    try {
      await expect(updateEditorScenePublicRequests([], { kind: 'widget', id: 'widget', dataConfig: binding(null) }))
        .rejects.toThrow('仍被其他')
      expect(requests.scenePublicRequestList).toEqual([request])
      expect(widgets.createWidgetHistorySnapshot(['widget'])).toEqual(beforeWidgets)
      expect(commandBus.getUndoSize()).toBe(0)
      expect(tracker.getSnapshot().revision).toBe(revision)

      const original = serializeSceneDefinitionToFourPackages(store.getScene())
      const dependencies = JSON.parse(original.dependenciesJson)
      dependencies.dataBindings.push({ bindingKey: 'opaque', owner: { domain: 'threeD', ownerType: 'instance', instanceId: 'unloaded' },
        source: { type: 'public', publicRequestKey: 'shared' } })
      retainOriginalScenePackages(sceneId, { ...original, dependenciesJson: JSON.stringify(dependencies) })
      await expect(updateEditorScenePublicRequests([], { kind: 'sceneObject', id: 'node', dataConfig: binding(null) }))
        .rejects.toThrow('仍被其他')
      expect(requests.scenePublicRequestList).toEqual([request])
      expect(store.getObject('node')?.metadata?.dataConfig).toEqual(binding('shared'))
      expect(commandBus.getUndoSize()).toBe(0)
    } finally { tracker.dispose() }
  })

  it('三维绑定的运行端确认失败恢复公共列表、草稿、历史和保存范围', async () => {
    const options = await setup()
    const { host, store, requests, commandBus, tracker } = options
    const edits = store.captureSaveEdits()
    vi.spyOn(host.getRuntime(), 'upsertObject').mockRejectedValueOnce(new Error('三维拒绝'))
    try {
      await expect(updateEditorScenePublicRequests([publicRequest('new', '新接口')], {
        kind: 'sceneObject', id: 'node', dataConfig: binding('new'),
      })).rejects.toThrow('三维拒绝')
      expect(requests.scenePublicRequestList).toEqual([])
      expect(store.getObject('node')?.metadata?.dataConfig).toEqual(binding(null))
      expect(store.captureSaveEdits()).toEqual(edits)
      expect(commandBus.getUndoSize()).toBe(0)
      expect(tracker.getSnapshot().dirty).toBe(false)
    } finally { tracker.dispose() }
  })

  it('本地快照写入失败时恢复公共列表及默认配置', async () => {
    const { requests, widgets, commandBus, tracker } = await setup()
    vi.spyOn(widgets, 'applyWidgetHistorySnapshot').mockImplementationOnce(() => { throw new Error('快照写入失败') })
    const defaults = { ...createEmptyRequestGlobalConfig(), requestOriginUrl: '/new-origin' }
    try {
      await expect(updateEditorScenePublicRequests([publicRequest('new', '新接口')], {
        kind: 'widget', id: 'widget', dataConfig: binding('new'),
      }, defaults)).rejects.toThrow('快照写入失败')
      expect(requests.scenePublicRequestList).toEqual([])
      expect(requests.sceneRequestGlobalConfig).toEqual(createEmptyRequestGlobalConfig())
      expect(commandBus.getUndoSize()).toBe(0)
      expect(tracker.getSnapshot().dirty).toBe(false)
    } finally { tracker.dispose() }
  })
})
