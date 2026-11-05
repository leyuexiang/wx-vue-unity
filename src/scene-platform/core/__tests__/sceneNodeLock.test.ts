import { describe, expect, it, vi } from 'vitest'
import { createSceneDefinition, parseSceneDefinition } from '../sceneDefinition'
import { buildSceneNodeIndex } from '../sceneNodeIndex'
import { createSceneNodeLockCache } from '../sceneNodeLock'
import type { SceneLayer, SceneObject } from '../types'
import { createSceneStore } from '../../store/sceneStore'
import { createCommandBus } from '../../store/commandBus'
import { createUpdateObjectLockCommand, createUpdateObjectNameCommand, createMoveObjectToLayerCommand, createDeleteObjectLayerCommand } from '../../commands/objectLayerCommands'
import { createUpdateObjectVisibilityCommand } from '../../commands/updateObjectVisibilityCommand'
import { createUpdateObjectTransformCommand } from '../../commands/updateObjectTransformCommand'
import { createUpdateObjectStyleCommand } from '../../commands/updateObjectStyleCommand'
import { createUpdateObjectExtensionsCommand } from '../../commands/updateObjectExtensionsCommand'
import { createDeleteObjectCommand } from '../../commands/deleteObjectCommand'
import { createCreateObjectCommand } from '../../commands/createObjectCommand'
import { createMoveSceneNodeCommand } from '../../commands/moveSceneNodeCommand'
import { createCopySceneSubtreesCommand } from '../../commands/copySceneSubtreesCommand'
import { createDeleteSceneSubtreesCommand } from '../../commands/deleteSceneSubtreesCommand'
import { createRuntimeBridge } from '../../runtime/runtimeBridge'
import { MemorySceneRuntime } from '../../runtime/memory/memorySceneRuntime'
import { resolveEditorSceneObjectEffectiveState, setEditorSceneObjectLocked } from '@/integrations/scene/editorSceneLayerAdapter'
import { serializeSceneDefinitionToFourPackages } from '@/integrations/scene/sceneFourPackage'
import { assembleSceneDefinitionFromRuntimeFragments } from '@/integrations/scene/sceneRuntimeFragmentAssembler'

const node = (id: string, parentInstanceId?: string, locked = false, layerId?: string): SceneObject => ({
  id, name: id, parentInstanceId, layerId, locked, visible: true, type: 'group', order: 0,
  metadata: { pickable: true }, transform: { kind: 'local', position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 },
})
const layer = (id: string, locked = false): SceneLayer => ({ id, name: id, locked, visible: true, type: 'object', order: 0 })
const scene = (objects = [node('r'), node('a', 'r'), node('own', 'r', true), node('other')], layers = [layer('free')]) =>
  createSceneDefinition({ id: '节点锁定', name: '节点锁定', type: 'local3d', objects, layers,
    coordinateSystem: { kind: 'local', unit: 'meter', upAxis: 'Y', gridEnabled: true } })

