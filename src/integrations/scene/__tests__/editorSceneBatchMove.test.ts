import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createSceneDefinition, createViewportHost, MemorySceneRuntime, type SceneObject, type ViewportHost } from '@/scene-platform'
import { createMoveSceneNodesCommand } from '@/scene-platform/commands/moveSceneNodeCommand'
import { clearActiveSceneViewportHost, setActiveSceneViewportHost } from '../editorScenePlatformHost'
import { runConfirmedEditorCommand } from '../editorSceneCommandTransaction'
import { dispatchEditorHistory } from '../editorSceneUndoRedoAdapter'
import { saveEditorSceneDefinition } from '../editorSceneSaveAdapter'
import { assembleSceneDefinitionFromRuntimeFragments } from '../sceneRuntimeFragmentAssembler'
import { serializeSceneDefinitionToFourPackages, type SceneFourPackagePayload } from '../sceneFourPackage'
import { releaseOriginalScenePackages, retainOriginalScenePackages } from '../twoDPackagePreservation'

const sceneId = '8147'
const node = (id: string, x: number, order: number, parentInstanceId?: string, layerId?: string): SceneObject => ({
  id, name: id, order, parentInstanceId, layerId, type: 'group', locked: false, visible: true,
  transform: { kind: 'local', position: [x, 0, 0], rotation: [0, 0, 0], scale: 1 },
})
let active: ViewportHost | undefined
async function setup() {
  setActivePinia(createPinia())
  const scene = createSceneDefinition({
    id: sceneId, name: '批量换父级检查', type: 'local3d',
    coordinateSystem: { kind: 'local', unit: 'meter', upAxis: 'Y', gridEnabled: true },
    layers: ['a', 'b'].map((id, order) => ({ id, name: id, type: 'object', order, visible: true, locked: false })),
    objects: [
      node('source', 10, 0), node('target', 100, 1),
      node('first', 2, 0, 'source', 'a'), node('first-peer', 3, 1, 'source', 'a'),
      node('child', 7, 0, 'first', 'a'),
      node('second', 20, 0, undefined, 'b'),
      node('target-peer', 4, 0, 'target'),
    ],
  })
  // 按正式保存路径启用 Unity 层级标记，播放器用内存实现替代。
  const host = createViewportHost({
    container: {} as HTMLElement, scene,
    runtimeFactory: () => new MemorySceneRuntime('local3d', 'unity-batch-move-test'),
  })
  active = host
  await host.mount()
  setActiveSceneViewportHost(host)
  const store = host.getStore()
  return {
    host, store, commandBus: host.getCommandBus(), onError: vi.fn(),
    execute: (ids: string[], parent?: string) =>
      runConfirmedEditorCommand(host, 'execute', createMoveSceneNodesCommand(store, ids, parent), () => active === host),
  }
}
afterEach(() => {
  clearActiveSceneViewportHost()
  active?.dispose()
  releaseOriginalScenePackages(sceneId)
  vi.restoreAllMocks()
})

