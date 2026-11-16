<template>
  <div ref="viewportRef" class="scene-preview-stage-viewport" data-three-map-background-host>
    <div ref="stageRef" class="scene-preview-stage" :class="runtimeStageClass" :style="stageStyle">
      <div
        id="preview-runtime"
        ref="runtimeHostRef"
        class="scene-preview-runtime"
        data-scene-preview-runtime
      />
      <LayerDOM />
      <div v-if="firstPersonObject?.firstPerson?.enabled" class="scene-preview-first-person-tools">
        <button type="button" @click="toggleFirstPerson">{{ firstPersonActive ? '退出第一人称' : '进入第一人称' }}</button>
        <span v-if="firstPersonCollisionMessage">{{ firstPersonCollisionMessage }}</span>
      </div>
    </div>
    <section
      v-if="previewAccessState !== 'ready' && previewAccessState !== 'loading'"
      class="scene-preview-access-state"
      role="status"
    >
      <template v-if="previewAccessState === 'need-password' || previewAccessState === 'need-ticket'">
        <h1>{{ previewAccessState === 'need-ticket' ? '请输入发布访问票据' : '请输入访问密码' }}</h1>
        <p
          class="scene-preview-access-state__password-message"
          :class="{ 'is-error': previewAccessMessage }"
          aria-live="polite"
        >
          {{ previewAccessMessage || (previewAccessState === 'need-ticket' ? '使用签发给该发布版本的票据。' : '该场景已启用公开加密访问。') }}
        </p>
        <el-input
          v-model="previewPassword"
          class="scene-preview-access-state__input"
          type="password"
          show-password
          autocomplete="current-password"
          :placeholder="previewAccessState === 'need-ticket' ? '请输入发布访问票据' : '请输入访问密码'"
          @input="clearPreviewPasswordMessage"
          @keyup.enter="submitPreviewPassword"
        />
        <el-button
          type="primary"
          :loading="previewPasswordSubmitting"
          @click="submitPreviewPassword"
        >
          进入预览
        </el-button>
      </template>
      <template v-else>
        <h1>{{ previewAccessTitle }}</h1>
        <p>{{ previewAccessMessage }}</p>
        <el-button v-if="fixedLoginRequired" type="primary" @click="loginForFixedPublication">前往登录</el-button>
      </template>
    </section>
  </div>
  <Loading :percentage="loadingInfo.percentage" :loading="loadingInfo.loading" />
</template>
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, provide, reactive, readonly, ref, watch } from 'vue'
import { sceneMediaServerKey } from '@/integrations/scene/useSceneMediaServer'
// 路径别名导入由 TypeScript 与 Vite 统一解析；不保留 .ts 扩展名，避免 NodeNext 模块解析规则报错。
import type renderScene from '@/utils/renderScene'
import { useSceneWidgetStore } from '@/stores/sceneEditStore'
import {
  FirstPersonPreviewController,
  type FirstPersonPreviewPose,
  type SceneCameraState,
  type SceneObject,
  type SceneRuntime,
  type SceneType,
} from '@/scene-platform'
import { INTERACTIVE_EVENT_ENUM } from '@/enums/scenePanelEnum'
import { evaluateConditionBlock } from '@/utils/renderScene/conditionRuntime'
import { getStagePointerCoordinate } from '@/utils/renderScene/pointerCoordinate'
import { createEditorSceneInteractionActionRuntimePort } from '@/integrations/scene/editorSceneInteractionActionRuntime'
import { useRoute } from 'vue-router'
import Loading from '@/components/Loading/index.vue'
import LayerDOM from '@/views/sceneEdit/SceneCenter/SceneCanvas/LayerDOM/index.vue'
import {
  calculateSceneStageLayout,
  createDefaultSceneStageSize,
} from '@/utils/sceneStage'
import { appLogger } from '@/utils/logger'
import {
  createScenePreviewRuntimeLoader,
  type ScenePreviewRuntimeController,
} from '@/integrations/scene/scenePreviewRuntimeLoader'
import { createSceneRuntimeFragmentLoader } from '@/integrations/scene/sceneRuntimeFragmentLoader'
import {
  createScenePreviewFragmentLoaderApi,
  createScenePreviewTicketRefresher,
  resolveScenePreviewAccessMessage,
  resolveScenePreviewSession,
  type ScenePreviewSession,
  type ScenePreviewTicketRefresher,
} from '@/integrations/scene/scenePreviewAccess'
import { authContext } from '@/auth/authContext'
import { hasIotPermission } from '@/auth/iotNavigation'
import { loadFixedScenePublication, type FixedPublication } from '@/integrations/scene/fixedScenePublication'
import { UnityEditorSceneRuntime } from '@/unity-runtime/runtime/UnityEditorSceneRuntime'
import { unityRenderConfig } from '@/unity-runtime/renderMode'
import { clearAuthenticationRuntime } from '@/auth/runtime'
import { tokenCache } from '@/utils/utils'
import { clearTabAuthHandoffCache } from '@/auth/tabAuthHandoff'
import {
  clearScenePreviewLoginRedirectGuard,
  isScenePreviewAuthenticationError,
  redirectScenePreviewToTenantLogin,
} from '@/auth/scenePreviewLoginRedirect'
import type { Dim3dPreviewResolveResultCode } from '@/servers/manual/dim3d/api/sceneRuntime'
import {
  createReadonlyPreviewRenderSceneStoreBridge,
  createReadonlyPreviewWidgetCommandPort,
  createReadonlyPreviewWidgetOverlayHostPort,
  createReadonlyPreviewWidgetRuntimePort,
} from '@/integrations/scene/scenePreviewReadonlyAdapter'
import {
  getWidgetOverlayHostPort,
  getWidgetRuntimePort,
  resetWidgetRuntimePorts,
  setWidgetCommandPort,
  setWidgetOverlayHostPort,
  setWidgetRuntimePort,
} from '@/integrations/scene/widgetRuntime'

