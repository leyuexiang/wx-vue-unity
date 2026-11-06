<template>
  <div class="scene-edit-operation">
    <div class="scene-edit-operation__group">
      <div class="scene-edit-operation__rail">
        <el-tooltip
          v-for="item in transformTypeList"
          :key="item.type"
          :content="item.label"
          placement="bottom"
          popper-class="scene-edit-popover"
        >
          <span
            :class="['scene-edit-icon-button', { 'is-active': transformType === item.type }]"
            @click="handleTransformType(item.type)"
          >
            <!-- 使用遮罩图标让按钮颜色继承父级，激活态才能复用统一的主题色。 -->
            <span
              class="scene-edit-icon-button__image"
              :style="createIconStyle(item.icon)"
              aria-hidden="true"
            ></span>
          </span>
        </el-tooltip>
      </div>
      <div class="scene-edit-operation__rail">
        <el-tooltip
          v-for="item in availableMeasureTypeList"
          :key="item.type"
          :content="item.label"
          placement="bottom"
          popper-class="scene-edit-popover"
        >
          <span
            :class="[
              'scene-edit-icon-button',
              'scene-edit-icon-button--measure',
              { 'is-active': measureDistanceType === item.type },
            ]"
            @click="handleMeasureDistanceType(item.type)"
          >
            <!-- 测量图标同样通过 currentColor 继承默认/选中颜色。 -->
            <span
              class="scene-edit-icon-button__image"
              :style="createIconStyle(item.icon)"
              aria-hidden="true"
            ></span>
          </span>
        </el-tooltip>
      </div>
    </div>

    <button v-if="editorSceneRecovery" type="button" :title="editorSceneRecovery.message"
      @click="editorSceneRecovery.retry()">重试恢复</button>
    <!-- 保存和预览已收敛到顶栏；这里仅保留设计稿定义的编辑辅助与历史操作。 -->
    <el-divider direction="vertical" />
    <div class="scene-edit-operation__group">
      <div class="scene-edit-operation__rail">
        <el-tooltip content="撤销" placement="bottom" popper-class="scene-edit-popover">
          <button
            type="button"
            aria-label="撤销"
            :disabled="isUndoDisabled"
            :class="['scene-edit-icon-button', { 'is-disabled': isUndoDisabled }]"
            @click="handleUndo"
          >
            <span
              class="scene-edit-icon-button__image"
              :style="createIconStyle(undoIcon)"
              aria-hidden="true"
            ></span>
          </button>
        </el-tooltip>
        <el-tooltip content="重做" placement="bottom" popper-class="scene-edit-popover">
          <button
            type="button"
            aria-label="重做"
            :disabled="isRedoDisabled"
            :class="['scene-edit-icon-button', { 'is-disabled': isRedoDisabled }]"
            @click="handleRedo"
          >
            <span
              class="scene-edit-icon-button__image"
              :style="createIconStyle(redoIcon)"
              aria-hidden="true"
            ></span>
          </button>
        </el-tooltip>
        <el-tooltip content="重置场景" placement="bottom" popper-class="scene-edit-popover">
          <span class="scene-edit-icon-button" @click="handleRefreshScene">
            <span
              class="scene-edit-icon-button__image"
              :style="createIconStyle(resetIcon)"
              aria-hidden="true"
            ></span>
          </span>
        </el-tooltip>
      </div>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { computed, onBeforeUnmount, onMounted, ref, watch, getCurrentInstance } from 'vue'
