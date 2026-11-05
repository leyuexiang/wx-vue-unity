import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  createSceneDefinition, createViewportHost, createCreateObjectLayerCommand, createMoveObjectToLayerCommand,
  createUpdateObjectExtensionsCommand, createUpdateObjectLayerCommand, createUpdateObjectNameCommand,
  createUpdateObjectVisibilityCommand, type SceneLayer, type SceneObject, type ViewportHost,
} from '@/scene-platform'
import { createDeleteObjectLayerCommand } from '@/scene-platform/commands/objectLayerCommands'
import { createEmptyDataConfig } from '@/types/data-config'
import { deleteEditorSceneObjectLayer } from '../editorSceneLayerAdapter'
import { clearActiveSceneViewportHost, setActiveSceneViewportHost } from '../editorScenePlatformHost'
import { runConfirmedEditorCommand } from '../editorSceneCommandTransaction'
import { saveEditorSceneDefinition } from '../editorSceneSaveAdapter'
import { saveActiveEditorSceneAsTemplate } from '../editorDim3dSceneTemplateService'
import { setEditorSceneObjectDataConfig } from '../editorSceneDataConfigAdapter'
import { setEditorSceneObjectInteractiveEventList } from '../editorSceneInteractionConfigAdapter'
import { assembleSceneDefinitionFromRuntimeFragments } from '../sceneRuntimeFragmentAssembler'
import { serializeSceneDefinitionToFourPackages, type SceneFourPackagePayload } from '../sceneFourPackage'
import { releaseOriginalScenePackages, retainOriginalScenePackages } from '../twoDPackagePreservation'
import { DATA_BINDING_OVERFLOW_METADATA_KEY, SERVER_PERSISTED_DATA_BINDING_LIMIT } from '../dataBindingOverflow'
import { DIM3D_TEMPLATE_TYPE } from '@/servers/manual/dim3d/api/template'

const sceneId = '8148'
const layer = (id: string, order: number): SceneLayer => ({ id, name: id, type: 'object', order, visible: true, locked: false })
const node = (id: string, layerId: string, metadata?: SceneObject['metadata']): SceneObject => ({
  id, name: id, type: 'group', order: 0, layerId, visible: true, locked: false, metadata,
  transform: { kind: 'local', position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 },
})
const owner = (instanceId: string) => ({ domain: 'threeD', ownerType: 'instance', instanceId })
const data = (value: string) => {
  const config = createEmptyDataConfig()
  if (config.request.type === 'static') config.request.config.data = [{ value }]
  return config
}
let active: ViewportHost | undefined
async function setup() {
  setActivePinia(createPinia())
  const scene = createSceneDefinition({
    id: sceneId, name: '原档字段合并检查', type: 'local3d',
    coordinateSystem: { kind: 'local', unit: 'meter', upAxis: 'Y', gridEnabled: true },
    layers: [layer('source', 0), layer('target', 1)],
    objects: [
      node('editable', 'source', {
        pickable: true, dataConfig: data('旧值'), deviceId: 'old-device',
        deviceBinding: { bindingKey: 'primary', vendorChannel: 'channel' },
        interactiveEvent: [{ id: 'old-event', eventName: '旧事件' }],
        statusList: [{ id: 'status', statusName: '原状态' }],
      }),
      node('peer', 'target'),
    ],
  })
  const host = createViewportHost({ container: {} as HTMLElement, scene })
  active = host
  await host.mount()
  setActiveSceneViewportHost(host)
  const store = host.getStore()
  const commandBus = host.getCommandBus()
  const original = serializeSceneDefinitionToFourPackages(store.getScene())
  const threeD = JSON.parse(original.threeDJson)
  const dependencies = JSON.parse(original.dependenciesJson)
  const saveAll = vi.fn(async (_body: SceneFourPackagePayload) => ({ code: 200, data: { sceneId, conflict: false } }))
  const save = async () => {
    await saveEditorSceneDefinition({
      saveContext: { sceneId, lockToken: 'test-lock' }, dim3dSaveOptions: { saveAll },
    })
    return saveAll.mock.lastCall![0]
  }
  const retain = () => retainOriginalScenePackages(sceneId, {
    ...original, threeDJson: JSON.stringify(threeD), dependenciesJson: JSON.stringify(dependencies),
  })
  return { host, store, commandBus, original, threeD, dependencies, save, saveAll, retain }
}
afterEach(() => {
  clearActiveSceneViewportHost()
  active?.dispose()
  releaseOriginalScenePackages(sceneId)
  vi.restoreAllMocks()
})

