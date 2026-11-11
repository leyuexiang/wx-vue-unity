<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef } from 'vue'
import { ElMessage } from 'element-plus'
import type { SceneDefinition, ViewportHost } from '@/scene-platform'
import { subscribeActiveSceneViewportHost } from '@/integrations/scene/editorScenePlatformHost'
import { isWidgetPreview } from '@/integrations/scene/widgetRuntime'
import {
  DEFAULT_GIS_SOURCE, EDITOR_GIS_IMAGERY_PRESETS, GIS_NUMERIC_RANGES, getEditorGisAppearance, getEditorGisBaseLayer,
  getEditorGisSourceKey, isSelectableGisTile, isEditorGisWriteAllowed, updateEditorSceneGis,
  type EditorGisAppearance, type GisDataKind, type GisTileRecord,
} from '@/integrations/scene/editorSceneGisAdapter'
import { listGisTile } from '@/servers/manual/gis/api'
import ScenePropertyRow from '../PropertyControls/ScenePropertyRow/index.vue'
import ScenePropertySlider from '../PropertyControls/ScenePropertySlider/index.vue'
import ScenePropertyNumberInput from '../PropertyControls/ScenePropertyNumberInput/index.vue'

const host = shallowRef<ViewportHost | null>(null)
const scene = shallowRef<SceneDefinition | null>(null)
const appearance = ref<EditorGisAppearance>({ terrainExaggeration: 1, brightness: 1, contrast: 1, saturation: 1, originConfigured: false })
const longitude = ref(0), latitude = ref(0)
const sources = ref<Record<GisDataKind, GisTileRecord[]>>({ terrain: [], imagery: [] })
const loading = ref(false), sourceError = ref('')
let stopStore = () => {}, disposed = false, requestVersion = 0
const isGis = computed(() => scene.value?.type === 'gis' && scene.value.coordinateSystem.kind === 'wgs84')
const disabled = computed(() => !host.value || !isEditorGisWriteAllowed() || scene.value?.settings.readOnly === true || isWidgetPreview())
const sync = () => {
  scene.value = host.value?.getStore().getScene() ?? null
  if (scene.value?.coordinateSystem.kind !== 'wgs84') return
  appearance.value = getEditorGisAppearance(scene.value)
  longitude.value = scene.value.coordinateSystem.defaultLongitude
  latitude.value = scene.value.coordinateSystem.defaultLatitude
}
async function loadSources() {
  const version = ++requestVersion
  loading.value = true; sourceError.value = ''
  const kinds: GisDataKind[] = ['terrain', 'imagery']
  const results = await Promise.allSettled([listGisTile('ELEVATION'), listGisTile('SATELLITE')])
  if (disposed || version !== requestVersion) return
  const failed: string[] = []
  results.forEach((result, index) => {
    const kind = kinds[index]!
    if (result.status === 'fulfilled' && String(result.value.code) === '200')
      sources.value[kind] = (result.value.data ?? []).filter(tile => isSelectableGisTile(tile, kind))
    else failed.push(kind === 'terrain' ? '高程' : '影像')
  })
  sourceError.value = failed.length ? `${failed.join('、')}数据加载失败，当前配置已保留。` : ''
  loading.value = false
}
const stopHost = subscribeActiveSceneViewportHost(next => {
  stopStore(); host.value = next; sync()
  stopStore = next?.getStore().subscribe(event => {
    if (['sceneLoaded', 'sceneGisUpdated', 'sceneSettingsUpdated', 'layerUpserted', 'layerRemoved'].includes(event.type)) sync()
    if (event.type === 'sceneLoaded' && isGis.value) void loadSources()
  }) ?? (() => {})
  if (isGis.value) void loadSources()
})
function commit(change: Pick<Parameters<typeof updateEditorSceneGis>[0], 'appearance' | 'origin' | 'source'>) {
  if (disabled.value || !host.value) return
  try {
    updateEditorSceneGis({ store: host.value.getStore(), execute: host.value.getCommandBus().execute, canEdit: () => !disabled.value, ...change })
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : 'GIS 配置更新失败'); sync() }
}
const selectedSource = (kind: GisDataKind) => getEditorGisSourceKey(scene.value ? getEditorGisBaseLayer(scene.value, kind) : undefined)
function sourceOptions(kind: GisDataKind) {
  const options = sources.value[kind].map(tile => ({ value: String(tile.id), label: tile.gisName }))
  if (kind === 'imagery') options.unshift(...EDITOR_GIS_IMAGERY_PRESETS.map(preset => ({ value: preset.id, label: preset.label })))
  const current = scene.value ? getEditorGisBaseLayer(scene.value, kind) : undefined
  const key = getEditorGisSourceKey(current)
  if (current && !options.some(option => option.value === key)) options.unshift({ value: key, label: current.name })
  return options
}
function selectSource(kind: GisDataKind, value: string) {
  if (value === selectedSource(kind)) return
  if (kind === 'imagery') {
    const preset = EDITOR_GIS_IMAGERY_PRESETS.find(item => item.id === value)
    if (preset) {
      commit({ source: { kind, presetId: preset.id } })
      return
    }
  }
  const tile = sources.value[kind].find(item => String(item.id) === value)
  if (value !== DEFAULT_GIS_SOURCE && !tile) return
  commit({ source: { kind, tile: tile ?? null } })
}
function commitNumber(key: keyof typeof GIS_NUMERIC_RANGES) { commit({ appearance: { [key]: appearance.value[key] } }) }
function commitOrigin() { commit({ origin: { longitude: longitude.value, latitude: latitude.value } }) }
const imageFields = [{ key: 'brightness', label: '亮度' }, { key: 'contrast', label: '对比度' }, { key: 'saturation', label: '饱和度' }] as const
onBeforeUnmount(() => { disposed = true; stopHost(); stopStore() })
</script>

