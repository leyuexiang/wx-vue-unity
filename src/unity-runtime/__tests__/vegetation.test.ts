import { describe, expect, it } from 'vitest'
import {
  createSceneDefinition,
  createDefaultVegetationAuthoringDefinition,
  createUpdateVegetationSystemCommand,
} from '@/scene-platform'
import { migrateLegacyPlantings } from '@/integrations/scene/legacyPlantingMigration'
import { readSavedVegetationPublicationIdentity } from '@/views/SceneManage/vegetationPublicationValidation'
import { serializeSceneDefinitionToFourPackages } from '@/integrations/scene/sceneFourPackage'
import { assembleSceneDefinitionFromRuntimeFragments } from '@/integrations/scene/sceneRuntimeFragmentAssembler'
import { projectSceneForUnity } from '../runtime/projectSceneForUnity'
import type { Dim3dSceneDetailResponse } from '@/servers/manual/dim3d/api/scene'

function configuration() {
  const value = createDefaultVegetationAuthoringDefinition('planting-test')
  value.streaming.renderMode = 'instanced'
  value.layers = [
    {
      id: 'forest',
      name: '树林',
      kind: 'forest',
      visible: true,
      locked: false,
      priority: 0,
      speciesIds: ['birch'],
    },
  ]
  value.speciesCatalog = [
    {
      id: 'birch',
      name: '白桦',
      enabled: true,
      minimumScale: 1,
      maximumScale: 2,
      modelAsset: {
        id: 'model-1',
        kind: 'glb',
        url: 'https://example.test/tree.glb',
        metadata: { assetId: 'model-1' },
      },
    },
  ]
  return value
}
const legacy = {
  plantings: [
    {
      plantingId: 'old-forest',
      plantingName: '旧区域',
      drawMode: 0,
      currentPlantingVisibility: false,
      totalTrees: 800,
      treeSpacing: 5,
      geoPoints: [
        { longitude: 104, latitude: 30, height: 100 },
        { longitude: 104.001, latitude: 30, height: 110 },
        { longitude: 104.001, latitude: 30.001, height: 115 },
      ],
      treeTypes: [{ treeType: '白桦', ratio: 1 }],
    },
  ],
}

describe('native vegetation scene integration', () => {
  it('migrates existing polygon data with stable IDs, height, visibility, tree counts and resource bindings', () => {
    const original = configuration()
    const result = migrateLegacyPlantings(legacy, original)
    expect(original.rules).toEqual([])
    expect(result.rules[0]).toMatchObject({
      id: 'old-forest',
      enabled: false,
      kind: 'polygon',
      targetCount: 800,
      speciesMix: [{ speciesId: 'birch', weight: 1 }],
      minimumSpacingM: 5,
    })
    if (result.rules[0]?.kind !== 'polygon') throw new Error('Wrong rule kind')
    expect(result.rules[0].polygon.rings[0]).toHaveLength(4)
    expect(result.rules[0].polygon.rings[0]?.[0]).toEqual([104, 30, 100])
    expect(result.rules[0].polygon.rings[0]?.at(-1)).toEqual([104, 30, 100])
  })

  it('migrates line mode without silently adding a second row of trees', () => {
    const input = structuredClone(legacy)
    input.plantings[0]!.drawMode = 3
    const result = migrateLegacyPlantings(input, configuration())
    expect(result.rules[0]).toMatchObject({
      kind: 'corridor',
      side: 'left',
      offsetM: 0,
      spacingM: 5,
      alignToPath: true,
    })
  })

  it('rejects unknown species and repeated region IDs without changing the current document', () => {
    const config = configuration()
    const missing = structuredClone(legacy)
    missing.plantings[0]!.treeTypes[0]!.treeType = '未知树种'
    expect(() => migrateLegacyPlantings(missing, config)).toThrow('未知树种')
    const imported = migrateLegacyPlantings(legacy, config)
    expect(() => migrateLegacyPlantings(legacy, imported)).toThrow('重复')
    expect(config.rules).toEqual([])
  })

  it('keeps native rules in Unity projection and saved packages while allowing native scene publication', () => {
    const scene = createSceneDefinition({
      id: 'native-forest',
      name: '树林',
      type: 'gis',
      coordinateSystem: {
        kind: 'wgs84',
        defaultLongitude: 104,
        defaultLatitude: 30,
        defaultHeight: 100,
        terrainEnabled: false,
      },
    })
    scene.vegetation = migrateLegacyPlantings(legacy, configuration())
    scene.vegetation.speciesCatalog[0]!.modelAsset.modelLodVariants = [
      {
        id: 'model-low',
        kind: 'glb',
        url: 'https://example.test/low.glb',
        minimumDistance: 120,
      },
    ]
    scene.vegetation.rules[0]!.enabled = true
    const projected = projectSceneForUnity(scene)
    expect(projected.settings.vegetation).toEqual(scene.vegetation)
    const saved = serializeSceneDefinitionToFourPackages(scene)
    const definition = JSON.parse(saved.threeDJson).vegetation
    expect(definition.streaming.renderMode).toBe('instanced')
    expect(definition.rules[0].targetCount).toBe(800)
    const dependencies = JSON.parse(saved.dependenciesJson)
    expect(dependencies.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          assetId: 'model-1',
          owners: expect.arrayContaining([
            expect.objectContaining({
              ownerType: 'vegetation-native-species',
              ownerKey: 'birch',
            }),
          ]),
        }),
      ]),
    )
    const response = {
      code: 200,
      data: { currentRevision: { threeDJson: saved.threeDJson } },
    } as Dim3dSceneDetailResponse
    const restored = assembleSceneDefinitionFromRuntimeFragments({
      manifest: {
        fragmentType: 'manifest',
        contentJson: JSON.stringify(saved),
      },
      options: {
        sceneId: scene.id,
        resolvedAssetUrls: {
          'model-1': 'https://resolved.test/tree.glb',
          'model-low': 'https://resolved.test/low.glb',
        },
      },
    })
    expect(restored.vegetation?.rules).toEqual(scene.vegetation.rules)
    expect(restored.vegetation?.streaming.renderMode).toBe('instanced')
    expect(restored.vegetation?.speciesCatalog[0]?.modelAsset.url).toBe(
      'https://resolved.test/tree.glb',
    )
    expect(
      restored.vegetation?.speciesCatalog[0]?.modelAsset.modelLodVariants?.[0]
        ?.url,
    ).toBe('https://resolved.test/low.glb')
    expect(readSavedVegetationPublicationIdentity(response)).toBeNull()
    const invalid = JSON.parse(saved.threeDJson)
    invalid.vegetation.rules[0].speciesMix[0].speciesId = 'unknown'
    expect(() =>
      readSavedVegetationPublicationIdentity({
        code: 200,
        data: { currentRevision: { threeDJson: JSON.stringify(invalid) } },
      } as Dim3dSceneDetailResponse),
    ).toThrow('原生植被配置无效')
  })

  it('retains validation for existing tiles publications', () => {
    const config = migrateLegacyPlantings(legacy, configuration())
    config.rules[0]!.enabled = true
    config.streaming.renderMode = 'published-tiles'
    const response = {
      code: 200,
      data: {
        currentRevision: { threeDJson: JSON.stringify({ vegetation: config }) },
      },
    } as Dim3dSceneDetailResponse
    expect(() => readSavedVegetationPublicationIdentity(response)).toThrow(
      '没有正式版本',
    )
    expect(() => createUpdateVegetationSystemCommand(config)).not.toThrow()
  })
})
