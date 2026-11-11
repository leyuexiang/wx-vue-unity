import type { UnityEditorSceneRuntime } from './UnityEditorSceneRuntime'

export type VegetationEditorRuntime = Pick<UnityEditorSceneRuntime,
  'vegetationAvailable' | 'pickVegetationPoint' | 'cancelVegetationPointPick' |
  'controlVegetation' | 'listVegetationModels' | 'applyVegetationDraft' | 'controlCamera'>

/** Runtime instances can outlive a hot-reloaded class constructor. Check the contract. */
export function isVegetationEditorRuntime(value: unknown): value is VegetationEditorRuntime {
  if (!value || typeof value !== 'object') return false
  const runtime = value as Record<string, unknown>
  return typeof runtime.vegetationAvailable === 'boolean' && [
    'pickVegetationPoint', 'cancelVegetationPointPick', 'controlVegetation',
    'listVegetationModels', 'applyVegetationDraft', 'controlCamera',
  ].every(name => typeof runtime[name] === 'function')
}
