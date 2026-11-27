import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import type { SceneObject, SceneRuntime } from '@/scene-platform'
import { UnityEditorSceneRuntime } from '@/unity-runtime/runtime/UnityEditorSceneRuntime'
import { findFirstPersonStart, SCENE_FIRST_PERSON_TOGGLE_EVENT } from './sceneFirstPersonAction'

/** 编辑预览和发布预览共用同一套切换，播放器确认后才更新页面状态。 */
export function useFirstPersonPreview() {
  const object = shallowRef<SceneObject | null>(null)
  const active = ref(false)
  const pending = ref(false)
  const message = ref('')
  let runtime: UnityEditorSceneRuntime | null = null
  let generation = 0

  const reset = () => {
    ++generation
    // 处理中也排入退出指令，避免关闭页面时迟到的进入请求继续占用镜头。
    if (runtime && (active.value || pending.value)) void runtime.controlFirstPerson({ action: 'exit' }).catch(() => undefined)
    runtime = null
    object.value = null
    active.value = false
    pending.value = false
    message.value = ''
  }

  const configure = (next: SceneRuntime | null, objects: readonly SceneObject[], preferredId?: string) => {
    reset()
    if (!(next instanceof UnityEditorSceneRuntime) || !next.capabilities.editing.firstPerson) return
    object.value = findFirstPersonStart(objects, preferredId)
    runtime = next
  }

  const setActive = async (enabled: boolean) => {
    if (!runtime || !object.value || pending.value || active.value === enabled) return
    const current = generation
    pending.value = true
    message.value = ''
    try {
      await runtime.controlFirstPerson(enabled ? { action: 'enter', instanceId: object.value.id } : { action: 'exit' })
      if (current === generation) active.value = enabled
    } catch (error) {
      if (current === generation) message.value = error instanceof Error ? error.message : '第一人称切换失败'
    } finally {
      if (current === generation) pending.value = false
    }
  }

  const toggle = () => setActive(!active.value)
  const onEscape = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !active.value || pending.value || event.defaultPrevented) return
    event.preventDefault()
    event.stopPropagation()
    void setActive(false)
  }

  onMounted(() => {
    // 在播放器转发按键前处理退出，避免视频画布先消费逃逸键。
    window.addEventListener('keydown', onEscape, true)
    window.addEventListener(SCENE_FIRST_PERSON_TOGGLE_EVENT, toggle)
  })
  onBeforeUnmount(() => {
    window.removeEventListener('keydown', onEscape, true)
    window.removeEventListener(SCENE_FIRST_PERSON_TOGGLE_EVENT, toggle)
    reset()
  })

  return { object, active, pending, message, configure, setActive, toggle, reset }
}
