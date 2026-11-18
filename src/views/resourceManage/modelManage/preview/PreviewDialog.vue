<template>
  <el-dialog
    class="manage-dialog model-preview-dialog"
    :model-value="visible"
    destroy-on-close
    width="640px"
    align-center
    append-to-body
    :z-index="2200"
    :show-close="false"
    :close-on-click-modal="false"
    :close-on-press-escape="false"
    @opened="handleDialogOpened"
    @update:model-value="emit('update:visible', $event)"
  >
    <div class="model-preview-dialog__top">
      <span class="model-preview-dialog__title">{{ title }}</span>
      <button type="button" class="model-preview-dialog__close" aria-label="关闭预览" @click="close">
        <el-icon><Close /></el-icon>
      </button>
    </div>
    <div class="model-preview-dialog__content">
      <div class="model-preview-dialog__stage">
        <span class="model-preview-dialog__status" :class="statusClass">
          <i class="model-preview-dialog__status-dot" aria-hidden="true" />
          {{ statusLabel }}
        </span>
        <div ref="modelBoxRef" class="model-preview-dialog__canvas" />
        <div v-if="loading || errorMessage" class="model-preview-dialog__loading" :role="errorMessage ? 'alert' : 'status'">
          <span>{{ errorMessage || loadingMessage }}</span>
          <el-button v-if="errorMessage" size="small" @click="retryPreview">重新加载</el-button>
        </div>
        <div class="model-preview-dialog__hint">
          <button type="button" aria-label="恢复模型视角" :disabled="!modelReady" @click="resetView">
            <el-icon><Refresh /></el-icon>
          </button>
          <span>拖拽旋转·滚轮缩放·右键平移</span>
        </div>
      </div>
      <div class="model-preview-dialog__metadata">
        <template v-for="(item, index) in metadata" :key="item.label">
          <div class="model-preview-dialog__meta-item" :class="{ 'is-flexible': index >= 2 }">
            <span class="model-preview-dialog__meta-label">{{ item.label }}</span>
            <span class="model-preview-dialog__meta-value">{{ item.value }}</span>
          </div>
          <i v-if="index < metadata.length - 1" class="model-preview-dialog__meta-divider" aria-hidden="true" />
        </template>
      </div>
      <!-- 编辑能力由页面按平台与资源归属计算；租户端系统资源不挂载按钮及其空白操作区。 -->
      <div v-if="canEdit" class="model-preview-dialog__footer">
        <div class="model-preview-dialog__divider" />
        <el-button type="primary" @click="handleEdit">编辑模型</el-button>
      </div>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { Close, Refresh } from '@element-plus/icons-vue'
import RenderScene from './RenderScene'

interface Props {
  path: string
  /** 受管模型按稳定资源编号加载，旧模型继续使用资源详情返回的文件地址。 */
  resourceId?: string
  visible: boolean
  /** 资源详情解析失败由管理页传入，避免弹窗一直显示等待状态。 */
  sourceError?: string
  /** 与卡片共用同一份能力结果，禁止预览弹窗绕过租户端系统资源限制。 */
  canEdit: boolean
  record?: {
    name?: string
    modelName?: string
    category?: string
    resourceBelongName?: string
    resourceBelong?: string
    description?: string
    modelDesc?: string
    updateTime?: string
    status?: string
    statusLabel?: string
  }
}

const props = defineProps<Props>()
const emit = defineEmits(['update:visible', 'edit', 'retry'])

const title = computed(() => `${props.record?.name || props.record?.modelName || '模型'}·预览`)
const statusLabel = computed(() => {
  if (props.record?.statusLabel && props.record.statusLabel !== '--') return props.record.statusLabel
  return props.record?.status === 'OFFLINE' ? '已下线' : '已上线'
})
const statusClass = computed(() => (props.record?.status === 'OFFLINE' ? 'is-offline' : 'is-online'))

/** Figma 使用完整日期时间；预览弹窗单独规范化接口时间，避免原始时间带时区或毫秒导致列宽异常。 */
const formatPreviewDateTime = (value?: string) => {
  if (!value) return '--'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  const hours = `${date.getHours()}`.padStart(2, '0')
  const minutes = `${date.getMinutes()}`.padStart(2, '0')
  const seconds = `${date.getSeconds()}`.padStart(2, '0')
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
}