describe('节点自身及继承锁定', () => {
  it.each([true, false])('显式锁定%s与可拾取独立保存、解析，缺失锁定才执行旧档推导', (locked) => {
    const explicit = node('n', undefined, locked)
    explicit.metadata = { pickable: locked }
    const normalized = scene([explicit])
    expect(normalized.objects[0]?.locked).toBe(locked)
    expect(parseSceneDefinition(JSON.stringify(normalized)).objects[0]).toMatchObject({ locked, metadata: { pickable: locked } })
    const raw = JSON.parse(JSON.stringify(normalized))
    delete raw.objects[0].locked
    raw.objects[0].metadata = { pickup: locked }
    expect(parseSceneDefinition(JSON.stringify(raw)).objects[0]).toMatchObject({ locked: !locked, metadata: { pickable: locked } })
    expect(parseSceneDefinition(JSON.stringify(raw)).objects[0]?.metadata).not.toHaveProperty('pickup')
    const packages = serializeSceneDefinitionToFourPackages(normalized)
    const reopen = (body: typeof packages) => assembleSceneDefinitionFromRuntimeFragments({
      manifest: { fragmentType: 'manifest', fragmentKey: normalized.id, contentJson: JSON.stringify(body) },
      options: { sceneId: normalized.id, sceneType: 'local3d' },
    })
    expect(reopen(packages).objects[0]).toMatchObject({ locked, metadata: { pickable: locked } })
    const oldThreeD = JSON.parse(packages.threeDJson)
    delete oldThreeD.components[0].locked
    expect(reopen({ ...packages, threeDJson: JSON.stringify(oldThreeD) }).objects[0]?.locked).toBe(!locked)
  })

  it('父锁定保留子自身锁定、拾取配置和保存字段，解锁恢复原意图', () => {
    const store = createSceneStore(scene())
    const child = store.getObject('a')
    store.upsertObject({ ...store.getObject('r')!, locked: true })
    expect(store.getObjectLockState('a')).toEqual({ ownLocked: false, inheritedLocked: true, effectiveLocked: true })
    expect(store.isObjectEffectivelyLocked('a')).toBe(true)
    expect(store.getObject('a')).toBe(child)
    expect(store.getObject('a')?.metadata?.pickable).toBe(true)
    expect(resolveEditorSceneObjectEffectiveState(store, 'a')).toMatchObject({ ownLocked: false, inheritedLocked: true, effectiveLocked: true })
    const saved = JSON.parse(serializeSceneDefinitionToFourPackages(store.getScene()).threeDJson)
    expect(saved.components.find((entry: { instanceId: string }) => entry.instanceId === 'a').locked).toBe(false)
    expect(store.captureSaveEdits().objects.has('a')).toBe(false)
    store.upsertObject({ ...store.getObject('r')!, locked: false })
    expect(store.isObjectEffectivelyLocked('a')).toBe(false)
    expect(store.isObjectEffectivelyLocked('own')).toBe(true)
  })

  it('父级和自身图层独立继承，图层删除、移组和同编号重载更新派生结果', () => {
    const store = createSceneStore(scene([node('r', undefined, false, 'x'), node('a', 'r', false, 'y')], [layer('x'), layer('y')]))
    expect(store.isObjectEffectivelyLocked('a')).toBe(false)
    store.upsertLayer(layer('x', true)); expect(store.isObjectEffectivelyLocked('a')).toBe(true)
    store.upsertLayer(layer('x')); store.upsertLayer(layer('y', true))
    expect(store.isObjectEffectivelyLocked('a')).toBe(true)
    store.upsertObject({ ...store.getObject('a')!, layerId: 'x' })
    expect(store.isObjectEffectivelyLocked('a')).toBe(false)
    store.upsertLayer(layer('x', true)); store.removeLayer('x')
    expect(store.isObjectEffectivelyLocked('a')).toBe(false)
    const removed = store.removeObjectBatch(new Set(['r', 'a']))
    expect(store.getObjectLockState('a')).toBeNull()
    store.restoreObjectBatch(removed, undefined)
    expect(store.isObjectEffectivelyLocked('a')).toBe(false)
    store.loadScene(scene([node('a', undefined, true)]))
    expect(store.getObjectLockState('a')).toEqual({ ownLocked: true, inheritedLocked: false, effectiveLocked: true })
  })

  it('锁定缓存和显隐、变换缓存分别失效，无关节点与普通编辑复用派生结果', () => {
    const store = createSceneStore(scene())
    const own = store.getObjectLockState('a')
    const other = store.getObjectLockState('other')
    const visibility = store.getObjectVisibilityState('a')
    const matrix = store.getObjectWorldMatrix('a')
    store.upsertObject({ ...store.getObject('a')!, name: '改名', visible: false })
    expect(store.getObjectLockState('a')).toBe(own)
    store.upsertObject({ ...store.getObject('a')!, visible: true })
    const latestVisibility = store.getObjectVisibilityState('a')
    store.upsertObject({ ...store.getObject('r')!, locked: true })
    expect(store.getObjectLockState('a')).not.toBe(own)
    expect(store.getObjectLockState('other')).toBe(other)
    expect(store.getObjectVisibilityState('a')).toBe(latestVisibility)
    expect(store.getObjectWorldMatrix('a')).toBe(matrix)
    expect(visibility?.effectiveVisible).toBe(true)
  })

  it('两万节点深链迭代查询，重复查询不再读取父链或扫描图层', () => {
    let reads = 0
    const nodes = Array.from({ length: 20000 }, (_, i) => ({ ...node(String(i), i ? String(i - 1) : undefined),
      get locked() { reads++; return i === 0 } }))
    const index = { ...buildSceneNodeIndex(nodes), structureVersion: 1 }
    const readLayers = vi.fn(() => [] as SceneLayer[])
    const cache = createSceneNodeLockCache(() => index, readLayers, () => new Set())
    expect(cache.get('19999')?.effectiveLocked).toBe(true)
    const first = reads
    expect(cache.get('19999')?.effectiveLocked).toBe(true)
    expect(reads).toBe(first)
    expect(first).toBeLessThanOrEqual(nodes.length * 2)
    expect(readLayers).toHaveBeenCalledTimes(1)
  })

  it('同步事务内读过临时锁定后回滚恢复原状态', () => {
    const store = createSceneStore(scene())
    store.getObjectLockState('a')
    expect(() => store.runTransaction(() => {
      store.upsertObject({ ...store.getObject('r')!, locked: true })
      expect(store.isObjectEffectivelyLocked('a')).toBe(true)
      throw new Error('回滚')
    })).toThrow('回滚')
    expect(store.isObjectEffectivelyLocked('a')).toBe(false)
  })

  it('自身锁定可解锁，继承锁定不能通过修改自身锁定绕过；撤销只恢复锁定字段', () => {
    const store = createSceneStore(scene())
    const bus = createCommandBus(store)
    bus.execute(createUpdateObjectLockCommand('r', true))
    expect(() => bus.execute(createUpdateObjectLockCommand('a', false))).toThrow('锁定')
    expect(setEditorSceneObjectLocked({ store, commandBus: bus, objectId: 'a', locked: true })).toEqual({ status: 'skipped', reason: 'locked-object' })
    store.upsertObject({ ...store.getObject('r')!, name: '后来更新' })
    bus.undo()
    expect(store.getObject('r')).toMatchObject({ name: '后来更新', locked: false })
    bus.execute(createUpdateObjectLockCommand('own', false))
    expect(store.isObjectEffectivelyLocked('own')).toBe(false)
  })
})

