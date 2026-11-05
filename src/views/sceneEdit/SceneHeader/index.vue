<template>
  <header class="scene-edit-header">
    <div class="scene-edit-titlebar">
      <button class="scene-edit-brand" type="button" :title="brandTitle">
        <img
          v-if="brandConfig.logoSrc"
          class="scene-edit-brand__logo"
          :src="resolveSceneEditorBrandAssetUrl(brandConfig.logoSrc)"
          :alt="brandConfig.logoAlt"
        />
        <span v-else class="scene-edit-brand__mark" aria-hidden="true">
          <span></span>
          <span></span>
          <span></span>
        </span>
        <span class="scene-edit-brand__text">
          <strong>{{ brandConfig.softwareName }}</strong>
        </span>
      </button>

      <div class="scene-edit-header__title" :title="projectName">
        {{ projectName }}
      </div>

      <div
        class="scene-edit-header__actions"
        :class="{ 'scene-edit-header__actions--with-import': props.showImportSceneJson }"
        aria-label="场景操作"
      >
        <!--
          顶栏沿用 Figma 节点 2086:1792 的 20px 操作按钮、分隔线和 24px 退出按钮。
          运维端增加上传入口时同步扩展操作槽宽度，不能让新增图标挤出退出按钮。
          每个按钮同时挂载普通态与交互态原始资源，由 CSS 切换透明度；这样不会使用滤镜猜色，
          也能在首次悬浮时立即显示设计稿状态。退出普通态使用完整节点导出的原始资源，
          交互态保留相同矢量路径并使用设计主色，确保五个按钮具有一致的状态反馈。
          去除文字后统一补充 Tooltip 与 aria-label，确保鼠标和键盘用户都能识别按钮用途。
        -->
        <div class="scene-edit-header__primary-actions">
          <SceneJsonUpload
            v-if="props.showImportSceneJson"
            :disabled="props.importDisabled"
            @before-replace="emit('before-import')"
            @after-replace="emit('after-import')"
            @applied="emit('scene-imported')"
          />
          <el-tooltip
            v-if="props.showSaveAsTemplate"
            content="保存为模板"
            placement="bottom"
            :show-after="160"
            popper-class="scene-edit-popover"
          >
            <button
              class="scene-edit-header__action"
              type="button"
              aria-label="保存为模板"
              :disabled="!!editorSceneOperation"
              @click="emit('save-template')"
            >
              <img
                class="scene-edit-header__action-icon scene-edit-header__action-icon--default"
                :src="saveTemplateDefaultIcon"
                alt=""
                aria-hidden="true"
              />
              <img
                class="scene-edit-header__action-icon scene-edit-header__action-icon--active"
                :src="saveTemplateActiveIcon"
                alt=""
                aria-hidden="true"
              />
            </button>
          </el-tooltip>
          <el-tooltip
            :content="props.saveLoading ? '保存中' : props.saveDirty ? '保存未提交的改动' : '保存'"
            placement="bottom"
            :show-after="160"
            popper-class="scene-edit-popover"
          >
            <button
              class="scene-edit-header__action"
              type="button"
              :aria-label="props.saveLoading ? '保存中' : '保存'"
              :aria-busy="props.saveLoading"
              :disabled="props.saveDisabled"
              @click="emit('save')"
            >
              <img
                class="scene-edit-header__action-icon scene-edit-header__action-icon--default"
                :src="saveDefaultIcon"
                alt=""
                aria-hidden="true"
              />
              <img
                class="scene-edit-header__action-icon scene-edit-header__action-icon--active"
                :src="saveActiveIcon"
                alt=""
                aria-hidden="true"
              />
            </button>
          </el-tooltip>
          <el-tooltip
            content="预览"
            placement="bottom"
            :show-after="160"
            popper-class="scene-edit-popover"
          >
            <button
              class="scene-edit-header__action"
              type="button"
              aria-label="预览"
              :disabled="!!editorSceneOperation"
              @click="emit('preview')"
            >
              <img
                class="scene-edit-header__action-icon scene-edit-header__action-icon--default"
                :src="previewDefaultIcon"
                alt=""
                aria-hidden="true"
              />
              <img
                class="scene-edit-header__action-icon scene-edit-header__action-icon--active"
                :src="previewActiveIcon"
                alt=""
                aria-hidden="true"
              />
            </button>
          </el-tooltip>
          <el-tooltip
            content="发布"
            placement="bottom"
            :show-after="160"
            popper-class="scene-edit-popover"
          >
            <button
              class="scene-edit-header__action"
              type="button"
              aria-label="发布"
              :disabled="!!editorSceneOperation"
              @click="emit('publish')"
            >
              <img
                class="scene-edit-header__action-icon scene-edit-header__action-icon--default"
                :src="publishDefaultIcon"
                alt=""
                aria-hidden="true"
              />
              <img
                class="scene-edit-header__action-icon scene-edit-header__action-icon--active"
                :src="publishActiveIcon"
                alt=""
                aria-hidden="true"
              />
            </button>
          </el-tooltip>
        </div>
        <span class="scene-edit-header__divider" aria-hidden="true"></span>
        <el-tooltip
          content="退出编辑器"
          placement="bottom"
          :show-after="160"
          popper-class="scene-edit-popover"
        >
          <button
            class="scene-edit-header__action scene-edit-header__action--exit"
            type="button"
            aria-label="退出编辑器"
            @click="emit('back')"
          >
            <img
              class="scene-edit-header__exit-icon scene-edit-header__action-icon--default"
              :src="exitIcon"
              alt=""
              aria-hidden="true"
            />
            <img
              class="scene-edit-header__exit-icon scene-edit-header__action-icon--active"
              :src="exitActiveIcon"
              alt=""
              aria-hidden="true"
            />
          </button>
        </el-tooltip>
      </div>
    </div>

    <!--
      第二行只承载左右面板页签。Figma 的中心工具栏属于场景槽位，
      已移动到 SceneEdit 中间画布容器的第一行，避免把画布操作误归入全局顶栏。
    -->
    <div class="scene-edit-nav">
      <nav class="scene-edit-nav__sections" aria-label="左侧面板导航">
        <button
          v-for="item in panelNavItems"
          :key="item.value"
          type="button"
          class="scene-edit-nav__section"
          :class="{ 'is-active': leftPanel === item.value }"
          @click="leftPanel = item.value"
        >
          <span>{{ item.label }}</span>
        </button>
      </nav>

      <div class="scene-edit-nav__center" aria-hidden="true"></div>

      <div class="scene-edit-mode-tabs" data-scene-right-panel="true" aria-label="属性面板模式">
        <button
          v-for="item in workspaceModes"
          :key="item.value"
          type="button"
          class="scene-edit-mode-tabs__item"
          :class="{ 'is-active': inspectorPanel === item.value }"
          @click="inspectorPanel = item.value"
        >
          <el-icon>
            <component :is="item.icon" />
          </el-icon>
          <span>{{ item.label }}</span>
        </button>
      </div>
    </div>
  </header>
