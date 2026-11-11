import { inject, nextTick, provide, shallowRef, type InjectionKey, type Ref, type ShallowRef } from 'vue'
import type { listVegetationRegions } from '@/integrations/scene/editorVegetationRegions'

type VegetationStructureRegion = Pick<ReturnType<typeof listVegetationRegions>[number], 'id' | 'name' | 'kind'>

interface VegetationStructureState {
  draft: ShallowRef<{
    regions: VegetationStructureRegion[]
    selectedRegionId: string
    selectionDisabled: boolean
  } | null>
  requestedRegionId: ShallowRef<string | null>
  openRegion: (id: string) => void
  clearRegionSelection: () => void
}

export const VEGETATION_STRUCTURE_KEY: InjectionKey<VegetationStructureState> =
  Symbol('vegetationStructure')

export function provideVegetationStructure(openInspector: () => void) {
  const requestedRegionId = shallowRef<string | null>(null)
  const state: VegetationStructureState = {
    draft: shallowRef(null),
    requestedRegionId,
    openRegion(id) {
      requestedRegionId.value = id
      // 等待原有选中态清除触发的检查器页签重置。
      void nextTick(openInspector)
    },
    clearRegionSelection() {
      if (state.draft.value?.selectedRegionId && !state.draft.value.selectionDisabled) {
        requestedRegionId.value = ''
      }
    },
  }
  provide(VEGETATION_STRUCTURE_KEY, state)
}

export function useVegetationViewportSelection(
  stage: Ref<HTMLElement | undefined>,
  renderSurface: Ref<HTMLElement | undefined>,
) {
  const vegetationStructure = inject(VEGETATION_STRUCTURE_KEY, null)
  let press: { pointerId: number; x: number; y: number } | undefined

  function isSceneBackground(event: PointerEvent) {
    const target = event.target
    if (target === event.currentTarget || target === stage.value || target === renderSurface.value) return true
    return target instanceof Element && target.parentElement === renderSurface.value &&
      target.matches('canvas.unity-web-canvas, video.unity-cloud-video')
  }

  function pointerDown(event: PointerEvent) {
    press = undefined
    const selection = vegetationStructure?.draft.value
    if (!selection?.selectedRegionId || selection.selectionDisabled || !event.isPrimary ||
      event.button !== 0 || !isSceneBackground(event)) return
    press = { pointerId: event.pointerId, x: event.clientX, y: event.clientY }
  }

  function pointerMove(event: PointerEvent) {
    if (press?.pointerId === event.pointerId && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 5) {
      press = undefined
    }
  }

  function pointerUp(event: PointerEvent) {
    pointerMove(event)
    const isBackgroundClick = press?.pointerId === event.pointerId && event.button === 0 && isSceneBackground(event)
    press = undefined
    if (isBackgroundClick) vegetationStructure?.clearRegionSelection()
  }

  function cancel() { press = undefined }

  return { pointerDown, pointerMove, pointerUp, cancel }
}
