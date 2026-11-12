<script setup lang="ts">
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import { useAppStore } from './stores/appStore'
import {
  clearAuthenticationRuntime,
  initializeAuthentication,
  initializeTabAuthentication,
  isEmbeddedMode,
} from '@/auth/runtime'
import { handleLoginRedirect } from '@/utils/auth'
import { restoreStandalone } from '@/auth/standalone'
import StandaloneLogin from '@/views/StandaloneLogin.vue'
import { redirectScenePreviewToTenantLogin } from '@/auth/scenePreviewLoginRedirect'
import router from '@/router'
import { canAccessManagementRoute, isManagementRouteName, getManagementFallbackRoute } from '@/auth/managementNavigation'
import { loadManagementMenus } from '@/auth/loadManagementMenus'

const appStore = useAppStore()
const authReady = ref(false)
const authError = ref('')
const showStandaloneLogin = ref(false)
const editorAuthExpired = ref(false)
const isEditorTab = computed(() => window.location.pathname.endsWith('/sceneEdit'))
const isPreviewTab = computed(() => window.location.pathname.endsWith('/scenePreview'))
let previewAuthExpiryTimer: ReturnType<typeof setTimeout> | undefined

const schedulePreviewAuthExpiryRedirect = (context: Readonly<{ expiresAt?: number }> | null) => {
  if (!context?.expiresAt) return

  const checkExpiration = () => {
    const remaining = context.expiresAt! - Date.now()
    if (remaining <= 0) {
      redirectScenePreviewToTenantLogin()
      return
    }
    // 浏览器单次定时器存在 32 位上限，超长有效期按上限分段复查。
    previewAuthExpiryTimer = setTimeout(checkExpiration, Math.min(remaining, 2_147_483_647))
  }
  checkExpiration()
}

const handleEditorAuthExpired = () => {
  if (isPreviewTab.value) {
    redirectScenePreviewToTenantLogin()
    return
  }
  if (isEditorTab.value) {
    // 后端确认登录失效后立即移除页签缓存，刷新也不能重新恢复同一份无效凭据。
    clearAuthenticationRuntime()
    editorAuthExpired.value = true
    return
  }
  // 独立管理页也可能来自受信页签交接；没有可续期会话时回到当前登录入口。
  if (!isEmbeddedMode()) {
    clearAuthenticationRuntime()
    requireStandaloneLogin()
  }
}

const closeEditorTab = () => {
  // 编辑器由管理页通过 window.open 创建，浏览器允许脚本关闭该页签。
  window.close()
}

/**
 * 首次路由解析早于鉴权，业务视图挂载前统一检查管理菜单。
 * 未授权页面不挂载或发送业务请求，空菜单进入独立恢复页，避免跳转循环。
 */
const redirectRestrictedManagementRoute = async () => {
  // 菜单在业务组件挂载前读取；首次地址栏进入同样经过授权校验。
  await loadManagementMenus()
  await router.isReady()
  if (isManagementRouteName(router.currentRoute.value.name) && !canAccessManagementRoute(router.currentRoute.value.name)) {
    await router.replace({ name: getManagementFallbackRoute() })
  }
}

/** 登录与失效都由组合根控制业务视图，避免旧权限请求或外部跳转混入独立认证流程。 */
const completeStandaloneLogin = async () => {
  appStore.syncAuthentication()
  await redirectRestrictedManagementRoute()
  showStandaloneLogin.value = false
  authError.value = ''
  authReady.value = true
}
const requireStandaloneLogin = () => {
  appStore.syncAuthentication()
  // 编辑中失效保留内存画布并提示关闭，不能因登录表单切换而静默丢弃未保存编辑。
  if (isEditorTab.value && authReady.value) {
    editorAuthExpired.value = true
    return
  }
  authReady.value = false
  showStandaloneLogin.value = true
}

