import { createRouter, createWebHistory } from 'vue-router'
import { authContext } from '@/auth/authContext'
import { canAccessManagementRoute, isManagementRouteName, getManagementFallbackRoute } from '@/auth/managementNavigation'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      redirect: '/sceneManage',
      component: () => import('@/layout/index.vue'),
      children: [
        { path: '/management/access', name: 'managementAccess', component: () => import('../views/manageShared/ManagementAccess.vue') },
        // 编译期注册页面组件；后端菜单只决定授权导航，不能提供动态导入地址。
        { path: '/iotManage/connectors', name: 'iotConnectors', component: () => import('../views/iotManage/connectors/index.vue') },
        { path: '/iotManage/bindings', name: 'iotBindings', component: () => import('../views/iotManage/bindings/index.vue') },
        { path: '/iotManage/messages', name: 'iotMessages', component: () => import('../views/iotManage/messages/index.vue') },
        {
          path: '/resourceManage',
          name: 'resourceManage',
          redirect: { name: 'modelManage' },
          children: [
            {
              path: 'model',
              name: 'modelManage',
              component: () => import('../views/resourceManage/modelManage/index.vue'),
            },
            {
              path: 'icon',
              name: 'iconManage',
              component: () => import('../views/resourceManage/iconManage/index.vue'),
            },
            {
              // 模板页复用资源管理外壳，路径与同级模型、图片页面保持一致，便于侧栏和地址栏直接访问。
              path: 'template',
              name: 'templateManage',
              component: () => import('../views/resourceManage/templateManage/index.vue'),
            },
          ],
        },
        {
          path: '/sceneManage',
          name: 'sceneManage',
          component: () => import('../views/SceneManage/index.vue'),
        },
      ],
    },
    {
      path: '/sceneEdit',
      name: 'sceneEdit',
      component: () => import('../views/sceneEdit/index.vue'),
    },
    {
      path: '/scenePreview',
      name: 'scenePreview',
      component: () => import('../views/scenePreview/index.vue'),
    },
    {
      path: '/plantingManage',
      name: 'plantingManage',
      alias: '/planting-management',
      component: () => import('../views/plantingManage/index.vue'),
    },
    {
      path: '/:pathMatch(.*)*',
      name: '404',
      component: () => import('../views/404.vue'),
    },
  ],
})

/**
 * 七个管理页面共用菜单准入，拒绝地址栏及站内跳转绕过隐藏菜单。
 * 初次认证尚未完成时由App在业务视图挂载前补做同一检查；空菜单进入恢复页。
 */
router.beforeEach((to) => {
  if (isManagementRouteName(to.name) && authContext.get() && !canAccessManagementRoute(to.name)) {
    return { name: getManagementFallbackRoute(), replace: true }
  }
  return true
})

export default router