describe('旧三维档案的显式字段合并', () => {
  it('实际命令修改的图层和实例字段可保存重开及另存，原档扩展和未接管记录保留', async () => {
    const { store, commandBus, threeD, dependencies, retain, save } = await setup()
    const originalLayer = threeD.layers.find((entry: { layerKey: string }) => entry.layerKey === 'source')
    originalLayer.vendorLayer = { keep: true }
    const originalTarget = threeD.components.find((entry: { instanceId: string }) => entry.instanceId === 'editable')
    originalTarget.vendorTarget = '保留'
    originalTarget.contentJson = JSON.stringify({
      ...originalTarget.contentJson, vendorContent: { keep: true },
      metadata: { ...originalTarget.contentJson.metadata, vendorMetadata: 1, interactiveEvent: [{ id: 'legacy-copy' }] },
    })
    const untouched = { instanceId: 'unloaded', targetType: 'vendor', layerKey: 'target', extension: { keep: true } }
    threeD.components.push(untouched)
    const opaqueBehavior = { owner: owner('editable'), behaviorKey: 'opaque', behaviorType: 'interaction', vendorRecord: 3 }
    dependencies.behaviors.push(opaqueBehavior)
    dependencies.dataBindings[0].contentJson.vendorBinding = true
    dependencies.dataBindings[0].source.vendorSource = '原来源扩展'
    retain()

    commandBus.execute(createUpdateObjectLayerCommand('source', { name: '原图层改名', visible: false }))
    commandBus.execute(createCreateObjectLayerCommand(layer('empty-group', 2)))
    commandBus.execute(createMoveObjectToLayerCommand('editable', 'target'))
    commandBus.execute(createUpdateObjectNameCommand('editable', '改名后'))
    commandBus.execute(createUpdateObjectVisibilityCommand('editable', false))
    commandBus.execute(createUpdateObjectExtensionsCommand('editable', { metadata: { pickable: false, deviceId: 'new-device' } }))
    setEditorSceneObjectDataConfig({ store, commandBus, objectId: 'editable', dataConfig: data('新值') })
    setEditorSceneObjectInteractiveEventList({ store, commandBus, objectId: 'editable', eventList: [] })
    const body = await save()
    const savedThreeD = JSON.parse(body.threeDJson)
    const target = savedThreeD.components.find((entry: { instanceId: string }) => entry.instanceId === 'editable')
    expect(target).toMatchObject({ name: '改名后', visible: false, layerKey: 'target', vendorTarget: '保留' })
    expect(JSON.parse(target.contentJson)).toEqual({
      vendorContent: { keep: true }, metadata: { pickable: false, vendorMetadata: 1 },
    })
    expect(savedThreeD.components).toContainEqual(untouched)
    expect(savedThreeD.layers).toContainEqual(expect.objectContaining({
      layerKey: 'source', name: '原图层改名', visible: false, vendorLayer: { keep: true },
    }))
    expect(savedThreeD.layers).toContainEqual(expect.objectContaining({ layerKey: 'empty-group' }))
    const deps = JSON.parse(body.dependenciesJson)
    expect(deps.dataBindings).toHaveLength(1)
    expect(deps.dataBindings[0]).toMatchObject({
      source: { staticData: [{ value: '新值' }], vendorSource: '原来源扩展' },
      contentJson: { vendorBinding: true },
    })
    expect(deps.behaviors).toEqual([expect.objectContaining({ behaviorKey: 'status' }), opaqueBehavior])
    expect(deps.deviceBindings).toEqual([expect.objectContaining({
      bindingKey: 'primary', deviceId: 'new-device', vendorChannel: 'channel',
    })])
    const reopened = assembleSceneDefinitionFromRuntimeFragments({
      manifest: { fragmentType: 'manifest', fragmentKey: sceneId, contentJson: JSON.stringify(body) },
      options: { sceneId, sceneType: 'local3d' },
    })
    expect(reopened.objects.find(object => object.id === 'editable')).toMatchObject({
      name: '改名后', layerId: 'target',
      metadata: { pickable: false, vendorMetadata: 1, deviceId: 'new-device', dataConfig: { request: { config: { data: [{ value: '新值' }] } } } },
    })
    const saveTemplate = vi.fn(async (_body: SceneFourPackagePayload) => ({
      code: 200, data: { sceneId: '45', sceneKind: 'TEMPLATE' as const, saveScope: 'all' as const },
    }))
    await saveActiveEditorSceneAsTemplate({
      name: '旧档字段验收', category: '1', templateType: DIM3D_TEMPLATE_TYPE.INDUSTRY, saveScope: 'all',
    }, { saveTemplate })
    expect(JSON.parse(saveTemplate.mock.lastCall![0].threeDJson).layers).toContainEqual(
      expect.objectContaining({ layerKey: 'empty-group' }),
    )
    commandBus.undo()
    const undone = JSON.parse((await save()).dependenciesJson)
    expect(undone.behaviors).toContainEqual(expect.objectContaining({ behaviorKey: 'old-event' }))
    commandBus.execute(createUpdateObjectExtensionsCommand('editable', { metadata: { deviceId: '' } }))
    expect(JSON.parse((await save()).dependenciesJson).deviceBindings).toEqual([])
  })

  it('删除图层后解除成员归属，未进入草稿的成员阻止删除与落盘', async () => {
    const { store, commandBus, threeD, retain, save, saveAll } = await setup()
    const unloaded = { instanceId: 'unloaded', targetType: 'vendor', layerKey: 'source' }
    threeD.components.push(unloaded)
    retain()
    expect(() => deleteEditorSceneObjectLayer({ store, commandBus, layerId: 'source' })).toThrow('未进入草稿')
    expect(commandBus.getUndoSize()).toBe(0)
    commandBus.execute(createDeleteObjectLayerCommand('source'))
    await expect(save()).rejects.toThrow('仍被原始节点引用')
    expect(saveAll).not.toHaveBeenCalled()
    commandBus.undo()

    threeD.components.pop()
    retain()
    expect(deleteEditorSceneObjectLayer({ store, commandBus, layerId: 'source' }).status).toBe('applied')
    const saved = JSON.parse((await save()).threeDJson)
    expect(saved.layers.map((entry: { layerKey: string }) => entry.layerKey)).toEqual(['target'])
    expect(saved.components.find((entry: { instanceId: string }) => entry.instanceId === 'editable'))
      .not.toHaveProperty('layerKey')
    commandBus.undo()
    const undone = JSON.parse((await save()).threeDJson)
    expect(undone.components.find((entry: { instanceId: string }) => entry.instanceId === 'editable'))
      .toHaveProperty('layerKey', 'source')
  })

  it('异步补偿不扩大保存范围，重新合并后重建数据绑定尾部', async () => {
    const { host, store, commandBus, original, threeD, dependencies, save } = await setup()
    const fillers = Array.from({ length: SERVER_PERSISTED_DATA_BINDING_LIMIT }, (_, index) => ({
      bindingKey: `opaque-${index}`, owner: owner('other'),
    }))
    retainOriginalScenePackages(sceneId, {
      ...original,
      threeDJson: JSON.stringify(threeD),
      sceneJson: JSON.stringify({ ...JSON.parse(original.sceneJson), metadata: {
        [DATA_BINDING_OVERFLOW_METADATA_KEY]: dependencies.dataBindings,
      } }),
      dependenciesJson: JSON.stringify({ ...dependencies, dataBindings: fillers }),
    })
    vi.spyOn(host.getBridge(), 'flush').mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('运行端拒绝'))
    const command = createUpdateObjectLayerCommand('source', { visible: false })
    await expect(runConfirmedEditorCommand(host, 'execute', command, () => active === host)).rejects.toThrow('运行端拒绝')
    expect(store.getLayer('source')?.visible).toBe(true)
    expect(store.captureSaveEdits().layers.size).toBe(0)
    setEditorSceneObjectDataConfig({ store, commandBus, objectId: 'editable', dataConfig: data('尾部新值') })
    const body = await save()
    const overflow = JSON.parse(body.sceneJson).metadata[DATA_BINDING_OVERFLOW_METADATA_KEY]
    expect(overflow).toEqual([expect.objectContaining({
      owner: owner('editable'), source: expect.objectContaining({ staticData: [{ value: '尾部新值' }] }),
    })])
  })
})
