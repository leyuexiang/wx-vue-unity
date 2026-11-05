<template>
  <!--
    滚动行为由 SceneRightPanel 的唯一属性滚动容器负责。
    二维组件基础面板只提供内容根节点，避免与外层重复计算视口高度、产生双滚动条或重复 12px 留白。
  -->
  <div
    v-if="widgetComponent"
    class="scene-edit-property-content"
    data-widget-base-editor
    :inert="Boolean(editorSceneOperation) || undefined"
  >
    <!-- Figma 对二维组件的首个分组统一命名为“通用”，用于承载名称、启用、尺寸、对齐与位置。 -->
    <section v-if="!widgetChildId" class="scene-edit-property-section">
      <div class="scene-edit-property-section__header">通用</div>
      <div class="scene-edit-property-section__body">
        <WidgetBase
          v-if="widgetComponent.attr"
          :key="widgetId ?? undefined"
          :data="widgetComponent.attr"
          :label="
            ((widgetComponent.option as Record<string, unknown> | undefined)?.label as string) ?? ''
          "
          :visible="widgetVisible"
          :interactive="(widgetComponent.option as Record<string, unknown>).interactive !== false"
          :locked="widgetLockState.effectiveLocked"
          :inherited-locked="widgetLockState.inheritedLocked"
          @update:label="updateWidgetLabel"
          @update:visible="updateWidgetVisible"
          @update:interactive="updateWidgetInteractive"
          @update:locked="updateWidgetLocked"
          @attr-change="updateWidgetAttr"
        />
      </div>
    </section>
    <div
      :inert="widgetLockState.effectiveLocked || undefined"
      :aria-disabled="widgetLockState.effectiveLocked"
    >
      <component
        :is="widgetConfigPanelComponent"
        v-if="widgetConfigPanelComponent && (!usesNestedOption || nestedOption)"
        :key="widgetConfigPanelKey"
        :option="nestedOption?.draft ?? widgetComponent.option"
        :selected-child-id="widgetChildId || ''"
        @update:option="updateWidgetOption"
        @select-child="selectWidgetChild"
      />
    </div>
  </div>

  <!-- 分组也复用同一内容根节点，保证切换单个组件、分组时视觉坐标不跳变。 -->
  <div v-else-if="widgetGroupId" class="scene-edit-property-content">
    <section class="scene-edit-property-section">
      <div class="scene-edit-property-section__header">通用</div>
      <div class="scene-edit-property-section__body">
        <WidgetGroupBase :group-id="widgetGroupId" />
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, shallowRef, watch } from 'vue'
import { cloneDeep, isEqual } from 'lodash-es'
import type { WidgetConfig } from '@/stores/sceneEditStore'
import type { ViewportHost } from '@/scene-platform'
import WidgetBase from '../../BasePanel/WidgetBase/index.vue'
import WidgetGroupBase from '../../BasePanel/WidgetGroupBase/index.vue'
import { COMPONENT_TYPE, getComponentName } from '@/utils/components'
import { subscribeActiveSceneViewportHost } from '@/integrations/scene/editorScenePlatformHost'
import { editorSceneOperation, subscribeEditorSceneBeforeOperation } from '@/integrations/scene/editorSceneOperationGate'
import {
  bumpWidgetPanelRenderVersion,
  getWidgetByPanelId,
  getWidgetPanelLockState,
  runWidgetPanelHistoryChange,
  resolveWidgetPanelSelection,
  setWidgetPanelLocked,
  setWidgetPanelChildSelection,
  setWidgetPanelVisible,
} from '@/integrations/scene/widgetPanels'

defineOptions({ name: 'WidgetBasePanel' })

const widgetComponent = ref<WidgetConfig['component'] | null>(null)
const widgetId = ref<string | null>(null)
const widgetGroupId = ref<string | null>(null)
const widgetChildId = ref<string | null>(null)

let pendingWidgetRenderFrame = 0

/**
 * 二维基础面板只读取二维适配层暴露的部件目标。
 * 这里不访问 sceneApi、renderScene 或 sceneModules，避免和三维对象基础面板继续耦合。
 */
