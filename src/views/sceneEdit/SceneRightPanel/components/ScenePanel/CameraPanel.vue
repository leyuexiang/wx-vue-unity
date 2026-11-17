<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef } from 'vue'
import { ElMessage } from 'element-plus'
import {
  createUpdateSceneSettingsCommand, createUpdateCameraPathsCommand, getCameraPathMinimumTotalDurationMs,
  normalizeCameraPathDurationMs, type CameraPath, type GeoCameraPathWaypoint, type ViewportHost,
} from '@/scene-platform'
import { subscribeActiveSceneViewportHost } from '@/integrations/scene/editorScenePlatformHost'
import { isEditorGisWriteAllowed } from '@/integrations/scene/editorSceneGisAdapter'
import { isWidgetPreview } from '@/integrations/scene/widgetRuntime'
import { UnityEditorSceneRuntime } from '@/unity-runtime/runtime/UnityEditorSceneRuntime'
import { getUnityCameraConfig } from '@/unity-runtime/runtime/editorCameraConfig'
import type { UnityCameraAction } from '@/unity-runtime/runtime/JsonRpcUnityCloudRuntime'
import type { UnityCameraConfig, UnityCameraState } from '@/unity-runtime/protocol/types'
import ScenePropertyRow from '../PropertyControls/ScenePropertyRow/index.vue'

const host = shallowRef<ViewportHost | null>(null)
const runtime = shallowRef<UnityEditorSceneRuntime | null>(null)
const revision = ref(0)
const scene = computed(() => { void revision.value; return host.value?.getStore().getScene() })
const gis = computed(() => scene.value?.type === 'gis')
const blocked = computed(() => !scene.value || scene.value.settings.readOnly === true || !isEditorGisWriteAllowed() || isWidgetPreview())
const state = shallowRef<UnityCameraState>()
const busy = ref(false)
const liveReadFailed = ref(false)
const positionDraft = ref<Partial<Record<number, number | undefined>>>({})
const clippingDraft = ref<Partial<Record<'near' | 'far', number | undefined>>>({})
const position = computed(() => state.value?.position.map((value, index) =>
  index in positionDraft.value ? positionDraft.value[index] : value,
) ?? [])
const near = computed(() => 'near' in clippingDraft.value ? clippingDraft.value.near : state.value?.near)
const far = computed(() => 'far' in clippingDraft.value ? clippingDraft.value.far : state.value?.far)
const pathId = ref(''), pointId = ref('')
const recording = shallowRef<{ first?: GeoCameraPathWaypoint }>()
const previousView = ref<GeoCameraPathWaypoint>()
const paths = computed(() => scene.value?.cameraPaths ?? [])
const path = computed(() => paths.value.find(item => item.id === pathId.value) ?? paths.value[0])
const point = computed(() => path.value?.waypoints.find(item => item.id === pointId.value) ?? path.value?.waypoints[0])
const config = computed(() => scene.value ? getUnityCameraConfig(scene.value.settings, scene.value.type) : {})
const aa = computed(() => config.value.antialiasing ?? { mode: 'default' })
const axes = computed(() => gis.value ? ['经度', '纬度', '椭球高（米）'] : ['X（米）', 'Y（米）', 'Z（米）'])
const angleFields = [{ key: 'heading', label: '航向' }, { key: 'pitch', label: '俯仰' }, { key: 'roll', label: '横滚' }] as const
const antialiasModes = [
  ['default', '播放器默认'], ['none', '关闭'], ['fxaa', 'FXAA'], ['smaa', 'SMAA'], ['msaa', 'MSAA'], ['ssaa', 'SSAA'],
]
let stopStore = () => {}, scope = 0
let readingScope: number | undefined

function showCamera(camera: UnityCameraState) {
  state.value = camera
  liveReadFailed.value = false
}

async function readLiveCamera() {
  const current = runtime.value
  const requestScope = scope
  if (!current?.cameraAvailable || document.hidden || busy.value || readingScope === requestScope) return
  readingScope = requestScope
  try {
    const camera = await current.controlCamera({ action: 'get' })
    if (requestScope === scope && !busy.value) showCamera(camera)
  } catch {
    if (requestScope === scope && !busy.value) liveReadFailed.value = true
  } finally {
    if (readingScope === requestScope) readingScope = undefined
  }
}