const route = useRoute()

// 发布视频只继承当前发布快照的服务器，不读取编辑器宿主；快照就绪前暂停源流接入。
const previewMediaServerId = ref<string | null>(null)
provide(sceneMediaServerKey, readonly(previewMediaServerId))

const sceneWidgetStore = useSceneWidgetStore()
const viewportRef = ref<HTMLElement>()
const stageRef = ref<HTMLElement>()
const runtimeHostRef = ref<HTMLElement>()
const previewRuntimeType = ref<SceneType | null>(null)
const stageLayout = reactive({
  ...createDefaultSceneStageSize(),
  scale: 1,
  left: 0,
  top: 0,
})
let resizeObserver: ResizeObserver | null = null
let previewRuntimeController: ScenePreviewRuntimeController | null = null
let previewClosed = false
const firstPersonObject = ref<SceneObject | null>(null)
const firstPersonActive = ref(false)
const firstPersonCollisionMessage = ref('')
let firstPersonRuntime: SceneRuntime | null = null
let firstPersonController: FirstPersonPreviewController | null = null
let firstPersonPreviousCamera: SceneCameraState | null = null
let firstPersonFrame: number | null = null
let firstPersonLastFrameTime = 0

const applyFirstPersonPose = (pose: FirstPersonPreviewPose) => {
  const runtime = firstPersonRuntime
  const object = firstPersonObject.value
  if (!runtime || !object?.firstPerson || !firstPersonActive.value) return
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
  if (camera.kind === 'three' && object.transform.kind === 'local') {
    const eye: [number, number, number] = [
      pose.position[0],
      pose.position[1] + object.firstPerson.eyeHeight,
      pose.position[2],
    ]
    void runtime.setCamera({
      ...camera,
      position: eye,
      target: [
        eye[0] + Math.sin(pose.heading),
        eye[1] + Math.sin(pose.pitch),
        eye[2] - Math.cos(pose.heading),
      ],
      fov: object.firstPerson.fov,
    })
  } else if (camera.kind === 'cesium' && object.transform.kind === 'geo') {
    runtime.setFirstPersonFov?.(object.firstPerson.fov)
    void runtime.setCamera({
      ...camera,
      destination: [pose.position[0], pose.position[1], pose.position[2] + object.firstPerson.eyeHeight],
      orientation: { heading: pose.heading, pitch: pose.pitch, roll: 0 },
    })
  }
}

