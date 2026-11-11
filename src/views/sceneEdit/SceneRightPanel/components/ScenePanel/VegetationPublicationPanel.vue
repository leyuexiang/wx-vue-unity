<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import type { SceneDefinition, VegetationSystemDefinition } from '@/scene-platform'
import {
  applyVegetationGenerationPreview, applyVegetationPublication, buildVegetationGenerationRequest,
  cancelVegetationGenerationTask, createVegetationGenerationTask, getCurrentVegetationPublication,
  getVegetationGenerationTask, publishVegetationGenerationTask,
  type BuildVegetationGenerationRequestOptions, type VegetationGenerationRequest,
  type VegetationGenerationTaskResponse,
} from '@/integrations/scene/editorVegetationPublicationAdapter'
import { pollVegetationGenerationTask } from '@/integrations/scene/vegetationTaskPolling'
import { importVegetationPublication } from '@/integrations/scene/importVegetationPublication'

const props = defineProps<{
  scene: SceneDefinition
  definition: VegetationSystemDefinition
  disabled: boolean
  draftDirty: boolean
  previewAvailable: boolean
  applyDefinition: (definition: VegetationSystemDefinition, persist: boolean) => Promise<void>
}>()
const emit = defineEmits<{ busy: [value: boolean]; imported: [value: VegetationSystemDefinition] }>()
const task = shallowRef<VegetationGenerationTaskResponse>()
const frozen = shallowRef<VegetationSystemDefinition>()
const request = shallowRef<VegetationGenerationRequest>()
const busy = ref(false), error = ref(''), notice = ref(''), demUrl = ref(''), demVersion = ref('')
const verticalDatum = ref<'ellipsoid' | 'orthometric'>('ellipsoid')
const importUrl = ref('')
const publishedTask = ref('')
const pollRunning = ref(false)
let epoch = 0, polling: AbortController | undefined
const active = computed(() => task.value?.status === 'PENDING' || task.value?.status === 'RUNNING')
const stale = computed(() => {
  if (!request.value) return false
  try {
    const current = buildVegetationGenerationRequest({ id: props.scene.id, vegetation: props.definition }, options(request.value.idempotencyKey))
    return JSON.stringify(current) !== JSON.stringify(request.value)
  } catch { return true }
})
const statusNames = { PENDING: '排队中', RUNNING: '生成中', SUCCESS: '生成成功', PARTIAL_FAILED: '部分失败', FAILED: '生成失败', CANCELED: '已取消' }
const progress = computed(() => task.value?.totalTileCount ? Math.min(100, Math.round((task.value.completedTileCount ?? 0) / task.value.totalTileCount * 100)) : undefined)
watch(busy, value => emit('busy', value), { flush: 'sync' })
function reset() {
  epoch++; polling?.abort(); polling = undefined
  task.value = undefined; frozen.value = undefined; request.value = undefined
  busy.value = false; error.value = ''; notice.value = ''; publishedTask.value = ''; pollRunning.value = false
}
watch(() => props.scene.id, reset, { flush: 'sync' })
onBeforeUnmount(reset)
function options(idempotencyKey?: string): BuildVegetationGenerationRequestOptions {
  const result: BuildVegetationGenerationRequestOptions = { idempotencyKey }
  if (demUrl.value.trim()) {
    if (!/^https?:\/\//i.test(demUrl.value.trim()) || !demVersion.value.trim()) throw new Error('请填写后端可访问的 DEM 地址和数据版本')
    result.elevationSource = { url: demUrl.value.trim(), version: demVersion.value.trim(), verticalDatum: verticalDatum.value,
      heightOffsetM: props.definition.elevationSource.heightOffsetM }
  } else if (props.definition.elevationSource.kind === 'constant') {
    throw new Error('瓦片生成服务需要可访问的 DEM。请填写 DEM 地址和版本，或将高程来源改为不使用高程。')
  } else if (props.definition.elevationSource.kind === 'scene-terrain' || props.definition.elevationSource.kind === 'external-dem') {
    throw new Error('正式贴地生成需要后端可访问的 DEM 地址和版本，请在下方填写')
  } else if (props.definition.elevationSource.heightOffsetM !== 0) {
    throw new Error('离地偏移需要明确的固定高程或 DEM 高程来源')
  }
  return result
}
async function poll(scope: number) {
  const controller = new AbortController(); polling = controller
  pollRunning.value = true
  try {
    await pollVegetationGenerationTask({ signal: controller.signal,
      readTask: () => task.value!, writeTask: value => { if (scope === epoch) task.value = value },
      queryTask: getVegetationGenerationTask })
    if (scope !== epoch) return
    if (task.value?.status === 'SUCCESS') notice.value = '生成成功，可以预览结果并发布'
    else if (task.value?.status !== 'CANCELED') error.value = task.value?.errorMessage || '瓦片生成失败，请检查任务结果后重新生成'
  } catch (reason) {
    if (scope === epoch && !controller.signal.aborted) error.value = reason instanceof Error ? reason.message : '任务查询失败，可点击刷新任务继续查询'
  } finally { if (polling === controller) { polling = undefined; pollRunning.value = false } }
}
async function generate() {
  if (props.disabled || busy.value || active.value) return
  if (props.draftDirty) { error.value = '请先应用规则后再生成瓦片'; return }
  const scope = ++epoch
  polling?.abort(); error.value = ''; notice.value = ''; busy.value = true
  try {
    const definition = JSON.parse(JSON.stringify(props.definition)) as VegetationSystemDefinition
    const opts = options(crypto.randomUUID())
    const body = buildVegetationGenerationRequest({ id: props.scene.id, vegetation: definition }, opts)
    frozen.value = definition; request.value = body
    task.value = undefined; publishedTask.value = ''
    const created = await createVegetationGenerationTask(body)
    if (scope !== epoch) return
    task.value = created
    if (created.status === 'PENDING' || created.status === 'RUNNING') void poll(scope)
    else if (created.status === 'SUCCESS') notice.value = '生成成功，可以预览结果并发布'
    else error.value = created.errorMessage || `生成任务${statusNames[created.status]}`
  } catch (reason) {
    if (scope === epoch) error.value = reason instanceof Error ? reason.message : '创建植被任务失败'
  } finally { if (scope === epoch) busy.value = false }
}
async function refreshTask() {
  if (!task.value || busy.value || polling) return
  const scope = epoch; busy.value = true; error.value = ''
  try {
    const value = await getVegetationGenerationTask(task.value.taskId)
    if (scope !== epoch) return
    task.value = value
    if (active.value) void poll(scope)
  } catch (reason) { if (scope === epoch) error.value = reason instanceof Error ? reason.message : '刷新失败' }
  finally { if (scope === epoch) busy.value = false }
}
async function cancel() {
  if (!task.value || busy.value || !active.value) return
  const scope = epoch, id = task.value.taskId
  busy.value = true; polling?.abort(); error.value = ''
  try {
    const value = await cancelVegetationGenerationTask(id)
    if (scope === epoch) task.value = value
  } catch (reason) { if (scope === epoch) error.value = reason instanceof Error ? reason.message : '取消失败，请刷新任务确认状态' }
  finally { if (scope === epoch) busy.value = false }
}
async function preview() {
  if (props.disabled || !props.previewAvailable || props.draftDirty || !task.value || !frozen.value || task.value.status !== 'SUCCESS' || stale.value || busy.value) return
  const scope = epoch; busy.value = true; error.value = ''
  try {
    const previewDefinition = applyVegetationGenerationPreview(frozen.value, task.value)
    if (!previewDefinition.layers.some(layer => layer.visible && layer.tilesetAsset?.url))
      throw new Error('生成结果缺少可预览图层的瓦片入口')
    await props.applyDefinition(previewDefinition, false)
    if (scope === epoch) notice.value = '已加载生成结果预览，发布后可保存到场景'
  } catch (reason) { if (scope === epoch) error.value = reason instanceof Error ? reason.message : '预览失败' }
  finally { if (scope === epoch) busy.value = false }
}
async function publish() {
  if (props.disabled || props.draftDirty || !task.value || !frozen.value || task.value.status !== 'SUCCESS' || stale.value || busy.value || publishedTask.value === task.value.taskId) return
  const scope = epoch, sceneId = props.scene.id; busy.value = true; error.value = ''
  let publishedVersion: string | undefined
  try {
    const result = await publishVegetationGenerationTask(task.value.taskId)
    publishedVersion = result.publicationVersion
    if (scope !== epoch || props.scene.id !== sceneId) return
    publishedTask.value = task.value.taskId
    if (result.sceneId !== sceneId) throw new Error('发布结果所属场景不一致')
    if (result.taskId !== task.value.taskId || result.ruleVersion !== request.value?.ruleVersion)
      throw new Error('发布结果与当前任务或规则版本不一致，请同步稳定版本后核对')
    if (stale.value) throw new Error('发布期间规则已变化，请同步稳定版本后核对')
    await props.applyDefinition(applyVegetationPublication(props.definition, result), true)
    notice.value = `植被版本 ${result.publicationVersion} 已发布，请保存场景`
  } catch (reason) {
    if (scope === epoch) error.value = `${publishedVersion ? `版本 ${publishedVersion} 已发布，同步场景失败。` : ''}${reason instanceof Error ? reason.message : '发布失败'}`
  } finally { if (scope === epoch) busy.value = false }
}
async function importPublished() {
  if (props.disabled || busy.value || active.value || !importUrl.value.trim()) return
  const scope = epoch; busy.value = true; error.value = ''
  try {
    const next = await importVegetationPublication(props.definition, importUrl.value)
    if (scope !== epoch) return
    reset()
    emit('imported', next)
    notice.value = '已导入发布清单，请应用植被。发布清单包含模型和瓦片引用，绘制规则可通过规则文件导入。'
  } catch (reason) { if (scope === epoch) error.value = reason instanceof Error ? reason.message : '导入发布清单失败' }
  finally { if (scope === epoch) busy.value = false }
}
async function sync() {
  if (busy.value || active.value || props.disabled || props.draftDirty) return
  const scope = epoch, sceneId = props.scene.id; busy.value = true; error.value = ''
  try {
    const result = await getCurrentVegetationPublication(sceneId)
    if (scope !== epoch || props.scene.id !== sceneId) return
    if (result.sceneId !== sceneId) throw new Error('稳定版本所属场景不一致')
    await props.applyDefinition(applyVegetationPublication(props.definition, result), true)
    notice.value = `已同步植被版本 ${result.publicationVersion}，请保存场景`
  } catch (reason) { if (scope === epoch) error.value = reason instanceof Error ? reason.message : '同步失败' }
  finally { if (scope === epoch) busy.value = false }
}
</script>

<template>
  <section class="publication" aria-label="植被瓦片生成与发布">
    <strong>瓦片生成与发布</strong>
    <el-input v-model="importUrl" aria-label="植被发布清单地址" placeholder="发布包的 manifest.json 或 tileset.json 地址" :disabled="disabled || busy || active" />
    <el-button size="small" :disabled="disabled || busy || active || !importUrl.trim()" @click="importPublished">导入已有发布</el-button>
    <p>绘制或导入规则后生成瓦片，预览结果，再发布并保存场景。</p>
    <p>正式生成按密度布点，多边形使用单一外环。</p>
    <p v-if="draftDirty" class="warning">请先应用规则后再生成瓦片。</p>
    <el-input v-model="demUrl" aria-label="生成 DEM 地址" placeholder="贴地生成的 DEM 服务地址" :disabled="disabled || busy || active" />
    <el-input v-model="demVersion" aria-label="DEM 数据版本" placeholder="DEM 数据版本" :disabled="disabled || busy || active" />
    <el-select v-model="verticalDatum" aria-label="生成高程基准" :disabled="disabled || busy || active">
      <el-option label="椭球高" value="ellipsoid" /><el-option label="正常高" value="orthometric" />
    </el-select>
    <div class="actions">
      <el-button size="small" type="primary" :disabled="disabled || busy || active || draftDirty" @click="generate">生成瓦片</el-button>
      <el-button size="small" :disabled="disabled || busy || !active" @click="cancel">取消生成</el-button>
      <el-button size="small" :disabled="disabled || busy || !task || pollRunning" @click="refreshTask">刷新任务</el-button>
    </div>
    <p v-if="task">{{ statusNames[task.status] }} · {{ task.instanceCount ?? '—' }} 株 · {{ task.completedTileCount ?? 0 }}/{{ task.totalTileCount ?? '—' }} 块</p>
    <el-progress v-if="progress !== undefined" :percentage="progress" />
    <p v-if="task?.progress?.currentStage">{{ task.progress.currentStage }}</p>
    <p v-if="stale" class="warning">规则已变化，请重新生成后发布。</p>
    <div class="actions">
      <el-button size="small" :disabled="disabled || !previewAvailable || busy || draftDirty || task?.status !== 'SUCCESS' || stale" @click="preview">预览生成结果</el-button>
      <el-button size="small" type="primary" :disabled="disabled || busy || draftDirty || task?.status !== 'SUCCESS' || stale || publishedTask === task?.taskId" @click="publish">发布植被</el-button>
      <el-button size="small" :disabled="disabled || busy || active || draftDirty" @click="sync">同步稳定版本</el-button>
    </div>
    <p v-if="definition.publication">当前发布版本 {{ definition.publication.version }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.publication { display: grid; gap: 8px; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--scene-edit-line, #40505a); }
.publication p { margin: 0; font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
.actions { display: flex; flex-wrap: wrap; gap: 6px; }
.actions .el-button { margin-left: 0; }
.error { color: #f38c87; }
.warning { color: #e6b867; }
</style>
