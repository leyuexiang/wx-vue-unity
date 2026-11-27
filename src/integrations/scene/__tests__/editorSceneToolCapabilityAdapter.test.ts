import { describe, expect, it } from 'vitest'
import { DRAG_MODEL_ENUM } from '@/enums'
import { createDefaultRuntimeCapabilities } from '@/scene-platform/runtime/runtimeCapabilities'
import {
  filterEditorSceneDragGroupsByRuntimeCapabilities,
  getFirstPersonDragDisabledReason,
} from '../editorSceneToolCapabilityAdapter'

describe('系统资源中的第一人称入口', () => {
  it('旧播放器仍展示相机分组，连接支持的播放器后沿用同一张资源卡片', () => {
    const camera = { key: 'camera', children: [{ modelType: DRAG_MODEL_ENUM.FirstPerson }] }
    const capabilities = createDefaultRuntimeCapabilities('local3d')

    expect(filterEditorSceneDragGroupsByRuntimeCapabilities([camera], null)[0]).toBe(camera)
    expect(getFirstPersonDragDisabledReason(null)).toContain('连接')

    capabilities.editing.firstPerson = false
    expect(filterEditorSceneDragGroupsByRuntimeCapabilities([camera], capabilities)[0]).toBe(camera)
    expect(getFirstPersonDragDisabledReason(capabilities)).toContain('更新')

    capabilities.editing.firstPerson = true
    expect(filterEditorSceneDragGroupsByRuntimeCapabilities([camera], capabilities)[0]).toBe(camera)
    expect(getFirstPersonDragDisabledReason(capabilities)).toBeUndefined()
  })
})
