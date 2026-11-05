<template>
  <div
    ref="containerRef"
    class="absolute top-0 left-0 w-full h-full pointer-events-none outline-0"
    :tabindex="-1"
    @mousedown.capture="captureWidgetEdit"
  >
    <div class="scene-edit-widget-viewport">
      <div class="scene-edit-widget-canvas" :style="widgetCanvasStyle">
        <div
          v-for="item in orderedWidgets"
          :key="`${item.id}-${sceneWidgetStore.widgetRenderVersionMap[item.id] ?? 0}`"
          :ref="(element) => setLayerItemRef(item.id, element as HTMLDivElement | null)"
          class="absolute"
          :class="[
            resolvePersistedAnimationClass(item),
            item.component.info.keyName === 'VPageMenu'
              ? 'pointer-events-none'
              : 'pointer-events-auto',
          ]"
          :data-pointer-through="
            isPreview && (item.component.option as Record<string, unknown>).interactive === false
              ? 'true'
              : undefined
          "
          data-widget-layer-item="true"
          :data-widget-id="item.id"
          :style="getWidgetLayerStyle(item)"
          @mousedown="(e) => handleWidgetMouseDown(e, item)"
        >
          <div class="relative w-full h-full">
            <!-- 按钮下移反馈允许绘制到固定命中外框之外，避免裁掉底边；其内部仍独立裁剪文字和图片。 -->
            <div
              class="w-full h-full select-none"
              :class="
                item.component.info.keyName === 'VPageMenu' || item.component.info.keyName === 'VButton'
                  ? 'overflow-visible'
                  : 'overflow-hidden'
              "
              @click="handleWidgetDomEvent($event, item, INTERACTIVE_EVENT_ENUM.Click)"
              @dblclick="handleWidgetDomEvent($event, item, INTERACTIVE_EVENT_ENUM.DoubleClick)"
              @mouseenter="handleWidgetDomEvent($event, item, INTERACTIVE_EVENT_ENUM.MouseEnter)"
              @mouseleave="handleWidgetDomEvent($event, item, INTERACTIVE_EVENT_ENUM.MouseLeave)"
              @mouseover="
                handlePageFrameChildHover($event, item, INTERACTIVE_EVENT_ENUM.MouseEnter)
              "
              @mouseout="handlePageFrameChildHover($event, item, INTERACTIVE_EVENT_ENUM.MouseLeave)"
            >
              <component
                :is="
                  getComponentName(
                    COMPONENT_TYPE.WIDGET,
                    item.component.info.packageName,
                    item.component.info.keyName,
                  )
                "
                :option="getWidgetRenderState(item.id).option"
                :widget-id="item.id"
                :is-preview="isPreview"
                :selected-child-id="
                  sceneWidgetStore.currentWidgetChildSelection?.frameId === item.id
                    ? sceneWidgetStore.currentWidgetChildSelection.childId
                    : undefined
                "
                @select-child="handleWidgetChildSelect(item, $event)"
                @drag-child="handleWidgetChildDrag(item, $event)"
                @resize-child="handleWidgetChildResize(item, $event)"
                @drag-icon="handleWidgetMenuIconDrag(item, $event)"
                @resize-icon="handleWidgetMenuIconResize(item, $event)"
                @retry="retryQuizWidget(item.id)"
              />
            </div>
          </div>
        </div>

        <!-- 拖动期间的瞬时对齐辅助线；不进入场景配置，也不参与鼠标命中。 -->
        <div
          v-for="(guide, index) in alignmentGuides"
          :key="`${guide.axis}-${guide.position}-${index}`"
          class="scene-edit-alignment-guide"
          :class="`is-${guide.axis}`"
          :style="getAlignmentGuideStyle(guide)"
        />

        <!-- 单部件 / 多部件编辑框。选中分组时由临时代理总框接管。 -->
        <template v-for="item in activeWidgets" :key="item.id">
          <div
            v-if="!isPreview && !groupSelectionActive"
            class="absolute top-0 left-0 w-0 h-0 cursor-move z-10 select-none"
            :class="[
              'border border-[rgba(67,119,190,0.8)]',
              item.component.info.keyName === 'VPageMenu'
                ? 'pointer-events-none bg-transparent'
                : 'pointer-events-auto bg-[rgba(67,119,190,0.3)]',
            ]"
            data-widget-layer-active="true"
            :data-widget-id="item.id"
            :style="getWidgetActiveLayerStyle(item)"
            @click="containerRef?.focus()"
            @mousedown="(e) => handleActiveWidgetMouseDown(e, item)"
          >
            <div class="relative w-full h-full">
              <!-- 四个角落的拖拽点 -->
              <div
                v-for="point in DragPoints"
                :key="point.id"
                class="absolute pointer-events-auto bg-white rounded-md border border-[rgba(67,119,190,0.8)]"
                :class="point.className"
                @mousedown.stop="(e) => handleWidgetResizeMouseDown(e, item, point.id)"
              />
            </div>
          </div>
        </template>

        <!--
          分组代理只存在于编辑器 DOM，用成员包围框派生位置与尺寸。
          它不保存、不发布、不创建运行时父子节点；拖动只批量更新成员坐标。
        -->
        <div
          v-if="!isPreview && groupSelectionActive && activeGroupBounds"
          class="scene-edit-group-active-box absolute pointer-events-auto top-0 left-0 z-10 select-none"
          :class="groupTransformLocked ? 'is-locked' : 'cursor-move'"
          data-widget-layer-active="true"
          :style="{
            top: `${activeGroupBounds.t}px`,
            left: `${activeGroupBounds.l}px`,
            width: `${activeGroupBounds.w}px`,
            height: `${activeGroupBounds.h}px`,
          }"
          @click="containerRef?.focus()"
          @mousedown="handleGroupMouseDown"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { editorSceneOperation } from '@/integrations/scene/editorSceneOperationGate'
