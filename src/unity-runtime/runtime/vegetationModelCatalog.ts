import type { AssetRef } from '@/scene-platform/core/types'

export interface VegetationModelChoice {
  id: string
  name: string
  asset: AssetRef
}

export interface VegetationCatalogDeployment {
  projectId: string
  descriptorBase64: string
  releaseBaseUrl: string
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

/** List the templates from the same release admitted by the running Web player. */
export async function loadVegetationModelCatalog(
  deployment: VegetationCatalogDeployment,
): Promise<VegetationModelChoice[]> {
  const descriptor = record(JSON.parse(atob(deployment.descriptorBase64)))
  const base = new URL(deployment.releaseBaseUrl)
  const manifestResponse = await fetch(
    new URL('ArtReleaseManifest.json', base),
    {
      credentials: 'omit',
      cache: 'no-store',
      signal: AbortSignal.timeout(15000),
    },
  )
  if (!manifestResponse.ok) throw new Error('Unity 模型发布清单读取失败')
  const manifest = record(await manifestResponse.json())
  if (
    manifest.projectId !== deployment.projectId ||
    manifest.releaseHash !== descriptor.releaseHash ||
    typeof manifest.catalogFile !== 'string'
  )
    throw new Error('模型目录与当前 Unity 资源版本不一致')
  const catalogUrl = new URL(manifest.catalogFile, base)
  if (
    catalogUrl.origin !== base.origin ||
    !catalogUrl.pathname.startsWith(base.pathname)
  )
    throw new Error('模型目录地址无效')
  const response = await fetch(catalogUrl, {
    credentials: 'omit',
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) throw new Error('Unity 模型目录读取失败')
  const bytes = await response.arrayBuffer()
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const hash =
    'sha256:' +
    Array.from(new Uint8Array(digest), (value) =>
      value.toString(16).padStart(2, '0'),
    ).join('')
  if (hash !== manifest.catalogSha256) throw new Error('Unity 模型目录校验失败')
  const catalog = record(JSON.parse(new TextDecoder().decode(bytes)))
  if (
    catalog.projectId !== deployment.projectId ||
    !Array.isArray(catalog.resources)
  )
    throw new Error('Unity 模型目录格式无效')
  const models = new Map<string, VegetationModelChoice>()
  for (const value of catalog.resources) {
    const resource = record(value)
    if (
      resource.kind !== 'Model' ||
      resource.deprecated === true ||
      typeof resource.legacyId !== 'string' ||
      !resource.legacyId.trim()
    )
      continue
    const nativeId = resource.legacyId.trim()
    const id = `unity-model:${deployment.projectId}:${nativeId}`
    const name =
      typeof resource.sceneName === 'string' && resource.sceneName.trim()
        ? resource.sceneName
        : nativeId
    models.set(nativeId, {
      id,
      name,
      asset: {
        id,
        kind: 'glb',
        url: `unity-resource:model/${encodeURIComponent(nativeId)}`,
        ...(typeof resource.resourceVersion === 'string' &&
        resource.resourceVersion
          ? { version: resource.resourceVersion }
          : {}),
        metadata: {
          source: 'unity-catalog',
          assetId: nativeId,
          projectId: deployment.projectId,
        },
      },
    })
  }
  const vegetation = (name: string) =>
    /植被|树|tree|plant|grass|草|灌木/i.test(name) ? 0 : 1
  return [...models.values()].sort(
    (a, b) =>
      vegetation(a.name) - vegetation(b.name) || a.name.localeCompare(b.name),
  )
}
