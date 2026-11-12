import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SceneRuntime } from '@/scene-platform'
import type { ActionItem } from '@/types/threeScene'
import { ACTION_TYPE_ENUM } from '@/enums/scenePanelEnum'
import { createEditorSceneInteractionActionRuntimePort } from '../editorSceneInteractionActionRuntime'
import { setWidgetPreviewState } from '../widgetRuntime/ports'

const visibilityAction = (id: string): ActionItem => ({
  id: `hide-${id}`,
  actionType: ACTION_TYPE_ENUM.ModelVisibility,
  actionTargetUuid: id,
  modelVisibility: false,
} as ActionItem)

describe('三维动作异步确认的生命周期隔离', () => {
  afterEach(() => setWidgetPreviewState(false))

  it.each(['退出预览', '退出后重进', '来源销毁'] as const)('%s后迟到的显隐确认不得写入新预览状态', async (scenario) => {
    let confirm!: (applied: boolean) => void
    const acknowledgement = new Promise<boolean>((resolve) => { confirm = resolve })
    const setObjectVisibleAsync = vi.fn().mockReturnValue(acknowledgement)
    const onSceneObjectVisibilityChanged = vi.fn()
    const runtime = { setObjectVisibleAsync } as unknown as SceneRuntime
    let active = true
    const port = createEditorSceneInteractionActionRuntimePort({ getRuntime: () => runtime, isActive: () => active })
    setWidgetPreviewState(true)
    const completion = port.executeActionList([visibilityAction('target'), visibilityAction('next')], { onSceneObjectVisibilityChanged })
    expect(setObjectVisibleAsync).toHaveBeenCalledTimes(1)

    // 引擎请求已发出；预览或来源结束后，旧确认不能把过期结果重新登记为当前状态。
    if (scenario === '来源销毁') active = false
    else {
      setWidgetPreviewState(false)
      if (scenario === '退出后重进') setWidgetPreviewState(true)
    }
    confirm(true)
    await completion
    expect(onSceneObjectVisibilityChanged).not.toHaveBeenCalled()
    expect(setObjectVisibleAsync).toHaveBeenCalledTimes(1)
    port.dispose?.()
  })

  it('有效会话等待确认后登记显隐并继续后续动作', async () => {
    let confirm!: (applied: boolean) => void
    const setObjectVisibleAsync = vi.fn().mockImplementationOnce(() => new Promise<boolean>((resolve) => { confirm = resolve })).mockResolvedValue(true)
    const onSceneObjectVisibilityChanged = vi.fn()
    const runtime = { setObjectVisibleAsync } as unknown as SceneRuntime
    const port = createEditorSceneInteractionActionRuntimePort({ getRuntime: () => runtime })
    setWidgetPreviewState(true)
    const completion = port.executeActionList([visibilityAction('target'), visibilityAction('next')], { onSceneObjectVisibilityChanged })
    expect(onSceneObjectVisibilityChanged).not.toHaveBeenCalled()
    confirm(true)
    await completion
    expect(onSceneObjectVisibilityChanged.mock.calls).toEqual([['target', false], ['next', false]])
    port.dispose?.()
  })
})
