import { authContext } from '@/auth/authContext'

/** 配置页保留可扩展入口；本接口当前只管理两个网页渲染包位置。 */
export type WebPackageChannel = 'stable' | 'development'
export interface WebPackageDraft {
  active: WebPackageChannel
  packages: Record<WebPackageChannel, string>
  revision: string
}
export type WebPackageChecks = Record<WebPackageChannel, { ready: boolean; message: string }>
export interface WebPackageSettings extends WebPackageDraft { checks: WebPackageChecks }
/** 目录弹窗仅请求当前层，配套资源检查结果决定当前文件夹是否可以选用。 */
export interface WebPackageDirectories {
  path: string
  directories: { name: string; path: string }[]
  selection: { ready: boolean; message: string }
}

/** 与播放器启动接口使用同一应用根路径和认证上下文，支持部署到任意子目录。 */
async function request<T>(method: string, suffix = '', draft?: WebPackageDraft, signal?: AbortSignal): Promise<T> {
  const context = authContext.get()
  const url = new URL(`./unity-runtime/config/webgpu${suffix}`, new URL(import.meta.env.BASE_URL, document.baseURI))
  const response = await fetch(url, {
    method, cache: 'no-store', credentials: 'same-origin',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
    headers: {
      ...(context ? { Authorization: `Bearer ${context.accessToken}`, ClientId: context.clientId, 'X-Unity-Platform': context.platformType } : {}),
      ...(context?.tenantId ? { 'tenant-id': context.tenantId } : {}),
      ...(draft ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(draft ? { body: JSON.stringify(draft) } : {}),
  })
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new Error(body?.error || `配置服务请求失败（${response.status}），请确认网页渲染网关已启动`)
  return body as T
}

/** 检查不会保存草稿；只有保存成功返回的快照才代表服务器当前使用的版本。 */
export const webgpuPackageApi = {
  load: () => request<WebPackageSettings>('GET'),
  directories: (path: string, signal?: AbortSignal) =>
    request<WebPackageDirectories>('GET', `/directories?path=${encodeURIComponent(path)}`, undefined, signal),
  check: (draft: WebPackageDraft) => request<{ checks: WebPackageChecks }>('POST', '/check', draft),
  save: (draft: WebPackageDraft) => request<WebPackageSettings>('PUT', '', draft),
}
