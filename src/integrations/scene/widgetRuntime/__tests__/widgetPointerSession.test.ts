import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import BaseWidgetConfig from '@/packages/components/BaseWidgetConfig'
import { useSceneWidgetStore } from '@/stores/sceneEditStore'
import { createSceneDefinition, createViewportHost, type ViewportHost } from '@/scene-platform'
import { setActiveSceneViewportHost, clearActiveSceneViewportHost } from '../../editorScenePlatformHost'
import { beginEditorSceneOperation, editorSceneOperation, editorSceneRecovery } from '../../editorSceneOperationGate'
import { createCommandBusWidgetCommandPort } from '../commandBusWidgetCommandAdapter'
import { setWidgetCommandPort, resetWidgetRuntimePorts } from '../ports'
import { getWidgetPointerSession, type WidgetPointerSession } from '../widgetPointerSession'
import { useMove, useResize } from '@/views/sceneEdit/SceneCenter/SceneCanvas/LayerDOM/hooks/useDrag'
import { DragType } from '@/views/sceneEdit/SceneCenter/SceneCanvas/LayerDOM/type'

const mouse = (type: string, x = 100, y = 100) =>
  Object.assign(new Event(type, { cancelable: true }), { clientX: x, clientY: y, button: 0 }) as unknown as MouseEvent
