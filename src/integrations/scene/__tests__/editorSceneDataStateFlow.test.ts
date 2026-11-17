import { describe, expect, it, vi } from 'vitest'
import type { SceneObject, SceneStore, ViewportHost } from '@/scene-platform'
import type { InteractionEvent } from '@/types/threeScene'
import { ACTION_TYPE_ENUM, CONDITION_RULE_TYPE_ENUM, FIXED_VALUE_TYPE_ENUM, JUDGMENT_TYPE_ENUM, OBJECT_TYPE_ENUM } from '@/enums/scenePanelEnum'
import { createEmptyDataConfig, createEmptyRequestGlobalConfig } from '@/types/data-config'
import { createEditorSceneObjectBehaviorRuntime } from '../editorSceneObjectBehaviorRuntime'
import { SceneDataPollingRuntime } from '../widgetRuntime/sceneDataPollingRuntime'
import { setWidgetPreviewState } from '../widgetRuntime/ports'

/** 复用真实数据调度、条件与动作执行器，仅在 Unity 传输边界记录确认。 */
describe('三维数据到状态动作的会话内闭环', () => {
  it('两个实例温度隔离、阈值边沿只触发一次、冷却后可再次触发且退出恢复原显隐', async () => {
    const object = (id: string): SceneObject => ({ id, name: id, type: 'model', visible: true, locked: false, order: 0,
      transform: { kind: 'local', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, assetRefs: [] })
    const source = (id: string, target: string, temperature: number): SceneObject => ({ ...object(id), metadata: {
      dataConfig: createEmptyDataConfig([{ temperature }]),
      statusList: [{ id: 'overheat', statusName: '过热', isOpen: true, conditionGroupList: [{ id: 'group', conditionBlokList: [{
        id: 'block', conditionRuleType: CONDITION_RULE_TYPE_ENUM.All,
        conditionList: [{ id: 'threshold', status: true, sourceObjectType: OBJECT_TYPE_ENUM.ComponentDataValue,
          sourceComponentDataField: 'temperature', targetObjectType: OBJECT_TYPE_ENUM.FixedValue,
          targetFixedValueType: FIXED_VALUE_TYPE_ENUM.Number, targetFixedValue: 80, judgmentType: JUDGMENT_TYPE_ENUM.GreaterThan }],
        actionList: [{ id: 'hide', actionType: ACTION_TYPE_ENUM.ModelVisibility, actionTargetUuid: target, modelVisibility: false }],
      }] }] } as unknown as InteractionEvent],
    } })
    const objects = new Map([source('sensor-a', 'target-a', 20), source('sensor-b', 'target-b', 20), object('target-a'), object('target-b')].map((entry) => [entry.id, entry]))
    const rendered = new Map<string, SceneObject>()
    const setObjectVisibleAsync = vi.fn(async (id: string, visible: boolean) => {
      rendered.set(id, { ...(rendered.get(id) ?? objects.get(id)!), visible })
      return true
    })
    const store = { getObject: (id: string) => objects.get(id) ?? null, getScene: () => ({ objects: [...objects.values()] }), subscribe: () => () => undefined } as unknown as SceneStore
    const runtime = { subscribeObjectInteraction: () => () => undefined, setObjectVisibleAsync }
    const host = { getStore: () => store, getRuntime: () => runtime } as unknown as ViewportHost
    const behavior = createEditorSceneObjectBehaviorRuntime({ getViewportHost: () => host })
    const polling = new SceneDataPollingRuntime({ getSceneObjects: () => [...objects.values()], getPublicRequests: () => [], getRequestGlobalConfig: createEmptyRequestGlobalConfig,
      applySceneObject: async (entry) => {
        const projected = behavior.applyPreviewOverridesToSceneObject(entry)
        rendered.set(entry.id, projected)
        await behavior.observeSceneObject(projected)
      },
    })
    try {
      await polling.start()
      behavior.preparePreview()
      setWidgetPreviewState(true)
      await behavior.startPreview()
      expect(setObjectVisibleAsync).not.toHaveBeenCalled()
      const publish = async (id: string, target: string, temperature: number) => {
        objects.set(id, source(id, target, temperature))
        const configBefore = JSON.stringify([...objects.values()])
        await polling.start()
        // 测量与动作只进入运行时，不把显隐覆盖写回领域配置。
        expect(JSON.stringify([...objects.values()])).toBe(configBefore)
      }
      await publish('sensor-a', 'target-a', 90)
      expect(setObjectVisibleAsync.mock.calls).toEqual([['target-a', false]])
      expect(rendered.get('target-b')?.visible ?? objects.get('target-b')!.visible).toBe(true)
      await publish('sensor-a', 'target-a', 95)
      expect(setObjectVisibleAsync).toHaveBeenCalledTimes(1)
      await publish('sensor-a', 'target-a', 60)
      await publish('sensor-a', 'target-a', 90)
      expect(setObjectVisibleAsync.mock.calls).toEqual([['target-a', false], ['target-a', false]])
      await publish('sensor-b', 'target-b', 100)
      expect(setObjectVisibleAsync).toHaveBeenLastCalledWith('target-b', false)
      setWidgetPreviewState(false)
      behavior.exitPreview()
      expect(rendered.get('target-a')?.visible).toBe(true)
      expect(rendered.get('target-b')?.visible).toBe(true)
      expect(objects.get('target-a')!.visible).toBe(true)
    } finally {
      polling.dispose()
      behavior.dispose()
      setWidgetPreviewState(false)
    }
  })
})