<template>
  <div v-if="isGis" class="scene-gis-settings" data-scene-gis-settings>
    <section>
      <h3>高程配置</h3>
      <ScenePropertyRow label="高程数据" control-fill>
        <el-select :model-value="selectedSource('terrain')" :disabled="disabled" :loading="loading" placement="bottom-end" :fallback-placements="['top-end']" aria-label="高程数据" @change="selectSource('terrain', $event)">
          <el-option :value="DEFAULT_GIS_SOURCE" label="默认高程" />
          <el-option v-for="option in sourceOptions('terrain')" :key="option.value" v-bind="option" />
        </el-select>
      </ScenePropertyRow>
      <ScenePropertyRow label="夸张系数">
        <div class="scene-gis-settings__slider-row">
          <ScenePropertySlider v-model="appearance.terrainExaggeration" v-bind="GIS_NUMERIC_RANGES.terrainExaggeration" :disabled="disabled" aria-label="夸张系数" @change="commitNumber('terrainExaggeration')" />
          <output>{{ appearance.terrainExaggeration.toFixed(1) }}</output>
        </div>
      </ScenePropertyRow>
    </section>
    <section>
      <h3>影像配置</h3>
      <ScenePropertyRow label="影像数据" control-fill>
        <el-select :model-value="selectedSource('imagery')" :disabled="disabled" placement="bottom-end" :fallback-placements="['top-end']" aria-label="影像数据" @change="selectSource('imagery', $event)">
          <el-option :value="DEFAULT_GIS_SOURCE" label="默认影像" />
          <el-option v-for="option in sourceOptions('imagery')" :key="option.value" v-bind="option" />
        </el-select>
      </ScenePropertyRow>
      <ScenePropertyRow v-for="field in imageFields" :key="field.key" :label="field.label">
        <div class="scene-gis-settings__slider-row">
          <ScenePropertySlider v-model="appearance[field.key]" v-bind="GIS_NUMERIC_RANGES[field.key]" :disabled="disabled" :aria-label="field.label" @change="commitNumber(field.key)" />
          <output>{{ appearance[field.key].toFixed(1) }}</output>
        </div>
      </ScenePropertyRow>
    </section>
    <section>
      <h3>原点设置</h3>
      <ScenePropertyRow label="场景原点" control-fill>
        <div class="scene-gis-settings__origin">
          <ScenePropertyNumberInput v-model="longitude" :min="-180" :max="180" :step="0.000001" :precision="6" :controls="false" :disabled="disabled" aria-label="场景原点经度" @change="commitOrigin" />
          <ScenePropertyNumberInput v-model="latitude" :min="-90" :max="90" :step="0.000001" :precision="6" :controls="false" :disabled="disabled" aria-label="场景原点纬度" @change="commitOrigin" />
        </div>
      </ScenePropertyRow>
    </section>
    <div v-if="sourceError" class="scene-gis-settings__notice" role="status">
      <span>{{ sourceError }}</span><button type="button" :disabled="loading" @click="loadSources">重试</button>
    </div>
  </div>
</template>

<style scoped lang="scss">
.scene-gis-settings {
  min-width: 0;
  section { display: grid; gap: 4px; padding: 24px 0; border-bottom: 1px solid var(--scene-edit-line); }
  section:last-of-type { border-bottom: 0; }
  h3 { margin: 0 0 12px; font-size: 14px; font-weight: 600; line-height: 21px; color: var(--scene-edit-text); }
  &__slider-row { display: grid; grid-template-columns: minmax(0, 1fr) 30px; align-items: center; gap: 12px; width: 100%; min-width: 0; }
  output { text-align: right; font-size: 12px; font-weight: 600; color: var(--scene-edit-text-2); font-variant-numeric: tabular-nums; }
  &__origin { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px; min-width: 0; }
  &__origin :deep(.el-input-number) { width: 100%; min-width: 0; }
  &__origin :deep(.el-input__inner) { text-align: left; font-size: 12px; padding: 0; }
  &__notice { display: flex; gap: 8px; padding: 8px 0; font-size: 12px; line-height: 1.6; color: var(--scene-edit-text-2); }
  button { flex: none; padding: 0; border: 0; background: none; color: var(--scene-edit-accent); cursor: pointer; }
}
</style>
