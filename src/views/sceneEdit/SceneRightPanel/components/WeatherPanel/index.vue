<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef } from 'vue'
import { ElMessage } from 'element-plus'
import type { ViewportHost } from '@/scene-platform'
import { subscribeActiveSceneViewportHost } from '@/integrations/scene/editorScenePlatformHost'
import { isEditorWeatherWriteAllowed, getEditableEnviroWeatherConfig, updateEditorSceneWeather } from '@/integrations/scene/editorSceneWeatherAdapter'
import { createDefaultEnviroWeatherConfig, createInheritedEnviroWeatherOverrides, selectEnviroWeatherPreset, type EnviroWeatherConfig } from '@/scene-platform/effects/weather'
import { UnityEditorSceneRuntime } from '@/unity-runtime/runtime/UnityEditorSceneRuntime'
import { isWidgetPreview } from '@/integrations/scene/widgetRuntime'
import type { WeatherDescription } from '@/unity-runtime/protocol/weather'
import ScenePropertyRow from '../PropertyControls/ScenePropertyRow/index.vue'
import ScenePropertySwitch from '../PropertyControls/ScenePropertySwitch/index.vue'
import ScenePropertySlider from '../PropertyControls/ScenePropertySlider/index.vue'
import ScenePropertyRadioGroup from '../PropertyControls/ScenePropertyRadioGroup/index.vue'
import ScenePropertyNumberInput from '../PropertyControls/ScenePropertyNumberInput/index.vue'

