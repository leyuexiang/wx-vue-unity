import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultVegetationAuthoringDefinition, createSceneDefinition } from '@/scene-platform'
import { validateVegetationSystemDefinition } from '@/scene-platform/core/vegetation'
import { applyVegetationGenerationPreview, applyVegetationPublication, buildVegetationGenerationRequest,
  isVegetationPublicationApplied, type VegetationPublicationResponse } from '../editorVegetationPublicationAdapter'
import { importVegetationPublication } from '../importVegetationPublication'
import { serializeSceneDefinitionToFourPackages } from '../sceneFourPackage'
import { assembleSceneDefinitionFromRuntimeFragments } from '../sceneRuntimeFragmentAssembler'
import { preserveUneditedThreeDDomain, releaseOriginalScenePackages, retainOriginalScenePackages } from '../twoDPackagePreservation'
import { collectScenePackageResourceReferences } from '../sceneAssetUrlResolver'

function definition() {
  const value = createDefaultVegetationAuthoringDefinition('test-scene')
  value.streaming.renderMode = 'published-tiles'
  value.enabled = true
  value.layers = [{ id: 'forest', name: 'Forest', kind: 'forest', visible: true, locked: false, priority: 0, speciesIds: ['tree'] }]
  value.speciesCatalog = [{ id: 'tree', name: 'Tree', enabled: true, minimumScale: 1, maximumScale: 2,
    modelAsset: { id: 'catalog-tree', kind: 'glb', url: 'https://example.test/tree.glb', metadata: { assetId: '9007199254740999' } } }]
  value.rules = [{ id: 'polygon-1', name: 'Forest region', kind: 'polygon', enabled: true, layerId: 'forest', priority: 0, seedOffset: 0,
    speciesMix: [{ speciesId: 'tree', weight: 1 }], distribution: 'poisson', densityPerHectare: 100, minimumSpacingM: 2,
    polygon: { rings: [[[104, 30, 500], [104.001, 30, 500], [104.001, 30.001, 500], [104, 30, 500]]] } }]
  return value
}
const publication: VegetationPublicationResponse = {
  sceneId: 'test-scene', publicationVersion: 'pub-1', taskId: 'task-1', ruleVersion: '1', generatorVersion: '0.3.1',
  manifestUrl: 'https://example.test/manifest.json', tilesetUrl: 'https://example.test/tileset.json',
  layerTilesetUrls: { forest: 'https://example.test/forest.json' }, sourceHash: 'sha256:test', status: 'STABLE', instanceCount: 20, tileCount: 1,
}
afterEach(() => vi.unstubAllGlobals())