import { getWidgetPointerSession, type WidgetPointerSession } from '@/integrations/scene/widgetRuntime/widgetPointerSession'
import { throttle } from 'lodash-es'
import { useGroupMove, useMove, useResize } from './hooks/useDrag'
import type { AlignmentGuide, AlignmentRect, WidgetCanvasBounds } from './alignment'
import { storeToRefs } from 'pinia'
import { DragType } from './type'
import { COMPONENT_TYPE, getComponentName } from '@/utils/components'
import {
  useSceneWidgetStore,
  type WidgetConfig,
  type WidgetNudgeDirection,
} from '@/stores/sceneEditStore'
import { createWidgetRenderOptionCache } from './widgetRenderOption'
import { INTERACTIVE_EVENT_ENUM } from '@/enums/scenePanelEnum'
import { resolveWidgetAnimationClass } from './animation'
import { animationsClass } from '@/utils/style'
import { getWidgetPreviewState, getWidgetRuntimePort } from '@/integrations/scene/widgetRuntime'
import { provideWidgetRuntimeValueContext } from '@/packages/components/widgetRuntimeValueContext'
import { provideRecordPaginationContext } from '@/packages/components/Control/RecordPagination/runtimeContext'
import { recordPaginationContext } from '@/integrations/scene/widgetRuntime/recordPaginationRuntime'
import { passSceneRequestParameters } from '@/integrations/scene/widgetRuntime/sceneDataRequestActions'
import {
  findPageFrameChild,
  PAGE_FRAME_CHILD_OFFSET_RANGE,
  PAGE_FRAME_MENU_SCALE_RANGE,
  type PageFrameOption,
  type PageFramePositionableChild,
  type PageFrameResizeHandle,
  type PageFrameSelectableChild,
} from '@/packages/components/Widget/VPageMenu/pageFrameTypes'

const DragPoints = [
  {
    id: DragType.L,
    className: 'top-1/2 left-0 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize h-4 w-2',
  },
  {
    id: DragType.R,
    className: 'top-1/2 right-0 translate-x-1/2 -translate-y-1/2 cursor-ew-resize h-4 w-2',
  },
  {
    id: DragType.T,
    className: 'top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 cursor-ns-resize h-2 w-4',
  },
  {
    id: DragType.B,
    className: 'bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2 cursor-ns-resize h-2 w-4',
  },
  {
    id: DragType.LT,
    className: 'top-0 left-0 -translate-x-1/2 -translate-y-1/2 cursor-nw-resize  h-2 w-2',
  },
  {
    id: DragType.RT,
    className: 'top-0 right-0 translate-x-1/2 -translate-y-1/2 cursor-ne-resize w-2 h-2',
  },
  {
    id: DragType.LB,
    className: 'bottom-0 left-0 -translate-x-1/2 translate-y-1/2 cursor-sw-resize w-2 h-2',
  },
  {
    id: DragType.RB,
    className: 'bottom-0 right-0 translate-x-1/2 translate-y-1/2 cursor-se-resize w-2 h-2',
  },
]

defineOptions({ name: 'LayerDOM' })

const sceneWidgetStore = useSceneWidgetStore()
// 只向按钮提供按需浏览能力，组件包不依赖当前宿主的仓库或请求实现。
provideRecordPaginationContext(recordPaginationContext)
/**
 * 画布直接订阅仓库的派生渲染列表。
 * storeToRefs 保留 Pinia 计算状态的订阅关系，删除操作替换部件集合后，
 * v-for 会在当前批次立即移除对应 DOM，不需要借助下一次选中变化刷新。
 */
const { orderedWidgets } = storeToRefs(sceneWidgetStore)
const containerRef = ref<HTMLElement>()
// 根容器预先取得交互会话，移动、缩放及菜单控件随后登记各自的恢复快照。
let widgetPointerSession: WidgetPointerSession | undefined
const captureWidgetEdit = (event: MouseEvent) => {
  if (isPreview.value || event.button !== 0) return
  // 数字输入可能在失焦时才提交，先交还焦点，再取得拖拽门禁。
  const focused = document.activeElement
  if (focused instanceof HTMLElement && focused.closest('[data-widget-base-editor]')) focused.blur()
  const session = getWidgetPointerSession()
  if (!session) {
    event.preventDefault()
    event.stopImmediatePropagation()
    return
  }
  widgetPointerSession = session
}
const alignmentGuides = ref<AlignmentGuide[]>([])
const defaultWidgetRenderState = {
  option: {},
  visible: true,
}

/**
 * 组件包通过上下文上报运行时值，避免 TextCommon、输入框、倒计时等组件直接依赖编辑器仓库。
 * 当前由 LayerDOM 适配到旧二维仓库，后续统一运行时落地后只需要替换这里的 provider。
 */
provideWidgetRuntimeValueContext({
  getRuntimeValue: (widgetId, field) => {
    if (!widgetId || !field) return undefined
    return sceneWidgetStore.widgetRuntimeValueMap[widgetId]?.[field]
  },
  setRuntimeValue: (widgetId, field, value) => {
    if (!widgetId) return
    sceneWidgetStore.setWidgetRuntimeValue(widgetId, field, value)
  },
})

const resolveVisibleFromOption = (option: unknown) => {
  if (
    !option ||
    typeof option !== 'object' ||
    !('visible' in (option as Record<string, unknown>))
  ) {
    return true
  }
  return (option as Record<string, unknown>).visible !== false
}

