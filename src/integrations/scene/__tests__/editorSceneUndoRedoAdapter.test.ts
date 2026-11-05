import { createPinia, setActivePinia } from 'pinia'
import BaseWidgetConfig from '@/packages/components/BaseWidgetConfig'
import { useSceneRequestStore, useSceneStore, useSceneWidgetStore } from '@/stores/sceneEditStore'
import { createEmptyDataConfig, createEmptyRequestGlobalConfig } from '@/types/data-config'
import { getWidgetDataConfigById, setWidgetDataConfigById } from '@/utils/dataConfig'
import { createCommandBusWidgetCommandPort } from '../widgetRuntime/commandBusWidgetCommandAdapter'
import { resetWidgetRuntimePorts, setWidgetCommandPort } from '../widgetRuntime/ports'
import { reactive } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSceneDefinition, createViewportHost, createCreateObjectCommand, createUpdateObjectLayerCommand, createUpdateObjectTransformCommand, type ViewportHost } from '@/scene-platform'
import { clearActiveSceneViewportHost, setActiveSceneViewportHost } from '../editorScenePlatformHost'
import { runConfirmedEditorCommand } from '../editorSceneCommandTransaction'
import { createEditorSceneSaveStateTracker } from '../editorSceneSaveState'
import { updateEditorSceneRequestGlobalConfig } from '../editorSceneGlobalStateAdapter'
import { ensureEditorSceneObjectLayersInStore } from '../editorSceneLayerAdapter'
import { beginEditorSceneOperation, editorSceneOperation, editorSceneRecovery, subscribeEditorSceneBeforeOperation } from '../editorSceneOperationGate'
import { dispatchEditorHistory, getEditorUndoRedoState } from '../editorSceneUndoRedoAdapter'
import { commitSceneStageSizeChange } from '../sceneStage'

const hosts: ViewportHost[] = []
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
const setup = async () => {
  const scene = createSceneDefinition({ id: 'history', name: '历史检查', type: 'local3d',
    coordinateSystem: { kind: 'local', unit: 'meter', upAxis: 'Y', gridEnabled: true } })
  const host = createViewportHost({ container: {} as HTMLElement, scene })
  hosts.push(host)
  await host.mount()
  setActiveSceneViewportHost(host)
  host.getCommandBus().execute(createCreateObjectCommand({ id: 'node', name: '节点', type: 'group',
    visible: true, locked: false, order: 0,
    transform: { kind: 'local', position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } }))
  await host.getBridge().flush()
  return { host, commandBus: host.getCommandBus(), onApplied: vi.fn(), onError: vi.fn() }
}

afterEach(() => {
  clearActiveSceneViewportHost()
  hosts.splice(0).forEach((host) => host.dispose())
  resetWidgetRuntimePorts()
  vi.restoreAllMocks()
})

