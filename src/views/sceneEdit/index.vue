<template>
  <!-- #scene 必须始终挂载；场景锁只控制编辑器外壳可见性和画布初始化，避免 Teleport 在异步加锁前找不到目标。 -->
  <div
    ref="sceneEditRootRef"
    class="scene-edit scene-edit-theme"
    :inert="editorSceneOperation === 'importJson' || editorSceneOperation === 'template' || editorSceneOperation === 'createObject'"
  >
    <!-- 模型异步创建期间停用编辑交互，防止其他历史命令打断失败补偿；门禁结束后自动恢复。 -->
    <SceneHeader
      v-model:left-panel="activeLeftPanel"
      v-model:inspector-panel="activeInspectorPanel"
      :save-disabled="sceneSaving || !!editorSceneOperation"
      :save-loading="sceneSaving"
      :save-dirty="sceneOperationRef?.sceneSaveState.dirty"
      :show-save-as-template="editorCapabilities.saveAsTemplate"
      :show-import-scene-json="editorCapabilities.importSceneJson"
      :import-disabled="
        !sceneLockReady || sceneLockLost || sceneDataLoadState !== 'ready' || isPreviewScene || saveAsTemplateVisible
      "
      @before-import="sceneCanvasRef?.stopSceneDataPolling()"
      @after-import="sceneCanvasRef?.restartSceneDataPolling()"
      @scene-imported="sceneOperationRef?.markSceneDirty()"
      @save-template="openSaveAsTemplateDialog"
      @preview="handlePreviewScene"
      @save="handleSaveSceneConfig"
      @publish="releaseScene"
      @back="handleBackToPreviousPage"
    />
    <splitpanes
      v-show="sceneLockReady && !sceneLockLost"
      class="scene-edit-shell"
      style="height: calc(100vh - var(--scene-edit-header-height))"
      @ready="handleReady"
      @resize="handleResized"
      @resized="handleResized"
    >
      <!-- 左侧默认宽度按 48px 一级工具栏加 272px 资源面板设置，分栏拖动能力保持不变。 -->
      <pane
        :min-size="leftPaneMinSizePercent"
        :size="leftPaneSizePercent"
        style="min-width: 320px !important"
      >
        <div class="scene-edit-side-pane scene-edit-side-pane--left">
          <SceneLeftPanel v-model:active-panel="activeLeftPanel" />
        </div>
      </pane>
      <pane :min-size="50" :size="centerPaneSizePercent">
        <div class="scene-edit-center-shell">
          <div class="scene-edit-center-pane">
            <!--
              Figma 节点 1:3567 将场景工具栏放在场景名称下方的中间槽位，
              其左、右边界正好与两侧面板对齐。工具栏与 #scene 共用同一个画布容器，
              因此不会再被误认为全局顶栏，也不会改变撤销、变换和测量命令的调用链。
            -->
            <SceneOperation
              ref="sceneOperationRef"
              :save-context="sceneSaveContext"
              @save-state-change="handleSceneSaveStateChange"
              @save-succeeded="handleSceneSaveSucceeded"
            />
            <div id="scene" class="scene-edit-center-pane__viewport"></div>
          </div>
        </div>
      </pane>
      <!--
        Splitpanes 的尺寸单位是百分比，因此这里由页面外壳把 300/320/400px 动态换算为百分比。
        右栏默认 320px、拖动范围 300–400px；窗口变化时保持用户最后一次拖动后的像素宽度。
      -->
      <pane
        :min-size="rightPaneMinSizePercent"
        :max-size="rightPaneMaxSizePercent"
        :size="rightPaneSizePercent"
        style="min-width: 300px !important; max-width: 400px !important"
      >
        <div class="scene-edit-side-pane scene-edit-side-pane--right">
          <SceneRightPanel v-if="splitPanesReady" v-model:inspector-panel="activeInspectorPanel" />
        </div>
      </pane>
    </splitpanes>
  </div>
  <!--
    场景顶栏的另存为入口复用模板管理已按 Figma 校准的表单。save-as 模式不会请求旧模板详情，
    确认后由场景集成服务采集当前四包快照并调用真实另存接口，不会误走旧模板编辑链路。
  -->
  <EditDialog
    v-if="editorCapabilities.saveAsTemplate"
    v-model:visible="saveAsTemplateVisible"
    mode="save-as"
    :categories="saveAsTemplateCategories"
    :save-as-handler="handleSaveAsTemplate"
    @template-type-change="handleSaveAsTemplateTypeChange"
  />
  <Teleport :to="teleportTo">
    <SceneCanvas
      ref="sceneCanvasRef"
      v-if="sceneLockReady && !sceneLockLost && splitPanesReady"
      :render-mode="renderMode"
      @scene-load-state-change="handleSceneLoadStateChange"
      @renderer-disconnected="handleRendererDisconnected"
    />
  </Teleport>
  <div id="preview" class="scene-edit-theme scene-edit-preview-layer" v-show="isPreviewScene">
    <div class="scene-edit-preview-actions">
      <div class="flex">
        <el-button
          v-if="previewFirstPersonObject?.firstPerson?.enabled"
          size="small"
          type="primary"
          @click="toggleEditorFirstPersonPreview"
        >{{ previewFirstPersonActive ? '退出第一人称' : '进入第一人称' }}</el-button>
        <span
          v-if="previewFirstPersonCollisionMessage"
          class="scene-edit-preview-collision-message"
        >{{ previewFirstPersonCollisionMessage }}</span>
        <el-button
          icon="CloseBold"
          aria-label="关闭预览"
          size="small"
          type="primary"
          @click="closePreviewScene"
        ></el-button>
        <el-button
          v-if="!isPublish"
          icon="Position"
          size="small"
          type="primary"
          @click="releaseScene"
        ></el-button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Splitpanes, Pane } from 'splitpanes'
import 'splitpanes/dist/splitpanes.css'
import SceneHeader from './SceneHeader/index.vue'
import SceneLeftPanel from './SceneLeftPanel/index.vue'
import SceneRightPanel from './SceneRightPanel/index.vue'
import SceneCanvas from './SceneCenter/SceneCanvas/index.vue'
import SceneOperation from './SceneCenter/SceneOperation/index.vue'
import EditDialog from '../resourceManage/templateManage/EditDialog.vue'
import { useSceneStore } from '@/stores/sceneEditStore'
import { useRoute, useRouter } from 'vue-router'
import { ref, onMounted, onUnmounted, getCurrentInstance, computed, nextTick } from 'vue'
import { MITT_ON_KEY_ENUM } from '@/enums'
import {
  heartbeatDim3dScene,
  createDim3dSceneClientKey,
  getDim3dSceneInfo,
  lockDim3dScene,
  publishDim3dScene,
  unlockDim3dScene,
  unlockDim3dSceneOnUnload,
} from '@/servers/manual/dim3d/api/scene'
import { getDim3dCurrentVegetationPublication } from '@/servers/manual/dim3d/api/vegetation'
import { ElMessage } from 'element-plus'
import { appLogger } from '@/utils/logger'
import { ENABLE_SCENE_LOCK } from '@/config/sceneLock'
import { getWidgetOverlayHostPort } from '@/integrations/scene/widgetRuntime'
import { getActiveSceneViewportHost } from '@/integrations/scene/editorScenePlatformHost'
import {
  FirstPersonPreviewController,
  type FirstPersonPreviewPose,
  type SceneCameraState,
  type SceneObject,
  type SceneRuntime,
} from '@/scene-platform'
import type {
  EditorDim3dSceneSaveBookmark,
  EditorDim3dSceneSaveContext,
} from '@/integrations/scene/editorDim3dSceneSaveService'
import {
  saveActiveEditorSceneAsTemplate,
  type EditorDim3dSceneTemplateForm,
} from '@/integrations/scene/editorDim3dSceneTemplateService'
import {
  createDim3dDictionaryOptions,
  getDim3dTemplateCategoryDictionary,
} from '@/servers/manual/dim3d/api/dictionary'
import { type Dim3dTemplateType } from '@/servers/manual/dim3d/api/template'
import { DEFAULT_TEMPLATE_TYPE } from '../resourceManage/templateManage/config'
import {
  assertVegetationPublicationMatches,
  readSavedVegetationPublicationIdentity,
} from '../SceneManage/vegetationPublicationValidation'
import { SCENE_PANEL_ENUM as LEFT_SCENE_PANEL_ENUM } from './enum'
import { SCENE_PANEL_ENUM as RIGHT_SCENE_PANEL_ENUM } from '@/enums/scenePanelEnum'
import { getCurrentManagementCapabilities } from '@/auth/capabilities'
import './theme.scss'
import { beginEditorSceneOperation, editorSceneOperation } from '@/integrations/scene/editorSceneOperationGate'
import { isUnityRenderMode } from '@/unity-runtime/renderMode'
import { createEditorSceneExitController } from '@/integrations/scene/editorSceneExitController'