const handleDocumentMouseDown = (event: MouseEvent) => {
  /**
   * 空白清选需要同时覆盖两种编辑态：
   * 1. 单部件 / 多部件选中；
   * 2. 分组选中。
   *
   * 之前这里只判断 currentWidgetsIds，导致“只选中了分组”时直接提前 return，
   * 用户点击画布空白也无法退出组选中态。
   */
  const hasWidgetSelection = Boolean(sceneWidgetStore.currentWidgetsIds?.length)
  const hasGroupSelection = Boolean(sceneWidgetStore.currentWidgetGroupId)
  if (isPreview.value || (!hasWidgetSelection && !hasGroupSelection)) return

  const target = event.target as HTMLElement | null
  if (!target) return

  if (
    target.closest('[data-widget-layer-item]') ||
    target.closest('[data-widget-layer-active]') ||
    /**
     * 拖动编辑器左右分栏的分隔条只是调整布局，不是点击画布空白。
     * 文档级捕获会先于 Splitpanes 收到 mousedown；若在这里清选，页面框架的子节点
     * 编辑态会退回场景基础面板，导致用户每次调整右栏宽度都丢失当前配置上下文。
     */
    target.closest('.splitpanes__splitter') ||
    /**
     * 结构面板里的部件多选依赖 Ctrl + 单击逐个累加。
     * 文档级捕获不能在点击结构面板时提前把旧选择清掉，否则第二次点击前，
     * currentWidgetsIds 就已经被重置，最终只会剩最后一个部件处于选中态。
     */
    target.closest('.scene-edit-structure-panel') ||
    target.closest('[data-scene-right-panel]') ||
    target.closest('.scene-edit-drawer') ||
    target.closest('.scene-edit-dialog') ||
    target.closest('.scene-edit-popover') ||
    target.closest('.scene-edit-popper') ||
    /**
     * 创建分组菜单通过 teleport 挂到 body，不属于结构面板自身。
     * 点击菜单按钮时必须保留当前多选集合，否则建组函数拿到的 ids 会被提前清空。
     */
    target.closest('.scene-edit-structure-menu') ||
    target.closest('.el-overlay') ||
    target.closest('.el-popper') ||
    target.closest('.el-select-dropdown') ||
    target.closest('.el-cascader__dropdown') ||
    target.closest('.el-color-dropdown') ||
    target.closest('.el-picker__popper')
  ) {
    return
  }

  sceneWidgetStore.clearCurrentWidgetSelection()
}

/**
 * 组选中与成员选中框互斥；总框是纯编辑器代理，几何始终由成员实时派生。
 * 显式依赖 orderedWidgets 可确保成员拖动后包围框立即更新。
 */
const groupSelectionActive = computed(() => Boolean(sceneWidgetStore.currentWidgetGroupId))
const activeGroupBounds = computed(() => {
  const groupId = sceneWidgetStore.currentWidgetGroupId
  if (!groupId) return null
  void orderedWidgets.value
  return sceneWidgetStore.getGroupBounds(groupId)
})
const groupTransformLocked = computed(() => {
  const groupId = sceneWidgetStore.currentWidgetGroupId
  return Boolean(groupId && sceneWidgetStore.isWidgetGroupTransformLocked(groupId))
})

const activeWidgets = computed(() => {
  if (groupSelectionActive.value) return []
  return (
    orderedWidgets.value.filter((item) => sceneWidgetStore.currentWidgetsIds?.includes(item.id)) ||
    []
  )
})

const resizeObserver = new ResizeObserver((entries) => {
  for (const entry of entries) {
    // 同步缩放后舞台的真实可见矩形，用于把屏幕鼠标坐标反算成设计坐标。
    sceneWidgetStore.setBoundingClientRect(entry.target.getBoundingClientRect())
  }
})

const widgetPreviewState = getWidgetPreviewState()
const isPreview = computed(() => widgetPreviewState.value || getWidgetRuntimePort().isPreview())

/** 重试复用场景请求调度器，仅重发当前测验实例的完整题库请求。 */
const retryQuizWidget = (targetId: string) =>
  void passSceneRequestParameters({ targetKind: 'widget', targetId, assignments: [] })

const widgetCanvasStyle = computed(() => {
  const layout = sceneWidgetStore.getWidgetCanvasLayout()
  return {
    width: `${layout.width}px`,
    height: `${layout.height}px`,
  }
})

/**
 * 画布部件 DOM 引用表。
 * 动画 hover 预览不再走整层模板 class 求值，而是只对当前目标元素做局部 classList 切换。
 * 这样能避免 preview 状态变化时，所有部件都重新读取全局 store 并执行一次类名计算。
 */
const layerItemElementMap = new Map<string, HTMLDivElement>()
const previewAnimationClassMap = new Map<string, string>()

/**
 * 预览态追加的动画类名会包含两个 token：
 * 1. animate__animated
 * 2. animate__xxx
 *
 * 这里统一做拆分，后续删除时只移除我们追加的类，不影响持久化动画和业务类名。
 */
const splitAnimationClassNames = (className: string) => {
  return className
    .split(' ')
    .map((item) => item.trim())
    .filter(Boolean)
}

const removePreviewAnimationClass = (widgetId: string) => {
  const targetElement = layerItemElementMap.get(widgetId)
  const previewAnimationClass = previewAnimationClassMap.get(widgetId)
  if (!targetElement || !previewAnimationClass) return

  targetElement.classList.remove(...splitAnimationClassNames(previewAnimationClass))
  previewAnimationClassMap.delete(widgetId)
}

const applyPreviewAnimationClass = (widgetId: string, animation: string) => {
  const targetElement = layerItemElementMap.get(widgetId)
  if (!targetElement) return

  const nextPreviewAnimationClass = animationsClass([animation])
  if (!nextPreviewAnimationClass) return

  removePreviewAnimationClass(widgetId)
  targetElement.classList.add(...splitAnimationClassNames(nextPreviewAnimationClass))
  previewAnimationClassMap.set(widgetId, nextPreviewAnimationClass)
}

