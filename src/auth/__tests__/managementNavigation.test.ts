import { afterEach, expect, it } from 'vitest'
import { authContext } from '../authContext'
import { parseManagementMenus } from '../iotNavigation'
import { getManagementNavigation, canAccessManagementRoute, getManagementFallbackRoute } from '../managementNavigation'

const menus = [
  { id: '1', name: '资产中心', children: [
    { id: '2', name: '模型资料', component: 'resourceManage/modelManage/index' },
    { id: '3', name: '图片资料', component: 'resourceManage/iconManage/index' },
    { id: '4', name: '场景模板', component: 'resourceManage/templateManage/index' },
  ] },
  { id: '5', name: '项目场景', children: [{ id: '6', name: '项目列表', component: 'SceneManage/index' }] },
  { id: '7', name: '设备中心', children: [{ id: '8', name: '接入连接', component: 'iotManage/connectors/index' }] },
]
const login = (permissions = ['*:*:*'], platformType: 'operation' | 'tenant' = 'operation', tree: unknown = menus) =>
  authContext.set({ accessToken: 'fake', clientId: 'web', tenantId: '7', platformType, roles: [],
    permissions, menus: parseManagementMenus(tree) })
afterEach(() => authContext.clear())

it('后台授权页面恢复为原有三类业务目录与二级入口', () => {
  login()
  expect(getManagementNavigation().map(node => node.name)).toEqual(['资源管理', '场景管理', '物联网管理'])
  expect(getManagementNavigation()[0]?.children.map(node => node.name)).toEqual(['模型管理', '图片管理', '模板管理'])
  for (const name of ['modelManage', 'iconManage', 'templateManage', 'sceneManage', 'iotConnectors']) {
    expect(canAccessManagementRoute(name)).toBe(true)
  }
  expect(canAccessManagementRoute('sceneEdit')).toBe(false)
  expect(getManagementFallbackRoute()).toBe('sceneManage')
})
it('应用包装、多层目录和扁平页面都不能替代原一级分类或增加第三级', () => {
  login(['*:*:*'], 'operation', [
    { id: '90', name: '应用工作台', component: 'Layout', children: [
      { id: '91', name: '旧项目分类', children: [menus[2], menus[0]] },
    ] },
    menus[1]?.children?.[0],
  ])
  const groups = getManagementNavigation()
  expect(groups.map(node => node.name)).toEqual(['资源管理', '场景管理', '物联网管理'])
  expect(groups.every(node => !node.routeName && node.children.every(page => page.routeName && page.children.length === 0))).toBe(true)
})
it('资源查询权限与菜单求交集，租户端不能恢复运营模板入口', () => {
  login(['dim3d:model:query'], 'tenant')
  expect(canAccessManagementRoute('modelManage')).toBe(true)
  expect(canAccessManagementRoute('iconManage')).toBe(false)
  expect(canAccessManagementRoute('templateManage')).toBe(false)
  expect(canAccessManagementRoute('iotConnectors')).toBe(false)
  expect(getManagementNavigation()[0]?.children.map(node => node.routeName)).toEqual(['modelManage'])
})
it('空菜单、读取失败与未知组件不回退静态入口，不循环跳转无权场景', () => {
  login(['*:*:*'], 'operation', [])
  expect(getManagementNavigation()).toEqual([])
  expect(getManagementFallbackRoute()).toBe('managementAccess')
  expect(canAccessManagementRoute('sceneManage')).toBe(false)
  login(['*:*:*'], 'operation', [{ id: '1', name: '错误组件', component: 'https://remote.invalid/script' }])
  expect(getManagementFallbackRoute()).toBe('managementAccess')
})
it('隐藏父节点连带关闭地址准入，重复页面只保留第一项', () => {
  login(['*:*:*'], 'operation', [{ ...menus[0], visible: false }, menus[1], menus[1]])
  expect(canAccessManagementRoute('modelManage')).toBe(false)
  expect(getManagementNavigation()).toHaveLength(1)
})
it('当前身份菜单更新和退出可通知布局，解除订阅后不再回调', () => {
  let changes = 0
  const unsubscribe = authContext.subscribe(() => { changes++ })
  login()
  authContext.clear()
  expect(changes).toBe(2)
  unsubscribe()
  login()
  expect(changes).toBe(2)
})