describe('vegetation generation and import integration', () => {
  it('freezes drawn coordinates, GLB resource identity, species mix and DEM reference', () => {
    const value = definition(), original = JSON.stringify(value)
    const request = buildVegetationGenerationRequest({ id: 'test-scene', vegetation: value }, {
      elevationSource: { url: 'https://example.test/dem.tif', heightOffsetM: 2, version: 'dem-v1', verticalDatum: 'ellipsoid' },
      idempotencyKey: 'same-request',
    })
    expect(request.rules[0]).toMatchObject({ ruleId: 'polygon-1', type: 'polygon',
      polygon: [{ longitude: 104, latitude: 30 }, { longitude: 104.001, latitude: 30 }, { longitude: 104.001, latitude: 30.001 }, { longitude: 104, latitude: 30 }],
      species: [{ assetId: '9007199254740999', assetKind: 'glb', assetUrl: 'https://example.test/tree.glb', weight: 1, minimumScale: 1, maximumScale: 2 }] })
    expect(request.elevationSource).toEqual({ url: 'https://example.test/dem.tif', heightOffsetM: 2, version: 'dem-v1', verticalDatum: 'ellipsoid' })
    expect(request.idempotencyKey).toBe('same-request')
    expect(JSON.stringify(value)).toBe(original)
  })
  it('rejects native resource URIs, exact-count rules and holes before creating a task', () => {
    const value = definition()
    value.speciesCatalog[0]!.modelAsset.url = 'unity-resource:model/26'
    expect(() => buildVegetationGenerationRequest({ id: 'test', vegetation: value })).toThrow('可访问的 GLB')
    const exact = definition()
    if (exact.rules[0]?.kind !== 'polygon') throw new Error('polygon expected')
    exact.rules[0].targetCount = 100
    expect(() => buildVegetationGenerationRequest({ id: 'test', vegetation: exact })).toThrow('清空目标株数')
    delete exact.rules[0].targetCount
    exact.rules[0].polygon.rings.push(exact.rules[0].polygon.rings[0]!)
    expect(() => buildVegetationGenerationRequest({ id: 'test', vegetation: exact })).toThrow('孔洞')
  })
  it('keeps task previews transient and writes stable publication references only after publishing', () => {
    const value = definition(), before = JSON.stringify(value)
    const preview = applyVegetationGenerationPreview(value, { taskId: 'task-1', tilesetUrl: publication.tilesetUrl })
    expect(preview.publication).toBeUndefined()
    expect(preview.layers[0]!.tilesetAsset?.id).toContain('generation-preview')
    const stable = applyVegetationPublication(value, publication)
    expect(stable.publication?.ruleVersion).toBe('1')
    expect(isVegetationPublicationApplied(stable, publication)).toBe(true)
    expect(validateVegetationSystemDefinition(stable, 'gis').issues).toEqual([])
    expect(JSON.stringify(value)).toBe(before)
  })

  it('saves newly published vegetation without replacing the existing three-dimensional package', () => {
    const scene = createSceneDefinition({ id: 'test-scene', name: 'Test', type: 'gis' })
    const original = serializeSceneDefinitionToFourPackages(scene)
    original.threeDJson = JSON.stringify({ ...JSON.parse(original.threeDJson), futureRenderer: { version: 9 } })
    retainOriginalScenePackages(scene.id, original)
    try {
      scene.vegetation = applyVegetationPublication(definition(), publication)
      const saved = preserveUneditedThreeDDomain(scene.id, serializeSceneDefinitionToFourPackages(scene))
      expect(JSON.parse(saved.threeDJson).futureRenderer).toEqual({ version: 9 })
      const resolvedAssetUrls = {
        'catalog-tree': 'https://example.test/tree.glb',
        'vegetation-manifest:test-scene:pub-1': 'https://example.test/manifest.json',
        'vegetation-tileset:test-scene:pub-1': 'https://example.test/tileset.json',
        'vegetation-tileset:test-scene:pub-1:forest': 'https://example.test/forest.json',
      }
      expect(collectScenePackageResourceReferences(saved.threeDJson)).toContainEqual({
        resourceKey: 'catalog-tree', assetId: '9007199254740999', kind: 'glb',
      })
      const reopened = assembleSceneDefinitionFromRuntimeFragments({
        manifest: { fragmentType: 'manifest', contentJson: JSON.stringify(saved) },
        options: { sceneId: scene.id, resolvedAssetUrls },
      })
      expect(reopened.vegetation?.publication?.version).toBe('pub-1')
      expect(reopened.vegetation?.rules).toEqual(scene.vegetation.rules)
      expect(reopened.vegetation?.speciesCatalog[0]?.modelAsset.url).toBe(resolvedAssetUrls['catalog-tree'])
    } finally {
      releaseOriginalScenePackages(scene.id)
    }
  })
  it('imports model and density references without binding another scene publication or inventing rules', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ format: 'vegetation-generation-manifest-v2',
      layers: [{ layerId: 'forest', tilesetUrl: 'layers/forest.json', densityTilesetUrls: { high: 'high.json', balanced: 'balanced.json', performance: 'low.json' } }],
      tiles: [{ layer_id: 'forest', asset_id: '9007199254740999', asset_url: '../../models/tree.glb' }] })))
    const value = applyVegetationPublication(definition(), publication)
    const imported = await importVegetationPublication(value, 'https://example.test/releases/pub-1/manifest.json')
    expect(imported.rules).toEqual([])
    expect(imported.publication).toBeUndefined()
    expect(imported.layers[0]!.tilesetAsset?.url).toBe('https://example.test/releases/pub-1/layers/forest.json')
    expect(imported.layers[0]!.densityTilesetAssets?.balanced.url).toBe('https://example.test/releases/pub-1/balanced.json')
    expect(imported.speciesCatalog[0]!.modelAsset.url).toBe('https://example.test/models/tree.glb')
    expect(value.publication).toBeDefined()
    const scene = createSceneDefinition({ id: 'test-scene', name: 'Test', type: 'gis' })
    scene.vegetation = imported
    const saved = serializeSceneDefinitionToFourPackages(scene)
    expect(JSON.parse(saved.threeDJson).vegetation.layers[0].tilesetAsset.url).toBeUndefined()
    expect(collectScenePackageResourceReferences(saved.threeDJson)).toEqual([])
    const reopened = assembleSceneDefinitionFromRuntimeFragments({
      manifest: { fragmentType: 'manifest', contentJson: JSON.stringify(saved) }, options: { sceneId: scene.id },
    })
    expect(reopened.vegetation?.layers[0]?.tilesetAsset?.url).toBe(imported.layers[0]?.tilesetAsset?.url)
    expect(reopened.vegetation?.speciesCatalog[0]?.modelAsset.url).toBe(imported.speciesCatalog[0]?.modelAsset.url)
  })
  it('rejects malformed manifests and unsafe URLs without replacing current rules', async () => {
    const value = definition(), before = JSON.stringify(value)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ asset: { version: '1.0' }, root: {} })))
    await expect(importVegetationPublication(value, 'https://example.test/tileset.json')).rejects.toThrow('manifest.json')
    await expect(importVegetationPublication(value, 'file:///example.json')).rejects.toThrow('HTTP(S)')
    await expect(importVegetationPublication(value, 'https://example.test/manifest.json?token=secret')).rejects.toThrow('临时签名')
    expect(JSON.stringify(value)).toBe(before)
  })
})