defineOptions({ name: 'SceneEdit' })

const store = useSceneStore()
const route = useRoute()
const renderMode = computed(() => isUnityRenderMode(route.query.renderMode) ? route.query.renderMode : null)
const router = useRouter()
/**
 * 编辑器只消费能力快照，不判断消息来源、路由参数或平台字符串。
 * 租户端为 false 时同时不挂载弹窗和顶栏入口，运营端继续沿用原有另存模板能力。
 */
const editorCapabilities = getCurrentManagementCapabilities().editor
/** 只暴露数据调度生命周期，上传入口无需认识画布的具体渲染引擎。 */
const sceneCanvasRef = ref<InstanceType<typeof SceneCanvas>>()

const { $eventBus } = getCurrentInstance()?.proxy || {}

const isPreviewScene = ref(false)
const previewFirstPersonObject = ref<SceneObject | null>(null)
const previewFirstPersonActive = ref(false)
const previewFirstPersonCollisionMessage = ref('')
let previewFirstPersonRuntime: SceneRuntime | null = null
let previewFirstPersonController: FirstPersonPreviewController | null = null
let previewPreviousCamera: SceneCameraState | null = null
let previewFirstPersonFrame: number | null = null
let previewFirstPersonLastFrameTime = 0
let editorPreviewGeneration = 0

const applyEditorFirstPersonPose = (pose: FirstPersonPreviewPose) => {
  const runtime = previewFirstPersonRuntime
  const object = previewFirstPersonObject.value
  if (!runtime || !object?.firstPerson || !previewFirstPersonActive.value) return
  if (runtime.setFirstPersonPose) {
    runtime.setFirstPersonPose({
      position: pose.position,
      heading: pose.heading,
      pitch: pose.pitch,
      eyeHeight: object.firstPerson.eyeHeight,
      fov: object.firstPerson.fov,
    })
    return
  }
  const camera = runtime.getCamera()
  const { eyeHeight, fov } = object.firstPerson
  if (camera.kind === 'three' && object.transform.kind === 'local') {
    const eye: [number, number, number] = [pose.position[0], pose.position[1] + eyeHeight, pose.position[2]]
    void runtime.setCamera({
      ...camera, position: eye,
      target: [eye[0] + Math.sin(pose.heading), eye[1] + Math.sin(pose.pitch), eye[2] - Math.cos(pose.heading)],
      fov,
    })
  } else if (camera.kind === 'cesium' && object.transform.kind === 'geo') {
    runtime.setFirstPersonFov?.(fov)
    void runtime.setCamera({
      ...camera,
      destination: [pose.position[0], pose.position[1], pose.position[2] + eyeHeight],
      orientation: { heading: pose.heading, pitch: pose.pitch, roll: 0 },
    })
  }
}

const releaseEditorFirstPersonInput = () => {
  previewFirstPersonController?.pointerUp()
  for (const key of ['w', 'a', 's', 'd']) previewFirstPersonController?.keyUp(key)
}
const handleEditorFirstPersonKeyDown = (event: KeyboardEvent) => {
  if (!previewFirstPersonActive.value || event.ctrlKey || event.metaKey || event.altKey) return
  if (!['w', 'a', 's', 'd'].includes(event.key.toLowerCase())) return
  const target = event.target
  if (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  ) {
    return
  }
  event.preventDefault()
  previewFirstPersonController?.keyDown(event.key)
}
const handleEditorFirstPersonKeyUp = (event: KeyboardEvent) => previewFirstPersonController?.keyUp(event.key)
const handleEditorFirstPersonPointerDown = (event: PointerEvent) => {
  if (!previewFirstPersonActive.value || event.button !== 0) return
  if (!(event.target instanceof HTMLCanvasElement) || !event.target.closest('#preview #scene-render')) return
  event.preventDefault()
  previewFirstPersonController?.pointerDown(event.clientX, event.clientY)
}
const handleEditorFirstPersonPointerMove = (event: PointerEvent) => {
  previewFirstPersonController?.pointerMove(event.clientX, event.clientY)
}
const handleEditorFirstPersonPointerUp = () => previewFirstPersonController?.pointerUp()
const tickEditorFirstPersonPreview = (time: number) => {
  if (!previewFirstPersonController) { previewFirstPersonFrame = null; return }
  previewFirstPersonController.step((time - previewFirstPersonLastFrameTime) / 1000)
  previewFirstPersonLastFrameTime = time
  previewFirstPersonFrame = requestAnimationFrame(tickEditorFirstPersonPreview)
}
const stopEditorFirstPersonPreview = () => {
  if (previewFirstPersonFrame !== null) cancelAnimationFrame(previewFirstPersonFrame)
  previewFirstPersonFrame = null
  releaseEditorFirstPersonInput()
  previewFirstPersonController?.dispose()
  previewFirstPersonController = null
  previewFirstPersonRuntime?.setFirstPersonInputEnabled?.(false)
  previewFirstPersonRuntime?.setFirstPersonPerformanceMode?.(false)
  if (previewPreviousCamera && previewFirstPersonRuntime) {
    void previewFirstPersonRuntime.setCamera(previewPreviousCamera)
  }
  previewPreviousCamera = null
  previewFirstPersonActive.value = false
  previewFirstPersonCollisionMessage.value = ''
}
const startEditorFirstPersonPreview = () => {
  const object = previewFirstPersonObject.value
  const runtime = previewFirstPersonRuntime
  if (!object?.firstPerson?.enabled || !runtime) return
  stopEditorFirstPersonPreview()
  previewPreviousCamera = runtime.getCamera()
  previewFirstPersonActive.value = true
  runtime.setFirstPersonInputEnabled?.(true)
  runtime.setFirstPersonPerformanceMode?.(true)
  previewFirstPersonController = new FirstPersonPreviewController({
    config: object.firstPerson,
    transform: object.transform,
    isCollisionAvailable: () => runtime.isFirstPersonCollisionAvailable?.() ?? false,
    canMove: (position, movement) => runtime.canMoveFirstPerson?.({
      position, height: object.firstPerson!.height,
      radius: object.firstPerson!.collisionRadius, objectId: object.id, movement,
    }) ?? false,
    onBlocked: (reason) => {
      previewFirstPersonCollisionMessage.value =
        reason === 'unavailable' ? '碰撞查询不可用，移动已暂停' : '已碰到障碍物'
    },
    onUnblocked: () => { previewFirstPersonCollisionMessage.value = '' },
    onChange: applyEditorFirstPersonPose,
  })
  previewFirstPersonController.reset()
  previewFirstPersonLastFrameTime = performance.now()
  previewFirstPersonFrame = requestAnimationFrame(tickEditorFirstPersonPreview)
}
const toggleEditorFirstPersonPreview = () => {
  if (previewFirstPersonActive.value) stopEditorFirstPersonPreview()
  else startEditorFirstPersonPreview()
}
const teleportTo = ref('#scene')
const activeLeftPanel = ref(LEFT_SCENE_PANEL_ENUM.Resource)
const activeInspectorPanel = ref(RIGHT_SCENE_PANEL_ENUM.Base)
const sceneOperationRef = ref<InstanceType<typeof SceneOperation> | null>(null)
const sceneEditRootRef = ref<HTMLElement | null>(null)
let leftPaneResizeObserver: ResizeObserver | undefined
let rightPaneResizeObserver: ResizeObserver | undefined
let shellResizeObserver: ResizeObserver | undefined
let layoutSyncFrame: number | undefined
let rightPaneConstraintFrame: number | undefined

