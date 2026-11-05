<template>
  <div v-if="object && draft && isSupportedObject" :key="object.id" ref="panel" class="scene-edit-property-content">
    <section class="scene-edit-property-section">
      <div class="scene-edit-property-section__header">通用</div>
      <div class="scene-edit-property-section__body">
        <el-alert
          v-if="isEffectivelyLocked"
          class="scene-object-base-panel__lock-tip"
          title="对象已锁定，请先在结构列表中解锁"
          type="warning"
          :closable="false"
          show-icon
        />
        <!-- 基础字段只读当前 SceneStore 快照；每次提交都经命令总线进入本会话撤销历史。 -->
        <ScenePropertyRow label="名称" control-fill>
          <ScenePropertyInput
            v-model.trim="draft.name"
            :disabled="!canEdit"
            @change="commitName"
          />
        </ScenePropertyRow>
        <ScenePropertyRow label="实例编号" control-fill>
          <ScenePropertyInput :model-value="object.id" readonly />
        </ScenePropertyRow>
        <ScenePropertyRow v-if="object.asset" label="资产" control-fill>
          <ScenePropertyInput :model-value="assetLabel" readonly />
        </ScenePropertyRow>
        <ScenePropertyRow label="启用">
          <ScenePropertySwitch
            :model-value="draft.visible"
            :disabled="!canEdit"
            @update:model-value="commitVisibility(Boolean($event))"
          />
        </ScenePropertyRow>
        <ScenePropertyRow label="可拾取">
          <ScenePropertySwitch
            :model-value="draft.pickable"
            :disabled="!canEdit"
            @update:model-value="commitPickable(Boolean($event))"
          />
        </ScenePropertyRow>
        <ScenePropertyRow label="设备编号" control-fill>
          <ScenePropertyInput
            v-model.trim="draft.deviceId"
            :disabled="!canEdit"
            @change="commitDeviceId"
          />
        </ScenePropertyRow>

        <template v-if="object.transform.kind === 'geo'">
          <!-- 经纬高始终写入地理变换字段，不把 WGS84 坐标误解释为本地三轴位置。 -->
          <ScenePropertyRow label="经度" control-fill>
            <ScenePropertyNumberInput
              :model-value="draft.geographicPosition[0]"
              :min="-180"
              :max="180"
              :step="0.0001"
              :precision="6"
              :disabled="!canEdit"
              @update:model-value="setAxis('geographicPosition', 0, $event)"
              @edit-commit="(value, session) => commitAxis('geographicPosition', 0, value, session)"
            />
          </ScenePropertyRow>
          <ScenePropertyRow label="纬度" control-fill>
            <ScenePropertyNumberInput
              :model-value="draft.geographicPosition[1]"
              :min="-90"
              :max="90"
              :step="0.0001"
              :precision="6"
              :disabled="!canEdit"
              @update:model-value="setAxis('geographicPosition', 1, $event)"
              @edit-commit="(value, session) => commitAxis('geographicPosition', 1, value, session)"
            />
          </ScenePropertyRow>
          <ScenePropertyRow label="海拔" control-fill>
            <ScenePropertyNumberInput
              :model-value="draft.geographicPosition[2]"
              :step="0.5"
              :precision="2"
              :disabled="!canEdit"
              @update:model-value="setAxis('geographicPosition', 2, $event)"
              @edit-commit="(value, session) => commitAxis('geographicPosition', 2, value, session)"
            />
          </ScenePropertyRow>
        </template>
        <ScenePropertyRow v-else label="位置">
          <div class="scene-object-base-panel__axes">
            <ScenePropertyNumberInput
              :model-value="draft.position[0]"
              prefix="X"
              :step="0.1"
              :disabled="!canEdit"
              @update:model-value="setAxis('position', 0, $event)"
              @edit-commit="(value, session) => commitAxis('position', 0, value, session)"
            />
            <ScenePropertyNumberInput
              :model-value="draft.position[1]"
              prefix="Y"
              :step="0.1"
              :disabled="!canEdit"
              @update:model-value="setAxis('position', 1, $event)"
              @edit-commit="(value, session) => commitAxis('position', 1, value, session)"
            />
            <ScenePropertyNumberInput
              :model-value="draft.position[2]"
              prefix="Z"
              :step="0.1"
              :disabled="!canEdit"
              @update:model-value="setAxis('position', 2, $event)"
              @edit-commit="(value, session) => commitAxis('position', 2, value, session)"
            />
          </div>
        </ScenePropertyRow>

        <ScenePropertyRow label="旋转">
          <div class="scene-object-base-panel__axes">
            <ScenePropertyNumberInput
              :model-value="draft.rotation[0]"
              prefix="X"
              :step="0.1"
              :disabled="!canEdit"
              @update:model-value="setAxis('rotation', 0, $event)"
              @edit-commit="(value, session) => commitAxis('rotation', 0, value, session)"
            />
            <ScenePropertyNumberInput
              :model-value="draft.rotation[1]"
              prefix="Y"
              :step="0.1"
              :disabled="!canEdit"
              @update:model-value="setAxis('rotation', 1, $event)"
              @edit-commit="(value, session) => commitAxis('rotation', 1, value, session)"
            />
            <ScenePropertyNumberInput
              :model-value="draft.rotation[2]"
              prefix="Z"
              :step="0.1"
              :disabled="!canEdit"
              @update:model-value="setAxis('rotation', 2, $event)"
              @edit-commit="(value, session) => commitAxis('rotation', 2, value, session)"
            />
          </div>
        </ScenePropertyRow>

        <ScenePropertyRow>
          <template #label>
            <span>缩放</span>
            <button
              type="button"
              class="scene-object-base-panel__scale-lock"
              :aria-label="scaleRatioLocked ? '解锁缩放比例' : '锁定缩放比例'"
              :aria-pressed="scaleRatioLocked"
              @click="scaleRatioLocked = !scaleRatioLocked"
            >
              <el-icon><Lock v-if="scaleRatioLocked" /><Unlock v-else /></el-icon>
            </button>
          </template>
          <div class="scene-object-base-panel__axes">
            <ScenePropertyNumberInput
              :model-value="draft.scale[0]"
              prefix="X"
              :step="0.1"
              :disabled="!canEdit"
              @update:model-value="setAxis('scale', 0, $event)"
              @edit-commit="(value, session) => commitAxis('scale', 0, value, session)"
            />
            <ScenePropertyNumberInput
              :model-value="draft.scale[1]"
              prefix="Y"
              :step="0.1"
              :disabled="!canEdit"
              @update:model-value="setAxis('scale', 1, $event)"
              @edit-commit="(value, session) => commitAxis('scale', 1, value, session)"
            />
            <ScenePropertyNumberInput
              :model-value="draft.scale[2]"
              prefix="Z"
              :step="0.1"
              :disabled="!canEdit"
              @update:model-value="setAxis('scale', 2, $event)"
              @edit-commit="(value, session) => commitAxis('scale', 2, value, session)"
            />
          </div>
        </ScenePropertyRow>
      </div>
    </section>
  </div>

  <el-empty
    v-else-if="object && !isSupportedObject"
    description="此对象类型保留专用属性面板，本次仅接入模型和基础几何体"
  />
  <el-empty v-else description="请选择三维模型" />
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Lock, Unlock } from '@element-plus/icons-vue'
import { editorSceneOperation, subscribeEditorSceneBeforeOperation } from '@/integrations/scene/editorSceneOperationGate'
import type { CommandBus, SceneObject, SceneStore, SceneTransform } from '@/scene-platform'
import {
  createUpdateObjectExtensionsCommand,
  createUpdateObjectNameCommand,
  createUpdateObjectTransformCommand,
  createUpdateObjectVisibilityCommand,
} from '@/scene-platform'
import ScenePropertyInput from '../../PropertyControls/ScenePropertyInput/index.vue'
import ScenePropertyNumberInput from '../../PropertyControls/ScenePropertyNumberInput/index.vue'
import ScenePropertyRow from '../../PropertyControls/ScenePropertyRow/index.vue'
import ScenePropertySwitch from '../../PropertyControls/ScenePropertySwitch/index.vue'

