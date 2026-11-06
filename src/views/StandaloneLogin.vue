<script setup lang="ts">
import { ref, watch, onUnmounted } from 'vue'
import { loginStandalone, sendStandaloneSms } from '@/auth/standalone'
import type { PlatformType } from '@/auth/authTypes'
import { DIM3D_ADMIN_API } from '@/servers/manual/dim3d/api/constants'

defineProps<{ message?: string }>()
const emit = defineEmits<{ authenticated: [] }>()
const phonenumber = ref('')
const password = ref('')
const mobile = ref('')
const code = ref('')
const loginMethod = ref<'account' | 'mobile'>('account')
const sendingCode = ref(false)
const countdown = ref(0)
let countdownTimer: ReturnType<typeof setInterval> | undefined
let disposed = false
onUnmounted(() => { disposed = true; if (countdownTimer) clearInterval(countdownTimer) })

/** 发送成功后按实际截止时间倒计时，切换方式不重置冷却，避免重复发送。 */
async function sendCode(): Promise<void> {
  if (sendingCode.value || countdown.value || submitting.value) return
  sendingCode.value = true
  errorMessage.value = ''
  try {
    await sendStandaloneSms(mobile.value, platformType.value)
    if (disposed) return
    const deadline = Date.now() + 60000
    countdown.value = 60
    countdownTimer = setInterval(() => {
      countdown.value = Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
      if (!countdown.value) clearInterval(countdownTimer)
    }, 1000)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '验证码发送失败，请稍后重试'
  } finally { sendingCode.value = false }
}
const submitting = ref(false)
const errorMessage = ref('')
const platformType = ref<PlatformType>('operation')

/** 切换登录平台或方式只影响下次认证；清除敏感输入，不修改已有身份权限。 */
watch([platformType, loginMethod], () => {
  password.value = ''
  code.value = ''
  errorMessage.value = ''
})

/** 两种方式分别校验输入，提交结束立即清空密码及验证码。 */
async function submit(): Promise<void> {
  if (submitting.value || sendingCode.value) return
  if (loginMethod.value === 'mobile') {
    if (!/^1[3-9]\d{9}$/.test(mobile.value.trim()) || !/^\d{4,6}$/.test(code.value)) {
      errorMessage.value = '请输入有效手机号和验证码'
      return
    }
  } else if (!(DIM3D_ADMIN_API ? Boolean(phonenumber.value.trim()) : /^1[3-9]\d{9}$/.test(phonenumber.value.trim())) || !password.value) {
    errorMessage.value = '请输入账号和密码'
    return
  }
  submitting.value = true
  errorMessage.value = ''
  try {
    await loginStandalone(loginMethod.value === 'mobile' ? mobile.value : phonenumber.value, loginMethod.value === 'mobile' ? code.value : password.value, platformType.value, loginMethod.value)
    emit('authenticated')
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '登录失败，请稍后重试'
  } finally {
    password.value = ''
    code.value = ''
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
      <el-radio-group v-model="platformType" class="standalone-login__platform" aria-label="登录平台" :disabled="submitting || sendingCode">
        <el-radio-button value="operation">运营端</el-radio-button>
        <el-radio-button value="tenant">租户端</el-radio-button>
      </el-radio-group>
      <!-- 使用现有页签控件，保留键盘导航和选中状态语义；切换期间不提交另一种身份凭据。 -->
      <el-tabs v-model="loginMethod" class="standalone-login__methods" stretch aria-label="登录方式">
        <el-tab-pane label="账号登录" name="account" :disabled="submitting || sendingCode">
          <div class="standalone-login__fields">
            <label for="standalone-account">账号</label>
            <el-input id="standalone-account" v-model="phonenumber" autocomplete="username" maxlength="30" placeholder="请输入账号" :disabled="submitting" />
            <label for="standalone-password">密码</label>
            <el-input id="standalone-password" v-model="password" type="password" autocomplete="current-password" show-password placeholder="请输入密码" :disabled="submitting" />
          </div>
        </el-tab-pane>
        <el-tab-pane label="手机登录" name="mobile" :disabled="submitting || sendingCode">
          <div class="standalone-login__fields">
            <label for="standalone-mobile">手机号</label>
            <el-input id="standalone-mobile" v-model="mobile" autocomplete="tel" inputmode="tel" maxlength="11" placeholder="请输入手机号" :disabled="submitting || sendingCode" />
            <label for="standalone-code">验证码</label>
            <div class="standalone-login__code-row">
              <el-input id="standalone-code" v-model="code" autocomplete="one-time-code" inputmode="numeric" maxlength="6" placeholder="请输入验证码" :disabled="submitting" />
              <el-button native-type="button" :loading="sendingCode" :disabled="submitting || countdown > 0 || !/^1[3-9]\d{9}$/.test(mobile.trim())" @click="sendCode">{{ countdown ? `${countdown}秒后重发` : '获取验证码' }}</el-button>
            </div>
          </div>
        </el-tab-pane>
      </el-tabs>
      <p v-if="errorMessage || message" class="standalone-login__error" role="alert">{{ errorMessage || message }}</p>
      <el-button native-type="submit" type="primary" :loading="submitting" :disabled="sendingCode">登录{{ platformType === 'tenant' ? '租户端' : '运营端' }}</el-button>
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
.standalone-login__fields { display: grid; gap: 16px; }
.standalone-login__methods { --el-color-primary: #51a195; }
.standalone-login__code-row { display: flex; gap: 12px; }
.standalone-login__code-row .el-input { min-width: 0; flex: 1; }
.standalone-login__code-row .el-button { margin-top: 0; min-width: 112px; }
label { margin-bottom: -8px; font-size: 14px; }
.standalone-login__form :deep(.el-input__wrapper) { min-height: 42px; }
.standalone-login__form .el-button { margin-top: 12px; height: 44px; --el-color-primary: #51a195; --el-color-primary-light-3: #75b4aa; --el-color-primary-dark-2: #408679; }
.standalone-login__error { margin: 0; color: #b42318; font-size: 13px; }
</style>
