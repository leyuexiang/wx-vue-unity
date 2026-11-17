import { afterEach, describe, expect, it } from 'vitest'
import { authContext } from '../authContext'
import { getIotNavigation, canAccessIotRoute, hasIotPermission, parseManagementMenus } from '../iotNavigation'

const menus = [{ id: '1', name: '设备中心', path: '/iotManage', children: [
  { id: '2', name: '连接配置', component: 'iotManage/connectors/index', path: 'connectors' },
  { id: '3', name: '绑定配置', component: 'iotManage/bindings/index', path: 'bindings' },
  { id: '4', name: '任意组件', component: 'https://invalid/code', path: 'unsafe' },
] }]
const login = (permissions: string[], tree: unknown = menus) => authContext.set({
  accessToken: 'fake', clientId: 'web', tenantId: '7', platformType: 'tenant', roles: [],
  permissions, menus: parseManagementMenus(tree),
})
afterEach(() => authContext.clear())

describe('物联网授权导航', () => {
  it('保留后端层级与名称，只接受编译白名单并交叉校验操作权限', () => {
    login(['iot:connector:query'])
    expect(getIotNavigation()).toEqual([expect.objectContaining({ name: '设备中心', children: [
      expect.objectContaining({ name: '连接配置', routeName: 'iotConnectors' }),
    ] })])
    expect(canAccessIotRoute('iotConnectors')).toBe(true)
    expect(canAccessIotRoute('iotBindings')).toBe(false)
    expect(hasIotPermission('iot:connector:delete')).toBe(false)
  })
  it('隐藏父菜单连带移除子入口，未知组件不能作为文件路径加载', () => {
    login(['*:*:*'], [{ ...menus[0], visible: false }])
    expect(getIotNavigation()).toEqual([])
    expect(canAccessIotRoute('iotConnectors')).toBe(false)
  })
  it('清理及身份切换后不保留上一身份菜单，无菜单不回退全量', () => {
    login(['*:*:*'])
    expect(hasIotPermission('iot:connector:update')).toBe(true)
    authContext.clear()
    expect(getIotNavigation()).toEqual([])
    login(['*:*:*'], [])
    expect(canAccessIotRoute('iotConnectors')).toBe(false)
  })
  it('深拷贝只读菜单，拒绝不安全编号和非菜单响应', () => {
    const source = structuredClone(menus)
    login(['*:*:*'], source)
    source[0]!.name = '被外部修改'
    expect(getIotNavigation()[0]?.name).toBe('设备中心')
    expect(parseManagementMenus({ menus })).toEqual([])
    expect(parseManagementMenus([{ id: Number.MAX_SAFE_INTEGER + 1, name: '错误编号' }])).toEqual([])
  })
})