const releaseFirstPersonInput = () => {
  firstPersonController?.pointerUp()
  for (const key of ['w', 'a', 's', 'd']) firstPersonController?.keyUp(key)
}
const handleFirstPersonKeyDown = (event: KeyboardEvent) => {
  if (!firstPersonActive.value || !['w', 'a', 's', 'd'].includes(event.key.toLowerCase())) return
  const target = event.target as HTMLElement | null
  if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
  event.preventDefault()
  firstPersonController?.keyDown(event.key)
}
const handleFirstPersonKeyUp = (event: KeyboardEvent) => firstPersonController?.keyUp(event.key)
const handleFirstPersonPointerDown = (event: PointerEvent) => {
  if (!firstPersonActive.value || event.button !== 0 || !runtimeHostRef.value?.contains(event.target as Node)) return
  firstPersonController?.pointerDown(event.clientX, event.clientY)
}
const handleFirstPersonPointerMove = (event: PointerEvent) => {
  firstPersonController?.pointerMove(event.clientX, event.clientY)
}
const handleFirstPersonPointerUp = () => firstPersonController?.pointerUp()
const tickFirstPerson = (time: number) => {
  if (!firstPersonController) { firstPersonFrame = null; return }
  firstPersonController.step((time - firstPersonLastFrameTime) / 1000)
  firstPersonLastFrameTime = time
  firstPersonFrame = requestAnimationFrame(tickFirstPerson)
}
const exitFirstPerson = () => {
  if (firstPersonFrame !== null) cancelAnimationFrame(firstPersonFrame)
  firstPersonFrame = null
  releaseFirstPersonInput()
  firstPersonController?.dispose()
  firstPersonController = null
  firstPersonRuntime?.setFirstPersonInputEnabled?.(false)
  firstPersonRuntime?.setFirstPersonPerformanceMode?.(false)
  if (firstPersonPreviousCamera && firstPersonRuntime) void firstPersonRuntime.setCamera(firstPersonPreviousCamera)
  firstPersonPreviousCamera = null
  firstPersonActive.value = false
  firstPersonCollisionMessage.value = ''
}
const enterFirstPerson = (runtime: SceneRuntime, object: SceneObject) => {
  if (!object.firstPerson?.enabled) return
  exitFirstPerson()
  firstPersonRuntime = runtime
  firstPersonObject.value = object
  firstPersonPreviousCamera = runtime.getCamera()
  firstPersonActive.value = true
  runtime.setFirstPersonInputEnabled?.(true)
  runtime.setFirstPersonPerformanceMode?.(true)
  firstPersonController = new FirstPersonPreviewController({
    config: object.firstPerson,
    transform: object.transform,
    isCollisionAvailable: () => runtime.isFirstPersonCollisionAvailable?.() ?? false,
    canMove: (position, movement) =>
      runtime.canMoveFirstPerson?.({
        position,
        height: object.firstPerson!.height,
        radius: object.firstPerson!.collisionRadius,
        objectId: object.id,
        movement,
      }) ?? false,
    onBlocked: (reason) => {
      firstPersonCollisionMessage.value =
        reason === 'unavailable' ? '碰撞查询不可用，移动已暂停' : '已碰到障碍物'
    },
    onUnblocked: () => { firstPersonCollisionMessage.value = '' },
    onChange: applyFirstPersonPose,
  })
  firstPersonController.reset()
  firstPersonLastFrameTime = performance.now()
  firstPersonFrame = requestAnimationFrame(tickFirstPerson)
}
const toggleFirstPerson = () => {
  if (firstPersonActive.value) exitFirstPerson()
  else if (firstPersonRuntime && firstPersonObject.value) enterFirstPerson(firstPersonRuntime, firstPersonObject.value)
}
let stopPreviewGisObjectInteraction: (() => void) | null = null
let previewTicketRefresher: ScenePreviewTicketRefresher | null = null
/** 公开加密预览续期需要密码；只保留在当前页面内存，卸载时立即清除。 */
let previewTicketRefreshPassword = ''

type PreviewAccessState =
  | 'loading'
  | 'ready'
  | 'need-password'
  | 'need-login'
  | 'need-ticket'
  | 'not-found'
  | 'not-published'
  | 'expired'
  | 'no-permission'
  | 'error'

const previewAccessState = ref<PreviewAccessState>('loading')
const previewAccessMessage = ref('')
const previewPassword = ref('')
const previewPasswordSubmitting = ref(false)
const fixedLoginRequired = computed(() => previewAccessState.value === 'need-login' && Boolean(getFixedPublicationId()))

const loginForFixedPublication = () => {
  try {
    if (!redirectScenePreviewToTenantLogin()) previewAccessMessage.value = '请稍后重试登录。'
  } catch {
    previewAccessMessage.value = '请从租户端场景管理进入该发布。'
  }
}

