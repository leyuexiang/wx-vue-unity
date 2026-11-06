import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createSceneDefinition, createViewportHost, type SceneObject, type ViewportHost } from '@/scene-platform'
import { clearActiveSceneViewportHost, setActiveSceneViewportHost } from '../editorScenePlatformHost'
import { copyEditorSceneSubtrees } from '../editorSceneSubtreeCopy'
import { dispatchEditorHistory } from '../editorSceneUndoRedoAdapter'
import { saveEditorSceneDefinition } from '../editorSceneSaveAdapter'
import { serializeSceneDefinitionToFourPackages, type SceneFourPackagePayload } from '../sceneFourPackage'
import { releaseOriginalScenePackages, retainOriginalScenePackages } from '../twoDPackagePreservation'

const sceneId = '8146'
const node = (id: string, order: number, parentInstanceId?: string): SceneObject => ({
  id, name: id, order, parentInstanceId, type: 'group', locked: false, visible: true,
  transform: { kind: 'local', position: [1, 2, 3], rotation: [0, 0, 0], scale: 1 },
})
const action = {
  actionTargetUuid: 'leaf', observationTargetUuid: 'external',
  sourceModelValue: 'second', targetModelValue: 'parent',
  targets: [{ domain: 'twoD', instanceId: 'leaf' }, { domain: 'threeD', instanceId: 'second' }],
  parameterSource: { kind: 'object', id: 'leaf' },
  unknown: 'opaque-value',
}
let active: ViewportHost | undefined
async function setup(locked = false) {
  setActivePinia(createPinia())
  const scene = createSceneDefinition({
    id: sceneId, name: '子树复制验收', type: 'local3d',
    coordinateSystem: { kind: 'local', unit: 'meter', upAxis: 'Y', gridEnabled: true },
    objects: [
      { ...node('parent', 0), metadata: {
        engineObjectUuid: 'engine', legacyOnlyUuid: 'legacy', unknownExtension: { key: 'opaque-value' },
        interactiveEvent: [{ id: 'action-key', actionList: [action] }],
      } },
      node('second', 2),
      { ...node('leaf', 3, 'parent'), locked, type: 'model',
        asset: { id: 'shared-model', kind: 'model', url: 'https://example.test/model.glb' } },
      node('external', 4),
    ],
    streaming: {
      groups: [],
      chunks: [{ id: 'mixed', sceneId, bounds: { type: 'sphere', center: [0, 0, 0], radius: 10 },
        objectIds: ['leaf', 'external'], assetIds: ['shared-model'] }],
    },
  })
  const host = createViewportHost({ container: {} as HTMLElement, scene })
  active = host
  await host.mount()
  setActiveSceneViewportHost(host)
  return { host, store: host.getStore(), commandBus: host.getCommandBus(), onError: vi.fn() }
}
afterEach(() => {
  clearActiveSceneViewportHost()
  active?.dispose()
  releaseOriginalScenePackages(sceneId)
  vi.restoreAllMocks()
})

