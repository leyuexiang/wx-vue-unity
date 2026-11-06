import { describe, expect, it, vi } from 'vitest'
import { createSceneDefinition, createViewportHost, type SceneDefinition, type ViewportHost } from '@/scene-platform'
import {
  applyEditorDim3dTemplate,
  createEditorSceneFromTemplate,
} from '../editorDim3dTemplateApplyService'
import { releaseOriginalScenePackages } from '../twoDPackagePreservation'
import { dispatchEditorHistory } from '../editorSceneUndoRedoAdapter'
import { clearActiveSceneViewportHost, setActiveSceneViewportHost } from '../editorScenePlatformHost'
import { serializeSceneDefinitionToFourPackages } from '../sceneFourPackage'
import { assembleSceneDefinitionFromRuntimeFragments } from '../sceneRuntimeFragmentAssembler'

const buildLocalScene = (id: string, overrides: Partial<SceneDefinition> = {}) =>
  createSceneDefinition({
    id,
    name: `本地场景-${id}`,
    type: 'local3d',
    coordinateSystem: { kind: 'local', unit: 'meter', upAxis: 'Y', gridEnabled: true },
    ...overrides,
  })

const buildGisScene = (id: string, overrides: Partial<SceneDefinition> = {}) =>
  createSceneDefinition({
    id,
    name: `地图场景-${id}`,
    type: 'gis',
    coordinateSystem: {
      kind: 'wgs84',
      terrainEnabled: false,
      defaultLongitude: 104,
      defaultLatitude: 30,
      defaultHeight: 0,
    },
    ...overrides,
  })

const buildHost = (currentScene: SceneDefinition) =>
  ({
    getStore: vi.fn(() => ({ getScene: () => currentScene })),
    getRuntime: vi.fn(() => null),
    replaceScene: vi.fn(async () => undefined),
  }) as unknown as ViewportHost