async function control(action: UnityCameraAction, after: (result: UnityCameraState) => void = showCamera) {
  const current = runtime.value
  const requestScope = scope
  if (!current?.cameraAvailable || busy.value) return
  busy.value = true
  try {
    await host.value?.getBridge().flush()
    if (requestScope !== scope) return
    const result = await current.controlCamera(action)
    if (requestScope === scope) after(result)
  } catch (error) {
    if (requestScope === scope) ElMessage.error(error instanceof Error ? error.message : '相机操作失败')
  } finally {
    if (requestScope === scope) busy.value = false
  }
}

function resetCameraView() {
  scope++
  busy.value = false
  state.value = undefined
  liveReadFailed.value = false
  positionDraft.value = {}
  clippingDraft.value = {}
  previousView.value = undefined
  recording.value = undefined
}

const stopHost = subscribeActiveSceneViewportHost(next => {
  const nextRuntime = next?.getRuntime()
  stopStore()
  host.value = next
  runtime.value = nextRuntime instanceof UnityEditorSceneRuntime ? nextRuntime : null
  revision.value++
  resetCameraView()
  stopStore = next?.getStore().subscribe(event => {
    revision.value++
    if (event.type === 'sceneLoaded') {
      resetCameraView()
      pathId.value = pointId.value = ''
    }
  }) ?? (() => {})
  void readLiveCamera()
})
// Reuse the players' existing camera RPC for both rendering modes, with one background read at a time.
const liveReadTimer = window.setInterval(readLiveCamera, 200)
onBeforeUnmount(() => { scope++; window.clearInterval(liveReadTimer); stopStore(); stopHost() })

function commitCamera(patch: Record<string, unknown>) {
  if (blocked.value || !host.value || !runtime.value?.cameraAvailable) return false
  const { settings } = host.value.getStore().getScene()
  const kind = gis.value ? 'cesium' : 'three'
  const old = settings.camera as Record<string, unknown> | undefined
  const camera: Record<string, unknown> = { ...(old?.kind === kind ? old : {}), kind, ...patch }
  for (const key of Object.keys(camera)) if (camera[key] === undefined) delete camera[key]
  host.value.getCommandBus().execute(createUpdateSceneSettingsCommand({ settings: { ...settings, camera } }))
  return true
}

function refreshCamera() {
  void control({ action: 'get' }, camera => {
    positionDraft.value = {}
    clippingDraft.value = {}
    showCamera(camera)
  })
}

function applyPosition() {
  const [x, y, z] = position.value
  if (x === undefined || y === undefined || z === undefined || ![x, y, z].every(Number.isFinite)
      || (gis.value && (Math.abs(x) > 180 || Math.abs(y) > 90))) {
    ElMessage.warning('请输入有效的相机坐标')
    return
  }
  if (gis.value) {
    void control({ action: 'get' }, camera => {
      if (commitCamera({ destination: [x, y, z], orientation: { ...camera.orientation } })) positionDraft.value = {}
    })
  } else if (commitCamera({ position: [x, y, z], target: undefined })) {
    positionDraft.value = {}
  }
}

function applyClipping() {
  if (near.value === undefined || far.value === undefined || near.value < .01 || near.value > 10000
      || Math.fround(far.value) <= Math.fround(near.value) || far.value > 1e9) {
    ElMessage.warning('近裁剪面须在 0.01 至 10000 米之间，远裁剪面须大于近裁剪面且不超过 10 亿米')
    return
  }
  if (commitCamera({ near: near.value, far: far.value })) clippingDraft.value = {}
}

function restoreClipping() {
  if (!commitCamera({ near: undefined, far: undefined })) return
  clippingDraft.value = {}
  void control({ action: 'get' })
}

function setAntialiasing(patch: Partial<NonNullable<UnityCameraConfig['antialiasing']>>) {
  if (blocked.value || !host.value || !runtime.value?.cameraAvailable) return
  const { settings } = host.value.getStore().getScene()
  const rendering = { ...settings.rendering as Record<string, unknown> | undefined }
  if (patch.mode === 'default') {
    delete rendering.antialiasing
    delete rendering.antialias
  } else {
    const next = { ...aa.value, ...patch }
    rendering.antialiasing = next
    rendering.antialias = next.mode !== 'none'
  }
  host.value.getCommandBus().execute(createUpdateSceneSettingsCommand({ settings: { ...settings, rendering } }))
}