/**
 * 部件节点在重排、重渲染、卸载时都会变更。
 * 这里集中维护 id 到 DOM 的映射，并在“节点重建但预览仍存在”时立即把预览类重新补回去，
 * 确保预览效果和渲染版本刷新不会互相打断。
 */
const setLayerItemRef = (widgetId: string, element: HTMLDivElement | null) => {
  if (!element) {
    layerItemElementMap.delete(widgetId)
    previewAnimationClassMap.delete(widgetId)
    return
  }

  layerItemElementMap.set(widgetId, element)

  const previewState = sceneWidgetStore.widgetAnimationPreview
  if (previewState?.widgetId === widgetId) {
    applyPreviewAnimationClass(widgetId, previewState.animation)
  }
}

/**
 * 中间画布拖拽时最忌讳“位置一动，所有部件都重算运行时 option”。
 * 这里把运行时渲染态缓存成一张按 id 索引的表，并且只在以下情况更新：
 * 1. 预览态切换；
 * 2. 部件顺序/集合变化；
 * 3. 指定部件显式更新自己的渲染版本。
 *
 * 即使版本表因单个部件刷新而整体替换，未变化部件也会命中按编号缓存，不再重复执行数据深拷贝与运行时拼装。
 */
const widgetRenderOptionCache = createWidgetRenderOptionCache()
const widgetRenderStateMap = computed<Record<string, { option: unknown; visible: boolean }>>(() => {
  const nextMap: Record<string, { option: unknown; visible: boolean }> = {}
  const activeWidgetIds = new Set<string>()
  const preview = Boolean(isPreview.value)
  const renderVersionMap = sceneWidgetStore.widgetRenderVersionMap

  orderedWidgets.value.forEach((item) => {
    activeWidgetIds.add(item.id)
    const option = widgetRenderOptionCache.resolve(
      item.id,
      item.component,
      preview,
      renderVersionMap[item.id] ?? 0,
    )
    const visible = sceneWidgetStore.isWidgetEffectivelyVisible(
      item.id,
      resolveVisibleFromOption(option),
    )

    nextMap[item.id] = {
      option,
      visible,
    }
  })

  widgetRenderOptionCache.retain(activeWidgetIds)

  return nextMap
})

const widgetLayerStyleMap = computed<Record<string, Record<string, string>>>(() => {
  const nextMap: Record<string, Record<string, string>> = {}

  orderedWidgets.value.forEach((item) => {
    /**
     * 部件始终直接消费设计坐标。
     * 外层用户发布尺寸舞台负责统一缩放，所以编辑态、预览态和发布态不会再出现单部件定位差异。
     */
    nextMap[item.id] = {
      top: `${item.component.attr.t}px`,
      left: `${item.component.attr.l}px`,
      width: `${item.component.attr.w}px`,
      height: `${item.component.attr.h}px`,
      // 二维组件之间的前后关系由结构树同步出的持久化 zIndex 统一决定，不按组件类型单独抬高层级。
      zIndex: `${item.component.attr.zIndex}`,
      display: getWidgetRenderState(item.id).visible ? 'block' : 'none',
    }
  })

  return nextMap
})

const getWidgetLayerStyle = (item: WidgetConfig) => widgetLayerStyleMap.value[item.id] || {}

const getWidgetActiveLayerStyle = (item: WidgetConfig) => ({
  ...getWidgetLayerStyle(item),
  zIndex: `${item.component.attr.zIndex + 1}`,
})

const getAlignmentGuideStyle = (guide: AlignmentGuide) =>
  guide.axis === 'vertical'
    ? {
        left: `${guide.position}px`,
        top: `${guide.start}px`,
        height: `${Math.max(0, guide.end - guide.start)}px`,
      }
    : {
        left: `${guide.start}px`,
        top: `${guide.position}px`,
        width: `${Math.max(0, guide.end - guide.start)}px`,
      }

const setAlignmentGuides = (guides: AlignmentGuide[]) => {
  alignmentGuides.value = guides
}

watch(
  () => isPreview.value,
  (newVal) => {
    // 进入预览前结束旧拖拽，再清空选择，避免恢复快照重新选中部件。
    if (newVal) {
      widgetPointerSession?.cancel()
      sceneWidgetStore.clearCurrentWidgetSelection()
    }
  },
)

onMounted(() => {
  resizeObserver.observe(containerRef.value!)
  containerRef.value?.focus()
  containerRef.value?.addEventListener('keydown', handleKeyDown)
  document.addEventListener('mousedown', handleDocumentMouseDown, true)
})

onBeforeUnmount(() => {
  widgetPointerSession?.cancel()
  widgetPointerSession = undefined
  resizeObserver.disconnect()
  containerRef.value?.removeEventListener('keydown', handleKeyDown)
  document.removeEventListener('mousedown', handleDocumentMouseDown, true)
  alignmentGuides.value = []
  layerItemElementMap.clear()
  previewAnimationClassMap.clear()
})

const handleWidgetMouseDown = (e: MouseEvent, item: WidgetConfig) => {
  /**
   * 预览态下必须把事件完整让给部件自身：
   * - 输入框需要获得焦点；
   * - 选择框需要展开下拉；
   * - 日期选择器需要打开弹层。
   *
   * 如果这里继续走编辑器选中逻辑，mousedown 会先被外层容器吃掉，
   * 内部表单控件就会表现成“看得到但点不动”。
   */
  if (isPreview.value) return
  handleSelect(e, item)
}

