import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createSceneDefinition, createViewportHost, type SceneObject, type ViewportHost } from '@/scene-platform'
import { useSceneWidgetStore } from '@/stores/sceneEditStore'
import BaseWidgetConfig from '@/packages/components/BaseWidgetConfig'
import { createCommandBusWidgetCommandPort } from '../widgetRuntime/commandBusWidgetCommandAdapter'
import { resetWidgetRuntimePorts, setWidgetCommandPort } from '../widgetRuntime/ports'
import { clearActiveSceneViewportHost, setActiveSceneViewportHost } from '../editorScenePlatformHost'
import { deleteEditorSceneSubtrees } from '../editorSceneSubtreeDeletion'
import { dispatchEditorHistory } from '../editorSceneUndoRedoAdapter'
import { releaseOriginalScenePackages, retainOriginalScenePackages } from '../twoDPackagePreservation'
import { serializeSceneDefinitionToFourPackages, type SceneFourPackagePayload } from '../sceneFourPackage'
import { saveEditorSceneDefinition } from '../editorSceneSaveAdapter'

const id = '8145'
const node = (id: string, parentInstanceId?: string, order = 0): SceneObject => ({
  id, name: id, type: 'group', parentInstanceId, order, locked: false, visible: true,
  transform: { kind: 'local', position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 },
})
let host: ViewportHost | undefined
async function setup(locked = false) {
  setActivePinia(createPinia())
  const scene = createSceneDefinition({
    id, name: '子树删除检查', type: 'local3d',
    coordinateSystem: { kind: 'local', unit: 'meter', upAxis: 'Y', gridEnabled: true },
    objects: [
      node('parent'), node('other', undefined, 1), node('leaf', 'parent'),
      { ...node('deep', 'leaf'), locked, metadata: { unknownExtension: { key: '保留' } } },
    ],
    streaming: {
      groups: [],
      chunks: [{ id: 'mixed', sceneId: id, bounds: { type: 'sphere', center: [0, 0, 0], radius: 10 },
        objectIds: ['leaf', 'other'], assetIds: [] }],
    },
  })
  const current = createViewportHost({ container: {} as HTMLElement, scene })
  host = current
  await current.mount()
  setActiveSceneViewportHost(current)
  setWidgetCommandPort(createCommandBusWidgetCommandPort(() => current.getCommandBus()))
  return { host: current, store: current.getStore(), commandBus: current.getCommandBus(), onError: vi.fn() }
}
afterEach(() => {
  clearActiveSceneViewportHost()
  host?.dispose()
  releaseOriginalScenePackages(id)
  resetWidgetRuntimePorts()
  vi.restoreAllMocks()
})

