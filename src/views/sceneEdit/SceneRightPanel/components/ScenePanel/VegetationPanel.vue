<script setup lang="ts">
import { computed, inject, onBeforeUnmount, ref, shallowRef, watch, watchEffect } from 'vue'
import { ElMessage } from 'element-plus'
import {
  createDefaultVegetationAuthoringDefinition,
  createUpdateVegetationSystemCommand,
  type ViewportHost,
  type VegetationSystemDefinition,
  type VegetationPlantingRule,
  type VegetationPolygonRule,
  type VegetationSpeciesDefinition,
  type VegetationGeoPosition,
  type VegetationAltitudeZoneDefinition,
} from '@/scene-platform'
import { validateVegetationSystemDefinition } from '@/scene-platform/core/vegetation'
import { subscribeActiveSceneViewportHost } from '@/integrations/scene/editorScenePlatformHost'
import { isEditorGisWriteAllowed } from '@/integrations/scene/editorSceneGisAdapter'
import { isImageryPlantingRule, listVegetationRegions, type ImageryRegion } from '@/integrations/scene/editorVegetationRegions'
import {
  clipImageryPlantingRule, drawVegetationRegionPreview, loadVegetationRegionPreview,
  recognizeVegetationSelection, vegetationImageryBox, vegetationImageryLayer,
  type ImageryExclusion, type VegetationImageryPreview,
} from '@/integrations/scene/vegetationImagery'
import { isWidgetPreview } from '@/integrations/scene/widgetRuntime'
import { isVegetationEditorRuntime, type VegetationEditorRuntime } from '@/unity-runtime/runtime/vegetationEditorRuntime'
import ScenePropertyRow from '../PropertyControls/ScenePropertyRow/index.vue'
import VegetationPublicationPanel from './VegetationPublicationPanel.vue'
import { migrateLegacyPlantings } from '@/integrations/scene/legacyPlantingMigration'
import type { VegetationModelChoice } from '@/unity-runtime/runtime/vegetationModelCatalog'
import { loadDim3dModelGroups } from '@/views/sceneEdit/SceneLeftPanel/components/ResourcePanel/modelResource'
import { VEGETATION_STRUCTURE_KEY } from '../../../vegetationStructure'

const vegetationStructure = inject(VEGETATION_STRUCTURE_KEY, null)
const emit = defineEmits<{ inspectorViewChange: [] }>()
const host = shallowRef<ViewportHost | null>(null)
const draft = ref<VegetationSystemDefinition>()
const revision = ref(0),
  selectedRuleId = ref(''),
  modelId = ref('')
const dirty = ref(false),
  busy = ref(false),
  message = ref('')
const publicationBusy = ref(false)
const vegetationAvailable = ref(false)
const pointPickSession = shallowRef<{ runtime: VegetationEditorRuntime } | null>(null)
const picking = computed(() => pointPickSession.value !== null)
const imagerySelection = shallowRef<{
  runtime: VegetationEditorRuntime; controller: AbortController; mode: 'plant' | 'exclude'
  region?: ImageryRegion
} | null>(null)
const imageryOutline = shallowRef<VegetationGeoPosition[]>([])
const imageryResult = shallowRef<VegetationImageryPreview>()
const imageryPreviews = new Map<string, VegetationImageryPreview>()
const imageryError = ref('')
const imageryDensity = ref(100)
const pendingImageryRuleIds = shallowRef(new Set<string>())
let replacedImageryRules: Array<{ rule: VegetationPlantingRule; index: number }> = []
const modelChoices = shallowRef<VegetationModelChoice[]>([])
const modelsLoading = ref(false)
const modelsError = ref('')
let modelRequest = 0
const stats = shallowRef<Record<string, unknown>>({})
const applyError = ref(false)
const selectedQuantity = computed(() =>
  (stats.value.quantityRules as { id: string; planned: number; resident: number }[] | undefined)
    ?.find(item => item.id === selectedRuleId.value),
)
const tab = ref('regions')
const regionInspectorOpen = ref(false)
const ringIndex = ref(0)
let pendingDrawnRuleId: string | undefined
const drawing = shallowRef<{
  ruleId: string
  previousRuleId: string
  wasDirty: boolean
  baseline: string
  runtime: VegetationEditorRuntime
  kind: 'polygon' | 'corridor'
} | null>(null)
const activeDrawingMode = computed(() => drawing.value?.kind)
const canFinishDrawing = computed(
  () =>
    !!drawing.value &&
    !!rule.value &&
    points(rule.value).length >= (rule.value.kind === 'corridor' ? 2 : 3),
)
const importInput = ref<HTMLInputElement>()
const scene = computed(() => {
  void revision.value
  return host.value?.getStore().getScene()
})
const imageryLayer = computed(() => {
  void revision.value
  return vegetationImageryLayer(host.value?.getStore().getLayers() ?? [])
})
const runtime = computed(() => {
  void revision.value
  const value = host.value?.getRuntime()
  return isVegetationEditorRuntime(value) ? value : null
})
const blocked = computed(
  () =>
    !scene.value ||
    scene.value.type !== 'gis' ||
    scene.value.settings.readOnly === true ||
    !isEditorGisWriteAllowed() ||
    isWidgetPreview(),
)
const rule = computed(() =>
  draft.value?.rules.find((item) => item.id === selectedRuleId.value),
)
const regions = computed(() => listVegetationRegions(draft.value?.rules ?? []))
const selectedRegion = computed(() => regions.value.find(item => item.kind === 'imagery'
  ? item.patches.some(patch => patch.id === selectedRuleId.value)
  : item.id === selectedRuleId.value))