import undoIcon from '@/assets/images/scene-editor-tool-undo.svg'
import redoIcon from '@/assets/images/scene-editor-tool-redo.svg'
import resetIcon from '@/assets/images/scene-editor-tool-reset.svg'
import type { CommandBus, RuntimeCapabilities, SceneStore, SceneStoreEvent } from '@/scene-platform'
import { TRANSFORM_CONTROLS_ENUM, MEASURE_ENUM } from '@/enums/scenePanelEnum'
import { useSceneStore } from '@/stores/sceneEditStore'
import { ElMessage, ElMessageBox } from 'element-plus'
import { MITT_ON_KEY_ENUM } from '@/enums'
import { transformTypeList, measureTypeList } from './config'
import { useRoute } from 'vue-router'
import { appLogger } from '@/utils/logger'
import { beginEditorSceneOperation, editorSceneOperation, editorSceneRecovery } from '@/integrations/scene/editorSceneOperationGate'
import { saveActiveEditorSceneDefinition } from '@/integrations/scene/editorSceneSaveAdapter'
import {
  EditorSceneSaveError,
  submitPreparedEditorSceneSave,
  type EditorDim3dSceneSaveBookmark,
  type EditorDim3dSceneSaveContext,
} from '@/integrations/scene/editorDim3dSceneSaveService'
import { readWidgetSceneFragment } from '@/integrations/scene/widgetRuntime/widgetSceneFragment'
import type { Dim3dSceneSaveAllBody } from '@/servers/manual/dim3d/api/sceneRuntime'
import { getActiveSceneViewportHost, subscribeActiveSceneViewportHost } from '@/integrations/scene/editorScenePlatformHost'
import { UnityEditorSceneRuntime } from '@/unity-runtime/runtime/UnityEditorSceneRuntime'
import { createEditorSceneSaveStateTracker, type EditorSceneSaveCheckpoint } from '@/integrations/scene/editorSceneSaveState'
import {
  clearEditorHistory,
  getEditorUndoRedoState,
  dispatchEditorHistory,
} from '@/integrations/scene/editorSceneUndoRedoAdapter'
import {
  canUseEditorSceneMeasure,
  filterEditorSceneMeasureTools,
  getEditorSceneRuntimeCapabilities,
} from '@/integrations/scene/editorSceneToolCapabilityAdapter'

const { $eventBus } = getCurrentInstance()?.proxy || {}
const store = useSceneStore()
const route = useRoute()

const props = withDefaults(
  defineProps<{
    /** 编辑器根组件持有锁上下文；工具栏不自行读取 sessionStorage 中的敏感令牌。 */
    saveContext?: EditorDim3dSceneSaveContext | null
  }>(),
  {
    saveContext: null,
  },
)

const emit = defineEmits<{
  /** 保存成功后把服务端书签交还根组件，供下一次保存携带最新基准修订号。 */
  saveSucceeded: [bookmark: EditorDim3dSceneSaveBookmark]
  /** 同步真实请求中的状态，供顶栏禁用保存按钮；脏状态变化不会触发额外接口。 */
  saveStateChange: [saving: boolean]
  saveLockLost: []
}>()

/**
 * 将外部 SVG 作为遮罩使用，图形只保留透明度，实际颜色由按钮的 currentColor 决定。
 * 这样普通、悬停、激活和禁用状态都能沿用场景编辑器的同一套颜色变量。
 */
const createIconStyle = (icon: string) => ({
  '--scene-icon-src': `url("${icon}")`,
})

const scenePlatformCommandBus = ref<CommandBus | null>(null)
const scenePlatformHistoryRevision = ref(0)
const runtimeCapabilities = ref<RuntimeCapabilities | null>(null)
const scenePlatformStore = ref<SceneStore | null>(null)
/** GIS 与普通三维共用 Unity 的变换接口。 */
const unityGizmoRuntime = ref<UnityEditorSceneRuntime | null>(null)
const editorSceneSaveStateTracker = createEditorSceneSaveStateTracker((snapshot) => {
  sceneSaveState.value = snapshot
  emit('saveStateChange', snapshot.saving)
})
const sceneSaveState = ref(editorSceneSaveStateTracker.getSnapshot())
// 不确定回执仅保留在本会话内，下一次保存先确认这批已冻结的四包。
let pendingSaveBatch: { checkpoint: EditorSceneSaveCheckpoint; body: Readonly<Dim3dSceneSaveAllBody> } | undefined
let stopScenePlatformHostSubscription: (() => void) | null = null
let stopScenePlatformStoreSubscription: (() => void) | null = null
let stopScenePlatformHistorySubscription: (() => void) | null = null

const refreshScenePlatformHistoryRevision = () => {
  scenePlatformHistoryRevision.value += 1
}

/**
 * 场景选中态可能来自结构树、浏览器拾取或 Runtime 反写，不一定经过顶部按钮。
 * 当当前按钮停在“旋转”且新选中对象是看板时，同步退回“平移”，避免 UI 高亮与真实控件不一致。
 */
