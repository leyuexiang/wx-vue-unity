<template>
  <el-dialog
    class="manage-dialog player-folder-dialog"
    :model-value="visible"
    :title="`选择${versionLabel}播放器文件夹`"
    width="680px"
    align-center
    :close-on-click-modal="false"
    @update:model-value="emit('update:visible', $event)"
  >
    <div class="player-folder-dialog__browser">
      <!-- 目录来自当前部署的网关，公共资源根目录在开发和发布环境使用同一相对路径语义。 -->
      <nav class="player-folder-dialog__breadcrumbs" aria-label="文件夹路径">
        <button type="button" :disabled="loading" @click="navigate('')">公共资源目录</button>
        <template v-for="crumb in breadcrumbs" :key="crumb.path">
          <span aria-hidden="true">/</span>
          <button type="button" :disabled="loading" @click="navigate(crumb.path)">{{ crumb.name }}</button>
        </template>
      </nav>
      <div class="player-folder-dialog__toolbar">
        <span>请选择包含构建文件的 <code>player</code> 文件夹</span>
        <el-button size="small" :disabled="loading || !currentPath" @click="navigate(parentPath)">上一级</el-button>
      </div>
      <div v-if="error" class="player-folder-dialog__error" role="alert">{{ error }}</div>
      <div v-loading="loading" class="player-folder-dialog__folders" aria-label="文件夹列表" :aria-busy="loading">
        <button
          v-for="directory in listing?.directories || []"
          :key="directory.path"
          class="player-folder-dialog__folder"
          type="button"
          :disabled="loading"
          :aria-label="`打开文件夹 ${directory.name}`"
          @click="navigate(directory.path)"
        >
          <el-icon><FolderOpened /></el-icon>
          <span>{{ directory.name }}</span>
          <el-icon class="player-folder-dialog__arrow"><ArrowRight /></el-icon>
        </button>
        <p v-if="!loading && listing && !listing.directories.length" class="player-folder-dialog__empty">此文件夹没有子文件夹</p>
      </div>
      <div class="player-folder-dialog__selection">
        <span>当前文件夹</span>
        <code>{{ currentPath || '公共资源目录' }}</code>
      </div>
      <p class="player-folder-dialog__status" :class="{ 'is-ready': listing?.selection.ready }" role="status">
        <el-icon><CircleCheckFilled v-if="listing?.selection.ready" /><InfoFilled v-else /></el-icon>
        {{ listing?.selection.message || '请进入需要使用的 player 文件夹' }}
      </p>
    </div>
    <template #footer>
      <el-button @click="emit('update:visible', false)">取消</el-button>
      <el-button type="primary" :disabled="loading || !listing?.selection.ready || Boolean(error)" @click="select">选择此文件夹</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { ArrowRight, CircleCheckFilled, FolderOpened, InfoFilled } from '@element-plus/icons-vue'
import { webgpuPackageApi, type WebPackageDirectories } from '@/config/webgpuPackages'

const props = defineProps<{ visible: boolean; initialPath: string; versionLabel: string }>()
const emit = defineEmits<{
  'update:visible': [visible: boolean]
  select: [path: string]
}>()
const listing = ref<WebPackageDirectories | null>(null)
const currentPath = ref('')
const loading = ref(false)
const error = ref('')
let requestController: AbortController | undefined
const parentPath = computed(() => currentPath.value.split('/').slice(0, -1).join('/'))
const breadcrumbs = computed(() => {
  const segments = currentPath.value.split('/').filter(Boolean)
  return segments.map((name, index) => ({ name, path: segments.slice(0, index + 1).join('/') }))
})

/** 每次只加载当前层，切换目录或关闭弹窗立即中止旧请求，迟到响应不会覆盖新选择。 */
async function navigate(path: string) {
  requestController?.abort()
  const controller = new AbortController()
  requestController = controller
  loading.value = true
  error.value = ''
  try {
    const result = await webgpuPackageApi.directories(path, controller.signal)
    if (controller.signal.aborted) return
    listing.value = result
    currentPath.value = result.path
  } catch (cause) {
    if (controller.signal.aborted) return
    error.value = cause instanceof Error ? cause.message : '文件夹暂时无法读取'
  } finally {
    if (requestController === controller) loading.value = false
  }
}

/** 网关确认播放器与配套资源可用后才回填，弹窗确认仅修改草稿，仍由页面统一保存生效。 */
function select() {
  if (loading.value || error.value || !listing.value?.selection.ready) return
  emit('select', listing.value.path)
  emit('update:visible', false)
}

watch(() => props.visible, visible => {
  requestController?.abort()
  if (!visible) return
  listing.value = null
  currentPath.value = ''
  void navigate(props.initialPath)
}, { immediate: true })
onBeforeUnmount(() => requestController?.abort())
</script>

<style scoped lang="scss">
/* 目录弹窗沿用管理页主题变量，列表只呈现文件夹，固定滚动区避免目录较多时撑出屏幕。 */
.player-folder-dialog__browser { color: var(--manage-text); }
.player-folder-dialog__breadcrumbs { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 12px; background: var(--manage-color-active); border-radius: 4px; }
.player-folder-dialog__breadcrumbs button { padding: 2px 0; border: 0; color: var(--manage-accent); background: transparent; font: inherit; cursor: pointer; }
.player-folder-dialog__breadcrumbs button:disabled { cursor: wait; }
.player-folder-dialog__toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 16px 0 12px; color: var(--manage-text-2); font-size: 13px; }
.player-folder-dialog__folders { height: min(280px, 35vh); overflow-y: auto; border: 1px solid var(--manage-line); border-radius: 6px; }
.player-folder-dialog__folder { display: flex; align-items: center; gap: 10px; width: 100%; padding: 13px 16px; text-align: left; color: var(--manage-text); background: transparent; border: 0; border-bottom: 1px solid var(--manage-line); cursor: pointer; font: inherit; }
.player-folder-dialog__folder:hover, .player-folder-dialog__folder:focus-visible { background: var(--manage-color-active); }
.player-folder-dialog__folder > .el-icon:first-child { color: var(--manage-accent); }
.player-folder-dialog__arrow { margin-left: auto; color: var(--manage-text-2); }
.player-folder-dialog__empty { padding: 24px 16px; color: var(--manage-text-2); text-align: center; }
.player-folder-dialog__selection { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 16px; font-size: 13px; }
.player-folder-dialog__selection span { color: var(--manage-text-2); }
.player-folder-dialog__selection code { overflow-wrap: anywhere; }
.player-folder-dialog__status { display: flex; align-items: center; gap: 6px; margin: 12px 0 0; color: var(--manage-text-2); font-size: 13px; line-height: 1.6; }
.player-folder-dialog__status .el-icon { flex-shrink: 0; }
.player-folder-dialog__status.is-ready { color: var(--manage-accent); }
.player-folder-dialog__error { margin-bottom: 12px; color: var(--manage-danger); font-size: 13px; }
:global(.player-folder-dialog.el-dialog) { max-width: calc(100vw - 32px); }
</style>