const selectedImageryRegion = computed(() => {
  const region = selectedRegion.value
  return region?.kind === 'imagery' ? region : undefined
})
const selectedRegionId = computed(() => selectedRegion.value?.id ?? '')
const showRegionInspector = computed(() => regionInspectorOpen.value && !!selectedRegion.value)
const ruleSelectionDisabled = computed(() =>
  busy.value || publicationBusy.value || !!drawing.value || picking.value || !!imagerySelection.value,
)
const models = computed(() => {
  const choices = new Map<string, VegetationModelChoice>()
  for (const item of scene.value?.objects ?? []) {
    if (
      item.type !== 'model' ||
      !item.asset ||
      !['glb', 'gltf'].includes(item.asset.kind)
    )
      continue
    const identity = String(item.asset.metadata?.assetId ?? item.asset.id)
    choices.set(identity, { id: item.id, name: item.name, asset: item.asset })
  }
  for (const item of modelChoices.value) {
    const identity = String(item.asset.metadata?.assetId ?? item.asset.id)
    if (!choices.has(identity)) choices.set(identity, item)
  }
  return [...choices.values()].filter(item => draft.value?.streaming.renderMode !== 'published-tiles' ||
    item.asset.kind === 'glb' && /^https?:\/\//i.test(item.asset.url ?? ''))
})
const issues = computed(() =>
  draft.value
    ? validateVegetationSystemDefinition(draft.value, 'gis').issues
    : [],
)
const uid = (prefix: string) => `${prefix}-${crypto.randomUUID()}`
let stopStore = () => {},
  generation = 0,
  polling = false
let previewTimer: ReturnType<typeof setTimeout> | undefined

function resetImageryResult() {
  pendingImageryRuleIds.value = new Set()
  replacedImageryRules = []
  imageryError.value = ''
}
function restore() {
  pendingDrawnRuleId = undefined
  resetImageryResult()
  draft.value = scene.value?.vegetation
    ? structuredClone(scene.value.vegetation)
    : undefined
  dirty.value = false
  message.value = ''
  if (!draft.value?.rules.some((item) => item.id === selectedRuleId.value))
    selectedRuleId.value = ''
}
const stopHost = subscribeActiveSceneViewportHost((next) => {
  cancelInteraction()
  modelRequest++
  modelChoices.value = []
  modelsLoading.value = false
  modelsError.value = ''
  stopStore()
  generation++
  busy.value = false
  host.value = next
  revision.value++
  restore()
  stopStore =
    next?.getStore().subscribe((event) => {
      revision.value++
      if (event.type === 'sceneLoaded') {
        cancelInteraction()
        generation++
        busy.value = false
        stats.value = {}
        selectedRuleId.value = ''
        restore()
      } else if (event.type === 'vegetationUpdated' && !dirty.value) restore()
    }) ?? (() => {})
})
async function refreshModels() {
  const current = runtime.value
  const published = draft.value?.streaming.renderMode === 'published-tiles'
  if ((!current && !published) || modelsLoading.value) return
  const request = ++modelRequest
  modelsLoading.value = true
  modelsError.value = ''
  try {
    let choices = published ? null : await current!.listVegetationModels()
    if (choices === null) {
      const results = await Promise.allSettled([
        loadDim3dModelGroups('SYSTEM'),
        loadDim3dModelGroups('MINE'),
      ])
      if (results.every((result) => result.status === 'rejected'))
        throw new Error('模型资源读取失败，请检查登录或点击刷新重试')
      choices = results
        .flatMap((result) =>
          result.status === 'fulfilled' ? result.value : [],
        )
        .flatMap((group) => group.children)
        .filter(
          (item) =>
            item.resourceAsset &&
            ['glb', 'gltf'].includes(String(item.fileType).toLowerCase()),
        )
        .map((item) => ({
          id: item.resourceAsset!.id,
          name: item.name,
          asset: {
            ...item.resourceAsset!,
            kind: String(item.fileType).toLowerCase() as 'glb' | 'gltf',
            metadata: { assetId: item.resourceAsset!.id },
          },
        }))
    }
    if (request === modelRequest) modelChoices.value = choices
  } catch (error) {
    if (request === modelRequest)
      modelsError.value =
        error instanceof Error ? error.message : '模型列表读取失败'
  } finally {
    if (request === modelRequest) modelsLoading.value = false
  }
}
watch(() => draft.value?.streaming.renderMode, () => {
  modelRequest++
  modelChoices.value = []
  modelsLoading.value = false
  modelId.value = ''
  if (tab.value === 'species') void refreshModels()
})
watch([tab, runtime, vegetationAvailable], () => {
  if (tab.value === 'species') void refreshModels()
})
function createSystem() {
  if (!scene.value || blocked.value) return
  const config = createDefaultVegetationAuthoringDefinition(scene.value.id)
  config.streaming = {
    ...config.streaming,
    renderMode: 'instanced',
    maximumDisplayDistanceM: 1000,
    distanceHysteresisM: 100,
    memoryBudgetMB: 512,
    targetFps: 30,
  }
  config.elevationSource = {
    kind: 'scene-terrain',
    verticalDatum: 'ellipsoid',
    heightOffsetM: 0,
  }
  config.layers = [
    {
      id: 'vegetation-main',
      name: '场景植被',
      visible: true,
      locked: false,
      kind: 'forest',
      speciesIds: [],
      priority: 0,
    },
  ]
  draft.value = config
  dirty.value = true
}
function snapshot<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
function changed() {
  applyError.value = false
  dirty.value = true
  message.value = ''
}
async function importFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file || !draft.value || blocked.value) return
  const scope = generation
  try {
    if (file.size > 10 * 1024 * 1024)
      throw new Error('植被规则文件不能超过 10 MB')
    const value: unknown = JSON.parse(await file.text())
    if (scope !== generation) return
    if (value && typeof value === 'object' && 'schemaVersion' in value) {
      const result = validateVegetationSystemDefinition(value, 'gis')
      if (result.issues.length) throw new Error(result.issues[0])
      draft.value = structuredClone(value) as VegetationSystemDefinition
      pendingDrawnRuleId = undefined
    } else {
      const mode = draft.value.streaming.renderMode
      draft.value = migrateLegacyPlantings(value, snapshot(draft.value))
      if (mode === 'published-tiles') draft.value.streaming.renderMode = mode
    }
    resetImageryResult()
    selectedRuleId.value = draft.value.rules[0]?.id ?? ''
    changed()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '导入失败')
  } finally {
    input.value = ''
  }
}
function exportFile() {
  if (!draft.value) return
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(draft.value, null, 2)], {
      type: 'application/json',
    }),
  )
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = 'vegetation-rules.json'
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}
function addSpecies() {
  const object = models.value.find((item) => item.id === modelId.value)
  if (!object?.asset || !draft.value) return
  if (
    draft.value.speciesCatalog.some(
      (item) =>
        String(item.modelAsset.metadata?.assetId ?? item.modelAsset.id) ===
        String(object.asset.metadata?.assetId ?? object.asset.id),
    )
  ) {
    ElMessage.info('该模型已在物种目录')
    return
  }
  const entry: VegetationSpeciesDefinition = {
    id: uid('species'),
    name: object.name,
    enabled: true,
    modelAsset: snapshot(object.asset),
    minimumScale: 1,
    maximumScale: 1,
  }
  draft.value.speciesCatalog.push(entry)
  draft.value.layers[0]?.speciesIds.push(entry.id)
  for (const item of draft.value.rules) {
    const targets = item.kind === 'altitude-zonation' ? item.zones : [item]
    for (const target of targets)
      if (!target.speciesMix.length)
        target.speciesMix.push({ speciesId: entry.id, weight: 1 })
  }
  changed()
}
function removeSpecies(id: string) {
  if (!draft.value) return
  const used = draft.value.rules.some((item) =>
    item.kind === 'altitude-zonation'
      ? item.zones.some((zone) =>
          zone.speciesMix.some((entry) => entry.speciesId === id),
        )
      : item.speciesMix.some((entry) => entry.speciesId === id),
  )
  if (used) {
    ElMessage.warning('请先从种植规则中移除该物种')
    return
  }
  draft.value.speciesCatalog = draft.value.speciesCatalog.filter(
    (item) => item.id !== id,
  )
  draft.value.layers.forEach((layer) => {
    layer.speciesIds = layer.speciesIds.filter((value) => value !== id)
  })
  changed()
}
function defaultMix() {
  return (
    draft.value?.speciesCatalog
      .filter((item) => item.enabled)
      .map((item) => ({ speciesId: item.id, weight: 1 })) ?? []
  )
}
function zone(): VegetationAltitudeZoneDefinition {
  return {
    id: uid('zone'),
    name: '海拔分带',
    enabled: true,
    minimumAltitudeM: 0,
    maximumAltitudeM: 1000,
    minimumSlopeDegrees: 0,
    maximumSlopeDegrees: 60,
    densityPerHectare: 100,
    minimumSpacingM: 5,
    upperTransitionWidthM: 0,
    speciesMix: defaultMix(),
  }
}
function addRule(kind: VegetationPlantingRule['kind']) {
  const config = draft.value,
    layer = config?.layers[0]
  if (!config || !layer) return
  const base = {
    id: uid('planting'),
    name:
      kind === 'corridor'
        ? '行道树'
        : kind === 'polygon'
          ? '区域种植'
          : '海拔植被带',
    enabled: true,
    layerId: layer.id,
    priority: 0,
    seedOffset: config.rules.length,
  }
  const value: VegetationPlantingRule =
    kind === 'corridor'
      ? {
          ...base,
          kind,
          speciesMix: defaultMix(),
          path: [],
          side: 'both',
          offsetM: 3,
          spacingM: 8,
          startOffsetM: 0,
          endOffsetM: 0,
          alignToPath: true,
        }
      : kind === 'polygon'
        ? {
            ...base,
            kind,
            speciesMix: defaultMix(),
            polygon: { rings: [[]] },
            distribution: 'poisson',
            densityPerHectare: 100,
            minimumSpacingM: 5,
          }
        : {
            ...base,
            kind,
            ...(config.streaming.renderMode === 'published-tiles'
              ? { scope: 'polygon' as const, polygon: { rings: [[]] } }
              : { scope: 'camera-view' as const }),
            gapPolicy: 'leave-empty',
            zones: [zone()],
          }
  config.rules.push(value)
  ringIndex.value = 0
  selectedRuleId.value = value.id
  tab.value = 'regions'
  changed()
  return rule.value
}
function keepLatestDrawing(ruleId: string) {
  const config = draft.value
  if (!config) return
  if (pendingDrawnRuleId) {
    config.rules = config.rules.filter((item) => item.id !== pendingDrawnRuleId)
  }
  pendingDrawnRuleId = ruleId
}
function removeRule() {
  if (!draft.value || !rule.value) return
  if (pendingDrawnRuleId === rule.value.id) pendingDrawnRuleId = undefined
  const removedIds = new Set(selectedImageryRegion.value?.patches.map(item => item.id) ?? [rule.value.id])
  draft.value.rules = draft.value.rules.filter(item => !removedIds.has(item.id))
  pendingImageryRuleIds.value = new Set([...pendingImageryRuleIds.value].filter(id => !removedIds.has(id)))
  selectedRuleId.value = ''
  changed()
}
function cloneRule() {
  if (!draft.value || !rule.value) return
  const copy = snapshot(rule.value)
  copy.id = uid('planting')
  copy.name += ' 副本'
  copy.enabled = false
  draft.value.rules.push(copy)
  selectedRuleId.value = copy.id
  changed()
}
function renameImageryRegion(name: string) {
  const region = selectedImageryRegion.value
  if (!region) return
  const previous = region.patches[0]!
  const metadata = { ...previous.imageryRegion, id: previous.imageryRegion?.id ?? previous.id, name }
  for (const patch of region.patches) patch.imageryRegion = metadata
  changed()
}
function imageryRegionValue<K extends keyof VegetationPolygonRule>(key: K) {
  const patches = selectedImageryRegion.value?.patches
  if (!patches?.length) return undefined
  const value = patches[0]![key]
  return patches.every(patch => patch[key] === value) ? value : undefined
}
function setImageryRegionValue<K extends keyof VegetationPolygonRule>(key: K, value: VegetationPolygonRule[K] | undefined) {
  if (value == null || !selectedImageryRegion.value) return
  for (const patch of selectedImageryRegion.value.patches) {
    patch[key] = value
    if (key === 'densityPerHectare') delete patch.targetCount
  }
  if (key === 'densityPerHectare' && typeof value === 'number') imageryDensity.value = value
  changed()
}
function imagerySpeciesWeight(id: string) {
  const weights = selectedImageryRegion.value?.patches.map(patch =>
    patch.speciesMix.find(item => item.speciesId === id)?.weight ?? 0) ?? []
  return weights.every(weight => weight === weights[0]) ? weights[0] : undefined
}
function setImagerySpeciesWeight(id: string, weight: number | undefined) {
  if (weight == null || !selectedImageryRegion.value) return
  for (const patch of selectedImageryRegion.value.patches) {
    patch.speciesMix = patch.speciesMix.filter(item => item.speciesId !== id)
    if (weight > 0) patch.speciesMix.push({ speciesId: id, weight })
  }
  changed()
}
function imageryRegionOutline(region: ImageryRegion): VegetationGeoPosition[] {
  const corners = region.patches[0]?.imageryRegion?.corners
  if (corners) return vegetationImageryBox(...corners)
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity
  let height = 0, count = 0
  for (const patch of region.patches) {
    for (const [longitude, latitude, altitude] of patch.polygon.rings[0] ?? []) {
      west = Math.min(west, longitude)
      east = Math.max(east, longitude)
      south = Math.min(south, latitude)
      north = Math.max(north, latitude)
      if (altitude !== undefined) {
        height += altitude
        count++
      }
    }
  }
  if (west >= east || south >= north) return []
  const fallbackHeight = scene.value?.coordinateSystem.kind === 'wgs84' ? scene.value.coordinateSystem.defaultHeight : 0
  const altitude = count ? height / count : fallbackHeight
  return vegetationImageryBox([west, south, altitude], [east, north, altitude])
}