const host = shallowRef<ViewportHost | null>(null)
const config = ref(createDefaultEnviroWeatherConfig())
const description = shallowRef<WeatherDescription | null>(null)
const versionError = ref('')
const tick = ref(0)
let stopStore = () => {}, stopRuntime = () => {}
let gesture: string | undefined
let gestureField = ''
const runtime = computed(() => { const r = host.value?.getRuntime(); return r instanceof UnityEditorSceneRuntime ? r : null })
const sync = () => {
  const scene = host.value?.getStore().getScene()
  if (!scene) return
  try { config.value = getEditableEnviroWeatherConfig(scene); versionError.value = '' }
  catch (e) { versionError.value = e instanceof Error ? e.message : String(e) }
  description.value = runtime.value?.weatherRuntime?.weatherDescription ?? null
  tick.value++
}
const stopHost = subscribeActiveSceneViewportHost(next => {
  stopStore(); stopRuntime(); host.value = next
  stopStore = next?.getStore().subscribe(sync) ?? (() => {})
  stopRuntime = runtime.value?.weatherRuntime?.weather.subscribe(sync) ?? (() => {})
  sync()
})
const canWrite = () => !!host.value && isEditorWeatherWriteAllowed() && !isWidgetPreview() && host.value.getStore().getScene().settings.readOnly !== true && runtime.value?.canEditWeather() === true
const disabled = computed(() => { void tick.value; return !canWrite() || !!versionError.value || !description.value?.readiness.ready })
const controlsDisabled = computed(() => disabled.value)
const supported = (path: string) => description.value?.supportedControls[path] === true
const hasError = computed(() => { void tick.value; return !!versionError.value || !!runtime.value?.weatherRuntime?.weather.error })
const notice = computed(() => {
  void tick.value
  if (hasError.value) return '天气设置未生效'
  if (!host.value || !runtime.value?.weatherRuntime?.capabilities) return '正在连接天气'
  if (!runtime.value.weatherRuntime.capabilities.features['weather.enviro3']) return '当前播放器暂不支持天气'
  if (!description.value) return '正在连接天气'
  if (!description.value.readiness.ready) return '天气暂不可用'
  return ''
})
const controlReason = (path: string) => supported(path) ? undefined : description.value?.parameterDescriptors[path]?.reason || '当前环境不支持'
const groupEnabled = (toggle?: string) => !toggle || Boolean(override(toggle) ?? runtime.value?.weatherRuntime?.weather.state?.resolved?.[toggle] ?? true)
function commit(next: EnviroWeatherConfig, mergeKey?: string) {
  if (disabled.value || !host.value) return
  try { updateEditorSceneWeather({ store: host.value.getStore(), execute: host.value.getCommandBus().execute, canEdit: canWrite, config: { ...next, enabled: true }, gestureId: mergeKey }) }
  catch (e) { ElMessage.error(e instanceof Error ? e.message : '天气写入失败') }
}
const finish = () => { gesture = undefined; gestureField = ''; void host.value?.getBridge().flush().then(() => runtime.value?.flushWeather()) }
const begin = (field: string) => { if (!gesture || gestureField !== field) { gesture = crypto.randomUUID(); gestureField = field } }
function setPath(path: string, value: unknown, continuous = false) {
  // Element Plus may emit a clamped value while mounting a disabled slider.
  // Scene entry installs the enabled default; mounting an unsupported slider must never write it.
  if (path !== 'enabled' && (controlsDisabled.value || (path.startsWith('overrides.') && !supported(path.slice(10))))) return
  if ((path.startsWith('overrides.clouds.') && path !== 'overrides.clouds.enabled' && !groupEnabled('clouds.enabled')) ||
      (path.startsWith('overrides.fog.') && path !== 'overrides.fog.enabled' && !groupEnabled('fog.enabled'))) return
  const next = JSON.parse(JSON.stringify(config.value)) as EnviroWeatherConfig
  const keys = path.split('.'); let node: Record<string, unknown> = next as unknown as Record<string, unknown>
  keys.slice(0, -1).forEach(key => { node = node[key] as Record<string, unknown> }); node[keys[keys.length - 1]!] = value
  if (continuous) begin(path)
  commit(next, continuous ? gesture : undefined)
}
function override(path: string): number | boolean | null {
  const [group, key] = path.split('.')
  return (config.value.overrides[group as keyof EnviroWeatherConfig['overrides']] as Record<string, number | boolean | null>)[key!] ?? null
}
function resolved(path: string, fallback = 0): number {
  void tick.value
  const range = description.value?.parameterDescriptors[path]
  const value = Number(override(path) ?? runtime.value?.weatherRuntime?.weather.state?.resolved?.[path] ?? fallback)
  return Math.min(range?.max ?? Infinity, Math.max(range?.min ?? -Infinity, value))
}
const groups = [
  { name: '云', toggle: 'clouds.enabled', fields: [{ path: 'clouds.coveragePercent', label: '云量', unit: '%', step: 1 }, { path: 'clouds.baseHeightMeters', label: '云底高度', unit: 'm', step: 100 }] },
  { name: '雾', toggle: 'fog.enabled', fields: [{ path: 'fog.densityPercent', label: '浓度', unit: '%', step: 1 }, { path: 'fog.heightMeters', label: '雾层高度', unit: 'm', step: 10 }] },
  { name: '风', fields: [{ path: 'wind.strengthPercent', label: '风力', unit: '%', step: 1 }, { path: 'wind.directionDeg', label: '吹向', unit: '°', step: 1 }] },
  { name: '光照', fields: [{ path: 'lighting.directMultiplier', label: '太阳 / 月光', unit: '×', step: 0.05 }, { path: 'lighting.ambientMultiplier', label: '环境光', unit: '×', step: 0.05 }] },
]
function quickTime(minutes: number) { if (controlsDisabled.value || !supported('time')) return; commit({ ...config.value, time: { ...config.value.time, mode: 'fixed', minutesOfDay: minutes } }); finish() }
function retry() { runtime.value?.retryWeather(); void runtime.value?.weatherRuntime?.describeWeather().then(sync).catch(e => ElMessage.error(e instanceof Error ? e.message : '能力读取失败')) }
onBeforeUnmount(() => { finish(); stopHost(); stopStore(); stopRuntime() })
</script>