const metadata = computed(() => [
  { label: '模型分类', value: props.record?.category || '--' },
  {
    label: '模型归属',
    value: props.record?.resourceBelongName ||
      (props.record?.resourceBelong === 'MINE' ? '我的资源' : props.record?.resourceBelong === 'SYSTEM' ? '系统资源' : '--'),
  },
  { label: '模型描述', value: props.record?.modelDesc || props.record?.description || '--' },
  { label: '更新时间', value: formatPreviewDateTime(props.record?.updateTime) },
])
const close = () => emit('update:visible', false)
const handleEdit = () => { close(); emit('edit') }

const modelBoxRef = ref<HTMLElement>()
const loading = ref(true)
const loadingMessage = ref('正在准备网页播放器')
const renderError = ref('')
const modelReady = ref(false)
const errorMessage = computed(() => props.sourceError || renderError.value)
let renderer: RenderScene | null = null
let opened = false
let initialized = false
let generation = 0
let modelRequest = 0
let themeObserver: MutationObserver | null = null

/** 每次路径变化递增序号，关闭或切换后的旧错误和旧加载结果均不能写回弹窗。 */
const loadModel = async () => {
  const scene = renderer
  if (!scene || !props.visible) return
  const request = ++modelRequest
  modelReady.value = false
  renderError.value = ''
  loading.value = true
  try {
    if (!props.path && !props.resourceId) {
      loadingMessage.value = '正在读取模型资源'
      await scene.clearModel()
      return
    }
    const loaded = await scene.loadModel(props.path, props.resourceId)
    if (renderer === scene && request === modelRequest && props.visible && loaded) {
      modelReady.value = true
      loading.value = false
    }
  } catch (error) {
    if (renderer === scene && request === modelRequest && props.visible) {
      renderError.value = error instanceof Error ? error.message : '模型预览失败'
      loading.value = false
    }
  }
}

/** 弹窗打开动画结束后创建播放器，此时画布宽高有效，二次打开也会使用新的容器节点。 */
const handleDialogOpened = async () => {
  if (!props.visible || !modelBoxRef.value || renderer) return
  opened = true
  const currentGeneration = ++generation
  renderError.value = ''
  loading.value = true
  const scene = new RenderScene(modelBoxRef.value, (message) => {
    if (renderer === scene && props.visible) loadingMessage.value = message
  })
  renderer = scene
  // 观察器随每次视口创建，重试加载时也能重新监听主题。
  themeObserver = new MutationObserver(() => {
    void renderer?.updateBackground().catch(() => undefined)
  })
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-manage-theme'] })
  try {
    await scene.init()
    if (generation !== currentGeneration || !props.visible) return
    initialized = true
    await loadModel()
  } catch (error) {
    if (renderer === scene && props.visible) {
      renderError.value = error instanceof Error ? error.message : '网页播放器初始化失败'
      loading.value = false
    }
  }
}

/** 清理立即使回调失效；播放器退出由渲染适配器串行处理，快速重开也不会叠加实例。 */
const clearScene = () => {
  generation++
  modelRequest++
  opened = false
  initialized = false
  modelReady.value = false
  themeObserver?.disconnect()
  themeObserver = null
  const scene = renderer
  renderer = null
  if (scene) void scene.renderDestroy().catch(() => undefined)
}

const resetView = async () => {
  try { await renderer?.resetView() }
  catch (error) { renderError.value = error instanceof Error ? error.message : '视角恢复失败' }
}

const retryPreview = async () => {
  clearScene()
  if (props.sourceError) emit('retry')
  await nextTick()
  await handleDialogOpened()
}

// 初始化期间只保存最新路径，待播放器准备好后加载一次，避免详情请求先返回时重复下载。
watch(() => [props.path, props.resourceId], () => { if (opened && initialized) void loadModel() })
watch(() => props.visible, (visible) => { if (!visible) clearScene() })
onBeforeUnmount(clearScene)
</script>
<style scoped lang="scss">
/*
 * 模型预览遵循 Figma 的 640px 信息弹窗规格。
 * 弹窗壳体、展示区和底部操作区均采用固定尺寸，防止加载三维画布后引起页面布局跳动。
 */
