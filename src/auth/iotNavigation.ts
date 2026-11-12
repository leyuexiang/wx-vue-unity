import { authContext } from './authContext'
import type { AuthContext } from './authTypes'

/** 只承载服务端授权菜单；前端绝不把组件字符串当作导入地址执行。 */
export interface ManagementMenu {
  readonly id: string
  readonly name: string
  readonly component?: string
  readonly icon?: string
  readonly visible?: boolean
  readonly children: readonly ManagementMenu[]
}
export const IOT_ROUTES = {
  iotConnectors: { component: 'iotManage/connectors/index', path: '/iotManage/connectors', permission: 'iot:connector:query', title: '连接器管理' },
  iotBindings: { component: 'iotManage/bindings/index', path: '/iotManage/bindings', permission: 'iot:device-binding:query', title: '设备绑定' },
  iotMessages: { component: 'iotManage/messages/index', path: '/iotManage/messages', permission: 'iot:message-inbox:query', title: '接收记录' },
} as const
export type IotRouteName = keyof typeof IOT_ROUTES
export interface IotNavigationNode extends ManagementMenu {
  readonly routeName?: IotRouteName
  readonly children: readonly IotNavigationNode[]
}

/** 网络边界只接受有界菜单树；编号无损转换，复制并冻结，避免外部引用篡改当前身份。 */
export function parseManagementMenus(input: unknown): readonly ManagementMenu[] {
  let remaining = 1000
  const parse = (value: unknown, depth: number): readonly ManagementMenu[] => {
    if (!Array.isArray(value) || depth > 12) return Object.freeze([])
    const result: ManagementMenu[] = []
    for (const item of value) {
      if (--remaining < 0) break
      if (!item || typeof item !== 'object') continue
      const row = item as Record<string, unknown>
      if ((typeof row.id !== 'string' && !(typeof row.id === 'number' && Number.isSafeInteger(row.id))) ||
        typeof row.name !== 'string' || !row.name.trim()) continue
      result.push(Object.freeze({
        id: String(row.id), name: row.name.slice(0, 128),
        ...(typeof row.component === 'string' ? { component: row.component } : {}),
        ...(typeof row.icon === 'string' ? { icon: row.icon } : {}),
        visible: row.visible !== false,
        children: parse(row.children, depth + 1),
      }))
    }
    return Object.freeze(result)
  }
  return parse(input, 0)
}

/** 权限来自当前可信身份；不根据运营/租户平台名称补管理员权限。 */
export function hasIotPermission(permission: string, context = authContext.get()): boolean {
  return !!context && authContext.hasValidContext() &&
    (context.permissions.includes(permission) || context.permissions.includes('*:*:*'))
}

/** 后端顺序原样保留，父节点隐藏连带隐藏子树，缺失菜单不回退全量导航。 */
export function getIotNavigation(context: Readonly<AuthContext> | null = authContext.get()): readonly IotNavigationNode[] {
  const seen = new Set<IotRouteName>()
  const visit = (nodes: readonly ManagementMenu[]): IotNavigationNode[] => nodes.flatMap(node => {
    if (node.visible === false) return []
    const routeName = (Object.keys(IOT_ROUTES) as IotRouteName[]).find(key => IOT_ROUTES[key].component === node.component)
    if (routeName) {
      if (seen.has(routeName) || !hasIotPermission(IOT_ROUTES[routeName].permission, context)) return []
      seen.add(routeName)
      return [{ ...node, routeName, children: [] }]
    }
    // 非白名单的页面配置不能充当父目录，避免把错误配置静默转换成可访问页面。
    if (node.component && node.component !== 'Layout') return []
    const children = visit(node.children)
    return children.length ? [{ ...node, children }] : []
  })
  return context ? visit(context.menus ?? []) : []
}
export function isIotRouteName(name: unknown): name is IotRouteName {
  // 保持当前 TypeScript 目标库兼容，也拒绝从对象原型链继承的路由名称。
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(IOT_ROUTES, name)
}
export function canAccessIotRoute(name: unknown): boolean {
  if (!isIotRouteName(name)) return false
  const contains = (nodes: readonly IotNavigationNode[]): boolean =>
    nodes.some(node => node.routeName === name || contains(node.children))
  return contains(getIotNavigation())
}
