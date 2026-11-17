<template>
  <div class="manage-page manage-theme management-access">
    <el-empty description="当前账号暂无可用的管理菜单">
      <p>请联系管理员检查菜单、角色及租户套餐配置，或刷新权限重试。</p>
      <el-button type="primary" :loading="loading" @click="retry">刷新权限</el-button>
      <p v-if="error" role="alert">{{ error }}</p>
    </el-empty>
  </div>
</template>
<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { loadManagementMenus } from '@/auth/loadManagementMenus'
import { getManagementFallbackRoute } from '@/auth/managementNavigation'
import { DIM3D_ADMIN_API } from '@/servers/manual/dim3d/api/constants'
const router = useRouter()
const loading = ref(false), error = ref('')
/** 空菜单页不请求业务数据；参考身份刷新重新走其原有资料接口，不猜测菜单地址。 */
async function retry() {
  if (loading.value) return
  if (!DIM3D_ADMIN_API) { window.location.reload(); return }
  loading.value = true; error.value = ''
  try {
    await loadManagementMenus(true)
    const name = getManagementFallbackRoute()
    if (name === 'managementAccess') error.value = '尚未取得可用菜单，请检查网络或联系管理员完成授权'
    else await router.replace({ name })
  } finally { loading.value = false }
}
</script>
<style scoped>
.management-access { align-items: center; justify-content: center; color: var(--manage-color-text-primary); }
.management-access p { max-width: 480px; padding: 8px 16px; color: var(--manage-color-text-secondary); line-height: 1.8; }
</style>