/** 访问状态使用机器码映射固定标题，避免依赖后端 msg 文案判断业务分支。 */
const PREVIEW_ACCESS_TITLE: Partial<Record<PreviewAccessState, string>> = {
  'need-login': '需要登录',
  'not-found': '场景不存在',
  'not-published': '场景未发布',
  expired: '发布已过期',
  'no-permission': '暂无访问权限',
  error: '预览加载失败',
}

const previewAccessTitle = computed(
  () => PREVIEW_ACCESS_TITLE[previewAccessState.value] || '暂时无法预览',
)

const loadingInfo = reactive({
  percentage: 0,
  loading: false,
})

const stageStyle = computed(() => ({
  width: `${stageLayout.width}px`,
  height: `${stageLayout.height}px`,
  transform: `translate3d(${stageLayout.left}px, ${stageLayout.top}px, 0) scale(${stageLayout.scale})`,
}))

const runtimeStageClass = computed(() => ({
  'scene-preview-stage--gis': previewRuntimeType.value === 'gis',
  'scene-preview-stage--local3d': previewRuntimeType.value === 'local3d',
}))

const syncStageBoundingRect = () => {
  const stageElement = stageRef.value
  if (!stageElement) return
  /**
   * 发布页同样要把可见舞台矩形同步给部件 Store。
   * 这样输入框、选择器等二维部件在预览态触发事件时仍能使用统一坐标体系。
   */
  sceneWidgetStore.setBoundingClientRect(stageElement.getBoundingClientRect())
}

const updateStageLayout = () => {
  const viewportElement = viewportRef.value
  if (!viewportElement) return
  const rect = viewportElement.getBoundingClientRect()
  // 发布与预览共用完整显示布局，视口比例不同时保留留白，避免裁切设计画布边缘。
  const layout = calculateSceneStageLayout(
    rect.width,
    rect.height,
    sceneWidgetStore.getWidgetCanvasConfig(),
  )
  Object.assign(stageLayout, layout)
  nextTick(() => {
    syncStageBoundingRect()
    getWidgetOverlayHostPort().refreshViewportLayout()
  })
}

const registerPreviewWidgetPorts = (
  renderSceneApi: renderScene | null,
  activateWidgets: (widgetIds: readonly string[]) => Promise<void>,
  activateWidgetGroups: (groupIds: readonly string[]) => Promise<void>,
  // 二维和三维来源共用当前发布控制器的目标就绪屏障。
  prepareSceneObjects: ScenePreviewRuntimeController['prepareSceneObjects'],
) => {
  /**
   * 发布页统一注册只读端口。
   * 三维运行时统一由 SceneDefinition 驱动；命令提交和编辑 Store 写回都会被只读适配器截断。
   */
  setWidgetRuntimePort(
    createReadonlyPreviewWidgetRuntimePort(
      () => renderSceneApi,
      undefined,
      activateWidgets,
      activateWidgetGroups,
      prepareSceneObjects,
    ),
  )
  setWidgetCommandPort(createReadonlyPreviewWidgetCommandPort())
  setWidgetOverlayHostPort(createReadonlyPreviewWidgetOverlayHostPort(() => renderSceneApi))
}

/** 二维预览无三维拾取入口；三维事件将在 Unity 适配阶段绑定。 */
const registerPreviewGisObjectInteraction = (
  _runtime: SceneRuntime, _controller: ScenePreviewRuntimeController,
  _renderSceneApi: renderScene | null, _runtimeElement: HTMLElement,
): (() => void) => () => undefined

/**
 * 旧预览模块会异步加载数据源、远程请求和打点派生对象。
 * 二维状态规则必须等该流程完成后再首轮结算，否则规则可能读取到未初始化的运行时值；
 * 卸载后 `resetWidgetRuntimePorts` 会恢复空端口，因此迟到回调不会继续引用旧预览实例。
 */
const enterPreviewAndExecuteWidgetStatus = () => {
  const overlayHostPort = getWidgetOverlayHostPort()
  void Promise.resolve(overlayHostPort.enterPreview())
    .then(() => {
      const widgetRuntimePort = getWidgetRuntimePort()
      if (widgetRuntimePort.isPreview()) {
        widgetRuntimePort.executeAllStatusEvents()
      }
    })
    .catch((error) => {
      /**
       * 只记录当前页面仍持有的预览端口错误。
       * 页面卸载后端口会被 resetWidgetRuntimePorts 替换，迟到失败无需再次访问旧实例或输出误导日志；
       * 有效端口的预览状态与三维资源已由只读适配器完成回滚。
       */
      if (getWidgetOverlayHostPort() !== overlayHostPort) return
      appLogger.error('ScenePreview', '初始化预览数据失败，已退出预览态', error)
    })
}

