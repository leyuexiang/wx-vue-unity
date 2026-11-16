import request from '@/request'
import type { UnitySessionInitializePayload } from '@/unity-runtime/protocol/types'

export type FixedPublicationResources = NonNullable<UnitySessionInitializePayload['publicationResources']>
export type FixedPublication = {
  sceneId: string
  revisionNo: number
  sceneJson: string
  threeDJson: string
  twoDJson: string
  dependenciesJson: string
  resources: FixedPublicationResources
}

const rootHttpsOrigin = (text: string) => {
  const url = new URL(text)
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.username || url.password || url.search || url.hash) {
    throw new Error('固定发布资源需要配置 HTTPS 根地址')
  }
  return url.origin
}

/** 四包和资源目录同时绑定当前票据，浏览器只保留本页需要的授权信息。 */
export async function loadFixedScenePublication(publicationId: string, ticket: string): Promise<FixedPublication> {
  if (!/^PUB-[1-9]\d{0,18}$/.test(publicationId) || !/^[A-Za-z0-9_-]{40,256}$/.test(ticket)) {
    throw new Error('发布编号或访问票据格式无效')
  }
  const apiBaseUrl = rootHttpsOrigin(String(import.meta.env.VITE_UNITY_PUBLICATION_API_ORIGIN || globalThis.location?.origin || ''))
  // 网页四包、测点与 Unity 文件签发访问同一发布网关。
  const endpoint = `${apiBaseUrl}/admin-api/dim3d/scene/publication/preview`
  const sources = String(import.meta.env.VITE_UNITY_RESOURCE_DOWNLOAD_ORIGINS || '').split(',')
    .map((value) => value.trim()).filter(Boolean)
  const downloadOrigins = [...new Set(sources.map(rootHttpsOrigin))]
  if (!downloadOrigins.length) throw new Error('缺少发布模型下载来源')
  const options = {
    method: 'POST',
    headers: { 'X-Scene-Ticket': ticket },
    passAuth: true,
    publicPreview: true,
    anonymousPublicPreview: true,
    skipPlatformPath: true,
  }
  type PublishedSnapshot = Omit<FixedPublication, 'resources'> & { publicationId: string }
  type Resource = FixedPublicationResources['catalog'][string] & { resourceKey: string }
  type Envelope<T> = { code: number; data?: T }
  const settled = await Promise.all([
    request<Envelope<PublishedSnapshot>>(endpoint, options),
    request<Envelope<{ publicationId: string; resources: Resource[] }>>(`${endpoint}/resources`, options),
  ]).catch(() => { throw new Error('固定发布读取失败，请核对发布编号及访问票据') })
  const [snapshotResult, catalogResult] = settled
  const snapshot = snapshotResult.data
  const catalog = catalogResult.data
  if (snapshotResult.code !== 200 || catalogResult.code !== 200 || snapshot?.publicationId !== publicationId ||
      catalog?.publicationId !== publicationId || !Array.isArray(catalog.resources) || catalog.resources.length > 256 ||
      !Number.isInteger(snapshot.revisionNo) || snapshot.revisionNo < 1) {
    throw new Error('固定发布已失效或资源索引不可用')
  }
  const records = Object.create(null) as Record<string, Resource>
  for (const resource of catalog.resources) {
    const key = resource?.resourceKey
    if (!key || key.length > 160 || records[key]) throw new Error('固定发布资源键无效')
    records[key] = resource
  }
  return {
    ...snapshot,
    resources: { apiBaseUrl, publicationId, ticket, downloadOrigins, catalog: records },
  }
}
