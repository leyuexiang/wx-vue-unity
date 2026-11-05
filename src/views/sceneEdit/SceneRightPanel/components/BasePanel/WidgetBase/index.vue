<template>
  <div>
    <!-- 顶部页签已提供“基础”语义，这里去掉重复标题，保持面板更紧凑。 -->
    <setting-item-box name="名称" :alone="true">
      <setting-item>
        <ScenePropertyInput
          v-model="labelDraft"
          placeholder="名称"
          :disabled="locked"
          @change="commitLabel"
        />
      </setting-item>
    </setting-item-box>

    <setting-item-box name="启用" :alone="true">
      <setting-item>
        <!-- 二维部件显隐与模型属性区共享 28×16px 绿色开关。 -->
        <ScenePropertySwitch v-model="visibleModel" />
      </setting-item>
    </setting-item-box>

    <!-- 所有二维组件共用此开关；仅预览阶段穿透，编辑时仍可正常选中。 -->
    <setting-item-box name="是否可交互" :alone="true">
      <setting-item>
        <ScenePropertySwitch v-model="interactiveModel" :disabled="locked" />
      </setting-item>
    </setting-item-box>

    <setting-item-box name="锁定" :alone="true">
      <setting-item>
        <!-- 继承父组锁定时只展示有效状态，必须先解锁父组，避免子项出现无效开关。 -->
        <ScenePropertySwitch v-model="lockedModel" :disabled="inheritedLocked" />
      </setting-item>
    </setting-item-box>

    <div :inert="locked || undefined" :aria-disabled="locked">
      <!-- 比例按钮和两项尺寸共用一行；使用零最小列宽适配窄属性面板。 -->
      <setting-item-box
        name="尺寸"
        class="widget-size-row"
        :item-right-style="{
          gridTemplateColumns: '28px minmax(0, 1fr) minmax(0, 1fr)',
          columnGap: '4px',
        }"
      >
        <button
          type="button"
          class="widget-aspect-lock"
          :class="{ 'is-active': aspectLocked }"
          :title="aspectLockLabel"
          :aria-label="aspectLockLabel"
          :aria-pressed="aspectLocked"
          :disabled="locked || (!aspectLocked && !(data.w > 0 && data.h > 0))"
          @click="toggleAspectLock"
        >
          <el-icon aria-hidden="true"><Lock v-if="aspectLocked" /><Unlock v-else /></el-icon>
        </button>
        <setting-item name="宽度">
          <!--
          图表、控件等二维部件共用画布尺寸的纯输入框：关闭上下调节按钮，保留数字值与最小值校验。
          这里使用 Element Plus 的无控制按钮变体，避免原生 number 输入框在右侧显示浏览器自带微调器。
        -->
          <ScenePropertyNumberInput
            :model-value="data.w"
            placeholder="宽度"
            :min="0"
            :step="1"
            :controls="false"
            disabled-scientific
            @edit-input="(value, session) => updateSize('w', value, session)"
          />
        </setting-item>
        <setting-item name="高度">
          <ScenePropertyNumberInput
            :model-value="data.h"
            placeholder="高度"
            :min="0"
            :step="1"
            :controls="false"
            disabled-scientific
            @edit-input="(value, session) => updateSize('h', value, session)"
          />
        </setting-item>
      </setting-item-box>

      <!-- 锁定时对齐和位置同样属于不可编辑配置，统一放在只读区域内。 -->
      <SceneWidgetAlignControl :actions="alignActions" />

      <setting-item-box name="位置">
        <setting-item name="左">
          <!-- 位置和尺寸使用相同的数字输入框，由父面板统一提交。 -->
          <ScenePropertyNumberInput
            :model-value="data.l"
            placeholder="左"
            :step="1"
            :controls="false"
            disabled-scientific
            @edit-input="(value, session) => updatePosition('l', value, session)"
          />
        </setting-item>
        <setting-item name="上">
          <ScenePropertyNumberInput
            :model-value="data.t"
            placeholder="上"
            :step="1"
            :controls="false"
            disabled-scientific
            @edit-input="(value, session) => updatePosition('t', value, session)"
          />
        </setting-item>
      </setting-item-box>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Lock, Unlock } from '@element-plus/icons-vue'
import {
  getWidgetAspectRatio,
  getWidgetSize,
  toggleWidgetAspectRatio,
} from '@/utils/widgetAspectRatio'
import type BaseWidgetConfig from '@/packages/components/BaseWidgetConfig'
import { getWidgetPanelCanvasConfig } from '@/integrations/scene/widgetPanels'
import { ref, watch, type PropType } from 'vue'
import ScenePropertySwitch from '../../PropertyControls/ScenePropertySwitch/index.vue'
import SceneWidgetAlignControl from '../../PropertyControls/SceneWidgetAlignControl/index.vue'

defineOptions({ name: 'WidgetBase' })

const props = defineProps({
  data: { type: Object as PropType<BaseWidgetConfig['attr']>, required: true },
  label: { type: String, default: '' },
  visible: { type: Boolean, default: true },
  /** 未设置的旧组件默认允许交互，保持原有行为。 */
  interactive: { type: Boolean, default: true },
  locked: { type: Boolean, default: false },
  inheritedLocked: { type: Boolean, default: false },
})

