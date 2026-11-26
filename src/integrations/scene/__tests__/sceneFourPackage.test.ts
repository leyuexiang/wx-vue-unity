import { describe, expect, it } from 'vitest'
import {
  createSceneDefinition,
  createVegetationSystemDefinition,
  createDefaultThreeMapObject,
  type SceneDefinition,
} from '@/scene-platform'
import { BUILTIN_SCENE_RESOURCE_KEY } from '../editorBuiltinResourceRegistry'
import { reactive } from 'vue'
import {
  cloneScenePackageJsonValue,
  createSceneFourPackageDocuments,
  parseSceneFourPackagePayload,
  serializeSceneDefinitionToFourPackages,
} from '../sceneFourPackage'
import { assembleSceneDefinitionFromRuntimeFragments } from '../sceneRuntimeFragmentAssembler'
import { preserveUneditedThreeDDomain } from '../twoDPackagePreservation'

/**
 * 模拟真实二维组件导出的 Config 类实例。
 * 测试刻意保留图表内置函数，确保四包转换只在二维配置边界剔除运行时默认值，
 * 不会因此放宽场景 metadata 等其它领域的普通对象约束。
 */
class TestWidgetConfig {
  attr = { l: 10, t: 20, w: 300, h: 100, zIndex: 1 }
  info = { name: '图表', keyName: 'VBar', packageName: 'Chart', icon: '' }
  option = {
    title: '温度',
    chartOption: {
      yAxis: {
        type: 'value',
        color: () => '#000',
      },
    },
  }
  styles = { animations: [] }
  dataConfig = {
    version: 2,
    request: { type: 'ajax', config: { requestUrl: '/temperature' } },
    extractor: { resultPath: 'data.rows' },
    dataset: { dimensions: ['value'], source: [{ value: 20 }] },
    bindings: [{ kind: 'widget', sourceField: 'value', targetPath: 'value' }],
    requests: [
      {
        id: 'request-001',
        name: '温度请求',
        request: { type: 'ajax', config: { requestUrl: '/temperature' } },
        extractor: { resultPath: 'data.rows' },
        dataset: { dimensions: ['value'], source: [{ value: 20 }] },
        bindings: [{ kind: 'widget', sourceField: 'value', targetPath: 'value' }],
      },
    ],
  }
  statusList = [
    {
      id: 'status-001',
      statusName: '温度告警',
      isOpen: true,
      conditionGroupList: [],
    },
  ]
  interactiveEvent = [
    {
      id: 'event-001',
      eventName: '点击查看',
      eventType: 'click',
      isOpen: true,
      conditionGroupList: [],
    },
  ]
}

const createLocalScene = (): SceneDefinition =>
  createSceneDefinition({
    id: 'scene-local-001',
    name: '本地场景',
    type: 'local3d',
    coordinateSystem: { kind: 'local', unit: 'meter', upAxis: 'Y', gridEnabled: true },
    objects: [
      {
        id: 'object-model-001',
        name: '模型',
        type: 'model',
        visible: true,
        locked: false,
        order: 0,
        transform: {
          kind: 'local',
          position: [1, 2, 3],
          rotation: [0, 0.5, 0],
          scale: [1, 1, 1],
        },
        asset: { id: 'asset-model-001', kind: 'glb', url: '/models/model.glb' },
        style: { opacity: 0.8 },
      },
      {
        id: 'object-primitive-001',
        name: '几何体',
        type: 'primitive',
        visible: false,
        locked: true,
        layerId: 'layer-object-001',
        order: 1,
        transform: {
          kind: 'local',
          position: [0, 0, 0],
          rotation: [0, 0, 0],
          scale: 1,
        },
        metadata: { editorModelType: 'geometry' },
      },
    ],
    layers: [
      {
        id: 'layer-object-001',
        name: '对象图层',
        type: 'object',
        visible: true,
        locked: false,
        order: 0,
      },
    ],
    settings: {
      scene: { background: '#102030' },
      editor: {
        widgetSceneFragment: {
          widgets: [
            {
              id: 'widget-001',
              component: new TestWidgetConfig(),
            },
          ],
          widgetLayerTree: [{ id: 'widget-001', type: 'widget' }],
          widgetCanvas: { width: 1920, height: 1080 },
        },
      },
    },
    metadata: { businessKey: 'local-business-001' },
  })