const imageryPreviewInput = computed(() => {
  const region = selectedImageryRegion.value
  if (!region) return
  const box = imageryRegionOutline(region)
  if (!box.length) return
  const [west, south] = box[0]!, [east, north] = box[2]!
  if (west >= east || south >= north) return
  const polygons = region.patches.map(patch => patch.polygon)
  const exclusions = (draft.value?.imageryExclusions ?? []).filter(bounds =>
    bounds[0] < east && bounds[2] > west && bounds[1] < north && bounds[3] > south)
  const key = JSON.stringify([scene.value?.id, region.id, box, polygons, exclusions])
  return { key, box, polygons, exclusions }
})

function cacheImageryPreview(key: string, result: VegetationImageryPreview) {
  imageryPreviews.delete(key)
  imageryPreviews.set(key, result)
  if (imageryPreviews.size > 24) imageryPreviews.delete(imageryPreviews.keys().next().value!)
  imageryResult.value = result
}

watch(() => imageryPreviewInput.value?.key, (key, _, onCleanup) => {
  const input = imageryPreviewInput.value
  imageryResult.value = undefined
  if (!key || !input) return
  const cached = imageryPreviews.get(key)
  if (cached) {
    cacheImageryPreview(key, cached)
    return
  }
  const { box, polygons, exclusions } = input
  imageryResult.value = drawVegetationRegionPreview(box, polygons, exclusions)
  const controller = new AbortController()
  onCleanup(() => controller.abort())
  void loadVegetationRegionPreview(imageryLayer.value, box, controller.signal, polygons, exclusions)
    .then(result => {
      if (!controller.signal.aborted && imageryPreviewInput.value?.key === key && !imageryPreviews.has(key))
        cacheImageryPreview(key, result)
    })
    .catch(() => { /* Keep the saved planting geometry visible when imagery is unavailable. */ })
}, { immediate: true })
function points(value: VegetationPlantingRule): VegetationGeoPosition[] {
  if (value.kind === 'corridor') return value.path
  const ring = value.polygon?.rings[ringIndex.value] ?? []
  return ring.length > 1 ? ring.slice(0, -1) : ring
}
function setPoints(
  value: VegetationPlantingRule,
  values: VegetationGeoPosition[],
) {
  if (value.kind === 'corridor') value.path = values
  else {
    const rings = value.polygon?.rings ?? [[]]
    rings[ringIndex.value] = values.length
      ? [...values, [...values[0]!] as VegetationGeoPosition]
      : []
    value.polygon = { rings }
  }
  changed()
}
function onDrawingKey(event: KeyboardEvent) {
  if (
    event.key === 'Enter' &&
    event.target instanceof HTMLElement &&
    event.target.closest('input, textarea, select, [contenteditable="true"]')
  )
    return
  if (event.key !== 'Escape' && event.key !== 'Enter') return
  event.preventDefault()
  event.stopImmediatePropagation()
  if (event.key === 'Escape') finishDrawing(false)
  else if (canFinishDrawing.value) finishDrawing(true)
}
function finishDrawing(keep: boolean) {
  const session = drawing.value
  if (!session || (keep && !canFinishDrawing.value)) return
  drawing.value = null
  document.removeEventListener('keydown', onDrawingKey, true)
  session.runtime.cancelVegetationPointPick()
  if (keep) keepLatestDrawing(session.ruleId)
  else if (draft.value) {
    draft.value.rules = draft.value.rules.filter(
      (item) => item.id !== session.ruleId,
    )
    selectedRuleId.value = draft.value.rules.some(
      (item) => item.id === session.previousRuleId,
    )
      ? session.previousRuleId
      : ''
    dirty.value =
      session.wasDirty || JSON.stringify(draft.value) !== session.baseline
  }
  message.value = keep
    ? draft.value?.speciesCatalog.length
      ? '绘制完成，调整种植参数后应用植被'
      : '绘制完成，请在“物种”页加入树模型，再应用植被'
    : '已取消绘制'
}
function cancelPointPick() {
  const session = pointPickSession.value
  pointPickSession.value = null
  session?.runtime.cancelVegetationPointPick()
  if (session) message.value = '已取消拾取'
}
function cancelInteraction() {
  finishDrawing(false)
  cancelPointPick()
  cancelImagerySelection()
}
function onImageryKey(event: KeyboardEvent) {
  if (event.key !== 'Escape') return
  event.preventDefault()
  event.stopImmediatePropagation()
  cancelImagerySelection()
}
function cancelImagerySelection() {
  const session = imagerySelection.value
  if (!session) return
  imagerySelection.value = null
  imageryOutline.value = []
  document.removeEventListener('keydown', onImageryKey, true)
  session.controller.abort()
  session.runtime.cancelVegetationPointPick()
}
async function beginImagerySelection(mode: 'plant' | 'exclude', region?: ImageryRegion) {
  const current = runtime.value
  const config = draft.value
  const layer = imageryLayer.value
  if (!current?.vegetationAvailable || !config?.layers[0] || blocked.value || busy.value || publicationBusy.value) return
  imageryError.value = ''
  cancelInteraction()
  const session = { runtime: current, controller: new AbortController(), mode, region }
  imagerySelection.value = session
  document.addEventListener('keydown', onImageryKey, true)
  try {
    const first = await current.pickVegetationPoint()
    if (imagerySelection.value !== session) return
    imageryOutline.value = [first]
    const second = await current.pickVegetationPoint()
    if (imagerySelection.value !== session) return
    const box = vegetationImageryBox(first, second)
    imageryOutline.value = box
    if (mode === 'exclude') {
      const [west, south] = box[0]!, [east, north] = box[2]!
      if (west >= east || south >= north || east - west > 180) throw new Error('请框选有效的禁种范围。')
      const exclusion: ImageryExclusion = [west, south, east, north]
      const exclusions = config.imageryExclusions ?? []
      if (exclusions.some(([w, s, e, n]) => w <= west && s <= south && e >= east && n >= north))
        throw new Error('这个范围已在影像禁种区内。')
      config.imageryExclusions = [...exclusions, exclusion]
      const clip = (item: VegetationPlantingRule) => clipImageryPlantingRule(item, exclusion, () => uid('imagery-planting'))
      const pending = new Set<string>()
      config.rules = config.rules.flatMap(item => {
        const pieces = clip(item)
        if (pendingImageryRuleIds.value.has(item.id)) pieces.forEach(piece => pending.add(piece.id))
        return pieces
      })
      replacedImageryRules = replacedImageryRules.flatMap(({ rule, index }) =>
        clip(rule).map((part, offset) => ({ rule: part, index: index + offset })))
      pendingImageryRuleIds.value = pending
      if (!config.rules.some(item => item.id === selectedRuleId.value)) selectedRuleId.value = ''
      changed()
      message.value = '已框选影像禁种区，点击「应用植被」清理框内植被。'
      return
    }
    const result = await recognizeVegetationSelection(layer, box, session.controller.signal, config.imageryExclusions)
    if (imagerySelection.value !== session || draft.value !== config || blocked.value) return
    if (imageryLayer.value !== layer) throw new Error('影像图层已切换，请重新框选。')
    const retained = session.region ? config.rules : config.rules.filter(item => !pendingImageryRuleIds.value.has(item.id))
    if (!session.region) {
      for (const { rule, index } of replacedImageryRules) retained.splice(index, 0, rule)
    }
    const [west, south] = box[0]!, [east, north] = box[2]!
    const previous = session.region?.patches[0]
    const previousRegionId = previous?.imageryRegion?.id
    const previousPatchIds = new Set(session.region?.patches.map(item => item.id))
    if (session.region && result.missing) {
      imageryError.value = '新范围的影像不完整，已保留原种植区域。'
      return
    }
    const replaces = (item: VegetationPlantingRule) => {
      if (item.kind !== 'polygon') return false
      if (session.region) {
        return previousPatchIds.has(item.id) ||
          (previousRegionId !== undefined && item.imageryRegion?.id === previousRegionId)
      }
      return result.missing === 0 && isImageryPlantingRule(item) && item.polygon.rings.length === 1 &&
        item.polygon.rings[0]!.every(([longitude, latitude]) =>
          longitude >= west && longitude <= east && latitude >= south && latitude <= north)
    }
    const replaced = retained.flatMap((rule, index) => replaces(rule) ? [{ rule, index }] : [])
    if (!result.rings.length && (session.region || !replaced.length)) {
      imageryError.value = `${result.sourceName}中未识别到植被。可换用更清晰的卫星影像，或重新框选。`
      return
    }

    const replacedIds = new Set(replaced.map(item => item.rule.id))
    const remaining = retained.filter(item => !replacedIds.has(item.id))
    const imageryRegion = {
      id: previousRegionId ?? previous?.id ?? uid('imagery-region'),
      name: session.region?.name ?? '影像种植区',
      corners: [first, second] as [VegetationGeoPosition, VegetationGeoPosition],
    }
    imageryDensity.value = previous?.densityPerHectare ?? imageryDensity.value
    const rules: VegetationPlantingRule[] = result.rings.map((ring, index) => ({
      id: uid('imagery-planting'),
      kind: 'polygon',
      name: `影像植被区 ${index + 1}`,
      enabled: previous?.enabled ?? true,
      layerId: previous?.layerId ?? config.layers[0]!.id,
      priority: previous?.priority ?? 0,
      seedOffset: (previous?.seedOffset ?? remaining.length) + index,
      speciesMix: previous ? snapshot(previous.speciesMix) : defaultMix(),
      polygon: { rings: [ring] },
      distribution: previous?.distribution ?? 'poisson',
      densityPerHectare: imageryDensity.value,
      minimumSpacingM: previous?.minimumSpacingM ?? 5,
      imageryRegion,
    }))
    if (session.region) {
      const insertionIndex = replaced[0]?.index ?? remaining.length
      config.rules = [...remaining.slice(0, insertionIndex), ...rules, ...remaining.slice(insertionIndex)]
      const pending = new Set(pendingImageryRuleIds.value)
      if (replaced.some(({ rule }) => pending.has(rule.id))) {
        for (const { rule } of replaced) pending.delete(rule.id)
        for (const rule of rules) pending.add(rule.id)
        pendingImageryRuleIds.value = pending
      } else {
        replacedImageryRules = replacedImageryRules.filter(({ rule }) => !replaces(rule))
      }
    } else {
      config.rules = [...remaining, ...rules]
      replacedImageryRules = replaced
      pendingImageryRuleIds.value = new Set(rules.map(item => item.id))
    }
    ringIndex.value = 0
    selectedRuleId.value = rules[0]?.id ?? ''
    const previewInput = imageryPreviewInput.value
    if (previewInput) {
      const { rings: _rings, ...preview } = result
      cacheImageryPreview(previewInput.key, { ...preview, replaced: replaced.length })
    }
    changed()
  } catch (error) {
    if (imagerySelection.value === session)
      imageryError.value = error instanceof Error ? error.message : '影像植被识别失败。'
  } finally {
    if (imagerySelection.value === session) cancelImagerySelection()
  }
}
function beginAltitude() {
  if (blocked.value || busy.value) return
  cancelInteraction()
  const active = addRule('altitude-zonation')
  if (active) keepLatestDrawing(active.id)
}
async function beginDrawing(kind: 'polygon' | 'corridor') {
  const current = runtime.value
  if (
    !current?.vegetationAvailable ||
    blocked.value ||
    busy.value
  )
    return
  if (drawing.value?.kind === kind) return
  cancelInteraction()
  const previousRuleId = selectedRuleId.value
  const wasDirty = dirty.value
  const baseline = JSON.stringify(draft.value)
  const active = addRule(kind)
  if (!active) return
  const session = {
    ruleId: active.id,
    previousRuleId,
    wasDirty,
    baseline,
    runtime: current,
    kind,
  }
  drawing.value = session
  message.value = ''
  document.addEventListener('keydown', onDrawingKey, true)
  try {
    while (drawing.value === session) {
      const point = await current.pickVegetationPoint()
      if (drawing.value !== session) break
      setPoints(active, [...points(active), point])
    }
  } catch (error) {
    if (drawing.value === session) {
      finishDrawing(false)
      message.value = error instanceof Error ? error.message : '绘制失败'
    }
  }
}
async function pickPoint(index?: number) {
  const active = rule.value,
    current = runtime.value,
    scope = generation
  if (!active || !current || busy.value || picking.value || drawing.value)
    return
  const session = { runtime: current }
  pointPickSession.value = session
  message.value = '请在视口地表单击，Escape 取消'
  try {
    const point = await current.pickVegetationPoint()
    if (scope === generation && pointPickSession.value === session) {
      const values = [...points(active)]
      if (index === undefined) values.push(point)
      else values[index] = point
      setPoints(active, values)
      message.value = ''
    }
  } catch (error) {
    if (scope === generation && pointPickSession.value === session)
      message.value = error instanceof Error ? error.message : '拾取失败'
  } finally {
    if (pointPickSession.value === session) pointPickSession.value = null
  }
}
function addHole() {
  if (!rule.value || rule.value.kind === 'corridor') return
  const polygon = rule.value.polygon ?? { rings: [[]] }
  polygon.rings.push([])
  rule.value.polygon = polygon
  ringIndex.value = polygon.rings.length - 1
  changed()
}
function removeHole() {
  if (!rule.value || rule.value.kind === 'corridor' || ringIndex.value === 0)
    return
  rule.value.polygon?.rings.splice(ringIndex.value, 1)
  ringIndex.value = 0
  changed()
}
watch(selectedRuleId, () => {
  ringIndex.value = 0
})
watch(selectedRegionId, (id) => {
  if (!id) regionInspectorOpen.value = false
})
watch(() => showRegionInspector.value ? selectedRegionId.value : '', () => emit('inspectorViewChange'), { flush: 'post' })