onMounted(async () => {
  window.addEventListener('xr-center-auth-expired', handleEditorAuthExpired)
  window.addEventListener('standalone-auth-required', requireStandaloneLogin)
  if (!isEmbeddedMode()) handleLoginRedirect()
  // 预览始终是独立页签：无论当前构建是否开启 iframe 模式，都只消费新页签/登录回跳凭证，
  // 不调用历史独立登录的用户信息接口。这样本地联调切换 VITE_EMBED_MODE 时行为仍保持一致。
  if (isPreviewTab.value) {
    const context = await initializeTabAuthentication()
    schedulePreviewAuthExpiryRedirect(context)
    authReady.value = true
    return
  }
  // 内嵌模式先完成父子窗口鉴权，再同步身份投影；失败时保留状态，不在子页面内跳登录。
  if (isEmbeddedMode()) {
    try {
      await initializeAuthentication()
      appStore.syncAuthentication()
      // 内嵌鉴权上下文已由父页面提供权限、角色和平台信息；旧版路径前缀/权限接口
      // 属于独立登录模式的历史启动请求，内嵌模式不再主动调用，避免请求不存在的
      // /admin-api/operation/dimensions/signaling 与 /admin-api/operation/system/auth 路径。
      await redirectRestrictedManagementRoute()
      authReady.value = true
    } catch {
      // 鉴权失败时不挂载业务视图；独立编辑页没有父 iframe，必须显示重新进入的明确出口。
      authError.value = isEditorTab.value
        ? '当前页签登录状态无法恢复，请关闭后从外层平台重新进入'
        : '登录状态无效，请返回外层平台重新登录'
      if (isEditorTab.value) editorAuthExpired.value = true
      return
    }
    return
  }

  // 先恢复受信页签交接，再恢复本项目独立会话；不采信旧登录地址携带的令牌。
  try {
    const tabContext = await initializeTabAuthentication()
    const profile = tabContext ? null : await restoreStandalone()
    if (tabContext || profile) await completeStandaloneLogin()
    else showStandaloneLogin.value = true
  } catch {
    authError.value = '无法验证登录状态，请检查网络后重新登录'
    showStandaloneLogin.value = true
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('xr-center-auth-expired', handleEditorAuthExpired)
  window.removeEventListener('standalone-auth-required', requireStandaloneLogin)
  if (previewAuthExpiryTimer !== undefined) clearTimeout(previewAuthExpiryTimer)
})
</script>

<template>
  <el-config-provider :locale="zhCn">
    <!-- 未完成父子鉴权前不挂载业务路由，避免子页面在 onMounted 中抢先请求第一方接口。 -->
    <RouterView v-if="authReady" />
    <div v-if="editorAuthExpired && authReady" class="auth-expired-overlay" role="alertdialog">
      <div class="auth-expired-dialog">
        <p>编辑器权限已过期，请关闭当前页签后重新进入。</p>
        <button type="button" @click="closeEditorTab">确认并关闭编辑器</button>
      </div>
    </div>
    <StandaloneLogin v-if="showStandaloneLogin && !authReady" :message="authError" @authenticated="completeStandaloneLogin" />
    <div v-if="!authReady && !showStandaloneLogin" class="auth-bootstrap-state" role="status">
      <span>{{ authError || '正在验证登录状态…' }}</span>
      <button v-if="editorAuthExpired" type="button" @click="closeEditorTab">
        确认并关闭编辑器
      </button>
    </div>
  </el-config-provider>
</template>

<style scoped>
.auth-bootstrap-state {
  display: grid;
  place-items: center;
  min-height: 100vh;
  color: #a8b5c7;
  background: #07111f;
}
.auth-bootstrap-state button {
  padding: 8px 18px;
  color: #ffffff;
  cursor: pointer;
  background: #3d8f86;
  border: 0;
  border-radius: 4px;
}
.auth-expired-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: grid;
  place-items: center;
  color: #d8e4f5;
  background: rgb(3 10 22 / 72%);
}
.auth-expired-dialog {
  display: grid;
  gap: 18px;
  min-width: 320px;
  padding: 28px;
  text-align: center;
  background: #101d31;
  border: 1px solid rgb(138 170 214 / 24%);
  border-radius: 8px;
  box-shadow: 0 12px 36px rgb(0 0 0 / 35%);
}
.auth-expired-dialog p {
  margin: 0;
}
.auth-expired-dialog button {
  justify-self: center;
  padding: 8px 18px;
  color: #ffffff;
  cursor: pointer;
  background: #3d8f86;
  border: 0;
  border-radius: 4px;
}
</style>