const handleWidgetChildSelect = (item: WidgetConfig, childId: string) => {
  if (isPreview.value || item.component.info.keyName !== 'VPageMenu') return
  containerRef.value?.focus()
  sceneWidgetStore.setCurrentWidgetChildSelection({ frameId: item.id, childId })
  getWidgetRuntimePort().clearSceneObjectSelection()
}

type PageFrameChildDragPayload = {
  childId: string
  event: MouseEvent
  movingRect: AlignmentRect
  targets: AlignmentRect[]
  canvas: WidgetCanvasBounds
}
type PageFrameChildResizePayload = PageFrameChildDragPayload & {
  handle: PageFrameResizeHandle
}
type PageFrameMenuIconDragPayload = PageFrameChildDragPayload & {
  active: boolean
}
type PageFrameMenuIconResizePayload = PageFrameMenuIconDragPayload & {
  handle: PageFrameResizeHandle
}

const isPositionablePageFrameChild = (
  child: ReturnType<typeof findPageFrameChild>,
): child is PageFrameSelectableChild & PageFramePositionableChild =>
  child?.kind === 'logo' ||
  child?.kind === 'menu-slot' ||
  child?.kind === 'title' ||
  child?.kind === 'menu-button' ||
  child?.kind === 'weather' ||
  child?.kind === 'time' ||
  child?.kind === 'account'

/**
 * 页面框架的可拖动槽位不脱离框架本体创建独立部件，而是保存各自相对默认栅格的偏移。
 * 复用画布的缩放换算，确保编辑器缩放后鼠标位移仍准确落到设计坐标。
 */
const handleWidgetChildDrag = (item: WidgetConfig, payload: PageFrameChildDragPayload) => {
  if (isPreview.value || item.component.info.keyName !== 'VPageMenu') return
  if (sceneWidgetStore.isWidgetLocked(item.id)) return

  const child = findPageFrameChild(item.component.option as PageFrameOption, payload.childId)
  if (!isPositionablePageFrameChild(child) || child.locked) return

  const oldSnapshot = sceneWidgetStore.createWidgetHistorySnapshot([item.id])
  /** 页面框架内部几何使用局部坐标；显示到画布辅助层前转换为舞台坐标。 */
  const offsetChildGuidesToCanvas = (guides: AlignmentGuide[]) =>
    guides.map<AlignmentGuide>((guide) =>
      guide.axis === 'vertical'
        ? {
            ...guide,
            position: guide.position + item.component.attr.l,
            start: guide.start + item.component.attr.t,
            end: guide.end + item.component.attr.t,
          }
        : {
            ...guide,
            position: guide.position + item.component.attr.t,
            start: guide.start + item.component.attr.l,
            end: guide.end + item.component.attr.l,
          },
    )

  useGroupMove(
    payload.event,
    (deltaX, deltaY) => {
      child.offsetX = Math.min(
        PAGE_FRAME_CHILD_OFFSET_RANGE.max,
        Math.max(PAGE_FRAME_CHILD_OFFSET_RANGE.min, child.offsetX + deltaX),
      )
      child.offsetY = Math.min(
        PAGE_FRAME_CHILD_OFFSET_RANGE.max,
        Math.max(PAGE_FRAME_CHILD_OFFSET_RANGE.min, child.offsetY + deltaY),
      )
    },
    () => {
      // 拖拽过程直接修改当前响应式配置；松开后才失效缓存，避免每一帧重建页面框架实例。
      sceneWidgetStore.bumpWidgetRenderVersion(item.id)
      sceneWidgetStore.recordWidgetHistorySnapshot(
        '移动页面框架内部部件', oldSnapshot, sceneWidgetStore.createWidgetHistorySnapshot([item.id]),
      )
    },
    {
      onCancel: () => sceneWidgetStore.applyWidgetHistorySnapshot(oldSnapshot),
      movingRect: payload.movingRect,
      excludedWidgetIds: [item.id],
      targets: payload.targets,
      canvas: payload.canvas,
      onGuidesChange: (guides) => setAlignmentGuides(offsetChildGuidesToCanvas(guides)),
    },
  )
}

/**
 * 一级菜单沿用普通二维部件的四边八点缩放体验。
 * 菜单内部使用统一 scale，拖动左/上控制点时同步修正 offset，保持对侧边缘不动。
 */
