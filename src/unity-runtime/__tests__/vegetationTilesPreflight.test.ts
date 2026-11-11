import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultVegetationAuthoringDefinition, createSceneDefinition } from '@/scene-platform'
import { checkVegetationTilesForUnity } from '../runtime/vegetationTilesPreflight'
import { UnityEditorSceneRuntime } from '../runtime/UnityEditorSceneRuntime'

function configuration() {
  const config = createDefaultVegetationAuthoringDefinition('published-test')
  config.enabled = true
  config.streaming.renderMode = 'published-tiles'
  config.layers = [{ id: 'forest', name: 'Forest', visible: true, locked: false,
    kind: 'forest', priority: 0, speciesIds: [],
    tilesetAsset: { id: 'tiles', kind: '3d-tiles', url: 'https://example.test/tileset.json' } }]
  return config
}

afterEach(() => vi.unstubAllGlobals())

describe('published vegetation WebGPU preflight', () => {
  it('rejects i3dm before downloading models or sending a Unity apply request', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ root: {
      children: [{ content: { uri: 'tiles/TREES.I3DM?version=2' } }],
    } }))
    vi.stubGlobal('fetch', fetch)
    const unity = { controlVegetation: vi.fn() }
    const scene = createSceneDefinition({ id: 'gis', name: 'GIS', type: 'gis' })
    const runtime = new UnityEditorSceneRuntime('gis', { mode: 'webgpu', getHost: () => null, onStatus: vi.fn() })
    Object.assign(runtime, { unity, scene })
    await expect(runtime.applyVegetationDraft(scene, configuration())).rejects.toThrow('i3dm')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(unity.controlVegetation).not.toHaveBeenCalled()
    await runtime.controlVegetation({ action: 'get' })
    expect(unity.controlVegetation).toHaveBeenCalledWith({ action: 'get' })
  })

  it('protects opening a saved scene and keeps its configuration intact', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ root: { content: { uri: 'forest.i3dm' } } })))
    const scene = createSceneDefinition({ id: 'gis', name: 'GIS', type: 'gis' })
    scene.vegetation = configuration()
    const saved = JSON.stringify(scene)
    const unity = { loadScene: vi.fn() }
    const runtime = new UnityEditorSceneRuntime('gis', { mode: 'webgpu', getHost: () => null, onStatus: vi.fn() })
    Object.assign(runtime, { unity })
    await expect(runtime.loadScene(scene)).rejects.toThrow('i3dm')
    expect(unity.loadScene).not.toHaveBeenCalled()
    expect(JSON.stringify(scene)).toBe(saved)
  })

  it('checks external tilesets, legacy urls and multiple contents without looping', async () => {
    const fetch = vi.fn().mockImplementation(async (url: URL) => Response.json(url.pathname.endsWith('external.json')
      ? { root: { contents: [{ url: '../forest.i3dm' }, { uri: '../tileset.json' }] } }
      : { root: { children: [{ content: { uri: 'nested/external.json' } }] } }))
    vi.stubGlobal('fetch', fetch)
    await expect(checkVegetationTilesForUnity(configuration(), 'webgpu')).rejects.toThrow('i3dm')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('allows ordinary GLB/b3dm tiles and selects the active density entry', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ root: { children: [
      { content: { uri: 'tree.glb' } }, { content: { uri: 'forest.b3dm' } },
    ] } }))
    vi.stubGlobal('fetch', fetch)
    const config = configuration()
    const asset = { id: 'balanced', kind: '3d-tiles' as const, url: 'https://example.test/balanced.json' }
    config.layers[0]!.densityTilesetAssets = { high: asset, balanced: asset, performance: asset }
    await checkVegetationTilesForUnity(config, 'webgpu')
    expect(String(fetch.mock.calls[0]![0])).toBe(asset.url)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('skips disabled, hidden and native vegetation and cloud rendering', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const config = configuration()
    await checkVegetationTilesForUnity(config, 'cloud')
    await checkVegetationTilesForUnity(config, 'webgpu', true)
    config.enabled = false
    await checkVegetationTilesForUnity(config, 'webgpu')
    config.enabled = true
    config.layers[0]!.visible = false
    await checkVegetationTilesForUnity(config, 'webgpu')
    config.layers[0]!.visible = true
    config.streaming.renderMode = 'instanced'
    await checkVegetationTilesForUnity(config, 'webgpu')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('reports failed checks and prevents a late apply after the scene changes', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('', { status: 403 }))
    vi.stubGlobal('fetch', fetch)
    await expect(checkVegetationTilesForUnity(configuration(), 'webgpu')).rejects.toThrow('HTTP 403')
    const unity = { controlVegetation: vi.fn() }
    const runtime = new UnityEditorSceneRuntime('gis', { mode: 'webgpu', getHost: () => null, onStatus: vi.fn() })
    Object.assign(runtime, { unity, scene: createSceneDefinition({ id: 'gis', name: 'GIS', type: 'gis' }) })
    fetch.mockImplementation(async () => {
      runtime.clearScene()
      return Response.json({ root: {} })
    })
    await expect(runtime.controlVegetation({ action: 'apply', config: configuration() })).rejects.toThrow('场景已切换')
    expect(unity.controlVegetation).not.toHaveBeenCalled()
  })
})