/**
 * 预览地址的入口编号是编辑场景 `sceneId`，只用于调用 resolve。
 * resolve 成功后返回的 `publicationId` 才会写入预览会话，并用于四个发布预览数据接口。
 */
const getPreviewSceneId = () => {
  const sceneId = route.query.sceneId
  return (Array.isArray(sceneId) ? sceneId[0] : sceneId)?.trim() || ''
}

const getFixedPublicationId = () => {
  const publicationId = route.query.publicationId
  return (Array.isArray(publicationId) ? publicationId[0] : publicationId)?.trim() || ''
}

const mountSceneDefinitionPreview = async (
  publishedPublicationId: string,
  runtimeElement: HTMLElement,
  session: ScenePreviewSession | undefined,
  fixed?: FixedPublication,
) => {
  const identity = authContext.get()
  const fixedResources = fixed?.resources
  const controller = createScenePreviewRuntimeLoader({
    container: runtimeElement,
    /** 运行态回退标识也必须使用发布快照编号，避免场景基础包缺少标识时回到编辑场景。 */
    sceneId: publishedPublicationId,
    renderSceneStoreBridge: createReadonlyPreviewRenderSceneStoreBridge(),
    // 使用无图形运行时，严禁从预览路由恢复旧浏览器三维渲染器。
    /**
     * 运行态容器与二维 DOM 叠加层分离，为 Unity 播放器保留独立容器。
     */
    renderSelector: '#preview-runtime',
    /** 当前公开会话固定使用 publishedPublicationId + ticket 的预览数据源，禁止切换正式发布接口。 */
    publicationId: publishedPublicationId,
    ...(fixed && fixedResources ? {
      fixedPublication: fixed,
      runtimeFactory: (scene) => new UnityEditorSceneRuntime(scene.type, {
        mode: 'webgpu',
        webBootstrapUrl: unityRenderConfig.webgpu.bootstrapUrl,
        publicationResources: fixedResources,
        getHost: () => null,
        onStatus: () => undefined,
      }),
      getIotPublicationAccess: () => {
        const current = authContext.get()
        if (previewClosed || !identity || !authContext.hasValidContext() || identity.tenantId !== current?.tenantId ||
          identity.platformType !== current?.platformType ||
          !(hasIotPermission('dimensions:iot-state:query') || hasIotPermission('dimensions:iot-state:subscribe'))) return null
        return { publicationId: fixedResources.publicationId, publicationTicket: fixedResources.ticket, apiBaseUrl: fixedResources.apiBaseUrl }
      },
    } : {}),
    fragmentLoaderFactory: session ? (fragmentPublicationId) => {
      if (fragmentPublicationId !== session.publishedPublicationId) {
        throw new Error('发布预览请求编号与 publishedPublicationId 不一致。')
      }
      return createSceneRuntimeFragmentLoader({
        publicationId: session.publishedPublicationId,
        api: createScenePreviewFragmentLoaderApi(session),
      })
    } : undefined,
  })

  // 持有正在装载的控制器，保证卸载也能结束 Unity 启动和在途订阅。
  previewRuntimeController = controller
  let result: Awaited<ReturnType<typeof controller.load>>
  try {
    result = await controller.load()
  } catch (error) {
    /**
     * 新格式加载失败时立刻释放已创建的 Runtime，避免预览页残留半初始化资源。
     */
    controller.dispose()
    throw error
  }

  if (previewClosed || previewRuntimeController !== controller) return false
  if (result.loadedBy !== 'scene-definition' || !result.runtime) {
    controller.dispose()
    return false
  }

  previewRuntimeType.value = result.runtimeType
  firstPersonRuntime = result.runtime
  // 内存宿主不具备第一人称渲染能力，不能因为保存包存在相机就开放三维输入循环。
  firstPersonObject.value = null
  const mediaServerId = result.scene?.settings.mediaServerId
  previewMediaServerId.value = typeof mediaServerId === 'string' ? mediaServerId : ''
  const renderSceneApi = result.renderSceneApi as renderScene | null
  /**
   * 隐藏二维组件的首次显示通过当前 controller 的页面内存缓存完成；刷新或卸载后 controller
   * 会释放缓存，下一次进入仍从 resolve 和二维分片接口重新获取。
   */
  registerPreviewWidgetPorts(
    renderSceneApi,
    controller.activateWidgets,
    controller.activateWidgetGroups,
    controller.prepareSceneObjects,
  )
  stopPreviewGisObjectInteraction?.()
  stopPreviewGisObjectInteraction = registerPreviewGisObjectInteraction(
    result.runtime,
    controller,
    renderSceneApi,
    runtimeElement,
  )
  renderSceneApi?.transformControlsModules.setIsPreviewScene(true)
  /**
   * 预览页只通过只读端口进入二维预览态，不写入编辑态 Store。
   */
  enterPreviewAndExecuteWidgetStatus()
  // 二维预览不自动开启已保存相机的三维输入循环。

  previewTicketRefresher?.stop()
  previewTicketRefresher = session ? createScenePreviewTicketRefresher(session, {
    getPassword: () =>
      session.accessMode === 'PUBLIC_ENCRYPT' ? previewTicketRefreshPassword : undefined,
    isAuthenticated: () => authContext.hasValidContext(),
    onError: (error) => {
      // 续期失败只记录并等待下一周期重试，绝不在运行态弹出登录或密码交互。
      appLogger.warn('ScenePreview', '预览票据续期失败，下一周期将继续尝试', error)
    },
  }) : null

  updateStageLayout()
  return true
}