/**
 * 场景锁服务端 TTL 为 20 分钟；编辑器统一每 10 分钟续期一次，给网络抖动预留一半 TTL 缓冲。
 * 定时器只在编辑器根组件创建，因此 GIS 与本地三维不会重复注册心跳请求。
 */
const SCENE_LOCK_HEARTBEAT_INTERVAL = 10 * 60 * 1000
let sceneLockHeartbeatTimer: ReturnType<typeof setInterval> | undefined
let sceneLockHeartbeatInFlight = false
let sceneLockHeartbeatCompletion: Promise<void> | undefined
const sceneLockLost = ref(false)
let sceneLockReleaseSent = false
/** 当前页签实际持有的锁快照；退出和卸载阶段优先使用它，不依赖路由或存储仍然可读。 */
let activeSceneLock:
  | { sceneId: string; clientKey: string; lockToken: string }
  | undefined
/** 只有锁确认可用后才挂载编辑器内容，避免刷新重加锁期间出现可编辑闪烁。 */
const sceneLockReady = ref(false)
/** 后端当前编辑修订未恢复成功前禁止保存，避免把初始化空场景覆盖到服务端。 */
const sceneDataLoadState = ref<'loading' | 'ready' | 'failed'>('loading')
/** 当前编辑数据的后端基准修订；保存成功后更新，供下一次 saveAll 做并发校验。 */
const sceneBaseRevisionNo = ref<number | undefined>()
/** 最近一次真实保存书签只保留在当前页内存，不写入浏览器本地场景数据。 */
const latestSceneSaveBookmark = ref<EditorDim3dSceneSaveBookmark | null>(null)
/** 保存请求发出到完成期间保持 true，顶栏据此禁用按钮，防止连续点击重复请求。 */
const sceneSaving = ref(false)
/** 另存为仅控制对话框可见性，表单状态和上传任务均由复用弹窗在关闭时释放。 */
const saveAsTemplateVisible = ref(false)
/** 另存弹窗的分类来自当前模板类型专属字典，提交时只传该字典的 dictValue。 */
const saveAsTemplateCategories = ref<Array<{ value: string; label: string }>>([])
const saveAsTemplateType = ref<Dim3dTemplateType>(DEFAULT_TEMPLATE_TYPE)
const saveAsTemplateCategoryCache = new Map<
  Dim3dTemplateType,
  Array<{ value: string; label: string }>
>()
const saveAsTemplateCategoryRequests = new Map<Dim3dTemplateType, Promise<void>>()
const SCENE_LOCK_STORAGE_PREFIX = 'scene-edit-lock-token:'

const getRouteQueryString = (value: unknown) => {
  const candidate = Array.isArray(value) ? value[0] : value
  return typeof candidate === 'string' ? candidate.trim() : ''
}

/** 从同源会话存储读取锁令牌；令牌不再通过路由查询参数传播，避免进入历史记录和访问日志。 */
const getSceneLockStorageKey = (sceneId: string, clientKey: string) =>
  `${SCENE_LOCK_STORAGE_PREFIX}${sceneId}:${clientKey}`

const getSceneLockHandoffKey = (sceneId: string, clientKey: string) =>
  `scene-edit-lock-handoff:${sceneId}:${clientKey}`

/** 管理页在新页签创建后写入的一次性锁令牌；新页签消费后立即删除，避免复制页复用。 */
const getSceneLockHandoffTokenKey = (sceneId: string, clientKey: string) =>
  `scene-edit-lock-handoff-token:${sceneId}:${clientKey}`

const getStoredSceneLockToken = (sceneId: string, clientKey: string) => {
  if (typeof sessionStorage === 'undefined') return ''
  try {
    return sessionStorage.getItem(getSceneLockStorageKey(sceneId, clientKey))?.trim() || ''
  } catch {
    return ''
  }
}

/** 从跨页签存储接管管理页已申请的令牌，并转存到当前页签会话存储。 */
const consumeSceneLockHandoffToken = (sceneId: string, clientKey: string) => {
  if (typeof localStorage === 'undefined') return ''
  try {
    const key = getSceneLockHandoffTokenKey(sceneId, clientKey)
    const token = localStorage.getItem(key)?.trim() || ''
    if (token) localStorage.removeItem(key)
    if (token) storeSceneLockToken(sceneId, clientKey, token)
    return token
  } catch {
    return ''
  }
}

/**
 * 由根组件集中生成保存上下文。
 *
 * SceneOperation 只接收当前有效令牌和修订号，不直接接触路由或会话存储；锁未就绪、已失效、
 * 场景编号非法或令牌缺失时返回 null，保存服务会拒绝发起请求。
 */
const sceneSaveContext = computed<EditorDim3dSceneSaveContext | null>(() => {
  if (
    !ENABLE_SCENE_LOCK ||
    !sceneLockReady.value ||
    sceneLockLost.value ||
    sceneDataLoadState.value !== 'ready'
  ) {
    return null
  }
  const sceneId = getRouteQueryString(route.query.id)
  const clientKey = getRouteQueryString(route.query.clientKey)
  const lockToken = getStoredSceneLockToken(sceneId, clientKey)
  if (!sceneId || !lockToken) return null
  return {
    sceneId,
    lockToken,
    ...(sceneBaseRevisionNo.value === undefined
      ? {}
      : { baseRevisionNo: sceneBaseRevisionNo.value }),
  }
})

/** 保存成功后推进后端基准修订；页面内存书签不作为跨刷新缓存。 */
const handleSceneSaveSucceeded = (bookmark: EditorDim3dSceneSaveBookmark) => {
  latestSceneSaveBookmark.value = bookmark
  if (bookmark.revisionNo !== undefined) {
    sceneBaseRevisionNo.value = bookmark.revisionNo
  }
}

/** 保存状态由唯一的 SceneOperation 上报，根组件只负责顶栏交互锁定。 */
const handleSceneSaveStateChange = (saving: boolean) => {
  sceneSaving.value = saving
}

/** 画布只上报加载结论；根组件统一决定顶部保存、预览和发布是否可用。 */
const handleSceneLoadStateChange = (state: 'loading' | 'ready' | 'failed') => {
  sceneDataLoadState.value = state
  if (state === 'failed') {
    ElMessage.error('场景数据加载失败，已禁止保存，请重新进入编辑器后重试')
  }
}

/** 仅清理仍属于当前编辑页的令牌，避免异步卸载误删后续会话写入的新令牌。 */
const clearStoredSceneLockToken = (sceneId: string, clientKey: string, lockToken: string) => {
  if (typeof sessionStorage === 'undefined') return
  try {
    const key = getSceneLockStorageKey(sceneId, clientKey)
    if (sessionStorage.getItem(key) === lockToken) sessionStorage.removeItem(key)
  } catch {
    // 会话存储不可用时不影响解锁请求本身。
  }
}

/** 写入当前页签内存锁快照，确保路由切换或存储清理后仍能准确解锁原锁。 */
const setActiveSceneLock = (sceneId: string, clientKey: string, lockToken: string) => {
  activeSceneLock = { sceneId, clientKey, lockToken }
}

/** 保存新申请的令牌，确保刷新后重新加锁和后续心跳使用同一凭证。 */
const storeSceneLockToken = (sceneId: string, clientKey: string, lockToken: string) => {
  if (typeof sessionStorage === 'undefined') return false
  try {
    sessionStorage.setItem(getSceneLockStorageKey(sceneId, clientKey), lockToken)
    return true
  } catch {
    return false
  }
}