describe('统一历史回放入口', () => {
  it('两个入口交替撤销重做，等待回放同步后各通知一次', async () => {
    const options = await setup()
    const completion = deferred()
    vi.spyOn(options.host.getBridge(), 'flush').mockResolvedValueOnce(undefined).mockReturnValueOnce(completion.promise)
    const undo = dispatchEditorHistory('undo', options)
    await vi.waitFor(() => expect(options.host.getStore().getObject('node')).toBeNull())
    expect(options.commandBus.getUndoSize()).toBe(1)
    expect(options.commandBus.getRedoSize()).toBe(0)
    expect(options.onApplied).not.toHaveBeenCalled()
    expect(getEditorUndoRedoState(options)).toMatchObject({ canUndo: false, canRedo: false })
    expect(await dispatchEditorHistory('redo', options)).toBe(false)
    completion.resolve()
    expect(await undo).toBe(true)
    expect(options.host.getStore().getObject('node')).toBeNull()
    // 工具栏用ref持有总线，快捷键直接从宿主读取，二者必须均可回放。
    expect(await dispatchEditorHistory('redo', { ...options, commandBus: reactive(options.commandBus) })).toBe(true)
    expect(options.host.getStore().getObject('node')).not.toBeNull()
    expect(options.onApplied).toHaveBeenCalledTimes(2)
    expect(options.onError).not.toHaveBeenCalled()
    expect(editorSceneOperation.value).toBeNull()
  })

  it('先排空已有编辑，再回放，保存门禁期间不改变历史', async () => {
    const options = await setup()
    const release = beginEditorSceneOperation('save')
    try {
      expect(await dispatchEditorHistory('undo', options)).toBe(false)
      expect(options.commandBus.getUndoSize()).toBe(1)
    } finally { release() }
    const drain = deferred()
    vi.spyOn(options.host.getBridge(), 'flush').mockReturnValueOnce(drain.promise)
    const undo = dispatchEditorHistory('undo', options)
    expect(options.commandBus.getUndoSize()).toBe(1)
    drain.resolve()
    expect(await undo).toBe(true)
  })

  it('同一三维字段保留首笔基线，保存先结算同一会话，再切开下一笔', async () => {
    const options = await setup()
    const { commandBus, host } = options
    const store = host.getStore()
    commandBus.clear()
    const positionX = Symbol('位置 X')
    const commit = (x: number, y: number, session?: symbol) => {
      commandBus.execute(createUpdateObjectTransformCommand('node', {
        kind: 'local', position: [x, y, 0], rotation: [0, 0, 0], scale: 1,
      }, session))
    }
    commit(1, 0, positionX)
    const stop = subscribeEditorSceneBeforeOperation(() => commit(2, 0, positionX))
    try {
      const release = beginEditorSceneOperation('save')
      try {
        expect(commandBus.getUndoSize()).toBe(1)
        expect(store.getObject('node')?.transform).toMatchObject({ position: [2, 0, 0] })
      } finally { release() }
    } finally { stop() }
    commit(3, 0, positionX)
    commit(3, 5, Symbol('位置 Y'))
    expect(commandBus.getUndoSize()).toBe(3)
    expect(await dispatchEditorHistory('undo', options)).toBe(true)
    expect(store.getObject('node')?.transform).toMatchObject({ position: [3, 0, 0] })
    expect(await dispatchEditorHistory('undo', options)).toBe(true)
    expect(store.getObject('node')?.transform).toMatchObject({ position: [2, 0, 0] })
    expect(await dispatchEditorHistory('undo', options)).toBe(true)
    expect(store.getObject('node')?.transform).toMatchObject({ position: [0, 0, 0] })
    expect(await dispatchEditorHistory('redo', options)).toBe(true)
    expect(store.getObject('node')?.transform).toMatchObject({ position: [2, 0, 0] })

    // Unity 每次拖动结束后提交完整变换，各自独立入栈。
    commit(4, 0)
    commit(6, 0)
    expect(commandBus.getUndoSize()).toBe(3)
    expect(commandBus.getRedoSize()).toBe(0)
    expect(await dispatchEditorHistory('undo', options)).toBe(true)
    expect(store.getObject('node')?.transform).toMatchObject({ position: [4, 0, 0] })
  })

  it('二维数字输入按会话和部件合并，撤销重做使用首末快照', async () => {
    const options = await setup()
    options.commandBus.clear()
    setActivePinia(createPinia())
    const widgets = useSceneWidgetStore()
    widgets.totalWidgets = ['first', 'second'].map((id) => ({ id, component: new BaseWidgetConfig() }))
    setWidgetCommandPort(createCommandBusWidgetCommandPort(() => options.commandBus))
    const session = Symbol('部件左边距')
    const update = (id: string, value: number) => widgets.runWidgetHistoryChange('更新部件位置与尺寸', [id], () => {
      widgets.getWidgetById(id)!.component.attr.l = value
    }, { mergeSession: session })
    update('first', 12)
    update('first', 30)
    update('second', 10)
    expect(options.commandBus.getUndoSize()).toBe(2)
    expect(await dispatchEditorHistory('undo', options)).toBe(true)
    expect(widgets.getWidgetById('first')?.component.attr.l).toBe(30)
    expect(widgets.getWidgetById('second')?.component.attr.l).toBe(0)
    expect(await dispatchEditorHistory('undo', options)).toBe(true)
    expect(widgets.getWidgetById('first')?.component.attr.l).toBe(0)
    expect(await dispatchEditorHistory('redo', options)).toBe(true)
    expect(widgets.getWidgetById('first')?.component.attr.l).toBe(30)
    update('first', 55)
    expect(options.commandBus.getUndoSize()).toBe(2)
    expect(options.commandBus.getRedoSize()).toBe(0)
  })

  it('空栈和非活动场景不触发回放或完成通知', async () => {
    const options = await setup()
    options.commandBus.clear()
    expect(await dispatchEditorHistory('undo', options)).toBe(false)
    const another = await setup()
    expect(await dispatchEditorHistory('undo', options)).toBe(false)
    expect(another.commandBus.getUndoSize()).toBe(1)
    expect(options.onApplied).not.toHaveBeenCalled()
    expect(editorSceneOperation.value).toBeNull()
  })

  it('先登记待提交的二维属性，再判断历史是否可撤销', async () => {
    const options = await setup()
    options.commandBus.clear()
    setActivePinia(createPinia())
    const store = useSceneWidgetStore()
    const component = new BaseWidgetConfig()
    component.option = { label: '原名称' }
    store.totalWidgets = [{ id: 'widget', component }]
    setWidgetCommandPort(createCommandBusWidgetCommandPort(() => options.commandBus))
    let pending = true
    const stop = subscribeEditorSceneBeforeOperation(() => {
      if (!pending) return
      pending = false
      store.runWidgetHistoryChange('更新部件名称', ['widget'], () => {
        store.getWidgetById('widget')!.component.option = { label: '新名称' }
      })
    })
    try {
      expect(await dispatchEditorHistory('undo', options)).toBe(true)
      expect(store.getWidgetById('widget')?.component.option).toEqual({ label: '原名称' })
      expect(options.commandBus.getRedoSize()).toBe(1)
    } finally { stop() }
  })

  it('同步命令失败保持栈位置，统一报告错误并释放门禁', async () => {
    const options = await setup()
    options.commandBus.execute({ name: '失败回放', execute: () => {}, undo: () => { throw new Error('无法恢复') } })
    expect(await dispatchEditorHistory('undo', options)).toBe(false)
    expect(options.commandBus.getUndoSize()).toBe(2)
    expect(options.commandBus.getRedoSize()).toBe(0)
    expect(options.onError).toHaveBeenCalledWith(expect.objectContaining({ message: '无法恢复' }))
    expect(options.onApplied).not.toHaveBeenCalled()
    expect(editorSceneOperation.value).toBeNull()
  })

  it('运行端同步失败只发出错误，不误发完成通知', async () => {
    const options = await setup()
    vi.spyOn(options.host.getBridge(), 'flush').mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('运行端失败'))
    expect(await dispatchEditorHistory('undo', options)).toBe(false)
    expect(options.onError).toHaveBeenCalledTimes(1)
    expect(options.onApplied).not.toHaveBeenCalled()
    expect(editorSceneOperation.value).toBeNull()
  })

  it('撤销同步失败恢复节点、选中与干净状态，历史栈保留原位置', async () => {
    const options = await setup()
    const tracker = createEditorSceneSaveStateTracker()
    tracker.bindStore(options.host.getStore(), options.commandBus)
    options.host.getStore().setSelectedObjectId('node')
    vi.spyOn(options.host.getBridge(), 'flush').mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('确认失败'))
    expect(await dispatchEditorHistory('undo', options)).toBe(false)
    expect(options.host.getStore().getObject('node')).not.toBeNull()
    expect(options.host.getStore().getSelectedObjectId()).toBe('node')
    expect(options.commandBus.getUndoSize()).toBe(1)
    expect(options.commandBus.getRedoSize()).toBe(0)
    expect(tracker.getSnapshot().dirty).toBe(false)
    expect(await dispatchEditorHistory('undo', options)).toBe(true)
    tracker.dispose()
  })

  it('图层与设置写入标记未保存，加载补齐、选择和清空历史不改变保存基线', async () => {
    const { host, commandBus } = await setup()
    const store = host.getStore()
    const tracker = createEditorSceneSaveStateTracker()
    tracker.bindStore(store, commandBus)
    try {
      ensureEditorSceneObjectLayersInStore(store)
      store.setSelectedObjectId('node')
      expect(tracker.getSnapshot()).toMatchObject({ dirty: false, revision: 0 })

      commandBus.execute(createUpdateObjectLayerCommand(store.getLayers()[0]!.id, { visible: false }))
      expect(tracker.getSnapshot()).toMatchObject({ dirty: true, revision: 1 })
      tracker.bindStore(store, commandBus)
      expect(tracker.getSnapshot()).toMatchObject({ dirty: true, revision: 1 })

      tracker.beginSave()
      store.updateSceneSettings({ ...store.getScene().settings, mediaServerId: 'latest' })
      tracker.markSaved()
      commandBus.clear()
      expect(tracker.getSnapshot()).toMatchObject({ dirty: true, revision: 2, savedRevision: 1 })
      tracker.beginSave()
      tracker.markSaved()
      expect(tracker.getSnapshot().dirty).toBe(false)

      // 同编号重载后，旧保存回执不能清除新草稿的未保存状态。
      tracker.beginSave()
      await host.replaceScene(store.getScene())
      store.updateSceneSettings({ ...store.getScene().settings, mediaServerId: 'after-reload' })
      expect(tracker.markSaved()).toMatchObject({ dirty: true, savedRevision: 0, revision: 1 })
    } finally { tracker.dispose() }
  })

  it('舞台、二维数据和全局请求共用历史及脏状态，回放后的配置重新读取仓库', async () => {
    const options = await setup()
    setActivePinia(createPinia())
    const { host, commandBus } = options
    const tracker = createEditorSceneSaveStateTracker()
    tracker.bindStore(host.getStore(), commandBus)
    const widgets = useSceneWidgetStore()
    widgets.totalWidgets = [{ id: 'widget', component: new BaseWidgetConfig() }]
    setWidgetCommandPort(createCommandBusWidgetCommandPort(() => commandBus))
    try {
      expect(getWidgetDataConfigById('widget')).toBeNull()
      const config = createEmptyDataConfig()
      setWidgetDataConfigById('widget', config)
      expect(getWidgetDataConfigById('widget')).not.toBeNull()
      expect(tracker.getSnapshot()).toMatchObject({ dirty: true, revision: 1 })
      commitSceneStageSizeChange({ width: 1664, height: 936 })
      expect(tracker.getSnapshot().revision).toBe(2)

      const request = { ...createEmptyRequestGlobalConfig(), requestOriginUrl: 'https://example.test' }
      expect(updateEditorSceneRequestGlobalConfig(request)).toBe(true)
      expect(updateEditorSceneRequestGlobalConfig(request)).toBe(false)
      expect(tracker.getSnapshot().revision).toBe(3)
      expect(useSceneRequestStore().sceneRequestGlobalConfig).toEqual(request)
      tracker.beginSave()
      tracker.markSaved()
      expect(await dispatchEditorHistory('undo', options)).toBe(true)
      expect(useSceneRequestStore().sceneRequestGlobalConfig).toEqual(createEmptyRequestGlobalConfig())
      expect(tracker.getSnapshot()).toMatchObject({ dirty: true, revision: 4 })
      expect(await dispatchEditorHistory('undo', options)).toBe(true)
      expect(await dispatchEditorHistory('undo', options)).toBe(true)
      expect(getWidgetDataConfigById('widget')).toBeNull()
      expect(tracker.getSnapshot().revision).toBe(6)
      expect(await dispatchEditorHistory('redo', options)).toBe(true)
      expect(getWidgetDataConfigById('widget')).not.toBeNull()
      expect(tracker.getSnapshot().revision).toBe(7)
    } finally { tracker.dispose() }
  })

  it('失败的新命令保留原重做分支，补偿失败后可显式重试', async () => {
    const options = await setup()
    options.commandBus.undo()
    await options.host.getBridge().flush()
    const command = createCreateObjectCommand({ id: 'new', name: '新节点', type: 'group',
      visible: true, locked: false, order: 0,
      transform: { kind: 'local', position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } })
    vi.spyOn(options.host.getBridge(), 'flush').mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('失败'))
    const resync = vi.spyOn(options.host.getBridge(), 'resync').mockRejectedValueOnce(new Error('恢复网络失败'))
    await expect(runConfirmedEditorCommand(options.host, 'execute', command, () => true)).rejects.toThrow('重试恢复')
    expect(editorSceneOperation.value).toBe('historyRecovery')
    expect(() => beginEditorSceneOperation('save')).toThrow()
    expect(() => options.commandBus.redo()).toThrow('等待')
    expect(options.commandBus.getRedoSize()).toBe(1)
    expect(options.commandBus.getUndoSize()).toBe(0)
    expect(await editorSceneRecovery.value?.retry()).toBe(true)
    expect(resync).toHaveBeenCalledTimes(2)
    expect(editorSceneOperation.value).toBeNull()
    expect(options.host.getStore().getObject('new')).toBeNull()
    expect(await dispatchEditorHistory('redo', options)).toBe(true)
  })

  it('重做失败仍保留重做位置，成功重试才提交', async () => {
    const options = await setup()
    options.commandBus.undo()
    await options.host.getBridge().flush()
    vi.spyOn(options.host.getBridge(), 'flush').mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('失败'))
    expect(await dispatchEditorHistory('redo', options)).toBe(false)
    expect(options.commandBus.getRedoSize()).toBe(1)
    expect(options.host.getStore().getObject('node')).toBeNull()
    expect(await dispatchEditorHistory('redo', options)).toBe(true)
  })

  it('反向命令失败可重试，成功恢复后不重复回放', async () => {
    const options = await setup()
    let restores = 0
    const command = { name: '恢复失败', execute: () => {}, undo: () => {
      restores++
      if (restores === 1) throw new Error('反向失败')
    } }
    vi.spyOn(options.host.getBridge(), 'flush').mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('确认失败'))
    await expect(runConfirmedEditorCommand(options.host, 'execute', command, () => true)).rejects.toThrow('重试恢复')
    expect(await editorSceneRecovery.value?.retry()).toBe(true)
    expect(restores).toBe(2)
    expect(options.commandBus.getUndoSize()).toBe(1)
    expect(editorSceneRecovery.value).toBeNull()
  })

  it('同宿主重新载入相同场景编号，迟到确认不能提交旧事务', async () => {
    const options = await setup()
    const completion = deferred()
    const flush = vi.spyOn(options.host.getBridge(), 'flush').mockResolvedValueOnce(undefined).mockReturnValueOnce(completion.promise)
    const undo = dispatchEditorHistory('undo', options)
    await vi.waitFor(() => expect(options.host.getStore().getObject('node')).toBeNull())
    flush.mockRestore()
    await options.host.replaceScene(createSceneDefinition({ id: 'history', name: '新草稿', type: 'local3d',
      coordinateSystem: { kind: 'local', unit: 'meter', upAxis: 'Y', gridEnabled: true } }))
    completion.resolve()
    expect(await undo).toBe(false)
    expect(options.commandBus.getUndoSize()).toBe(0)
    expect(options.host.getStore().getScene().name).toBe('新草稿')
    expect(options.onApplied).not.toHaveBeenCalled()
  })

  it('二维仓库回放部分写入后失败，恢复配置及原历史位置', async () => {
    setActivePinia(createPinia())
    const options = await setup()
    const widgets = useSceneWidgetStore()
    const component = new BaseWidgetConfig()
    component.option = { title: '原值' }
    const other = new BaseWidgetConfig()
    widgets.totalWidgets = [{ id: 'widget', component }, { id: 'other', component: other }]
    widgets.setWidgetLayerTree([{ id: 'widget', type: 'widget' }, { id: 'other', type: 'widget' }])
    setWidgetCommandPort(createCommandBusWidgetCommandPort(() => options.commandBus))
    widgets.runWidgetHistoryChange('二维编辑', ['widget'], () => { component.option.title = '新值' })
    const unrelated = widgets.getWidgetById('other')
    const refresh = vi.spyOn(useSceneStore(), 'setTransformMaterialRandomId')
      .mockImplementationOnce(() => { throw new Error('二维刷新失败') })
    const resync = vi.spyOn(options.host.getBridge(), 'resync')
    expect(await dispatchEditorHistory('undo', options)).toBe(false)
    expect(widgets.getWidgetById('widget')?.component.option.title).toBe('新值')
    expect(widgets.getWidgetById('other')).toBe(unrelated)
    expect(options.commandBus.getUndoSize()).toBe(2)
    expect(options.commandBus.getRedoSize()).toBe(0)
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(resync).not.toHaveBeenCalled()
    expect(await dispatchEditorHistory('undo', options)).toBe(true)
    expect(widgets.getWidgetById('widget')?.component.option.title).toBe('原值')
  })

  it('Unity桥接失败时按统一栈回放二维部件和舞台，轮到三维命令才等待桥接', async () => {
    setActivePinia(createPinia())
    const options = await setup()
    const widgets = useSceneWidgetStore()
    const component = new BaseWidgetConfig()
    component.option = { title: '原值' }
    widgets.totalWidgets = [{ id: 'widget', component }]
    widgets.setWidgetLayerTree([{ id: 'widget', type: 'widget' }])
    setWidgetCommandPort(createCommandBusWidgetCommandPort(() => options.commandBus))
    const originalSize = widgets.getWidgetCanvasConfig()
    widgets.runWidgetHistoryChange('二维编辑', ['widget'], () => { component.option.title = '新值' })
    const nextSize = commitSceneStageSizeChange({ width: 1280, height: 720 })
    const flush = vi.spyOn(options.host.getBridge(), 'flush').mockRejectedValue(new Error('Unity桥接不可用'))
    const storeTransaction = vi.spyOn(options.host.getStore(), 'runTransaction')

    expect(await dispatchEditorHistory('undo', options)).toBe(true)
    expect(widgets.getWidgetCanvasConfig()).toEqual(originalSize)
    expect(widgets.getWidgetById('widget')?.component.option.title).toBe('新值')
    expect(await dispatchEditorHistory('undo', options)).toBe(true)
    expect(widgets.getWidgetById('widget')?.component.option.title).toBe('原值')
    expect(flush).not.toHaveBeenCalled()
    expect(storeTransaction).not.toHaveBeenCalled()
    expect(await dispatchEditorHistory('undo', options)).toBe(false)
    expect(options.host.getStore().getObject('node')).not.toBeNull()
    expect(options.commandBus.getUndoSize()).toBe(1)
    expect(options.commandBus.getRedoSize()).toBe(2)
    expect(options.onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Unity桥接不可用' }))
    expect(await dispatchEditorHistory('redo', options)).toBe(true)
    expect(widgets.getWidgetById('widget')?.component.option.title).toBe('新值')
    expect(widgets.getWidgetCanvasConfig()).toEqual(originalSize)
    expect(await dispatchEditorHistory('redo', options)).toBe(true)
    expect(widgets.getWidgetCanvasConfig()).toEqual(nextSize)
    expect(flush).toHaveBeenCalledTimes(1)
  })

  it('三维预确认等待期间栈顶换成新命令，不回放新目标', async () => {
    const options = await setup()
    const drain = deferred()
    vi.spyOn(options.host.getBridge(), 'flush').mockReturnValueOnce(drain.promise)
    const undo = dispatchEditorHistory('undo', options)
    const undoNew = vi.fn()
    options.commandBus.recordExecuted({ name: '新命令', execute: vi.fn(), undo: undoNew })
    drain.resolve()
    expect(await undo).toBe(false)
    expect(undoNew).not.toHaveBeenCalled()
    expect(options.commandBus.getUndoSize()).toBe(2)
  })

  it('二维补偿也失败时保留重试，等待期间拒绝旁路编辑', async () => {
    setActivePinia(createPinia())
    const options = await setup()
    const widgets = useSceneWidgetStore()
    const component = new BaseWidgetConfig()
    component.option = { title: '原值' }
    widgets.totalWidgets = [{ id: 'widget', component }]
    widgets.setWidgetLayerTree([{ id: 'widget', type: 'widget' }])
    setWidgetCommandPort(createCommandBusWidgetCommandPort(() => options.commandBus))
    widgets.runWidgetHistoryChange('二维编辑', ['widget'], () => { component.option.title = '新值' })
    const bridge = options.host.getBridge()
    const flush = vi.spyOn(bridge, 'flush')
    const resync = vi.spyOn(bridge, 'resync')
    vi.spyOn(useSceneStore(), 'setTransformMaterialRandomId')
      .mockImplementationOnce(() => { throw new Error('回放失败') })
      .mockImplementationOnce(() => { throw new Error('补偿失败') })
    expect(await dispatchEditorHistory('undo', options)).toBe(false)
    expect(editorSceneOperation.value).toBe('historyRecovery')
    const mutate = vi.fn()
    expect(() => widgets.runWidgetHistoryChange('旁路编辑', ['widget'], mutate)).toThrow('其他操作')
    expect(mutate).not.toHaveBeenCalled()
    expect(await editorSceneRecovery.value?.retry()).toBe(true)
    expect(widgets.getWidgetById('widget')?.component.option.title).toBe('新值')
    expect(await dispatchEditorHistory('undo', options)).toBe(true)
    expect(flush).not.toHaveBeenCalled()
    expect(resync).not.toHaveBeenCalled()
  })

  it('同宿主重载后作废失败二维事务，旧重试不会恢复到新草稿', async () => {
    const options = await setup()
    const restore = vi.fn(() => { throw new Error('二维补偿失败') })
    options.commandBus.recordExecuted({
      name: '二维变更',
      confirmationScope: 'local',
      captureRollback: () => restore,
      execute: vi.fn(),
      undo: () => { throw new Error('二维撤销失败') },
    })
    expect(await dispatchEditorHistory('undo', options)).toBe(false)
    const retry = editorSceneRecovery.value!.retry
    await options.host.replaceScene(createSceneDefinition({
      id: 'history', name: '新草稿', type: 'local3d',
      coordinateSystem: { kind: 'local', unit: 'meter', upAxis: 'Y', gridEnabled: true },
    }))
    expect(editorSceneOperation.value).toBeNull()
    expect(await retry()).toBe(false)
    expect(restore).toHaveBeenCalledTimes(1)
    expect(options.commandBus.getUndoSize()).toBe(0)
  })

  it('等待期间切换宿主，旧任务不再修改历史或通知新场景', async () => {
    const options = await setup()
    const drain = deferred()
    vi.spyOn(options.host.getBridge(), 'flush').mockReturnValueOnce(drain.promise)
    const undo = dispatchEditorHistory('undo', options)
    clearActiveSceneViewportHost(options.host)
    drain.resolve()
    expect(await undo).toBe(false)
    expect(options.commandBus.getUndoSize()).toBe(1)
    expect(options.onApplied).not.toHaveBeenCalled()
    expect(options.onError).not.toHaveBeenCalled()
    expect(editorSceneOperation.value).toBeNull()
  })
})