defineOptions({ name: 'SceneObjectBasePanel' })

type AxisValues = [number | null | undefined, number | null | undefined, number | null | undefined]
type AxisField = 'position' | 'geographicPosition' | 'rotation' | 'scale'

interface SceneObjectBaseDraft {
  name: string
  visible: boolean
  pickable: boolean
  deviceId: string
  position: AxisValues
  geographicPosition: AxisValues
  rotation: AxisValues
  scale: AxisValues
}

const props = defineProps<{
  store: SceneStore | null
  commandBus: CommandBus | null
  storeRevision: number
  objectId: string | null
}>()

const draft = ref<SceneObjectBaseDraft | null>(null)
const scaleRatioLocked = ref(false)
const panel = ref<HTMLElement | null>(null)

// 快捷入口可能在数字框仍聚焦时触发保存或回放。沿用控件自身的失焦提交顺序。
const stopBeforeOperation = subscribeEditorSceneBeforeOperation(() => {
  const input = document.activeElement
  if (input instanceof HTMLInputElement && !input.readOnly && panel.value?.contains(input)) input.blur()
})
onBeforeUnmount(stopBeforeOperation)

/** SceneStore 本身不具备 Vue 响应性；父检查器只在对象或选择事件时递增版本号。 */
const object = computed(() => {
  void props.storeRevision
  return props.store && props.objectId ? props.store.getObject(props.objectId) : null
})