describe('三维子树批量复制', () => {
  it('合并重叠选区，保持外部引用并重定向跨子树引用，一步撤销和重做', async () => {
    const options = await setup()
    const { host, store, commandBus } = options
    store.setSelectedObjectId('second')
    const before = structuredClone(store.getObjects())
    const beforeStreaming = structuredClone(store.getScene().streaming)
    await host.getBridge().flush()
    const load = vi.spyOn(host.getRuntime(), 'loadScene')

    expect(await copyEditorSceneSubtrees(host, ['second', 'leaf', 'parent', 'leaf'])).toBe(true)
    expect(load).toHaveBeenCalledTimes(1)
    expect(commandBus.getUndoSize()).toBe(1)
    expect(store.getObjects().slice(0, 4)).toEqual(before)
    const [parent, second, leaf] = store.getObjects().slice(4) as [SceneObject, SceneObject, SceneObject]
    expect(new Set(store.getObjects().map((object) => object.id)).size).toBe(7)
    const lastRootOrder = Math.max(...before.filter((object) => !object.parentInstanceId).map((object) => object.order))
    expect(parent).toMatchObject({ name: 'parent 副本', order: lastRootOrder + 1 })
    expect(second).toMatchObject({ name: 'second 副本', order: lastRootOrder + 2 })
    const sourceLeaf = before.find((object) => object.id === 'leaf')!
    expect(leaf).toMatchObject({ parentInstanceId: parent.id, order: sourceLeaf.order, asset: sourceLeaf.asset })
    expect(parent.metadata).toEqual({
      unknownExtension: { key: 'opaque-value' },
      interactiveEvent: [{ id: 'action-key', actionList: [{
        ...action,
        actionTargetUuid: leaf.id, sourceModelValue: second.id, targetModelValue: parent.id,
        targets: [{ domain: 'twoD', instanceId: 'leaf' }, { domain: 'threeD', instanceId: second.id }],
        parameterSource: { kind: 'object', id: leaf.id },
      }] }],
    })
    expect(store.getSelectedObjectId()).toBe(second.id)
    expect(store.getScene().streaming?.chunks[0]?.objectIds).toEqual(['leaf', 'external', leaf.id])

    expect(await dispatchEditorHistory('undo', options)).toBe(true)
    expect(store.getObjects()).toEqual(before)
    expect(store.getScene().streaming).toEqual(beforeStreaming)
    expect(store.getDeletedObjectIds().size).toBe(0)
    expect(store.getSelectedObjectId()).toBe('second')
    expect(await dispatchEditorHistory('redo', options)).toBe(true)
    expect(store.getObjects().slice(4)).toEqual([parent, second, leaf])
    expect(store.getSelectedObjectId()).toBe(second.id)
  })

  it('锁定后代使整批失败', async () => {
    const { host, store, commandBus } = await setup(true)
    await expect(copyEditorSceneSubtrees(host, ['second', 'parent'])).rejects.toThrow('已锁定')
    expect(store.getObjects()).toHaveLength(4)
    expect(commandBus.getUndoSize()).toBe(0)
  })

  it('为模型实例配置生成新身份，复用资源并保留源配置', async () => {
    const { host, store } = await setup()
    const leaf = store.getObject('leaf')!
    store.upsertObject({ ...leaf, asset: { ...leaf.asset!, id: '1234' }, metadata: {
      instanceDefinition: {
        schemaVersion: 'jtyf.instance-definition.v1',
        identity: { instanceId: 'leaf', instanceType: 'Model', sceneId },
        resource: { resourceId: '1234' },
        pages: { base: { name: 'leaf' }, data: { bindings: [] } },
      },
    } })
    expect(await copyEditorSceneSubtrees(host, ['leaf'])).toBe(true)
    const copied = store.getObject(store.getSelectedObjectId()!)!
    expect(copied.metadata?.instanceDefinition).toMatchObject({ identity: { instanceId: copied.id } })
    expect(store.getObject('leaf')?.metadata?.instanceDefinition).toMatchObject({ identity: { instanceId: 'leaf' } })
    const saved = JSON.parse(serializeSceneDefinitionToFourPackages(store.getScene()).threeDJson)
    expect(saved.objects.find((record: { instanceId: string }) => record.instanceId === copied.id)).toMatchObject({
      resourceRefKeys: ['1234'],
      contentJson: { metadata: { instanceDefinition: { identity: { instanceId: copied.id }, pages: { base: { name: 'leaf 副本' } } } } },
    })
  })

  it.each(['正文私有字段', '结构化依赖', '未声明实例引用'])('整批拒绝无法确认的%s', async (kind) => {
    const { host, store, commandBus } = await setup()
    const original = serializeSceneDefinitionToFourPackages(store.getScene())
    const threeD = JSON.parse(original.threeDJson)
    const dependencies = JSON.parse(original.dependenciesJson)
    if (kind === '正文私有字段') {
      threeD.objects[0].contentJson.vendorPrivate = { target: 'leaf' }
    } else if (kind === '结构化依赖') {
      dependencies.behaviors[0].conditionGroups.push({ vendorAction: { target: 'leaf' } })
    } else {
      const parent = store.getObject('parent')!
      store.upsertObject({ ...parent, metadata: { ...parent.metadata, vendor: { target: 'leaf' } } })
    }
    retainOriginalScenePackages(sceneId, { ...original, threeDJson: JSON.stringify(threeD), dependenciesJson: JSON.stringify(dependencies) })
    const before = structuredClone(store.getScene())
    await expect(copyEditorSceneSubtrees(host, ['parent', 'second'])).rejects.toThrow(/无法完整复制|未声明的实例引用/)
    expect(store.getScene()).toEqual(before)
    expect(commandBus.getUndoSize()).toBe(0)
  })

  it('运行端拒绝时整批恢复，撤销失败时副本及历史位置也保持原样', async () => {
    const options = await setup()
    const { host, store, commandBus } = options
    store.setSelectedObjectId('external')
    const before = structuredClone(store.getScene())
    await host.getBridge().flush()
    const load = vi.spyOn(host.getRuntime(), 'loadScene').mockRejectedValueOnce(new Error('Unity拒绝复制'))
    await expect(copyEditorSceneSubtrees(host, ['parent', 'second'])).rejects.toThrow('Unity拒绝复制')
    expect(load).toHaveBeenCalledTimes(2)
    expect(store.getScene()).toEqual(before)
    expect(store.getSelectedObjectId()).toBe('external')
    expect(commandBus.getUndoSize()).toBe(0)

    expect(await copyEditorSceneSubtrees(host, ['parent'])).toBe(true)
    const copied = structuredClone(store.getScene())
    load.mockRejectedValueOnce(new Error('Unity拒绝撤销'))
    expect(await dispatchEditorHistory('undo', options)).toBe(false)
    expect(store.getScene()).toEqual(copied)
    expect(store.getSelectedObjectId()).toBe(copied.objects[4]?.id)
    expect(commandBus.getUndoSize()).toBe(1)
    expect(commandBus.getRedoSize()).toBe(0)
  })

  it('正式保存包保留原记录和扩展，为副本追加区块、共享资源拥有者及已重定向行为', async () => {
    const { host, store } = await setup()
    const original = serializeSceneDefinitionToFourPackages(store.getScene())
    const threeD = JSON.parse(original.threeDJson)
    threeD.streaming.chunks[0].extension = '保留'
    threeD.streaming.chunks[0].objectIds.push('unloaded')
    retainOriginalScenePackages(sceneId, { ...original, threeDJson: JSON.stringify(threeD) })

    expect(await copyEditorSceneSubtrees(host, ['parent'])).toBe(true)
    const [, , , , parent, leaf] = store.getObjects()
    const saveAll = vi.fn(async (_body: SceneFourPackagePayload) => ({ code: 200, data: { sceneId, conflict: false } }))
    await saveEditorSceneDefinition({
      saveContext: { sceneId, lockToken: 'test-lock' },
      dim3dSaveOptions: { saveAll },
    })
    const body = saveAll.mock.lastCall![0]
    const saved = JSON.parse(body.threeDJson)
    expect(saved.streaming.chunks[0]).toMatchObject({ extension: '保留', objectIds: ['leaf', 'external', 'unloaded', leaf!.id] })
    expect(saved.objects.find((entry: { instanceId: string }) => entry.instanceId === leaf!.id)).toMatchObject({
      parentInstanceId: parent!.id, resourceRefKeys: ['shared-model'],
    })
    const dependencies = JSON.parse(body.dependenciesJson)
    expect(dependencies.resources).toEqual([expect.objectContaining({ resourceKey: 'shared-model', owners: [
      expect.objectContaining({ instanceId: 'leaf' }), expect.objectContaining({ instanceId: leaf!.id }),
    ] })])
    expect(dependencies.behaviors).toEqual([
      expect.objectContaining({ owner: expect.objectContaining({ instanceId: 'parent' }) }),
      expect.objectContaining({
        owner: expect.objectContaining({ instanceId: parent!.id }),
        contentJson: { legacyConfig: expect.objectContaining({ actionList: [expect.objectContaining({ actionTargetUuid: leaf!.id })] }) },
      }),
    ])
  })
})
