import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import BaseWidgetConfig from '@/packages/components/BaseWidgetConfig'
import { useSceneWidgetStore } from '@/stores/sceneEditStore'
import type renderScene from '@/utils/renderScene'
import {
  createSceneApiWidgetOverlayHostPort,
  createSceneApiWidgetRuntimePort,
} from '../sceneApiWidgetRuntimeAdapter'
import {
  resetWidgetRuntimePorts,
  setWidgetCommandPort,
  setWidgetRuntimePort,
  type WidgetRuntimePort,
} from '../ports'
import {
  setWidgetGroupVisibilityByIds,
  setWidgetPropertiesByIds,
  setWidgetVisibilityByIds,
} from '../widgetRuntimeActions'
import type { WidgetEventRuntimePort } from '../widgetEventRuntimeService'

const createWidget = () => {
  const component = new BaseWidgetConfig()
  component.option = {
    visible: true,
    title: '编辑态标题',
    dialog: { open: true },
  }

  return {
    id: 'widget-1',
    component,
  }
}

describe('editor preview widget transaction', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetWidgetRuntimePorts()
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((_callback: FrameRequestCallback) => 1),
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })

  afterEach(() => {
    resetWidgetRuntimePorts()
    vi.unstubAllGlobals()
  })

  it('GIS 编辑器预览会先评估初始状态，并在部件值变化后合并调度二维状态规则', async () => {
    const widgetStore = useSceneWidgetStore()
    widgetStore.totalWidgets = [createWidget()]

    const scheduledFrames: FrameRequestCallback[] = []
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        scheduledFrames.push(callback)
        return scheduledFrames.length
      }),
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    const widgetEventRuntime = {
      handleWidgetInteractiveEvent: vi.fn(),
      executeAllWidgetStatusEvents: vi.fn(),
    } satisfies WidgetEventRuntimePort
    const widgetRuntimePort = createSceneApiWidgetRuntimePort(() => null, widgetEventRuntime)
    setWidgetRuntimePort(widgetRuntimePort)

    const previewHost = createSceneApiWidgetOverlayHostPort(() => null)
    await previewHost.enterPreview()

    expect(widgetEventRuntime.executeAllWidgetStatusEvents).toHaveBeenCalledTimes(1)

    widgetStore.setWidgetRuntimeValue('widget-1', 'page', 2)

    expect(scheduledFrames).toHaveLength(1)
    expect(widgetEventRuntime.executeAllWidgetStatusEvents).toHaveBeenCalledTimes(1)

    scheduledFrames[0](0)

    expect(widgetEventRuntime.executeAllWidgetStatusEvents).toHaveBeenCalledTimes(2)
  })

  it('预览切换分组前先批量激活分组成员，再更新分组显隐', async () => {
    const widgetStore = useSceneWidgetStore()
    widgetStore.totalWidgets = [createWidget()]
    widgetStore.setWidgetLayerTree([
      {
        id: 'group-1',
        type: 'group',
        name: '运行态分组',
        visible: false,
        children: ['widget-1'],
      },
    ])

    const activateWidgetGroups = vi.fn(async () => undefined)
    setWidgetRuntimePort({
      isPreview: () => true,
      handleInteractiveEvent: () => undefined,
      scheduleStatusEvaluation: () => undefined,
      executeAllStatusEvents: () => undefined,
      clearSceneObjectSelection: () => undefined,
      activateWidgetGroups,
      dispose: () => undefined,
    } satisfies WidgetRuntimePort)

    setWidgetGroupVisibilityByIds(['group-1'], true)

    expect(activateWidgetGroups).toHaveBeenCalledWith(['group-1'])
    expect(widgetStore.getGroupVisible('group-1')).toBe(false)

    await Promise.resolve()
    await Promise.resolve()

    expect(widgetStore.getGroupVisible('group-1')).toBe(true)
  })

  it('退出预览后恢复部件弹窗显隐、配置和运行时输入值', async () => {
    const widgetStore = useSceneWidgetStore()
    const widget = createWidget()
    widgetStore.totalWidgets = [widget]
    widgetStore.setWidgetLayerTree([
      {
        id: 'group-1',
        type: 'group',
        name: '编辑态分组',
        visible: true,
        children: ['widget-1'],
      },
      { id: 'widget-1', type: 'widget' },
    ])
    widgetStore.setWidgetRuntimeValue('widget-1', 'opened', false)

    setWidgetRuntimePort(createSceneApiWidgetRuntimePort(() => null))
    const recordExecuted = vi.fn()
    const restorePreviewState = vi.fn()
    setWidgetCommandPort({
      executeWidgetCommand: recordExecuted,
      isApplyingWidgetHistory: () => false,
    })

    const previewHost = createSceneApiWidgetOverlayHostPort(
      () => null,
      () => null,
      restorePreviewState,
    )
    await previewHost.enterPreview()

    setWidgetVisibilityByIds(['widget-1'], false)
    setWidgetGroupVisibilityByIds(['group-1'], false)
    setWidgetPropertiesByIds(['widget-1'], [{ targetProperty: 'dialog.open', value: false }])
    widgetStore.setWidgetRuntimeValue('widget-1', 'opened', true)

    expect(recordExecuted).not.toHaveBeenCalled()
    expect(widgetStore.getWidgetById('widget-1')?.component.option).toMatchObject({
      visible: false,
      dialog: { open: false },
    })
    expect(widgetStore.getGroupVisible('group-1')).toBe(false)

    previewHost.exitPreview()

    expect(restorePreviewState).toHaveBeenCalledOnce()
    expect(widgetStore.getWidgetById('widget-1')?.component.option).toEqual({
      visible: true,
      title: '编辑态标题',
      dialog: { open: true },
    })
    expect(widgetStore.getGroupVisible('group-1')).toBe(true)
    expect(widgetStore.widgetRuntimeValueMap).toEqual({
      'widget-1': { opened: false },
    })

    setWidgetGroupVisibilityByIds(['group-1'], false)
    expect(recordExecuted).toHaveBeenCalledTimes(1)
  })

  it('预览初始化尚未完成时退出，也不会让迟到结果覆盖编辑态', async () => {
    const widgetStore = useSceneWidgetStore()
    const widget = createWidget()
    widgetStore.totalWidgets = [widget]
    widgetStore.setWidgetLayerTree([
      {
        id: 'group-1',
        type: 'group',
        name: '编辑态分组',
        visible: true,
        children: ['widget-1'],
      },
      { id: 'widget-1', type: 'widget' },
    ])

    let resolveInitialization: (() => void) | null = null
    const sceneApi = {
      scenePreviewModules: {
        setScenePreview: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              resolveInitialization = resolve
            }),
        ),
        exitScenePreview: vi.fn(),
      },
    } as unknown as renderScene

    setWidgetRuntimePort(createSceneApiWidgetRuntimePort(() => sceneApi))
    const previewHost = createSceneApiWidgetOverlayHostPort(
      () => sceneApi,
      () => null,
    )
    const enterPromise = previewHost.enterPreview()
    // 进入流程先等待编辑模式切换，需等初始化Promise建立后再模拟中途退出。
    await vi.waitFor(() => expect(sceneApi.scenePreviewModules.setScenePreview).toHaveBeenCalledTimes(1))

    setWidgetVisibilityByIds(['widget-1'], false)
    previewHost.exitPreview()
    resolveInitialization?.()
    await enterPromise

    expect(widgetStore.getWidgetById('widget-1')?.component.option).toMatchObject({
      visible: true,
      dialog: { open: true },
    })
    expect(previewHost.isMounted()).toBe(true)
    expect(sceneApi.scenePreviewModules.exitScenePreview).toHaveBeenCalledTimes(2)
  })
})