<template>
  <div class="enviro-weather-panel" data-weather-panel>
    <section>
      <div class="weather-heading"><strong>环境设置</strong></div>
      <div v-if="notice" class="weather-notice" :class="{ 'weather-notice--error': hasError }" role="status">
        <span>{{ notice }}</span><button v-if="hasError" type="button" class="weather-inherit" @click="retry">重试</button>
      </div>
    </section>
    <fieldset :disabled="controlsDisabled">
      <section>
        <ScenePropertyRow label="天气预设" control-fill><el-select :disabled="controlsDisabled || !supported('preset')" :model-value="config.presetId" aria-label="天气预设" @update:model-value="commit(selectEnviroWeatherPreset(config, $event)); finish()"><el-option v-for="preset in description?.presets" :key="preset.id" :value="preset.id" :label="preset.displayName" /></el-select></ScenePropertyRow>
        <ScenePropertyRow label="切换方式" control-fill><ScenePropertyRadioGroup :disabled="controlsDisabled" :model-value="config.transition.mode" size="small" @update:model-value="setPath('transition.mode', $event)"><el-radio-button value="instant">立即</el-radio-button><el-radio-button value="smooth">平滑</el-radio-button></ScenePropertyRadioGroup></ScenePropertyRow>
        <button class="weather-action" type="button" @click="commit({ ...config, overrides: createInheritedEnviroWeatherOverrides() }); finish()">恢复当前预设</button>
      </section>
      <section>
        <h4>日期时间</h4>
        <ScenePropertyRow label="时间模式" control-fill><el-select :disabled="controlsDisabled || !supported('time')" :model-value="config.time.mode" @update:model-value="setPath('time.mode', $event)"><el-option value="fixed" label="固定时间" /><el-option value="system" label="跟随系统" /></el-select></ScenePropertyRow>
        <ScenePropertyRow v-if="config.time.mode === 'system'" label="当前时间" control-fill><span class="weather-current-time">{{ runtime?.weatherRuntime?.weather.state?.currentTime ?? '—' }}</span></ScenePropertyRow>
        <ScenePropertyRow label="日期" control-fill><input aria-label="天气日期" type="date" :disabled="controlsDisabled || !supported('time') || config.time.mode === 'system'" :value="config.time.date" @change="setPath('time.date', ($event.target as HTMLInputElement).value)" /></ScenePropertyRow>
        <ScenePropertyRow label="UTC 偏移" control-fill><ScenePropertyNumberInput aria-label="天气 UTC 偏移" :disabled="controlsDisabled || !supported('time')" :model-value="config.time.utcOffsetHours" :min="-13" :max="13" :step="1" @update:model-value="setPath('time.utcOffsetHours', $event)" /></ScenePropertyRow>
        <div class="weather-field"><div class="weather-label"><span>时刻</span><span>{{ Math.floor(config.time.minutesOfDay / 60).toString().padStart(2, '0') }}:{{ (config.time.minutesOfDay % 60).toString().padStart(2, '0') }}</span></div>
          <ScenePropertySlider :model-value="config.time.minutesOfDay" :min="0" :max="1439" :step="5" :disabled="controlsDisabled || !supported('time') || config.time.mode === 'system'" aria-label="天气时刻" @update:model-value="setPath('time.minutesOfDay', $event, true)" @change="finish" @blur="finish" />
        </div>
        <div class="weather-shortcuts"><button v-for="(label, i) in ['清晨', '正午', '黄昏', '夜晚']" :key="label" type="button" :disabled="controlsDisabled || !supported('time')" @click="quickTime([360, 720, 1080, 0][i]!)">{{ label }}</button></div>
      </section>
      <section v-for="group in groups" :key="group.name">
        <div class="weather-heading"><h4>{{ group.name }}</h4><div v-if="group.toggle" class="weather-toggle">
          <button v-if="override(group.toggle) !== null" class="weather-inherit" type="button" :disabled="controlsDisabled || !supported(group.toggle)" :aria-label="'重置' + group.name + '开关'" title="恢复预设值" @click="setPath('overrides.' + group.toggle, null)">重置</button>
          <ScenePropertySwitch :model-value="Boolean(override(group.toggle) ?? runtime?.weatherRuntime?.weather.state?.resolved?.[group.toggle] ?? true)" :disabled="controlsDisabled || !supported(group.toggle)" :aria-label="group.name + '开关'" @update:model-value="setPath('overrides.' + group.toggle, $event)" />
        </div></div>
        <div v-for="field in group.fields" :key="field.path" class="weather-field" :class="{ 'weather-field--unavailable': !supported(field.path) || !groupEnabled(group.toggle) }" :title="controlReason(field.path) ?? (groupEnabled(group.toggle) ? undefined : '请先开启' + group.name)">
          <div class="weather-label"><span>{{ field.label }}</span><button v-if="override(field.path) !== null" class="weather-inherit" type="button" :disabled="controlsDisabled || !supported(field.path) || !groupEnabled(group.toggle)" :aria-label="'重置' + field.label" title="恢复预设值" @click="setPath('overrides.' + field.path, null)">重置</button><span class="weather-value">{{ supported(field.path) ? resolved(field.path, field.unit === '×' ? 1 : 0).toFixed(field.step < 1 ? 2 : 0) + field.unit : '—' }}</span></div>
          <ScenePropertySlider :model-value="resolved(field.path, field.unit === '×' ? 1 : 0)" :min="description?.parameterDescriptors[field.path]?.min ?? 0" :max="description?.parameterDescriptors[field.path]?.max ?? 100" :step="field.step" :disabled="controlsDisabled || !supported(field.path) || !groupEnabled(group.toggle)" :aria-label="field.label" @update:model-value="setPath('overrides.' + field.path, $event, true)" @change="finish" @blur="finish" />
        </div>
      </section>
      <section><ScenePropertyRow label="效果质量" control-fill><el-select :disabled="controlsDisabled || !supported('quality')" :model-value="config.quality.profile" @update:model-value="setPath('quality.profile', $event)"><el-option v-for="id in description?.qualityProfiles" :key="id" :value="id" :label="({ low: '低', medium: '中', high: '高' } as Record<string, string>)[id] ?? id" /></el-select></ScenePropertyRow></section>
    </fieldset>
  </div>
