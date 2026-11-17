import request from '@/request'
import { authContext } from '@/auth/authContext'
import { DIM3D_SERVER_URL } from '@/servers/manual/dim3d/api/constants'
import type { Dim3dSceneDetailVo } from '@/servers/manual/dim3d/api/scene'

export interface FixedPublicationCapabilities {
  protocol: 'fixed-ticket-v1'
  accessModes: Array<{ value: 'TICKET'; label: string }>
  ticketDefaultSeconds: number
  ticketMinSeconds: number
  ticketMaxSeconds: number
}
export interface FixedPublicationReceipt {
  sceneId: string
  publicationId: string
  revisionNo: number
  status: 'PUBLISHED'
  alreadyPublished?: boolean
}
export interface PublicationReadTicket {
  publicationId: string
  ticketId: string
  token: string
  scope: 'READ'
  expiresInSeconds: number
}

/** 固定发布管理只使用当前登录身份，不采用历史临时令牌或客户端传入的租户。 */
async function call<T>(path: string, method = 'GET', params?: Record<string, unknown>): Promise<T> {
  const identity = authContext.get()
  if (!identity || !authContext.hasValidContext()) throw new Error('请先登录')
  const response = await request<{ code?: number; msg?: string; data?: T }>(`${DIM3D_SERVER_URL}/admin-api/dim3d/scene/${path}`, {
    method, params, skipPlatformPath: true,
  })
  const current = authContext.get()
  if (!current || !authContext.hasValidContext() || current.accessToken !== identity.accessToken || current.tenantId !== identity.tenantId || current.platformType !== identity.platformType) {
    throw new Error('登录状态已变化，请重新打开发布窗口')
  }
  if (response.code !== 200 || response.data == null) throw new Error(response.msg || '发布管理请求失败')
  return response.data
}

const sceneIdValue = (id: string) => {
  if (!/^[1-9]\d{0,18}$/.test(id)) throw new Error('场景编号无效')
  return id
}
export const publicationIdValue = (id: string) => {
  if (!/^PUB-[1-9]\d{0,18}$/.test(id)) throw new Error('发布编号无效')
  return id
}

export async function getFixedPublicationCapabilities(): Promise<FixedPublicationCapabilities> {
  const data = await call<FixedPublicationCapabilities>('publication/capabilities')
  if (data.protocol !== 'fixed-ticket-v1' || !data.accessModes.some(mode => mode.value === 'TICKET') || data.ticketMinSeconds < 60 || data.ticketMaxSeconds > 3600 || data.ticketDefaultSeconds < data.ticketMinSeconds || data.ticketDefaultSeconds > data.ticketMaxSeconds) {
    throw new Error('当前服务没有提供可用的受控发布能力')
  }
  return data
}
export const getPublicationScene = (sceneId: string) => call<Dim3dSceneDetailVo>(`info/${sceneIdValue(sceneId)}`)

export async function publishCurrentScene(sceneId: string, revisionNo: number, requestId: string): Promise<FixedPublicationReceipt> {
  sceneIdValue(sceneId)
  if (!Number.isInteger(revisionNo) || revisionNo < 1 || !requestId.trim() || requestId.length > 110) throw new Error('发布确认参数无效')
  const data = await call<FixedPublicationReceipt>('publication/publish-current', 'POST', { sceneId, revisionNo, requestId })
  if (data.sceneId !== sceneId || data.revisionNo !== revisionNo || data.status !== 'PUBLISHED' || !/^PUB-[1-9]\d{0,18}$/.test(data.publicationId)) throw new Error('发布回执与确认版本不一致')
  return data
}

export async function issuePublicationTicket(publicationId: string, expiresInSeconds = 300): Promise<PublicationReadTicket> {
  publicationIdValue(publicationId)
  if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 60 || expiresInSeconds > 3600) throw new Error('凭证有效期必须在 60 到 3600 秒之间')
  const ticket = await call<PublicationReadTicket>(`publication/${publicationId}/ticket`, 'POST', { expiresInSeconds })
  if (ticket.publicationId !== publicationId || ticket.scope !== 'READ' || !/^TKT-[1-9]\d{0,18}$/.test(ticket.ticketId) || !/^[A-Za-z0-9_-]{40,256}$/.test(ticket.token) || ticket.expiresInSeconds !== expiresInSeconds) throw new Error('发布凭证响应无效')
  return ticket
}
export const revokePublicationTicket = (ticketId: string) => {
  if (!/^TKT-[1-9]\d{0,18}$/.test(ticketId)) throw new Error('凭证编号无效')
  return call<boolean>(`publication/ticket/${ticketId}`, 'DELETE')
}
export const revokeFixedPublication = (publicationId: string) => call<boolean>(`publication/${publicationIdValue(publicationId)}/revoke`, 'POST')

/** 只使用无凭据的固定发布编号生成地址；浏览器部署子路径由当前应用配置给出。 */
export function fixedPublicationPath(publicationId: string): string {
  const base = String(import.meta.env.BASE_URL || '/dts/').replace(/\/?$/, '/')
  return `${base}scenePreview?publicationId=${encodeURIComponent(publicationIdValue(publicationId))}`
}

/** 自动签发的预览凭证只在本页续期；失败不重建场景，关闭或身份变化后停止。 */
export function renewManagedPreviewTicket(initial: PublicationReadTicket, options: {
  issue?: typeof issuePublicationTicket
  onTicket: (ticket: PublicationReadTicket) => void
  onExpired: () => void
}) {
  const identity = authContext.get()
  let current = initial
  let deadline = Date.now() + initial.expiresInSeconds * 1000
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  const stop = () => { stopped = true; if (timer) clearTimeout(timer); timer = undefined }
  const schedule = (delay: number) => { timer = setTimeout(() => { void renew() }, delay) }
  const renew = async () => {
    const auth = authContext.get()
    if (stopped) return
    if (!identity || !auth || auth.accessToken !== identity.accessToken || auth.tenantId !== identity.tenantId || auth.platformType !== identity.platformType || !authContext.hasValidContext() || Date.now() >= deadline) {
      stop(); options.onExpired(); return
    }
    try {
      const next = await (options.issue ?? issuePublicationTicket)(current.publicationId, current.expiresInSeconds)
      if (stopped) return
      current = next; deadline = Date.now() + next.expiresInSeconds * 1000
      options.onTicket(next)
      schedule(Math.max(1000, next.expiresInSeconds * 1000 - 30000))
    } catch {
      if (stopped) return
      if (Date.now() >= deadline) { stop(); options.onExpired() }
      else schedule(Math.min(5000, deadline - Date.now()))
    }
  }
  schedule(Math.max(1000, initial.expiresInSeconds * 1000 - 30000))
  return stop
}
