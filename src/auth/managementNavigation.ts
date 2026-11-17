import { authContext } from './authContext'
import { createManagementCapabilities } from './capabilities'
import { IOT_ROUTES, hasIotPermission } from './iotNavigation'
import type { ManagementMenu } from './iotNavigation'

/** 编译期页面登记，不以后台path/component拼接导入地址；接口授权保持各业务原有规则。 */
export const MANAGEMENT_ROUTES = {
  modelManage: { component: 'resourceManage/modelManage/index', permission: 'dim3d:model:query', sidebarIcon: 'model' },
  iconManage: { component: 'resourceManage/iconManage/index', permission: 'dim3d:icon:query', sidebarIcon: 'icon' },
  templateManage: { component: 'resourceManage/templateManage/index', permission: '', sidebarIcon: 'template' },
  sceneManage: { component: 'SceneManage/index', permission: '', sidebarIcon: 'scene' },
  ...IOT_ROUTES,
} as const
export type ManagementRouteName = keyof typeof MANAGEMENT_ROUTES
/** 产品已确认的一级业务分类与二级入口；后台包装目录不能改变页面所属模块。 */
const MANAGEMENT_GROUPS = [
  { key: 'resources', name: '资源管理' }, { key: 'scenes', name: '场景管理' }, { key: 'iot', name: '物联网管理' },
] as const
type ManagementGroupKey = typeof MANAGEMENT_GROUPS[number]['key']
const MANAGEMENT_PRESENTATION: Record<ManagementRouteName, { group: ManagementGroupKey; name: string }> = {
  modelManage: { group: 'resources', name: '模型管理' },
  iconManage: { group: 'resources', name: '图片管理' },
  templateManage: { group: 'resources', name: '模板管理' },
  sceneManage: { group: 'scenes', name: '场景列表' },
  iotConnectors: { group: 'iot', name: '连接器管理' },
  iotBindings: { group: 'iot', name: '设备绑定' },
  iotMessages: { group: 'iot', name: '接收记录' },
}
export interface ManagementNavigationNode extends ManagementMenu {
  readonly routeName?: ManagementRouteName
  readonly sidebarIcon?: string
  readonly children: readonly ManagementNavigationNode[]
}
const componentRoutes = new Map<string, ManagementRouteName>(Object.entries(MANAGEMENT_ROUTES).map(([name, value]) => [
  value.component, name as ManagementRouteName,
]))
export function isManagementRouteName(name: unknown): name is ManagementRouteName {
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(MANAGEMENT_ROUTES, name)
}

/** 授权仍取后台，展示投影为原有两级业务目录；不补缺失页面，保留模块内授权顺序。 */
export function getManagementNavigation(): readonly ManagementNavigationNode[] {
  const context = authContext.get()
  if (!context || !authContext.hasValidContext()) return []
  const templateAllowed = createManagementCapabilities(context).template.canAccess
  const seen = new Set<ManagementRouteName>()
  const groups: Record<ManagementGroupKey, ManagementNavigationNode[]> = { resources: [], scenes: [], iot: [] }
  const visit = (nodes: readonly ManagementMenu[]): void => {
    for (const node of nodes) {
      if (node.visible === false) continue
      const routeName = componentRoutes.get(node.component ?? '')
      if (routeName) {
        const entry = MANAGEMENT_ROUTES[routeName]
        if (seen.has(routeName) || (entry.permission && !hasIotPermission(entry.permission)) ||
          (routeName === 'templateManage' && !templateAllowed)) continue
        seen.add(routeName)
        const presentation = MANAGEMENT_PRESENTATION[routeName]
        groups[presentation.group].push({ ...node, name: presentation.name, routeName,
          ...('sidebarIcon' in entry ? { sidebarIcon: entry.sidebarIcon } : {}), children: [] })
        continue
      }
      // 只穿过后台目录；未知页面仍不允许作为授权容器，隐藏父级也不能被投影绕过。
      if (!node.component || node.component === 'Layout') visit(node.children)
    }
  }
  visit(context.menus ?? [])
  return MANAGEMENT_GROUPS.flatMap(group => groups[group.key].length
    ? [{ id: 'management-group-' + group.key, name: group.name, children: groups[group.key] }] : [])
}
export function canAccessManagementRoute(name: unknown): boolean {
  if (!isManagementRouteName(name)) return false
  const contains = (nodes: readonly ManagementNavigationNode[]): boolean =>
    nodes.some(node => node.routeName === name || contains(node.children))
  return contains(getManagementNavigation())
}
/** 优先保留现有场景首页；没有授权场景时选首个有效页面，空菜单使用独立恢复页。 */
export function getManagementFallbackRoute(): ManagementRouteName | 'managementAccess' {
  const names: ManagementRouteName[] = []
  const visit = (nodes: readonly ManagementNavigationNode[]) => {
    for (const node of nodes) {
      if (node.routeName) names.push(node.routeName)
      else visit(node.children)
    }
  }
  visit(getManagementNavigation())
  return names.includes('sceneManage') ? 'sceneManage' : names[0] ?? 'managementAccess'
}
