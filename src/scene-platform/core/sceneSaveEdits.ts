/** 可在原四包上合并的编辑字段。选择和运行端投影不进入此范围。 */
export const sceneObjectSaveFields = ['name', 'visible', 'locked', 'layerId', 'order'] as const
export const sceneObjectSaveMetadataKeys = [
  'pickable', 'dataConfig', 'statusList', 'interactiveEvent', 'deviceId', 'deviceBinding',
] as const
export const sceneLayerSaveFields = ['name', 'visible', 'locked', 'order'] as const
export type SceneObjectSaveField = typeof sceneObjectSaveFields[number] | typeof sceneObjectSaveMetadataKeys[number]
export type SceneLayerSaveField = typeof sceneLayerSaveFields[number] | 'presence'

export interface SceneSaveEdits {
  readonly objects: ReadonlyMap<string, ReadonlySet<SceneObjectSaveField>>
  readonly layers: ReadonlyMap<string, ReadonlySet<SceneLayerSaveField>>
}
