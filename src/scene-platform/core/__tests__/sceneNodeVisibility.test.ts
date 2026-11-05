import { describe, expect, it, vi } from 'vitest'
import { createSceneDefinition } from '../sceneDefinition'
import type { SceneObject, SceneLayer } from '../types'
import { buildSceneNodeIndex } from '../sceneNodeIndex'
import { createSceneNodeVisibilityCache } from '../sceneNodeVisibility'
import { createSceneStore } from '../../store/sceneStore'
import { createCommandBus } from '../../store/commandBus'
import { createUpdateObjectVisibilityCommand } from '../../commands/updateObjectVisibilityCommand'
import { createRuntimeBridge } from '../../runtime/runtimeBridge'
import { MemorySceneRuntime } from '../../runtime/memory/memorySceneRuntime'
import { resolveEditorSceneObjectEffectiveState } from '@/integrations/scene/editorSceneLayerAdapter'
import { serializeSceneDefinitionToFourPackages } from '@/integrations/scene/sceneFourPackage'

const node = (id: string, parentInstanceId?: string, visible = true, layerId?: string): SceneObject => ({
  id, name: id, parentInstanceId, visible, layerId, locked: false, type: 'group', order: 0,
  transform: { kind: 'local', position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 },
})
const layer = (id: string, visible = true): SceneLayer => ({ id, name: id, type: 'object', visible, locked: false, order: 0 })
const scene = (objects = [node('r'), node('a', 'r'), node('b', 'r', false), node('other')], layers: SceneLayer[] = []) =>
  createSceneDefinition({ id: '显隐场景', name: '显隐场景', type: 'local3d', objects, layers,
    coordinateSystem: { kind: 'local', unit: 'meter', upAxis: 'Y', gridEnabled: true } })

