<template>
  <div class="manage-page manage-theme manage-list-page config-page">
    <ManagePageTopBar title="配置管理" breadcrumb="系统管理/配置管理">
      <template #actions>
        <el-button :disabled="busy" @click="reload">重新加载</el-button>
        <el-button type="primary" :loading="saving" :disabled="busy || !dirty" @click="save">保存并生效</el-button>
      </template>
    </ManagePageTopBar>

    <section v-loading="loading" class="manage-resource-content-panel config-page__panel" aria-label="系统配置">
      <!-- 分类与配置正文分离，后续增加配置类型时可在此扩展，无需修改管理布局。 -->
      <nav class="config-page__categories" aria-label="配置分类">
        <span class="config-page__category" aria-current="page"><el-icon><Box /></el-icon>网页渲染包</span>
      </nav>
      <div class="config-page__content">
        <div class="config-page__intro">
          <div>
            <h1>网页渲染包配置</h1>
            <p>管理网页图形处理器（WebGPU）资源包，在稳定版本与研发版本之间切换。</p>
          </div>
          <span v-if="saved" class="config-page__current">当前生效：{{ channelName(saved.active) }}</span>
        </div>

        <div v-if="error" class="config-page__error" role="alert">{{ error }}</div>
        <template v-if="saved">
          <div class="config-page__notice">
            <el-icon><InfoFilled /></el-icon>
            <span>选择版本后点击“保存并生效”。配置对所有用户生效，已打开的场景继续使用原版本。</span>
          </div>

          <fieldset class="config-page__versions" :disabled="busy">
            <legend class="config-page__legend">选择使用的资源包</legend>
            <article v-for="channel in channels" :key="channel.key" class="config-page__version" :class="{ 'is-selected': draft.active === channel.key }">
              <div class="config-page__version-heading">
                <label class="config-page__version-choice">
                  <input v-model="draft.active" type="radio" name="webgpu-version" :value="channel.key" />
                  <span>{{ channel.label }}</span>
                </label>
                <span v-if="saved.active === channel.key" class="config-page__badge">生效中</span>
              </div>
              <p class="config-page__description">{{ channel.description }}</p>
              <label class="config-page__path-label" :for="`package-${channel.key}`">播放器文件夹</label>
              <!-- 位置由目录弹窗回填为相对路径，输入框只供查看与复制，避免手填时选错目录层级。 -->
              <div class="config-page__path">
                <el-input
                  :id="`package-${channel.key}`"
                  :model-value="draft.packages[channel.key]"
                  :disabled="busy"
                  placeholder="请选择 player 文件夹"
                  readonly
                  @click="openFolderDialog(channel.key)"
                  @keydown.enter.prevent="openFolderDialog(channel.key)"
                >
                  <template #prefix><el-icon><FolderOpened /></el-icon></template>
                </el-input>
                <el-button :disabled="busy" :aria-label="`选择${channel.label}文件夹`" @click="openFolderDialog(channel.key)">选择文件夹</el-button>
              </div>
              <button v-if="draft.packages[channel.key] && draft.active !== channel.key" class="config-page__clear" type="button" :disabled="busy" @click="setFolder(channel.key, '')">清除选择</button>
              <div class="config-page__check" :class="{ 'is-ready': checks[channel.key]?.ready }" role="status">
                <el-icon v-if="checks[channel.key]?.ready"><CircleCheckFilled /></el-icon>
                <el-icon v-else><InfoFilled /></el-icon>
                <span>{{ checks[channel.key]?.message || '路径已修改，等待检查' }}</span>
              </div>
            </article>
          </fieldset>

          <div class="config-page__actions">
            <el-button :disabled="busy" :loading="checking" @click="check">检查资源包</el-button>
            <span>{{ dirty ? '有未保存的配置' : '配置已同步' }}</span>
          </div>
          <div class="config-page__guide">
            <h2>资源包放置说明</h2>
            <p>点击“选择文件夹”，进入需要使用的 <code>player</code> 目录后确认。位置自动保存为相对路径，例如 <code>unity-web/player</code>。</p>
            <p>弹窗浏览当前项目的公共资源目录，开发时对应 <code>public</code>。播放器目录包含 <code>Build</code>，上一级保留配套的 <code>art</code> 和 <code>ArtStartupRelease.json</code>。</p>
            <p>切换前请将完整资源包放入对应目录。研发版本暂未准备时，可留空；已打开场景使用的目录请保留。</p>
          </div>
        </template>
        <el-empty v-else-if="!loading" description="暂时无法读取配置，请确认网页渲染网关已启动后重新加载" />
      </div>
    </section>
    <PlayerFolderDialog
      v-model:visible="folderDialogVisible"
      :initial-path="draft.packages[folderChannel]"
      :version-label="channelName(folderChannel)"
      @select="setFolder(folderChannel, $event)"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Box, CircleCheckFilled, FolderOpened, InfoFilled } from '@element-plus/icons-vue'
