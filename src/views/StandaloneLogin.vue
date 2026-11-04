<script setup lang="ts">
import { ref, watch } from 'vue'
import { loginStandalone } from '@/auth/standalone'
import type { PlatformType } from '@/auth/authTypes'
import { DIM3D_ADMIN_API } from '@/servers/manual/dim3d/api/constants'

defineProps<{ message?: string }>()
const emit = defineEmits<{ authenticated: [] }>()
const phonenumber = ref('')
const password = ref('')
const submitting = ref(false)
const errorMessage = ref('')
const platformType = ref<PlatformType>('operation')

/** 切换登录端仅改变下次认证目标；清空口令和错误，不能直接修改已登录身份的权限。 */
watch(platformType, () => {
  password.value = ''
  errorMessage.value = ''
})

/** 本项目后端允许用户名，参考服务使用手机号；提交结束后立即清空口令。 */
async function submit(): Promise<void> {
  if (submitting.value) return
  if (!(DIM3D_ADMIN_API ? Boolean(phonenumber.value.trim()) : /^1[3-9]\d{9}$/.test(phonenumber.value.trim())) || !password.value) {
    errorMessage.value = DIM3D_ADMIN_API ? '请输入账号和密码' : '请输入有效手机号和密码'
    return
  }
  submitting.value = true
  errorMessage.value = ''
  try {
    await loginStandalone(phonenumber.value, password.value, platformType.value)
    emit('authenticated')
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '登录失败，请稍后重试'
  } finally {
    password.value = ''
    submitting.value = false
  }
}
</script>

<template>
  <!-- 复用管理界面的青绿色主色、字体与控件，入口不展示服务器或其他实现细节。 -->
  <main class="standalone-login">
    <form class="standalone-login__form" @submit.prevent="submit">
      <p class="standalone-login__brand">场景管理平台</p>
      <h1>登录工作空间</h1>
      <!-- 复用现有分段单选控件，原生键盘操作可切换；提交期间锁定平台，避免响应与选项错位。 -->
      <el-radio-group v-model="platformType" class="standalone-login__platform" aria-label="登录平台" :disabled="submitting">
        <el-radio-button value="operation">运营端</el-radio-button>
        <el-radio-button value="tenant">租户端</el-radio-button>
      </el-radio-group>
      <label for="standalone-phone">{{ DIM3D_ADMIN_API ? '账号' : '手机号' }}</label>
      <el-input id="standalone-phone" v-model="phonenumber" autocomplete="username" :inputmode="DIM3D_ADMIN_API ? 'text' : 'tel'" :maxlength="DIM3D_ADMIN_API ? 30 : 11" :placeholder="DIM3D_ADMIN_API ? '请输入账号' : '请输入手机号'" :disabled="submitting" />
      <label for="standalone-password">密码</label>
      <el-input id="standalone-password" v-model="password" type="password" autocomplete="current-password" show-password placeholder="请输入密码" :disabled="submitting" />
      <p v-if="errorMessage || message" class="standalone-login__error" role="alert">{{ errorMessage || message }}</p>
      <el-button native-type="submit" type="primary" :loading="submitting">登录{{ platformType === 'tenant' ? '租户端' : '运营端' }}</el-button>
    </form>
  </main>
</template>

<style scoped>
/* 与已迁入的侧栏保持相同主色和克制布局，小屏使用同一表单，不加载额外图片资源。 */
.standalone-login { display: grid; place-items: center; min-height: 100dvh; padding: 24px; background: #f5f7f8; color: #243431; }
.standalone-login__form { display: grid; gap: 16px; width: min(100%, 360px); }
.standalone-login__brand { margin: 0; color: #518f85; font-size: 14px; letter-spacing: 2px; }
h1 { margin: 0 0 24px; font-size: 30px; font-weight: 500; }
.standalone-login__platform { display: flex; margin-bottom: 8px; --el-color-primary: #51a195; }
.standalone-login__platform :deep(.el-radio-button) { flex: 1; }
.standalone-login__platform :deep(.el-radio-button__inner) { width: 100%; padding: 12px; }
label { margin-bottom: -8px; font-size: 14px; }
.standalone-login__form :deep(.el-input__wrapper) { min-height: 42px; }
.standalone-login__form .el-button { margin-top: 12px; height: 44px; --el-color-primary: #51a195; --el-color-primary-light-3: #75b4aa; --el-color-primary-dark-2: #408679; }
.standalone-login__error { margin: 0; color: #b42318; font-size: 13px; }
</style>