const syncTransformTypeAfterSceneStoreEvent = (event?: SceneStoreEvent) => {
  refreshScenePlatformHistoryRevision()
  if (transformType.value !== TRANSFORM_CONTROLS_ENUM.Rotate) return

  const selectedObjectId = event?.type === 'selectionChanged' ? event.objectId : undefined
  const nextType = coerceTransformTypeForCurrentSelection(transformType.value, selectedObjectId)
  if (nextType === transformType.value) return

  if (unityGizmoRuntime.value) {
    void unityGizmoRuntime.value.setGizmoMode(nextType).then(() => { transformType.value = nextType })
      .catch((error: unknown) => ElMessage.error(error instanceof Error ? error.message : 'Unity 变换模式切换失败'))
    return
  }

  const appliedType =
    store.sceneApi?.transformControlsModules?.setTransformControlsMode(nextType) ?? nextType
  transformType.value = normalizeTransformControlsMode(appliedType)
}

const subscribeScenePlatformStore = (nextStore: SceneStore | null) => {
  stopScenePlatformStoreSubscription?.()
  stopScenePlatformStoreSubscription = null
  refreshScenePlatformHistoryRevision()

  if (!nextStore) return

  /** Store订阅负责选择和变换工具，历史步数由独立历史订阅刷新。 */
  stopScenePlatformStoreSubscription = nextStore.subscribe(syncTransformTypeAfterSceneStoreEvent)
}

const subscribeScenePlatformHistory = (nextCommandBus: CommandBus | null) => {
  stopScenePlatformHistorySubscription?.()
  stopScenePlatformHistorySubscription = null
  if (!nextCommandBus) return
  stopScenePlatformHistorySubscription = nextCommandBus.subscribeHistory(
    refreshScenePlatformHistoryRevision,
  )
}

const editorHistoryState = computed(() => {
  void scenePlatformHistoryRevision.value
  return getEditorUndoRedoState({
    commandBus: scenePlatformCommandBus.value,
  })
})

const isUndoDisabled = computed(() => {
  return !editorHistoryState.value.canUndo
})
const isRedoDisabled = computed(() => {
  return !editorHistoryState.value.canRedo
})

const transformType = ref<TRANSFORM_CONTROLS_ENUM>(TRANSFORM_CONTROLS_ENUM.Translate)

/** Three TransformControls 返回字符串模式；工具栏内部统一转回项目枚举，避免响应式状态被放宽成字符串。 */
const normalizeTransformControlsMode = (mode: string): TRANSFORM_CONTROLS_ENUM => {
  if (mode === TRANSFORM_CONTROLS_ENUM.Rotate) return TRANSFORM_CONTROLS_ENUM.Rotate
  if (mode === TRANSFORM_CONTROLS_ENUM.Scale) return TRANSFORM_CONTROLS_ENUM.Scale
  return TRANSFORM_CONTROLS_ENUM.Translate
}

/**
 * 当前选中对象是三维看板时，旋转工具统一降级为平移工具。
 *
 * 看板本身由 Sprite 表达，始终面向相机；这里只在按钮点击边界读取一次 Store，
 * 不订阅每帧场景变化，避免工具栏为低频交互引入多余查询。
 */
const coerceTransformTypeForCurrentSelection = (
  type: TRANSFORM_CONTROLS_ENUM,
  selectedObjectId?: string | null,
) => {
  if (type !== TRANSFORM_CONTROLS_ENUM.Rotate) return type

  /**
   * 鼠标点击旧画布时 legacy 选中态可能先于 SceneStore 更新；结构树选择时则是 SceneStore 先更新。
   * 这里按“显式事件编号 → 旧选中态 → 平台选中态”取值，覆盖两条过渡期链路。
   */
  const objectId =
    selectedObjectId !== undefined
      ? selectedObjectId
      : store.currentTransformMaterialUuid || scenePlatformStore.value?.getSelectedObjectId()
  const sceneObject = objectId ? scenePlatformStore.value?.getObject(objectId) : null
  return sceneObject?.billboard ? TRANSFORM_CONTROLS_ENUM.Translate : type
}