import ManagePageTopBar from '@/views/manageShared/ManagePageTopBar.vue'
import PlayerFolderDialog from './PlayerFolderDialog.vue'
import { webgpuPackageApi, type WebPackageChannel, type WebPackageChecks, type WebPackageDraft, type WebPackageSettings } from '@/config/webgpuPackages'

defineOptions({ name: 'ConfigManage' })
const channels = [
  { key: 'stable', label: '稳定版本', description: '用于日常使用和正式交付的资源包。' },
  { key: 'development', label: '研发版本', description: '用于新功能验证和研发联调的资源包。' },
] as const
const channelName = (key: WebPackageChannel) => key === 'stable' ? '稳定版本' : '研发版本'
const saved = ref<WebPackageSettings | null>(null)
const draft = ref<WebPackageDraft>({ active: 'stable', packages: { stable: '', development: '' }, revision: '' })
const checks = ref<Partial<WebPackageChecks>>({})
const loading = ref(false)
const saving = ref(false)
const checking = ref(false)
const error = ref('')
const folderDialogVisible = ref(false)
const folderChannel = ref<WebPackageChannel>('stable')
const busy = computed(() => loading.value || saving.value || checking.value)
/** 草稿和生效状态分开持有，失败时保留用户输入，也不把单选操作误显示为已经生效。 */
const dirty = computed(() => Boolean(saved.value && (draft.value.active !== saved.value.active ||
  channels.some(({ key }) => draft.value.packages[key] !== saved.value!.packages[key]))))
const apply = (value: WebPackageSettings) => {
  saved.value = value
  draft.value = { active: value.active, packages: { ...value.packages }, revision: value.revision }
  checks.value = value.checks
}
/** 目录选择仅改动目标版本的草稿，保留另一个版本及服务器当前生效状态。 */
function openFolderDialog(key: WebPackageChannel) {
  if (busy.value) return
  folderChannel.value = key
  folderDialogVisible.value = true
}
function setFolder(key: WebPackageChannel, path: string) {
  draft.value.packages[key] = path
  // 非空路径只可能来自弹窗中已通过网关完整检查的选择，直接显示该次检查结果。
  if (path) checks.value[key] = { ready: true, message: '资源包检查通过' }
  else delete checks.value[key]
}
const report = (cause: unknown) => { error.value = cause instanceof Error ? cause.message : '配置服务暂时不可用' }
/** 仅丢弃尚未保存的输入需要确认，正常保存和版本切换不增加额外弹窗。 */
const canDiscard = async () => {
  if (!dirty.value) return true
  try {
    await ElMessageBox.confirm('当前有未保存的配置，是否放弃修改？', '未保存的配置', {
      customClass: 'manage-message-box', confirmButtonText: '放弃修改', cancelButtonText: '继续编辑',
    })
    return true
  } catch { return false }
}
const reload = async () => {
  if (busy.value || !(await canDiscard())) return
  loading.value = true
  error.value = ''
  try { apply(await webgpuPackageApi.load()) }
  catch (cause) { report(cause) }
  finally { loading.value = false }
}
const check = async () => {
  if (busy.value) return
  checking.value = true
  error.value = ''
  try { checks.value = (await webgpuPackageApi.check(draft.value)).checks }
  catch (cause) { report(cause) }
  finally { checking.value = false }
}
const save = async () => {
  if (busy.value || !dirty.value) return
  saving.value = true
  error.value = ''
  try {
    apply(await webgpuPackageApi.save(draft.value))
    ElMessage.success(`配置已保存，后续打开的场景使用${channelName(draft.value.active)}`)
  } catch (cause) { report(cause) }
  finally { saving.value = false }
}
// 路由离开时保护未保存草稿；保存请求中禁止离开，避免用户误判配置是否已生效。
onBeforeRouteLeave(async () => !saving.value && await canDiscard())
onMounted(reload)
</script>

