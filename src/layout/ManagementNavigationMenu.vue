<template>
  <template v-for="node in nodes" :key="node.id">
    <el-menu-item v-if="node.routeName" :index="node.routeName" class="iot-navigation-item">
      <span v-if="node.sidebarIcon && !node.icon" :class="'manage-sidebar-icon manage-sidebar-icon--' + node.sidebarIcon" aria-hidden="true"></span>
      <el-icon v-else aria-hidden="true"><component :is="icons[node.icon ?? ''] ?? Connection" /></el-icon>
      <span>{{ node.name }}</span>
    </el-menu-item>
    <template v-else-if="root">
      <!-- 三类顶层使用原业务分类标题；投影只包含后台实际授权的二级页面。 -->
      <div class="manage-header__category" aria-hidden="true">{{ node.name }}</div>
      <ManagementNavigationMenu :nodes="node.children" :root="false" />
    </template>
    <el-sub-menu v-else :index="'iot-group-' + node.id" class="iot-navigation-group">
      <template #title>
        <el-icon aria-hidden="true"><component :is="icons[node.icon ?? ''] ?? Connection" /></el-icon>
        <span>{{ node.name }}</span>
      </template>
      <ManagementNavigationMenu :nodes="node.children" :root="false" />
    </el-sub-menu>
  </template>
</template>
<script setup lang="ts">
import { Connection, Link, Tickets, Setting } from '@element-plus/icons-vue'
import type { Component } from 'vue'
import type { ManagementNavigationNode } from '@/auth/managementNavigation'
withDefaults(defineProps<{ nodes: readonly ManagementNavigationNode[]; root?: boolean }>(), { root: true })
// 图标也使用本地白名单，后台内容不能生成任意 HTML 或导入外部组件。
const icons: Record<string, Component> = { Connection, Link, Tickets, Setting }
</script>
<style lang="scss">
/* 递归菜单延续青绿侧栏，避免组件库子菜单白底与原白色文字叠加。 */
.manage-header__menu .iot-navigation-group .el-menu {
  background: transparent !important;
  border: 0;
  padding: 0;
}
.manage-header__menu .iot-navigation-group > .el-sub-menu__title {
  height: 48px;
  padding-left: 52px !important;
  padding-right: 32px;
  color: #fff;
  font-size: 14px;
  background: transparent !important;
}
.manage-header__menu .iot-navigation-group > .el-sub-menu__title:hover {
  background: rgb(255 255 255 / 10%) !important;
}
.manage-header__menu .iot-navigation-item .el-icon {
  position: absolute;
  left: 52px;
  margin-right: 0;
}
.manage-header__menu .iot-navigation-group > .el-sub-menu__title .el-sub-menu__icon-arrow {
  right: 32px;
}
</style>
