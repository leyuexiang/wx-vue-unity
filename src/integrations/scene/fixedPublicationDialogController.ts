import { reactive } from 'vue'
import type { Dim3dSceneDetailVo } from '@/servers/manual/dim3d/api/scene'
import type { FixedPublicationCapabilities, FixedPublicationReceipt, PublicationReadTicket } from './fixedPublicationManagement'

interface Dependencies {
  capabilities: () => Promise<FixedPublicationCapabilities>
  scene: (sceneId: string) => Promise<Dim3dSceneDetailVo>
  publish: (sceneId: string, revisionNo: number, requestId: string) => Promise<FixedPublicationReceipt>
  issue: (publicationId: string, seconds: number) => Promise<PublicationReadTicket>
  revokeTicket: (ticketId: string) => Promise<unknown>
  requestId: () => string
}

/** 发布窗口的异步所有者独立于组件，关闭、换目标及凭证到期都清除敏感内存。 */
export function createFixedPublicationDialogController(deps: Dependencies) {
  const state = reactive({ loading: false, busy: false, error: '', sceneId: '', sceneName: '', revisionNo: 0,
    capabilities: null as FixedPublicationCapabilities | null, publication: null as FixedPublicationReceipt | null,
    ticket: null as PublicationReadTicket | null, ticketExpiresAt: 0, seconds: 300 })
  let generation = 0
  let requestId = ''
  let expiry: ReturnType<typeof setTimeout> | undefined
  const clearTicket = () => {
    if (expiry) clearTimeout(expiry)
    expiry = undefined; state.ticket = null; state.ticketExpiresAt = 0
  }
  const close = () => {
    generation++; requestId = ''; clearTicket()
    Object.assign(state, { loading: false, busy: false, error: '', sceneId: '', sceneName: '', revisionNo: 0, capabilities: null, publication: null })
  }
  const load = async (sceneId: string) => {
    close(); state.loading = true; state.sceneId = sceneId
    const owner = generation
    try {
      const [capabilities, scene] = await Promise.all([deps.capabilities(), deps.scene(sceneId)])
      if (owner !== generation) return
      const revisionNo = scene.currentRevision?.revisionNo
      if (scene.sceneId !== sceneId || !Number.isInteger(revisionNo) || !revisionNo || revisionNo < 1) throw new Error('场景没有有效的已保存版本')
      state.capabilities = capabilities; state.revisionNo = revisionNo; state.sceneName = scene.name || sceneId
      state.seconds = capabilities.ticketDefaultSeconds; requestId = deps.requestId()
    } catch (error) {
      if (owner === generation) state.error = error instanceof Error ? error.message : '发布信息读取失败'
    } finally { if (owner === generation) state.loading = false }
  }
  const publish = async () => {
    if (state.busy || state.loading || !requestId || !state.capabilities) return false
    const owner = generation; state.busy = true; state.error = ''
    try {
      const receipt = await deps.publish(state.sceneId, state.revisionNo, requestId)
      if (owner !== generation) return false
      state.publication = receipt
      return true
    } catch (error) {
      if (owner === generation) state.error = error instanceof Error ? error.message : '发布失败，可重试'
      return false
    } finally { if (owner === generation) state.busy = false }
  }
  const issue = async () => {
    if (state.busy || !state.publication) return
    const owner = generation; state.busy = true; state.error = ''; clearTicket()
    try {
      const ticket = await deps.issue(state.publication.publicationId, state.seconds)
      if (owner !== generation) return
      state.ticket = ticket; state.ticketExpiresAt = Date.now() + ticket.expiresInSeconds * 1000
      expiry = setTimeout(clearTicket, ticket.expiresInSeconds * 1000)
    } catch (error) {
      if (owner === generation) state.error = error instanceof Error ? error.message : '凭证签发失败'
    } finally { if (owner === generation) state.busy = false }
  }
  const revokeTicket = async () => {
    if (state.busy || !state.ticket) return
    const owner = generation; state.busy = true; state.error = ''
    try {
      await deps.revokeTicket(state.ticket.ticketId)
      if (owner === generation) clearTicket()
    } catch (error) {
      if (owner === generation) state.error = error instanceof Error ? error.message : '凭证撤销失败'
    } finally { if (owner === generation) state.busy = false }
  }
  return { state, load, close, publish, issue, revokeTicket }
}