describe('三维子树批量删除', () => {
  it('去重后只同步一次并登记一步，与二维编辑按顺序回放', async () => {
    const options = await setup()
    const { host, store, commandBus } = options
    const widgets = useSceneWidgetStore()
    const component = new BaseWidgetConfig()
    component.option = { label: '原名' }
    widgets.totalWidgets = [{ id: 'widget', component }]
    store.setSelectedObjectId('leaf')
    const before = structuredClone(store.getObjects())
    const streamingBefore = structuredClone(store.getScene().streaming)
    widgets.runWidgetHistoryChange('修改二维名称', ['widget'], () => { component.option.label = '新名' })
    await host.getBridge().flush()
    const load = vi.spyOn(host.getRuntime(), 'loadScene')
    expect(await deleteEditorSceneSubtrees(host, ['leaf', 'parent', 'leaf'])).toBe(true)
    expect(load).toHaveBeenCalledTimes(1)
    expect(store.getObjects().map((entry) => entry.id)).toEqual(['other'])
    expect(store.getScene().streaming?.chunks[0]?.objectIds).toEqual(['other'])
    expect(store.getSelectedObjectId()).toBeNull()
    expect(commandBus.getUndoSize()).toBe(2)
    widgets.runWidgetHistoryChange('二维移动', ['widget'], () => { component.attr.l = 42 })
    expect(await dispatchEditorHistory('undo', options)).toBe(true)
    expect(widgets.getWidgetById('widget')?.component.attr.l).toBe(0)
    expect(store.getObject('parent')).toBeNull()
    expect(await dispatchEditorHistory('undo', options)).toBe(true)
    expect(store.getObjects()).toEqual(before)
    expect(store.getScene().streaming).toEqual(streamingBefore)
    expect(store.getDeletedObjectIds().size).toBe(0)
    expect(store.getSelectedObjectId()).toBe('leaf')
    expect(await dispatchEditorHistory('undo', options)).toBe(true)
    expect(widgets.getWidgetById('widget')?.component.option).toEqual({ label: '原名' })
    expect(await dispatchEditorHistory('redo', options)).toBe(true)
    expect(await dispatchEditorHistory('redo', options)).toBe(true)
    expect(await dispatchEditorHistory('redo', options)).toBe(true)
    expect(store.getObjects().map((entry) => entry.id)).toEqual(['other'])
    expect(widgets.getWidgetById('widget')?.component.attr.l).toBe(42)
  })

  it('锁定后代使整批失败，包含其他可删除节点也不部分提交', async () => {
    const { host, store, commandBus } = await setup(true)
    await expect(deleteEditorSceneSubtrees(host, ['other', 'parent'])).rejects.toThrow('已锁定')
    expect(store.getObjects()).toHaveLength(4)
    expect(commandBus.getUndoSize()).toBe(0)
    expect(store.getDeletedObjectIds().size).toBe(0)
  })

  it('保留节点仍引用子树时拒绝删除，删除范围内的内部引用随原记录恢复', async () => {
    const { host, store, commandBus } = await setup()
    const original = store.getObject('other')!
    const reference = { interactiveEvent: [{ actionList: [{ observationTargetUuid: 'deep' }] }] }
    store.upsertObject({ ...original, metadata: reference })
    await expect(deleteEditorSceneSubtrees(host, ['parent'])).rejects.toThrow('仍引用')
    expect(commandBus.getUndoSize()).toBe(0)
    store.upsertObject(original)
    const parent = store.getObject('parent')!
    store.upsertObject({ ...parent, metadata: reference })
    expect(await deleteEditorSceneSubtrees(host, ['parent'])).toBe(true)
    expect(commandBus.undo()).toBe(true)
    expect(store.getObject('parent')?.metadata).toEqual(reference)
  })

  it('运行端拒绝删除快照后恢复整批数据、选择及删除标记', async () => {
    const { host, store, commandBus } = await setup()
    store.setSelectedObjectId('leaf')
    await host.getBridge().flush()
    const runtimeLoad = vi.spyOn(host.getRuntime(), 'loadScene').mockRejectedValueOnce(new Error('Unity拒绝草稿'))
    await expect(deleteEditorSceneSubtrees(host, ['parent', 'other'])).rejects.toThrow('Unity拒绝草稿')
    expect(runtimeLoad).toHaveBeenCalledTimes(2)
    expect(store.getObjects()).toHaveLength(4)
    expect(store.getSelectedObjectId()).toBe('leaf')
    expect(store.getScene().streaming?.chunks[0]?.objectIds).toEqual(['leaf', 'other'])
    expect(store.getDeletedObjectIds().size).toBe(0)
    expect(commandBus.getUndoSize()).toBe(0)
  })

  it('原档未接管实例的扩展仍引用子树时阻止删除', async () => {
    const { host, store, commandBus } = await setup()
    const original = serializeSceneDefinitionToFourPackages(store.getScene())
    const threeD = JSON.parse(original.threeDJson)
    threeD.components.push({
      instanceId: 'unloaded', contentJson: JSON.stringify({ vendor: { observationTargetUuid: 'deep' } }),
    })
    retainOriginalScenePackages(id, { ...original, threeDJson: JSON.stringify(threeD) })
    await expect(deleteEditorSceneSubtrees(host, ['parent'])).rejects.toThrow('原始三维实例扩展仍引用')
    expect(store.getObjects()).toHaveLength(4)
    expect(commandBus.getUndoSize()).toBe(0)
  })

  it('四包保全仅移除显式删除项，保留未加载记录、共享资源和扩展字段', async () => {
    const { host, store, commandBus } = await setup()
    const original = serializeSceneDefinitionToFourPackages(store.getScene())
    const threeD = JSON.parse(original.threeDJson)
    threeD.components.push({ instanceId: 'unloaded', unknown: 7 })
    threeD.streaming = { extension: '保留', chunks: [{ id: 'mixed', objectIds: ['leaf', 'unloaded'] }] }
    const before = JSON.parse(original.dependenciesJson)
    const owner = (instanceId: string) => ({ domain: 'threeD', ownerType: 'instance', instanceId })
    before.resources = [
      { resourceKey: 'shared', owners: [owner('parent'), owner('unloaded')], extension: 9 },
      { resourceKey: 'exclusive', owners: [owner('leaf')] },
    ]
    before.dataBindings = [{ owner: owner('deep') }, { owner: owner('unloaded') }]
    retainOriginalScenePackages(id, { ...original, threeDJson: JSON.stringify(threeD), dependenciesJson: JSON.stringify(before) })
    expect(await deleteEditorSceneSubtrees(host, ['parent'])).toBe(true)
    const saveAll = vi.fn(async (_body: SceneFourPackagePayload) => ({ code: 200, data: { sceneId: id, conflict: false } }))
    const saved = async () => {
      await saveEditorSceneDefinition({
        saveContext: { sceneId: id, lockToken: 'test-lock' },
        dim3dSaveOptions: { saveAll },
      })
      return saveAll.mock.lastCall![0]
    }
    const after = await saved()
    expect(JSON.parse(after.threeDJson)).toMatchObject({
      components: [{ instanceId: 'other' }, { instanceId: 'unloaded', unknown: 7 }],
      streaming: { extension: '保留', chunks: [{ id: 'mixed', objectIds: ['unloaded'] }] },
    })
    expect(JSON.parse(after.dependenciesJson)).toMatchObject({
      resources: [{ resourceKey: 'shared', owners: [owner('unloaded')], extension: 9 }],
      dataBindings: [{ owner: owner('unloaded') }],
    })
    expect(commandBus.undo()).toBe(true)
    expect(JSON.parse((await saved()).threeDJson).components).toHaveLength(5)
  })
})