</template>

<style scoped lang="scss">
.enviro-weather-panel { color: #d8e2eb; font-size: 12px; }
fieldset { margin: 0; padding: 0; border: 0; min-width: 0; }
fieldset:disabled { opacity: .58; }
section { display: grid; gap: 14px; padding: 16px 0 20px; border-bottom: 1px solid var(--scene-edit-line); }
section:first-child { padding-top: 2px; }
h4 { margin: 0; } h4, strong { font-size: 14px; font-weight: 500; }
.weather-heading, .weather-label, .weather-toggle { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.weather-label { font-size: 12px; } .weather-label > span:last-child { font-variant-numeric: tabular-nums; }
.weather-value { margin-left: auto; }
.weather-field--unavailable .weather-label { color: #788b9a; }
.weather-current-time { font-size: 12px; font-variant-numeric: tabular-nums; }
.weather-notice { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: #92a2b1; line-height: 1.6; }
.weather-notice--error { color: #c9b48e; }
button, input { font: inherit; color: inherit; background: #131c26; border: 1px solid var(--scene-edit-line); border-radius: 3px; padding: 6px 8px; }
button { cursor: pointer; } button:hover:enabled { border-color: #5ab2a5; color: #5ab2a5; }
button:disabled { cursor: default; opacity: .5; }
.weather-inherit { background: none; border: 0; padding: 2px 0; color: #92a2b1; font-size: 11px; }
.weather-shortcuts { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
.weather-action { color: #5ab2a5; justify-self: start; }
button:focus-visible { outline: 1px solid #5ab2a5; outline-offset: 3px; }
input, :deep(.el-select), :deep(.el-input-number) { width: 100%; box-sizing: border-box; }
</style>
