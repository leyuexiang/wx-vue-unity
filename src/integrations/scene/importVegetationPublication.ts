import type { VegetationSystemDefinition } from '@/scene-platform/core/types'
import { validateVegetationSystemDefinition } from '@/scene-platform/core/vegetation'

export function readImportedVegetationAddress(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash)
      return url.href
  } catch { /* A saved source address may be absent or invalid. */ }
}

function publicAddress(uri: string, base?: URL): URL {
  const url = new URL(uri, base)
  if (!readImportedVegetationAddress(url.href)) throw new Error('请使用不带登录信息或临时签名参数的 HTTP(S) 发布地址')
  return url
}

async function readPublicationManifest(url: URL) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) })
  if (!response.ok) throw new Error(`植被发布清单读取失败，HTTP ${response.status}`)
  const manifest = await response.json()
  if (manifest?.format !== 'vegetation-generation-manifest-v2' || !Array.isArray(manifest.layers) || !Array.isArray(manifest.tiles))
    throw new Error('请导入生成器的 manifest.json 发布清单；规则文件请使用“导入规则 / 旧数据”')
  return manifest
}

export async function readPublishedVegetationModelUrls(address: string): Promise<Map<string, string>> {
  const url = publicAddress(address)
  const manifest = await readPublicationManifest(url)
  const urls = new Map<string, string>()
  for (const tile of manifest.tiles) {
    if (typeof tile.asset_id === 'string' && typeof tile.asset_url === 'string')
      urls.set(tile.asset_id, publicAddress(tile.asset_url, url).href)
  }
  return urls
}

/** Import generator metadata without inheriting another scene's publication identity. */
export async function importVegetationPublication(
  definition: VegetationSystemDefinition,
  address: string,
): Promise<VegetationSystemDefinition> {
  const url = publicAddress(address.trim())
  if (url.pathname.endsWith('/tileset.json')) url.pathname = url.pathname.replace(/tileset\.json$/, 'manifest.json')
  const manifest = await readPublicationManifest(url)
  const next = JSON.parse(JSON.stringify(definition)) as VegetationSystemDefinition
  next.enabled = true
  next.streaming.enabled = true
  next.streaming.renderMode = 'published-tiles'
  delete next.publication
  const species = new Map<string, VegetationSystemDefinition['speciesCatalog'][number]>()
  const speciesByLayer = new Map<string, Set<string>>()
  for (const tile of manifest.tiles) {
    if (typeof tile.asset_id !== 'string' || typeof tile.asset_url !== 'string') throw new Error('发布清单缺少模型编号或地址')
    const modelUrl = publicAddress(tile.asset_url, url)
    species.set(tile.asset_id, {
      id: tile.asset_id, name: decodeURIComponent(modelUrl.pathname.split('/').pop() ?? tile.asset_id),
      enabled: true, minimumScale: 1, maximumScale: 1,
      modelAsset: { id: tile.asset_id, kind: 'glb', url: modelUrl.href,
        metadata: { assetId: tile.asset_id, publicVegetationSource: modelUrl.href } },
    })
    const layerSpecies = speciesByLayer.get(tile.layer_id) ?? new Set<string>()
    layerSpecies.add(tile.asset_id)
    speciesByLayer.set(tile.layer_id, layerSpecies)
  }
  const asset = (id: string, uri: string) => {
    if (typeof uri !== 'string' || !uri.trim()) throw new Error('发布清单缺少图层瓦片地址')
    const target = publicAddress(uri, url)
    return { id, kind: '3d-tiles' as const, url: target.href, metadata: { publicVegetationSource: target.href } }
  }
  next.speciesCatalog = [...species.values()]
  next.rules = []
  next.layers = manifest.layers.map((layer: { layerId: string; tilesetUrl: string; densityTilesetUrls?: Record<string, string> }) => {
    if (typeof layer.layerId !== 'string' || !layer.layerId.trim()) throw new Error('发布清单缺少图层编号')
    const id = `imported-vegetation:${next.ruleSetId}:${layer.layerId}`
    const density = layer.densityTilesetUrls
    return {
      id: layer.layerId, name: layer.layerId, kind: 'forest' as const, visible: true, locked: false, priority: 0,
      speciesIds: [...(speciesByLayer.get(layer.layerId) ?? [])],
      tilesetAsset: asset(id, layer.tilesetUrl),
      ...(density?.high && density?.balanced && density?.performance ? { densityTilesetAssets: {
        high: asset(`${id}:high`, density.high), balanced: asset(`${id}:balanced`, density.balanced), performance: asset(`${id}:performance`, density.performance),
      } } : {}),
    }
  })
  const result = validateVegetationSystemDefinition(next, 'gis')
  if (result.issues.length) throw new Error(result.issues[0])
  return next
}