/**
 * 预览页签退出时清理所有权限相关内存和交接缓存。
 * 页面正常卸载、浏览器关闭及页签关闭均会触发 pagehide/beforeunload，避免下次打开时
 * 复用旧 window.name、一次性交接信封、刷新快照或公开加密密码。
 */
const clearPreviewAuthOnExit = (event?: Event) => {
  if (event && 'persisted' in event && Boolean((event as PageTransitionEvent).persisted)) return
  previewTicketRefresher?.stop()
  previewTicketRefresher = null
  previewTicketRefreshPassword = ''
  previewPassword.value = ''
  clearScenePreviewLoginRedirectGuard()
  clearTabAuthHandoffCache()
  clearAuthenticationRuntime()
}

const ACCESS_STATE_BY_RESULT_CODE: Partial<
  Record<Dim3dPreviewResolveResultCode, PreviewAccessState>
> = {
  NEED_PASSWORD: 'need-password',
  NEED_LOGIN: 'need-login',
  NOT_FOUND: 'not-found',
  NOT_PUBLISHED: 'not-published',
  EXPIRED: 'expired',
  NO_PERMISSION: 'no-permission',
} as const

/**
 * 先用编辑场景 `sceneId` 解析公开预览会话，再使用 resolve 响应中的 `publishedPublicationId`
 * 启动统一分片加载器，确保清单、区块、二维、行为和资源接口不会混入编辑场景编号。
 */