describe('场景四包转换', () => {
  it('重开根级模型和几何体序号重复的旧修订，并保留对象与资源引用', () => {
    const scene = createLocalScene()
    const payload = serializeSceneDefinitionToFourPackages(scene)
    const threeD = JSON.parse(payload.threeDJson)
    // 模型和几何体分存两个数组，但没有图层或父节点时共用根级排序。
    const [primitive] = threeD.components
    delete primitive.layerKey
    primitive.sortNo = threeD.objects[0].sortNo
    threeD.components.push({ ...primitive, instanceId: 'other-layer', layerKey: 'layer-object-001', sortNo: 6 })
    threeD.components.push({ ...primitive, instanceId: 'later-root', sortNo: 1 })
    const parentInstanceId = threeD.objects[0].instanceId
    threeD.components.push({ ...primitive, instanceId: 'first-child', parentInstanceId })
    threeD.components.push({ ...primitive, instanceId: 'second-child', parentInstanceId })
    const original = { ...payload, threeDJson: JSON.stringify(threeD) }
    const restored = assembleSceneDefinitionFromRuntimeFragments({
      manifest: { fragmentType: 'manifest', fragmentKey: scene.id, contentJson: JSON.stringify(original) },
      options: { sceneId: scene.id, resolvedAssetUrls: { 'asset-model-001': '/models/model.glb' } },
    })

    expect(restored.objects.filter(object => !object.layerId && !object.parentInstanceId).map(({ id, order }) => [id, order])).toEqual([
      ['object-model-001', 0], ['object-primitive-001', 1], ['later-root', 2],
    ])
    expect(restored.objects.filter(object => object.parentInstanceId === parentInstanceId).map(object => object.order)).toEqual([0, 0])
    expect(restored.objects.find(({ id }) => id === 'other-layer')?.order).toBe(6)
    expect(restored.objects.find(({ id }) => id === 'object-model-001')).toMatchObject({
      asset: { id: 'asset-model-001' }, transform: { position: [1, 2, 3] },
    })

    // 没有额外编辑直接保存，也要写回已恢复的顺序，避免旧原档覆盖修复结果。
    const saved = preserveUneditedThreeDDomain(scene.id, serializeSceneDefinitionToFourPackages(restored),
      undefined, undefined, undefined, undefined, original)
    expect(JSON.parse(saved.threeDJson).components.map((target: { sortNo: number }) => target.sortNo)).toEqual([1, 6, 2, 0, 0])
    expect(preserveUneditedThreeDDomain(scene.id, serializeSceneDefinitionToFourPackages(restored),
      undefined, undefined, undefined, undefined, saved).threeDJson).toBe(saved.threeDJson)
  })

  it('恢复 GIS 灯具配置，并兼容旧四包遗漏 light 的存量场景', () => {
    const scene = createSceneDefinition({
      id: 'gis-light-roundtrip',
      name: '灯具场景',
      type: 'gis',
      coordinateSystem: {
        kind: 'wgs84', terrainEnabled: false, defaultLongitude: 104,
        defaultLatitude: 30, defaultHeight: 0,
      },
      objects: [
        {
          id: 'light-1', name: '聚光灯', type: 'light', visible: true, locked: false, order: 0,
          transform: { kind: 'geo', longitude: 104, latitude: 30, height: 4,
            heading: 0, pitch: 0, roll: 0, scale: 1, altitudeMode: 'absolute' },
          light: { kind: 'spot', color: '#ffcc88', intensity: 9, range: 18,
            innerConeAngle: 0.2, outerConeAngle: 0.5 },
          metadata: { editorModelSnapshot: { light: { kind: 'point', color: '#ffffff', intensity: 4, range: 8 } } },
        },
        {
          id: 'model-1', name: '模型', type: 'model', visible: true, locked: false, order: 1,
          transform: { kind: 'geo', longitude: 104, latitude: 30, height: 0,
            heading: 0, pitch: 0, roll: 0, scale: 1, altitudeMode: 'absolute' },
        },
      ],
    })
    const payload = serializeSceneDefinitionToFourPackages(scene)
    const threeD = JSON.parse(payload.threeDJson) as {
      components: Array<{ contentJson: { light?: unknown } }>
    }
    expect(threeD.components[0]?.contentJson.light).toEqual(scene.objects[0]?.light)

    const restore = (threeDJson: string) => assembleSceneDefinitionFromRuntimeFragments({
      manifest: {
        fragmentType: 'manifest', fragmentKey: scene.id,
        contentJson: JSON.stringify({ ...payload, threeDJson }),
      },
      options: { sceneId: scene.id },
    })
    expect(restore(payload.threeDJson).objects[0]?.light).toEqual(scene.objects[0]?.light)

    delete threeD.components[0]?.contentJson.light
    const restoredLegacy = restore(JSON.stringify(threeD))
    expect(restoredLegacy.objects.map((object) => object.id)).toEqual(['light-1', 'model-1'])
    expect(restoredLegacy.objects[0]?.light).toEqual({
      kind: 'point', color: '#ffffff', intensity: 4, range: 8,
    })
  })

  it.each(['local3d', 'gis'] as const)('保存并重开 %s 第一人称相机时保留启用状态和参数', (sceneType) => {
    for (const enabled of [true, false]) {
      const firstPerson = {
        enabled, height: 1.8, eyeHeight: 1.5, collisionRadius: 0.25,
        moveSpeed: 4, lookSensitivity: 0.0025, fov: 75,
        lockPitch: true, collisionEnabled: true,
      }
      const scene = createSceneDefinition({
        id: `first-person-${sceneType}-${enabled}`, name: '第一人称保存测试', type: sceneType,
        coordinateSystem: sceneType === 'gis'
          ? {
              kind: 'wgs84', terrainEnabled: false, defaultLongitude: 103.57,
              defaultLatitude: 30.62, defaultHeight: 551,
            }
          : { kind: 'local', unit: 'meter', upAxis: 'Y', gridEnabled: true },
        objects: [{
          id: 'first-person-camera', name: '第一人称', type: 'camera', visible: true,
          locked: false, order: 0, firstPerson,
          transform: sceneType === 'gis'
            ? { kind: 'geo', longitude: 103.57, latitude: 30.62, height: 551,
                heading: 0.5, pitch: 0, roll: 0, scale: 1, altitudeMode: 'absolute' }
            : { kind: 'local', position: [3, 0, 4], rotation: [0, 0.5, 0], scale: 1 },
        }],
      })
      const payload = serializeSceneDefinitionToFourPackages(scene)
      const threeD = JSON.parse(payload.threeDJson) as { components: Array<{ contentJson: { firstPerson?: unknown } }> }
      expect(threeD.components[0]?.contentJson.firstPerson).toEqual(firstPerson)
      const restored = assembleSceneDefinitionFromRuntimeFragments({
        manifest: { fragmentType: 'manifest', fragmentKey: scene.id, contentJson: JSON.stringify(payload) },
        options: { sceneId: scene.id },
      })
      expect(restored.objects[0]?.firstPerson).toEqual(firstPerson)
      expect(restored.objects[0]?.transform).toEqual(scene.objects[0]?.transform)
    }
  })
  it('植被专用编码保留业务和资源版本，同时移除运行时地址与认证信息', () => {
    const scene = createLocalScene()
    scene.vegetation = createVegetationSystemDefinition({
      seed: 17,
      ruleSetId: 'vegetation-rules-17',
      ruleSetVersion: 'rule-version-3',
      speciesCatalog: [
        {
          id: 'species-tree',
          name: '乔木',
          enabled: true,
          modelAsset: {
            id: 'model-resource-17',
            kind: 'glb',
            url: 'https://temporary.example/tree.glb?token=secret',
            version: 'model-version-2',
          },
          minimumScale: 1,
          maximumScale: 2,
        },
      ],
      publication: {
        version: 'vegetation-publication-9',
        ruleVersion: 'rule-version-3',
        manifestAsset: {
          id: 'manifest-resource-9',
          kind: 'json',
          url: 'https://temporary.example/manifest.json?token=secret',
          version: 'manifest-version-9',
        },
        generatedAt: '2026-09-14T00:00:00.000Z',
        sourceHash: 'sha256:vegetation-9',
      },
    })
    /** 历史依赖可能缺少 usageType；保存时也必须按植被拥有者和保留编号前缀清理。 */
    scene.settings = {
      ...scene.settings,
      dependencies: {
        resources: [
          {
            resourceKey: 'legacy-vegetation-manifest',
            assetId: 'legacy-vegetation-manifest',
            kind: 'json',
            owners: [
              { domain: 'threeD', ownerType: 'vegetation-system', ownerKey: 'vegetation-rules-17' },
            ],
          },
          {
            resourceKey: 'legacy-vegetation-layer-tiles',
            assetId: 'legacy-vegetation-layer-tiles',
            kind: '3d-tiles',
            owners: [{ domain: 'threeD', ownerType: 'vegetation-layer', ownerKey: 'layer-1' }],
          },
          {
            resourceKey: 'vegetation-tileset:scene:old-version',
            assetId: 'vegetation-tileset:scene:old-version',
            kind: '3d-tiles',
            owners: [],
          },
          {
            resourceKey: 'legacy-vegetation-species-model',
            assetId: 'legacy-vegetation-species-model',
            kind: 'glb',
            owners: [
              { domain: 'threeD', ownerType: 'vegetation-system', ownerKey: 'species-tree' },
            ],
          },
        ],
      },
    }

    const documents = createSceneFourPackageDocuments(scene)
    const vegetation = documents.threeD.vegetation as Record<string, unknown>
    const species = (vegetation.speciesCatalog as Array<Record<string, unknown>>)[0]!
    const modelAsset = species.modelAsset as Record<string, unknown>
    const publication = vegetation.publication as Record<string, unknown>
    const manifestAsset = publication.manifestAsset as Record<string, unknown>

    expect(vegetation.ruleSetVersion).toBe('rule-version-3')
    expect(modelAsset).toMatchObject({ id: 'model-resource-17', version: 'model-version-2' })
    expect(publication).toMatchObject({
      version: 'vegetation-publication-9',
      ruleVersion: 'rule-version-3',
      sourceHash: 'sha256:vegetation-9',
    })
    expect(manifestAsset).toMatchObject({
      id: 'manifest-resource-9',
      version: 'manifest-version-9',
    })
    expect(JSON.stringify(vegetation)).not.toContain('temporary.example')
    expect(JSON.stringify(vegetation)).not.toContain('secret')

    /**
     * 植被模型、发布清单和瓦片都由后端预览资源接口按发布版本返回，保存时不得进入 resources 包；
     * 普通场景模型依赖仍需保留，避免过滤规则误伤非植被资源。
     */
    expect(documents.dependencies.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resourceKey: 'asset-model-001',
          assetId: 'asset-model-001',
          kind: 'glb',
          owners: [
            expect.objectContaining({
              domain: 'threeD',
              ownerType: 'instance',
              instanceId: 'object-model-001',
            }),
          ],
        }),
      ]),
    )
    expect(documents.dependencies.resources).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ usageType: 'vegetation-manifest' }),
        expect.objectContaining({ usageType: 'vegetation-tileset' }),
        expect.objectContaining({ usageType: 'vegetation-species-model' }),
      ]),
    )
    expect(documents.dependencies.resources.map((resource) => resource.resourceKey)).not.toEqual(
      expect.arrayContaining([
        'legacy-vegetation-manifest',
        'legacy-vegetation-layer-tiles',
        'vegetation-tileset:scene:old-version',
        'legacy-vegetation-species-model',
        'model-resource-17',
      ]),
    )

    const payload = serializeSceneDefinitionToFourPackages(scene)
    /** saveAll 实际提交的是字符串四包，这里再次检查序列化结果没有混入任何植被资源。 */
    const savedDependencies = JSON.parse(payload.dependenciesJson) as {
      resources: Array<Record<string, unknown>>
    }
    expect(savedDependencies.resources.map((resource) => resource.resourceKey)).not.toEqual(
      expect.arrayContaining([
        'legacy-vegetation-manifest',
        'legacy-vegetation-layer-tiles',
        'vegetation-tileset:scene:old-version',
        'legacy-vegetation-species-model',
        'model-resource-17',
      ]),
    )
    const restored = assembleSceneDefinitionFromRuntimeFragments({
      manifest: {
        fragmentType: 'manifest',
        fragmentKey: scene.id,
        contentJson: JSON.stringify(payload),
      },
      options: {
        sceneId: scene.id,
        resolvedAssetUrls: {
          'model-resource-17': '/runtime/tree.glb',
          'manifest-resource-9': '/runtime/manifest.json',
        },
      },
    })
    expect(restored.vegetation?.ruleSetVersion).toBe('rule-version-3')
    expect(restored.vegetation?.speciesCatalog[0]?.modelAsset).toMatchObject({
      id: 'model-resource-17',
      url: '/runtime/tree.glb',
      version: 'model-version-2',
    })
    expect(restored.vegetation?.publication).toMatchObject({
      version: 'vegetation-publication-9',
      ruleVersion: 'rule-version-3',
      manifestAsset: {
        id: 'manifest-resource-9',
        url: '/runtime/manifest.json',
        version: 'manifest-version-9',
      },
    })
  })
  it('将二维仓库中的 Vue 响应式代理解包为纯 JSON', () => {
    const source = reactive({ layout: { left: 10, top: 20 }, series: [{ value: 1 }] })

    expect(cloneScenePackageJsonValue(source)).toEqual({
      layout: { left: 10, top: 20 },
      series: [{ value: 1 }],
    })
  })

  it.each(['gis', 'local3d'] as const)('保存并恢复 %s 场景中的中国 3D 地图组件', (sceneType) => {
    const map = createDefaultThreeMapObject(
      `three-map-${sceneType}-001`,
      sceneType === 'gis'
        ? {
            kind: 'geo',
            longitude: 116.397,
            latitude: 39.908,
            height: 12,
            heading: 0.2,
            pitch: 0.1,
            roll: 0,
            scale: 1,
            altitudeMode: 'absolute',
          }
        : {
            kind: 'local',
            position: [4, 5, 6],
            rotation: [0.1, 0.2, 0.3],
            scale: [1, 1, 1],
          },
    )
    map.effect.params.floor.height = 2.5

    const scene = createSceneDefinition({
      id: `scene-${sceneType}-three-map-001`,
      name: `${sceneType} 中国 3D 地图场景`,
      type: sceneType,
      coordinateSystem:
        sceneType === 'gis'
          ? { kind: 'wgs84', datum: 'WGS84', unit: 'degree' }
          : { kind: 'local', unit: 'meter', upAxis: 'Y', gridEnabled: true },
      objects: [map],
    })

    const payload = serializeSceneDefinitionToFourPackages(scene)
    const savedThreeD = JSON.parse(payload.threeDJson) as {
      components: Array<{
        contentJson: { effect?: { type?: string; params?: { floor?: { height?: number } } } }
      }>
    }
    expect(savedThreeD.components[0]?.contentJson.effect).toMatchObject({
      type: 'three-map',
      params: { floor: { height: 2.5 } },
    })

    const restored = assembleSceneDefinitionFromRuntimeFragments({
      manifest: {
        fragmentType: 'manifest',
        fragmentKey: scene.id,
        contentJson: JSON.stringify(payload),
      },
      options: { sceneId: scene.id, sceneType },
    })

    expect(restored.objects[0]?.effect).toMatchObject({
      type: 'three-map',
      params: { floor: { height: 2.5 } },
    })
    expect(restored.objects[0]?.transform.kind).toBe(sceneType === 'gis' ? 'geo' : 'local')
  })

  it('按设计拆分本地场景，并保留二维、资源和纯领域字段', () => {
    const scene = createLocalScene()
    const widgetFragment = scene.settings.editor?.widgetSceneFragment as {
      widgets: Array<{ parentId?: string }>
    }
    widgetFragment.widgets[0]!.parentId = 'widget-parent-001'
    const documents = createSceneFourPackageDocuments(scene)

    expect(documents.scene).toMatchObject({
      sceneType: 'local3d',
      domainSlots: { twoD: 'present', threeD: 'present' },
    })
    expect(documents.scene).not.toHaveProperty('id')
    expect(documents.scene.metadata).toEqual({ businessKey: 'local-business-001' })
    expect(documents.threeD.objects.map((item) => item.instanceId)).toEqual(['object-model-001'])
    expect(documents.threeD.components.map((item) => item.instanceId)).toEqual([
      'object-primitive-001',
    ])
    expect(documents.threeD.objects[0].resourceRefKeys).toEqual(['asset-model-001'])
    expect(documents.threeD.objects[0].contentJson).toMatchObject({ style: { opacity: 0.8 } })
    expect(documents.twoD.components[0].instanceId).toBe('widget-001')
    expect(documents.twoD.components[0].parentInstanceId).toBe('widget-parent-001')
    expect(documents.twoD.components[0].componentType).toBe('VBar')
    expect(documents.twoD.canvas).toEqual({ width: 1920, height: 1080 })
    expect(documents.twoD.components[0].renderConfig).toEqual({
      title: '温度',
      chartOption: { yAxis: { type: 'value' } },
    })
    expect(documents.twoD.components[0].contentJson).toMatchObject({
      widget: { parentId: 'widget-parent-001' },
    })
    expect(documents.twoD.components[0].contentJson).not.toHaveProperty(
      'widget.component.dataConfig',
    )
    expect(documents.twoD.components[0].contentJson).not.toHaveProperty(
      'widget.component.statusList',
    )
    expect(documents.twoD.components[0].contentJson).not.toHaveProperty(
      'widget.component.interactiveEvent',
    )
    const restored = assembleSceneDefinitionFromRuntimeFragments({
      manifest: {
        fragmentType: 'manifest',
        fragmentKey: scene.id,
        contentJson: JSON.stringify(serializeSceneDefinitionToFourPackages(scene)),
      },
      options: { sceneId: scene.id },
    })
    expect(
      (
        restored.settings.editor?.widgetSceneFragment as {
          widgets: Array<{ parentId?: string }>
        }
      ).widgets[0]?.parentId,
    ).toBe('widget-parent-001')
    expect(documents.dependencies.resources[0]).toMatchObject({
      resourceKey: 'asset-model-001',
      assetId: 'asset-model-001',
      kind: 'glb',
    })
    expect(documents.dependencies.resources[0]).not.toHaveProperty('url')
    expect(documents.dependencies.dataBindings).toHaveLength(1)
    expect(documents.dependencies.dataBindings[0]).toMatchObject({
      bindingKey: 'request-001',
      owner: { domain: 'twoD', ownerType: 'instance', instanceId: 'widget-001' },
      source: { type: 'ajax', requestConfig: { requestUrl: '/temperature' } },
      enabled: true,
    })
    expect(documents.dependencies.behaviors).toEqual([
      expect.objectContaining({
        behaviorKey: 'status-001',
        behaviorType: 'status',
        owner: { domain: 'twoD', ownerType: 'instance', instanceId: 'widget-001' },
      }),
      expect.objectContaining({
        behaviorKey: 'event-001',
        behaviorType: 'interaction',
        eventType: 'click',
        owner: { domain: 'twoD', ownerType: 'instance', instanceId: 'widget-001' },
      }),
    ])
  })

  it('只在 sceneJson 保存场景级请求与动作，并以规范字段覆盖历史依赖镜像', () => {
    const scene = createLocalScene()
    scene.settings = {
      ...scene.settings,
      requestGlobalConfig: {
        requestOriginUrl: '/new-api',
        requestInterval: 30,
        requestIntervalUnit: 'second',
        requestParams: { Header: { tenant: 'new' } },
      },
      publicRequests: [
        {
          publicRequestKey: 'public-new',
          name: '新公共接口',
          requestConfig: { requestHttpType: 'GET', requestUrl: '/new' },
        },
      ],
      sceneActions: [{ actionKey: 'action-new', triggerType: 'scene-ready' }],
      dependencies: {
        requestGlobalConfig: { requestOriginUrl: '/old-api' },
        publicRequests: [{ publicRequestKey: 'public-old' }],
        sceneActions: [{ actionKey: 'action-old' }],
        resources: [],
        dataBindings: [],
        behaviors: [],
        deviceBindings: [],
      },
    }

    const documents = createSceneFourPackageDocuments(scene)

    expect(documents.scene.requestGlobalConfig).toMatchObject({ requestOriginUrl: '/new-api' })
    expect(documents.scene.publicRequests).toEqual([
      expect.objectContaining({ publicRequestKey: 'public-new', name: '新公共接口' }),
    ])
    expect(documents.scene.sceneActions).toEqual([
      expect.objectContaining({ actionKey: 'action-new' }),
    ])
    expect(documents.dependencies).not.toHaveProperty('requestGlobalConfig')
    expect(documents.dependencies).not.toHaveProperty('publicRequests')
    expect(documents.dependencies).not.toHaveProperty('sceneActions')
  })

  it('为 GIS 场景保留 WGS84 坐标系和 GIS 图层，不把引擎状态写入包', () => {
    const scene = createSceneDefinition({
      id: 'scene-gis-001',
      name: 'GIS 场景',
      type: 'gis',
      coordinateSystem: {
        kind: 'wgs84',
        terrainEnabled: true,
        defaultLongitude: 104,
        defaultLatitude: 30,
        defaultHeight: 10,
      },
      objects: [
        {
          id: 'gis-model-001',
          name: 'GIS 模型',
          type: 'model',
          visible: true,
          locked: false,
          order: 0,
          transform: {
            kind: 'geo',
            longitude: 104,
            latitude: 30,
            height: 10,
            heading: 0,
            pitch: 0,
            roll: 0,
            scale: 1,
            altitudeMode: 'absolute',
          },
        },
      ],
      layers: [
        {
          id: 'imagery-001',
          name: '影像',
          type: 'imagery',
          visible: true,
          locked: false,
          order: 0,
          provider: 'xyz',
          url: 'https://example.test/{z}/{x}/{y}.png',
        },
      ],
      settings: {},
      metadata: {},
    })
    const documents = createSceneFourPackageDocuments(scene)

    expect(documents.threeD.baseConfig.coordinateSystem).toEqual(scene.coordinateSystem)
    expect(documents.threeD.baseConfig.gisLayers).toHaveLength(1)
    expect(documents.threeD.baseConfig.gisLayers[0]).toMatchObject({
      layerKey: 'imagery-001',
      provider: 'xyz',
      /** URL 直连图层没有资源编号，四包必须保留其可重建数据源的稳定地址。 */
      url: 'https://example.test/{z}/{x}/{y}.png',
    })
    expect(documents.threeD.objects[0].transform).toMatchObject({
      kind: 'geo',
      longitude: 104,
      latitude: 30,
    })
  })

  it('saveAll 字段始终是合法 JSON 字符串，并拒绝引擎对象实例', () => {
    const scene = createLocalScene()
    const payload = serializeSceneDefinitionToFourPackages(scene)

    expect(Object.keys(payload)).toEqual([
      'sceneJson',
      'threeDJson',
      'twoDJson',
      'dependenciesJson',
    ])
    expect(JSON.parse(payload.sceneJson)).not.toHaveProperty('id')
    expect(JSON.parse(payload.threeDJson).streaming).toEqual({
      groups: [],
      chunks: [],
      chunkTargets: [],
    })
    expect(() => parseSceneFourPackagePayload(payload)).not.toThrow()
    expect(payload.twoDJson).not.toContain('=>')

    class FakeEngineObject {
      value = 1
    }
    const sceneWithEngineObject = { ...scene, metadata: { engine: new FakeEngineObject() } }
    expect(() => createSceneFourPackageDocuments(sceneWithEngineObject)).toThrow(
      '必须是普通 JSON 对象',
    )
  })

  it('将三维和二维实例依赖投影到 dependencies，并净化运行时资源信息', () => {
    const scene = createLocalScene()
    const model = scene.objects[0]
    model.metadata = {
      editorModelSnapshot: {
        modelType: 'model',
        filePath: 'https://expired.example/model.glb?token=secret',
        resourceAsset: {
          url: 'https://expired.example/model.glb?signature=secret',
          version: 'temporary-version',
        },
        geometry: { width: 10 },
      },
      dataConfig: {
        request: { type: 'static', config: { data: [{ value: 1 }] } },
        dataset: { dimensions: ['value'], source: [{ value: 1 }] },
        bindings: [],
      },
      statusList: [{ id: 'object-status', statusName: '状态', conditionGroupList: [] }],
      interactiveEvent: [{ id: 'object-event', eventName: '事件', conditionGroupList: [] }],
      deviceId: 'device-001',
      // 这两个字段模拟编辑器运行时写入的引擎身份，不能成为场景业务身份。
      engineObjectUuid: 'three-engine-uuid-001',
      legacyOnlyUuid: 'legacy-only-uuid-001',
    }
    const documents = createSceneFourPackageDocuments(scene)
    const targetMetadata = documents.threeD.objects[0].contentJson.metadata as Record<
      string,
      unknown
    >
    const snapshot = targetMetadata.editorModelSnapshot as Record<string, unknown>

    expect(targetMetadata).not.toHaveProperty('dataConfig')
    expect(targetMetadata).not.toHaveProperty('statusList')
    expect(targetMetadata).not.toHaveProperty('interactiveEvent')
    expect(targetMetadata).not.toHaveProperty('deviceId')
    expect(targetMetadata).not.toHaveProperty('engineObjectUuid')
    expect(targetMetadata).not.toHaveProperty('legacyOnlyUuid')
    // 保存采用 metadata 的纯投影，不能为了净化数据而破坏编辑器当前运行时对象。
    expect(model.metadata).toMatchObject({
      engineObjectUuid: 'three-engine-uuid-001',
      legacyOnlyUuid: 'legacy-only-uuid-001',
    })
    expect(snapshot).toEqual({ modelType: 'model', geometry: { width: 10 } })
    expect(JSON.stringify(documents)).not.toMatch(/expired\.example|temporary-version|secret/)
    expect(documents.dependencies.dataBindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          owner: expect.objectContaining({ domain: 'threeD', instanceId: 'object-model-001' }),
        }),
        expect.objectContaining({
          owner: expect.objectContaining({ domain: 'twoD', instanceId: 'widget-001' }),
        }),
      ]),
    )
    expect(documents.dependencies.behaviors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          owner: expect.objectContaining({
            domain: 'threeD',
            instanceId: 'object-model-001',
          }),
        }),
      ]),
    )
    expect(documents.dependencies.deviceBindings).toEqual([
      expect.objectContaining({
        deviceId: 'device-001',
        owner: expect.objectContaining({ domain: 'threeD' }),
      }),
    ])
  })

  it('历史依赖镜像只在缺少正式依赖时读取，并按域隔离同名记录', () => {
    const scene = createLocalScene()
    scene.settings = {
      ...scene.settings,
      sceneRuntimeDependencies: {
        resources: [
          {
            resourceKey: 'asset-model-001',
            assetId: 'asset-model-001',
            kind: 'glb',
            url: 'https://expired.example/legacy.glb',
            owners: [{ domain: 'threeD', ownerType: 'instance', instanceId: 'object-model-001' }],
          },
        ],
        dataBindings: [
          {
            bindingKey: 'same-key',
            owner: { domain: 'twoD', ownerType: 'instance', instanceId: 'same' },
          },
          {
            bindingKey: 'same-key',
            owner: { domain: 'threeD', ownerType: 'instance', instanceId: 'same' },
          },
        ],
      },
    }
    const documents = createSceneFourPackageDocuments(scene)

    expect(documents.dependencies.resources).toHaveLength(1)
    expect(documents.dependencies.resources[0]).not.toHaveProperty('url')
    expect(documents.dependencies.dataBindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          bindingKey: 'same-key',
          owner: expect.objectContaining({ domain: 'twoD' }),
        }),
        expect.objectContaining({
          bindingKey: 'same-key',
          owner: expect.objectContaining({ domain: 'threeD' }),
        }),
      ]),
    )
    expect(JSON.stringify(documents.threeD)).not.toContain('sceneRuntimeDependencies')
  })

  it('正式依赖包中的实例绑定不与当前实例投影重复保存', () => {
    const scene = createLocalScene()
    scene.settings = {
      ...scene.settings,
      dependencies: {
        resources: [],
        // 模拟场景加载后仍保留在 settings.dependencies 中的旧实例镜像。
        dataBindings: [
          {
            bindingKey: 'widget-001:request:1',
            owner: { domain: 'twoD', ownerType: 'instance', instanceId: 'widget-001' },
            source: { type: 'ajax', requestConfig: { requestUrl: '/temperature' } },
          },
        ],
        behaviors: [],
        deviceBindings: [],
      },
    }

    const documents = createSceneFourPackageDocuments(scene)

    // 当前组件中的 request-001 是保存时的权威记录，旧镜像不能形成第二条绑定。
    expect(documents.dependencies.dataBindings).toHaveLength(1)
    expect(documents.dependencies.dataBindings[0]).toMatchObject({
      bindingKey: 'request-001',
      owner: { domain: 'twoD', instanceId: 'widget-001' },
    })
  })

  it('内置城市模型不进入资源依赖，重新组装后由注册表恢复运行时地址', () => {
    const scene = createSceneDefinition({
      id: 'builtin-city-scene',
      name: '内置城市',
      type: 'local3d',
      coordinateSystem: { kind: 'local', unit: 'meter', upAxis: 'Y', gridEnabled: true },
      objects: [
        {
          id: 'builtin-city-instance',
          name: '城市',
          type: 'model',
          visible: true,
          locked: false,
          order: 0,
          transform: {
            kind: 'local',
            position: [0, 0, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
          },
          asset: { id: 'builtin:city-model', kind: 'glb', url: '/model/city.glb' },
          metadata: {
            editorModelSnapshot: {
              modelType: 'model',
              builtinResourceKey: BUILTIN_SCENE_RESOURCE_KEY.CITY_MODEL,
              filePath: 'model/city.glb',
              fileType: 'glb',
            },
          },
        },
      ],
    })
    const payload = serializeSceneDefinitionToFourPackages(scene)
    const savedThreeD = JSON.parse(payload.threeDJson) as Record<string, unknown>
    const savedDependencies = JSON.parse(payload.dependenciesJson) as Record<string, unknown>
    const restored = assembleSceneDefinitionFromRuntimeFragments({
      manifest: {
        fragmentType: 'manifest',
        fragmentKey: 'builtin-city-scene',
        contentJson: JSON.stringify(payload),
      },
      options: { sceneId: scene.id },
    })

    expect(JSON.stringify(savedThreeD)).not.toContain('model/city.glb')
    expect(savedDependencies.resources).toEqual([])
    expect(restored.objects[0]?.asset).toEqual({
      id: 'builtin:city-model',
      kind: 'glb',
      url: 'model/city.glb',
    })
  })

  it('三维看板图片只保存 OSS 编号，并在加载后按槽位补回运行时地址', () => {
    const scene = createSceneDefinition({
      id: 'billboard-resource-scene',
      name: '看板图片资源',
      type: 'local3d',
      coordinateSystem: { kind: 'local', unit: 'meter', upAxis: 'Y', gridEnabled: true },
      objects: [
        {
          id: 'billboard-instance',
          name: '三维看板',
          type: 'image',
          visible: true,
          locked: false,
          order: 0,
          transform: {
            kind: 'local',
            position: [0, 0, 0],
            rotation: [0, 0, 0],
            scale: 1,
          },
          asset: {
            id: 'builtin:billboard-logo',
            kind: 'image',
            url: '/assets/builtin-logo.png',
          },
          metadata: {
            editorModelSnapshot: {
              modelType: 'image',
              componentKind: 'billboard',
              builtinResourceKey: BUILTIN_SCENE_RESOURCE_KEY.BILLBOARD_LOGO,
              defaultImagePath: '/assets/builtin-logo.png',
            },
          },
          billboard: {
            schemaVersion: 1,
            content: {
              blocks: [
                {
                  type: 'image',
                  visible: true,
                  align: 'center',
                  imageSrc: 'https://temporary.example/content.png?token=secret',
                  imageResourceKey: 'oss-content-001',
                },
              ],
            },
            appearance: {
              width: 320,
              height: 180,
              nearDistance: 0,
              farDistance: 1000,
              nearScale: 1,
              farScale: 0.2,
              maximumDisplayDistance: 1000,
              padding: [0, 0, 0, 0],
              backgroundColor: 'transparent',
              backgroundImage: 'https://temporary.example/background.png?signature=secret',
              backgroundImageResourceKey: 'oss-background-001',
              borderColor: '#FFFFFF',
              borderWidth: 0,
              opacity: 1,
            },
          },
        },
      ],
    })

    const firstPayload = serializeSceneDefinitionToFourPackages(scene)
    const savedThreeD = JSON.parse(firstPayload.threeDJson) as {
      components: Array<{
        resourceRefKeys: string[]
        contentJson: {
          billboard: {
            content: { blocks: Array<Record<string, unknown>> }
            appearance: Record<string, unknown>
          }
        }
      }>
    }
    const savedDependencies = JSON.parse(firstPayload.dependenciesJson) as {
      resources: Array<Record<string, unknown>>
    }

    expect(savedThreeD.components[0].resourceRefKeys).toEqual([
      'oss-content-001',
      'oss-background-001',
    ])
    expect(savedThreeD.components[0].contentJson.billboard.content.blocks[0]).toMatchObject({
      imageResourceKey: 'oss-content-001',
      imageSrc: '',
    })
    expect(savedThreeD.components[0].contentJson.billboard.appearance).toMatchObject({
      backgroundImageResourceKey: 'oss-background-001',
      backgroundImage: null,
    })
    expect(savedDependencies.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resourceKey: 'oss-content-001',
          assetId: 'oss-content-001',
          kind: 'image',
        }),
        expect.objectContaining({
          resourceKey: 'oss-background-001',
          assetId: 'oss-background-001',
          kind: 'image',
        }),
      ]),
    )
    expect(JSON.stringify({ savedThreeD, savedDependencies })).not.toContain('temporary.example')

    const restored = assembleSceneDefinitionFromRuntimeFragments({
      manifest: {
        fragmentType: 'manifest',
        fragmentKey: 'billboard-resource-scene',
        contentJson: JSON.stringify(firstPayload),
      },
      options: {
        sceneId: scene.id,
        resolvedAssetUrls: {
          'oss-content-001': '/runtime/content.png',
          'oss-background-001': '/runtime/background.png',
        },
      },
    })
    const restoredObject = restored.objects[0]

    /** 内容图片不能覆盖看板对象自己的内置创建资产。 */
    expect(restoredObject.asset?.id).toBe('builtin:billboard-logo')
    expect(restoredObject.billboard?.content.blocks[0]).toMatchObject({
      imageResourceKey: 'oss-content-001',
      imageSrc: '/runtime/content.png',
    })
    expect(restoredObject.billboard?.appearance).toMatchObject({
      backgroundImageResourceKey: 'oss-background-001',
      backgroundImage: '/runtime/background.png',
    })

    /** 保存、加载、再次保存后仍只保留稳定编号，证明运行时补全不会污染四包。 */
    const secondPayload = serializeSceneDefinitionToFourPackages(restored)
    expect(JSON.parse(secondPayload.dependenciesJson)).toEqual(savedDependencies)
    expect(secondPayload.threeDJson).not.toContain('/runtime/content.png')
    expect(secondPayload.threeDJson).not.toContain('/runtime/background.png')
  })

  it('二维图片按来源分别保存外部地址或资源编号，页面菜单保持原有外部地址策略', () => {
    const scene = createSceneDefinition({
      id: 'widget-image-resource-scene',
      name: '二维图片资源',
      type: 'local3d',
      coordinateSystem: { kind: 'local', unit: 'meter', upAxis: 'Y', gridEnabled: true },
      settings: {
        editor: {
          widgetSceneFragment: {
            widgets: [
              {
                id: 'widget-image-001',
                component: {
                  attr: { l: 0, t: 0, w: 240, h: 160, zIndex: 0 },
                  info: { name: '图片', keyName: 'VImage', packageName: 'Widget', icon: '' },
                  option: {
                    sourceType: 'external',
                    value: 'https://temporary.example/widget.png?token=secret',
                    /** 外部模式中的历史残留编号必须被保存边界清理。 */
                    resourceKey: 'oss-widget-image-001',
                    fit: 'contain',
                    borderRadius: 0,
                    label: '图片',
                  },
                  styles: { animations: [] },
                },
              },
              {
                id: 'widget-page-menu-001',
                component: {
                  attr: { l: 0, t: 180, w: 800, h: 88, zIndex: 1 },
                  info: {
                    name: '页面菜单',
                    keyName: 'VPageMenu',
                    packageName: 'Widget',
                    icon: '',
                  },
                  option: {
                    barBackgroundImage: 'https://temporary.example/widget.png?token=shared-secret',
                    barBackgroundImageResourceKey: 'oss-widget-image-001',
                    buttonBackgroundImage:
                      'https://temporary.example/button.png?token=button-secret',
                    buttonBackgroundImageResourceKey: 'oss-menu-button-001',
                  },
                  styles: { animations: [] },
                },
              },
              {
                id: 'widget-image-market-001',
                component: {
                  attr: { l: 260, t: 0, w: 240, h: 160, zIndex: 2 },
                  info: { name: '市场图片', keyName: 'VImage', packageName: 'Widget', icon: '' },
                  option: {
                    sourceType: 'resource-market',
                    value: 'https://temporary.example/market.png?token=must-not-save',
                    resourceKey: 'oss-widget-market-001',
                    fit: 'cover',
                    borderRadius: 4,
                    label: '市场图片',
                  },
                  styles: { animations: [] },
                },
              },
            ],
            widgetLayerTree: [
              { id: 'widget-image-001', type: 'widget' },
              { id: 'widget-page-menu-001', type: 'widget' },
              { id: 'widget-image-market-001', type: 'widget' },
            ],
          },
        },
      },
    })

    const firstPayload = serializeSceneDefinitionToFourPackages(scene)
    const savedTwoD = JSON.parse(firstPayload.twoDJson) as {
      components: Array<{
        resourceRefKeys: string[]
        renderConfig: Record<string, unknown>
        contentJson: Record<string, unknown>
      }>
    }
    const savedDependencies = JSON.parse(firstPayload.dependenciesJson) as {
      resources: Array<Record<string, unknown>>
    }

    expect(savedTwoD.components[0].resourceRefKeys).toEqual([])
    expect(savedTwoD.components[0].renderConfig).toMatchObject({
      sourceType: 'external',
      value: 'https://temporary.example/widget.png?token=secret',
      fit: 'contain',
    })
    expect(savedTwoD.components[0].renderConfig).not.toHaveProperty('resourceKey')
    expect(savedTwoD.components[1].resourceRefKeys).toEqual([])
    expect(savedTwoD.components[1].renderConfig).toMatchObject({
      barBackgroundImage: 'https://temporary.example/widget.png?token=shared-secret',
      buttonBackgroundImage: 'https://temporary.example/button.png?token=button-secret',
    })
    expect(savedTwoD.components[1].renderConfig).not.toHaveProperty('barBackgroundImageResourceKey')
    expect(savedTwoD.components[1].renderConfig).not.toHaveProperty(
      'buttonBackgroundImageResourceKey',
    )
    expect(savedTwoD.components[2].resourceRefKeys).toEqual(['oss-widget-market-001'])
    expect(savedTwoD.components[2].renderConfig).toMatchObject({
      sourceType: 'resource-market',
      resourceKey: 'oss-widget-market-001',
      value: '',
      fit: 'cover',
    })
    expect(savedDependencies.resources).toEqual([
      expect.objectContaining({
        resourceKey: 'oss-widget-market-001',
        assetId: 'oss-widget-market-001',
        kind: 'image',
        owners: [{ domain: 'twoD', ownerType: 'instance', instanceId: 'widget-image-market-001' }],
      }),
    ])
    expect(firstPayload.twoDJson).not.toContain('token=must-not-save')

    const restored = assembleSceneDefinitionFromRuntimeFragments({
      manifest: {
        fragmentType: 'manifest',
        fragmentKey: 'widget-image-resource-scene',
        contentJson: JSON.stringify(firstPayload),
      },
      options: {
        sceneId: scene.id,
        resolvedAssetUrls: {
          'oss-widget-image-001': '/runtime/widget.png',
          'oss-menu-button-001': '/runtime/button.png',
          'oss-widget-market-001': '/runtime/market.png',
        },
      },
    })
    const restoredWidget = (
      restored.settings.editor as {
        widgetSceneFragment: {
          widgets: Array<{ component: { option: Record<string, unknown> } }>
        }
      }
    ).widgetSceneFragment.widgets[0]
    expect(restoredWidget.component.option).toMatchObject({
      value: 'https://temporary.example/widget.png?token=secret',
    })
    const restoredPageMenu = (
      restored.settings.editor as {
        widgetSceneFragment: {
          widgets: Array<{ component: { option: Record<string, unknown> } }>
        }
      }
    ).widgetSceneFragment.widgets[1]
    expect(restoredPageMenu.component.option).toMatchObject({
      barBackgroundImage: 'https://temporary.example/widget.png?token=shared-secret',
      buttonBackgroundImage: 'https://temporary.example/button.png?token=button-secret',
    })
    const restoredMarketImage = (
      restored.settings.editor as {
        widgetSceneFragment: {
          widgets: Array<{ component: { option: Record<string, unknown> } }>
        }
      }
    ).widgetSceneFragment.widgets[2]
    expect(restoredMarketImage.component.option).toMatchObject({
      sourceType: 'resource-market',
      resourceKey: 'oss-widget-market-001',
      value: '/runtime/market.png',
    })

    const secondPayload = serializeSceneDefinitionToFourPackages(restored)
    expect(JSON.parse(secondPayload.dependenciesJson)).toEqual(savedDependencies)
    expect(secondPayload.twoDJson).toContain('https://temporary.example/widget.png?token=secret')
    expect(secondPayload.twoDJson).toContain(
      'https://temporary.example/button.png?token=button-secret',
    )
    expect(secondPayload.twoDJson).not.toContain('/runtime/market.png')
  })

  it('页面框架资源市场背景保存稳定编号并在加载时恢复最新地址', () => {
    const scene = createSceneDefinition({
      id: 'page-frame-market-resource-scene',
      name: '页面框架资源市场图片',
      type: 'local3d',
      coordinateSystem: { kind: 'local', unit: 'meter', upAxis: 'Y', gridEnabled: true },
      settings: {
        editor: {
          widgetSceneFragment: {
            widgets: [
              {
                id: 'widget-page-frame-market-001',
                component: {
                  attr: { l: 0, t: 0, w: 1920, h: 1080, zIndex: -1 },
                  info: {
                    name: '页面框架',
                    keyName: 'VPageMenu',
                    packageName: 'Widget',
                    icon: '',
                  },
                  option: {
                    schemaVersion: 2,
                    layout: 'tcm-bottom',
                    background: {
                      sourceType: 'resource-market',
                      value: 'https://temporary.example/tcm-frame.png?token=secret',
                      resourceKey: 'oss-tcm-frame-001',
                      opacity: 1,
                    },
                  },
                  styles: { animations: [] },
                },
              },
            ],
            widgetLayerTree: [{ id: 'widget-page-frame-market-001', type: 'widget' }],
          },
        },
      },
    })

    const firstPayload = serializeSceneDefinitionToFourPackages(scene)
    const savedTwoD = JSON.parse(firstPayload.twoDJson) as {
      components: Array<{
        resourceRefKeys: string[]
        renderConfig: { background?: Record<string, unknown> }
      }>
    }
    const savedDependencies = JSON.parse(firstPayload.dependenciesJson) as {
      resources: Array<Record<string, unknown>>
    }

    expect(savedTwoD.components[0].resourceRefKeys).toEqual(['oss-tcm-frame-001'])
    expect(savedTwoD.components[0].renderConfig.background).toMatchObject({
      sourceType: 'resource-market',
      resourceKey: 'oss-tcm-frame-001',
      value: '',
    })
    expect(savedDependencies.resources).toEqual([
      expect.objectContaining({
        resourceKey: 'oss-tcm-frame-001',
        assetId: 'oss-tcm-frame-001',
        kind: 'image',
        owners: [
          {
            domain: 'twoD',
            ownerType: 'instance',
            instanceId: 'widget-page-frame-market-001',
          },
        ],
      }),
    ])
    expect(firstPayload.twoDJson).not.toContain('token=secret')

    const restored = assembleSceneDefinitionFromRuntimeFragments({
      manifest: {
        fragmentType: 'manifest',
        fragmentKey: 'page-frame-market-resource-scene',
        contentJson: JSON.stringify(firstPayload),
      },
      options: {
        sceneId: scene.id,
        resolvedAssetUrls: { 'oss-tcm-frame-001': '/runtime/tcm-frame.png' },
      },
    })
    const restoredWidget = (
      restored.settings.editor as {
        widgetSceneFragment: {
          widgets: Array<{ component: { option: { background: Record<string, unknown> } } }>
        }
      }
    ).widgetSceneFragment.widgets[0]
    expect(restoredWidget.component.option.background).toMatchObject({
      sourceType: 'resource-market',
      resourceKey: 'oss-tcm-frame-001',
      value: '/runtime/tcm-frame.png',
    })

    const secondPayload = serializeSceneDefinitionToFourPackages(restored)
    expect(JSON.parse(secondPayload.dependenciesJson)).toEqual(savedDependencies)
    expect(secondPayload.twoDJson).not.toContain('/runtime/tcm-frame.png')
  })

  it('测验多个资源市场图片槽位按稳定编号保存、去重并恢复', () => {
    const slotResourceKeys = {
      background: 'quiz-background',
      option: 'quiz-option',
      optionSelected: 'quiz-selected',
      optionCorrect: 'quiz-correct',
      optionIncorrect: 'quiz-incorrect',
      feedback: 'quiz-feedback',
      nextButton: 'quiz-selected',
    }
    const images = Object.fromEntries(
      Object.entries(slotResourceKeys).map(([slot, resourceKey]) => [
        slot,
        {
          sourceType: 'resource-market',
          value: `https://temporary.example/${slot}.png?token=secret`,
          resourceKey,
          fit: 'cover',
        },
      ]),
    )
    const scene = createSceneDefinition({
      id: 'quiz-resource-scene',
      name: '测验图片资源',
      type: 'local3d',
      coordinateSystem: { kind: 'local', unit: 'meter', upAxis: 'Y', gridEnabled: true },
      settings: {
        editor: {
          widgetSceneFragment: {
            widgets: [
              {
                id: 'widget-quiz-resource-001',
                component: {
                  attr: { l: 0, t: 0, w: 564, h: 616, zIndex: 0 },
                  info: {
                    name: '答题测验',
                    keyName: 'VQuiz',
                    packageName: 'Widget',
                    icon: '',
                  },
                  option: {
                    title: '本草小测验',
                    images,
                    text: {
                      title: {
                        x: 92,
                        y: 18,
                        width: 340,
                        height: 48,
                        fontSize: 30,
                        color: '#f2e5c7',
                      },
                    },
                  },
                  styles: { animations: [] },
                },
              },
            ],
            widgetLayerTree: [{ id: 'widget-quiz-resource-001', type: 'widget' }],
          },
        },
      },
    })

    const firstPayload = serializeSceneDefinitionToFourPackages(scene)
    const savedTwoD = JSON.parse(firstPayload.twoDJson) as {
      components: Array<{
        resourceRefKeys: string[]
        renderConfig: {
          images: Record<string, Record<string, unknown>>
          text: Record<string, Record<string, unknown>>
        }
      }>
    }
    const savedDependencies = JSON.parse(firstPayload.dependenciesJson) as {
      resources: Array<Record<string, unknown>>
    }
    const savedQuiz = savedTwoD.components[0]
    const uniqueResourceKeys = [...new Set(Object.values(slotResourceKeys))]

    expect(savedQuiz.resourceRefKeys).toEqual(uniqueResourceKeys)
    expect(savedDependencies.resources).toHaveLength(uniqueResourceKeys.length)
    expect(savedQuiz.renderConfig.images.background).toMatchObject({
      sourceType: 'resource-market',
      resourceKey: 'quiz-background',
      value: '',
    })
    expect(savedQuiz.renderConfig.text.title).toMatchObject({
      x: 92,
      y: 18,
      width: 340,
      height: 48,
    })
    expect(firstPayload.twoDJson).not.toContain('token=secret')

    const resolvedAssetUrls = Object.fromEntries(
      uniqueResourceKeys.map((resourceKey) => [resourceKey, `/runtime/${resourceKey}.png`]),
    )
    const restored = assembleSceneDefinitionFromRuntimeFragments({
      manifest: {
        fragmentType: 'manifest',
        fragmentKey: scene.id,
        contentJson: JSON.stringify(firstPayload),
      },
      options: { sceneId: scene.id, resolvedAssetUrls },
    })
    const restoredWidget = (
      restored.settings.editor as {
        widgetSceneFragment: {
          widgets: Array<{
            component: {
              option: {
                images: Record<string, Record<string, unknown>>
                text: { title: Record<string, unknown> }
              }
            }
          }>
        }
      }
    ).widgetSceneFragment.widgets[0]
    // 每个图片槽位按自己的资源编号恢复；重用编号只产生一份依赖记录。
    Object.entries(slotResourceKeys).forEach(([slot, resourceKey]) => {
      expect(restoredWidget.component.option.images[slot]).toMatchObject({
        sourceType: 'resource-market',
        resourceKey,
        value: resolvedAssetUrls[resourceKey],
      })
    })
    expect(restoredWidget.component.option.text.title).toMatchObject({
      x: 92,
      y: 18,
      width: 340,
    })

    const secondPayload = serializeSceneDefinitionToFourPackages(restored)
    expect(JSON.parse(secondPayload.dependenciesJson)).toEqual(savedDependencies)
    expect(secondPayload.twoDJson).not.toContain('/runtime/quiz-')
  })

  it('二维图片轮播直接保存地址数组并保留顺序和重复项', () => {
    const scene = createSceneDefinition({
      id: 'widget-carousel-resource-scene',
      name: '二维轮播图片资源',
      type: 'local3d',
      coordinateSystem: { kind: 'local', unit: 'meter', upAxis: 'Y', gridEnabled: true },
      settings: {
        editor: {
          widgetSceneFragment: {
            widgets: [
              {
                id: 'widget-carousel-001',
                component: {
                  attr: { l: 0, t: 0, w: 300, h: 180, zIndex: 0 },
                  info: {
                    name: '图片轮播',
                    keyName: 'VImageCarousel',
                    packageName: 'Widget',
                    icon: 'http://localhost:5173/carousel.png',
                  },
                  option: {
                    dataset: [
                      'https://temporary.example/slide.png?token=first',
                      'https://temporary.example/slide.png?token=second',
                    ],
                    options: [
                      {
                        label: '图片1',
                        value: 'https://temporary.example/slide.png?token=first',
                      },
                      {
                        label: '图片2',
                        value: 'https://temporary.example/slide.png?token=second',
                      },
                    ],
                    resourceKeys: ['oss-carousel-image-001', 'oss-carousel-image-001'],
                    autoplay: true,
                  },
                  styles: { animations: [] },
                },
              },
            ],
            widgetLayerTree: [{ id: 'widget-carousel-001', type: 'widget' }],
          },
        },
      },
    })

    const firstPayload = serializeSceneDefinitionToFourPackages(scene)
    const savedTwoD = JSON.parse(firstPayload.twoDJson) as {
      components: Array<{
        resourceRefKeys: string[]
        renderConfig: Record<string, unknown>
      }>
    }
    const savedDependencies = JSON.parse(firstPayload.dependenciesJson) as {
      resources: Array<Record<string, unknown>>
    }

    expect(savedTwoD.components[0].resourceRefKeys).toEqual([])
    expect(savedTwoD.components[0].renderConfig).toMatchObject({
      dataset: [
        'https://temporary.example/slide.png?token=first',
        'https://temporary.example/slide.png?token=second',
      ],
      autoplay: true,
    })
    expect(savedTwoD.components[0].renderConfig).not.toHaveProperty('resourceKeys')
    expect(savedDependencies.resources).toEqual([])

    const restored = assembleSceneDefinitionFromRuntimeFragments({
      manifest: {
        fragmentType: 'manifest',
        fragmentKey: 'widget-carousel-resource-scene',
        contentJson: JSON.stringify(firstPayload),
      },
      options: {
        sceneId: scene.id,
        resolvedAssetUrls: { 'oss-carousel-image-001': '/runtime/slide.png' },
      },
    })
    const restoredWidget = (
      restored.settings.editor as {
        widgetSceneFragment: {
          widgets: Array<{ component: { option: Record<string, unknown> } }>
        }
      }
    ).widgetSceneFragment.widgets[0]

    expect(restoredWidget.component.option.dataset).toEqual([
      'https://temporary.example/slide.png?token=first',
      'https://temporary.example/slide.png?token=second',
    ])
    const secondPayload = serializeSceneDefinitionToFourPackages(restored)
    expect(JSON.parse(secondPayload.dependenciesJson)).toEqual(savedDependencies)
    expect(secondPayload.twoDJson).toContain('https://temporary.example/slide.png?token=first')
    expect(secondPayload.twoDJson).toContain('https://temporary.example/slide.png?token=second')
  })
})
