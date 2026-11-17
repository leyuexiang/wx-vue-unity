<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from 'vue'
import { authContext } from '@/auth/authContext'
import { createDim3dSceneClientKey } from '@/servers/manual/dim3d/api/scene'
import { createFixedPublicationDialogController } from '@/integrations/scene/fixedPublicationDialogController'
import { fixedPublicationPath, getFixedPublicationCapabilities, getPublicationScene, issuePublicationTicket, publishCurrentScene, revokePublicationTicket } from '@/integrations/scene/fixedPublicationManagement'

const props = defineProps<{ modelValue: boolean; sceneId: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean]; published: [] }>()
const controller = createFixedPublicationDialogController({ capabilities: getFixedPublicationCapabilities, scene: getPublicationScene, publish: publishCurrentScene, issue: issuePublicationTicket, revokeTicket: revokePublicationTicket, requestId: createDim3dSceneClientKey })
const state = controller.state
const url = computed(() => state.publication ? new URL(fixedPublicationPath(state.publication.publicationId), window.location.origin).href : '')
const close = () => { controller.close(); emit('update:modelValue', false) }
watch([() => props.modelValue, () => props.sceneId], ([visible, id]) => {
  if (visible && id) void controller.load(id)
  else controller.close()
}, { immediate: true })
const unsubscribe = authContext.subscribe(() => {
  // 身份切换即清除原租户凭证，不保留在仍显示的发布窗口内。
  if (props.modelValue) close()
})
onBeforeUnmount(() => { unsubscribe(); controller.close() })
const publish = async () => { if (await controller.publish()) emit('published') }
const copy = async (value: string) => {
  try { await navigator.clipboard.writeText(value) }
  catch { state.error = '剪贴板不可用，请手动选择并复制' }
}
</script>

<template>
  <el-dialog :model-value="modelValue" title="发布场景" width="560px" :close-on-click-modal="false" :close-on-press-escape="!state.busy" :show-close="!state.busy" @close="close">
    <div v-loading="state.loading" class="fixed-publication-dialog">
      <p v-if="state.sceneName">场景：{{ state.sceneName }}</p>
      <p v-if="state.revisionNo">已保存版本：{{ state.revisionNo }}</p>
      <p v-if="state.capabilities">访问方式：{{ state.capabilities.accessModes[0]?.label }}</p>
      <template v-if="!state.publication">
        <p>发布将固定已保存的场景及资源。后续编辑不会改变此发布版本。</p>
        <p>访问者使用短期只读凭证打开；物联网实时状态还需要对应租户登录及权限。</p>
      </template>
      <template v-else>
        <p role="status">{{ state.publication.alreadyPublished ? '该保存版本已发布' : '发布成功' }}</p>
        <p>发布编号：{{ state.publication.publicationId }}</p>
        <label>固定版本链接</label>
        <el-input :model-value="url" readonly aria-label="固定版本链接">
          <template #append><el-button @click="copy(url)">复制链接</el-button></template>
        </el-input>
        <p>链接不包含访问凭证。需要分享时，请分别发送链接和凭证。</p>
        <label>凭证有效期（秒）</label>
        <el-input-number v-model="state.seconds" :min="state.capabilities?.ticketMinSeconds || 60" :max="state.capabilities?.ticketMaxSeconds || 3600" :disabled="state.busy" aria-label="凭证有效期（秒）" />
        <el-button :loading="state.busy" @click="controller.issue">{{ state.ticket ? '重新生成凭证' : '生成访问凭证' }}</el-button>
        <template v-if="state.ticket">
          <label>短期只读凭证</label>
          <el-input :model-value="state.ticket.token" readonly type="password" show-password aria-label="短期只读凭证" />
          <p>有效至 {{ new Date(state.ticketExpiresAt).toLocaleTimeString() }}，关闭窗口后不再保留。重新生成不会撤销此前已分享的凭证。</p>
          <el-button @click="copy(state.ticket.token)">复制凭证</el-button>
          <el-button :disabled="state.busy" @click="controller.revokeTicket">撤销此凭证</el-button>
        </template>
      </template>
      <p v-if="state.error" role="alert" class="fixed-publication-dialog__error">{{ state.error }}</p>
      <el-button v-if="state.error && !state.publication" :disabled="state.busy" @click="controller.load(sceneId)">重新读取版本</el-button>
    </div>
    <template #footer>
      <el-button :disabled="state.busy" @click="close">关闭</el-button>
      <el-button v-if="!state.publication" type="primary" :loading="state.busy" :disabled="state.loading || !state.capabilities || !state.revisionNo" @click="publish">{{ state.error ? '重试发布' : '确认发布' }}</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.fixed-publication-dialog { display: grid; gap: 12px; }
.fixed-publication-dialog p { margin: 0; line-height: 1.6; }
.fixed-publication-dialog__error { color: var(--el-color-danger); }
</style>