describe('继承锁定的编辑入口', () => {
  const attempts = [
    ['名称', () => createUpdateObjectNameCommand('a', '新名称')],
    ['变换', () => createUpdateObjectTransformCommand('a', { kind: 'local', position: [2, 0, 0], rotation: [0, 0, 0], scale: 1 })],
    ['样式', () => createUpdateObjectStyleCommand('a', { opacity: 0.5 })],
    ['配置', () => createUpdateObjectExtensionsCommand('a', { metadata: { pickable: false } })],
    ['显隐', () => createUpdateObjectVisibilityCommand('a', false)],
    ['移组', () => createMoveObjectToLayerCommand('a', 'free')],
    ['删除', () => createDeleteObjectCommand('a')],
    ['批量删除', () => createDeleteSceneSubtreesCommand(['a'], () => undefined)],
    ['复制', () => createCopySceneSubtreesCommand(['a'], () => 'copy', () => undefined)],
    ['覆盖创建', () => createCreateObjectCommand(node('a'))],
    ['父下创建', () => createCreateObjectCommand(node('new', 'r'))],
  ] as const
  it.each(attempts)('%s不可绕过父锁定，拒绝后草稿和历史不变', (_name, prepare) => {
    const store = createSceneStore(scene())
    const bus = createCommandBus(store)
    store.upsertObject({ ...store.getObject('r')!, locked: true })
    const before = structuredClone(store.getScene())
    expect(() => bus.execute(prepare())).toThrow(/锁定|Locked/)
    expect(store.getScene()).toEqual(before)
    expect(bus.getUndoSize()).toBe(0)
  })

  it.each(['r', 'other'])('准备换父级后%s被锁定，执行时再次拒绝', (id) => {
    const store = createSceneStore(scene())
    const bus = createCommandBus(store)
    const command = createMoveSceneNodeCommand(store, 'a', 'other')!
    store.upsertObject({ ...store.getObject(id)!, locked: true })
    const before = structuredClone(store.getScene())
    expect(() => bus.execute(command)).toThrow('锁定')
    expect(store.getScene()).toEqual(before)
  })

  it('复制重做复核源节点和目标父级的最新锁定状态', () => {
    const store = createSceneStore(scene())
    const bus = createCommandBus(store)
    bus.execute(createCopySceneSubtreesCommand(['a'], () => 'copy', () => undefined))
    bus.undo()
    store.upsertObject({ ...store.getObject('r')!, locked: true })
    expect(() => bus.redo()).toThrow('锁定')
    expect(store.getObject('copy')).toBeNull()
    expect(bus.getRedoSize()).toBe(1)
    store.upsertObject({ ...store.getObject('r')!, locked: false })
    bus.redo()
    expect(store.getObject('copy')?.parentInstanceId).toBe('r')
  })

  it('锁定目标图层内不能新增节点', () => {
    const store = createSceneStore(scene([], [layer('locked', true)]))
    expect(() => createCommandBus(store).execute(createCreateObjectCommand(node('new', undefined, false, 'locked')))).toThrow('锁定')
    expect(store.getObjects()).toHaveLength(0)
  })

  it.each(['名称', '变换', '显隐', '创建', '复制', '删除', '批量删除', '移组', '删除图层'] as const)('%s撤销失败时可以在新继承锁定下直接补偿', (kind) => {
    const store = createSceneStore(scene())
    const bus = createCommandBus(store)
    if (kind === '删除图层') store.upsertObject({ ...store.getObject('a')!, layerId: 'free' })
    const command = kind === '名称' ? createUpdateObjectNameCommand('a', '新名称')
      : kind === '变换' ? createUpdateObjectTransformCommand('a', { kind: 'local', position: [4, 0, 0], rotation: [0, 0, 0], scale: 1 })
        : kind === '显隐' ? createUpdateObjectVisibilityCommand('a', false)
          : kind === '创建' ? createCreateObjectCommand(node('new', 'r'))
            : kind === '复制' ? createCopySceneSubtreesCommand(['a'], () => 'copy', () => undefined)
              : kind === '删除' ? createDeleteObjectCommand('a')
                : kind === '批量删除' ? createDeleteSceneSubtreesCommand(['a'], () => undefined)
                  : kind === '删除图层' ? createDeleteObjectLayerCommand('free')
                    : createMoveObjectToLayerCommand('a', 'free', 0)
    bus.execute(command)
    store.upsertObject({ ...store.getObject('r')!, locked: true })
    const before = structuredClone(store.getScene())
    const deleted = new Set(store.getDeletedObjectIds())
    const saveEdits = store.captureSaveEdits()
    const hierarchy = new Set(store.getHierarchyEditedIds())
    const transaction = bus.beginConfirmed('undo')!
    // 模拟运行端拒绝：补偿应恢复本次撤销前状态，不能重新走新编辑门禁。
    transaction.restore(); transaction.finishRollback()
    expect(store.getScene()).toEqual(before)
    expect(bus.getUndoSize()).toBe(1)
    expect(bus.getRedoSize()).toBe(0)
    expect(store.getObject('r')?.locked).toBe(true)
    expect(store.getDeletedObjectIds()).toEqual(deleted)
    expect(store.captureSaveEdits()).toEqual(saveEdits)
    expect(store.getHierarchyEditedIds()).toEqual(hierarchy)
    const expected = buildSceneNodeIndex(store.getObjects())
    expect(store.getNodeIndex().childrenByParent).toEqual(expected.childrenByParent)
    expect(store.getNodeIndex().nodesById).toEqual(expected.nodesById)
  })

  it('复制源移出原父级后，重做仍检查副本原目标父级锁定', () => {
    const store = createSceneStore(scene())
    const bus = createCommandBus(store)
    bus.execute(createCopySceneSubtreesCommand(['a'], () => 'copy', () => undefined))
    bus.undo()
    store.upsertObject({ ...store.getObject('a')!, parentInstanceId: undefined })
    store.upsertObject({ ...store.getObject('r')!, locked: true })
    expect(() => bus.redo()).toThrow('副本目标父级已锁定')
    expect(store.getObject('copy')).toBeNull()
  })
})

