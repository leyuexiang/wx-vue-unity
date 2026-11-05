<template>
  <!--
    右侧属性面板共享的纯数字输入控件。
    组件提供外观、前缀和输入会话标识；数值范围、v-model 以及何时写入历史仍由调用方决定，
    因此不会把图表配置、天气状态或场景运行时逻辑耦合进公共控件。
  -->
  <div
    class="scene-edit-property-number-input"
    :class="{ 'is-error': Boolean(errorMessage) }"
  >
    <el-input-number
      v-model="model"
      v-bind="$attrs"
      :controls="controls"
      class="scene-edit-property-number-input__control"
      @focus="beginEdit"
      @blur="endEdit"
      @update:model-value="emit('edit-input', $event, editSession)"
      @change="emit('edit-commit', $event, editSession)"
    >
      <template v-if="prefix" #prefix>
        <span class="scene-edit-property-number-input__prefix">{{ prefix }}</span>
      </template>
      <!--
        转发调用方的单位后缀，保证公共数字输入框替换 Element Plus 原生控件后，
        MB、毫秒等语义单位仍显示在输入框右侧；没有传入后缀时不新增任何节点。
      -->
      <template v-if="$slots.suffix" #suffix>
        <slot name="suffix" />
      </template>
    </el-input-number>
    <p v-if="errorMessage" class="scene-edit-property-number-input__error">
      {{ errorMessage }}
    </p>
  </div>
</template>

<script setup lang="ts">
defineOptions({
  /** 关闭属性继承，保证传入的 Element Plus 属性只落在内部数字输入框上。 */
  inheritAttrs: false,
})

withDefaults(
  defineProps<{
    /** 输入框左侧的语义前缀，例如 Figma 标题样式中的“大小”。 */
    prefix?: string
    /** 由调用方显式传入的错误说明；为空时不占用额外垂直空间。 */
    errorMessage?: string
    /** 默认关闭上下调节按钮，保持 Figma 的纯输入框形态。 */
    controls?: boolean
  }>(),
  {
    prefix: '',
    errorMessage: '',
    controls: false,
  },
)

/** 图表字号等数字字段只向 Element Plus 传递数字或空值，避免控件内部出现字符串类型分支。 */
const model = defineModel<number | null | undefined>()

const emit = defineEmits<{
  'edit-input': [value: number | null | undefined, session: symbol | undefined]
  'edit-commit': [value: number | null | undefined, session: symbol | undefined]
}>()
// 一个控件的一次聚焦就是一次连续输入。独立点击和下一次聚焦不会沿用旧标识。
let editSession: symbol | undefined
const beginEdit = () => { editSession = Symbol('数字字段编辑') }
const endEdit = () => { editSession = undefined }
</script>