describe('编辑器应用三维模板服务', () => {
  it('通过模板场景编号请求详情，解析后使用当前场景编号整体替换', async () => {
    const currentScene = buildLocalScene('current-scene')
    const templateScene = buildLocalScene('template-scene', {
      objects: [
        {
          id: 'template-object',
          name: '模板几何体',
          type: 'primitive',
          visible: true,
          locked: false,
          order: 0,
          transform: {
            kind: 'local',
            position: [0, 0, 0],
            rotation: [0, 0, 0],
            scale: 1,
          },
        },
      ],
      streaming: {
        groups: [],
        chunks: [
          {
            id: 'template-chunk',
            sceneId: 'template-scene',
            bounds: { type: 'sphere', center: [0, 0, 0], radius: 10 },
            objectIds: ['template-object'],
            assetIds: [],
          },
        ],
        options: { enabled: true },
      },
    })
    const host = buildHost(currentScene)
    const repository = { load: vi.fn(async () => templateScene) }
    const applyWidgetFragment = vi.fn(async () => undefined)

    const result = await applyEditorDim3dTemplate(
      { templateSceneId: ' template-scene ', saveScope: 'all' },
      { host, repository, applyWidgetFragment },
    )

    expect(repository.load).toHaveBeenCalledOnce()
    expect(repository.load).toHaveBeenCalledWith('template-scene')
    expect(result.id).toBe('current-scene')
    expect(result.streaming.chunks[0]?.sceneId).toBe('current-scene')
    expect(result.objects.map((item) => item.id)).toEqual(['template-object'])
    expect(host.replaceScene).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'current-scene',
        objects: [expect.objectContaining({ id: 'template-object' })],
        streaming: expect.objectContaining({
          chunks: [expect.objectContaining({ sceneId: 'current-scene' })],
        }),
      }),
      { preserveHistory: true },
    )
    expect(applyWidgetFragment).toHaveBeenCalledOnce()
  })

  it('成功应用后登记场景快照命令，撤销与重做使用当前场景编号', async () => {
    const currentScene = buildLocalScene('current-scene')
    const templateScene = buildLocalScene('template-scene')
    const commandBus = { recordExecuted: vi.fn() }
    const host = {
      ...buildHost(currentScene),
      getCommandBus: () => commandBus,
    } as unknown as ViewportHost
    const repository = { load: vi.fn(async () => templateScene) }
    const applyWidgetFragment = vi.fn(async () => undefined)

    await applyEditorDim3dTemplate(
      { templateSceneId: 'template-scene', saveScope: 'all' },
      { host, repository, applyWidgetFragment },
    )

    expect(commandBus.recordExecuted).toHaveBeenCalledOnce()
    const command = commandBus.recordExecuted.mock.calls[0]?.[0]
    const store = { loadScene: vi.fn() }
    command.undo(store)
    expect(store.loadScene).toHaveBeenCalledWith(currentScene)
    command.execute(store)
    expect(store.loadScene).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'current-scene' }))
    await command.applyAsync('undo')
    expect(applyWidgetFragment).toHaveBeenCalledTimes(2)
    releaseOriginalScenePackages('current-scene')
  })

  it('真实场景宿主完成应用、撤销、重做和四包回读', async () => {
    const currentScene = buildLocalScene('current-scene', {
      objects: [{
        id: 'current-object', name: '当前对象', type: 'primitive', visible: true, locked: false, order: 0,
        transform: { kind: 'local', position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 },
      }],
    })
    const templateScene = buildLocalScene('template-scene', {
      objects: [{
        id: 'template-object', name: '模板对象', type: 'primitive', visible: true, locked: false, order: 0,
        transform: { kind: 'local', position: [10, 0, 0], rotation: [0, 0, 0], scale: 1 },
      }],
    })
    const host = createViewportHost({ container: {} as HTMLElement, scene: currentScene })
    await host.mount()
    setActiveSceneViewportHost(host)
    try {
      await applyEditorDim3dTemplate(
        { templateSceneId: 'template-scene', saveScope: 'all' },
        {
          host,
          repository: { load: vi.fn(async () => templateScene) },
          applyWidgetFragment: vi.fn(async () => undefined),
        },
      )
      expect(host.getStore().getObjects().map((object) => object.id)).toEqual(['template-object'])
      expect(host.getCommandBus().getUndoSize()).toBe(1)

      expect(await dispatchEditorHistory('undo', {
        commandBus: host.getCommandBus(),
        onError: (error) => { throw error },
      })).toBe(true)
      expect(host.getStore().getObjects().map((object) => object.id)).toEqual(['current-object'])
      const undone = assembleSceneDefinitionFromRuntimeFragments({
        manifest: {
          fragmentType: 'manifest', fragmentKey: 'current-scene',
          contentJson: JSON.stringify(serializeSceneDefinitionToFourPackages(host.getStore().getScene())),
        },
        options: { sceneId: 'current-scene', sceneType: 'local3d' },
      })
      expect(undone.objects.map((object) => object.id)).toEqual(['current-object'])

      expect(await dispatchEditorHistory('redo', {
        commandBus: host.getCommandBus(),
        onError: (error) => { throw error },
      })).toBe(true)
      expect(host.getStore().getObjects().map((object) => object.id)).toEqual(['template-object'])
    } finally {
      clearActiveSceneViewportHost()
      host.dispose()
    }
  })

  it('仅二维模板跨场景应用时清空来源三维域并使用当前场景类型', () => {
    const currentScene = buildGisScene('current-gis')
    const templateScene = buildLocalScene('template-two-d', {
      objects: [
        {
          id: 'unexpected-source-object',
          name: '不应保留的来源对象',
          type: 'primitive',
          visible: true,
          locked: false,
          order: 0,
          transform: {
            kind: 'local',
            position: [0, 0, 0],
            rotation: [0, 0, 0],
            scale: 1,
          },
        },
      ],
      layers: [
        {
          id: 'unexpected-source-layer',
          name: '不应保留的来源图层',
          type: 'object',
          visible: true,
          locked: false,
          order: 0,
        },
      ],
    })

    const result = createEditorSceneFromTemplate(templateScene, currentScene, 'twoD')

    expect(result).toMatchObject({
      id: 'current-gis',
      type: 'gis',
      coordinateSystem: { kind: 'wgs84' },
      objects: [],
      layers: [],
      effects: [],
    })
  })

  it('三维模板类型不匹配时拒绝覆盖当前场景', async () => {
    const currentScene = buildGisScene('current-gis')
    const templateScene = buildLocalScene('template-local')
    const host = buildHost(currentScene)
    const repository = { load: vi.fn(async () => templateScene) }

    await expect(
      applyEditorDim3dTemplate(
        { templateSceneId: 'template-local', saveScope: 'threeD' },
        { host, repository },
      ),
    ).rejects.toThrow('三维场景类型与当前场景不一致')
    expect(host.replaceScene).not.toHaveBeenCalled()
  })

  it('模板读取失败时保留当前草稿，不进入场景替换', async () => {
    const currentScene = buildLocalScene('current-scene')
    const host = buildHost(currentScene)
    const repository = { load: vi.fn(async () => { throw new Error('模板读取失败') }) }

    await expect(
      applyEditorDim3dTemplate(
        { templateSceneId: 'template-scene', saveScope: 'all' },
        { host, repository },
      ),
    ).rejects.toThrow('模板读取失败')
    expect(host.replaceScene).not.toHaveBeenCalled()
  })

  it('页面卸载后取消模板应用，不覆盖当前草稿', async () => {
    const currentScene = buildLocalScene('current-scene')
    const host = buildHost(currentScene)
    const repository = { load: vi.fn(async () => buildLocalScene('template-scene')) }

    await expect(
      applyEditorDim3dTemplate(
        { templateSceneId: 'template-scene', saveScope: 'all' },
        { host, repository, isActive: () => false },
      ),
    ).rejects.toThrow('模板应用已随页面关闭取消')
    expect(host.replaceScene).not.toHaveBeenCalled()
  })

  it('二维片段恢复失败时回放应用前草稿', async () => {
    const currentScene = buildLocalScene('current-scene')
    const templateScene = buildLocalScene('template-scene')
    const host = buildHost(currentScene)
    const repository = { load: vi.fn(async () => templateScene) }
    const applyWidgetFragment = vi
      .fn()
      .mockRejectedValueOnce(new Error('二维片段恢复失败'))
      .mockResolvedValue(undefined)

    await expect(
      applyEditorDim3dTemplate(
        { templateSceneId: 'template-scene', saveScope: 'all' },
        { host, repository, applyWidgetFragment },
      ),
    ).rejects.toThrow('二维片段恢复失败')
    expect(host.replaceScene).toHaveBeenCalledTimes(2)
    expect(host.replaceScene).toHaveBeenNthCalledWith(2, currentScene, { preserveHistory: undefined })
    expect(applyWidgetFragment).toHaveBeenCalledTimes(2)
  })

  it('模板编号或保存范围缺失时在发请求前拒绝', async () => {
    const host = buildHost(buildLocalScene('current-scene'))
    const repository = { load: vi.fn() }

    await expect(
      applyEditorDim3dTemplate({ templateSceneId: '  ', saveScope: 'all' }, { host, repository }),
    ).rejects.toThrow('缺少可加载的模板场景编号')
    await expect(
      applyEditorDim3dTemplate({ templateSceneId: 'template-scene' }, { host, repository }),
    ).rejects.toThrow('缺少有效的保存范围')
    expect(repository.load).not.toHaveBeenCalled()
  })
})