</template>

<script setup lang="ts">
import SceneJsonUpload from './SceneJsonUpload/index.vue'
import { editorSceneOperation } from '@/integrations/scene/editorSceneOperationGate'
import { computed, onBeforeUnmount, onMounted, ref, watch, type Component } from 'vue'
import { useRoute } from 'vue-router'
import {
  Aim,
  Box,
  Cloudy,
  Connection,
  DataAnalysis,
  DataBoard,
  Monitor,
  Pointer,
} from '@element-plus/icons-vue'
import saveTemplateDefaultIcon from '@/assets/images/scene-header-actions/template-default.svg'
import saveTemplateActiveIcon from '@/assets/images/scene-header-actions/template-active.svg'
import saveDefaultIcon from '@/assets/images/scene-header-actions/save-default.svg'
import saveActiveIcon from '@/assets/images/scene-header-actions/save-active.svg'
import previewDefaultIcon from '@/assets/images/scene-header-actions/preview-default.svg'
import previewActiveIcon from '@/assets/images/scene-header-actions/preview-active.svg'
import publishDefaultIcon from '@/assets/images/scene-header-actions/publish-default.svg'
import publishActiveIcon from '@/assets/images/scene-header-actions/publish-active.svg'
import exitIcon from '@/assets/images/scene-header-actions/exit.svg'
import exitActiveIcon from '@/assets/images/scene-header-actions/exit-active.svg'
import { SCENE_PANEL_ENUM } from '../enum'
import {
  getDefaultSceneEditorBrandConfig,
  loadSceneEditorBrandConfig,
  resolveSceneEditorBrandAssetUrl,
} from '@/config/sceneEditorBrand'
import { SCENE_PANEL_ENUM as INSPECTOR_PANEL_ENUM } from '@/enums/scenePanelEnum'
import { useSceneStore } from '@/stores/sceneEditStore'
import { resolveWidgetPanelSelection } from '@/integrations/scene/widgetPanels'
import { subscribeActiveSceneViewportHost } from '@/integrations/scene/editorScenePlatformHost'
import type { SceneStore } from '@/scene-platform'
import {
  getSceneInspectorPanelItems,
  isSceneInspectorEffectType,
  resolveSceneInspectorRouteKind,
} from '../inspectorMode'

