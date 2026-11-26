<template>
  <!-- 普通新增和模板实例化共用同一组场景类型；禁用时仍显示模板已锁定的来源类型。 -->
  <el-radio-group v-model="sceneType" class="scene-type-radio-group" aria-label="场景类型">
    <el-radio v-for="option in SCENE_CREATION_TYPE_OPTIONS" :key="option.value" :value="option.value">
      {{ option.label }}
    </el-radio>
  </el-radio-group>
</template>

<script setup lang="ts">
import type { Dim3dSceneForm } from '@/servers/manual/dim3d/api/scene'
import { SCENE_CREATION_TYPE_OPTIONS } from './sceneType'

const sceneType = defineModel<Dim3dSceneForm['sceneType']>({ required: true })
</script>

<style scoped>
/* 沿用新增场景的单选尺寸与选中样式，颜色由管理主题提供。 */
.scene-type-radio-group {
  display: flex;
  gap: 0 24px;
  font-family: 'Source Han Sans SC', 'Microsoft YaHei', sans-serif;
  font-synthesis: none;
  letter-spacing: 0;
}
.scene-type-radio-group :deep(.el-radio) {
  height: 22px;
  margin-right: 0;
}
.scene-type-radio-group :deep(.el-radio__label) {
  padding-left: 8px;
  font-size: 14px;
  line-height: 22px;
  color: var(--manage-text, #333333);
}
.scene-type-radio-group :deep(.el-radio__inner) {
  width: 16px;
  height: 16px;
  border-color: #b8b9bb;
}
.scene-type-radio-group :deep(.el-radio__input.is-checked .el-radio__inner) {
  background: transparent;
  border-color: var(--manage-accent, #51a195);
}
.scene-type-radio-group :deep(.el-radio__input.is-checked .el-radio__inner::after) {
  width: 8px;
  height: 8px;
  background: var(--manage-accent, #51a195);
}
</style>