describe('批量换父级', () => {
  it('跨父级按草稿顺序移动，重叠后代保留原父级，一步回放并按正式四包恢复', async () => {
    const options = await setup()
    const { host, store, commandBus } = options
    const original = serializeSceneDefinitionToFourPackages(store.getScene())
    const originalThreeD = JSON.parse(original.threeDJson)
    originalThreeD.components.find((entry: { instanceId: string }) => entry.instanceId === 'first').vendorField = { keep: true }
    retainOriginalScenePackages(sceneId, { ...original, threeDJson: JSON.stringify(originalThreeD) })
    const before = structuredClone(store.getObjects())
    const load = vi.spyOn(host.getRuntime(), 'loadScene')

    expect(await options.execute(['child', 'first', 'second', 'first'], 'target')).toBe(true)
    expect(load).toHaveBeenCalledTimes(1)
    expect(commandBus.getUndoSize()).toBe(1)
    expect(store.getObject('target-peer')?.order).toBe(0)
    // 当前草稿中根级的 second 排在 source 的子节点 first 之前。
    expect(store.getObject('second')).toMatchObject({ parentInstanceId: 'target', order: 1, transform: { position: [-80, 0, 0] } })
    expect(store.getObject('first')).toMatchObject({ parentInstanceId: 'target', order: 2, transform: { position: [-88, 0, 0] } })
    expect(store.getObject('first-peer')?.order).toBe(0)
    expect(store.getObject('child')).toMatchObject({ parentInstanceId: 'first', transform: { position: [7, 0, 0] } })
    const after = structuredClone(store.getObjects())
    expect(await dispatchEditorHistory('undo', options)).toBe(true)
    expect(store.getObjects()).toEqual(before)
    expect(await dispatchEditorHistory('redo', options)).toBe(true)
    expect(store.getObjects()).toEqual(after)

    const saveAll = vi.fn(async (_body: SceneFourPackagePayload) => ({ code: 200, data: { sceneId, conflict: false } }))
    await saveEditorSceneDefinition({ saveContext: { sceneId, lockToken: 'test-lock' }, dim3dSaveOptions: { saveAll } })
    const saved = saveAll.mock.lastCall![0]
    expect(JSON.parse(saved.threeDJson).components.find((entry: { instanceId: string }) => entry.instanceId === 'first'))
      .toMatchObject({ instanceId: 'first', parentInstanceId: 'target', sortNo: 2, vendorField: { keep: true } })
    const reopened = assembleSceneDefinitionFromRuntimeFragments({
      manifest: { fragmentType: 'manifest', fragmentKey: sceneId, contentJson: JSON.stringify(saved) },
      options: { sceneId, sceneType: 'local3d' },
    })
    expect(reopened.objects.find((entry) => entry.id === 'first')).toMatchObject({
      parentInstanceId: 'target', order: 2, transform: { position: [-88, 0, 0] },
    })
    expect(reopened.objects.find((entry) => entry.id === 'child')?.parentInstanceId).toBe('first')
    expect(await options.execute(['first', 'second'])).toBe(true)
    expect(store.getObject('first')).toMatchObject({ parentInstanceId: undefined, layerId: 'a', order: 0, transform: { position: [12, 0, 0] } })
    expect(store.getObject('second')).toMatchObject({ parentInstanceId: undefined, layerId: 'b', order: 0, transform: { position: [20, 0, 0] } })
  })

  it('拒绝目标在任一所选子树内、锁定层和部分节点的剪切，保留完整草稿', async () => {
    const { store, commandBus } = await setup()
    const before = structuredClone(store.getObjects())
    expect(() => createMoveSceneNodesCommand(store, ['second', 'first'], 'child')).toThrow('后代')
    store.upsertLayer({ ...store.getLayer('b')!, locked: true })
    expect(() => createMoveSceneNodesCommand(store, ['first', 'second'], 'target')).toThrow('锁定')
    expect(store.getObjects()).toEqual(before)
    store.upsertLayer({ ...store.getLayer('b')!, locked: false })
    const first = store.getObject('first')!
    const target = store.getObject('target')!
    if (first.transform.kind !== 'local' || target.transform.kind !== 'local') throw new Error('需要本地变换')
    // 排在前面的 second 可表示，后面的 first 会产生剪切。
    store.upsertObject({ ...first, transform: { ...first.transform, rotation: [0, 0, Math.PI / 4] } })
    store.upsertObject({ ...target, transform: { ...target.transform, scale: [2, 1, 1] } })
    const withTransforms = structuredClone(store.getObjects())
    expect(() => createMoveSceneNodesCommand(store, ['first', 'second'], 'target')).toThrow('剪切')
    expect(store.getObjects()).toEqual(withTransforms)
    expect(store.getHierarchyEditedIds().size).toBe(0)
    expect(commandBus.getUndoSize()).toBe(0)
  })

  it('运行端拒绝后恢复父级、顺序、变换及保存标记', async () => {
    const options = await setup()
    const { host, store, commandBus } = options
    expect(await options.execute(['second'], 'target')).toBe(true)
    const before = structuredClone(store.getObjects())
    const marks = new Set(store.getHierarchyEditedIds())
    const load = vi.spyOn(host.getRuntime(), 'loadScene').mockRejectedValueOnce(new Error('Unity拒绝层级'))
    await expect(options.execute(['first', 'second'], 'source')).rejects.toThrow('Unity拒绝层级')
    expect(load).toHaveBeenCalledTimes(2)
    expect(store.getObjects()).toEqual(before)
    expect(store.getHierarchyEditedIds()).toEqual(marks)
    expect(commandBus.getUndoSize()).toBe(1)
    expect(commandBus.getRedoSize()).toBe(0)
  })
})