function commitPaths(next: CameraPath[]) {
  if (!blocked.value && host.value) host.value.getCommandBus().execute(createUpdateCameraPathsCommand(next))
}

function updatePath(patch: Partial<CameraPath>) {
  const current = path.value
  if (current) commitPaths(paths.value.map(item => item.id === current.id ? { ...item, ...patch } : item))
}

function capture(camera: UnityCameraState, timeMs: number): GeoCameraPathWaypoint {
  return { id: newId(), kind: 'geo', destination: [...camera.position], orientation: { ...camera.orientation },
    timeMs, interpolation: 'ease-in-out' }
}

function newId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
}

function visitPoint() {
  const selected = point.value
  if (!selected) return
  if (previousView.value) {
    void control({ action: 'visit', waypoint: previousView.value }, camera => {
      previousView.value = undefined
      showCamera(camera)
    })
    return
  }
  const current = runtime.value, requestScope = scope
  void control({ action: 'get' }, camera => {
    if (scope !== requestScope || runtime.value !== current || point.value !== selected) return
    const restore = capture(camera, 0)
    // The read releases the operation guard in finally before the next RPC starts.
    void Promise.resolve().then(() => {
      if (scope === requestScope) return control({ action: 'visit', waypoint: selected }, visited => {
        previousView.value = restore
        showCamera(visited)
      })
    })
  })
}

const DEFAULT_WAYPOINT_INTERVAL_MS = 3000

function recordNewPathPoint() {
  const draft = recording.value
  if (blocked.value || !draft || paths.value.length >= 20) return
  void control({ action: 'get' }, camera => {
    if (blocked.value || recording.value !== draft || paths.value.length >= 20) return
    if (!draft.first) {
      recording.value = { first: capture(camera, 0) }
      return
    }
    const id = newId()
    const second = capture(camera, DEFAULT_WAYPOINT_INTERVAL_MS)
    commitPaths([...paths.value, { id, name: `相机路径 ${paths.value.length + 1}`, enabled: true, loop: false,
      autoPlay: false, orientationMode: 'keyframes', durationMs: getCameraPathMinimumTotalDurationMs(second.timeMs),
      waypoints: [draft.first, second] }])
    recording.value = undefined
    pathId.value = id
    pointId.value = second.id
  })
}

function capturePoint(replace: boolean) {
  const current = path.value, selected = point.value
  if (blocked.value || !current || (replace && !selected) || (!replace && current.waypoints.length >= 200)) return
  void control({ action: 'get' }, camera => {
    if (blocked.value || path.value !== current || (replace && point.value !== selected)) return
    if (replace && selected) {
      updatePoint({ destination: [...camera.position], orientation: { ...camera.orientation } })
      return
    }
    const last = current.waypoints[current.waypoints.length - 1]!
    const time = last.timeMs + DEFAULT_WAYPOINT_INTERVAL_MS
    const duration = getCameraPathMinimumTotalDurationMs(time, current.turnDurationMs)
    if (duration > 600000) { ElMessage.warning('路径已达到最大总时长'); return }
    const next = capture(camera, time)
    updatePath({ waypoints: [...current.waypoints, next], durationMs: Math.max(current.durationMs, duration) })
    pointId.value = next.id
  })
}

function updatePoint(patch: Partial<GeoCameraPathWaypoint>) {
  const current = path.value, selected = point.value
  if (!current || !selected) return
  updatePath({ waypoints: current.waypoints.map(item => item.id === selected.id ? { ...item, ...patch } : item) })
}

function removePoint() {
  if (!path.value || !point.value || path.value.waypoints.length <= 2) return
  const remaining = path.value.waypoints.filter(item => item.id !== point.value?.id)
  const offset = remaining[0]!.timeMs
  updatePath({ waypoints: remaining.map(item => ({ ...item, timeMs: item.timeMs - offset })) })
  pointId.value = remaining[0]!.id
}