const emit = defineEmits<{
  (e: 'update:label', value: string): void
  (e: 'update:visible', value: boolean): void
  (e: 'update:interactive', value: boolean): void
  (e: 'update:locked', value: boolean): void
  (e: 'attr-change', patch: Partial<BaseWidgetConfig['attr']>, session?: symbol): void
}>()

// 文本在输入框内编辑，确认后再写仓库，避免每个字符占用一步历史。
const labelDraft = ref<string | number>(props.label)
watch(() => props.label, (label) => { labelDraft.value = label })
const commitLabel = () => emit('update:label', String(labelDraft.value))

/**
 * 部件显隐作为部件级通用属性，统一回写到 option.visible。
 * 这里不直接操作渲染层，只负责把开关状态上抛给基础面板。
 */
const visibleModel = computed({
  get: () => props.visible,
  set: (value: boolean) => emit('update:visible', value),
})

const lockedModel = computed({
  get: () => props.locked,
  set: (value: boolean) => emit('update:locked', value),
})

/** 对外统一布尔值，与其它公共属性开关使用相同的双向绑定协议。 */
const interactiveModel = computed({
  get: () => props.interactive,
  set: (value: boolean) => emit('update:interactive', value),
})

// 子控件只提交属性变更，由父面板在仓库写入前记录基线。
const updatePosition = (axis: 'l' | 't', value: number | null | undefined, session?: symbol) => {
  if (props.locked || typeof value !== 'number' || !Number.isFinite(value)) return
  emit('attr-change', { [axis]: value }, session)
}

/** 锁状态由持久化属性派生，切换选中项、撤销和重新打开时无需额外同步。 */
const aspectLocked = computed(() => Boolean(getWidgetAspectRatio(props.data)))
const aspectLockLabel = computed(() =>
  aspectLocked.value ? '解锁宽高比' : '锁定宽高比（需正宽高）',
)

const toggleAspectLock = () => {
  if (props.locked) return
  const attr = { ...props.data }
  toggleWidgetAspectRatio(attr)
  emit('attr-change', { aspectRatio: attr.aspectRatio })
}

/** 两轴一次性提交；空值不写入，保留锁定比例的小数精度。 */
const updateSize = (axis: 'w' | 'h', value: number | null | undefined, session?: symbol) => {
  if (props.locked || typeof value !== 'number' || !Number.isFinite(value)) return
  emit('attr-change', getWidgetSize(props.data, axis, value), session)
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

const getCanvasSize = () => {
  /**
   * 对齐按钮只写 1920x1080 设计舞台坐标。
   * 最终显示缩放由外层统一舞台完成，不再为单个部件额外保存锚点。
   */
  return getWidgetPanelCanvasConfig()
}

const alignLeft = () => {
  updatePosition('l', 0)
}

const alignHorizontalCenter = () => {
  const canvas = getCanvasSize()
  if (!canvas) return
  updatePosition('l', clamp((canvas.width - Number(props.data.w || 0)) / 2, 0, canvas.width))
}

const alignRight = () => {
  const canvas = getCanvasSize()
  if (!canvas) return
  updatePosition('l', Math.max(canvas.width - Number(props.data.w || 0), 0))
}

const alignTop = () => {
  updatePosition('t', 0)
}

const alignVerticalCenter = () => {
  const canvas = getCanvasSize()
  if (!canvas) return
  updatePosition('t', clamp((canvas.height - Number(props.data.h || 0)) / 2, 0, canvas.height))
}

const alignBottom = () => {
  const canvas = getCanvasSize()
  if (!canvas) return
  updatePosition('t', Math.max(canvas.height - Number(props.data.h || 0), 0))
}

type AlignAction = {
  key: 'left' | 'h-center' | 'right' | 'top' | 'v-center' | 'bottom'
  label: string
  run: () => void
}

const alignActions: AlignAction[] = [
  { key: 'left', label: '左对齐', run: alignLeft },
  { key: 'h-center', label: '水平居中', run: alignHorizontalCenter },
  { key: 'right', label: '右对齐', run: alignRight },
  { key: 'top', label: '顶部对齐', run: alignTop },
  { key: 'v-center', label: '垂直居中', run: alignVerticalCenter },
  { key: 'bottom', label: '底部对齐', run: alignBottom },
]
</script>

<style scoped>
/* 局部收紧尺寸项，沿用面板输入框的边框、背景和主题高亮色。 */
.widget-size-row :deep(.setting-item) {
  min-width: 0;
}
.widget-aspect-lock {
  /* 与现有对齐按钮共用深色配色，避免全局浅色控件变量产生白底。 */
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 32px;
  padding: 0;
  color: rgb(255 255 255 / 60%);
  cursor: pointer;
  background: #131c26;
  border: 1px solid rgb(255 255 255 / 14%);
  border-radius: 2px;
}
.widget-aspect-lock.is-active,
.widget-aspect-lock:hover:not(:disabled) {
  color: #5ab2a5;
  border-color: rgb(90 178 165 / 60%);
}
.widget-aspect-lock:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
</style>