let host: ViewportHost
let pointer: WidgetPointerSession | undefined
let win: EventTarget
let doc: EventTarget & { visibilityState: string }
const setup = async () => {
  const scene = createSceneDefinition({ id: 'pointer', name: '拖拽检查', type: 'local3d',
    coordinateSystem: { kind: 'local', unit: 'meter', upAxis: 'Y', gridEnabled: true } })
  host = createViewportHost({ container: {} as HTMLElement, scene })
  await host.mount()
  setActiveSceneViewportHost(host)
  setWidgetCommandPort(createCommandBusWidgetCommandPort(() => host.getCommandBus()))
  const store = useSceneWidgetStore()
  const component = new BaseWidgetConfig()
  Object.assign(component.attr, { l: 50, t: 50, w: 100, h: 60 })
  store.totalWidgets = [{ id: 'widget', component }]
  store.setWidgetLayerTree([{ id: 'widget', type: 'widget' }])
  vi.spyOn(store, 'screenDeltaToWidgetCanvasDelta').mockImplementation((x, y) => ({ x, y }))
  pointer = getWidgetPointerSession()
  return { store, widget: store.getWidgetById('widget')! }
}
beforeEach(() => {
  vi.useFakeTimers()
  setActivePinia(createPinia())
  win = new EventTarget()
  doc = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  vi.stubGlobal('window', win)
  vi.stubGlobal('document', doc)
})
afterEach(() => {
  pointer?.cancel()
  clearActiveSceneViewportHost()
  host?.dispose()
  resetWidgetRuntimePorts()
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('二维指针交互会话', () => {
  it('松开时冲刷最后一帧，只产生一条可撤销历史', async () => {
    const { store, widget } = await setup()
    useMove(mouse('mousedown'), widget)
    win.dispatchEvent(mouse('mousemove', 130, 120))
    win.dispatchEvent(mouse('mousemove', 147, 127))
    expect(editorSceneOperation.value).toBe('widgetEdit')
    win.dispatchEvent(mouse('mouseup'))
    expect(store.getWidgetById('widget')?.component.attr.l).toBe(97)
    expect(host.getCommandBus().getUndoSize()).toBe(1)
    host.getCommandBus().undo()
    expect(store.getWidgetById('widget')?.component.attr.l).toBe(50)
    vi.runAllTimers()
    expect(store.getWidgetById('widget')?.component.attr.l).toBe(50)
    expect(editorSceneOperation.value).toBeNull()
  })

  it.each(['blur', 'pagehide', 'escape', 'hidden', 'unmount'])('取消%s恢复原位置，不产生历史和迟到尾帧', async (reason) => {
    const { store, widget } = await setup()
    useMove(mouse('mousedown'), widget)
    win.dispatchEvent(mouse('mousemove', 140, 120))
    win.dispatchEvent(mouse('mousemove', 160, 130))
    if (reason === 'escape') win.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' }))
    else if (reason === 'hidden') { doc.visibilityState = 'hidden'; doc.dispatchEvent(new Event('visibilitychange')) }
    else if (reason === 'unmount') pointer?.cancel()
    else win.dispatchEvent(new Event(reason))
    vi.runAllTimers()
    win.dispatchEvent(mouse('mousemove', 200, 200))
    win.dispatchEvent(mouse('mouseup'))
    expect(store.getWidgetById('widget')?.component.attr.l).toBe(50)
    expect(store.getWidgetById('widget')?.component.attr.t).toBe(50)
    expect(host.getCommandBus().getUndoSize()).toBe(0)
    expect(editorSceneOperation.value).toBeNull()
  })

  it('缩放取消恢复尺寸，旧回调不会覆盖随后提交的另一交互', async () => {
    const { store, widget } = await setup()
    useResize(mouse('mousedown'), widget, DragType.RB)
    win.dispatchEvent(mouse('mousemove', 140, 120))
    win.dispatchEvent(new Event('blur'))
    expect(store.getWidgetById('widget')?.component.attr.w).toBe(100)
    pointer = getWidgetPointerSession()
    useResize(mouse('mousedown'), store.getWidgetById('widget')!, DragType.RB)
    win.dispatchEvent(mouse('mousemove', 150, 130))
    win.dispatchEvent(mouse('mouseup'))
    vi.runAllTimers()
    expect(store.getWidgetById('widget')?.component.attr.w).toBe(150)
    expect(host.getCommandBus().getUndoSize()).toBe(1)
  })

  it('同编号场景重载只清理旧会话，不用旧快照恢复新部件', async () => {
    const { store, widget } = await setup()
    useMove(mouse('mousedown'), widget)
    win.dispatchEvent(mouse('mousemove', 140, 120))
    const replacement = new BaseWidgetConfig()
    Object.assign(replacement.attr, { l: 900, t: 800 })
    store.totalWidgets = [{ id: 'widget', component: replacement }]
    host.getStore().loadScene(createSceneDefinition({ id: 'pointer', name: '新场景', type: 'local3d',
      coordinateSystem: { kind: 'local', unit: 'meter', upAxis: 'Y', gridEnabled: true } }))
    vi.runAllTimers()
    win.dispatchEvent(mouse('mouseup'))
    expect(store.getWidgetById('widget')?.component.attr.l).toBe(900)
    expect(host.getCommandBus().getUndoSize()).toBe(0)
    expect(editorSceneOperation.value).toBeNull()
  })

  it('部件异步重载代次变化后，节流尾帧不会重新写入新列表', async () => {
    const { store, widget } = await setup()
    useMove(mouse('mousedown'), widget)
    win.dispatchEvent(mouse('mousemove', 140, 120))
    win.dispatchEvent(mouse('mousemove', 160, 130))
    await store.loadSavedWidgets([])
    vi.runAllTimers()
    win.dispatchEvent(mouse('mouseup'))
    expect(store.totalWidgets).toEqual([])
    expect(host.getCommandBus().getUndoSize()).toBe(0)
    expect(editorSceneOperation.value).toBeNull()
  })

  it('只点击而未移动时释放门禁，不登记空历史', async () => {
    const { widget } = await setup()
    useMove(mouse('mousedown'), widget)
    win.dispatchEvent(mouse('mouseup'))
    expect(host.getCommandBus().getUndoSize()).toBe(0)
    expect(editorSceneOperation.value).toBeNull()
  })

  it('右键不建立拖拽，也不会提前结束主键拖拽', async () => {
    const { widget } = await setup()
    pointer?.cancel()
    useMove(Object.assign(mouse('mousedown'), { button: 2 }), widget)
    expect(editorSceneOperation.value).toBeNull()
    pointer = getWidgetPointerSession()
    useMove(mouse('mousedown'), widget)
    win.dispatchEvent(mouse('mousemove', 140, 120))
    win.dispatchEvent(Object.assign(mouse('mouseup'), { button: 2 }))
    expect(editorSceneOperation.value).toBe('widgetEdit')
    expect(host.getCommandBus().getUndoSize()).toBe(0)
    win.dispatchEvent(mouse('mouseup'))
    expect(editorSceneOperation.value).toBeNull()
    expect(host.getCommandBus().getUndoSize()).toBe(1)
  })

  it('恢复失败后同宿主重载释放门禁，旧的重试入口无法写入新场景', async () => {
    await setup()
    const rollback = vi.fn(() => { throw new Error('模拟快照恢复失败') })
    pointer?.attach({ move: Object.assign(vi.fn(), { cancel: vi.fn(), flush: vi.fn() }), commit: vi.fn(), rollback })
    pointer?.cancel()
    expect(editorSceneOperation.value).toBe('historyRecovery')
    const retry = editorSceneRecovery.value!.retry
    host.getStore().loadScene(createSceneDefinition({ id: 'pointer', name: '新场景', type: 'local3d',
      coordinateSystem: { kind: 'local', unit: 'meter', upAxis: 'Y', gridEnabled: true } }))
    expect(editorSceneOperation.value).toBeNull()
    expect(await retry()).toBe(false)
    expect(rollback).toHaveBeenCalledTimes(1)
  })

  it('保存门禁期间不能建立新的指针会话', async () => {
    await setup()
    pointer?.cancel()
    const release = beginEditorSceneOperation('save')
    try { expect(getWidgetPointerSession()).toBeUndefined() }
    finally { release() }
  })
})