<style scoped lang="scss">
/* 全部颜色取自管理主题，结构沿用现有白底面板、青绿色选中态和亮暗主题。 */
.config-page__panel { flex-direction: row; gap: 0; padding: 0; }
.config-page__categories { width: 196px; flex-shrink: 0; padding: 24px 16px; border-right: 1px solid var(--manage-line); }
.config-page__category { display: flex; align-items: center; gap: 10px; padding: 12px; color: var(--manage-accent); background: var(--manage-color-active); border-radius: 6px; font-size: 14px; }
.config-page__content { flex: 1; min-width: 0; padding: 28px 32px; overflow-y: auto; color: var(--manage-text); }
.config-page__intro { display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 16px; margin-bottom: 24px; }
h1 { margin: 0 0 10px; font-size: 18px; font-weight: 400; }
.config-page__intro p, .config-page__description, .config-page__guide p { margin: 0; font-size: 13px; line-height: 1.8; color: var(--manage-text-2); }
.config-page__current, .config-page__badge { padding: 5px 10px; color: var(--manage-accent); background: var(--manage-color-active); border-radius: 4px; font-size: 12px; white-space: nowrap; }
.config-page__notice { display: flex; gap: 8px; align-items: center; padding: 12px 16px; margin-bottom: 24px; background: var(--manage-color-active); color: var(--manage-text-2); border-radius: 6px; font-size: 13px; line-height: 1.6; }
.config-page__notice .el-icon { color: var(--manage-accent); flex-shrink: 0; }
.config-page__versions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; padding: 0; border: 0; margin: 0; }
.config-page__legend { margin-bottom: 14px; font-size: 14px; }
.config-page__version { min-width: 0; padding: 20px; border: 1px solid var(--manage-line); border-radius: 8px; transition: border-color .15s; }
.config-page__version.is-selected { border-color: var(--manage-accent); }
.config-page__version-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 28px; }
.config-page__version-choice { display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 15px; }
.config-page__version-choice input { margin: 0; width: 16px; height: 16px; accent-color: var(--manage-accent); }
.config-page__description { margin: 10px 0 22px; }
.config-page__path-label { display: block; margin-bottom: 10px; font-size: 13px; color: var(--manage-text-2); }
.config-page__path { display: flex; gap: 10px; align-items: center; }
.config-page__path .el-input { flex: 1; min-width: 0; }
.config-page__clear { margin-top: 10px; padding: 0; border: 0; color: var(--manage-accent); background: transparent; font: inherit; font-size: 12px; cursor: pointer; }
.config-page__check { display: flex; align-items: center; gap: 6px; margin-top: 12px; min-height: 20px; font-size: 12px; color: var(--manage-text-2); }
.config-page__check.is-ready { color: var(--manage-accent); }
.config-page__check .el-icon { flex-shrink: 0; }
.config-page__actions { display: flex; align-items: center; gap: 14px; margin: 22px 0 32px; color: var(--manage-text-2); font-size: 12px; }
.config-page__guide { border-top: 1px solid var(--manage-line); padding-top: 22px; }
.config-page__guide h2 { font-size: 14px; font-weight: 400; margin: 0 0 12px; }
.config-page__guide p + p { margin-top: 8px; }
.config-page__guide code { padding: 2px 5px; border-radius: 3px; background: var(--manage-color-active); color: var(--manage-text); overflow-wrap: anywhere; }
.config-page__error { margin-bottom: 20px; padding: 12px 16px; color: var(--manage-danger); background: var(--manage-color-danger-soft); border-radius: 6px; font-size: 13px; }
@media (max-width: 1100px) {
  .config-page__categories { width: 160px; padding: 20px 12px; }
  .config-page__content { padding: 24px; }
  .config-page__versions { grid-template-columns: 1fr; }
}
@media (max-width: 700px) {
  .config-page__panel { flex-direction: column; }
  .config-page__categories { width: auto; padding: 12px; border-right: 0; border-bottom: 1px solid var(--manage-line); }
  .config-page__content { padding: 18px; }
}
</style>