describe('有效锁定运行投影与恢复', () => {
  const setup = async () => {
    const store = createSceneStore(scene())
    const runtime = new MemorySceneRuntime('local3d')
    const bridge = createRuntimeBridge(store, runtime)
    bridge.start(); await bridge.flush()
    return { store, runtime, bridge }
  }

  it('父锁定只投影相关子树，解锁恢复自身锁定及独立拾取配置', async () => {
    const { store, runtime, bridge } = await setup()
    const bus = createCommandBus(store)
    const upsert = vi.spyOn(runtime, 'upsertObject')
    const load = vi.spyOn(runtime, 'loadScene')
    bus.execute(createUpdateObjectLockCommand('r', true)); await bridge.flush()
    expect(upsert.mock.calls.map(([object]) => object.id).sort()).toEqual(['a', 'own', 'r'])
    expect(upsert.mock.calls.every(([object]) => object.locked && object.metadata?.pickable === false)).toBe(true)
    expect(store.getObject('a')).toMatchObject({ locked: false, metadata: { pickable: true } })
    expect(load).not.toHaveBeenCalled()
    upsert.mockClear()
    bus.undo(); await bridge.flush()
    expect(upsert.mock.calls.find(([object]) => object.id === 'a')?.[0]).toMatchObject({ locked: false, metadata: { pickable: true } })
    expect(upsert.mock.calls.find(([object]) => object.id === 'own')?.[0].locked).toBe(true)
    store.upsertObject({ ...store.getObject('a')!, metadata: { pickable: false } })
    await bridge.flush(); upsert.mockClear()
    bus.execute(createUpdateObjectLockCommand('r', true)); await bridge.flush()
    bus.undo(); await bridge.flush()
    expect(upsert.mock.calls.filter(([object]) => object.id === 'a').at(-1)?.[0].metadata?.pickable).toBe(false)
    bridge.stop()
  })

  it('图层锁定跨子树生效，删除图层恢复', async () => {
    const { store, runtime, bridge } = await setup()
    store.upsertObject({ ...store.getObject('r')!, layerId: 'free' }); await bridge.flush()
    const upsert = vi.spyOn(runtime, 'upsertObject')
    store.upsertLayer(layer('free', true)); await bridge.flush()
    expect(upsert.mock.calls.find(([object]) => object.id === 'a')?.[0].locked).toBe(true)
    upsert.mockClear()
    store.removeLayer('free'); await bridge.flush()
    expect(upsert.mock.calls.find(([object]) => object.id === 'a')?.[0].locked).toBe(false)
    bridge.stop()
  })

  it('独立临时快照按自身父链锁定，不污染原始配置', async () => {
    const store = createSceneStore(scene())
    const runtime = new MemorySceneRuntime('local3d')
    const load = vi.spyOn(runtime, 'loadScene')
    const bridge = createRuntimeBridge(store, runtime, (source) => ({ ...source,
      objects: source.objects.map((object) => object.id === 'r' ? { ...object, locked: true } : object) }))
    bridge.start(); await bridge.flush()
    expect(load.mock.lastCall?.[0].objects.find((object) => object.id === 'a')).toMatchObject({ locked: true, metadata: { pickable: false } })
    expect(store.getObject('a')).toMatchObject({ locked: false, metadata: { pickable: true } })
    bridge.stop()
  })

  it('部分运行投影失败后补偿重同步，历史和拾取配置恢复', async () => {
    const { store, runtime, bridge } = await setup()
    const bus = createCommandBus(store)
    const load = vi.spyOn(runtime, 'loadScene')
    vi.spyOn(runtime, 'upsertObject').mockRejectedValueOnce(new Error('锁定同步失败'))
    const transaction = bus.beginConfirmed('execute', createUpdateObjectLockCommand('r', true))!
    await expect(bridge.flush()).rejects.toThrow('锁定同步失败')
    transaction.restore(); await bridge.resync(); transaction.finishRollback()
    expect(store.isObjectEffectivelyLocked('a')).toBe(false)
    expect(load.mock.lastCall?.[0].objects.find((object) => object.id === 'a')).toMatchObject({ locked: false, metadata: { pickable: true } })
    expect(bus.getUndoSize()).toBe(0)
    bridge.stop()
  })
})