const handleTransformType = async (type: TRANSFORM_CONTROLS_ENUM) => {
  // 二维宿主不具备三维操控器，入口保留但不能伪造激活状态。
  if (!runtimeCapabilities.value?.editing.gizmo) { ElMessage.info('三维变换待 Unity 云渲染接入'); return }

  const nextType = coerceTransformTypeForCurrentSelection(type)
  if (unityGizmoRuntime.value) {
    try {
      await unityGizmoRuntime.value.setGizmoMode(nextType)
      transformType.value = nextType
    } catch (error) {
      ElMessage.error(error instanceof Error ? error.message : 'Unity 变换模式切换失败')
    }
    return
  }

  /** 非 GIS 场景继续沿用现有 Three TransformControls 行为，保证原编辑器交互不受影响。 */
  const appliedType =
    store.sceneApi?.transformControlsModules?.setTransformControlsMode(nextType) ?? nextType
  transformType.value = normalizeTransformControlsMode(appliedType)
}

/**
 * 画布只负责识别 Q/W/E，工具栏负责真正切换模式。
 * 这样快捷键与鼠标按钮共用 `handleTransformType`，GIS 看板限制、当前高亮和 Three 降级逻辑不会分叉。
 */
const handleTransformModeShortcut = (mode: 'translate' | 'rotate' | 'scale') => {
  handleTransformType(mode as TRANSFORM_CONTROLS_ENUM)
}

const measureDistanceType = ref<MEASURE_ENUM | null>(null)
const availableMeasureTypeList = computed(() =>
  filterEditorSceneMeasureTools(measureTypeList, runtimeCapabilities.value),
)
watch(
  () => store.isMeasuring,
  (newVal) => {
    if (!newVal) {
      measureDistanceType.value = null
    }
  },
)
watch(availableMeasureTypeList, (nextList) => {
  if (!measureDistanceType.value) return
  if (nextList.some((item) => item.type === measureDistanceType.value)) return

  /**
   * Runtime 切换后如果测量能力不可用，需要同步清理按钮选中态和旧测量态。
   * 这里只在能力变更时触发一次，避免每次渲染都访问旧 sceneApi。
   */
  measureDistanceType.value = null
  store.sceneApi?.measureDistanceModules?.stopMeasure()
})
const handleMeasureDistanceType = (type: MEASURE_ENUM) => {
  if (!canUseEditorSceneMeasure(runtimeCapabilities.value)) return
  if (measureDistanceType.value === type) {
    measureDistanceType.value = null
    store.sceneApi?.measureDistanceModules?.stopMeasure()
    return
  }
  measureDistanceType.value = type
  store.sceneApi?.measureDistanceModules?.startMeasure(type)
}

/** 工具栏只转发意图，状态、门禁和完成时机均由统一调度入口处理。 */
const replayHistory = (direction: 'undo' | 'redo') => dispatchEditorHistory(direction, {
  commandBus: scenePlatformCommandBus.value,
  onApplied: () => $eventBus?.emit(MITT_ON_KEY_ENUM.HISTORY_APPLIED, true),
  onError: (error) => ElMessage.error(error instanceof Error ? error.message : '历史回放失败，请检查场景状态'),
})
const handleUndo = () => replayHistory('undo')
const handleRedo = () => replayHistory('redo')

