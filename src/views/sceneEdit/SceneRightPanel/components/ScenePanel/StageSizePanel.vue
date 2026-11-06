<template>
  <section class="scene-stage-size-panel">
    <div class="scene-stage-size-panel__title">发布画布</div>
    <label class="scene-stage-size-panel__field">
      <span>尺寸</span>
      <div class="scene-stage-size-panel__fields">
        <!-- 宽高等分属性行剩余空间，并继续复用原有提交、失焦与卸载兜底逻辑。 -->
        <ScenePropertyNumberInput
          v-model="stageWidth"
          class="scene-stage-size-panel__input"
          :min="SCENE_STAGE_SIZE_LIMIT.min"
          :max="SCENE_STAGE_SIZE_LIMIT.max"
          :step="10"
          :controls="false"
          disabled-scientific
          @change="applyStageSizeChange"
          @blur="applyStageSizeChange"
        />
        <span class="scene-stage-size-panel__separator">x</span>
        <ScenePropertyNumberInput
          v-model="stageHeight"
          class="scene-stage-size-panel__input"
          :min="SCENE_STAGE_SIZE_LIMIT.min"
          :max="SCENE_STAGE_SIZE_LIMIT.max"
          :step="10"
          :controls="false"
          disabled-scientific
          @change="applyStageSizeChange"
          @blur="applyStageSizeChange"
        />
      </div>
    </label>
  </section>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import type { WidgetCanvasConfig } from '@/types/threeScene'
import {
  commitSceneStageSizeChange,
  getCurrentSceneStageSize,
  getSceneStageSizeState,
} from '@/integrations/scene/sceneStage'
import { createDefaultSceneStageSize, SCENE_STAGE_SIZE_LIMIT } from '@/utils/sceneStage'
import { editorSceneOperation, subscribeEditorSceneBeforeOperation } from '@/integrations/scene/editorSceneOperationGate'

defineOptions({ name: 'SceneStageSizePanel' })

const defaultStageSize = createDefaultSceneStageSize()

const stageWidth = ref(defaultStageSize.width)
const stageHeight = ref(defaultStageSize.height)

/**
 * 面板值始终跟随 Store 中的真实舞台尺寸。
 * 撤销、重做、场景加载和用户手动输入都会走同一个同步入口，避免输入框显示和实际舞台尺寸分离。
 */
const syncStageSizeForm = (size: WidgetCanvasConfig = getCurrentSceneStageSize()) => {
  stageWidth.value = size.width
  stageHeight.value = size.height
}

/**
 * 应用用户输入的发布尺寸。
 * 面板只提交草稿尺寸；归一化、Store 写入和历史命令记录统一收敛在场景舞台适配层。
 */
const applyStageSizeChange = () => {
  // 保存、换父级等操作先结算输入；随后面板卸载无需穿过该操作的编辑门禁。
  if (editorSceneOperation.value) return
  syncStageSizeForm(
    commitSceneStageSizeChange({
      width: stageWidth.value,
      height: stageHeight.value,
    }),
  )
}
const stopBeforeOperation = subscribeEditorSceneBeforeOperation(applyStageSizeChange)

watch(
  () => getSceneStageSizeState(),
  () => syncStageSizeForm(),
  { deep: true, immediate: true },
)

/**
 * 用户输入后如果直接点击画布或切换右侧面板，组件可能先卸载，输入框的 change 事件来不及稳定落到 Store。
 * 卸载前再提交一次当前表单值，避免发布尺寸回到默认 1920x1080。
 */
onBeforeUnmount(() => {
  stopBeforeOperation()
  applyStageSizeChange()
})
</script>

<style scoped lang="scss">
.scene-stage-size-panel {
  /**
   * 发布画布作为基础页首个分组，严格使用天气系统的 16px 行间距、24px 底部留白与实线分隔。
   * 组件只维护自身布局，输入框尺寸和交互态继续由公共属性控件统一处理。
   */
  display: grid;
  gap: 16px;
  min-width: 0;
  padding-bottom: 24px;
  border-bottom: 1px solid var(--scene-edit-line);
}
.scene-stage-size-panel__title {
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 14px;
  font-weight: 600;
  line-height: 21px;
  color: var(--scene-edit-text);
  white-space: nowrap;
}
.scene-stage-size-panel__field {
  display: grid;
  grid-template-columns: 65px minmax(0, 1fr);
  gap: 4px;
  align-items: center;
  min-width: 0;
  min-height: 32px;
  color: var(--scene-edit-text-2);
  > span {
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 13px;
    line-height: 32px;
    white-space: nowrap;
  }
}
.scene-stage-size-panel__fields {
  display: grid;
  flex: 1 1 auto;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  gap: 4px;
  align-items: center;
  width: 100%;
  min-width: 0;
}
.scene-stage-size-panel__input {
  /** 双尺寸输入框等分属性行剩余宽度，面板在 300–400px 间拖动时同步伸缩。 */
  width: 100%;
  min-width: 0;
}
.scene-stage-size-panel__separator {
  font-size: 12px;
  line-height: 1;
  color: var(--scene-edit-text-2);
}

/** 发布尺寸控件与属性行同高，并统一为规范要求的 2px 圆角。 */
:deep(.scene-stage-size-panel__input .el-input__wrapper) {
  min-height: 32px;
  border-radius: 2px;
}

/** 发布画布尺寸同样使用左侧 8px 输入基线，避免与其它场景数值框出现对齐差异。 */
:deep(.scene-stage-size-panel__input .el-input__inner) {
  text-align: left !important;
}
</style>