const openPreview = async (password?: string) => {
  const runtimeElement = runtimeHostRef.value
  const sceneId = getPreviewSceneId()
  const fixedId = getFixedPublicationId()
  if (runtimeElement && fixedId) {
    if (!authContext.hasValidContext()) {
      previewAccessState.value = 'need-login'
      previewAccessMessage.value = '登录后可加载此发布的 Unity 场景。'
      return
    }
    previewAccessState.value = 'need-ticket'
    if (!password) return
    if (!unityRenderConfig.webgpu.bootstrapUrl) throw new Error('固定发布的 Unity WebGPU 播放器尚未配置。')
    const fixed = await loadFixedScenePublication(fixedId, password)
    if (previewClosed) return
    if (!await mountSceneDefinitionPreview(fixedId, runtimeElement, undefined, fixed)) {
      throw new Error('固定发布没有可用的场景内容。')
    }
    previewAccessState.value = 'ready'
    previewAccessMessage.value = ''
    return
  }
  if (!runtimeElement || !sceneId) {
    previewAccessState.value = 'error'
    previewAccessMessage.value = '预览地址缺少有效的 sceneId。'
    return
  }

  /** 每次重新建立预览会话前丢弃旧密码，只有本次成功校验后才交给续期闭包。 */
  previewTicketRefreshPassword = ''
  exitFirstPerson()
  firstPersonObject.value = null
  firstPersonRuntime = null
  previewRuntimeController?.dispose()
  previewTicketRefresher?.stop()
  previewTicketRefresher = null
  stopPreviewGisObjectInteraction?.()
  stopPreviewGisObjectInteraction = null
  previewRuntimeController = null
  previewMediaServerId.value = null
  let resolved = await resolveScenePreviewSession(
    sceneId,
    password,
    false,
    true,
  )
  let guestLoginCompleted = false
  const isReportedPublicAccess =
    resolved.accessMode === 'PUBLIC_SHARE' || resolved.accessMode === 'PUBLIC_ENCRYPT'
  if (resolved.resultCode === 'NEED_LOGIN' && isReportedPublicAccess) {
    /**
     * 无身份首次解析可能先命中租户预览入口的 NEED_LOGIN。公开地址不能在这里展示或跳转登录页，
     * 先静默登录游客并用游客上下文重试；只有重试后仍要求用户身份时才按受限场景处理。
     */
    await tokenCache()
    guestLoginCompleted = true
    resolved = await resolveScenePreviewSession(sceneId, password, true)
  } else if (resolved.resultCode === 'NEED_LOGIN' && authContext.hasValidContext()) {
    // 个人和企业内部预览只复用真实用户交接身份，绝不切换为游客账号。
    resolved = await resolveScenePreviewSession(sceneId, password, true)
  }
  if (resolved.resultCode !== 'OK' || !resolved.session) {
    previewAccessState.value = ACCESS_STATE_BY_RESULT_CODE[resolved.resultCode] ?? 'error'
    previewAccessMessage.value = resolveScenePreviewAccessMessage(
      resolved,
      Boolean(password?.trim()),
    )
    if (resolved.resultCode === 'NEED_LOGIN') {
      previewAccessMessage.value = '登录状态无效，正在跳转租户端登录页…'
      if (!redirectScenePreviewToTenantLogin()) {
        previewAccessMessage.value = '登录状态仍未恢复，请稍后刷新页面重试。'
      }
    }
    return
  }

  /**
   * 公开地址每次进入都统一登录游客身份。登录必须发生在场景挂载前，确保随后启动的
   * 新数据面板请求、旧数据集请求和轮询首帧都能读取同一份内存鉴权上下文。
   * 企业和个人访问仍使用原有用户登录态；公开访问不复用进入页面前可能残留的其他身份。
   */
  const isPublicAccess =
    resolved.session.accessMode === 'PUBLIC_SHARE' ||
    resolved.session.accessMode === 'PUBLIC_ENCRYPT'
  if (isPublicAccess && !guestLoginCompleted) {
    await tokenCache()
  }

  const mounted = await mountSceneDefinitionPreview(
    resolved.session.publishedPublicationId,
    runtimeElement,
    resolved.session,
  )
  if (!mounted) throw new Error('发布分片未组装出可预览的场景定义。')
  previewAccessState.value = 'ready'
  previewAccessMessage.value = ''
  if (resolved.session.accessMode === 'PUBLIC_ENCRYPT' && password?.trim()) {
    /** 密码仅用于当前页面后续续期，不写入路由、存储或任何持久化场景数据。 */
    previewTicketRefreshPassword = password.trim()
  } else if (resolved.session.accessMode !== 'PUBLIC_ENCRYPT') {
    previewTicketRefreshPassword = ''
  }
  clearScenePreviewLoginRedirectGuard()
}

/** 用户开始修正密码时移除上一次校验错误，避免旧错误与新输入同时存在造成误导。 */
const clearPreviewPasswordMessage = () => {
  if (previewAccessState.value === 'need-password' || previewAccessState.value === 'need-ticket') previewAccessMessage.value = ''
}

/** 密码只保留在输入模型和当前请求中；成功后立即清空，不写路由或浏览器存储。 */
const submitPreviewPassword = async () => {
  if (previewPasswordSubmitting.value) return
  const password = previewPassword.value.trim()
  if (!password) {
    previewAccessMessage.value = getFixedPublicationId() ? '请输入发布访问票据。' : '请输入访问密码。'
    return
  }
  previewPasswordSubmitting.value = true
  loadingInfo.loading = true
  try {
    await openPreview(password)
  if (previewAccessState.value === 'ready') previewPassword.value = ''
  } catch (error) {
    if (getFixedPublicationId()) {
      previewPassword.value = ''
      previewAccessState.value = 'need-ticket'
      previewAccessMessage.value = error instanceof Error ? error.message : '固定发布加载失败。'
      return
    }
    if (isScenePreviewAuthenticationError(error) && redirectScenePreviewToTenantLogin()) return
    previewAccessState.value = 'error'
    previewAccessMessage.value = error instanceof Error ? error.message : '预览加载失败。'
    appLogger.error('ScenePreview', '公开加密预览加载失败', error)
  } finally {
    previewPasswordSubmitting.value = false
    loadingInfo.loading = false
  }
}