const isSupportedObject = computed(() => object.value?.type === 'model' || object.value?.type === 'primitive' || object.value?.type === 'group')
const isEffectivelyLocked = computed(() =>
  Boolean(props.store && props.objectId && props.store.isObjectEffectivelyLocked(props.objectId)),
)
const canEdit = computed(() => Boolean(object.value && props.commandBus && !isEffectivelyLocked.value && !editorSceneOperation.value))
const assetLabel = computed(() =>
  object.value?.asset ? `${object.value.asset.kind} · ${object.value.asset.id}` : '',
)

const toAxisValues = (value: number | readonly number[]): AxisValues =>
  typeof value === 'number' ? [value, value, value] : [value[0], value[1], value[2]]

/** 每次 Store 修订都从完整领域快照重建表单，防止旧输入覆盖其它命令刚更新的字段。 */
const syncDraftFromObject = (nextObject: SceneObject | null) => {
  if (!nextObject) {
    draft.value = null
    return
  }

  const transform = nextObject.transform
  const metadata = nextObject.metadata ?? {}
  draft.value = {
    name: nextObject.name,
    visible: nextObject.visible,
    pickable: typeof metadata.pickable === 'boolean' ? metadata.pickable : true,
    deviceId: typeof metadata.deviceId === 'string' ? metadata.deviceId : '',
    position: transform.kind === 'local' ? [...transform.position] : [0, 0, 0],
    geographicPosition:
      transform.kind === 'geo'
        ? [transform.longitude, transform.latitude, transform.height]
        : [0, 0, 0],
    rotation:
      transform.kind === 'geo'
        ? [transform.heading, transform.pitch, transform.roll]
        : [...transform.rotation],
    scale: toAxisValues(transform.scale),
  }
}

watch(object, syncDraftFromObject, { immediate: true })
watch(() => props.objectId, () => { scaleRatioLocked.value = false })

const reportCommandFailure = (error: unknown) => {
  ElMessage.error(error instanceof Error ? error.message : '三维属性更新失败')
  syncDraftFromObject(object.value)
}

const commitName = () => {
  const current = object.value
  const nextName = draft.value?.name.trim()
  if (!canEdit.value || !current || !nextName || nextName === current.name) return
  try {
    props.commandBus!.execute(createUpdateObjectNameCommand(current.id, nextName))
  } catch (error) {
    reportCommandFailure(error)
  }
}

