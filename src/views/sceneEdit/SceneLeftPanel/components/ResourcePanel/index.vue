<template>
  <div class="scene-edit-resource-panel">
    <el-tabs v-model="activeTab" size="small" tab-position="left">
      <el-tab-pane v-for="item in list" :key="item.key" :label="item.name" :name="item.key">
        <template #label>
          <el-tooltip :content="item.name" placement="right" :show-after="240">
            <div class="scene-edit-resource-tab-label" :aria-label="item.name">
              <img :src="activeTab === item.key ? item.activeIcon : item.icon" :alt="item.name" />
            </div>
          </el-tooltip>
        </template>

        <!--
          我的资源的组件、图标、图表和装饰需要传入独立分类名。
          系统资源与模型资源服务没有额外参数，`contentProps` 未定义时不会影响原有组件挂载。
        -->
        <component :is="item.contentComponent" v-bind="item.contentProps" />
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script setup lang="ts">
import templateActive from '@/assets/images/scene-left-navigation/template-active.svg'
import templateDefault from '@/assets/images/scene-left-navigation/template-default.svg'
import modelActive from '@/assets/images/scene-left-navigation/model-active.svg'
import modelDefault from '@/assets/images/scene-left-navigation/model-default.svg'
import componentActive from '@/assets/images/scene-left-navigation/component-active.svg'
import componentDefault from '@/assets/images/scene-left-navigation/component-default.svg'
import iconActive from '@/assets/images/scene-left-navigation/icon-active.svg'
import iconDefault from '@/assets/images/scene-left-navigation/icon-default.svg'
import chartActive from '@/assets/images/scene-left-navigation/chart-active.svg'
import chartDefault from '@/assets/images/scene-left-navigation/chart-default.svg'
import markerActive from '@/assets/images/scene-left-navigation/marker-active.svg'
import markerDefault from '@/assets/images/scene-left-navigation/marker-default.svg'
import SystemDrag from './SystemDrag/index.vue'
import CustomDrag from './CustomDrag/index.vue'
import TemplateDrag from './TemplateDrag/index.vue'
import ComponentDrag from './ComponentDrag/index.vue'
import IconDrag from './IconDrag/index.vue'
import ChartDrag from './ChartDrag/index.vue'
import DecorateDrag from './DecorateDrag/index.vue'
import MyResourceDrag from './MyResourceDrag/index.vue'
import { computed, ref, watch } from 'vue'
import type { Component } from 'vue'
import { RESOURCE_TAB_ENUM } from '../../../enum'

type ResourceScope = 'system' | 'mine'

type ResourceTab = {
  name: string
  key: RESOURCE_TAB_ENUM
  icon: string
  activeIcon: string
  contentComponent: Component
  contentProps?: Record<string, string>
}

const props = withDefaults(
  defineProps<{
    scope?: ResourceScope
  }>(),
  {
    scope: 'system',
  },
)

/**
 * 左侧资源导航的唯一配置源。
 *
 * 每个入口都持有 Figma「侧边栏导航组件」的一对状态图标；模板、模型、组件、图标、
 * 图表、标记点分别映射到当前已有的资源类型。`scope` 只负责选择入口及其数据源，
 * `activeTab` 仍由 Element Plus 页签管理，因此替换“我的资源”的独立内容容器不会改变
 * 系统资源的拖拽、搜索和挂载逻辑。
 */
const allTabs: ResourceTab[] = [
  {
    name: '模板',
    key: RESOURCE_TAB_ENUM.Template,
    icon: templateDefault,
    activeIcon: templateActive,
    contentComponent: TemplateDrag,
  },
  {
    name: '内置模型',
    key: RESOURCE_TAB_ENUM.System,
    icon: modelDefault,
    activeIcon: modelActive,
    contentComponent: SystemDrag,
  },
  {
    name: '模型资源服务',
    key: RESOURCE_TAB_ENUM.Custom,
    icon: modelDefault,
    activeIcon: modelActive,
    contentComponent: CustomDrag,
  },
  {
    name: '组件/部件',
    key: RESOURCE_TAB_ENUM.Component,
    icon: componentDefault,
    activeIcon: componentActive,
    contentComponent: ComponentDrag,
  },
  {
    name: '图标',
    key: RESOURCE_TAB_ENUM.Icon,
    icon: iconDefault,
    activeIcon: iconActive,
    contentComponent: IconDrag,
  },
  {
    name: '图表',
    key: RESOURCE_TAB_ENUM.Chart,
    icon: chartDefault,
    activeIcon: chartActive,
    contentComponent: ChartDrag,
  },
  {
    name: '装饰',
    key: RESOURCE_TAB_ENUM.Decorate,
    icon: markerDefault,
    activeIcon: markerActive,
    contentComponent: DecorateDrag,
  },
]