:global(.model-preview-dialog.el-dialog) {
  width: min(640px, calc(100vw - 32px)) !important;
  max-height: min(800px, calc(100vh - 32px));

  /* Element Plus 的居中布局依赖自动外边距；禁止写成 0，否则弹窗会贴在遮罩左上角并被拉伸。 */
  margin: auto;
  overflow: hidden;

  /* 弹窗追加到 body 后仍通过管理页主题变量切换亮暗色。 */
  background: var(--manage-color-elevated, #ffffff) !important;
  border: 0 !important;
  border-radius: 8px;
  box-shadow: 0 12px 32px rgb(25 31 37 / 16%);
}

/* 暗色 Figma 节点的固定面板色：弹窗 #1d2a35、画布 #131c26。 */
:global(html[data-manage-theme='dark'] .model-preview-dialog.el-dialog) {
  background: #1d2a35 !important;
}
:global(html[data-manage-theme='dark'] .model-preview-dialog__stage) {
  --model-preview-background: #131c26;
}

/* 预览弹窗是纯白 Figma 面板，不叠加管理页旧版的渐变装饰层。 */
:global(.model-preview-dialog.el-dialog::before) {
  display: none;
}

/* Element Plus 默认标题区域不参与本弹窗布局，所有标题与关闭操作由设计稿结构统一承载。 */
:global(.model-preview-dialog .el-dialog__header) {
  display: none;
}
:global(.model-preview-dialog .el-dialog__body) {
  max-height: min(800px, calc(100vh - 32px));

  /* 覆盖管理页公共弹窗的 20px 内边距，Figma 的 24px 只属于内容容器本身。 */
  padding: 0 !important;
  overflow: hidden auto;
}
.model-preview-dialog__top {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 48px;
  padding: 0 8px 0 24px;
  border-bottom: 1px solid var(--manage-color-line, #e5e7eb);
}
.model-preview-dialog__title {
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: 'Source Han Sans SC', 'Noto Sans SC', sans-serif;
  font-size: 16px;
  font-weight: 500;
  line-height: 24px;
  color: var(--manage-color-text-primary, #1f2937);
  white-space: nowrap;
}
.model-preview-dialog__close {
  display: inline-flex;
  flex: 0 0 32px;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  font-size: 18px;
  color: var(--manage-color-text-secondary, #6b7280);
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: 4px;
}
.model-preview-dialog__close:hover {
  color: var(--manage-color-text-primary, #1f2937);
  background: var(--manage-color-button-hover-surface, #f3f4f6);
}
.model-preview-dialog__content {
  box-sizing: border-box;
  min-width: 0;
  padding: 24px;
}
.model-preview-dialog__stage {
  position: relative;
  width: 100%;
  height: 402px;
  overflow: hidden;
  background: var(--model-preview-background);
  border-radius: 8px;

  /* 亮色复用管理页的浅灰内层面板色，与白色弹窗区分；播放器读取同一变量同步清屏色。
   * 暗色仍由上方主题选择器覆盖，避免输入框的纯白背景抹掉预览区域层次。 */
  --model-preview-background: var(--manage-color-panel-deep, #f6f8f9);
}
.model-preview-dialog__canvas {
  width: 100%;
  height: 100%;
}

/* 画布由网页播放器动态生成；块级显示可消除画布基线带来的底部空隙。 */
.model-preview-dialog__canvas :deep(canvas) {
  display: block;
  width: 100% !important;
  height: 100% !important;
}
.model-preview-dialog__status {
  position: absolute;
  top: 10px;
  right: 10px;
  z-index: 1;
  box-sizing: border-box;
  display: inline-flex;
  gap: 4px;
  align-items: center;
  justify-content: center;
  min-width: 62px;
  height: 24px;
  padding: 2px 8px;
  font-family: 'Source Han Sans SC', 'Noto Sans SC', sans-serif;
  font-size: 12px;
  line-height: 18px;
  border: 1px solid transparent;
  border-radius: 8px;
}
.model-preview-dialog__status.is-online {
  color: #73c74f;
  background: #e6fcef;
  border-color: #e2f4d8;
}
.model-preview-dialog__status.is-offline {
  color: #f05b50;
  background: #fff1f0;
  border-color: #ffd8d5;
}
.model-preview-dialog__status-dot {
  flex: 0 0 4px;
  width: 4px;
  height: 4px;
  background: currentcolor;
  border-radius: 50%;
}
.model-preview-dialog__loading {
  position: absolute;
  top: 50%;
  left: 50%;
  font-size: 14px;
  line-height: 20px;
  color: var(--manage-color-text-secondary, #6b7280);
  transform: translate(-50%, -50%);
  z-index: 2;
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-items: center;
  width: calc(100% - 48px);
  text-align: center;
}
.model-preview-dialog__hint {
  position: absolute;
  bottom: 9px;
  left: 50%;
  display: inline-flex;
  gap: 4px;
  align-items: center;
  height: 28px;
  padding: 0 8px;
  font-family: 'Source Han Sans SC', 'Noto Sans SC', sans-serif;
  font-size: 12px;
  line-height: 18px;
  color: var(--manage-color-text-secondary, #666666);
  z-index: 1;
  background: var(--manage-color-elevated, #ffffff);
  border-radius: 12px;
  transform: translateX(-50%);
}
.model-preview-dialog__hint button {
  display: inline-flex;
  padding: 0;
  color: inherit;
  cursor: pointer;
  background: transparent;
  border: 0;
}
.model-preview-dialog__hint button:disabled { cursor: default; opacity: .5; }
.model-preview-dialog__metadata {
  display: flex;
  gap: 12px;
  align-items: stretch;
  width: 100%;
  min-width: 0;
  min-height: 57px;
  margin-top: 12px;
}
.model-preview-dialog__meta-item {
  box-sizing: border-box;
  display: flex;
  flex: 0 0 100px;
  flex-direction: column;
  gap: 2px;
  align-items: flex-start;
  min-width: 0;
  padding: 8px;
  text-align: left;
}

/* Figma 的第三、第四列由剩余空间平分，避免固定列宽造成分隔线漂移。 */
.model-preview-dialog__meta-item.is-flexible {
  flex: 1 1 0;
}

/* 分隔符作为独立布局节点，占用真实宽度并垂直居中，位置与 Figma 一致。 */
.model-preview-dialog__meta-divider {
  flex: 0 0 1px;
  align-self: center;
  width: 1px;
  height: 30px;
  background: var(--manage-color-line, #e5e5e5);
}
.model-preview-dialog__meta-label {
  font-family: 'Source Han Sans SC', 'Noto Sans SC', sans-serif;
  font-size: 12px;
  line-height: 18px;
  color: var(--manage-color-text-tertiary, #999999);
}
.model-preview-dialog__meta-value {
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: 'Source Han Sans SC', 'Noto Sans SC', sans-serif;
  font-size: 14px;
  line-height: 20px;
  color: var(--manage-color-text-primary, #333333);
  white-space: nowrap;
}

/* 更新时间按 Figma 原样完整展示，不用省略号截断；列宽已预留足够空间。 */
.model-preview-dialog__meta-item:last-of-type .model-preview-dialog__meta-value {
  overflow: visible;
  text-overflow: clip;
}
.model-preview-dialog__footer {
  display: flex;
  flex-direction: column;
  gap: 16px;
  align-items: flex-end;
  margin-top: 12px;
}
.model-preview-dialog__divider {
  width: 100%;
  height: 1px;
  background: var(--manage-color-line, #e5e7eb);
}
.model-preview-dialog__footer :deep(.el-button) {
  min-width: 88px;
  height: 32px;
  margin: 0;
  font-family: 'Source Han Sans SC', 'Noto Sans SC', sans-serif;
  border-radius: 4px;
}
.model-preview-dialog__footer :deep(.el-button--primary) {
  color: #ffffff;
  background: #51a195;
  border-color: #51a195;
}

@media (width <= 680px) {
  .model-preview-dialog__content {
    padding: 16px;
  }
  .model-preview-dialog__stage {
    height: min(402px, calc((100vw - 64px) * 0.679));
  }
  .model-preview-dialog__metadata {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px 12px;
  }
  .model-preview-dialog__meta-item,
  .model-preview-dialog__meta-item.is-flexible {
    flex: none;
    width: auto;
    padding: 8px;
  }
  .model-preview-dialog__meta-divider {
    display: none;
  }
}
</style>