const commitVisibility = (visible: boolean) => {
  const current = object.value
  if (!canEdit.value || !current || current.visible === visible) return
  draft.value!.visible = visible
  try {
    props.commandBus!.execute(createUpdateObjectVisibilityCommand(current.id, visible))
  } catch (error) {
    reportCommandFailure(error)
  }
}

/** 可拾取独立保存为实例扩展，锁定只限制属性编辑，不会隐式改写用户设置的拾取状态。 */
const commitExtension = (patch: Record<string, unknown>) => {
  const current = object.value
  if (!canEdit.value || !current) return
  try {
    props.commandBus!.execute(
      createUpdateObjectExtensionsCommand(current.id, { metadata: patch }),
    )
  } catch (error) {
    reportCommandFailure(error)
  }
}

const commitPickable = (pickable: boolean) => {
  if (!draft.value || draft.value.pickable === pickable) return
  draft.value.pickable = pickable
  commitExtension({ pickable })
}

const commitDeviceId = () => {
  if (!draft.value) return
  const current = object.value
  if (!current || current.metadata?.deviceId === draft.value.deviceId) return
  commitExtension({ deviceId: draft.value.deviceId })
}

const setAxis = (field: AxisField, axis: 0 | 1 | 2, value: number | null | undefined) => {
  if (!draft.value) return
  const nextValue = typeof value === 'number' && Number.isFinite(value) ? value : undefined
  draft.value[field][axis] = nextValue
  if (field === 'scale' && scaleRatioLocked.value && nextValue !== undefined) {
    draft.value.scale = [nextValue, nextValue, nextValue]
  }
}

/** 只从本次输入更新一个字段，避免提交其它还在编辑或已被运行端刷新的草稿值。 */
const commitAxis = (
  field: AxisField,
  axis: 0 | 1 | 2,
  value: number | null | undefined,
  mergeSession?: symbol,
) => {
  const current = props.objectId ? props.store?.getObject(props.objectId) : null
  if (!canEdit.value || !current) return
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    syncDraftFromObject(current)
    return
  }
  const transform = current.transform
  let nextTransform: SceneTransform
  if (field === 'scale') {
    const scale: [number, number, number] = typeof transform.scale === 'number'
      ? [transform.scale, transform.scale, transform.scale] : [...transform.scale]
    if (scaleRatioLocked.value ? scale.every((item) => item === value) : scale[axis] === value) return
    if (scaleRatioLocked.value) scale.fill(value)
    else scale[axis] = value
    nextTransform = { ...transform, scale }
  } else if (transform.kind === 'geo') {
    if (field === 'position') return
    const key = field === 'rotation'
      ? (['heading', 'pitch', 'roll'] as const)[axis]
      : (['longitude', 'latitude', 'height'] as const)[axis]
    if ((key === 'longitude' && Math.abs(value) > 180) || (key === 'latitude' && Math.abs(value) > 90)) {
      ElMessage.warning('经度范围为 -180 至 180，纬度范围为 -90 至 90')
      syncDraftFromObject(current)
      return
    }
    if (transform[key] === value) return
    nextTransform = { ...transform, [key]: value }
  } else {
    if (field === 'geographicPosition' || transform[field][axis] === value) return
    const values: [number, number, number] = [...transform[field]]
    values[axis] = value
    nextTransform = { ...transform, [field]: values }
  }

  try {
    props.commandBus!.execute(createUpdateObjectTransformCommand(current.id, nextTransform, mergeSession))
  } catch (error) {
    reportCommandFailure(error)
  }
}
</script>

<style scoped lang="scss">
.scene-object-base-panel__axes {
  display: grid;
  width: 100%;
  min-width: 0;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 4px;
}

.scene-object-base-panel__scale-lock {
  display: inline-flex;
  align-items: center;
  margin-left: 4px;
  padding: 0;
  border: 0;
  color: inherit;
  background: transparent;
  cursor: pointer;
}

.scene-object-base-panel__lock-tip {
  margin-bottom: 8px;
}
</style>