function changePointTime(value: number | undefined) {
  const current = path.value, selected = point.value
  if (!current || !selected || value === undefined) return
  const timeMs = Math.round(value * 1000)
  const index = current.waypoints.indexOf(selected)
  const max = current.waypoints[index + 1]?.timeMs ?? current.durationMs - getCameraPathMinimumTotalDurationMs(0, current.turnDurationMs)
  if (index === 0 || timeMs <= current.waypoints[index - 1]!.timeMs || timeMs > max
      || timeMs === current.waypoints[index + 1]?.timeMs) { ElMessage.warning('路径点时间必须递增并保留末尾转向时间'); return }
  updatePoint({ timeMs })
}

function waypointLabel(index: number, count: number, timeMs: number) {
  const name = index === 0 ? '起点' : index === count - 1 ? '终点' : `第 ${index + 1} 个点`
  return `${name} · ${timeMs / 1000} 秒`
}
</script>

<template>
  <div class="camera-inspector">
    <section aria-label="相机参数">
      <header><h3>相机参数</h3><el-button size="small" :loading="busy" :disabled="!runtime?.cameraAvailable" @click="refreshCamera">读取当前视角</el-button></header>
      <p v-if="!runtime?.cameraAvailable" class="camera-hint">相机控制需要已连接且支持该功能的 Unity 播放器。</p>
      <p v-else-if="liveReadFailed" class="camera-hint" role="status">正在等待播放器更新相机参数。</p>
      <template v-if="state">
        <div class="camera-grid">
          <label v-for="(label, index) in axes" :key="label">{{ label }}
            <el-input-number :model-value="position[index]" :aria-label="label" :controls="false" :disabled="blocked || busy"
              @update:model-value="value => positionDraft[index] = value" />
          </label>
        </div>
        <el-button class="camera-position-apply" size="small" :disabled="blocked || busy" @click="applyPosition">应用位置</el-button>
        <div class="camera-grid" role="group" aria-label="当前相机朝向">
          <div v-for="{ key, label } in angleFields" :key="key" class="camera-angle">
            <span>{{ label }}（°）</span>
            <span class="camera-angle-value">{{ (state.orientation[key] * 180 / Math.PI).toFixed(2) }}</span>
          </div>
        </div>
        <ScenePropertyRow label="视野角（°）" control-fill>
          <el-input-number :model-value="state.fov" :min="1" :max="179" :step="1" :controls="false" :disabled="blocked || busy" aria-label="视野角" @change="value => value !== undefined && commitCamera({ fov: value })" />
        </ScenePropertyRow>
        <div class="camera-grid camera-grid--pair">
          <label>近裁剪面（米）<el-input-number :model-value="near" :controls="false" :disabled="blocked || busy" aria-label="近裁剪面" @update:model-value="value => clippingDraft.near = value" /></label>
          <label>远裁剪面（米）<el-input-number :model-value="far" :controls="false" :disabled="blocked || busy" aria-label="远裁剪面" @update:model-value="value => clippingDraft.far = value" /></label>
        </div>
        <div class="camera-actions">
          <el-button size="small" :disabled="blocked || busy" @click="applyClipping">应用裁剪</el-button>
          <el-button size="small" :disabled="blocked || busy || config.near === undefined" @click="restoreClipping">{{ gis ? '恢复动态裁剪' : '恢复默认裁剪' }}</el-button>
          <span v-if="gis" class="camera-hint">{{ state.automaticClipping ? '动态' : '手动' }}</span>
        </div>
        <ScenePropertyRow label="抗锯齿" control-fill>
          <el-select :model-value="aa.mode === 'off' ? 'none' : aa.mode" :disabled="blocked || busy" aria-label="抗锯齿" @change="mode => setAntialiasing({ mode })">
            <el-option v-for="[value, label] in antialiasModes" :key="value" :value="value" :label="label" />
          </el-select>
        </ScenePropertyRow>
        <ScenePropertyRow v-if="aa.mode === 'msaa'" label="采样数" control-fill>
          <el-select :model-value="aa.msaaSamples ?? 4" :disabled="blocked || busy" aria-label="MSAA 采样数" @change="msaaSamples => setAntialiasing({ msaaSamples })">
            <el-option v-for="value in [2, 4, 8]" :key="value" :value="value" :label="`${value}×`" />
          </el-select>
        </ScenePropertyRow>
        <ScenePropertyRow v-if="aa.mode === 'ssaa'" label="渲染倍率" control-fill>
          <el-input-number :model-value="aa.supersampleScale ?? 1.5" :min="1.25" :max="2" :step="0.25" :disabled="blocked || busy" aria-label="SSAA 渲染倍率" @change="supersampleScale => supersampleScale !== undefined && setAntialiasing({ supersampleScale })" />
        </ScenePropertyRow>
      </template>
    </section>

    <section v-if="gis" aria-label="路径漫游">
      <header><h3>路径漫游</h3><el-button v-if="!recording" size="small" type="primary" :disabled="blocked || busy || !state || paths.length >= 20" @click="recording = {}">新建路径</el-button></header>
      <div v-if="recording" class="camera-recording">
        <strong>{{ recording.first ? '第 2 步 · 记录下一个点' : '第 1 步 · 记录起点' }}</strong>
        <p class="camera-hint" role="status">{{ recording.first
          ? '起点已记录。在画布中移动并转好镜头，再记录下一个点。录满 2 个点后即可播放。'
          : '在画布中把镜头摆到出发位置，再点击下方按钮。每次点击记录一个视角。' }}</p>
        <div class="camera-actions">
          <el-button size="small" type="primary" :disabled="blocked || busy || !state || paths.length >= 20" @click="recordNewPathPoint">
            {{ recording.first ? '记录第 2 个点' : '记录起点' }}
          </el-button>
          <el-button size="small" @click="recording = undefined">取消新建</el-button>
        </div>
      </div>
      <p v-else-if="!path" class="camera-hint">新建一条路径，然后在画布中逐个记录要经过的视角。</p>
      <template v-else>
        <el-select :model-value="path.id" aria-label="选择相机路径" @change="id => { pathId = id; pointId = '' }">
          <el-option v-for="item in paths" :key="item.id" :label="item.name" :value="item.id" />
        </el-select>
        <div class="camera-actions">
          <el-button size="small" :disabled="busy || !state || !path.enabled" @click="control({ action: 'play', path })">播放漫游</el-button>
          <el-button size="small" :disabled="busy || !state" @click="control({ action: 'stop', rewind: true })">停止并回到起点</el-button>
        </div>
        <header>
          <h4>已记录 {{ path.waypoints.length }} 个视角</h4>
          <el-button size="small" type="primary" :disabled="blocked || busy || !state || path.waypoints.length >= 200" @click="capturePoint(false)">记录下一个点</el-button>
        </header>
        <p class="camera-hint">把镜头移到下一站，再点击「记录下一个点」。新点会加在路径末尾。</p>
        <template v-if="point">
          <el-select :model-value="point.id" aria-label="选择路径点" @change="id => pointId = id">
            <el-option v-for="(item, index) in path.waypoints" :key="item.id" :label="waypointLabel(index, path.waypoints.length, item.timeMs)" :value="item.id" />
          </el-select>
          <div class="camera-actions">
            <el-button size="small" :disabled="busy || !state" @click="visitPoint">{{ previousView ? '恢复视角' : '查看所选点' }}</el-button>
            <el-button size="small" :disabled="blocked || busy || !state" @click="capturePoint(true)">用当前视角替换</el-button>
            <el-button size="small" :disabled="blocked || path.waypoints.length <= 2" @click="removePoint">删除点</el-button>
          </div>
        </template>
        <details class="camera-details">
          <summary>播放设置</summary>
          <ScenePropertyRow label="名称" control-fill>
            <el-input :model-value="path.name" maxlength="64" :disabled="blocked" aria-label="路径名称" @change="name => name.trim() && updatePath({ name: name.trim() })" />
          </ScenePropertyRow>
          <div class="camera-grid camera-grid--pair">
            <label v-for="[key, label] in ([['enabled', '启用路径'], ['loop', '循环播放'], ['autoPlay', '自动播放']] as const)" :key="key" class="camera-switch">{{ label }}
              <el-switch :model-value="path[key]" :disabled="blocked" :aria-label="label" @change="value => updatePath({ [key]: Boolean(value) })" />
            </label>
            <label class="camera-switch">沿路线转向<el-switch :model-value="path.orientationMode === 'follow-path'" :disabled="blocked" aria-label="沿路线转向" @change="value => updatePath({ orientationMode: value ? 'follow-path' : 'keyframes' })" /></label>
          </div>
          <ScenePropertyRow class="camera-time-row" label="总时长（秒）" control-fill>
            <el-input-number :model-value="path.durationMs / 1000" :step="0.1" :controls="false" :disabled="blocked" aria-label="路径总时长（秒）"
              @change="value => value !== undefined && path && updatePath({ durationMs: normalizeCameraPathDurationMs(value * 1000, getCameraPathMinimumTotalDurationMs(path.waypoints[path.waypoints.length - 1]!.timeMs, path.turnDurationMs)) })" />
          </ScenePropertyRow>
          <el-button size="small" :disabled="blocked || busy" @click="commitPaths(paths.filter(item => item.id !== path?.id))">删除路径</el-button>
        </details>
        <details v-if="point" class="camera-details">
          <summary>所选点参数</summary>
          <div class="camera-grid">
            <label v-for="(label, index) in axes" :key="label">{{ label }}
              <el-input-number :model-value="point.destination[index]" :controls="false" :disabled="blocked" :aria-label="`路径点${label}`"
                :min="index === 0 ? -180 : index === 1 ? -90 : undefined" :max="index === 0 ? 180 : index === 1 ? 90 : undefined"
                @change="value => { if (point && value !== undefined) { const destination = [...point.destination] as GeoCameraPathWaypoint['destination']; destination[index] = value; updatePoint({ destination }) } }" />
            </label>
            <label v-for="{ key, label } in angleFields" :key="key">{{ label }}（°）
              <el-input-number :model-value="point.orientation[key] * 180 / Math.PI" :controls="false" :precision="2"
                :disabled="blocked || (path.orientationMode === 'follow-path' && key !== 'roll')" :aria-label="label"
                @change="value => point && value !== undefined && updatePoint({ orientation: { ...point.orientation, [key]: value * Math.PI / 180 } })" />
            </label>
          </div>
          <ScenePropertyRow class="camera-time-row" label="到达时间（秒）" control-fill>
            <el-input-number :model-value="point.timeMs / 1000" :controls="false" :step="0.1" :disabled="blocked || point.timeMs === 0" aria-label="路径点到达时间（秒）" @change="changePointTime" />
          </ScenePropertyRow>
          <ScenePropertyRow label="插值" control-fill>
            <el-select :model-value="point.interpolation" :disabled="blocked" aria-label="路径点插值" @change="interpolation => updatePoint({ interpolation })">
              <el-option label="线性" value="linear" /><el-option label="缓入缓出" value="ease-in-out" />
            </el-select>
          </ScenePropertyRow>
        </details>
      </template>
    </section>
  </div>