const handleSaveSceneConfig = async () => {
  const host = getActiveSceneViewportHost()
  const context = props.saveContext
  if (!host || !context || sceneSaveState.value.saving || editorSceneOperation.value) return
  const release = beginEditorSceneOperation('save')
  const checkpoint = editorSceneSaveStateTracker.captureCheckpoint()
  const sameLease = () => props.saveContext?.sceneId === context.sceneId &&
    props.saveContext.lockToken === context.lockToken && props.saveContext.baseRevisionNo === context.baseRevisionNo
  if (pendingSaveBatch && (pendingSaveBatch.checkpoint.session !== checkpoint.session ||
    pendingSaveBatch.body.sceneId !== context.sceneId || pendingSaveBatch.body.lockToken !== context.lockToken ||
    pendingSaveBatch.body.baseRevisionNo !== context.baseRevisionNo)) pendingSaveBatch = undefined
  const retry = pendingSaveBatch
  const attempt = editorSceneSaveStateTracker.beginSave(retry?.checkpoint ?? checkpoint)
  // 同编号重载、新批次和锁变化都不能让迟到回执推进当前基线。
  const isCurrentSave = () => getActiveSceneViewportHost() === host &&
    editorSceneSaveStateTracker.isCurrentSave(attempt)

  try {
    let bookmark: EditorDim3dSceneSaveBookmark | undefined
    if (retry) {
      release()
      bookmark = await submitPreparedEditorSceneSave(retry.body)
    } else {
      const result = await saveActiveEditorSceneDefinition({
        sceneApi: store.sceneApi,
        saveContext: context,
        widgetSceneFragment: readWidgetSceneFragment(),
        onPrepared: (body) => {
          if (!isCurrentSave() || !sameLease()) throw new Error('保存快照所属场景或编辑锁已变化')
          pendingSaveBatch = { body, checkpoint }
          // 四包固定后等待网络无需占用编辑门禁，新操作保持未保存。
          release()
        },
      })
      bookmark = result.backendBookmark
    }
    if (!isCurrentSave()) return
    if (!sameLease() || !bookmark) throw new Error('保存回执所属场景或编辑锁已变化')
    pendingSaveBatch = undefined
    editorSceneSaveStateTracker.markSaved(attempt)
    refreshScenePlatformHistoryRevision()
    emit('saveSucceeded', bookmark)
    ElMessage.success(retry && sceneSaveState.value.dirty ? '原保存批次已确认，后续编辑仍待保存' : '场景保存成功')
  } catch (error) {
    if (!isCurrentSave()) return
    if (!(error instanceof EditorSceneSaveError && error.kind === 'uncertain' && sameLease()))
      pendingSaveBatch = undefined
    const saveFailureState = editorSceneSaveStateTracker.markFailed(error, attempt)
    if (error instanceof EditorSceneSaveError && error.kind === 'lockLost') emit('saveLockLost')
    appLogger.error('SceneOperation', '保存场景定义失败', route.query.id, saveFailureState.lastErrorMessage)
    ElMessage.error(saveFailureState.lastErrorMessage || '场景保存失败，当前改动已保留')
  } finally {
    release()
  }
}

const handleRefreshScene = () => {
  if (editorSceneOperation.value) return
  ElMessageBox.confirm('将会清空当前场景和历史记录，是否重置？', '重置', {
    confirmButtonText: '确定',
    cancelButtonText: '取消',
    type: 'warning',
  }).then(() => {
    // 重置直接重新读取服务端修订，不从空旧渲染器中生成场景。
    window.location.reload()
    clearEditorHistory({
      commandBus: scenePlatformCommandBus.value,
    })
    refreshScenePlatformHistoryRevision()
  })
}

const handlePreviewScene = () => {
  $eventBus?.emit(MITT_ON_KEY_ENUM.PREVIEW_SCENE, true)
}

// 顶部栏只代理公开方法，保存、预览仍由本组件维护原有平台与事件总线链路。
// 宿主刷新后显式标为未保存；锁令牌与后端修订仍由根组件持有。
defineExpose({
  handleSaveSceneConfig,
  handlePreviewScene,
  sceneSaveState,
  markSceneDirty: editorSceneSaveStateTracker.markDirty,
})

onMounted(() => {
  $eventBus?.on(MITT_ON_KEY_ENUM.TRANSFORM_MODE_SHORTCUT, handleTransformModeShortcut)
  stopScenePlatformHostSubscription = subscribeActiveSceneViewportHost((host) => {
    scenePlatformCommandBus.value = host?.getCommandBus() ?? null
    subscribeScenePlatformHistory(scenePlatformCommandBus.value)
    runtimeCapabilities.value = getEditorSceneRuntimeCapabilities(host)
    const runtime = host?.getRuntime() ?? null
    unityGizmoRuntime.value = runtime instanceof UnityEditorSceneRuntime ? runtime : null
    const nextStore = host?.getStore() ?? null
    scenePlatformStore.value = nextStore
    subscribeScenePlatformStore(nextStore)
    editorSceneSaveStateTracker.bindStore(nextStore, host?.getCommandBus())
  })
})

onBeforeUnmount(() => {
  $eventBus?.off(MITT_ON_KEY_ENUM.TRANSFORM_MODE_SHORTCUT, handleTransformModeShortcut)
  stopScenePlatformHostSubscription?.()
  stopScenePlatformHostSubscription = null
  stopScenePlatformStoreSubscription?.()
  stopScenePlatformStoreSubscription = null
  stopScenePlatformHistorySubscription?.()
  stopScenePlatformHistorySubscription = null
  scenePlatformCommandBus.value = null
  runtimeCapabilities.value = null
  scenePlatformStore.value = null
  unityGizmoRuntime.value = null
  editorSceneSaveStateTracker.dispose()
  pendingSaveBatch = undefined
})
</script>