function inspectRegion(id?: string) {
  if (ruleSelectionDisabled.value) return
  const region = regions.value.find(item => item.id === id)
  if (id && !region) return
  selectedRuleId.value = region?.kind === 'imagery' ? region.patches[0]!.id : region?.id ?? ''
  regionInspectorOpen.value = !!region
  tab.value = 'regions'
  if (!region) {
    message.value = ''
    imageryError.value = ''
  }
}

if (vegetationStructure) {
  watchEffect(() => {
    vegetationStructure.draft.value = draft.value ? {
      regions: regions.value.map(({ id, name, kind }) => ({ id, name, kind })),
      selectedRegionId: selectedRegionId.value,
      selectionDisabled: ruleSelectionDisabled.value,
    } : null
  })
  watch(vegetationStructure.requestedRegionId, (id) => {
    if (id === null) return
    vegetationStructure.requestedRegionId.value = null
    inspectRegion(id)
  }, { immediate: true })
}
const selectedRegionPoints = computed(() => selectedImageryRegion.value
  ? imageryRegionOutline(selectedImageryRegion.value)
  : rule.value ? points(rule.value) : [])
async function flyToRule() {
  if (!runtime.value) return
  const values = selectedRegionPoints.value
  if (!values.length) return
  const longitude =
    values.reduce((sum, point) => sum + point[0], 0) / values.length
  const latitude =
    values.reduce((sum, point) => sum + point[1], 0) / values.length
  const height =
    values.reduce((sum, point) => sum + (point[2] ?? 0), 0) / values.length
  try {
    await runtime.value.controlCamera({
      action: 'visit',
      waypoint: {
        id: uid('view'),
        kind: 'geo',
        timeMs: 0,
        destination: [longitude, latitude - 0.001, height + 180],
        orientation: { heading: 0, pitch: -0.9, roll: 0 },
        interpolation: 'linear',
      },
    })
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '定位失败')
  }
}
async function flyToPublished() {
  const location = stats.value.location
  if (!runtime.value || !Array.isArray(location) || location.length !== 3) return
  const [longitude, latitude, height] = location as number[]
  const radius = Math.max(120, Number(stats.value.radiusM) || 300)
  try {
    await runtime.value.controlCamera({ action: 'visit', waypoint: {
      id: uid('published-view'), kind: 'geo', timeMs: 0,
      destination: [longitude!, latitude! - radius * 1.7 / 111000, height! + radius * 1.6],
      orientation: { heading: 0, pitch: -0.75, roll: 0 }, interpolation: 'linear',
    } })
  } catch (error) { message.value = error instanceof Error ? error.message : '瓦片定位失败' }
}
async function apply() {
  const current = host.value,
    config = draft.value
  if (!current || !config || blocked.value || busy.value || publicationBusy.value || imagerySelection.value) return
  if (issues.value.length) {
    message.value = issues.value[0] ?? ''
    return
  }
  const scope = generation
  busy.value = true
  applyError.value = false
  try {
    const generationInput = (value: VegetationSystemDefinition | undefined) => value && JSON.stringify({
      seed: value.seed, rules: value.rules, speciesCatalog: value.speciesCatalog,
      imageryExclusions: value.imageryExclusions,
      elevationSource: value.elevationSource, layers: value.layers.map(layer => layer.id),
    })
    if (generationInput(scene.value?.vegetation) !== generationInput(config))
      config.ruleSetVersion = String(Math.max(Number(config.ruleSetVersion) || 0,
        Number(scene.value?.vegetation?.ruleSetVersion) || 0) + 1)
    const definition = snapshot(config)
    if (runtime.value?.vegetationAvailable)
      await runtime.value.applyVegetationDraft(current.getStore().getScene(), definition)
    if (scope !== generation || current !== host.value) return
    current
      .getCommandBus()
      .execute(createUpdateVegetationSystemCommand(definition))
    pendingDrawnRuleId = undefined
    pendingImageryRuleIds.value = new Set()
    replacedImageryRules = []
    await current.getBridge().flush()
    if (scope === generation) {
      dirty.value = false
      message.value = '已应用，保存场景可持久化种植配置'
      await readState()
    }
  } catch (error) {
    if (scope === generation) {
      applyError.value = true
      message.value = error instanceof Error ? error.message : '应用失败'
    }
  } finally {
    if (scope === generation) busy.value = false
  }
}
async function applyPublicationDefinition(definition: VegetationSystemDefinition, persist: boolean) {
  const current = host.value, currentRuntime = runtime.value, scope = generation
  if (!current || blocked.value) throw new Error('植被编辑器尚未就绪')
  const next = snapshot(definition)
  if (currentRuntime?.vegetationAvailable)
    await currentRuntime.applyVegetationDraft(current.getStore().getScene(), next)
  else if (!persist) throw new Error('植被运行时尚未就绪')
  if (scope !== generation || current !== host.value) throw new Error('植被所在场景已切换')
  if (persist) {
    current.getCommandBus().execute(createUpdateVegetationSystemCommand(next))
    draft.value = next
    dirty.value = false
    await current.getBridge().flush()
  }
  await readState()
}
async function readState() {
  const current = runtime.value,
    scope = generation
  const wasAvailable = vegetationAvailable.value
  vegetationAvailable.value = current?.vegetationAvailable === true
  if (wasAvailable && !vegetationAvailable.value) {
    cancelInteraction()
    message.value = 'Unity 连接已中断或正在重连，绘制已取消；就绪后可重新选择绘制方式'
  }
  if (!current?.vegetationAvailable || polling || document.hidden) return
  polling = true
  try {
    const value = await current.controlVegetation({ action: 'get' })
    if (scope === generation) stats.value = value
  } catch {
    /* The bridge reports connection errors through the editor status bar. */
  } finally {
    polling = false
  }
}
const timer = window.setInterval(() => {
  void readState()
}, 1500)
watch(runtime, (current, previous) => {
  if (previous && current !== previous) cancelInteraction()
  vegetationAvailable.value = current?.vegetationAvailable === true
  void readState()
}, { immediate: true })
watch(
  () =>
    JSON.stringify(
      imagerySelection.value ? { imageryOutline: imageryOutline.value } : rule.value
        ? {
            points: selectedRegionPoints.value,
            kind: rule.value.kind,
            scope:
              rule.value.kind === 'altitude-zonation' ? rule.value.scope : null,
          }
        : null,
    ),
  () => {
    clearTimeout(previewTimer)
    const scope = generation
    previewTimer = setTimeout(() => {
      const current = runtime.value,
        selected = rule.value
      if (
        !current?.vegetationAvailable ||
        scope !== generation ||
        scene.value?.type !== 'gis' ||
        blocked.value
      )
        return
      const values = (imagerySelection.value ? imageryOutline.value : selectedRegionPoints.value)
        .map(point => [point[0], point[1], point[2] ?? 0])
      void current
        .controlVegetation({
          action: 'preview',
          points: values,
          closed: !!imagerySelection.value || (!!selected && selected.kind !== 'corridor'),
        })
        .catch((error) => {
          if (scope === generation)
            message.value =
              error instanceof Error ? error.message : '控制点预览失败'
        })
    }, 120)
  },
  { immediate: true },
)
onBeforeUnmount(() => {
  if (vegetationStructure) vegetationStructure.draft.value = null
  cancelInteraction()
  modelRequest++
  generation++
  stopStore()
  stopHost()
  clearInterval(timer)
  clearTimeout(previewTimer)
  if (runtime.value?.vegetationAvailable)
    void runtime.value
      .controlVegetation({ action: 'preview', points: [], closed: false })
      .catch(() => {})
})
</script>

