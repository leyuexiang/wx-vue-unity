import type { VegetationSystemDefinition } from '@/scene-platform/core/types'
import type { UnityRenderMode } from '../renderMode'

type Tile = {
  content?: { uri?: string; url?: string }
  contents?: Array<{ uri?: string; url?: string }>
  children?: Tile[]
}

/** The current Cesium WebGPU player does not expand i3dm instances correctly. */
export async function checkVegetationTilesForUnity(
  vegetation: VegetationSystemDefinition | null | undefined,
  mode: UnityRenderMode,
  supportsPublishedInstancing = false,
): Promise<void> {
  if (supportsPublishedInstancing || mode !== 'webgpu' || !vegetation || vegetation.enabled === false ||
    vegetation.streaming.enabled === false || vegetation.streaming.renderMode === 'instanced') return

  const quality = vegetation.streaming.qualityPreset ?? 'balanced'
  const pending = vegetation.layers.filter(layer => layer.visible !== false).map(layer =>
    layer.densityTilesetAssets?.[quality]?.url ?? layer.tilesetAsset?.url ??
    (layer.manifestAsset?.kind === '3d-tiles' ? layer.manifestAsset.url : undefined),
  ).filter((url): url is string => Boolean(url))
  const visited = new Set<string>()
  const signal = AbortSignal.timeout(10000)
  while (pending.length) {
    const url = new URL(pending.pop()!)
    const extension = decodeURIComponent(url.pathname).toLowerCase()
    if (extension.endsWith('.i3dm')) {
      throw new Error('当前 WebGPU 暂不支持该植被包的 i3dm 实例化内容，已取消加载以避免内存溢出。请使用普通 GLB/b3dm 瓦片或原生实例化。')
    }
    if (visited.has(url.href)) continue
    if (visited.size >= 32) throw new Error('植被瓦片清单层级过多，兼容性检查未完成，已取消加载。')
    visited.add(url.href)
    let root: Tile
    try {
      const response = await fetch(url, { signal })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const manifest = await response.json() as { root?: Tile }
      if (!manifest.root) throw new Error('缺少 root 节点')
      root = manifest.root
    } catch (error) {
      throw new Error(`植被瓦片兼容性检查失败，已取消加载。${error instanceof Error ? error.message : '无法读取清单'}`)
    }
    const tiles = [root]
    while (tiles.length) {
      const tile = tiles.pop()!
      for (const content of [...(tile.content ? [tile.content] : []), ...(tile.contents ?? [])]) {
        const uri = content.uri ?? content.url
        if (!uri) continue
        const contentUrl = new URL(uri, url)
        const path = decodeURIComponent(contentUrl.pathname).toLowerCase()
        if (path.endsWith('.i3dm') || path.endsWith('.json')) pending.push(contentUrl.href)
      }
      tiles.push(...(tile.children ?? []))
    }
  }
}