const handleWidgetChildResize = (item: WidgetConfig, payload: PageFrameChildResizePayload) => {
  if (payload.event.button !== 0 || isPreview.value || item.component.info.keyName !== 'VPageMenu') return
  if (sceneWidgetStore.isWidgetLocked(item.id)) return

  const child = findPageFrameChild(item.component.option as PageFrameOption, payload.childId)
  if (!child || child.kind !== 'menu-button' || child.locked) return

  const originScale = Math.max(child.scale, PAGE_FRAME_MENU_SCALE_RANGE.min)
  const originOffsetX = child.offsetX
  const originOffsetY = child.offsetY
  const originWidth = Math.max(payload.movingRect.w, 1)
  const originHeight = Math.max(payload.movingRect.h, 1)
  const pointer = getWidgetPointerSession()
  if (!pointer) return
  const oldSnapshot = sceneWidgetStore.createWidgetHistorySnapshot([item.id])
  const hasLeft = payload.handle.includes('l')
  const hasRight = payload.handle.includes('r')
  const hasTop = payload.handle.includes('t')
  const hasBottom = payload.handle.includes('b')

  const handleResizeMove = throttle((event: MouseEvent) => {
    if (!pointer.isActive()) return
    const delta = sceneWidgetStore.screenDeltaToWidgetCanvasDelta(
      event.clientX - payload.event.clientX,
      event.clientY - payload.event.clientY,
    )
    const horizontalRatio = hasLeft
      ? 1 - delta.x / originWidth
      : hasRight
        ? 1 + delta.x / originWidth
        : 1
    const verticalRatio = hasTop
      ? 1 - delta.y / originHeight
      : hasBottom
        ? 1 + delta.y / originHeight
        : 1
    const ratio =
      hasLeft || hasRight
        ? hasTop || hasBottom
          ? Math.abs(horizontalRatio - 1) >= Math.abs(verticalRatio - 1)
            ? horizontalRatio
            : verticalRatio
          : horizontalRatio
        : verticalRatio
    const nextScale = Math.min(
      PAGE_FRAME_MENU_SCALE_RANGE.max,
      Math.max(PAGE_FRAME_MENU_SCALE_RANGE.min, originScale * ratio),
    )
    const widthDelta = originWidth * (nextScale / originScale - 1)
    const heightDelta = originHeight * (nextScale / originScale - 1)

    child.scale = nextScale
    child.offsetX = originOffsetX + (hasLeft ? -widthDelta / 2 : hasRight ? widthDelta / 2 : 0)
    child.offsetY = originOffsetY + (hasTop ? -heightDelta / 2 : hasBottom ? heightDelta / 2 : 0)
    sceneWidgetStore.bumpWidgetRenderVersion(item.id)
  }, 16)

  payload.event.preventDefault()
  payload.event.stopPropagation()
  pointer.attach({
    move: handleResizeMove,
    commit: () => sceneWidgetStore.recordWidgetHistorySnapshot(
      '调整页面菜单尺寸', oldSnapshot, sceneWidgetStore.createWidgetHistorySnapshot([item.id]),
    ),
    rollback: () => sceneWidgetStore.applyWidgetHistorySnapshot(oldSnapshot),
  })
}

const handleWidgetMenuIconDrag = (item: WidgetConfig, payload: PageFrameMenuIconDragPayload) => {
  if (isPreview.value || item.component.info.keyName !== 'VPageMenu') return
  if (sceneWidgetStore.isWidgetLocked(item.id)) return

  const child = findPageFrameChild(item.component.option as PageFrameOption, payload.childId)
  if (!child || child.kind !== 'menu-button' || child.locked) return

  const oldSnapshot = sceneWidgetStore.createWidgetHistorySnapshot([item.id])
  useGroupMove(
    payload.event,
    (deltaX, deltaY) => {
      child.iconOffsetX = Math.min(
        PAGE_FRAME_CHILD_OFFSET_RANGE.max,
        Math.max(PAGE_FRAME_CHILD_OFFSET_RANGE.min, child.iconOffsetX + deltaX),
      )
      child.iconOffsetY = Math.min(
        PAGE_FRAME_CHILD_OFFSET_RANGE.max,
        Math.max(PAGE_FRAME_CHILD_OFFSET_RANGE.min, child.iconOffsetY + deltaY),
      )
    },
    () => {
      sceneWidgetStore.bumpWidgetRenderVersion(item.id)
      sceneWidgetStore.recordWidgetHistorySnapshot(
        '移动菜单图标',
        oldSnapshot,
        sceneWidgetStore.createWidgetHistorySnapshot([item.id]),
      )
    },
    {
      onCancel: () => sceneWidgetStore.applyWidgetHistorySnapshot(oldSnapshot),
      movingRect: payload.movingRect,
      excludedWidgetIds: [item.id],
      targets: payload.targets,
      canvas: payload.canvas,
    },
  )
}

const handleWidgetMenuIconResize = (
  item: WidgetConfig,
  payload: PageFrameMenuIconResizePayload,
) => {
  if (payload.event.button !== 0 || isPreview.value || item.component.info.keyName !== 'VPageMenu') return
  if (sceneWidgetStore.isWidgetLocked(item.id)) return

  const child = findPageFrameChild(item.component.option as PageFrameOption, payload.childId)
  if (!child || child.kind !== 'menu-button' || child.locked) return

  const scaleKey = payload.active ? 'activeIconScale' : 'iconScale'
  const originScale = Math.max(child[scaleKey], PAGE_FRAME_MENU_SCALE_RANGE.min)
  const originWidth = Math.max(payload.movingRect.w, 1)
  const originHeight = Math.max(payload.movingRect.h, 1)
  const pointer = getWidgetPointerSession()
  if (!pointer) return
  const oldSnapshot = sceneWidgetStore.createWidgetHistorySnapshot([item.id])
  const hasLeft = payload.handle.includes('l')
  const hasRight = payload.handle.includes('r')
  const hasTop = payload.handle.includes('t')
  const hasBottom = payload.handle.includes('b')

  const handleResizeMove = throttle((event: MouseEvent) => {
    if (!pointer.isActive()) return
    const delta = sceneWidgetStore.screenDeltaToWidgetCanvasDelta(
      event.clientX - payload.event.clientX,
      event.clientY - payload.event.clientY,
    )
    const horizontalRatio = hasLeft
      ? 1 - delta.x / originWidth
      : hasRight
        ? 1 + delta.x / originWidth
        : 1
    const verticalRatio = hasTop
      ? 1 - delta.y / originHeight
      : hasBottom
        ? 1 + delta.y / originHeight
        : 1
    const ratio =
      hasLeft || hasRight
        ? hasTop || hasBottom
          ? Math.abs(horizontalRatio - 1) >= Math.abs(verticalRatio - 1)
            ? horizontalRatio
            : verticalRatio
          : horizontalRatio
        : verticalRatio
    child[scaleKey] = Math.min(
      PAGE_FRAME_MENU_SCALE_RANGE.max,
      Math.max(PAGE_FRAME_MENU_SCALE_RANGE.min, originScale * ratio),
    )
    sceneWidgetStore.bumpWidgetRenderVersion(item.id)
  }, 16)

  payload.event.preventDefault()
  payload.event.stopPropagation()
  pointer.attach({
    move: handleResizeMove,
    commit: () => sceneWidgetStore.recordWidgetHistorySnapshot(
      '调整菜单图标尺寸', oldSnapshot, sceneWidgetStore.createWidgetHistorySnapshot([item.id]),
    ),
    rollback: () => sceneWidgetStore.applyWidgetHistorySnapshot(oldSnapshot),
  })
}

