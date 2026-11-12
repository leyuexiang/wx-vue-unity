<template>
  <div class="manage-header">
    <!--
      水印单独作为装饰层承载，便于将 Figma 的图形尺寸、旋转角度和水平倾斜一一映射到 CSS。
      文字裁除后由侧栏边界统一完成自然裁切；装饰层不参与菜单布局，也不会在路由切换时重复创建。
    -->
    <div class="manage-header__watermark" aria-hidden="true"></div>
    <!-- 管理页复用编辑器的品牌配置，品牌区独立于下方可滚动的导航。 -->
    <div class="manage-header__brand">
      <img
        v-if="managementBrand.logoSrc"
        class="manage-header__brand-logo"
        :src="resolveSceneEditorBrandAssetUrl(managementBrand.logoSrc)"
        alt=""
        width="28"
        height="28"
      />
      <span class="manage-header__brand-name" :title="managementBrand.projectName">
        {{ managementBrand.projectName }}
      </span>
    </div>
    <!--
      后台授权页面统一投影到原有三类一级目录，二级入口由同一白名单和组件渲染。
      复用现有菜单注册以保留路由选中态和键盘导航，后端没有授权的页面不补静态副本。
    -->
    <el-menu
      :default-active="activeIndex"
      mode="vertical"
      class="manage-header__menu"
      @select="handleSelect"
    >
      <!-- 全部管理模块消费同一授权树；分类文字和顺序不再分别写死。 -->
      <ManagementNavigationMenu :nodes="managementNavigation" />
    </el-menu>

    <!--
      底部工具区严格对应侧栏资源中的 248×42 槽位，并作为菜单滚动区之外的不可收缩项。
      主题按钮与账号下拉共用该稳定坐标：窗口高度不足时只压缩、滚动上方菜单，不能带动工具区移动。
    -->
    <div class="manage-header__bottom-tools">
      <el-tooltip :content="themeToggleLabel" placement="top">
        <!--
          显式处理 Enter 与空格键，避免工具提示包裹时浏览器未把键盘事件转换为 click；
          prevent 阻止浏览器默认 click 造成双重切换。aria-pressed 反映当前是否为暗色主题，
          title 作为组件提示未渲染时的无障碍兜底。切换逻辑由全局主题控制器统一持久化并同步根属性。
        -->
        <button
          type="button"
          class="manage-header__theme-toggle"
          :aria-label="themeToggleLabel"
          :aria-pressed="theme === 'dark'"
          :title="themeToggleLabel"
          @click="handleThemeToggle"
          @keydown.enter.prevent="handleThemeToggle"
          @keydown.space.prevent="handleThemeToggle"
        >
          <el-icon aria-hidden="true">
            <Moon v-if="theme === 'light'" />
            <Sunny v-else />
          </el-icon>
        </button>
      </el-tooltip>

      <!-- 独立模式保留账号退出入口；内嵌模式由父页面统一维护登录态和跳转。 -->
      <el-dropdown
        v-if="appStore.userInfo && !isEmbeddedMode()"
        class="manage-header__user-dropdown"
        popper-class="manage-dropdown-popper"
      >
        <span class="manage-header__user outline-0">
          <el-icon aria-hidden="true"><User /></el-icon>
          <span class="manage-header__user-name">{{ appStore.userInfo.user.nickname }}</span>
        </span>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item @click="handleLogout()">退出登录</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Moon, Sunny, User } from '@element-plus/icons-vue'
import { useAppStore } from '@/stores/appStore'
import { toLogin } from '@/utils/auth'
import { useManageTheme } from '@/views/manageShared/manageTheme'
import { computed, ref, shallowRef, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { isEmbeddedMode } from '@/auth/runtime'
import ManagementNavigationMenu from './ManagementNavigationMenu.vue'
import { getManagementNavigation, isManagementRouteName } from '@/auth/managementNavigation'
import { authContext } from '@/auth/authContext'
import {
  getDefaultSceneEditorBrandConfig,
  loadSceneEditorBrandConfig,
  resolveSceneEditorBrandAssetUrl,
} from '@/config/sceneEditorBrand'

defineOptions({ name: 'LayoutHeader' })

const appStore = useAppStore()
const router = useRouter()
const activeIndex = ref()
const brandConfig = ref(getDefaultSceneEditorBrandConfig())
const managementBrand = computed(() => brandConfig.value.managementBrand ?? {
  projectName: brandConfig.value.softwareName,
  logoSrc: brandConfig.value.logoSrc,
})
const { theme, toggleTheme } = useManageTheme()
/** 重取菜单、切换身份或退出同步更新侧栏，离开布局立即解除订阅。 */
const managementNavigation = shallowRef(getManagementNavigation())
const unsubscribeMenus = authContext.subscribe(() => { managementNavigation.value = getManagementNavigation() })
onBeforeUnmount(unsubscribeMenus)

/**
 * 文案始终描述下一次操作而非当前状态，既能为视觉提示提供准确文本，
 * 也让读屏用户在聚焦前得知按钮的实际结果。
 */
const themeToggleLabel = computed(() =>
  theme.value === 'light' ? '切换为暗色主题' : '切换为亮色主题',
)

/**
 * 统一收窄 Element Plus 菜单事件传入的字符串。
 * 只有通过白名单的名称才能写入选中态或交给路由，避免分组索引被误当成页面路由。
 */
const isManageRouteName = isManagementRouteName

onBeforeMount(() => {
  setActive(router.currentRoute.value.name)
})

onMounted(async () => {
  brandConfig.value = await loadSceneEditorBrandConfig()
})

watch(
  () => router.currentRoute.value.name,
  (name) => {
    setActive(name)
  },
)

const setActive = (key?: string | symbol) => {
  // 地址栏刷新、前进和后退只同步真实页面，资源分组本身不会被标记为可点击页面。
  activeIndex.value = isManageRouteName(key) ? key : undefined
}

const handleSelect = (key: string) => {
  // 当前页重复点击不创建重复导航记录，也不会触发该页面的额外路由生命周期。
  if (!isManageRouteName(key) || key === router.currentRoute.value.name) return

  void router.push({ name: key })
}

/**
 * 仅委托共享控制器切换主题，控制器负责 localStorage 持久化和根属性同步。
 * 这里不直接写 DOM 或存储，避免侧栏重复挂载时产生状态源分叉。
 */
const handleThemeToggle = () => {
  toggleTheme()
}

/**
 * 仅独立模式允许调用历史登录跳转；内嵌模式必须由父页面完成退出和跳转。
 */
const handleLogout = () => {
  // 内嵌模式的登录态完全由父页面管理，子应用不得调用本地登出接口或跳转登录页。
  if (isEmbeddedMode()) return
  toLogin(true)
}
</script>