/** 内置模型属于系统预置内容，只在“系统资源”中展示。 */
const systemResourceTabs = new Set<RESOURCE_TAB_ENUM>([
  RESOURCE_TAB_ENUM.Template,
  RESOURCE_TAB_ENUM.System,
  RESOURCE_TAB_ENUM.Component,
  RESOURCE_TAB_ENUM.Icon,
  RESOURCE_TAB_ENUM.Chart,
  RESOURCE_TAB_ENUM.Decorate,
])
/**
 * “我的资源”除模型资源服务外，也应具备可拖入的组件、图标、图表和装饰入口。
 * 这些入口与系统资源只复用导航图标和布局，不复用系统静态内容；具体内容由下方独立分类映射
 * 决定。只有“内置模型”继续限定为系统预置资源。
 */
const myResourceTabs = new Set<RESOURCE_TAB_ENUM>([
  RESOURCE_TAB_ENUM.Custom,
  RESOURCE_TAB_ENUM.Component,
  RESOURCE_TAB_ENUM.Icon,
  RESOURCE_TAB_ENUM.Chart,
  RESOURCE_TAB_ENUM.Decorate,
])

/**
 * 我的资源的二维分类与系统资源同名，但内容绝不能共用系统静态清单。
 *
 * 模型资源服务已有专用接口，继续使用 `CustomDrag`；其余分类暂由 `MyResourceDrag` 承载空数据。
 * 这样后续接入用户资源接口时只有该容器需要扩展，且不会出现加载失败后回退显示系统资源的风险。
 */
const myResourceIndependentCategories = new Map<RESOURCE_TAB_ENUM, string>([
  [RESOURCE_TAB_ENUM.Component, '组件'],
  [RESOURCE_TAB_ENUM.Icon, '图标'],
  [RESOURCE_TAB_ENUM.Chart, '图表'],
  [RESOURCE_TAB_ENUM.Decorate, '装饰'],
])
const defaultActiveTab = {
  // 保持历史默认打开内置模型；模板页签仅新增在其上方，不改变用户原有进入路径。
  system: RESOURCE_TAB_ENUM.System,
  mine: RESOURCE_TAB_ENUM.Custom,
} satisfies Record<ResourceScope, RESOURCE_TAB_ENUM>

const list = computed(() => {
  const enabledTabs = props.scope === 'mine' ? myResourceTabs : systemResourceTabs

  return allTabs
    .filter((item) => enabledTabs.has(item.key))
    .map((item) => {
      const categoryName =
        props.scope === 'mine' ? myResourceIndependentCategories.get(item.key) : undefined

      if (!categoryName) return item

      return {
        ...item,
        contentComponent: MyResourceDrag,
        contentProps: { categoryName },
      }
    })
})
const activeTab = ref<RESOURCE_TAB_ENUM>(defaultActiveTab[props.scope])

watch(
  list,
  (tabs) => {
    if (tabs.some((item) => item.key === activeTab.value)) return

    activeTab.value = tabs[0]?.key ?? defaultActiveTab[props.scope]
  },
  { immediate: true },
)
</script>