/** 读取并消费跨页签共享的一次性锁接管标记；复制页签无法再次消费已删除的标记。 */
const consumeSceneLockHandoff = (sceneId: string, clientKey: string) => {
  if (typeof localStorage === 'undefined') return false
  try {
    const key = getSceneLockHandoffKey(sceneId, clientKey)
    const handedOff = localStorage.getItem(key) === '1'
    if (handedOff) localStorage.removeItem(key)
    return handedOff
  } catch {
    return false
  }
}

/**
 * 续期当前编辑器持有的场景锁。
 * 通过 inFlight 标记合并慢请求，防止网络延迟时多个心跳并发刷新同一把锁。
 */
const refreshSceneLock = async () => {
  if (!ENABLE_SCENE_LOCK) return
  const sceneId = activeSceneLock?.sceneId || getRouteQueryString(route.query.id)
  const clientKey = activeSceneLock?.clientKey || getRouteQueryString(route.query.clientKey)
  const lockToken = activeSceneLock?.lockToken || getStoredSceneLockToken(sceneId, clientKey)
  if (!sceneId || !lockToken || sceneLockLost.value || sceneLockHeartbeatInFlight) return

  sceneLockHeartbeatInFlight = true
  const completion = (async () => {
    try {
      const response = await heartbeatDim3dScene(sceneId, { lockToken })
      if (response.data?.locked === true) {
        sceneLockLost.value = true
        // 令牌已失效，立即清理会话存储，防止同一标签页重新进入时跳过重新加锁。
        clearStoredSceneLockToken(sceneId, clientKey, lockToken)
        if (sceneLockHeartbeatTimer !== undefined) {
          clearInterval(sceneLockHeartbeatTimer)
          sceneLockHeartbeatTimer = undefined
        }
        activeSceneLock = undefined
        ElMessage.warning('当前场景编辑锁已失效，请重新进入编辑器')
        return
      }
      if (response.data?.locked !== false) {
        appLogger.warn('SceneEdit', '场景心跳返回未知锁状态', sceneId, response)
      }
    } catch (error) {
      // 单次网络失败不立即判定失锁，保留定时器等待下一周期重试，避免短暂抖动中断编辑。
      appLogger.warn('SceneEdit', '场景编辑锁心跳续期失败，将在下一周期重试', sceneId, error)
    } finally {
      sceneLockHeartbeatInFlight = false
    }
  })()
  sceneLockHeartbeatCompletion = completion
  try {
    await completion
  } finally {
    if (sceneLockHeartbeatCompletion === completion) {
      sceneLockHeartbeatCompletion = undefined
    }
  }
}

/** 在编辑器根组件挂载时启动唯一心跳定时器；无令牌的历史直达链接不发起伪造请求。 */
const startSceneLockHeartbeat = () => {
  if (!ENABLE_SCENE_LOCK) return
  const sceneId = activeSceneLock?.sceneId || getRouteQueryString(route.query.id)
  const clientKey = activeSceneLock?.clientKey || getRouteQueryString(route.query.clientKey)
  const lockToken = activeSceneLock?.lockToken || getStoredSceneLockToken(sceneId, clientKey)
  if (!sceneId || !lockToken || sceneLockHeartbeatTimer !== undefined) return
  sceneLockLost.value = false
  // 首次挂载立即刷新一次状态，之后再按固定周期续期，避免初始 10 分钟内状态无更新。
  void refreshSceneLock()
  sceneLockHeartbeatTimer = setInterval(() => {
    void refreshSceneLock()
  }, SCENE_LOCK_HEARTBEAT_INTERVAL)
}

/** 停止心跳并释放当前用户持有的锁，确保关闭标签页后不会残留占用状态。 */
const stopSceneLockHeartbeat = async () => {
  if (!ENABLE_SCENE_LOCK) return
  if (sceneLockHeartbeatTimer !== undefined) {
    clearInterval(sceneLockHeartbeatTimer)
    sceneLockHeartbeatTimer = undefined
  }
  const sceneId = activeSceneLock?.sceneId || getRouteQueryString(route.query.id)
  const clientKey = activeSceneLock?.clientKey || getRouteQueryString(route.query.clientKey)
  const lockToken = activeSceneLock?.lockToken || getStoredSceneLockToken(sceneId, clientKey)
  if (!sceneId || !lockToken || sceneLockReleaseSent) return
  if (sceneLockLost.value) {
    clearStoredSceneLockToken(sceneId, clientKey, lockToken)
    activeSceneLock = undefined
    return
  }
  sceneLockReleaseSent = true
  // 等待正在进行的心跳结束后再解锁，避免两个请求乱序导致解锁后又被心跳重新续期。
  await sceneLockHeartbeatCompletion?.catch(() => undefined)
  try {
    await unlockDim3dScene(sceneId, clientKey)
  } catch (error) {
    appLogger.warn('SceneEdit', '退出编辑时释放场景锁失败', sceneId, error)
    // 普通解锁请求失败后再用页面保活请求兜底，沿用原页签身份，避免立即关页中止重试。
    unlockDim3dSceneOnUnload(sceneId, clientKey)
  } finally {
    clearStoredSceneLockToken(sceneId, clientKey, lockToken)
    activeSceneLock = undefined
  }
}

/**
 * 浏览器关闭、页签关闭或刷新时的同步兜底解锁。
 * pagehide 覆盖移动端和页签销毁，beforeunload 覆盖桌面浏览器关闭/刷新；使用标记避免重复解锁。
 */
const releaseSceneLockBeforeUnload = (event?: Event) => {
  if (!ENABLE_SCENE_LOCK) return
  if (event && 'persisted' in event && Boolean((event as PageTransitionEvent).persisted)) return
  const sceneId = activeSceneLock?.sceneId || getRouteQueryString(route.query.id)
  const clientKey = activeSceneLock?.clientKey || getRouteQueryString(route.query.clientKey)
  const lockToken = activeSceneLock?.lockToken || getStoredSceneLockToken(sceneId, clientKey)
  if (!sceneId || !lockToken || sceneLockLost.value || sceneLockReleaseSent) return
  sceneLockReleaseSent = true
  if (sceneLockHeartbeatTimer !== undefined) {
    clearInterval(sceneLockHeartbeatTimer)
    sceneLockHeartbeatTimer = undefined
  }
  unlockDim3dSceneOnUnload(sceneId, clientKey)
  clearStoredSceneLockToken(sceneId, clientKey, lockToken)
  activeSceneLock = undefined
}

/** 判断当前页面是否由刷新或历史回退恢复；这两类入口不能继续复用已被卸载页释放的旧令牌。 */
const shouldReacquireSceneLock = () => {
  if (typeof performance === 'undefined') return false
  const navigation = performance.getEntriesByType('navigation')[0] as
    | PerformanceNavigationTiming
    | undefined
  return navigation?.type === 'reload' || navigation?.type === 'back_forward'
}

/**
 * 刷新编辑器后重新申请场景锁，并把新令牌写回会话存储。
 * 首次从场景卡片进入时沿用卡片预先申请的令牌，避免同一次进入流程重复加锁。
 */
