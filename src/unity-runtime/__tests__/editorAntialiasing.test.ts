import { expect, it, vi } from 'vitest'
import { createSceneDefinition } from '@/scene-platform'
import { UnityEditorSceneRuntime } from '../runtime/UnityEditorSceneRuntime'

it.each(['webgpu', 'cloud', 'public'] as const)('初次装载与实时相机同步一致，并尊重场景明确选择（%s）', async (kind) => {
  const scene = createSceneDefinition({ id: 'scene', name: '测试场景', type: 'local3d', coordinateSystem: { kind: 'local' } })
  const runtime = new UnityEditorSceneRuntime(scene.type, {
    mode: kind === 'cloud' ? 'cloud' : 'webgpu', getHost: () => null, onStatus: vi.fn(),
    publicationResources: kind === 'public' ? {
      apiBaseUrl: 'https://publication.test', publicationId: '1', ticket: 'test', downloadOrigins: [], catalog: {},
    } : undefined,
  })
  const unity = { loadScene: vi.fn(), controlCamera: vi.fn(), capabilities: { features: { 'camera.control': true } } }
  Object.assign(runtime, { unity })

  // 初始配置只存在于发送给播放器的草稿，编辑器保存的数据不增加默认配置。
  const camera = kind === 'webgpu' ? { antialiasing: { mode: 'ssaa', supersampleScale: 1.25 } } : {}
  await runtime.loadScene(scene)
  expect(unity.loadScene).toHaveBeenLastCalledWith(expect.objectContaining({ camera }))
  expect(scene.settings).toEqual({})
  await runtime.updateSceneSettings({ title: '调整无关设置' })
  expect(unity.controlCamera).not.toHaveBeenCalled()

  // 旧场景的显式关闭仍有效，清除覆盖后恢复对应渲染方式的默认值。
  await runtime.updateSceneSettings({ rendering: { antialias: false } })
  expect(unity.controlCamera).toHaveBeenLastCalledWith({ action: 'apply', config: { antialiasing: { mode: 'none' } } })
  await runtime.updateSceneSettings({})
  expect(unity.controlCamera).toHaveBeenLastCalledWith({ action: 'apply', config: camera })
})