const handleSelect = (e: MouseEvent, item: WidgetConfig) => {
  if (isPreview.value) return
  /**
   * 锁定组件在画布中完全不可选中。
   * 必须在更新 currentWidgetsIds 之前拦截，否则点击锁定组件会覆盖当前选择，
   * 甚至让它短暂显示选中框；拖动和缩放入口也分别保留锁定保护，形成完整防线。
   */
  if (sceneWidgetStore.isWidgetLocked(item.id)) return
  containerRef.value?.focus()

  /**
   * 画布中的选中框既是单击选择入口，也是多选后的拖动入口。
   * 点击当前多选集合中的任一部件时保留整个集合，让底层 useMove 能够为所有成员使用同一个
   * 位移量；点击集合外的部件仍然回到普通单选语义。
   */
  const currentWidgetIds = sceneWidgetStore.currentWidgetsIds || []
  const nextWidgetIds =
    currentWidgetIds.length > 1 && currentWidgetIds.includes(item.id)
      ? [...currentWidgetIds]
      : [item.id]
  sceneWidgetStore.setCurrentWidgetsIds(nextWidgetIds)
  getWidgetRuntimePort().clearSceneObjectSelection()
  useMove(e, item, { onGuidesChange: setAlignmentGuides })
}

const handleActiveWidgetMouseDown = (e: MouseEvent, item: WidgetConfig) => {
  if (sceneWidgetStore.isWidgetLocked(item.id)) return
  useMove(e, item, { onGuidesChange: setAlignmentGuides })
}

const handleWidgetResizeMouseDown = (e: MouseEvent, item: WidgetConfig, type: DragType) => {
  if (sceneWidgetStore.isWidgetLocked(item.id)) return
  useResize(e, item, type)
}

/**
 * 分组代理整体拖动：按下时保存一次成员快照，移动中仅更新坐标，松开后只提交一条历史。
 * 锁定判断同时覆盖组锁和成员自身锁，防止代理绕过单节点保护。
 */
const handleGroupMouseDown = (e: MouseEvent) => {
  const groupId = sceneWidgetStore.currentWidgetGroupId
  if (!groupId || sceneWidgetStore.isWidgetGroupTransformLocked(groupId)) return
  const widgetIds = sceneWidgetStore.getGroupWidgetIds(groupId)
  /** 隐藏成员松手后也可能重新显示；边界约束必须覆盖组内全部成员。 */
  const groupBounds = sceneWidgetStore.getGroupBounds(groupId, true)
  if (!widgetIds.length || !groupBounds) return

  containerRef.value?.focus()
  const oldSnapshot = sceneWidgetStore.createWidgetHistorySnapshot(widgetIds)
  useGroupMove(
    e,
    (deltaX, deltaY) => sceneWidgetStore.moveWidgetGroup(groupId, deltaX, deltaY),
    () => {
      sceneWidgetStore.recordWidgetHistorySnapshot(
        '移动部件分组',
        oldSnapshot,
        sceneWidgetStore.createWidgetHistorySnapshot(widgetIds),
      )
    },
    {
      onCancel: () => sceneWidgetStore.applyWidgetHistorySnapshot(oldSnapshot),
      movingRect: { ...groupBounds, id: groupId },
      excludedWidgetIds: widgetIds,
      onGuidesChange: setAlignmentGuides,
    },
  )
}

const getWidgetRenderState = (id: string) => {
  return widgetRenderStateMap.value[id] || defaultWidgetRenderState
}

/**
 * 持久化动画属于场景配置的一部分，继续交给模板 class 绑定即可。
 * 这样保存、回显和正常渲染都保持 declarative，不会增加维护成本。
 */
const resolvePersistedAnimationClass = (item: WidgetConfig) => {
  return resolveWidgetAnimationClass({
    packageName: item.component.info.packageName,
    animations: Array.isArray(item.component.styles?.animations)
      ? item.component.styles.animations
      : [],
  })
}

/**
 * hover 预览属于编辑器瞬时态，不参与场景 schema。
 * 这里直接监听 preview store，把旧目标的类移除、把新目标的类追加到目标 DOM：
 * - 时间复杂度稳定在 O(1)；
 * - 不再让 v-for 中的每一个部件都响应 preview 变化；
 * - 图表和控件的内部实例也不会因为 preview hover 被动进入重算链。
 */
watch(
  () => sceneWidgetStore.widgetAnimationPreview,
  (nextPreviewState, previousPreviewState) => {
    if (previousPreviewState?.widgetId) {
      removePreviewAnimationClass(previousPreviewState.widgetId)
    }

    if (nextPreviewState?.widgetId && nextPreviewState.animation) {
      applyPreviewAnimationClass(nextPreviewState.widgetId, nextPreviewState.animation)
    }
  },
)

/**
 * 部件预览态的点击、双击、移入、移出都需要转发给交互模块。
 * 不这样做的话，右侧给部件配置的交互事件只能保存，永远不会在画布 DOM 层真正触发。
 */