<style scoped lang="scss">
.scene-edit-resource-panel {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  height: 100%;
  overflow: hidden;
  :deep(.el-tabs) {
    /*
     * 轨道和资源内容必须在固定的横向弹性容器内分配宽度。
     * 否则不同资源页的网格、搜索框或滚动条会参与内容固有宽度计算，
     * 在切换“模型 / 组件 / 图标 / 图表 / 装饰”时推挤左侧轨道并产生横向跳动。
     */
    display: flex;
    width: 100%;
    min-width: 0;
    height: 100%;
  }
  :deep(.el-tabs__header.is-left) {
    flex: 0 0 var(--scene-edit-left-resource-rail-width);
    width: var(--scene-edit-left-resource-rail-width);
    min-width: var(--scene-edit-left-resource-rail-width);
    max-width: var(--scene-edit-left-resource-rail-width);
    height: 100%;
    min-height: 0;
    margin-right: 0;
  }
  :deep(.el-tabs__nav-wrap.is-left) {
    /*
     * 垂直页签的导航包裹层位于纵向弹性容器中，此处只能固定宽度。
     * 若设置 48px 的 flex-basis，会把高度压缩为 48px并触发错误的上下滚动按钮。
     */
    width: var(--scene-edit-left-resource-rail-width);

    /* 与结构面板分类栏共享主题令牌，保证三个资源页签的左侧轨道完全同色。 */
    background: var(--scene-edit-left-resource-rail-bg);
  }
  :deep(.el-tabs__nav.is-left) {
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 100%;
  }
  :deep(.el-tabs__nav-scroll) {
    /*
     * 资源导航是嵌套页签。必须保持组件库要求的块级滚动容器，
     * 以便它以真实高度计算全部五个入口，不能继承外层页签的弹性导航样式。
     */
    display: block;
    width: 100%;
    height: 100%;
    overflow: hidden;
  }
  :deep(.el-tabs__content) {
    /*
     * `flex-basis: 0` 让资源内容只消费轨道以外的剩余空间，不再由当前页内容反推宽度；
     * `width: 0` 与 `min-width: 0` 同时处理 Element Plus 左侧页签的默认最小内容宽度。
     */
    box-sizing: border-box;
    flex: 1 1 0;
    width: 0;
    min-width: 0;
    height: 100%;
    margin: 0;
    overflow: hidden;
    background: #1d2a35;
    border: 0;
    border-radius: 0;
    box-shadow: none;
    backdrop-filter: none;
  }
  :deep(.el-tab-pane) {
    height: 100%;
    overflow: hidden;
  }
  :deep(.el-tab-pane > .scene-edit-resource-content) {
    /*
     * 每个资源页统一采用“固定搜索区 + 单一列表滚动区”的纵向弹性布局。
     * 资源类型切换只替换数据，不再让搜索框随列表滚动或形成嵌套滚动容器。
     */
    display: flex;
    flex-direction: column;
    width: 100%;
    min-width: 0;
    height: 100%;
    min-height: 0;
    overflow: hidden;
  }
  :deep(.scene-edit-resource-scroll) {
    flex: 1 1 0;
    width: 100%;
    min-width: 0;
    height: 0;
    min-height: 0;
  }
  :deep(.scene-edit-resource-scroll > .el-scrollbar__wrap) {
    /* 始终预留纵向滚动条槽位，长列表与短列表切换时资源卡片不会左右移动。 */
    max-height: none !important;
    overflow-x: hidden;
    scrollbar-gutter: stable;
  }
  :deep(.el-tabs__item) {
    box-sizing: border-box;
    display: flex;
    align-items: center;
    justify-content: center;
    width: var(--scene-edit-left-resource-rail-width);
    height: 42px;
    padding: 0;
    border-left: 2px solid transparent;
  }
  :deep(.el-tabs__item.is-active) {
    color: var(--scene-edit-text);
    background: #1d2a35;
    border-left-color: var(--scene-edit-header-primary);
    box-shadow: none;
  }
  :deep(.el-tabs__active-bar.is-left) {
    display: none;
  }
  :deep(.el-collapse-item__wrap),
  :deep(.el-collapse-item__header),
  :deep(.el-collapse) {
    border-top: none;
    border-bottom: none;
  }

  /* 搜索与资源内容使用语义类名定位，避免依赖原子类顺序导致后续组件调整时错位。 */
  :deep(.scene-edit-resource-search) {
    padding: 12px 12px 0;
  }
  :deep(.scene-edit-resource-groups) {
    padding: 20px 12px 12px;
  }
  :deep(.scene-edit-resource-groups > .el-collapse) {
    display: flex;
    flex-direction: column;
    gap: 28px;

    /**
     * Element Plus 默认把折叠标题的最小高度固定为 48px，仅设置 height 无法缩小实际盒模型。
     * 这里把组件变量同步改为 Figma 的 21px 标题行高，使相邻标题之间真正只保留 28px 空隙。
     */
    --el-collapse-header-height: 21px;
  }
  :deep(.scene-edit-resource-search .el-input) {
    height: 32px;
  }
  :deep(.scene-edit-resource-search .el-input__wrapper) {
    box-sizing: border-box;
    padding: 0 8px;
    background: #121b26;
    border: 1px solid rgb(255 255 255 / 20%);
    border-radius: 2px;
    box-shadow: none;
  }
  :deep(.scene-edit-resource-search .el-input__wrapper:hover) {
    border-color: rgb(255 255 255 / 32%);
    box-shadow: none;
  }
  :deep(.scene-edit-resource-search .el-input__wrapper.is-focus) {
    border-color: var(--scene-edit-header-primary);
    box-shadow: 0 0 0 2px rgb(90 178 165 / 18%);
  }
  :deep(.scene-edit-resource-search .el-input__prefix-inner) {
    gap: 6px;
  }
  :deep(.scene-edit-resource-search .el-input__prefix-inner > svg) {
    width: 16px;
    height: 16px;
    color: var(--scene-edit-text-2);
  }
  :deep(.scene-edit-resource-search .el-input__inner) {
    font-size: 12px;
    line-height: 17px;
    color: var(--scene-edit-text);
  }
  :deep(.el-collapse-item__header) {
    height: 21px;
    min-height: 21px;
    padding: 0;

    /** 收起项之间的垂直间隔完全由父级 28px gap 控制，禁止再叠加内容间距。 */
    margin-bottom: 0;
    font-size: 14px;
    font-weight: 400;
    line-height: 21px;
    color: var(--scene-edit-text);
    background: transparent;
  }
  :deep(.el-collapse-item__header.is-active) {
    /** 展开标题与下方资源网格仍按 Figma 保留 12px 内容间距。 */
    margin-bottom: 12px;
  }
  :deep(.el-collapse-item__arrow) {
    width: 14px;
    height: 14px;
    margin: 0 4px 0 0;
    font-size: 14px;
    color: var(--scene-edit-text-2);
  }
  :deep(.el-collapse-item__content) {
    padding: 0;
  }
  :deep(.scene-edit-resource-grid) {
    display: grid !important;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 20px 12px;
    width: 100%;
  }

  /**
   * 模板使用 Figma 节点 2086:1711 的两列横向卡片：基准内容宽 249px、列间距 12px，
   * 因此每列约为 118.5px。`auto-fill` 在默认面板宽度下稳定保留两列；面板变宽时
   * 自动增加列数，变窄时自动降为单列，无需监听尺寸变化，也不会产生额外重排开销。
   */
  :deep(.scene-edit-resource-grid--template) {
    grid-template-columns: repeat(auto-fill, minmax(118px, 1fr));
    gap: 20px 12px;
  }
  :deep(.scene-edit-resource-card) {
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: center;
    justify-content: center;
    width: 100% !important;
    height: 84px !important;
    padding: 8px 4px;
    cursor: move;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 0;
    transition:
      background-color 150ms ease-out,
      border-color 150ms ease-out,
      border-radius 150ms ease-out;
  }
  :deep(.scene-edit-resource-card__image) {
    box-sizing: border-box;
    width: 44px !important;
    height: 44px !important;
    padding: 6px;
    object-fit: contain;
    background: #121b26;
    opacity: 0.6;
  }

  /**
   * 模板卡片按 Figma 的 118.5×104px 基准盒模型展示，封面固定为 110×62px。
   * 卡片列宽可随面板弹性增长，但封面不拉伸，避免宽面板下图片失真或高度跳动。
   */
  :deep(.scene-edit-resource-card--template) {
    height: 104px !important;
    padding: 8px 4px;

    /* 模板封面需要完整占用 110px 内容宽；透明边框改由悬停描边承担，避免挤压封面 2px。 */
    border: 0;
  }
  :deep(.scene-edit-resource-card--template .scene-edit-resource-card__image) {
    width: min(110px, 100%) !important;
    height: 62px !important;
    padding: 0;
    object-fit: cover;
    background: transparent;
    opacity: 1;
  }
  :deep(.scene-edit-resource-card--template .scene-edit-resource-card__image .el-image__inner) {
    object-fit: cover;
  }
  :deep(.scene-edit-resource-card--template:hover) {
    /* outline 不参与盒模型计算，悬停态仍有 Figma 的 1px 强调边框且不会引发布局抖动。 */
    outline: 1px solid var(--scene-edit-header-primary-hover);
    outline-offset: -1px;
  }
  :deep(.scene-edit-resource-card__name) {
    width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 12px;
    line-height: 18px;
    color: rgb(255 255 255 / 60%);
    text-align: center;
    white-space: nowrap;
  }
  :deep(.scene-edit-resource-card:hover) {
    background: rgb(90 178 165 / 14%);
    border-color: var(--scene-edit-header-primary-hover) !important;
    border-radius: 2px;
  }
  :deep(.scene-edit-resource-card:hover .scene-edit-resource-card__image) {
    opacity: 1;
  }
  :deep(.scene-edit-resource-card--custom) {
    padding: 0;
  }
  :deep(.scene-edit-resource-card__body) {
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    padding: 8px 4px;
  }
  :deep(.scene-edit-resource-card__body .el-image__inner) {
    box-sizing: border-box;
    padding: 6px;
    object-fit: contain;
  }

  /* Element Plus 的图片组件有额外包裹层；外层不再重复内边距，保证实际图形仍为 32×32。 */
  :deep(.el-image.scene-edit-resource-card__image) {
    padding: 0;
  }
  :deep(.scene-edit-resource-card__fallback) {
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    padding: 6px;
    object-fit: contain;
  }
  :deep(.scene-edit-resource-card--template .scene-edit-resource-card__fallback) {
    padding: 0;
    object-fit: cover;
  }
}
.scene-edit-resource-tab-label {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  line-height: 1;
}
.scene-edit-resource-tab-label img {
  width: 18px;
  height: 18px;
  object-fit: contain;

  /*
   * Figma 导出的未选中 SVG 已在图层内声明 60% 透明度；这里保持满透明度，
   * 避免再乘以容器透明度而把未选中图标错误压暗。
   */
  opacity: 1;
  filter: none;
}
</style>