describe('节点自身和有效显隐', () => {
  it('父隐藏不覆盖子自身值，父恢复保留子隐藏意图与保存字段', () => {
    const store = createSceneStore(scene())
    const beforeChild = store.getObject('a')
    store.upsertObject({ ...store.getObject('r')!, visible: false })
    expect(store.getObjectVisibilityState('a')).toEqual({ ownVisible: true, inheritedVisible: false, effectiveVisible: false })
    expect(store.getObject('a')).toBe(beforeChild)
    const saved = JSON.parse(serializeSceneDefinitionToFourPackages(store.getScene()).threeDJson)
    expect(saved.components.find((entry: { instanceId: string }) => entry.instanceId === 'a').visible).toBe(true)
    expect(store.captureSaveEdits().objects.has('a')).toBe(false)
    store.upsertObject({ ...store.getObject('r')!, visible: true })
    expect(store.getObjectVisibilityState('a')?.effectiveVisible).toBe(true)
    expect(store.getObjectVisibilityState('b')?.effectiveVisible).toBe(false)
  })

  it('父隐藏期间修改子意图，恢复后读取最新意图；面板读取同一派生结果', () => {
    const store = createSceneStore(scene())
    store.upsertObject({ ...store.getObject('r')!, visible: false })
    store.upsertObject({ ...store.getObject('a')!, visible: false })
    store.upsertObject({ ...store.getObject('b')!, visible: true })
    expect(resolveEditorSceneObjectEffectiveState(store, 'b')).toMatchObject({ ownVisible: true, inheritedVisible: false, effectiveVisible: false })
    store.upsertObject({ ...store.getObject('r')!, visible: true })
    expect(store.getObjectVisibilityState('a')?.effectiveVisible).toBe(false)
    expect(store.getObjectVisibilityState('b')?.effectiveVisible).toBe(true)
  })

  it('父级图层和子自身图层分别生效，成员索引随移组、删除与恢复更新', () => {
    const store = createSceneStore(scene([node('r', undefined, true, 'x'), node('a', 'r', true, 'y')], [layer('x'), layer('y')]))
    expect(store.getObjectVisibilityState('a')?.effectiveVisible).toBe(true)
    store.upsertLayer(layer('x', false))
    expect(store.getObjectVisibilityState('a')?.effectiveVisible).toBe(false)
    store.upsertLayer(layer('x'))
    store.upsertLayer(layer('y', false))
    expect(store.getObjectVisibilityState('a')?.effectiveVisible).toBe(false)
    store.upsertObject({ ...store.getObject('a')!, layerId: 'x' })
    expect(store.getObjectIdsInLayer('y').size).toBe(0)
    expect(store.getObjectIdsInLayer('x')).toEqual(new Set(['r', 'a']))
    expect(store.getObjectVisibilityState('a')?.effectiveVisible).toBe(true)
    const removed = store.removeObjectBatch(new Set(['r', 'a']))
    expect(store.getObjectIdsInLayer('x').size).toBe(0)
    store.restoreObjectBatch(removed, undefined)
    expect(store.getObjectIdsInLayer('x')).toEqual(new Set(['r', 'a']))
  })

  it('缓存只影响相应子树，普通属性和变换保持派生记录', () => {
    const store = createSceneStore(scene())
    const unrelated = store.getObjectVisibilityState('other')
    const child = store.getObjectVisibilityState('a')
    store.upsertObject({ ...store.getObject('a')!, name: '改名', transform: { kind: 'local', position: [1, 0, 0], rotation: [0, 0, 0], scale: 1 } })
    expect(store.getObjectVisibilityState('a')).toBe(child)
    store.upsertObject({ ...store.getObject('r')!, visible: false })
    expect(store.getObjectVisibilityState('a')).not.toBe(child)
    expect(store.getObjectVisibilityState('other')).toBe(unrelated)
  })

  it('两万节点深链不递归，重复读取不重新访问父链状态', () => {
    let reads = 0
    const nodes = Array.from({ length: 20000 }, (_, i) => ({ ...node(String(i), i ? String(i - 1) : undefined),
      get visible() { reads++; return i !== 0 } }))
    const index = { ...buildSceneNodeIndex(nodes), structureVersion: 1 }
    const cache = createSceneNodeVisibilityCache(() => index, () => [])
    expect(cache.get('19999')?.effectiveVisible).toBe(false)
    const counted = reads
    expect(cache.get('19999')?.effectiveVisible).toBe(false)
    expect(reads).toBe(counted)
    expect(counted).toBeLessThanOrEqual(nodes.length * 2)
  })

  it('换父级、删除图层、事务回滚及同编号重载重新计算正确状态', () => {
    const store = createSceneStore(scene([node('r', undefined, false), node('a', 'r'), node('s', undefined, true, 'x')], [layer('x', false)]))
    store.getObjectVisibilityState('a')
    const a = store.getObject('a')!
    store.applyObjectHierarchy([{ id: 'a', parentInstanceId: 's', order: 0, transform: a.transform }])
    expect(store.getObjectVisibilityState('a')?.effectiveVisible).toBe(false)
    store.removeLayer('x')
    expect(store.getObjectVisibilityState('a')?.effectiveVisible).toBe(true)
    expect(() => store.runTransaction(() => {
      store.upsertObject({ ...store.getObject('s')!, visible: false })
      expect(store.getObjectVisibilityState('a')?.effectiveVisible).toBe(false)
      throw new Error('回滚')
    })).toThrow('回滚')
    expect(store.getObjectVisibilityState('a')?.effectiveVisible).toBe(true)
    store.loadScene(scene([node('a', undefined, false)]))
    expect(store.getObjectVisibilityState('a')).toEqual({ ownVisible: false, inheritedVisible: true, effectiveVisible: false })
    expect(store.getObjectVisibilityState('r')).toBeNull()
  })

  it('显隐回放只恢复自身字段，保留之后到达的其他属性', () => {
    const store = createSceneStore(scene())
    const bus = createCommandBus(store)
    bus.execute(createUpdateObjectVisibilityCommand('r', false))
    store.upsertObject({ ...store.getObject('r')!, name: '外部更新' })
    bus.undo()
    expect(store.getObject('r')).toMatchObject({ visible: true, name: '外部更新' })
    expect(store.getObjectVisibilityState('a')?.effectiveVisible).toBe(true)
    bus.redo()
    expect(store.getObjectVisibilityState('a')?.effectiveVisible).toBe(false)
    const pending = bus.beginConfirmed('execute', createUpdateObjectVisibilityCommand('r', true))!
    expect(store.getObjectVisibilityState('a')?.effectiveVisible).toBe(true)
    pending.restore(); pending.finishRollback()
    expect(store.getObjectVisibilityState('a')?.effectiveVisible).toBe(false)
  })

  it('同编号插入替换、删除重建及重载同步清理成员和派生状态', () => {
    const store = createSceneStore(scene([node('r', undefined, false), node('a', 'r', true, 'x')], [layer('x'), layer('y')]))
    expect(store.getObjectVisibilityState('a')?.effectiveVisible).toBe(false)
    store.insertObjectAt(node('a', undefined, true, 'y'), 0)
    expect(store.getObjectIdsInLayer('x').size).toBe(0)
    expect(store.getObjectIdsInLayer('y')).toEqual(new Set(['a']))
    expect(store.getObjectVisibilityState('a')?.effectiveVisible).toBe(true)
    store.removeObject('a')
    expect(store.getObjectVisibilityState('a')).toBeNull()
    expect(store.getObjectIdsInLayer('y').size).toBe(0)
    store.upsertObject(node('a', undefined, false, 'x'))
    expect(store.getObjectVisibilityState('a')?.effectiveVisible).toBe(false)
    store.loadScene(scene([node('a')]))
    expect(store.getObjectIdsInLayer('x').size).toBe(0)
    expect(store.getObjectVisibilityState('a')?.effectiveVisible).toBe(true)
  })

  it('切换图层和刷新缓存不重复扫描所有节点或图层', () => {
    const nodes = [node('r', undefined, true, 'x'), node('a', 'r')]
    const index = { ...buildSceneNodeIndex(nodes), structureVersion: 1 }
    const values = vi.spyOn(index.nodesById, 'values')
    const readLayers = vi.fn(() => [layer('x')])
    const cache = createSceneNodeVisibilityCache(() => index, readLayers)
    expect(cache.get('a')?.effectiveVisible).toBe(true)
    cache.upsertLayer(layer('x'), layer('x', false))
    expect(cache.get('a')?.effectiveVisible).toBe(false)
    cache.upsertLayer(layer('x', false), layer('x'))
    expect(cache.get('a')?.effectiveVisible).toBe(true)
    expect(cache.getMembers('x')).toEqual(new Set(['r']))
    expect(values).toHaveBeenCalledTimes(1)
    expect(readLayers).toHaveBeenCalledTimes(1)
  })
})