const route = useRoute()
const store = useSceneStore()
const brandConfig = ref(getDefaultSceneEditorBrandConfig())

const props = withDefaults(
  defineProps<{
    /** 请求未完成时禁用保存按钮，浏览器不会再次派发点击事件。 */
    saveDisabled?: boolean
    /** 保存中的无障碍状态和提示文案，与真实接口 Promise 生命周期保持一致。 */
    saveLoading?: boolean
    /** 已确认的编辑尚未写入服务端。 */
    saveDirty?: boolean
    /** 由统一编辑器能力模型控制；租户端不挂载该入口，也不渲染任何同类可操作节点。 */
    showSaveAsTemplate?: boolean
    /** 文件入口与统一能力模型一致；会话未就绪或失锁时禁止选择和应用。 */
    showImportSceneJson?: boolean
    importDisabled?: boolean
  }>(),
  {
    saveDisabled: false,
    saveLoading: false,
    showSaveAsTemplate: true,
    showImportSceneJson: false,
    importDisabled: true,
  },
)

const emit = defineEmits<{
  'save-template': []
  preview: []
  save: []
  publish: []
  back: []
  'before-import': []
  'after-import': []
  'scene-imported': []
}>()

// 页面标题优先使用路由中的真实场景名称，缺失时回退到品牌配置，避免为视觉对齐写死文案。
const projectName = computed(() => {
  const queryName = route.query.name
  const sceneName = Array.isArray(queryName) ? queryName[0] : queryName

  return String(sceneName || brandConfig.value.projectNameFallback)
})

const brandTitle = computed(() => `${brandConfig.value.softwareName} ${projectName.value}`)

const leftPanel = defineModel<SCENE_PANEL_ENUM>('leftPanel', { default: SCENE_PANEL_ENUM.Resource })
const inspectorPanel = defineModel<INSPECTOR_PANEL_ENUM>('inspectorPanel', {
  default: INSPECTOR_PANEL_ENUM.Base,
})

const panelNavItems = [
  { label: '系统资源', value: SCENE_PANEL_ENUM.Resource },
  { label: '我的资源', value: SCENE_PANEL_ENUM.MyResource },
  { label: '结构', value: SCENE_PANEL_ENUM.Structure },
]

const currentTransformMaterialUuid = computed(() => store.currentTransformMaterialUuid)
const currentObjectLayerId = computed(() => store.currentObjectLayerId)
const widgetPanelSelection = computed(() => resolveWidgetPanelSelection())
const scenePlatformStore = ref<SceneStore | null>(null)
const scenePlatformStoreRevision = ref(0)
let stopScenePlatformHostSubscription: (() => void) | null = null
let stopScenePlatformStoreSubscription: (() => void) | null = null