const dispatchWidgetDomEvent = (
  item: WidgetConfig,
  eventType: INTERACTIVE_EVENT_ENUM,
  childId?: string | null,
) => {
  if (!isPreview.value) return
  // 除浏览器命中穿透外再阻止组件交互分发，避免残留事件触发已禁用组件。
  if ((item.component.option as Record<string, unknown> | undefined)?.interactive === false) return
  getWidgetRuntimePort().handleInteractiveEvent(item.id, eventType, childId)
}

const resolvePageFrameChildElement = (target: EventTarget | null) =>
  target instanceof HTMLElement ? target.closest<HTMLElement>('[data-page-frame-child-id]') : null

/**
 * 普通二维组件仍以整组件触发；页面框架则把点击和双击精确路由到命中的子项，
 * 避免“首页”、天气和管理员共用框架根节点上的同一份事件列表。
 */
const handleWidgetDomEvent = (
  event: MouseEvent,
  item: WidgetConfig,
  eventType: INTERACTIVE_EVENT_ENUM,
) => {
  if (item.component.info.keyName !== 'VPageMenu') {
    dispatchWidgetDomEvent(item, eventType)
    return
  }

  const childId = resolvePageFrameChildElement(event.target)?.dataset.pageFrameChildId
  if (childId) dispatchWidgetDomEvent(item, eventType, childId)
}

/**
 * mouseenter/mouseleave 不冒泡，页面框架使用 mouseover/mouseout 委托模拟子项边界。
 * 同一子项内部元素之间移动时不重复触发，只有真正进入或离开该子项才转发现有事件类型。
 */
const handlePageFrameChildHover = (
  event: MouseEvent,
  item: WidgetConfig,
  eventType: INTERACTIVE_EVENT_ENUM,
) => {
  if (item.component.info.keyName !== 'VPageMenu') return
  const childElement = resolvePageFrameChildElement(event.target)
  const childId = childElement?.dataset.pageFrameChildId
  if (!childId) return

  const relatedChildId = resolvePageFrameChildElement(event.relatedTarget)?.dataset.pageFrameChildId
  if (relatedChildId === childId) return
  dispatchWidgetDomEvent(item, eventType, childId)
}

/** 输入控件和可编辑内容需要保留浏览器自身的方向键行为。 */
const isEditableKeyboardTarget = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) return false
  const tagName = target.tagName.toLowerCase()
  return (
    tagName === 'input' ||
    tagName === 'textarea' ||
    tagName === 'select' ||
    tagName === 'button' ||
    tagName === 'a' ||
    target.isContentEditable ||
    Boolean(target.closest('[contenteditable="true"]'))
  )
}

const widgetNudgeDirectionByKey: Record<string, WidgetNudgeDirection> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
}

const handleKeyDown = (e: KeyboardEvent) => {
  if (editorSceneOperation.value) return
  if (isPreview.value) return
  if (e.isComposing || isEditableKeyboardTarget(e.target)) return

  /** Ctrl/Command/Alt 组合键交给浏览器或编辑器快捷键，避免抢占其它功能。 */
  if (e.ctrlKey || e.metaKey || e.altKey) return

  const nudgeDirection = widgetNudgeDirectionByKey[e.key]
  if (nudgeDirection) {
    /** 每次方向键只移动一个逻辑画布单位，Store 会统一处理边界、多选和历史记录。 */
    e.preventDefault()
    sceneWidgetStore.nudgeCurrentWidgets(nudgeDirection)
    return
  }

  if (e.key === 'Delete') {
    /** Store 仍会做第二层锁定校验，这里提前返回可避免无效命令和多余响应式更新。 */
    if ((sceneWidgetStore.currentWidgetsIds || []).some(sceneWidgetStore.isWidgetLocked)) return
    sceneWidgetStore.deleteWidgets(sceneWidgetStore.currentWidgetsIds || [])
  }
}
</script>

<style scoped>
/* 浏览器原生命中穿透覆盖整棵组件子树，包含内部显式启用鼠标事件的图表、视频和内嵌页。
 * 不合成或转发鼠标事件，因此单击、双击、右键、中键及滚轮直接交给下方场景。 */
[data-pointer-through='true'],
[data-pointer-through='true'] :deep(*) {
  pointer-events: none !important;
}
.scene-edit-widget-viewport {
  position: relative;

  /**
   * 中国 3D 地图 Presenter 与底层 Three/Cesium Runtime 共用同一舞台。
   * 地图 Presenter 固定处于 0 层；为整个二维宿主建立正层级上下文，确保二维组件始终位于地图之上，
   * 再由子节点 zIndex 保持二维组件之间的原有遮挡顺序。
   * 该值只影响运行时 DOM 叠加关系，不写入场景数据，也不会增加每帧计算或改变组件排序算法。
   */
  z-index: 1;
  width: 100%;
  height: 100%;
  overflow: hidden;
  pointer-events: none;
}
.scene-edit-widget-canvas {
  position: absolute;
  top: 0;
  left: 0;
  pointer-events: none;
  transform-origin: left top;
}
.scene-edit-alignment-guide {
  position: absolute;
  z-index: 2147483646;
  pointer-events: none;
  background: #2986ff;
  box-shadow: 0 0 4px rgb(41 134 255 / 65%);
}
.scene-edit-alignment-guide.is-vertical {
  width: 1px;
  transform: translateX(-0.5px);
}
.scene-edit-alignment-guide.is-horizontal {
  height: 1px;
  transform: translateY(-0.5px);
}
.scene-edit-group-active-box {
  background: rgb(90 178 165 / 8%);
  border: 1px solid #5ab2a5;
  box-shadow: inset 0 0 0 1px rgb(90 178 165 / 12%);
}
.scene-edit-group-active-box.is-locked {
  cursor: not-allowed;
  background: rgb(255 255 255 / 4%);
  border-color: rgb(255 255 255 / 36%);
}
</style>
