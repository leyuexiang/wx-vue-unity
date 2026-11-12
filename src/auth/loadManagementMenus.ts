import request from '@/request'
import { DIM3D_ADMIN_API, DIM3D_SERVER_URL } from '@/servers/manual/dim3d/api/constants'
import { authContext } from './authContext'
import { parseManagementMenus } from './iotNavigation'

/** 内嵌/页签身份不改宿主协议，仅在标准后台部署读取同一令牌的菜单，失败时保持关闭。 */
export async function loadManagementMenus(force = false): Promise<void> {
  const identity = authContext.get()
  if (!DIM3D_ADMIN_API || !identity || (!force && identity.menus !== undefined)) return
  try {
    const response = await request<{ code: number; data?: { menus?: unknown } }>(
      `${DIM3D_SERVER_URL}/admin-api/system/auth/get-permission-info`, { skipPlatformPath: true })
    if (authContext.get() !== identity) return
    authContext.set({ ...identity, menus: response.code === 200 ? parseManagementMenus(response.data?.menus) : [] })
  } catch {
    // 失败关闭管理入口，保留身份供访问提示页重试，不回退静态或全量菜单。
    if (authContext.get() === identity) authContext.set({ ...identity, menus: [] })
  }
}