/**
 * 本地中国 3D 地图由独立 Presenter 绘制，旧编辑态可能先于 SceneStore 选中事件更新。
 * 允许用旧态编号反查平台对象，保证顶部页签与右侧内容使用同一效果路由。
 */
const isSelectedSceneEffect = computed(() => {
  void scenePlatformStoreRevision.value
  if (store.selectedThreeMapObjectId) return true
  // 创建入口为中国 3D 地图生成稳定的 three-map-* 编号；宿主事件尚未到达时不能回退场景页签。
  if (currentTransformMaterialUuid.value?.startsWith('three-map-')) return true
  const selectedObjectId = scenePlatformStore.value?.getSelectedObjectId()
  const selectedObject = selectedObjectId
    ? scenePlatformStore.value?.getObject(selectedObjectId)
    : null
  const legacySelectedObject = currentTransformMaterialUuid.value
    ? scenePlatformStore.value?.getObject(currentTransformMaterialUuid.value)
    : null
  const selectedEffectId = scenePlatformStore.value?.getSelectedEffectId()
  const selectedEffect = selectedEffectId
    ? scenePlatformStore.value?.getEffect(selectedEffectId)
    : null
  return Boolean(
    isSceneInspectorEffectType(selectedObject?.effect?.type) ||
      isSceneInspectorEffectType(legacySelectedObject?.effect?.type) ||
      isSceneInspectorEffectType(selectedEffect?.type),
  )
})

const panelRouteKind = computed(() =>
  // 顶部页签与右侧面板必须消费同一份效果选中态，否则热力场节点选中后顶部仍显示场景设置。
  resolveSceneInspectorRouteKind(
    widgetPanelSelection.value.kind,
    currentTransformMaterialUuid.value,
    currentObjectLayerId.value,
    isSelectedSceneEffect.value,
  ),
)

const workspaceModeIconMap: Partial<Record<INSPECTOR_PANEL_ENUM, Component>> = {
  [INSPECTOR_PANEL_ENUM.Base]: Monitor,
  [INSPECTOR_PANEL_ENUM.Camera]: Aim,
  [INSPECTOR_PANEL_ENUM.Weather]: Cloudy,
  /** 植被系统暂沿用原页签图标，避免引入未在项目中使用的图标资源。 */
  [INSPECTOR_PANEL_ENUM.Vegetation]: Connection,
  [INSPECTOR_PANEL_ENUM.Data]: DataBoard,
  [INSPECTOR_PANEL_ENUM.Animation]: Box,
  [INSPECTOR_PANEL_ENUM.Status]: DataAnalysis,
  [INSPECTOR_PANEL_ENUM.Interaction]: Pointer,
}

const workspaceModes = computed(() => {
  void scenePlatformStoreRevision.value
  return getSceneInspectorPanelItems(panelRouteKind.value).map((item) => ({
    ...item,
    icon: workspaceModeIconMap[item.value] || Monitor,
  }))
})

watch(
  workspaceModes,
  (modes) => {
    if (modes.length > 0 && !modes.some((item) => item.value === inspectorPanel.value)) {
      inspectorPanel.value = modes[0].value
    }
  },
  { immediate: true },
)

onMounted(async () => {
  // 品牌配置只在组件挂载时读取一次，避免顶部栏渲染期间重复查询配置文件。
  brandConfig.value = await loadSceneEditorBrandConfig()
  stopScenePlatformHostSubscription = subscribeActiveSceneViewportHost((host) => {
    stopScenePlatformStoreSubscription?.()
    scenePlatformStore.value = host?.getStore() ?? null
    scenePlatformStoreRevision.value += 1
    stopScenePlatformStoreSubscription =
      scenePlatformStore.value?.subscribe(() => {
        scenePlatformStoreRevision.value += 1
      }) ?? null
  })
})

onBeforeUnmount(() => {
  stopScenePlatformHostSubscription?.()
  stopScenePlatformStoreSubscription?.()
  stopScenePlatformHostSubscription = null
  stopScenePlatformStoreSubscription = null
})
</script>