const ensureSceneLockForEditor = async () => {
  const sceneId = getRouteQueryString(route.query.id)
  if (!sceneId) return false
  if (!ENABLE_SCENE_LOCK) return true
  const routeClientKey = getRouteQueryString(route.query.clientKey)
  // 先读取交接令牌，再判断是否为复制页。内嵌管理页的 opener 路径和 localStorage 标记可能不同步，
  // 但令牌本身是当前页唯一的锁凭证；只要能消费到它，就必须沿用管理页已申请的锁。
  const initialHandoffToken = routeClientKey
    ? consumeSceneLockHandoffToken(sceneId, routeClientKey)
    : ''
  // 管理页首次打开会写入一次性接管标记。不能依赖 opener 的 pathname：管理页可能嵌在
  // XrCenter 外壳中，编辑器看到的 opener 路径并不一定是 /sceneManage；复制页则没有该标记。
  const hasInitialHandoff = routeClientKey
    ? consumeSceneLockHandoff(sceneId, routeClientKey)
    : false
  const hasInitialLockCredential = Boolean(initialHandoffToken)
  const needsReacquire = shouldReacquireSceneLock()
  let clientKey = routeClientKey || createDim3dSceneClientKey()

  /**
   * 刷新时先释放旧页锁，再为新页生成独立 clientKey。
   * 旧页卸载请求即使延迟到达，也只会命中旧 clientKey，不会误释放新页锁。
   */
  if (routeClientKey && needsReacquire) {
    sceneLockReleaseSent = true
    const previousToken = getStoredSceneLockToken(sceneId, routeClientKey)
    try {
      await unlockDim3dScene(sceneId, routeClientKey)
    } catch (error) {
      appLogger.warn(
        'SceneEdit',
        '刷新前释放旧场景锁失败，将由重新加锁结果决定是否进入',
        sceneId,
        error,
      )
    }
    if (previousToken) clearStoredSceneLockToken(sceneId, routeClientKey, previousToken)
    clientKey = createDim3dSceneClientKey()
  }

  // 复制页签会复制 sessionStorage 中的旧令牌，但不会从编辑页 opener 获得一次性接管凭据。
  // 为复制页生成独立 clientKey，禁止它继续使用原页令牌；原页仍保留旧锁并继续编辑。
  if (routeClientKey && !needsReacquire && !hasInitialHandoff && !hasInitialLockCredential) {
    // 复制页签关闭前不得按继承来的旧 clientKey 解锁原页的锁。
    sceneLockReleaseSent = true
    clientKey = createDim3dSceneClientKey()
  }

  if (!routeClientKey || clientKey !== routeClientKey) {
    await router.replace({
      query: {
        ...route.query,
        clientKey,
      },
    })
  }
  const storedToken = getStoredSceneLockToken(sceneId, clientKey)
  // 新页签的 sessionStorage 不会包含 window.open 之后才写入的令牌，先消费跨页签交接凭证。
  const handedOffToken =
    storedToken || initialHandoffToken || consumeSceneLockHandoffToken(sceneId, clientKey)
  if (handedOffToken && !needsReacquire) {
    setActiveSceneLock(sceneId, clientKey, handedOffToken)
    return true
  }

  // 本次将重新申请锁，禁止失败卸载时误释放刷新前可能已失效的旧锁。
  sceneLockReleaseSent = true

  try {
    const response = await lockDim3dScene(sceneId, clientKey)
    const lock = response.data
    if (lock?.locked !== false || !lock.lockToken?.trim()) {
      ElMessage.warning(
        lock?.locked === true
          ? '当前场景已被其他用户占用，暂不能进入编辑器'
          : '场景锁状态异常，暂不能进入编辑器',
      )
      return false
    }
    sceneBaseRevisionNo.value = Number.isInteger(lock.baseRevisionNo)
      ? lock.baseRevisionNo
      : undefined
    latestSceneSaveBookmark.value = null
    if (!storeSceneLockToken(sceneId, clientKey, lock.lockToken.trim())) {
      // 刷新重加锁后若本地凭证无法写入，立即回滚服务端锁，避免页面跳回管理页后遗留占用。
      void unlockDim3dScene(sceneId, clientKey).catch(() => undefined)
      ElMessage.error('当前浏览器无法保存场景锁状态，暂不能进入编辑器')
      return false
    }
    setActiveSceneLock(sceneId, clientKey, lock.lockToken.trim())
    // 仅替换锁令牌，不改变场景编号、类型和名称，保持当前编辑器路由上下文完整。
    await router.replace({
      query: {
        ...route.query,
      },
    })
    sceneLockReleaseSent = false
    return true
  } catch (error) {
    appLogger.warn('SceneEdit', '刷新后重新申请场景锁失败', sceneId, error)
    ElMessage.error('场景重新加锁失败，请返回场景列表后重试')
    return false
  }
}

/** 设计规范规定的右侧属性面板像素范围。 */
const RIGHT_PANEL_WIDTH = Object.freeze({
  default: 320,
  min: 300,
  max: 400,
})
const CENTER_MIN_SIZE_PERCENT = 50

/** Splitpanes 模板声明与运行时负载存在版本差异，这里只描述布局换算真正需要的尺寸字段。 */
type SplitPaneSize = {
  min?: number
  max?: number
  size: number
}

type SplitpanesLayoutPayload = {
  panes: SplitPaneSize[]
}

type SplitpanesLayoutEvent = SplitPaneSize[] | SplitpanesLayoutPayload

/** 设计规范规定左侧工具栏 48px 加资源面板 272px，默认总宽度固定为 320px。 */
const LEFT_PANEL_WIDTH = Object.freeze({
  default: 320,
  min: 320,
})
const FALLBACK_SHELL_WIDTH = 1920
const initialShellWidth =
  typeof window === 'undefined' ? FALLBACK_SHELL_WIDTH : Math.max(window.innerWidth, 1)

/** 将像素尺寸换算为 Splitpanes 使用的百分比，避免把像素值误当成百分比传入。 */
const pixelsToPercent = (pixels: number, containerWidth: number) =>
  (pixels / Math.max(containerWidth, 1)) * 100

const initialLeftPaneSizePercent = pixelsToPercent(LEFT_PANEL_WIDTH.default, initialShellWidth)
const leftPaneSizePercent = ref(initialLeftPaneSizePercent)
const leftPaneMinSizePercent = ref(pixelsToPercent(LEFT_PANEL_WIDTH.min, initialShellWidth))
const rightPaneSizePercent = ref(pixelsToPercent(RIGHT_PANEL_WIDTH.default, initialShellWidth))
const rightPaneMinSizePercent = ref(pixelsToPercent(RIGHT_PANEL_WIDTH.min, initialShellWidth))
const rightPaneMaxSizePercent = ref(pixelsToPercent(RIGHT_PANEL_WIDTH.max, initialShellWidth))
const centerPaneSizePercent = ref(100 - leftPaneSizePercent.value - rightPaneSizePercent.value)
let currentLeftPaneWidth: number = LEFT_PANEL_WIDTH.default
let currentRightPaneWidth: number = RIGHT_PANEL_WIDTH.default