onMounted(async () => {
  window.addEventListener('pagehide', clearPreviewAuthOnExit)
  window.addEventListener('beforeunload', clearPreviewAuthOnExit)
  window.addEventListener('keydown', handleFirstPersonKeyDown)
  window.addEventListener('keyup', handleFirstPersonKeyUp)
  window.addEventListener('blur', releaseFirstPersonInput)
  window.addEventListener('pointerdown', handleFirstPersonPointerDown)
  window.addEventListener('pointermove', handleFirstPersonPointerMove)
  window.addEventListener('pointerup', handleFirstPersonPointerUp)
  loadingInfo.loading = true
  resizeObserver = new ResizeObserver(updateStageLayout)
  if (viewportRef.value) {
    resizeObserver.observe(viewportRef.value)
  }
  updateStageLayout()

  try {
    await openPreview()
  } catch (error) {
    if (isScenePreviewAuthenticationError(error) && redirectScenePreviewToTenantLogin()) return
    previewAccessState.value = 'error'
    previewAccessMessage.value = error instanceof Error ? error.message : '预览加载失败。'
    appLogger.error('ScenePreview', '公开预览加载失败', error)
  } finally {
    loadingInfo.loading = false
  }
})

onBeforeUnmount(() => {
  previewClosed = true
  exitFirstPerson()
  window.removeEventListener('keydown', handleFirstPersonKeyDown)
  window.removeEventListener('keyup', handleFirstPersonKeyUp)
  window.removeEventListener('blur', releaseFirstPersonInput)
  window.removeEventListener('pointerdown', handleFirstPersonPointerDown)
  window.removeEventListener('pointermove', handleFirstPersonPointerMove)
  window.removeEventListener('pointerup', handleFirstPersonPointerUp)
  window.removeEventListener('pagehide', clearPreviewAuthOnExit)
  window.removeEventListener('beforeunload', clearPreviewAuthOnExit)
  resizeObserver?.disconnect()
  resizeObserver = null
  getWidgetOverlayHostPort().exitPreview()
  stopPreviewGisObjectInteraction?.()
  stopPreviewGisObjectInteraction = null
  previewRuntimeController?.dispose()
  previewRuntimeController = null
  clearPreviewAuthOnExit()
  previewRuntimeType.value = null
  resetWidgetRuntimePorts()
})

watch(
  () => sceneWidgetStore.widgetCanvasSize,
  () => updateStageLayout(),
  { deep: true },
)
</script>

<style scoped lang="scss">
.scene-preview-stage-viewport {
  position: relative;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  background: #02070d;
}

/** 访问门禁独立覆盖在运行态容器上，密码提交前不会初始化任何三维资源或发布预览数据请求。 */
.scene-preview-access-state {
  position: absolute;
  top: 50%;
  left: 50%;
  z-index: 10;
  display: flex;
  flex-direction: column;
  gap: 16px;
  width: min(360px, calc(100vw - 48px));
  padding: 28px;
  color: #e8f2ff;
  text-align: center;
  background: rgb(8 19 33 / 94%);
  border: 1px solid rgb(106 176 255 / 34%);
  border-radius: 8px;
  box-shadow: 0 18px 56px rgb(0 0 0 / 45%);
  transform: translate(-50%, -50%);
  h1,
  p {
    margin: 0;
  }
  h1 {
    font-size: 20px;
    line-height: 28px;
  }
  p {
    font-size: 14px;
    line-height: 22px;
    color: #9fb3c8;
  }
}
.scene-preview-access-state__input {
  width: 100%;
}
.scene-preview-access-state__password-message.is-error {
  color: #f56c6c;
}
.scene-preview-stage {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
  transform-origin: left top;
}
.scene-preview-runtime {
  position: absolute;
  inset: 0;
  z-index: 0;
  overflow: hidden;
}
.scene-preview-runtime :deep(canvas) {
  display: block;
}
.scene-preview-first-person-tools {
  position: absolute;
  top: 16px;
  right: 16px;
  z-index: 100;
  display: flex;
  gap: 10px;
  align-items: center;
  font-size: 12px;
  color: #ffc477;
}
.scene-preview-first-person-tools button {
  padding: 7px 12px;
  color: #dcecf4;
  cursor: pointer;
  background: rgb(12 22 30 / 90%);
  border: 1px solid rgb(114 184 220 / 65%);
  border-radius: 6px;
}
</style>