<template>
  <section class="vegetation-panel" data-vegetation-panel>
    <div class="heading">
      <div v-if="showRegionInspector" class="region-heading">
        <strong>种植区域属性</strong>
        <span :title="selectedRegion?.name">{{ selectedRegion?.name || '未命名种植区域' }}</span>
      </div>
      <div v-else><strong>植被系统</strong><span>区域、物种与流式渲染</span></div>
      <el-tag size="small" :type="dirty ? 'warning' : 'info'">{{
        dirty ? '待应用' : '场景配置'
      }}</el-tag>
    </div>
    <el-alert
      v-if="scene?.type !== 'gis'"
      title="请切换到 GIS 场景后配置植被"
      type="info"
      :closable="false"
    />
    <el-button
      v-else-if="!draft"
      class="full"
      :disabled="blocked"
      @click="createSystem"
      >创建植被系统</el-button
    >
    <template v-else>
      <input
        ref="importInput"
        type="file"
        accept=".json,application/json"
        hidden
        @change="importFile"
      />
      <div v-if="!showRegionInspector" class="row">
        <el-button
          size="small"
          :disabled="blocked || busy || publicationBusy || picking || !!drawing || !!imagerySelection"
          @click="importInput?.click()"
          >导入规则 / 旧数据</el-button
        ><el-button size="small" @click="exportFile">导出</el-button>
      </div>
      <div v-else class="row">
        <el-button size="small" text :disabled="ruleSelectionDisabled" @click="inspectRegion()">返回植被系统</el-button>
      </div>
      <fieldset :disabled="blocked || busy || publicationBusy || !!imagerySelection">
        <template v-if="!showRegionInspector">
        <ScenePropertyRow label="场景植被"
          ><el-switch v-model="draft.enabled" @change="changed"
        /></ScenePropertyRow>
        <ScenePropertyRow label="渲染方式"
          ><el-select v-model="draft.streaming.renderMode" @change="changed"
            ><el-option label="原生实例化" value="instanced" /><el-option
              label="已有瓦片发布"
              value="published-tiles" /></el-select
        ></ScenePropertyRow>
        <ScenePropertyRow label="质量档位"
          ><el-select v-model="draft.streaming.qualityPreset" @change="changed"
            ><el-option label="高清 · 投射阴影" value="high" /><el-option
              label="均衡 · 接收阴影"
              value="balanced" /><el-option
              label="性能 · 关闭阴影"
              value="performance" /></el-select
        ></ScenePropertyRow>
        </template>
        <el-tabs v-model="tab" stretch :class="{ 'region-inspector-tabs': showRegionInspector }">
          <el-tab-pane label="种植区域" name="regions">
            <div v-if="!showRegionInspector" class="row">
              <el-button
                size="small"
                :disabled="
                  !vegetationAvailable
                "
                @click="beginDrawing('polygon')"
                :type="activeDrawingMode === 'polygon' ? 'primary' : undefined"
                :aria-pressed="activeDrawingMode === 'polygon'"
                >多边形</el-button
              ><el-button
                size="small"
                :disabled="
                  !vegetationAvailable
                "
                @click="beginDrawing('corridor')"
                :type="activeDrawingMode === 'corridor' ? 'primary' : undefined"
                :aria-pressed="activeDrawingMode === 'corridor'"
                >行道树</el-button
              ><el-button
                size="small"
                @click="beginAltitude"
                >海拔带</el-button
              ><el-button
                size="small"
                :disabled="!vegetationAvailable || !!drawing || picking"
                @click="beginImagerySelection('plant')"
                >影像种植</el-button>
              <el-button size="small" :disabled="!vegetationAvailable || !!drawing || picking"
                @click="beginImagerySelection('exclude')">框选禁种</el-button>
            </div>
      <div v-if="drawing" class="drawing-status" role="status">
        <p>
          在地表连续单击添加{{
            rule?.kind === 'corridor' ? '路径点' : '顶点'
          }}，已选 {{ rule ? points(rule).length : 0 }} 个点。Enter 完成，Escape
          取消。
        </p>
        <div class="row">
          <el-button
            size="small"
            type="primary"
            :disabled="!canFinishDrawing"
            @click="finishDrawing(true)"
            >完成绘制</el-button
          ><el-button size="small" @click="finishDrawing(false)"
            >取消绘制</el-button
          >
        </div>
      </div>
      <div v-else-if="picking" class="drawing-status" role="status">
        <p>{{ message }}</p>
        <el-button size="small" @click="cancelPointPick"
          >取消拾取</el-button
        >
      </div>
            <p v-if="!showRegionInspector && !vegetationAvailable" class="hint" role="status">Unity 尚未就绪或当前视口不支持植被绘制。连接完成后会自动启用；仍不可用时请检查连接并刷新页面。</p>
            <div v-if="imageryResult && selectedImageryRegion" class="imagery-result">
              <img :src="imageryResult.preview" :alt="imageryResult.sourceName ? '框选影像，浅绿色标出识别出的种植区域' : '种植范围示意图'" />
              <p v-if="imageryResult.sourceName" class="hint">{{ imageryResult.reconstructed ? '预览影像' : '识别来源' }} {{ imageryResult.sourceName }}</p>
              <p v-if="imageryResult.waterExcluded" class="hint">蓝色为已排除的水面。</p>
              <p v-if="imageryResult.manualExcluded" class="hint">橙色为手动框选的禁种区。</p>
              <p v-if="imageryResult.truncated" class="hint">部分零碎区域已省略。缩小框选范围可保留更多细节。</p>
              <p v-if="imageryResult.replaced" class="hint">本次替换 {{ imageryResult.replaced }} 个旧植被斑块。</p>
              <p class="hint">
                {{ imageryResult.reconstructed ? '已保存' : '识别到' }} {{ selectedImageryRegion.patches.length }} 个植被斑块，占框选{{ imageryResult.reconstructed ? '范围' : '影像' }}
                {{ (imageryResult.coverage * 100).toFixed(1) }}%。
                <span v-if="imageryResult.missing">部分瓦片无数据，已跳过。</span>
              </p>
              <p v-if="selectedImageryRegion.patches.some(patch => pendingImageryRuleIds.has(patch.id))" class="hint">
                确认浅绿色区域，选择树种后应用植被。
              </p>
            </div>
            <p v-if="imageryError" class="error" role="alert">{{ imageryError }}</p>
            <p v-if="!showRegionInspector && draft.imageryExclusions?.length" class="hint">已记录 {{ draft.imageryExclusions.length }} 处影像禁种区。</p>
            <p v-if="!showRegionInspector" class="hint">应用前保留最近一次手绘区域和最近一次影像识别结果。</p>
            <el-select
              v-if="!showRegionInspector"
              :model-value="selectedRegionId"
              @change="inspectRegion"
              :disabled="ruleSelectionDisabled"
              class="full"
              placeholder="选择种植区域"
              clearable
              ><el-option
                v-for="item in regions"
                :key="item.id"
                :value="item.id"
                :label="item.name"
            /></el-select>
            <template v-if="selectedImageryRegion">
              <ScenePropertyRow label="名称">
                <el-input :model-value="selectedImageryRegion.name" @input="renameImageryRegion" />
              </ScenePropertyRow>
              <ScenePropertyRow label="显示">
                <el-switch :model-value="imageryRegionValue('enabled')" @change="value => setImageryRegionValue('enabled', Boolean(value))" />
              </ScenePropertyRow>
              <ScenePropertyRow label="所属图层">
                <el-select :model-value="imageryRegionValue('layerId')" placeholder="多个图层" @change="value => setImageryRegionValue('layerId', value)">
                  <el-option v-for="layer in draft.layers" :key="layer.id" :value="layer.id" :label="layer.name" />
                </el-select>
              </ScenePropertyRow>
              <ScenePropertyRow label="优先级">
                <el-input-number :model-value="imageryRegionValue('priority')" :controls="false" :min="0"
                  placeholder="混合值" @change="value => setImageryRegionValue('priority', value)" />
              </ScenePropertyRow>
              <ScenePropertyRow label="密度 株/公顷">
                <el-input-number :model-value="imageryRegionValue('densityPerHectare')" :min="1" :max="100000"
                  :controls="false" placeholder="混合值" aria-label="识别区域株数 / 公顷"
                  @change="value => setImageryRegionValue('densityPerHectare', value)" />
              </ScenePropertyRow>
              <ScenePropertyRow label="最小株距 m">
                <el-input-number :model-value="imageryRegionValue('minimumSpacingM')" :min="1" :controls="false"
                  placeholder="混合值" @change="value => setImageryRegionValue('minimumSpacingM', value)" />
              </ScenePropertyRow>
              <ScenePropertyRow label="分布">
                <el-select :model-value="imageryRegionValue('distribution')" placeholder="混合值"
                  @change="value => setImageryRegionValue('distribution', value)">
                  <el-option label="自然疏密" value="poisson" />
                  <el-option label="规则网格" value="grid" />
                  <el-option label="随机" value="random" />
                </el-select>
              </ScenePropertyRow>
              <ScenePropertyRow v-for="species in draft.speciesCatalog" :key="species.id" :label="species.name">
                <el-input-number :model-value="imagerySpeciesWeight(species.id)" :min="0" :controls="false"
                  placeholder="混合值" @change="value => setImagerySpeciesWeight(species.id, value)" />
              </ScenePropertyRow>
              <div class="row">
                <el-button size="small" :disabled="!vegetationAvailable || !selectedRegionPoints.length" @click="flyToRule">定位</el-button>
                <el-button size="small" :disabled="!vegetationAvailable || ruleSelectionDisabled"
                  @click="beginImagerySelection('plant', selectedImageryRegion)">重框识别</el-button>
                <el-button size="small" type="danger" plain :disabled="ruleSelectionDisabled" @click="removeRule">删除区域</el-button>
              </div>
            </template>
            <template v-else-if="rule">
              <ScenePropertyRow label="名称"
                ><el-input v-model="rule.name" @input="changed"
              /></ScenePropertyRow>
              <ScenePropertyRow label="显示"
                ><el-switch v-model="rule.enabled" @change="changed"
              /></ScenePropertyRow>
              <ScenePropertyRow label="所属图层"
                ><el-select v-model="rule.layerId" @change="changed"
                  ><el-option
                    v-for="layer in draft.layers"
                    :key="layer.id"
                    :value="layer.id"
                    :label="layer.name" /></el-select
              ></ScenePropertyRow>
              <ScenePropertyRow label="优先级"
                ><el-input-number
                  v-model="rule.priority"
                  :controls="false"
                  @change="changed"
              /></ScenePropertyRow>
              <div class="row">
                <el-button
                  size="small"
                  :disabled="!!drawing || picking"
                  @click="flyToRule"
                  >定位</el-button
                ><el-button
                  size="small"
                  :disabled="!!drawing || picking"
                  @click="cloneRule"
                  >复制</el-button
                ><el-button
                  size="small"
                  :disabled="!!drawing || picking"
                  type="danger"
                  plain
                  @click="removeRule"
                  >删除</el-button
                >
              </div>
              <template v-if="rule.kind === 'altitude-zonation'">
                <ScenePropertyRow label="范围"
                  ><el-select v-model="rule.scope" @change="changed"
                    ><el-option
                      label="随镜头加载"
                      value="camera-view" /><el-option
                      label="指定多边形"
                      value="polygon" /></el-select
                ></ScenePropertyRow>
                <article
                  v-for="(band, index) in rule.zones"
                  :key="band.id"
                  class="species"
                >
                  <div class="row">
                    <el-input v-model="band.name" @input="changed" /><el-switch
                      v-model="band.enabled"
                      @change="changed"
                    /><el-button
                      size="small"
                      @click="
                        rule.zones.splice(index, 1);
                        changed()
                      "
                      >删除</el-button
                    >
                  </div>
                  <ScenePropertyRow label="最低海拔 m"
                    ><el-input-number
                      v-model="band.minimumAltitudeM"
                      :controls="false"
                      @change="changed"
                  /></ScenePropertyRow>
                  <ScenePropertyRow label="最高海拔 m"
                    ><el-input-number
                      v-model="band.maximumAltitudeM"
                      :controls="false"
                      @change="changed"
                  /></ScenePropertyRow>
                  <ScenePropertyRow label="最小坡度 °"
                    ><el-input-number
                      v-model="band.minimumSlopeDegrees"
                      :min="0"
                      :max="90"
                      :controls="false"
                      @change="changed"
                  /></ScenePropertyRow>
                  <ScenePropertyRow label="最大坡度 °"
                    ><el-input-number
                      v-model="band.maximumSlopeDegrees"
                      :min="0"
                      :max="90"
                      :controls="false"
                      @change="changed"
                  /></ScenePropertyRow>
                  <ScenePropertyRow label="过渡宽度 m"
                    ><el-input-number
                      v-model="band.upperTransitionWidthM"
                      :min="0"
                      :controls="false"
                      @change="changed"
                  /></ScenePropertyRow>
                  <ScenePropertyRow label="密度 株/公顷"
                    ><el-input-number
                      v-model="band.densityPerHectare"
                      :min="1"
                      :max="10000"
                      :controls="false"
                      @change="changed"
                  /></ScenePropertyRow>
                  <ScenePropertyRow label="最小株距 m"
                    ><el-input-number
                      v-model="band.minimumSpacingM"
                      :min="1"
                      :controls="false"
                      @change="changed"
                  /></ScenePropertyRow>
                  <ScenePropertyRow
                    v-for="species in draft.speciesCatalog"
                    :key="species.id"
                    :label="species.name"
                    ><el-input-number
                      :model-value="
                        band.speciesMix.find(
                          (item) => item.speciesId === species.id,
                        )?.weight ?? 0
                      "
                      :min="0"
                      :controls="false"
                      @change="
                        (value) => {
                          band.speciesMix = band.speciesMix.filter(
                            (item) => item.speciesId !== species.id,
                          )
                          if (value)
                            band.speciesMix.push({
                              speciesId: species.id,
                              weight: value,
                            })
                          changed()
                        }
                      "
                  /></ScenePropertyRow>
                </article>
                <el-button
                  size="small"
                  @click="
                    rule.zones.push(zone());
                    changed()
                  "
                  >添加海拔分带</el-button
                >
              </template>
              <template v-else>
                <ScenePropertyRow
                  v-for="species in draft.speciesCatalog"
                  :key="species.id"
                  :label="species.name"
                  ><el-input-number
                    :model-value="
                      rule.speciesMix.find(
                        (item) => item.speciesId === species.id,
                      )?.weight ?? 0
                    "
                    :min="0"
                    :controls="false"
                    @change="
                      (value) => {
                        if (!rule || rule.kind === 'altitude-zonation') return
                        rule.speciesMix = rule.speciesMix.filter(
                          (item) => item.speciesId !== species.id,
                        )
                        if (value)
                          rule.speciesMix.push({
                            speciesId: species.id,
                            weight: value,
                          })
                        changed()
                      }
                    "
                /></ScenePropertyRow>
                <template v-if="rule.kind === 'polygon'">
                  <p class="hint">{{ rule.targetCount != null ? '按株数生成：精确数量' : '按密度生成' }}。清空目标株数可切回密度模式。</p>
                  <ScenePropertyRow label="目标株数"
                    ><el-input-number
                      v-model="rule.targetCount"
                      :min="1"
                      :max="10000000"
                      :controls="false"
                      placeholder="留空按密度生成"
                      @change="value => { if (rule?.kind === 'polygon' && value == null) delete rule.targetCount; changed() }"
                  /></ScenePropertyRow>
                  <ScenePropertyRow label="密度 株/公顷"
                    ><el-input-number
                      v-model="rule.densityPerHectare"
                      :disabled="rule.targetCount != null"
                      :min="1"
                      :max="10000"
                      :controls="false"
                      @change="changed"
                  /></ScenePropertyRow>
                  <ScenePropertyRow label="最小株距 m"
                    ><el-input-number
                      v-model="rule.minimumSpacingM"
                      :min="1"
                      :controls="false"
                      @change="changed"
                  /></ScenePropertyRow>
                  <p v-if="rule.targetCount != null" class="hint">应用时校验边界、孔洞和最小株距；容量不足会提示，并保留已有植被。</p>
                  <p v-if="selectedQuantity && !dirty" class="hint">全区计划 {{ selectedQuantity.planned }} 株，当前加载 {{ selectedQuantity.resident }} 株。远处区域随相机移动加载。</p>
                  <ScenePropertyRow label="分布"
                    ><el-select v-model="rule.distribution" @change="changed"
                      ><el-option label="自然疏密" value="poisson" /><el-option
                        label="规则网格"
                        value="grid" /><el-option
                        label="随机"
                        value="random" /></el-select
                  ></ScenePropertyRow>
                </template>
                <template v-else>
                  <ScenePropertyRow label="道路侧别"
                    ><el-select v-model="rule.side" @change="changed"
                      ><el-option label="两侧" value="both" /><el-option
                        label="左侧"
                        value="left" /><el-option
                        label="右侧"
                        value="right" /></el-select
                  ></ScenePropertyRow>
                  <ScenePropertyRow label="株距 m"
                    ><el-input-number
                      v-model="rule.spacingM"
                      :min="1"
                      :controls="false"
                      @change="changed"
                  /></ScenePropertyRow>
                  <ScenePropertyRow label="侧向偏移 m"
                    ><el-input-number
                      v-model="rule.offsetM"
                      :min="0"
                      :controls="false"
                      @change="changed"
                  /></ScenePropertyRow>
                  <ScenePropertyRow label="起点留白 m"
                    ><el-input-number
                      v-model="rule.startOffsetM"
                      :min="0"
                      :controls="false"
                      @change="changed"
                  /></ScenePropertyRow>
                  <ScenePropertyRow label="终点留白 m"
                    ><el-input-number
                      v-model="rule.endOffsetM"
                      :min="0"
                      :controls="false"
                      @change="changed"
                  /></ScenePropertyRow>
                  <ScenePropertyRow label="沿路朝向"
                    ><el-switch v-model="rule.alignToPath" @change="changed"
                  /></ScenePropertyRow>
                </template>
              </template>
              <template
                v-if="
                  rule.kind !== 'altitude-zonation' || rule.scope === 'polygon'
                "
              >
                <div class="section-title">控制点 · 经度 / 纬度 / 高程</div>
                <div v-if="rule.kind !== 'corridor'" class="row">
                  <el-select v-model="ringIndex" :disabled="!!drawing || picking"
                    ><el-option
                      v-for="(_, index) in rule.polygon?.rings ?? [[]]"
                      :key="index"
                      :value="index"
                      :label="
                        index === 0 ? '外边界' : '孔洞 ' + index
                      " /></el-select
                  ><el-button size="small" :disabled="!!drawing || picking" @click="addHole">挖空</el-button
                  ><el-button
                    v-if="ringIndex > 0"
                    :disabled="!!drawing || picking"
                    size="small"
                    @click="removeHole"
                    >移除孔洞</el-button
                  >
                </div>
                <div
                  v-for="(point, index) in points(rule)"
                  :key="index"
                  class="point"
                >
                  <button
                    class="point-pick"
                    :disabled="!vegetationAvailable || !!drawing || picking"
                    :title="'重新拾取控制点 ' + (index + 1)"
                    @click="pickPoint(index)"
                  >
                    {{ index + 1 }}</button
                  ><el-input-number
                    v-model="point[0]"
                    :controls="false"
                    :precision="8"
                    @change="setPoints(rule, points(rule))"
                  /><el-input-number
                    v-model="point[1]"
                    :controls="false"
                    :precision="8"
                    @change="setPoints(rule, points(rule))"
                  /><el-input-number
                    v-model="point[2]"
                    :controls="false"
                    :precision="2"
                    @change="setPoints(rule, points(rule))"
                  /><el-button
                    text
                    size="small"
                    :disabled="!!drawing || picking"
                    @click="
                      setPoints(
                        rule,
                        points(rule).filter((_, at) => at !== index),
                      )
                    "
                    >×</el-button
                  >
                </div>
                <div class="row">
                  <el-button
                    size="small"
                    :disabled="!vegetationAvailable || !!drawing || picking"
                    @click="pickPoint()"
                    >视口拾取</el-button
                  ><el-button
                    size="small"
                    :disabled="!!drawing || picking"
                    @click="
                      setPoints(rule, [
                        ...points(rule),
                        [
                          scene?.coordinateSystem.kind === 'wgs84'
                            ? scene.coordinateSystem.defaultLongitude
                            : 0,
                          scene?.coordinateSystem.kind === 'wgs84'
                            ? scene.coordinateSystem.defaultLatitude
                            : 0,
                          0,
                        ],
                      ])
                    "
                    >手动添加</el-button
                  >
                </div>
              </template>
            </template>
            <p v-else class="hint">{{ regions.length ? '选择种植区域后查看和编辑属性。' : '选择上方绘制方式创建种植区域。' }}</p>
          </el-tab-pane>
          <el-tab-pane v-if="!showRegionInspector" label="物种" name="species">
            <p v-if="draft.streaming.renderMode === 'published-tiles'" class="hint">从资源库选择已发布的 GLB 模型，生成服务会使用该模型构建瓦片。</p>
            <p v-else class="hint">
              直接选择模型资源加入物种，无需先放入场景。WebGPU 使用当前 Unity
              已发布的模型。
            </p>
            <el-select
              v-model="modelId"
              class="full"
              placeholder="搜索并选择树模型"
              filterable
              :loading="modelsLoading"
              no-data-text="暂无可用模型，请刷新或检查资源发布"
              ><el-option
                v-for="model in models"
                :key="model.id"
                :value="model.id"
                :label="model.name"
            /></el-select>
            <el-button size="small" :disabled="!modelId" @click="addSpecies"
              >加入物种</el-button
            >
            <el-button
              size="small"
              :loading="modelsLoading"
              @click="refreshModels"
              >刷新模型</el-button
            >
            <p v-if="modelsError" class="error">{{ modelsError }}</p>
            <article
              v-for="species in draft.speciesCatalog"
              :key="species.id"
              class="species"
            >
              <div class="row">
                <el-input v-model="species.name" @input="changed" /><el-switch
                  v-model="species.enabled"
                  @change="changed"
                />
              </div>
              <ScenePropertyRow label="最小比例"
                ><el-input-number
                  v-model="species.minimumScale"
                  :min="1"
                  :max="30"
                  :controls="false"
                  @change="changed"
              /></ScenePropertyRow>
              <ScenePropertyRow label="最大比例"
                ><el-input-number
                  v-model="species.maximumScale"
                  :min="species.minimumScale"
                  :max="30"
                  :controls="false"
                  @change="changed"
              /></ScenePropertyRow>
              <el-button
                size="small"
                text
                type="danger"
                @click="removeSpecies(species.id)"
                >移除物种</el-button
              >
            </article>
          </el-tab-pane>
          <el-tab-pane v-if="!showRegionInspector" label="加载" name="streaming">
            <ScenePropertyRow label="流式加载"
              ><el-switch v-model="draft.streaming.enabled" @change="changed"
            /></ScenePropertyRow>
            <ScenePropertyRow label="显示距离 m"
              ><el-input-number
                v-model="draft.streaming.maximumDisplayDistanceM"
                :min="100"
                :max="10000"
                :controls="false"
                @change="changed"
            /></ScenePropertyRow>
            <ScenePropertyRow label="内存预算 MB"
              ><el-input-number
                v-model="draft.streaming.memoryBudgetMB"
                :min="16"
                :max="16384"
                :controls="false"
                @change="changed"
            /></ScenePropertyRow>
            <ScenePropertyRow label="地面高程"
              ><el-select
                :model-value="draft.elevationSource.kind"
                @change="
                  (value) => {
                    draft!.elevationSource =
                      value === 'constant'
                        ? {
                            kind: 'constant',
                            heightM: 0,
                            verticalDatum: 'ellipsoid',
                            heightOffsetM: 0,
                          }
                        : {
                            kind: 'scene-terrain',
                            verticalDatum: 'ellipsoid',
                            heightOffsetM: 0,
                          }
                    changed()
                  }
                "
                ><el-option
                  label="当前场景地形"
                  value="scene-terrain" /><el-option
                  label="固定椭球高"
                  value="constant" /></el-select
            ></ScenePropertyRow>
            <ScenePropertyRow
              v-if="draft.elevationSource.kind === 'constant'"
              label="椭球高 m"
              ><el-input-number
                v-model="draft.elevationSource.heightM"
                :controls="false"
                @change="changed"
            /></ScenePropertyRow>
            <ScenePropertyRow label="离地偏移 m"
              ><el-input-number
                v-model="draft.elevationSource.heightOffsetM"
                :controls="false"
                @change="changed"
            /></ScenePropertyRow>
            <ScenePropertyRow
              v-for="layer in draft.layers"
              :key="layer.id"
              :label="layer.name"
              ><el-switch v-model="layer.visible" @change="changed"
            /></ScenePropertyRow>
          </el-tab-pane>
        </el-tabs>
      </fieldset>
      <div v-if="imagerySelection" class="drawing-status" role="status">
        <p v-if="imageryOutline.length === 0">在地表单击框选范围的第一个角点。</p>
        <p v-else-if="imageryOutline.length === 1">
          {{ imagerySelection.mode === 'exclude' ? '单击对角点，排除框内的影像种植。' : '单击对角点，开始识别框内植被。' }}
        </p>
        <p v-else-if="imageryLayer">正在读取 {{ imageryLayer.name }} 并识别植被。</p>
        <p v-else>正在查找覆盖所选范围的卫星影像。</p>
        <el-button size="small" @click="cancelImagerySelection">取消影像种植</el-button>
      </div>
      <VegetationPublicationPanel
        v-if="draft.streaming.renderMode === 'published-tiles' && scene"
        v-show="!showRegionInspector"
        :key="generation"
        :scene="scene"
        :definition="draft"
        :draft-dirty="dirty"
        :preview-available="vegetationAvailable"
        :disabled="blocked || busy || picking || !!drawing || !!imagerySelection"
        :apply-definition="applyPublicationDefinition"
        @busy="publicationBusy = $event"
        @imported="value => { draft = value; resetImageryResult(); selectedRuleId = ''; changed() }"
      />
      <el-button v-if="!showRegionInspector && draft.streaming.renderMode === 'published-tiles'" size="small"
        :disabled="blocked || busy || publicationBusy || !Array.isArray(stats.location)" @click="flyToPublished">定位已发布植被</el-button>
      <div v-if="!showRegionInspector" class="status" aria-live="polite">
        <span>{{ stats.status ?? '等待播放器' }}</span
        ><span
          >驻留 {{ stats.residentInstances ?? 0 }} 株 /
          {{ stats.residentCells ?? 0 }} 区</span
        >
      </div>
      <p v-if="stats.error" class="error">{{ stats.error }}</p>
      <p v-if="!showRegionInspector && stats.visibleRequiredCells != null" class="hint">视锥分区 {{ stats.visibleReadyCells ?? 0 }} / {{ stats.visibleRequiredCells }} 已加载 · 显示距离 {{ stats.radiusM }} m</p>
      <p v-if="!showRegionInspector && stats.streamingWarning" class="error">{{ stats.streamingWarning }}</p>
      <p v-if="stats.terrainError" class="hint">{{ stats.terrainError }}</p>
      <p v-if="message" :class="applyError || issues.length ? 'error' : 'hint'">
        {{ message }}
      </p>
      <p v-if="issues.length" class="error">{{ issues[0] }}</p>
      <div class="row actions">
        <el-button
          :disabled="blocked || busy || publicationBusy || picking || !!drawing || !!imagerySelection || !dirty"
          @click="restore"
          >还原</el-button
        ><el-button
          type="primary"
          :loading="busy"
          :disabled="
            blocked || busy || publicationBusy || picking || !!drawing || !!imagerySelection || !dirty || !!issues.length
          "
          @click="apply"
          >应用植被</el-button
        >
      </div>
    </template>
  </section>