// 当前选中的模型uuid
const currentTransformMaterialUuid = computed(() => {
  return store.currentTransformMaterialUuid
})
const isPublish = computed(() => {
  return store.sceneIsPublish
})
// 监听预览场景
onMounted(async () => {
  window.addEventListener('keydown', handleEditorFirstPersonKeyDown)
  window.addEventListener('keyup', handleEditorFirstPersonKeyUp)
  window.addEventListener('blur', releaseEditorFirstPersonInput)
  window.addEventListener('pointerdown', handleEditorFirstPersonPointerDown)
  window.addEventListener('pointermove', handleEditorFirstPersonPointerMove)
  window.addEventListener('pointerup', handleEditorFirstPersonPointerUp)
  window.addEventListener('pointercancel', handleEditorFirstPersonPointerUp)
  document.body.classList.add('scene-edit-route-open')
  if (ENABLE_SCENE_LOCK) {
    window.addEventListener('beforeunload', releaseSceneLockBeforeUnload)
    window.addEventListener('pagehide', releaseSceneLockBeforeUnload)
  }
  // 根编辑器同时覆盖 GIS 和本地三维运行时；重新加锁完成后才启动心跳，避免旧令牌进入续期链路。
  const lockReady = await ensureSceneLockForEditor()
  if (!lockReady) {
    window.removeEventListener('beforeunload', releaseSceneLockBeforeUnload)
    window.removeEventListener('pagehide', releaseSceneLockBeforeUnload)
    // 新页签进入时若锁校验失败（尤其是确实被占用），关闭当前编辑页，避免把用户误导回管理页。
    // 仅当浏览器禁止脚本关闭时才回退导航，确保当前页仍有可用出口。
    window.close()
    if (!window.closed) await router.replace({ name: 'sceneManage' })
    return
  }
  sceneLockReady.value = true
  startSceneLockHeartbeat()
  nextTick(() => {
    syncShellNavWidths()

    const leftPaneElement = getLeftPaneElement()
    const rightPaneElement = getRightPaneElement()
    if (typeof ResizeObserver !== 'undefined') {
      if (leftPaneElement) {
        leftPaneResizeObserver = new ResizeObserver(syncLeftCardNavWidth)
        leftPaneResizeObserver.observe(leftPaneElement)
      }
      if (rightPaneElement) {
        rightPaneResizeObserver = new ResizeObserver(syncRightCardNavWidth)
        rightPaneResizeObserver.observe(rightPaneElement)
      }
      const shellElement = getSceneShellElement()
      if (shellElement) {
        /**
         * 只观察编辑器外壳本身；拖动分隔线不会改变外壳宽度，因此不会形成观察器回调循环。
         * 浏览器窗口或宿主容器变化时重新换算百分比，保持右栏真实像素宽度不漂移。
         */
        shellResizeObserver = new ResizeObserver(scheduleRightPaneConstraintSync)
        shellResizeObserver.observe(shellElement)
      }
    }
    /**
     * 部分嵌入式浏览器在缩放视口时不会及时派发外壳的 ResizeObserver 回调。
     * 额外监听窗口尺寸变化，并在下一帧读取真实宽度，确保 300–400px 的硬性范围始终生效。
     */
    window.addEventListener('resize', scheduleRightPaneConstraintSync, { passive: true })
  })

  $eventBus?.on(MITT_ON_KEY_ENUM.PREVIEW_SCENE, (value) => {
    if (!value) return
    const generation = ++editorPreviewGeneration
    stopEditorFirstPersonPreview()
    const host = getActiveSceneViewportHost()
    previewFirstPersonRuntime = host?.getRuntime() ?? null
    previewFirstPersonObject.value = null // 二维阶段不开放三维第一人称预览
    isPreviewScene.value = value
    teleportTo.value = '#preview'
    /**
     * 预览切换只通过二维叠加宿主端口协调。
     * 当前端口仍包旧 sceneApi，后续替换三维运行时时编辑页不需要跟着改。
     */
    void Promise.resolve().then(() => {
      if (generation !== editorPreviewGeneration || !isPreviewScene.value) return
      const entering = getWidgetOverlayHostPort().enterPreview()
      if (generation === editorPreviewGeneration && isPreviewScene.value) startEditorFirstPersonPreview()
      return entering
    }).catch((error) => {
      if (generation !== editorPreviewGeneration) return
      appLogger.error('SceneEdit', '进入场景预览失败', error)
      ElMessage.error('进入场景预览失败')
      closePreviewScene()
    })
  })
})

// 分割面板是否准备好
const splitPanesReady = ref(false)

const timeOut = ref<ReturnType<typeof setTimeout>>()
const handleReady = (payload?: SplitpanesLayoutEvent) => {
  const panes = resolveSplitpanesEventPanes(payload)
  if (panes) syncCurrentPaneSizes(panes)
  timeOut.value = setTimeout(() => {
    splitPanesReady.value = true
    nextTick(() => {
      syncRightPanePercentageConstraints()
      scheduleShellLayoutSync()
    })
  }, 300)
}

/**
 * 分隔线拖动期间记录右栏的实际像素宽度，并把高频 DOM 读取和视口刷新合并到每个动画帧一次。
 * 这样既保持 Three/Cesium 画布实时适配，也避免鼠标移动事件重复触发布局查询。
 */
const handleResized = (payload?: SplitpanesLayoutEvent) => {
  const panes = resolveSplitpanesEventPanes(payload)
  if (panes) syncCurrentPaneSizes(panes)
  scheduleShellLayoutSync()
}

/**
 * 兼容 Splitpanes 当前声明中的数组负载与运行时对象负载；升级依赖后可保留同一调用入口。
 */
const resolveSplitpanesEventPanes = (payload?: SplitpanesLayoutEvent) => {
  if (!payload) return undefined
  return Array.isArray(payload) ? payload : payload.panes
}

/**
 * 缓存分栏百分比，并据当前外壳宽度记录用户拖动后的左右栏像素宽度。
 * 这些像素值会在窗口缩放时重新换算，避免用户拖动后的面板宽度被百分比放大。
 */
const syncCurrentPaneSizes = (panes: SplitPaneSize[]) => {
  if (panes.length < 3) return

  // 拖动事件是分栏尺寸的唯一实时来源，回写响应式值可让后续重渲染保持用户拖动结果。
  leftPaneSizePercent.value = panes[0].size
  centerPaneSizePercent.value = panes[1].size
  rightPaneSizePercent.value = panes[2].size
  const shellWidth = getSceneShellElement()?.clientWidth ?? 0
  if (shellWidth > 0) {
    currentLeftPaneWidth = Math.max(LEFT_PANEL_WIDTH.min, (shellWidth * panes[0].size) / 100)
    currentRightPaneWidth = Math.min(
      RIGHT_PANEL_WIDTH.max,
      Math.max(RIGHT_PANEL_WIDTH.min, (shellWidth * panes[2].size) / 100),
    )
  }
}

/**
 * 根据外壳最新宽度同步左右栏的像素约束，并按缓存的像素宽度恢复拖动结果。
 */
const syncRightPanePercentageConstraints = () => {
  const shellWidth = getSceneShellElement()?.clientWidth ?? 0
  if (shellWidth <= 0) return

  /** 左栏按 320px 像素基准换算，窄屏时仍服从 CSS 下限，避免中心栏和右栏发生溢出。 */
  const leftSize = pixelsToPercent(Math.max(LEFT_PANEL_WIDTH.min, currentLeftPaneWidth), shellWidth)
  const availableRightWidth = Math.max(
    RIGHT_PANEL_WIDTH.min,
    shellWidth * (1 - leftSize / 100 - CENTER_MIN_SIZE_PERCENT / 100),
  )
  const effectiveMaxRightWidth = Math.min(RIGHT_PANEL_WIDTH.max, availableRightWidth)
  currentRightPaneWidth = Math.min(
    effectiveMaxRightWidth,
    Math.max(RIGHT_PANEL_WIDTH.min, currentRightPaneWidth),
  )
  const rightSize = pixelsToPercent(currentRightPaneWidth, shellWidth)
  const centerSize = Math.max(0, 100 - leftSize - rightSize)

  leftPaneMinSizePercent.value = pixelsToPercent(LEFT_PANEL_WIDTH.min, shellWidth)
  leftPaneSizePercent.value = leftSize
  rightPaneMinSizePercent.value = pixelsToPercent(RIGHT_PANEL_WIDTH.min, shellWidth)
  rightPaneMaxSizePercent.value = pixelsToPercent(effectiveMaxRightWidth, shellWidth)
  centerPaneSizePercent.value = centerSize
  rightPaneSizePercent.value = rightSize
  nextTick(scheduleShellLayoutSync)
}

/**
 * 将窗口缩放和 ResizeObserver 的连续通知合并到下一动画帧。
 * 此时浏览器已经提交了新的外壳宽度，再写入 Splitpanes 百分比，避免用到缩放前的旧尺寸。
 */
const scheduleRightPaneConstraintSync = () => {
  if (rightPaneConstraintFrame !== undefined) return

  rightPaneConstraintFrame = window.requestAnimationFrame(() => {
    rightPaneConstraintFrame = undefined
    syncRightPanePercentageConstraints()
  })
}

/** 把连续分栏事件收敛为单帧一次，减少属性面板和 WebGL 视口的重复重排。 */
const scheduleShellLayoutSync = () => {
  if (layoutSyncFrame !== undefined) return

  layoutSyncFrame = window.requestAnimationFrame(() => {
    layoutSyncFrame = undefined
    syncShellNavWidths()
    getWidgetOverlayHostPort().refreshViewportLayout()
  })
}