</template>

<style scoped>
.camera-inspector, .camera-inspector section { display: grid; gap: 12px; }
.camera-inspector section + section { border-top: 1px solid var(--scene-edit-line); padding-top: 14px; }
.camera-inspector header, .camera-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.camera-inspector header { justify-content: space-between; }
.camera-inspector h3, .camera-inspector h4 { margin: 0; font-size: 13px; font-weight: 650; }
.camera-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.camera-grid--pair { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.camera-grid label { display: grid; gap: 5px; font-size: 12px; }
.camera-angle { display: grid; gap: 5px; font-size: 12px; }
.camera-angle-value { padding: 6px 8px; border: 1px solid var(--scene-edit-line); border-radius: 4px; font-variant-numeric: tabular-nums; }
.camera-grid .camera-switch { display: flex; align-items: center; justify-content: space-between; }
.camera-grid .el-input-number { width: 100%; }
.camera-inspector .el-button { margin: 0; }
.camera-position-apply { justify-self: end; }
.camera-inspector :deep(.scene-edit-property-row) { margin-bottom: 0; }
.camera-time-row { grid-template-columns: 100px minmax(0, 1fr); }
.camera-recording { display: grid; gap: 10px; padding: 10px; border: 1px solid var(--scene-edit-line); border-radius: 6px; }
.camera-recording strong { font-size: 13px; }
.camera-details { border-top: 1px solid var(--scene-edit-line); padding-top: 8px; }
.camera-details summary { cursor: pointer; font-size: 12px; }
.camera-details[open] > * + * { margin-top: 10px; }
.camera-inspector .el-select { width: 100%; }
.camera-hint { color: rgb(255 255 255 / 65%); font-size: 12px; line-height: 1.5; margin: 0; }
</style>