</template>

<style scoped>
.vegetation-panel {
  --el-fill-color-blank: #131c26;
  --el-fill-color-light: #253b47;
  --el-fill-color: #253b47;
  --el-bg-color: #1d2b36;
  --el-bg-color-overlay: #1d2b36;
  --el-border-color: #40505a;
  --el-border-color-light: #40505a;
  --el-text-color-primary: #dbe8ec;
  --el-text-color-regular: #c6d9df;
  --el-text-color-placeholder: #8099a4;
  --el-color-primary: #5ab2a5;
  color: #dbe8ec;
  font-size: 12px;
}
.heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 0 14px;
  border-bottom: 1px solid var(--scene-edit-line);
}
.heading strong {
  display: block;
  font-size: 14px;
  font-weight: 600;
}
.region-heading {
  min-width: 0;
  margin-right: 8px;
}
.region-heading span {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.region-inspector-tabs :deep(> .el-tabs__header) {
  display: none;
}
.heading span,
.hint {
  color: #8dabb4;
  line-height: 1.7;
}
fieldset {
  border: 0;
  margin: 12px 0;
  padding: 0;
  min-width: 0;
}
fieldset:disabled {
  opacity: 0.65;
  pointer-events: none;
}
.row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 10px 0;
}
.row .el-button + .el-button {
  margin-left: 0;
}
.vegetation-panel .row {
  flex-wrap: wrap;
}
.drawing-status {
  margin-top: 12px;
  padding: 8px 10px;
  border: 1px solid #40505a;
  color: #91cabe;
  line-height: 1.7;
}
.drawing-status p {
  margin: 0;
}
.imagery-result {
  margin: 10px 0;
  border: 1px solid var(--el-border-color);
  border-radius: 4px;
  padding: 8px;
}
.imagery-result img {
  display: block;
  width: 100%;
  max-height: 180px;
  object-fit: contain;
  background: var(--el-fill-color-blank);
}
.full {
  width: 100%;
  margin-bottom: 8px;
}
.species {
  padding: 8px 0;
  border-bottom: 1px solid var(--scene-edit-line);
}
.point {
  display: grid;
  grid-template-columns: 14px 1fr 1fr 0.8fr 18px;
  gap: 3px;
  align-items: center;
  margin: 6px 0;
}
.point :deep(.el-input-number) {
  width: 100%;
  min-width: 0;
}
.point-pick {
  border: 0;
  padding: 0;
  color: #91cabe;
  background: transparent;
  cursor: crosshair;
}
.vegetation-panel :deep(.scene-edit-property-row) {
  grid-template-columns: 88px minmax(0, 1fr);
}
.point :deep(input) {
  padding: 0 3px;
  font-size: 10px;
}
.section-title {
  margin-top: 16px;
  color: #91cabe;
}
.status {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 9px 0;
  border-top: 1px solid var(--scene-edit-line);
  color: #9cbbb9;
}
.error {
  color: #f0aa93;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.actions {
  justify-content: flex-end;
  padding: 10px 0;
  background: #1d2b36;
}
:deep(.el-input-number) {
  width: 100%;
}
:deep(.el-tabs__item) {
  font-size: 12px;
}
</style>