const getLeftPaneElement = () => {
  return sceneEditRootRef.value?.querySelector<HTMLElement>(
    '.scene-edit-shell > .splitpanes__pane:first-child',
  )
}

const getRightPaneElement = () => {
  return sceneEditRootRef.value?.querySelector<HTMLElement>(
    '.scene-edit-shell > .splitpanes__pane:last-child',
  )
}

/** 返回分栏外壳的真实元素，作为像素与百分比换算的唯一宽度基准。 */
const getSceneShellElement = () => {
  return sceneEditRootRef.value?.querySelector<HTMLElement>('.scene-edit-shell')
}

const syncShellNavWidths = () => {
  syncLeftCardNavWidth()
  syncRightCardNavWidth()
}

const syncLeftCardNavWidth = () => {
  const rootElement = sceneEditRootRef.value
  const leftPaneElement = getLeftPaneElement()

  if (!rootElement || !leftPaneElement) return

  // 顶部左侧页签覆盖完整左面板，分栏拖动后只读取一次实际宽度并写入样式变量。
  const navWidth = leftPaneElement.getBoundingClientRect().width
  rootElement.style.setProperty('--scene-edit-left-card-nav-width', `${Math.max(0, navWidth)}px`)
}
const syncRightCardNavWidth = () => {
  const rootElement = sceneEditRootRef.value
  const rightPaneElement = getRightPaneElement()

  if (!rootElement || !rightPaneElement) return

  // 顶部右侧页签覆盖完整属性面板，避免旧版内缩量导致页签和面板边界错位。
  const navWidth = rightPaneElement.getBoundingClientRect().width
  rootElement.style.setProperty('--scene-edit-right-card-nav-width', `${Math.max(0, navWidth)}px`)
}

// 关闭预览场景
const closePreviewScene = () => {
  editorPreviewGeneration += 1
  stopEditorFirstPersonPreview()
  previewFirstPersonObject.value = null
  previewFirstPersonRuntime = null
  isPreviewScene.value = false
  teleportTo.value = '#scene'
  getWidgetOverlayHostPort().exitPreview()
  getWidgetOverlayHostPort().restoreSceneObjectHighlight(currentTransformMaterialUuid.value)
}

// 顶部按钮只代理到唯一的场景操作组件，避免复制保存和预览的数据流。
const handleSaveSceneConfig = () => {
  if (editorSceneOperation.value) return
  if (!sceneLockReady.value || sceneLockLost.value) {
    ElMessage.warning(
      sceneLockLost.value ? '当前场景编辑锁已失效，不能继续保存' : '场景锁尚未就绪，请稍后重试',
    )
    return
  }
  if (sceneDataLoadState.value !== 'ready') {
    ElMessage.warning(
      sceneDataLoadState.value === 'failed'
        ? '场景数据加载失败，不能保存当前空场景'
        : '场景数据尚未加载完成，请稍后重试',
    )
    return
  }
  sceneOperationRef.value?.handleSaveSceneConfig()
}

/**
 * 按模板类型懒加载分类字典，并按类型缓存结果；切换类型时不会重复请求，也不会把旧类型
 * 的分类选项短暂展示在当前弹窗中。请求失败仅影响分类下拉，仍允许用户保存其他字段。
 */
const loadSaveAsTemplateCategories = async (templateType: Dim3dTemplateType) => {
  saveAsTemplateType.value = templateType
  const cachedCategories = saveAsTemplateCategoryCache.get(templateType)
  if (cachedCategories) {
    saveAsTemplateCategories.value = cachedCategories
    return
  }

  let request = saveAsTemplateCategoryRequests.get(templateType)
  if (!request) {
    request = (async () => {
      try {
        const response = await getDim3dTemplateCategoryDictionary(templateType, {
          suppressNotFoundNotification: true,
        })
        if (response.code !== 200 || !Array.isArray(response.data)) {
          throw new Error(response.msg?.trim() || '模板分类接口返回格式异常')
        }
        saveAsTemplateCategoryCache.set(templateType, createDim3dDictionaryOptions(response.data))
      } catch (error) {
        appLogger.warn('SceneEdit', `另存模板加载${templateType}分类失败`, error)
        throw error
      }
    })()
    saveAsTemplateCategoryRequests.set(templateType, request)
    void request
      .then(
        () => undefined,
        () => undefined,
      )
      .then(() => {
        if (saveAsTemplateCategoryRequests.get(templateType) === request) {
          saveAsTemplateCategoryRequests.delete(templateType)
        }
      })
  }

  try {
    await request
  } catch {
    if (saveAsTemplateType.value === templateType) {
      saveAsTemplateCategories.value = []
      // 分类是另存接口必填字段；字典失败时保留空选项并提示用户重试，避免提交无效请求。
      ElMessage.warning('模板分类加载失败，请稍后重试')
    }
    return
  }

  if (saveAsTemplateType.value === templateType) {
    saveAsTemplateCategories.value = saveAsTemplateCategoryCache.get(templateType) || []
  }
}

/** 弹窗切换模板类型时由子组件通知父页面，父页面负责切换到对应字典。 */
const handleSaveAsTemplateTypeChange = (templateType: Dim3dTemplateType) => {
  if (templateType !== saveAsTemplateType.value) {
    saveAsTemplateCategories.value = []
  }
  void loadSaveAsTemplateCategories(templateType)
}

/**
 * 顶栏“保存为模板”只在当前编辑数据完整可用时开放。
 * 新接口直接上传当前内存快照，不依赖实例草稿是否已保存，但仍要求编辑会话未失锁。
 */
const openSaveAsTemplateDialog = () => {
  if (editorSceneOperation.value) return
  if (!editorCapabilities.saveAsTemplate) return
  if (!sceneLockReady.value || sceneLockLost.value) {
    ElMessage.warning(
      sceneLockLost.value ? '当前场景编辑锁已失效，不能另存为模板' : '场景锁尚未就绪，请稍后重试',
    )
    return
  }
  if (sceneDataLoadState.value !== 'ready') {
    ElMessage.warning(
      sceneDataLoadState.value === 'failed'
        ? '当前场景加载失败，不能另存为模板'
        : '当前场景仍在加载，请稍后重试',
    )
    return
  }
  saveAsTemplateType.value = DEFAULT_TEMPLATE_TYPE
  saveAsTemplateCategories.value = []
  saveAsTemplateVisible.value = true
  void loadSaveAsTemplateCategories(DEFAULT_TEMPLATE_TYPE)
}

/**
 * 由共享弹窗调用的场景模板提交器。
 * 服务层会一次采集 SceneStore、场景面板和二维部件并生成四包，不调用 saveAll，也不清除脏状态。
 */
const handleSaveAsTemplate = async (form: EditorDim3dSceneTemplateForm) => {
  if (!editorCapabilities.saveAsTemplate) {
    throw new Error('当前平台不支持保存为模板')
  }
  if (!sceneLockReady.value || sceneLockLost.value || sceneDataLoadState.value !== 'ready') {
    throw new Error('当前编辑会话已不可用，请重新进入场景后再另存模板')
  }
  const release = beginEditorSceneOperation('saveTemplate')
  try {
    return await saveActiveEditorSceneAsTemplate(form, { sceneApi: store.sceneApi })
  } finally {
    release()
  }
}
const handlePreviewScene = () => {
  if (editorSceneOperation.value) return
  if (!sceneLockReady.value || sceneLockLost.value) {
    ElMessage.warning(
      sceneLockLost.value ? '当前场景编辑锁已失效，不能继续操作' : '场景锁尚未就绪，请稍后重试',
    )
    return
  }
  if (sceneDataLoadState.value !== 'ready') {
    ElMessage.warning('场景数据尚未成功加载，暂不能预览')
    return
  }
  sceneOperationRef.value?.handlePreviewScene()
}

