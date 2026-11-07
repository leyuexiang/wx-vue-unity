<script setup lang="ts">
import { computed, getCurrentInstance, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import LayerDOM from './LayerDOM/index.vue'
import Loading from '@/components/Loading/index.vue'
import { useSceneStore, useSceneWidgetStore } from '@/stores/sceneEditStore'
import { createSceneDefinition, createViewportHost, type ViewportHost } from '@/scene-platform'
import { getStagePointerCoordinate } from '@/utils/renderScene/pointerCoordinate'
import { MITT_ON_KEY_ENUM, DRAG_MODEL_ENUM } from '@/enums'
import type { EditorCreationModel } from '@/integrations/scene/editorCreationRouter'
import { createEditorUnityObject } from '@/integrations/scene/editorUnityCreationAdapter'
import { clearEditorSceneSelection } from '@/integrations/scene/editorSceneSelectionAdapter'
import { calculateSceneStageLayout } from '@/utils/sceneStage'
import { loadEditorSceneDefinition, loadEditorSceneDefinitionIntoHost } from '@/integrations/scene/editorSceneLoadAdapter'
import { ensureEditorGisDefaultImageryLayer } from '@/integrations/scene/editorGisDefaultLayerAdapter'
import { setActiveSceneViewportHost, clearActiveSceneViewportHost } from '@/integrations/scene/editorScenePlatformHost'
import { createEditorSceneDataPollingController, type EditorSceneDataPollingController } from '@/integrations/scene/editorSceneDataPollingController'
import { createEditorSceneObjectBehaviorRuntime, type EditorSceneObjectBehaviorRuntime } from '@/integrations/scene/editorSceneObjectBehaviorRuntime'
import { createCommandBusWidgetCommandPort, createSceneApiWidgetRuntimePort,
  createSceneApiWidgetOverlayHostPort, setWidgetCommandPort, setWidgetRuntimePort,
  setWidgetOverlayHostPort, resetWidgetRuntimePorts, isWidgetPreview } from '@/integrations/scene/widgetRuntime'
import { applyEditorDim3dTemplate, type ApplyEditorDim3dTemplateInput } from '@/integrations/scene/editorDim3dTemplateApplyService'
import { releaseOriginalScenePackages, retainOriginalScenePackages } from '@/integrations/scene/twoDPackagePreservation'
import { serializeSceneDefinitionToFourPackages } from '@/integrations/scene/sceneFourPackage'
import { appLogger } from '@/utils/logger'
import { dispatchEditorHistory } from '@/integrations/scene/editorSceneUndoRedoAdapter'
import { beginEditorSceneOperation, editorSceneOperation } from '@/integrations/scene/editorSceneOperationGate'
import { UnityEditorSceneRuntime } from '@/unity-runtime/runtime/UnityEditorSceneRuntime'
import { isUnityRenderModeConfigured, unityRenderConfig, type UnityRenderMode } from '@/unity-runtime/renderMode'

/** 画布编排二维覆盖层与双端三维运行时，资源创建统一进入各自的命令链路。 */
const emit = defineEmits<{
  sceneLoadStateChange: [state: 'loading' | 'ready' | 'failed']
  /** 仅转发当前画布的异常断开，由持锁的编辑页统一解锁并关闭页签。 */
  rendererDisconnected: [message: string]
}>()
const props = defineProps<{ renderMode: UnityRenderMode | null }>()
const route = useRoute()
const widgetStore = useSceneWidgetStore()
const sceneStore = useSceneStore()
const eventBus = getCurrentInstance()?.proxy?.$eventBus
const viewport = ref<HTMLElement>()
const stage = ref<HTMLElement>()
const renderSurface = ref<HTMLElement>()
const dimensions = ref({ width: 0, height: 0 })
const loading = ref(true)
const runtimeMessage = ref('')
const runtimeWarnings = ref<string[]>([])
const loadError = ref('')
const reloadScene = () => window.location.reload()
let host: ViewportHost | null = null
let polling: EditorSceneDataPollingController | null = null
let objectBehaviorRuntime: EditorSceneObjectBehaviorRuntime | null = null
let disposed = false
let layoutFrame = 0
// 使用资源面板的完整载荷联合，避免把文件模型错误收窄成二维部件。
let drag: EditorCreationModel | null = null
let template: ApplyEditorDim3dTemplateInput | null = null
let observer: ResizeObserver | null = null
// 模板覆盖与模型创建共用操作门禁；卸载时立即释放，迟到任务不能阻塞下一编辑页。
let releaseCanvasOperation: (() => void) | null = null
const sceneId = String(route.query.id ?? '')
const layout = computed(() => calculateSceneStageLayout(dimensions.value.width, dimensions.value.height, widgetStore.getWidgetCanvasConfig()))
const stageStyle = computed(() => ({ width: `${layout.value.width}px`, height: `${layout.value.height}px`,
  left: `${layout.value.left}px`, top: `${layout.value.top}px`, transform: `scale(${layout.value.scale})`, transformOrigin: 'top left' }))

/** 尺寸与坐标更新按帧合并，分栏变化和预览容器移动共用同一条坐标换算链。 */
const refreshLayout = () => {
  if (layoutFrame || disposed) return
  layoutFrame = requestAnimationFrame(() => {
    layoutFrame = 0
    const bounds = viewport.value?.getBoundingClientRect()
    if (bounds) dimensions.value = { width: bounds.width, height: bounds.height }
    void nextTick(() => { if (stage.value && !disposed) widgetStore.setBoundingClientRect(stage.value.getBoundingClientRect()) })
  })
}
const stopSceneDataPolling = () => { polling?.dispose(); polling = null }
const restartSceneDataPolling = async () => {
  if (disposed || !host) return
  if (!polling) polling = createEditorSceneDataPollingController({
    getViewportHost: () => host,
    projectSceneObjectForRuntime: (object) =>
      objectBehaviorRuntime?.applyPreviewOverridesToSceneObject(object) ?? object,
    onSceneObjectUpdated: (object) => objectBehaviorRuntime?.observeSceneObject(object),
  })
  await polling.start()
}

/**
 * 等比画布外的留白不属于视频，无法发送引擎拾取事件，因此在前端统一清选。
 * 模板的 self 限定只处理视口自身：视频、二维覆盖层及操作控件仍使用各自的点击链路，
 * 避免模型命中后又因事件冒泡被取消；预览、加载及编辑事务期间不改变选择。
 */
const clearSelectionFromViewportBlank = (event: MouseEvent) => {
  if (event.button !== 0 || disposed || !host || loading.value || isWidgetPreview() || editorSceneOperation.value) return
  sceneStore.setCurrentObjectLayerId(null)
  sceneStore.setSelectedThreeMapObjectId(null)
  // 领域选择同时驱动结构、属性面板及引擎操控器，不能只清空旧界面编号。
  void clearEditorSceneSelection({
    store: host.getStore(),
    bridge: host.getBridge(),
    setLegacySelectedObjectId: (objectId) => sceneStore.setCurrentTransformMaterialUuid(objectId),
    clearWidgetSelection: () => widgetStore.clearCurrentWidgetSelection(),
  }).catch((error) => {
    appLogger.warn('SceneCanvas', '画布留白清选同步失败', error)
    if (!disposed) ElMessage.error('取消选择同步失败，请重试')
  })
}

/** 事件总线保留来源资源卡片载荷，三维资源不得误创建为空白二维节点。 */
const startDrag = (value: unknown) => { drag = value as EditorCreationModel; template = null }
const cancelDrag = () => { drag = null; template = null }
const startTemplateDrag = (value: unknown) => { template = value as ApplyEditorDim3dTemplateInput; drag = null }
const drop = async (event: DragEvent) => {
  event.preventDefault()
  // 创建完成前禁止再次放置，保证异步失败时仍能精确补偿刚写入的那条命令。
  if (!host || disposed || isWidgetPreview() || loading.value || editorSceneOperation.value) { cancelDrag(); return }
  const bounds = stage.value?.getBoundingClientRect()
  if (!bounds || event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) return
  const item = drag
  const templateItem = template
  let releaseOperation: (() => void) | null = null
  cancelDrag()
  try {
    if (templateItem) {
      // 未选择三维渲染方式时不能应用含三维内容的模板，避免只更新内存快照而没有运行端投影。
      // 已配置 Unity 渲染方式后统一进入模板应用服务，由服务负责类型校验、回放和失败补偿。
      if (templateItem.saveScope !== 'twoD' && !props.renderMode) {
        ElMessage.warning('含三维内容的模板需要先选择三维渲染方式')
        return
      }
      releaseOperation = beginEditorSceneOperation('template')
      releaseCanvasOperation = releaseOperation
      const confirmationMessage = templateItem.saveScope === 'twoD'
        ? '应用二维模板将按来源规则覆盖当前场景，并清空原有三维内容，是否继续？'
        : '应用模板将按来源规则覆盖当前场景，是否继续？'
      await ElMessageBox.confirm(confirmationMessage, '应用模板', { type: 'warning' })
      stopSceneDataPolling()
      const appliedScene = await applyEditorDim3dTemplate(templateItem, { host, isActive: () => !disposed })
      if (disposed) return
      // 用户明确选择整场景模板覆盖后，原三维包不再是当前编辑基线，不能在保存时恢复旧三维内容。
      retainOriginalScenePackages(sceneId, serializeSceneDefinitionToFourPackages(appliedScene))
      return
    }
    if (!item) return
    if (item.modelType !== DRAG_MODEL_ENUM.Widget) {
      if (!props.renderMode) { ElMessage.warning('请先选择三维渲染方式'); return }
      releaseOperation = beginEditorSceneOperation('createObject')
      releaseCanvasOperation = releaseOperation
      const activeHost = host
      const id = await createEditorUnityObject(item, { clientX: event.clientX, clientY: event.clientY }, {
        host: activeHost, isActive: () => !disposed && host === activeHost,
        // 舞台会按编辑区缩放居中；先还原成舞台逻辑像素，再由 Runtime 按 Unity 画布尺寸归一化。
        toRuntimeScreenPoint: (point) => renderSurface.value
          ? getStagePointerCoordinate(point.clientX, point.clientY, renderSurface.value)
          : null,
      })
      // 二维选中与三维选中互斥；必须等待模型同步完成，失败时保留用户原有二维选择。
      if (id && !disposed) {
        widgetStore.setCurrentWidgetsIds([])
        widgetStore.setCurrentWidgetGroupId(null)
        ElMessage.success('三维资源已添加至场景')
      }
      return
    }
    const id = await widgetStore.createWidget(item, { clientX: event.clientX, clientY: event.clientY })
    if (id) widgetStore.setCurrentWidgetsIds([id])
  } catch (error) {
    if (!disposed && error !== 'cancel' && error !== 'close') ElMessage.error(error instanceof Error ? error.message : '创建资源失败')
  } finally {
    releaseOperation?.()
    if (releaseCanvasOperation === releaseOperation) releaseCanvasOperation = null
    if (templateItem && templateItem.templateSceneId !== sceneId) releaseOriginalScenePackages(templateItem.templateSceneId)
    // 模板加载失败时也恢复数据调度，不能让一次失败覆盖操作永久停止已有二维请求。
    if (templateItem && !disposed) await restartSceneDataPolling()
  }
}

const replayHistory = (direction: 'undo' | 'redo') => dispatchEditorHistory(direction, {
  commandBus: host?.getCommandBus() ?? null,
  onApplied: () => eventBus?.emit(MITT_ON_KEY_ENUM.HISTORY_APPLIED, true),
  onError: (error) => ElMessage.error(error instanceof Error ? error.message : '历史回放失败，请检查场景状态'),
})

/** 文本输入不抢占快捷键；选中组件的编辑事务继续交给来源仓库记录唯一历史。 */
const handleKey = (event: KeyboardEvent) => {
  // 门禁期间不允许快捷键穿插历史，否则创建失败补偿可能撤销到用户的其他操作。
  if (isWidgetPreview() || disposed || !host || loading.value || editorSceneOperation.value) return
  const target = event.target as HTMLElement | null
  if (target?.closest('input, textarea, select, [contenteditable="true"], .monaco-editor, .el-dialog, .el-drawer')) return
  const modifier = event.ctrlKey || event.metaKey
  if (modifier && event.key.toLowerCase() === 'z') {
    event.preventDefault()
    void replayHistory(event.shiftKey ? 'redo' : 'undo')
    return
  }
  if (modifier && event.key.toLowerCase() === 'y') {
    event.preventDefault()
    void replayHistory('redo')
    return
  }
  const ids = widgetStore.currentWidgetsIds ?? []
  if ((event.key === 'Delete' || event.key === 'Backspace') && ids.length) { event.preventDefault(); widgetStore.deleteWidgets(ids) }
  if (modifier && event.key.toLowerCase() === 'd' && ids.length) { event.preventDefault(); widgetStore.duplicateWidgets(ids) }
}

onMounted(async () => {
  eventBus?.on(MITT_ON_KEY_ENUM.MODEL_DRAG_START, startDrag)
  eventBus?.on(MITT_ON_KEY_ENUM.MODEL_DRAG_CANCEL, cancelDrag)
  eventBus?.on(MITT_ON_KEY_ENUM.TEMPLATE_DRAG_START, startTemplateDrag)
  eventBus?.on(MITT_ON_KEY_ENUM.TEMPLATE_DRAG_CANCEL, cancelDrag)
  window.addEventListener('keydown', handleKey)
  observer = new ResizeObserver(refreshLayout)
  if (viewport.value) observer.observe(viewport.value)
  refreshLayout()
  emit('sceneLoadStateChange', 'loading')
  try {
    const result = await loadEditorSceneDefinition(sceneId)
    // 请求晚于卸载完成时，仓储刚保留的原始四包也必须释放。
    if (disposed || !stage.value || !renderSurface.value) { releaseOriginalScenePackages(sceneId); return }
    const isGis = route.query.sceneType === 'gis'
    let scene = result.scene ?? createSceneDefinition({ id: sceneId, name: '未命名场景', type: isGis ? 'gis' : 'local3d',
      coordinateSystem: isGis ? { kind: 'wgs84', defaultLongitude: 104.0668, defaultLatitude: 30.5728, defaultHeight: 0, terrainEnabled: false }
        : { kind: 'local', unit: 'meter', upAxis: 'Y', gridEnabled: true } })
    if (props.renderMode && scene.type === 'gis') scene = await ensureEditorGisDefaultImageryLayer(scene)
    if (disposed) return
    if (props.renderMode && !isUnityRenderModeConfigured(props.renderMode)) {
      throw new Error('所选 Unity 渲染方式尚未完成部署配置')
    }
    host = createViewportHost({
      container: renderSurface.value,
      scene,
      ...(props.renderMode ? { runtimeFactory: (definition: typeof scene) => new UnityEditorSceneRuntime(definition.type, {
        mode: props.renderMode!,
        cloudConfig: props.renderMode === 'cloud' ? {
          signalUrl: unityRenderConfig.cloud.signalUrl,
          appId: unityRenderConfig.cloud.appId,
          sceneKey: unityRenderConfig.cloud.sceneKey,
          ...(unityRenderConfig.cloud.connectionId ? { connectionId: unityRenderConfig.cloud.connectionId } : {}),
        } : undefined,
        webBootstrapUrl: props.renderMode === 'webgpu' ? unityRenderConfig.webgpu.bootstrapUrl : undefined,
        getHost: () => host,
        onStatus: (message) => { runtimeMessage.value = message },
        onWarnings: (messages) => { runtimeWarnings.value = messages },
        onDisconnected: (message) => {
          // 卸载后的迟到通知不得影响后续编辑页；先停业务轮询，再交给父组件退出。
          if (disposed) return
          stopSceneDataPolling()
          emit('rendererDisconnected', message)
        },
      }) } : {}),
    })
    await host.mount()
    if (disposed) { host.dispose(); return }
    setActiveSceneViewportHost(host)
    objectBehaviorRuntime = createEditorSceneObjectBehaviorRuntime({ getViewportHost: () => host })
    sceneStore.setSceneApi(null)
    setWidgetCommandPort(createCommandBusWidgetCommandPort(() => host?.getCommandBus()))
    // 二维部件事件与三维模型事件共用当前 Runtime，保证跨二维/三维目标的动作能抵达真实引擎。
    setWidgetRuntimePort(
      createSceneApiWidgetRuntimePort(
        () => null,
        undefined,
        () => host?.getRuntime() ?? null,
      ),
    )
    const overlay = createSceneApiWidgetOverlayHostPort(() => null, () => host?.getRuntime() ?? null)
    setWidgetOverlayHostPort({
      ...overlay,
      refreshViewportLayout: refreshLayout,
      enterPreview: async () => {
        objectBehaviorRuntime?.preparePreview()
        try {
          await overlay.enterPreview()
          await objectBehaviorRuntime?.startPreview()
        } catch (error) {
          objectBehaviorRuntime?.exitPreview()
          throw error
        }
      },
      exitPreview: () => {
        objectBehaviorRuntime?.exitPreview()
        overlay.exitPreview()
      },
    })
    await loadEditorSceneDefinitionIntoHost(sceneId, { host, preloadedResult: result, skipSceneReplace: true, isActive: () => !disposed })
    if (disposed) return
    await restartSceneDataPolling()
    if (disposed) return
    host.getCommandBus().clear()
    emit('sceneLoadStateChange', 'ready')
    refreshLayout()
  } catch (error) {
    if (disposed) return
    objectBehaviorRuntime?.dispose()
    objectBehaviorRuntime = null
    clearActiveSceneViewportHost(host)
    host?.dispose()
    host = null
    appLogger.error('SceneCanvas', '场景加载失败', error)
    loadError.value = error instanceof Error ? error.message : '场景加载失败'
    ElMessage.error(loadError.value)
    emit('sceneLoadStateChange', 'failed')
  } finally { if (!disposed) loading.value = false }
})
watch(() => [widgetStore.widgetCanvasSize, layout.value.scale], refreshLayout, { deep: true })
onBeforeUnmount(() => {
  disposed = true
  releaseCanvasOperation?.()
  releaseCanvasOperation = null
  stopSceneDataPolling()
  observer?.disconnect()
  cancelAnimationFrame(layoutFrame)
  window.removeEventListener('keydown', handleKey)
  eventBus?.off(MITT_ON_KEY_ENUM.MODEL_DRAG_START, startDrag)
  eventBus?.off(MITT_ON_KEY_ENUM.MODEL_DRAG_CANCEL, cancelDrag)
  eventBus?.off(MITT_ON_KEY_ENUM.TEMPLATE_DRAG_START, startTemplateDrag)
  eventBus?.off(MITT_ON_KEY_ENUM.TEMPLATE_DRAG_CANCEL, cancelDrag)
  resetWidgetRuntimePorts()
  objectBehaviorRuntime?.dispose()
  objectBehaviorRuntime = null
  clearActiveSceneViewportHost(host)
  host?.dispose()
  host = null
  void widgetStore.loadSavedWidgets([], [])
  releaseOriginalScenePackages(sceneId)
})
defineExpose({ stopSceneDataPolling, restartSceneDataPolling })
</script>
<template>
  <div ref="viewport" class="scene-edit-canvas-viewport" @mousedown.self="clearSelectionFromViewportBlank" @drop="drop" @dragover.prevent>
    <div id="scene-render" ref="stage" class="scene-edit-canvas-stage" :style="stageStyle">
      <div ref="renderSurface" class="scene-edit-render-surface" />
      <LayerDOM />
      <div v-if="props.renderMode && runtimeMessage && !loadError" class="scene-edit-render-status">{{ runtimeMessage }}</div>
      <div v-if="props.renderMode && runtimeWarnings.length && !loadError" class="scene-edit-render-warning" role="status">
        <div v-for="message in runtimeWarnings" :key="message">{{ message }}</div>
      </div>
      <div v-if="loadError" class="scene-edit-render-error" role="alert">
        <strong>场景未能加载</strong>
        <p>{{ loadError }}</p>
        <button type="button" @click="reloadScene">重新加载</button>
      </div>
    </div>
  </div>
  <Loading :loading="loading" :percentage="loading ? 0 : 100" />
</template>
<style scoped>
.scene-edit-canvas-viewport { position: relative; width: 100%; height: 100%; overflow: hidden; background: var(--scene-edit-canvas-bg, #17191d); }
.scene-edit-canvas-stage { position: absolute; overflow: hidden; background: #1f2937; }
.scene-edit-render-surface { position: absolute; inset: 0; }
.scene-edit-render-status { position: absolute; z-index: 2; left: 50%; bottom: 24px; transform: translateX(-50%); padding: 8px 14px; color: #fff; background: rgb(0 0 0 / 68%); border-radius: 6px; pointer-events: none; }
.scene-edit-render-warning { position: absolute; z-index: 2; top: 12px; left: 50%; transform: translateX(-50%); max-width: 80%; padding: 8px 14px; color: #ffda8a; background: rgb(48 37 15 / 92%); border: 1px solid #806126; border-radius: 6px; pointer-events: none; }
.scene-edit-render-error { position: absolute; z-index: 3; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; color: #fff; background: rgb(20 28 31 / 92%); text-align: center; }
.scene-edit-render-error p { max-width: 520px; margin: 12px 20px 20px; color: #d5e3e2; }
.scene-edit-render-error button { padding: 8px 18px; color: #fff; background: #51a195; border: 0; border-radius: 4px; cursor: pointer; }
</style>
