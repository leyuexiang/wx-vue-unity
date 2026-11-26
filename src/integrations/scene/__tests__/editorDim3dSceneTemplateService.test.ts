import { describe, expect, it, vi } from 'vitest'
import { createSceneDefinition, createVegetationSystemDefinition } from '@/scene-platform'
import { createEnviroWeatherEffect } from '@/scene-platform/effects/weather'
import { saveActiveEditorSceneAsTemplate } from '../editorDim3dSceneTemplateService'
import { readSceneGlobalStateFromDefinition } from '../editorSceneGlobalStateAdapter'

/** 构造最小合法场景，验证模板服务只依赖纯场景快照而不需要真实渲染器。 */
const buildScene = () =>
  createSceneDefinition({
    id: '2089645792212000769',
    name: '尚未保存的编辑场景',
    type: 'local3d',
    coordinateSystem: {
      kind: 'local',
      unit: 'meter',
      upAxis: 'Y',
      gridEnabled: true,
    },
  })

/** 构造同时包含二维、三维、共享资源和跨域动作的场景，用于验证模板筛选闭包。 */
const buildMixedScene = () =>
  createSceneDefinition({
    id: 'scene-mixed-001',
    name: '混合场景',
    type: 'local3d',
    coordinateSystem: {
      kind: 'local',
      unit: 'meter',
      upAxis: 'Y',
      gridEnabled: true,
    },
    objects: [
      {
        id: 'object-001',
        name: '三维模型',
        type: 'model',
        visible: true,
        locked: false,
        order: 0,
        transform: {
          kind: 'local',
          position: [0, 0, 0],
          rotation: [0, 0, 0],
          scale: 1,
        },
        asset: { id: 'asset-3d', kind: 'glb', url: '/model.glb' },
      },
    ],
    settings: {
      requestGlobalConfig: { requestOriginUrl: '/api' },
      publicRequests: [
        { publicRequestKey: 'public-2d', requestConfig: { requestUrl: '/two-d' } },
        { publicRequestKey: 'public-3d', requestConfig: { requestUrl: '/three-d' } },
      ],
      sceneActions: [
        {
          actionKey: 'scene-action-001',
          targets: [
            { domain: 'twoD', ownerType: 'instance', instanceId: 'widget-001' },
            { domain: 'threeD', ownerType: 'instance', instanceId: 'object-001' },
          ],
          config: {
            actionTargetUuid: 'object-001',
            actionTargetWidgetIds: ['widget-001'],
          },
        },
      ],
      // 旧依赖注入应使用兼容入口；正式 dependencies 表示已展开到实例的索引，不能再当旧配置读取。
      sceneRuntimeDependencies: {
        resources: [],
        dataBindings: [
          {
            bindingKey: 'binding-2d',
            owner: { domain: 'twoD', ownerType: 'instance', instanceId: 'widget-001' },
            source: { type: 'public', publicRequestKey: 'public-2d' },
          },
          {
            bindingKey: 'binding-3d',
            owner: { domain: 'threeD', ownerType: 'instance', instanceId: 'object-001' },
            source: { type: 'public', publicRequestKey: 'public-3d' },
          },
        ],
        behaviors: [
          {
            behaviorKey: 'behavior-2d',
            owner: { domain: 'twoD', ownerType: 'instance', instanceId: 'widget-001' },
            conditionGroups: [
              {
                actions: [
                  {
                    targets: [
                      { domain: 'threeD', ownerType: 'instance', instanceId: 'object-001' },
                    ],
                    config: { actionTargetUuid: 'object-001' },
                  },
                ],
              },
            ],
          },
          {
            behaviorKey: 'behavior-3d',
            owner: { domain: 'threeD', ownerType: 'instance', instanceId: 'object-001' },
          },
        ],
        deviceBindings: [
          {
            bindingKey: 'device-2d',
            owner: { domain: 'twoD', ownerType: 'instance', instanceId: 'widget-001' },
            deviceId: 'device-2d',
          },
          {
            bindingKey: 'device-3d',
            owner: { domain: 'threeD', ownerType: 'instance', instanceId: 'object-001' },
            deviceId: 'device-3d',
          },
        ],
      },
      editor: {
        widgetSceneFragment: {
          widgets: [
            {
              id: 'widget-001',
              component: {
                attr: { l: 0, t: 0, w: 100, h: 100, zIndex: 1 },
                info: { name: '图片', keyName: 'VImage', packageName: 'Widget' },
                option: {
                  sourceType: 'resource-market',
                  resourceKey: 'asset-2d',
                  value: '/image.png',
                },
                styles: { animations: [] },
              },
            },
          ],
          widgetLayerTree: [{ id: 'widget-001', type: 'widget' }],
          widgetCanvas: { width: 1920, height: 1080 },
        },
      },
    },
  })

