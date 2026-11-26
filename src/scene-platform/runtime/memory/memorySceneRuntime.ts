import type { SceneType } from '../../core/types'
import { BaseSceneRuntime } from '../baseSceneRuntime'

/**
 * 内存 Runtime（无 WebGL）。
 *
 * 用途：
 * - 第一阶段用于跑通契约测试、RuntimeBridge、保存恢复等“架构主干”；
 * - 测试场景仍可显式创建 MemorySceneRuntime，避免依赖浏览器 WebGL / Cesium / Three。
 */
export class MemorySceneRuntime extends BaseSceneRuntime {
  constructor(type: SceneType, id?: string) {
    super(type, id ?? `memory-${type}`)
    // 内存宿主仅保存领域快照，不支持真实三维变换、资产渲染、特效或编辑，所有能力按实际关闭。
    for (const group of Object.values(this.capabilities)) {
      const entries = group as Record<string, unknown>
      for (const key of Object.keys(entries)) if (typeof entries[key] === 'boolean') entries[key] = false
    }
  }
}
