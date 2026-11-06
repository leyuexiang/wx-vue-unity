import { describe, expect, it, vi } from 'vitest'
import { createSceneDefinition } from '@/scene-platform'
import { UnityEditorSceneRuntime } from '../runtime/UnityEditorSceneRuntime'

const fixture = async (mode: 'cloud' | 'webgpu') => {
  const runtime = new UnityEditorSceneRuntime('local3d', { mode, getHost: () => null, onStatus: vi.fn() })
  const scene = createSceneDefinition({ id: 'visual', name: '视觉回归', type: 'local3d', coordinateSystem: { kind: 'local' } })
  scene.objects = [{ id: 'bottle', name: '水瓶', type: 'primitive', visible: true, locked: false, order: 0,
    transform: { kind: 'local', position: [0, 15, 0], rotation: [0, 0, 0], scale: [100, 100, 100] },
    metadata: { editorGeometryType: 'BoxGeometry' } }]
  const unity = { loadScene: vi.fn(async () => {}), executeInteractionAction: vi.fn(async () => {}), setSelection: vi.fn(),
    capabilities: { features: { 'interaction.action': true } } }
  Object.assign(runtime, { unity })
  await runtime.loadScene(scene)
  return { runtime, unity }
}

describe('Unity 结构树聚焦', () => {
  it.each(['cloud', 'webgpu'] as const)('将结构树统一聚焦入口交给真实引擎（%s）', async (mode) => {
    const { runtime, unity } = await fixture(mode)
    await runtime.frame({ objectId: 'bottle' })
    expect(unity.executeInteractionAction).toHaveBeenCalledExactlyOnceWith({ actionType: 'moveCamera', instanceId: 'bottle' })
  })

  it('目标已移除时不向引擎发送过期实例', async () => {
    const { runtime, unity } = await fixture('webgpu')
    await expect(runtime.frame({ objectId: 'removed' })).rejects.toThrow('无法聚焦')
    expect(unity.executeInteractionAction).not.toHaveBeenCalled()
  })

  it('保留引擎的相机忙碌错误，后续聚焦仍可成功', async () => {
    const { runtime, unity } = await fixture('webgpu')
    unity.executeInteractionAction.mockRejectedValueOnce(new Error('相机正在飞行'))
    await expect(runtime.frame({ objectId: 'bottle' })).rejects.toThrow('相机正在飞行')
    await runtime.frame({ objectId: 'bottle' })
    expect(unity.executeInteractionAction).toHaveBeenCalledTimes(2)
  })

  it('排队中的聚焦在改选后失效，不再发往 Unity', async () => {
    const { runtime, unity } = await fixture('webgpu')
    let finish: () => void = () => {}
    unity.executeInteractionAction.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
    runtime.setSelectedObject('bottle')
    const first = runtime.moveCameraToObject('bottle')
    await Promise.resolve()
    const queued = runtime.moveCameraToObject('bottle')
    runtime.setSelectedObject(null)
    finish()
    expect(await first).toBe(true)
    expect(await queued).toBe(false)
    expect(unity.executeInteractionAction).toHaveBeenCalledTimes(1)
    expect(unity.setSelection).toHaveBeenLastCalledWith(null)
  })
})