describe('当前编辑场景另存模板服务', () => {
  it('一次提交当前四包快照并省略空的可选字段', async () => {
    const scene = buildScene()
    scene.effects = [createEnviroWeatherEffect()]
    const saveTemplate = vi.fn(async (body) => ({
      code: 200,
      data: {
        sceneId: '2095342911956561921',
        sceneKind: 'TEMPLATE' as const,
        saveScope: body.saveScope,
      },
    }))

    const result = await saveActiveEditorSceneAsTemplate(
      {
        name: '  设备监测模板  ',
        templateType: 'dim3d_template_industry',
        category: ' BASE ',
        saveScope: 'twoD',
        sceneDesc: '  ',
      },
      {
        scene,
        sceneApi: null,
        widgetSceneFragment: null,
        saveTemplate,
      },
    )

    expect(saveTemplate).toHaveBeenCalledTimes(1)
    const body = saveTemplate.mock.calls[0]?.[0]
    expect(body).toMatchObject({
      name: '设备监测模板',
      templateType: 'dim3d_template_industry',
      category: 'BASE',
      saveScope: 'twoD',
    })
    expect(body).not.toHaveProperty('sceneDesc')
    expect(body).not.toHaveProperty('ownerType')
    expect(JSON.parse(body?.sceneJson || '{}')).toMatchObject({
      name: '尚未保存的编辑场景',
      sceneType: 'local3d',
    })
    /** 模板场景编号由请求与后端新建结果承载，四包正文不能固化来源实例编号。 */
    expect(JSON.parse(body?.sceneJson || '{}')).not.toHaveProperty('id')
    // 启用了默认天气的场景另存为纯二维模板时，三维基础配置及效果列表都不能带入天气。
    const threeD = JSON.parse(body?.threeDJson || '{}')
    expect(threeD).toMatchObject({ baseConfig: {}, objects: [] })
    expect(threeD.baseConfig).not.toHaveProperty('weather')
    expect(threeD).not.toHaveProperty('effects')
    expect(JSON.parse(body?.twoDJson || '{}')).toHaveProperty('components')
    expect(JSON.parse(body?.dependenciesJson || '{}')).toHaveProperty('resources')
    expect(result.sceneId).toBe('2095342911956561921')
  })

  it('三维模板保留植被编辑定义并移除来源场景专属发布产物', async () => {
    const sceneId = 'scene-vegetation-template-source'
    const publicationVersion = 'publication-source-only'
    const speciesId = 'vegetation-species:tree-template'
    const scene = createSceneDefinition({
      id: sceneId,
      name: '植被模板来源场景',
      type: 'gis',
      coordinateSystem: { kind: 'wgs84', terrainEnabled: true },
      vegetation: createVegetationSystemDefinition({
        ruleSetVersion: '7',
        layers: [
          {
            id: 'vegetation-layer-main',
            name: '默认植被层',
            visible: true,
            locked: false,
            kind: 'forest',
            priority: 0,
            speciesIds: [speciesId],
            manifestAsset: {
              id: `vegetation-manifest:${sceneId}:${publicationVersion}`,
              kind: 'json',
              url: '/source/manifest.json',
            },
            tilesetAsset: {
              id: `vegetation-tileset:${sceneId}:${publicationVersion}:vegetation-layer-main`,
              kind: '3d-tiles',
              url: '/source/tileset.json',
            },
          },
        ],
        speciesCatalog: [
          {
            id: speciesId,
            name: '模板树木',
            enabled: true,
            modelAsset: { id: 'model-tree-template', kind: 'glb', url: '/models/tree.glb' },
            minimumScale: 1,
            maximumScale: 3,
          },
        ],
        publication: {
          version: publicationVersion,
          manifestAsset: {
            id: `vegetation-manifest:${sceneId}:${publicationVersion}`,
            kind: 'json',
            url: '/source/manifest.json',
          },
          tilesetAsset: {
            id: `vegetation-tileset:${sceneId}:${publicationVersion}`,
            kind: '3d-tiles',
            url: '/source/tileset.json',
          },
          generatedAt: '2026-09-16T12:00:00.000Z',
          sourceHash: 'sha256:source-publication',
        },
      }),
    })
    const saveTemplate = vi.fn(async (body) => ({
      code: 200,
      data: {
        sceneId: 'template-vegetation',
        sceneKind: 'TEMPLATE' as const,
        saveScope: body.saveScope,
      },
    }))

    await saveActiveEditorSceneAsTemplate(
      {
        name: '可复用植被模板',
        templateType: 'dim3d_template_industry',
        category: 'AGRICULTURE_BASE',
        saveScope: 'threeD',
      },
      { scene, widgetSceneFragment: null, saveTemplate },
    )

    const body = saveTemplate.mock.calls[0]?.[0]
    const threeD = JSON.parse(body?.threeDJson || '{}')
    const dependencies = JSON.parse(body?.dependenciesJson || '{}')
    /** 模板复制的是可重新编辑和生成的植被配置，不复用来源场景的任何植被资源依赖。 */
    expect(threeD.vegetation).toMatchObject({
      ruleSetVersion: '7',
      layers: [{ id: 'vegetation-layer-main', speciesIds: [speciesId] }],
      speciesCatalog: [{ id: speciesId, name: '模板树木' }],
    })
    expect(threeD.vegetation).not.toHaveProperty('publication')
    expect(threeD.vegetation.layers[0]).not.toHaveProperty('manifestAsset')
    expect(threeD.vegetation.layers[0]).not.toHaveProperty('tilesetAsset')
    expect(dependencies.resources).toEqual([])
  })

  it('后端返回非模板类型或不一致范围时拒绝虚假成功', async () => {
    await expect(
      saveActiveEditorSceneAsTemplate(
        {
          name: '异常模板',
          templateType: 'dim3d_template_exhibition',
          category: 'EXHIBITION_BASE',
          saveScope: 'all',
        },
        {
          scene: buildScene(),
          widgetSceneFragment: null,
          saveTemplate: async () => ({
            code: 200,
            data: {
              sceneId: '2095342911956561921',
              sceneKind: 'INSTANCE',
              saveScope: 'all',
            },
          }),
        },
      ),
    ).rejects.toThrow('场景类型不是模板')

    await expect(
      saveActiveEditorSceneAsTemplate(
        {
          name: '范围异常模板',
          templateType: 'dim3d_template_industry',
          category: 'BASE',
          saveScope: 'threeD',
        },
        {
          scene: buildScene(),
          widgetSceneFragment: null,
          saveTemplate: async () => ({
            code: 200,
            data: {
              sceneId: '2095342911956561922',
              sceneKind: 'TEMPLATE',
              saveScope: 'twoD',
            },
          }),
        },
      ),
    ).rejects.toThrow('保存范围与提交范围不一致')
  })

  it('未选择模板分类时在发请求前直接拒绝', async () => {
    const saveTemplate = vi.fn()

    await expect(
      saveActiveEditorSceneAsTemplate(
        {
          name: '缺少分类模板',
          templateType: 'dim3d_template_industry',
          category: '  ',
          saveScope: 'all',
        },
        { scene: buildScene(), widgetSceneFragment: null, saveTemplate },
      ),
    ).rejects.toThrow('请选择模板分类')
    expect(saveTemplate).not.toHaveBeenCalled()
  })

  it.each([
    {
      saveScope: 'twoD' as const,
      expectedThreeDCount: 0,
      expectedTwoDCount: 1,
      expectedOwnerDomain: 'twoD',
      expectedResourceKey: 'asset-2d',
      expectedPublicRequestKey: 'public-2d',
    },
    {
      saveScope: 'threeD' as const,
      expectedThreeDCount: 1,
      expectedTwoDCount: 0,
      expectedOwnerDomain: 'threeD',
      expectedResourceKey: 'asset-3d',
      expectedPublicRequestKey: 'public-3d',
    },
  ])('按 $saveScope 筛选域内容和依赖闭包', async (testCase) => {
    const saveTemplate = vi.fn(async (body) => ({
      code: 200,
      data: {
        sceneId: `template-${body.saveScope}`,
        sceneKind: 'TEMPLATE' as const,
        saveScope: body.saveScope,
      },
    }))

    await saveActiveEditorSceneAsTemplate(
      {
        name: '范围模板',
        templateType: 'dim3d_template_industry',
        category: 'BASE',
        saveScope: testCase.saveScope,
      },
      {
        scene: buildMixedScene(),
        widgetSceneFragment: null,
        sceneGlobalState: readSceneGlobalStateFromDefinition(buildMixedScene()),
        saveTemplate,
      },
    )

    const body = saveTemplate.mock.calls[0]?.[0]
    const scene = JSON.parse(body?.sceneJson || '{}')
    const threeD = JSON.parse(body?.threeDJson || '{}')
    const twoD = JSON.parse(body?.twoDJson || '{}')
    const dependencies = JSON.parse(body?.dependenciesJson || '{}')
    expect(threeD.objects).toHaveLength(testCase.expectedThreeDCount)
    expect(twoD.components).toHaveLength(testCase.expectedTwoDCount)
    expect(dependencies.dataBindings).toHaveLength(1)
    expect(dependencies.behaviors).toHaveLength(1)
    expect(dependencies.deviceBindings).toHaveLength(1)
    expect(dependencies.dataBindings[0].owner.domain).toBe(testCase.expectedOwnerDomain)
    expect(dependencies.resources.map((item: { resourceKey: string }) => item.resourceKey)).toEqual(
      [testCase.expectedResourceKey],
    )
    expect(
      scene.publicRequests.map((item: { publicRequestKey: string }) => item.publicRequestKey),
    ).toEqual([testCase.expectedPublicRequestKey])
  })

  it('仅二维模板保留跨域动作但清空三维目标', async () => {
    const saveTemplate = vi.fn(async (body) => ({
      code: 200,
      data: {
        sceneId: 'template-two-d',
        sceneKind: 'TEMPLATE' as const,
        saveScope: body.saveScope,
      },
    }))

    await saveActiveEditorSceneAsTemplate(
      {
        name: '二维模板',
        templateType: 'dim3d_template_industry',
        category: 'BASE',
        saveScope: 'twoD',
      },
      {
        scene: buildMixedScene(),
        widgetSceneFragment: null,
        sceneGlobalState: readSceneGlobalStateFromDefinition(buildMixedScene()),
        saveTemplate,
      },
    )

    const body = saveTemplate.mock.calls[0]?.[0]
    const scene = JSON.parse(body?.sceneJson || '{}')
    const dependencies = JSON.parse(body?.dependenciesJson || '{}')
    expect(scene.sceneActions[0].targets).toEqual([
      { domain: 'twoD', ownerType: 'instance', instanceId: 'widget-001' },
    ])
    expect(scene.sceneActions[0].config).toMatchObject({
      actionTargetUuid: '',
      actionTargetWidgetIds: ['widget-001'],
    })
    expect(dependencies.behaviors[0].conditionGroups[0].actions[0]).toMatchObject({
      targets: [],
      config: { actionTargetUuid: '' },
    })
  })

  it('全部模板保留二维、三维和两侧依赖', async () => {
    const saveTemplate = vi.fn(async (body) => ({
      code: 200,
      data: {
        sceneId: 'template-all',
        sceneKind: 'TEMPLATE' as const,
        saveScope: body.saveScope,
      },
    }))

    await saveActiveEditorSceneAsTemplate(
      {
        name: '完整模板',
        templateType: 'dim3d_template_industry',
        category: 'BASE',
        saveScope: 'all',
      },
      {
        scene: buildMixedScene(),
        widgetSceneFragment: null,
        sceneGlobalState: readSceneGlobalStateFromDefinition(buildMixedScene()),
        saveTemplate,
      },
    )

    const body = saveTemplate.mock.calls[0]?.[0]
    const scene = JSON.parse(body?.sceneJson || '{}')
    const threeD = JSON.parse(body?.threeDJson || '{}')
    const twoD = JSON.parse(body?.twoDJson || '{}')
    const dependencies = JSON.parse(body?.dependenciesJson || '{}')
    expect(threeD.objects).toHaveLength(1)
    expect(twoD.components).toHaveLength(1)
    expect(dependencies.dataBindings).toHaveLength(2)
    expect(dependencies.behaviors).toHaveLength(2)
    expect(dependencies.deviceBindings).toHaveLength(2)
    expect(dependencies.resources).toHaveLength(2)
    expect(scene.publicRequests).toHaveLength(2)
    expect(scene.sceneActions[0].targets).toHaveLength(2)
  })
})
