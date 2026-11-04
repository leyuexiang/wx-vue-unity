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
      Figma 侧栏中的“资源管理”和“场景管理”是模块分类标识，不是可展开的菜单项。
      分类使用普通容器承载，业务入口仍交给 Element Plus 菜单注册，以保留路由选中态和键盘导航。
      模板管理已完成列表与基础操作接入，和模型、图片页面一样注册真实菜单路由；
      仍未开放的进入、编辑和复制仅保留在模板卡片内并明确禁用。
    -->
    <el-menu
      :default-active="activeIndex"
      mode="vertical"
      class="manage-header__menu"
      @select="handleSelect"
    >
      <div class="manage-header__category" aria-hidden="true">资源管理</div>
      <el-menu-item index="modelManage">
        <span class="manage-sidebar-icon manage-sidebar-icon--model" aria-hidden="true"></span>
        <span>模型管理</span>
      </el-menu-item>
      <el-menu-item index="iconManage">
        <span class="manage-sidebar-icon manage-sidebar-icon--icon" aria-hidden="true"></span>
        <!-- 路由键和图形样式类保留 icon 以兼容现有导航，用户可见名称统一为“图片管理”。 -->
        <span>图片管理</span>
      </el-menu-item>
      <!-- 模板管理属于运营端能力；租户端不挂载入口，避免仅靠禁用样式留下可发现页面。 -->
      <el-menu-item v-if="managementCapabilities.template.canAccess" index="templateManage">
        <span class="manage-sidebar-icon manage-sidebar-icon--template" aria-hidden="true"></span>
        <span>模板管理</span>
      </el-menu-item>
      <div class="manage-header__category" aria-hidden="true">场景管理</div>
      <el-menu-item index="sceneManage">
        <span class="manage-sidebar-icon manage-sidebar-icon--scene" aria-hidden="true"></span>
        <span>场景列表</span>
      </el-menu-item>
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
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { isEmbeddedMode } from '@/auth/runtime'
import { getCurrentManagementCapabilities } from '@/auth/capabilities'
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
/** 布局在认证完成后挂载，此快照可稳定控制当前平台整个侧栏生命周期。 */
const managementCapabilities = getCurrentManagementCapabilities()

/**
 * 文案始终描述下一次操作而非当前状态，既能为视觉提示提供准确文本，
 * 也让读屏用户在聚焦前得知按钮的实际结果。
 */
const themeToggleLabel = computed(() =>
  theme.value === 'light' ? '切换为暗色主题' : '切换为亮色主题',
)

/**
 * 侧栏只允许跳转到路由表中已经存在的资源和场景页面。
 * 模板管理现在拥有真实路由，因此纳入白名单；无业务路由的分组文字仍不能触发导航。
 */
const manageRouteNames = new Set(['modelManage', 'iconManage', 'templateManage', 'sceneManage'] as const)

/**
 * 统一收窄 Element Plus 菜单事件传入的字符串。
 * 只有通过白名单的名称才能写入选中态或交给路由，避免分组索引被误当成页面路由。
 */
const isManageRouteName = (
  name: unknown,
): name is 'modelManage' | 'iconManage' | 'templateManage' | 'sceneManage' =>
  typeof name === 'string' &&
  manageRouteNames.has(name as 'modelManage' | 'iconManage' | 'templateManage' | 'sceneManage')

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