const syncWidgetTarget = () => {
  const selection = resolveWidgetPanelSelection()
  widgetGroupId.value = selection.kind === 'widgetGroup' ? selection.id : null

  if (selection.kind !== 'widget' && selection.kind !== 'widgetChild') {
    widgetId.value = null
    widgetChildId.value = null
    widgetComponent.value = null
    nestedOption.value = null
    return
  }

  widgetId.value = selection.kind === 'widget' ? selection.id : selection.frameId
  widgetChildId.value = selection.kind === 'widgetChild' ? selection.childId : null
  widgetComponent.value = selection.widget.component
  syncNestedOption()

  /**
   * 旧场景或热更新前已创建的页面菜单可能仍命中旧画布缓存。
   * 第一次选中时只刷新该菜单实例，确保默认菜单树立即在画布上重新挂载，
   * 不影响同场景的图表、模型或其他二维部件。
   */
  if (widgetComponent.value.info.keyName === 'VPageMenu') {
    scheduleWidgetRenderRefresh()
  }
}

const widgetVisible = computed(() => {
  if (!widgetComponent.value) return true
  const option = widgetComponent.value.option as Record<string, unknown> | undefined
  return option?.visible !== false
})

const widgetLockState = computed(() =>
  widgetId.value
    ? getWidgetPanelLockState(widgetId.value)
    : { ownLocked: false, inheritedLocked: false, effectiveLocked: false },
)

const widgetConfigPanelComponent = computed(() => {
  if (!widgetComponent.value) return null
  return getComponentName(
    COMPONENT_TYPE.CONFIG_PANEL,
    widgetComponent.value.info.packageName,
    widgetComponent.value.info.keyName,
  )
})

const widgetConfigPanelKey = computed(
  () => `${widgetId.value || 'widget-config-empty'}:${widgetChildId.value || 'frame'}`,
)

const scheduleWidgetRenderRefresh = () => {
  const targetId = widgetId.value
  if (!targetId) return

  if (pendingWidgetRenderFrame) {
    cancelAnimationFrame(pendingWidgetRenderFrame)
  }

  pendingWidgetRenderFrame = requestAnimationFrame(() => {
    bumpWidgetPanelRenderVersion(targetId)
    pendingWidgetRenderFrame = 0
  })
}

type WidgetComponent = WidgetConfig['component']
type WidgetOption = WidgetComponent['option']
const usesNestedOption = computed(() => {
  const key = widgetComponent.value?.info.keyName
  return key === 'VPageMenu' || key === 'VPagePagination'
})

const nestedOption = shallowRef<{
  id: string
  component: WidgetComponent
  draft: WidgetOption
  base: WidgetOption
} | null>(null)

// 旧菜单和分页器在子控件中直接修改嵌套对象。交给它们独立草稿，画布仍只读仓库数据。
const syncNestedOption = () => {
  const id = widgetId.value
  const component = widgetComponent.value
  if (!id || !component || !usesNestedOption.value) {
    nestedOption.value = null
    return
  }
  const previous = nestedOption.value
  if (previous?.id === id && previous.component === component
      && isEqual(previous.base, component.option)) return
  nestedOption.value = {
    id,
    component,
    draft: reactive(cloneDeep(component.option)),
    base: cloneDeep(component.option),
  }
}

const flushNestedOption = () => {
  const current = nestedOption.value
  if (!current || editorSceneOperation.value || isEqual(current.draft, current.base)) return
  if (getWidgetByPanelId(current.id)?.component !== current.component
      || !isEqual(current.base, current.component.option) || getWidgetPanelLockState(current.id).effectiveLocked) {
    nestedOption.value = null
    syncNestedOption()
    return
  }
  // 同一个事件中的多处嵌套写入一起提交，选中切换后也按原部件编号结算。
  const nextOption = cloneDeep(current.draft)
  runWidgetPanelHistoryChange('更新部件配置', [current.id], () => {
    current.component.option = nextOption
    bumpWidgetPanelRenderVersion(current.id)
  })
  // 基线必须与仓库分离，画布可能直接修改仓库里的嵌套坐标。
  current.base = cloneDeep(nextOption)
}

const selectWidgetChild = (childId: string) => {
  if (!widgetId.value) return
  flushNestedOption()
  setWidgetPanelChildSelection(widgetId.value, childId)
}

const editWidget = (name: string, mutate: (component: WidgetComponent) => void, mergeSession?: symbol) => {
  const id = widgetId.value
  const component = widgetComponent.value
  if (!id || !component || editorSceneOperation.value || widgetLockState.value.effectiveLocked
      || getWidgetByPanelId(id)?.component !== component) return
  flushNestedOption()
  runWidgetPanelHistoryChange(name, [id], () => mutate(component), { mergeSession })
}