/**
 * 主动退出和渲染器意外断开共用一个退出任务：停止心跳、等待解锁，再关闭当前页签。
 * 不依赖 opener 是否存在；浏览器拒绝关页时替换到管理页，避免回退到失效编辑会话。
 */
const handleBackToPreviousPage = createEditorSceneExitController({
  releaseSceneLock: stopSceneLockHeartbeat,
  returnToManagement: () => router.replace({ name: 'sceneManage' }),
})

/** 断开后立即停用编辑画布和保存入口，但不标记失锁，确保仍执行当前页签的真实解锁请求。 */
const handleRendererDisconnected = (message: string) => {
  if (renderMode.value !== 'cloud') return
  sceneLockReady.value = false
  appLogger.warn('SceneEdit', '云渲染连接意外断开，正在释放场景锁并关闭编辑页签', message)
  void handleBackToPreviousPage()
}

// 发布
const releaseScene = async () => {
  if (editorSceneOperation.value) return
  if (!sceneLockReady.value || sceneLockLost.value) {
    ElMessage.warning(
      sceneLockLost.value ? '当前场景编辑锁已失效，不能继续发布' : '场景锁尚未就绪，请稍后重试',
    )
    return
  }
  if (sceneDataLoadState.value !== 'ready') {
    ElMessage.warning('场景数据尚未成功加载，暂不能发布')
    return
  }
  const release = beginEditorSceneOperation('publish')
  try {
    const id = Array.isArray(route.query.id) ? route.query.id[0] : route.query.id
    const sceneId = String(id ?? '').trim()
    if (!/^[1-9]\d*$/.test(sceneId)) {
      ElMessage.warning('当前场景缺少有效编号，暂不能发布')
      return
    }
    /**
     * 新版发布接口要求 accessMode 必填。编辑器没有访问模式表单，因此只复用场景详情中已保存的模式；
     * 首次发布尚未配置模式时禁止发送非法空请求，并引导用户到管理页完成显式选择。
     */
    const detailResponse = await getDim3dSceneInfo(sceneId)
    const accessMode = detailResponse.data?.accessMode?.trim()
    if (!accessMode) {
      ElMessage.warning('当前场景尚未配置访问模式，请在场景管理页完成发布')
      return
    }
    /**
     * 编辑器内的快捷发布与场景管理页共用同一套发布前校验：读取当前保存四包的植被稳定身份，
     * 再获取服务端当前版本进行严格比对。校验失败时不发送整场发布请求，也不引入冻结逻辑。
     */
    const savedVegetationPublication = readSavedVegetationPublicationIdentity(detailResponse)
    if (savedVegetationPublication) {
      let currentVegetationPublication
      try {
        currentVegetationPublication = await getDim3dCurrentVegetationPublication(sceneId)
      } catch (error) {
        const status =
          error instanceof Error
            ? ((error as Error & { status?: number; code?: number }).status ??
              (error as Error & { code?: number }).code)
            : undefined
        if (status === 404) {
          throw new Error('服务端没有当前植被正式版本，请先生成并发布植被后再发布场景。')
        }
        throw new Error(
          error instanceof Error && error.message
            ? `服务端当前植被版本核对失败：${error.message}`
            : '服务端当前植被版本核对失败，请稍后重试。',
        )
      }
      assertVegetationPublicationMatches(
        sceneId,
        savedVegetationPublication,
        currentVegetationPublication,
      )
    }
    const response = await publishDim3dScene(sceneId, { accessMode })
    ElMessage.success(response.data?.alreadyPublished === true ? '该版本已发布' : '发布成功')
    store.setSceneIsPublish(true)
  } catch (error) {
    // 发布失败需要保留项目 id 和异常信息，便于排查发布接口或权限问题。
    appLogger.error('SceneEdit', '发布失败', route.query.id, error)
    ElMessage.error(error instanceof Error ? error.message : '发布失败，请稍后重试')
  } finally {
    release()
  }
}
onUnmounted(() => {
  editorPreviewGeneration += 1
  stopEditorFirstPersonPreview()
  window.removeEventListener('keydown', handleEditorFirstPersonKeyDown)
  window.removeEventListener('keyup', handleEditorFirstPersonKeyUp)
  window.removeEventListener('blur', releaseEditorFirstPersonInput)
  window.removeEventListener('pointerdown', handleEditorFirstPersonPointerDown)
  window.removeEventListener('pointermove', handleEditorFirstPersonPointerMove)
  window.removeEventListener('pointerup', handleEditorFirstPersonPointerUp)
  window.removeEventListener('pointercancel', handleEditorFirstPersonPointerUp)
  void stopSceneLockHeartbeat()
  window.removeEventListener('beforeunload', releaseSceneLockBeforeUnload)
  window.removeEventListener('pagehide', releaseSceneLockBeforeUnload)
  document.body.classList.remove('scene-edit-route-open')
  leftPaneResizeObserver?.disconnect()
  rightPaneResizeObserver?.disconnect()
  shellResizeObserver?.disconnect()
  if (layoutSyncFrame !== undefined) window.cancelAnimationFrame(layoutSyncFrame)
  if (rightPaneConstraintFrame !== undefined) {
    window.cancelAnimationFrame(rightPaneConstraintFrame)
  }
  window.removeEventListener('resize', scheduleRightPaneConstraintSync)
  clearTimeout(timeOut.value)
  $eventBus?.off(MITT_ON_KEY_ENUM.PREVIEW_SCENE)
})
</script>

<style scoped lang="scss">
:deep(.splitpanes__splitter) {
  position: relative;
  box-sizing: border-box;
  flex-shrink: 0;
  width: 2px;
  margin-left: -1px;
}
.scene-edit-center-shell {
  /**
    * Figma 中间区域从左右面板边界直接铺满到画布底部，不存在悬浮卡片式外间距。
    * 这里由外壳统一提供 #0C121A 底色，避免中心区域与两侧面板之间出现可见缝隙。
    */
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  padding: 0;
  background: var(--scene-edit-bg-app);
}
.scene-edit-center-pane {
  /**
    * 画布承载层与 Figma 的模块/场景工具栏、左右面板保持同一条边界。
    * 去掉旧的卡片边框、圆角、阴影和毛玻璃效果，避免顶部、底部和两侧产生明显断层；
    * 仅保留内部 Three.js / Cesium 画布自己的渲染背景与交互，不改变舞台尺寸或相机逻辑。
    */
  position: relative;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--scene-edit-bg-app);
  border: 0;
  border-radius: 0;
  box-shadow: none;
  backdrop-filter: none;
}
.scene-edit-side-pane {
  /**
    * 顶栏第二行的左右页签仍由 SceneHeader 统一渲染；页面主体从标题栏下方开始后，
    * 侧面板需要预留同样的 36px 高度，避免内容被页签覆盖。中间槽位不使用该预留，
    * 因为它由 SceneOperation 自己占用 36px，随后才开始渲染真实画布。
    */
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  min-height: 0;
}
.scene-edit-side-pane--left,
.scene-edit-side-pane--right {
  padding-top: var(--scene-edit-nav-height);
}
.scene-edit-center-pane__viewport {
  position: relative;
  flex: 1 1 auto;
  width: 100%;
  height: auto;
  min-height: 0;
}
.scene-edit-preview-layer {
  /**
   * 预览模式下会把 SceneCanvas Teleport 到这个容器里。
   * 这里必须显式提供高于编辑器面板的层级，否则画布会被“搬走”但预览层仍被左右面板压住，
   * 最终表现成中间空白、侧边栏还留在页面上。
   */
  position: fixed;
  inset: 0;
  z-index: 3000;
  width: 100vw;
  height: 100vh;
}
.scene-edit-preview-collision-message {
  align-self: center;
  padding: 5px 8px;
  font-size: 12px;
  color: #ffc477;
  background: rgb(12 22 30 / 90%);
  border-radius: 4px;
}
</style>
