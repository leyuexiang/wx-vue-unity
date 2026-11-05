import { describe, expect, it } from 'vitest'
import { createSceneDefinition } from '../sceneDefinition'
import { buildSceneNodeIndex } from '../sceneNodeIndex'
import type { SceneObject } from '../types'
import { createSceneStore } from '../../store/sceneStore'
import { createCommandBus } from '../../store/commandBus'
import { createMoveSceneNodeCommand } from '../../commands/moveSceneNodeCommand'

const node = (id: string, parentInstanceId?: string, order = 0): SceneObject => ({
  id, name: id, type: 'group', parentInstanceId, order, visible: true, locked: false,
  transform: { kind: 'local', position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 },
})
const scene = () => createSceneDefinition({
  id: '节点索引场景', name: '节点索引场景', type: 'local3d',
  coordinateSystem: { kind: 'local', unit: 'meter', upAxis: 'Y', gridEnabled: true },
  objects: [node('r'), node('s', undefined, 1), node('a', 'r'), node('b', 'r', 1), node('c', 's')],
})

/** 比较完整派生语义，不依赖不同维护策略下映射的插入次序。 */
const expectCurrentIndex = (store: ReturnType<typeof createSceneStore>) => {
  const expected = buildSceneNodeIndex(store.getObjects())
  const actual = store.getNodeIndex()
  expect(actual.nodesById).toEqual(expected.nodesById)
  expect(actual.parentById).toEqual(expected.parentById)
  expect(actual.childrenByParent).toEqual(expected.childrenByParent)
  for (const record of store.getObjects()) expect(actual.nodesById.get(record.id)).toBe(record)
}

describe('场景存储的节点索引生命周期', () => {
  it('改名、变换、选择和设置更新保留结构版本与兄弟集合', () => {
    const store = createSceneStore(scene())
    const index = store.getNodeIndex()
    const version = index.structureVersion
    const children = index.childrenByParent.get('r')
    store.upsertObject({ ...store.getObject('a')!, name: '新名称',
      transform: { kind: 'local', position: [3, 0, 0], rotation: [0, 0, 0], scale: 1 } })
    store.setSelectedObjectId('a')
    store.updateSceneSettings({ ...store.getScene().settings })
    expectCurrentIndex(store)
    expect(store.getNodeIndex()).toBe(index)
    expect(index.structureVersion).toBe(version)
    expect(index.childrenByParent.get('r')).toBe(children)
  })

  it('新增、插入和删除的隐式兄弟重编号同步进索引', () => {
    const store = createSceneStore(scene())
    const untouched = store.getNodeIndex().childrenByParent.get('s')
    store.insertObjectAt(node('first', 'r'), 0)
    expectCurrentIndex(store)
    store.removeObject('first')
    expectCurrentIndex(store)
    store.upsertObject(node('last', 'r', 20))
    expectCurrentIndex(store)
    expect(store.getNodeIndex().childrenByParent.get('s')).toBe(untouched)
  })

  it('批量删除和撤销恢复后索引与完整草稿一致', () => {
    const store = createSceneStore(scene())
    store.getNodeIndex()
    const removed = store.removeObjectBatch(new Set(['r', 'a', 'b']))
    expectCurrentIndex(store)
    expect(store.getNodeIndex().nodesById.has('r')).toBe(false)
    store.restoreObjectBatch(removed, undefined)
    expectCurrentIndex(store)
  })

  it('换父级、重排和命令回放不重建无关子集', () => {
    const store = createSceneStore(scene())
    const bus = createCommandBus(store)
    const index = store.getNodeIndex()
    const command = createMoveSceneNodeCommand(store, 'a', 's')!
    bus.execute(command)
    expectCurrentIndex(store)
    expect(index.parentById.get('a')).toBe('s')
    bus.undo()
    expectCurrentIndex(store)
    expect(index.parentById.get('a')).toBe('r')
    bus.redo()
    expectCurrentIndex(store)
    bus.execute(createMoveSceneNodeCommand(store, 'a', 's', 0)!)
    expectCurrentIndex(store)
    expect(index.childrenByParent.get('s')).toEqual(['a', 'c'])
    expect(store.getNodeIndex()).toBe(index)
  })

  it.each([false, true])('失败事务读取过临时索引=%s，回滚后只返回恢复记录', (readDuringTransaction) => {
    const store = createSceneStore(scene())
    const old = store.getNodeIndex()
    expect(() => store.runTransaction(() => {
      store.upsertObject({ ...store.getObject('a')!, name: '不能提交' })
      store.removeObject('b')
      if (readDuringTransaction) expect(store.getNodeIndex().nodesById.has('b')).toBe(false)
      throw new Error('注入事务失败')
    })).toThrow('注入事务失败')
    expectCurrentIndex(store)
    expect(store.getNodeIndex()).not.toBe(old)
    expect(store.getNodeIndex().nodesById.get('a')?.name).toBe('a')
    expect(store.getNodeIndex().nodesById.has('b')).toBe(true)
  })

  it('异步确认失败可反向恢复层级并继续使用同一缓存', () => {
    const store = createSceneStore(scene())
    const bus = createCommandBus(store)
    const index = store.getNodeIndex()
    const transaction = bus.beginConfirmed('execute', createMoveSceneNodeCommand(store, 'a', 's'))!
    expectCurrentIndex(store)
    expect(index.parentById.get('a')).toBe('s')
    transaction.restore()
    transaction.finishRollback()
    expectCurrentIndex(store)
    expect(index.parentById.get('a')).toBe('r')
    expect(bus.getUndoSize()).toBe(0)
  })

  it('同编号场景重载替换索引，订阅者第一次读到的就是新场景', () => {
    const store = createSceneStore(scene())
    const old = store.getNodeIndex()
    store.subscribe((event) => {
      if (event.type === 'sceneLoaded') expect(store.getNodeIndex().nodesById.has('a')).toBe(false)
    })
    store.loadScene({ ...scene(), objects: [node('new')] })
    expectCurrentIndex(store)
    expect(store.getNodeIndex()).not.toBe(old)
    expect(store.getNodeIndex().nodesById.has('a')).toBe(false)
  })

  it('事务内先子后父的新增在最终状态一起校验', () => {
    const store = createSceneStore(scene())
    store.getNodeIndex()
    store.runTransaction(() => {
      store.upsertObject(node('child', 'parent'))
      store.upsertObject(node('parent'))
      expectCurrentIndex(store)
    })
    expectCurrentIndex(store)
  })
})