const updateWidgetAttr = (patch: Partial<WidgetComponent['attr']>, mergeSession?: symbol) => {
  // 宽高联动仍属于触发它的单个输入会话，对齐等独立操作不传入标识。
  editWidget('更新部件位置与尺寸', (component) => Object.assign(component.attr, patch), mergeSession)
}

const shouldRefreshWidgetRender = () => {
  if (!widgetComponent.value) return false
  return (
    widgetComponent.value.info.packageName === 'Chart' ||
    widgetComponent.value.info.packageName === 'Control' ||
    /**
     * 页面菜单在资源面板归入“部件 -> 控件”，运行时仍属于 Widget 包。
     * 它的菜单树直接编辑 option.menus，必须失效当前画布缓存，
     * 否则右侧配置已变而画布仍可能保持拖入时的旧快照。
     */
    widgetComponent.value.info.keyName === 'VPageMenu' ||
    // 页面分页器的页签列表通过右侧面板原地编辑，需要失效当前部件的画布配置缓存。
    widgetComponent.value.info.keyName === 'VPagePagination'
  )
}

const updateWidgetOption = (value: unknown) => {
  editWidget('更新部件配置', (component) => {
    component.option = value as WidgetOption
    if (shouldRefreshWidgetRender()) scheduleWidgetRenderRefresh()
  })
}

/** 公共开关和名称在同一仓库事务中写入并登记。 */
const updateWidgetInteractive = (value: boolean) => {
  editWidget('更新部件交互', (component) => {
    component.option = { ...component.option, interactive: value }
    scheduleWidgetRenderRefresh()
  })
}

const updateWidgetLabel = (value: string) => {
  editWidget('更新部件名称', (component) => {
    component.option = { ...component.option, label: value }
    if (shouldRefreshWidgetRender()) scheduleWidgetRenderRefresh()
  })
}

/** 显隐底层也供预览使用，只有编辑面板把它登记进历史。 */
const updateWidgetVisible = (value: boolean) => {
  const id = widgetId.value
  if (!id || editorSceneOperation.value || getWidgetByPanelId(id)?.component !== widgetComponent.value) return
  flushNestedOption()
  runWidgetPanelHistoryChange('更新部件显隐', [id], () => setWidgetPanelVisible(id, value))
}

/** 锁定入口已在仓库中登记，面板只负责先结算配置草稿。 */
const updateWidgetLocked = (value: boolean) => {
  if (!widgetId.value || editorSceneOperation.value || widgetLockState.value.inheritedLocked) return
  flushNestedOption()
  setWidgetPanelLocked(widgetId.value, value)
}

watch(
  () => resolveWidgetPanelSelection(),
  () => {
    flushNestedOption()
    syncWidgetTarget()
  },
  { immediate: true },
)

watch(() => nestedOption.value?.draft, flushNestedOption, { deep: true })
watch(
  [() => editorSceneOperation.value ? undefined : nestedOption.value?.component.option, editorSceneOperation],
  () => {
    if (editorSceneOperation.value) return
    // 拖拽期间不跟踪仓库的逐帧写入，结束后再更新表单基线并结算迟到的表单结果。
    syncNestedOption()
    flushNestedOption()
  },
  { deep: true },
)

const stopBeforeOperation = subscribeEditorSceneBeforeOperation(flushNestedOption)
let panelHost: ViewportHost | null = null
let stopSceneLoad: (() => void) | undefined
const stopHost = subscribeActiveSceneViewportHost((host) => {
  if (panelHost === host) return
  panelHost = host
  stopSceneLoad?.()
  nestedOption.value = null
  if (host) syncNestedOption()
  stopSceneLoad = host?.getStore().subscribe((event) => {
    // 同编号场景重载也会废弃旧表单，防止迟到的嵌套更新落到新草稿。
    if (event.type === 'sceneLoaded') nestedOption.value = null
  })
})
onBeforeUnmount(() => {
  stopBeforeOperation()
  stopHost()
  stopSceneLoad?.()
  flushNestedOption()
  if (pendingWidgetRenderFrame) cancelAnimationFrame(pendingWidgetRenderFrame)
})
</script>
