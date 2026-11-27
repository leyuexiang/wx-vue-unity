import type { SceneObject } from '@/scene-platform/core/types'

/** 由当前预览页响应交互规则，由编辑页响应属性面板指定起点的请求。 */
export const SCENE_FIRST_PERSON_TOGGLE_EVENT = 'scene:first-person-toggle'
export const SCENE_FIRST_PERSON_PREVIEW_EVENT = 'scene:first-person-preview'

/** 优先使用显式选中的起点。只有检查到有父级的相机时才创建对象索引。 */
export function findFirstPersonStart(objects: readonly SceneObject[], preferredId?: string): SceneObject | null {
  let objectsById: Map<string, SceneObject> | undefined
  const isAvailable = (object: SceneObject) => {
    if (object.type !== 'camera' || !object.firstPerson || object.firstPerson.enabled === false || !object.visible) return false
    let parentId = object.parentInstanceId
    if (!parentId) return true
    objectsById ??= new Map(objects.map(item => [item.id, item]))
    while (parentId) {
      const parent = objectsById.get(parentId)
      if (!parent?.visible) return false
      parentId = parent.parentInstanceId
    }
    return true
  }
  const preferred = preferredId ? objects.find(object => object.id === preferredId) : undefined
  return preferred && isAvailable(preferred) ? preferred : objects.find(isAvailable) ?? null
}
