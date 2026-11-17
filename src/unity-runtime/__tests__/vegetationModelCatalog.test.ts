import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { loadVegetationModelCatalog } from '../runtime/vegetationModelCatalog'
import {
  createDefaultVegetationAuthoringDefinition,
  createSceneDefinition,
} from '@/scene-platform'
import { serializeSceneDefinitionToFourPackages } from '@/integrations/scene/sceneFourPackage'
import { assembleSceneDefinitionFromRuntimeFragments } from '@/integrations/scene/sceneRuntimeFragmentAssembler'
import {
  collectScenePackageResourceReferences,
  resolveSceneAssetUrls,
} from '@/integrations/scene/sceneAssetUrlResolver'

const catalog = JSON.stringify({
  projectId: '1',
  resources: [
    {
      kind: 'Model',
      legacyId: '26',
      sceneName: '树木 - Tree_05',
      resourceVersion: '1',
    },
    { kind: 'Model', legacyId: '1', sceneName: '车辆' },
    { kind: 'Model', legacyId: 'old', sceneName: '旧树', deprecated: true },
    { kind: 'Image', legacyId: 'image', sceneName: '图片' },
  ],
})
const manifest = {
  projectId: '1',
  releaseHash: 'sha256:current',
  catalogFile: 'ArtResourceCatalog.json',
  catalogSha256: 'sha256:' + createHash('sha256').update(catalog).digest('hex'),
}
const deployment = {
  projectId: '1',
  descriptorBase64: btoa(JSON.stringify({ releaseHash: manifest.releaseHash })),
  releaseBaseUrl: 'https://art.test/release/',
}
function mockRelease(value = manifest) {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify(value)))
    .mockResolvedValueOnce(new Response(catalog))
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}
afterEach(() => vi.unstubAllGlobals())

describe('vegetation model resource selection', () => {
  it('lists admitted Unity models without depending on scene objects, with trees first', async () => {
    mockRelease()
    const choices = await loadVegetationModelCatalog(deployment)
    expect(choices.map((item) => item.name)).toEqual(['树木 - Tree_05', '车辆'])
    expect(choices[0]?.asset).toMatchObject({
      id: 'unity-model:1:26',
      url: 'unity-resource:model/26',
      metadata: { source: 'unity-catalog', assetId: '26' },
    })
  })

  it('rejects a manifest for another player release', async () => {
    const fetcher = mockRelease({ ...manifest, releaseHash: 'sha256:other' })
    await expect(loadVegetationModelCatalog(deployment)).rejects.toThrow(
      '版本不一致',
    )
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('rejects a changed model catalog instead of listing unchecked identities', async () => {
    mockRelease({ ...manifest, catalogSha256: 'sha256:wrong' })
    await expect(loadVegetationModelCatalog(deployment)).rejects.toThrow(
      '校验失败',
    )
  })

  it('restores saved native template references without treating them as model file IDs', async () => {
    mockRelease()
    const [choice] = await loadVegetationModelCatalog(deployment)
    const scene = createSceneDefinition({
      id: 'native-resource-selection',
      name: '植被',
      type: 'gis',
      coordinateSystem: {
        kind: 'wgs84',
        defaultLongitude: 104,
        defaultLatitude: 30,
        defaultHeight: 0,
        terrainEnabled: false,
      },
    })
    scene.vegetation = createDefaultVegetationAuthoringDefinition(scene.id)
    scene.vegetation.streaming.renderMode = 'instanced'
    scene.vegetation.speciesCatalog = [
      {
        id: 'tree',
        name: choice!.name,
        modelAsset: choice!.asset,
        enabled: true,
        minimumScale: 1,
        maximumScale: 1,
      },
    ]
    const saved = serializeSceneDefinitionToFourPackages(scene)
    const fetcher = vi.fn(() => {
      throw Error('Native resources must not request model file metadata')
    })
    vi.stubGlobal('fetch', fetcher)
    const urls = await resolveSceneAssetUrls(saved.dependenciesJson, {
      additionalResources: collectScenePackageResourceReferences(
        JSON.parse(saved.threeDJson),
      ),
    })
    expect(fetcher).not.toHaveBeenCalled()
    const restored = assembleSceneDefinitionFromRuntimeFragments({
      manifest: {
        fragmentType: 'manifest',
        contentJson: JSON.stringify(saved),
      },
      options: { sceneId: scene.id, resolvedAssetUrls: urls },
    })
    expect(restored.vegetation?.speciesCatalog[0]?.modelAsset).toMatchObject({
      id: 'unity-model:1:26',
      url: 'unity-resource:model/26',
      metadata: { assetId: '26' },
    })
  })
})