describe('有效显隐运行投影', () => {
  const setup = async () => {
    const store = createSceneStore(scene([node('r', undefined, true, 'x'), node('a', 'r'), node('b', 'r', false), node('other')], [layer('x')]))
    const runtime = new MemorySceneRuntime('local3d')
    const bridge = createRuntimeBridge(store, runtime)
    bridge.start(); await bridge.flush()
    return { store, runtime, bridge }
  }

  it('父隐藏和恢复同步子树但不重载或触碰无关节点', async () => {
    const { store, runtime, bridge } = await setup()
    const upsert = vi.spyOn(runtime, 'upsertObject')
    const load = vi.spyOn(runtime, 'loadScene')
    const bus = createCommandBus(store)
    bus.execute(createUpdateObjectVisibilityCommand('r', false))
    await bridge.flush()
    expect(upsert.mock.calls.map(([object]) => object.id).sort()).toEqual(['a', 'b', 'r'])
    expect(upsert.mock.calls.every(([object]) => !object.visible)).toBe(true)
    expect(load).not.toHaveBeenCalled()
    upsert.mockClear()
    bus.undo(); await bridge.flush()
    expect(upsert.mock.calls.find(([object]) => object.id === 'a')?.[0].visible).toBe(true)
    expect(upsert.mock.calls.find(([object]) => object.id === 'b')?.[0].visible).toBe(false)
    expect(store.getObject('a')?.visible).toBe(true)
    bridge.stop()
  })

  it('普通改名只同步自身，同批父子显隐只提交一次最终结果', async () => {
    const { store, runtime, bridge } = await setup()
    const upsert = vi.spyOn(runtime, 'upsertObject')
    store.upsertObject({ ...store.getObject('r')!, name: '改名' }); await bridge.flush()
    expect(upsert.mock.calls.map(([object]) => object.id)).toEqual(['r'])
    upsert.mockClear()
    store.runTransaction(() => {
      store.upsertObject({ ...store.getObject('r')!, visible: false })
      store.upsertObject({ ...store.getObject('a')!, visible: false })
      store.upsertObject({ ...store.getObject('r')!, visible: true })
    })
    await bridge.flush()
    const calls = upsert.mock.calls.map(([object]) => [object.id, object.visible])
    expect(calls).toHaveLength(3)
    expect(calls).toContainEqual(['r', true])
    expect(calls).toContainEqual(['a', false])
    expect(calls).toContainEqual(['b', false])
    bridge.stop()
  })

  it('图层显隐跨子树传播，删除图层恢复；临时驻留意图不修改业务显隐', async () => {
    const { store, runtime, bridge } = await setup()
    const upsert = vi.spyOn(runtime, 'upsertObject')
    store.upsertLayer(layer('x', false)); await bridge.flush()
    expect(upsert.mock.calls.find(([object]) => object.id === 'a')?.[0].visible).toBe(false)
    upsert.mockClear()
    store.removeLayer('x'); await bridge.flush()
    expect(upsert.mock.calls.find(([object]) => object.id === 'a')?.[0].visible).toBe(true)
    upsert.mockClear()
    const before = structuredClone(store.getScene())
    bridge.setObjectStreamingInteraction('a', { kind: 'editing', active: false })
    await bridge.flush()
    expect(store.getScene()).toEqual(before)
    expect(upsert).not.toHaveBeenCalled()
    bridge.stop()
  })

  it('完整运行快照解析器的临时父显隐不回写原草稿', async () => {
    const store = createSceneStore(scene())
    const runtime = new MemorySceneRuntime('local3d')
    const load = vi.spyOn(runtime, 'loadScene')
    const bridge = createRuntimeBridge(store, runtime, (source) => ({ ...source,
      objects: source.objects.map((object) => object.id === 'r' ? { ...object, visible: false } : object) }))
    bridge.start(); await bridge.flush()
    expect(load.mock.lastCall?.[0].objects.find((object) => object.id === 'a')?.visible).toBe(false)
    expect(store.getObject('r')?.visible).toBe(true)
    bridge.stop()
  })

  it('运行端部分显隐失败后反向补偿并完整重同步恢复自身意图', async () => {
    const { store, runtime, bridge } = await setup()
    const bus = createCommandBus(store)
    const load = vi.spyOn(runtime, 'loadScene')
    vi.spyOn(runtime, 'upsertObject').mockRejectedValueOnce(new Error('拒绝显隐'))
    const transaction = bus.beginConfirmed('execute', createUpdateObjectVisibilityCommand('r', false))!
    await expect(bridge.flush()).rejects.toThrow('拒绝显隐')
    transaction.restore()
    await bridge.resync()
    transaction.finishRollback()
    expect(store.getObject('a')?.visible).toBe(true)
    expect(store.getObjectVisibilityState('a')?.effectiveVisible).toBe(true)
    expect(store.getObjectVisibilityState('b')?.effectiveVisible).toBe(false)
    expect(load.mock.lastCall?.[0].objects.find((object) => object.id === 'a')?.visible).toBe(true)
    expect(load.mock.lastCall?.[0].objects.find((object) => object.id === 'b')?.visible).toBe(false)
    expect(bus.getUndoSize()).toBe(0)
    bridge.stop()
  })
})
