import { describe, expect, it } from 'vitest'
import { buildSceneNodeIndex } from '../sceneNodeIndex'
import { createSceneDefinition } from '../sceneDefinition'
import type { LocalTransform, SceneObject } from '../types'
import { createSceneStore } from '../../store/sceneStore'
import { createCommandBus } from '../../store/commandBus'
import { createMoveSceneNodeCommand } from '../../commands/moveSceneNodeCommand'
import { createSceneNodeTransformCache, createSceneRelativeTransform, type SceneNodeMatrix } from '../sceneNodeTransforms'

const local = (position: LocalTransform['position'] = [0, 0, 0],
  rotation: LocalTransform['rotation'] = [0, 0, 0], scale: LocalTransform['scale'] = 1): LocalTransform =>
  ({ kind: 'local', position, rotation, scale })
const node = (id: string, transform = local(), parentInstanceId?: string): SceneObject => ({
  id, name: id, type: 'group', transform, parentInstanceId, order: 0, visible: true, locked: false,
})
const makeStore = (objects: SceneObject[]) => createSceneStore(createSceneDefinition({
  id: '变换查询', name: '变换查询', type: 'local3d', objects,
  coordinateSystem: { kind: 'local', unit: 'meter', upAxis: 'Y', gridEnabled: true },
}))
const expectMatrixClose = (actual: SceneNodeMatrix, expected: SceneNodeMatrix) => {
  for (let column = 0; column < 4; column++) {
    for (let axis = 0; axis < 3; axis++) expect(actual[column]![axis]).toBeCloseTo(expected[column]![axis]!, 8)
  }
}

describe('纯领域节点局部和世界变换', () => {
  it('父旋转和缩放作用到子位置，查询不反写草稿', () => {
    const store = makeStore([
      node('parent', local([10, 0, 0], [0, 0, Math.PI / 2], 2)),
      node('child', local([1, 0, 0]), 'parent'),
    ])
    const before = structuredClone(store.getScene())
    expectMatrixClose(store.getObjectWorldMatrix('child'), [[0, 2, 0], [-2, 0, 0], [0, 0, 2], [10, 2, 0]])
    expectMatrixClose(store.getObjectLocalMatrix('child'), [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 0, 0]])
    expect(store.getScene()).toEqual(before)
    expect(store.getObjectLocalMatrix('child')[3]).not.toBe((store.getObject('child')!.transform as LocalTransform).position)
  })

  it.each([0, 1, 2] as const)('局部欧拉角第%s轴与右手旋转方向一致', (axis) => {
    const rotations: LocalTransform['rotation'] = [0, 0, 0]
    rotations[axis] = Math.PI / 2
    const expected: SceneNodeMatrix[] = [
      [[1, 0, 0], [0, 0, 1], [0, -1, 0], [0, 0, 0]],
      [[0, 0, -1], [0, 1, 0], [1, 0, 0], [0, 0, 0]],
      [[0, 1, 0], [-1, 0, 0], [0, 0, 1], [0, 0, 0]],
    ]
    expectMatrixClose(makeStore([node('n', local([0, 0, 0], rotations))]).getObjectLocalMatrix('n'), expected[axis]!)
  })

  it('两万节点深链迭代计算，第二次查询复用整条父链', () => {
    let reads = 0
    const nodes = Array.from({ length: 20000 }, (_, i) => ({
      ...node(String(i), local([1, 0, 0]), i ? String(i - 1) : undefined),
      get transform() { reads++; return local([1, 0, 0]) },
    }))
    const index = { ...buildSceneNodeIndex(nodes), structureVersion: 1 }
    const cache = createSceneNodeTransformCache(() => index)
    expect(cache.getWorldMatrix('19999')[3]).toEqual([20000, 0, 0])
    const firstReads = reads
    const world = cache.getWorldMatrix('19999')
    expect(cache.getWorldMatrix('19998')[3]).toEqual([19999, 0, 0])
    expect(cache.getWorldMatrix('19999')).toBe(world)
    expect(reads).toBe(firstReads)
    expect(firstReads).toBeLessThanOrEqual(nodes.length * 3)
  })

  it('普通属性和同级重排保留矩阵，父移动只刷新受影响子树', () => {
    const store = makeStore([node('r'), node('a', local([1, 0, 0]), 'r'), node('b'), node('c', local(), 'r')])
    const child = store.getObjectWorldMatrix('a')
    const unaffected = store.getObjectWorldMatrix('b')
    const clonedTransform = structuredClone(store.getObject('a')!.transform) as LocalTransform
    clonedTransform.scale = [1, 1, 1]
    store.upsertObject({ ...store.getObject('a')!, name: '改名', visible: false, locked: true, transform: clonedTransform })
    expect(store.getObjectWorldMatrix('a')).toBe(child)
    const original = store.getObject('a')!
    store.applyObjectHierarchy([{ id: 'a', parentInstanceId: 'r', order: 3, transform: original.transform }])
    expect(store.getObjectWorldMatrix('a')).toBe(child)
    store.upsertObject({ ...store.getObject('r')!, transform: local([10, 0, 0]) })
    expect(store.getObjectWorldMatrix('a')[3]).toEqual([11, 0, 0])
    expect(store.getObjectWorldMatrix('b')).toBe(unaffected)
    expect(store.getObjectWorldMatrix('a')).not.toBe(child)
  })

  it('父子同批移动和多次改写读取最终结果', () => {
    const store = makeStore([node('r'), node('a', local([1, 0, 0]), 'r')])
    store.getObjectWorldMatrix('a')
    store.runTransaction(() => {
      store.upsertObject({ ...store.getObject('r')!, transform: local([10, 0, 0]) })
      store.upsertObject({ ...store.getObject('a')!, transform: local([2, 0, 0]) })
      store.upsertObject({ ...store.getObject('r')!, transform: local([20, 0, 0]) })
      expect(store.getObjectWorldMatrix('a')[3]).toEqual([22, 0, 0])
    })
    expect(store.getObjectWorldMatrix('a')[3]).toEqual([22, 0, 0])
  })

  it('连续替换与插入相同编号、删除后重建不复用旧矩阵', () => {
    const store = makeStore([node('a', local([1, 0, 0]))])
    const original = store.getObjectWorldMatrix('a')
    store.insertObjectAt(node('a', local([2, 0, 0])), 0)
    expect(store.getObjectWorldMatrix('a')[3]).toEqual([2, 0, 0])
    store.removeObject('a')
    store.upsertObject(node('a', local([3, 0, 0])))
    expect(store.getObjectWorldMatrix('a')[3]).toEqual([3, 0, 0])
    expect(store.getObjectWorldMatrix('a')).not.toBe(original)
  })

  it('转移出已脏父级的子树仍使用最新父链', () => {
    const store = makeStore([node('r'), node('s', local([100, 0, 0])), node('a', local([1, 0, 0]), 'r'), node('b', local([2, 0, 0]), 'a')])
    store.getObjectWorldMatrix('b')
    store.upsertObject({ ...store.getObject('r')!, transform: local([10, 0, 0]) })
    const a = store.getObject('a')!
    store.applyObjectHierarchy([{ id: 'a', parentInstanceId: 's', order: 0, transform: a.transform }])
    expect(store.getObjectWorldMatrix('b')[3]).toEqual([103, 0, 0])
  })

  it('换父级、撤销重做及异步失败补偿都保持世界姿态', () => {
    const store = makeStore([node('r', local([10, 0, 0])), node('s', local([100, 0, 0])), node('a', local([2, 0, 0]), 'r')])
    const bus = createCommandBus(store)
    const world = store.getObjectWorldMatrix('a')
    bus.execute(createMoveSceneNodeCommand(store, 'a', 's')!)
    expectMatrixClose(store.getObjectWorldMatrix('a'), world)
    bus.undo(); expectMatrixClose(store.getObjectWorldMatrix('a'), world)
    bus.redo(); expectMatrixClose(store.getObjectWorldMatrix('a'), world)
    const pending = bus.beginConfirmed('execute', createMoveSceneNodeCommand(store, 'a', 'r'))!
    expectMatrixClose(store.getObjectWorldMatrix('a'), world)
    pending.restore(); pending.finishRollback()
    expect(store.getObject('a')?.parentInstanceId).toBe('s')
    expectMatrixClose(store.getObjectWorldMatrix('a'), world)
  })

  it('删除恢复及同编号重载不复用旧对象的矩阵', () => {
    const store = makeStore([node('r'), node('a', local([1, 0, 0]), 'r')])
    const old = store.getObjectWorldMatrix('a')
    const removed = store.removeObjectBatch(new Set(['r', 'a']))
    expect(() => store.getObjectWorldMatrix('a')).toThrow('不存在')
    store.restoreObjectBatch(removed, undefined)
    expectMatrixClose(store.getObjectWorldMatrix('a'), old)
    store.loadScene({ ...store.getScene(), objects: [node('a', local([50, 0, 0]))] })
    expect(store.getObjectWorldMatrix('a')[3]).toEqual([50, 0, 0])
    expect(store.getObjectWorldMatrix('a')).not.toBe(old)
  })

  it('同步事务读取临时矩阵后失败，恢复草稿的矩阵重新计算', () => {
    const store = makeStore([node('r'), node('a', local([1, 0, 0]), 'r')])
    const before = store.getObjectWorldMatrix('a')
    expect(() => store.runTransaction(() => {
      store.upsertObject({ ...store.getObject('r')!, transform: local([20, 0, 0]) })
      expect(store.getObjectWorldMatrix('a')[3]).toEqual([21, 0, 0])
      throw new Error('注入失败')
    })).toThrow('注入失败')
    expectMatrixClose(store.getObjectWorldMatrix('a'), before)
  })

  it('缺失节点和地理变换拒绝使用本地查询', () => {
    const store = makeStore([node('r')])
    expect(() => store.getObjectWorldMatrix('missing')).toThrow('不存在')
    store.upsertObject({ ...node('geo'), transform: { kind: 'geo', longitude: 120, latitude: 30, height: 0,
      heading: 0, pitch: 0, roll: 0, scale: 1, altitudeMode: 'absolute' } })
    expect(() => store.getObjectLocalMatrix('geo')).toThrow('本地坐标')
    expect(() => store.getObjectWorldMatrix('geo')).toThrow('本地坐标')
  })
})

describe('共享相对变换计算与换父级兼容', () => {
  it('多轴旋转与非均匀缩放的层级组合符合逐级变换点的几何结果', () => {
    const nodes = [node('r', local([3, -4, 2], [0.3, -0.7, 0.8], [2, -3, 4])),
      node('a', local([5, 2, -1], [-0.2, 0.4, 0.6], [0.5, 2, -1]), 'r')]
    const store = makeStore(nodes)
    const world = store.getObjectWorldMatrix('a')
    // 通过先缩放、再按Z/Y/X旋转一个点独立对照，避免测试复刻矩阵展开式。
    const applyPoint = (t: LocalTransform, point: [number, number, number]): [number, number, number] => {
      const scale = typeof t.scale === 'number' ? [t.scale, t.scale, t.scale] : t.scale
      const x = point[0] * scale[0]!, y = point[1] * scale[1]!, z = point[2] * scale[2]!
      const [rx, ry, rz] = t.rotation
      const xz = x * Math.cos(rz) - y * Math.sin(rz), yz = x * Math.sin(rz) + y * Math.cos(rz)
      const xy = xz * Math.cos(ry) + z * Math.sin(ry), zy = -xz * Math.sin(ry) + z * Math.cos(ry)
      return [xy + t.position[0], yz * Math.cos(rx) - zy * Math.sin(rx) + t.position[1],
        yz * Math.sin(rx) + zy * Math.cos(rx) + t.position[2]]
    }
    for (const point of [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]] as Array<[number, number, number]>) {
      const expected = applyPoint(nodes[0]!.transform as LocalTransform, applyPoint(nodes[1]!.transform as LocalTransform, point))
      for (let axis = 0; axis < 3; axis++) {
        const actual = world[0][axis]! * point[0] + world[1][axis]! * point[1] + world[2][axis]! * point[2] + world[3][axis]!
        expect(actual).toBeCloseTo(expected[axis]!, 9)
      }
    }
  })

  it.each([Math.PI / 2, -Math.PI / 2, 0.7])('镜像和欧拉角奇异位%s往返保持矩阵', (angle) => {
    const store = makeStore([node('r'), node('a', local([3, 4, 5], [0.3, angle, 0.5], [-2, 3, 4]))])
    const original = store.getObjectWorldMatrix('a')
    const relative = createSceneRelativeTransform(store.getObjectWorldMatrix('r'))(original)
    store.upsertObject({ ...store.getObject('a')!, transform: relative })
    expectMatrixClose(store.getObjectWorldMatrix('a'), original)
  })

  it('世界矩阵允许表达剪切，写回局部变换时拒绝损失', () => {
    const store = makeStore([node('r', local([0, 0, 0], [0, 0, 0], [2, 1, 1])),
      node('a', local([0, 0, 0], [0, 0, Math.PI / 4]), 'r')])
    const world = store.getObjectWorldMatrix('a')
    const identity = makeStore([node('identity')]).getObjectWorldMatrix('identity')
    expect(() => createSceneRelativeTransform(identity)(world)).toThrow('剪切')
  })

  it('不可逆父矩阵和不可表示的源缩放被拒绝', () => {
    const store = makeStore([node('zero', local([0, 0, 0], [0, 0, 0], 0)), node('identity')])
    expect(() => createSceneRelativeTransform(store.getObjectWorldMatrix('zero'))).toThrow('求逆')
    expect(() => createSceneRelativeTransform(store.getObjectWorldMatrix('identity'))(store.getObjectWorldMatrix('zero'))).toThrow('缩放')
  })

  it.each([
    local([NaN, 0, 0]), local([0, 0, 0], [Infinity, 0, 0]), local([0, 0, 0], [0, 0, 0], Infinity),
  ])('非有限输入不能污染查询缓存 %#', (transform) => {
    const store = makeStore([node('a')])
    store.upsertObject({ ...store.getObject('a')!, transform })
    expect(() => store.getObjectWorldMatrix('a')).toThrow('有限')
    store.upsertObject({ ...store.getObject('a')!, transform: local([1, 0, 0]) })
    expect(store.getObjectWorldMatrix('a')[3]).toEqual([1, 0, 0])
  })

  it('有限输入组合溢出时拒绝世界矩阵，修复后可继续查询', () => {
    const store = makeStore([node('r', local([0, 0, 0], [0, 0, 0], 1e200)), node('a', local([1e200, 0, 0]), 'r')])
    expect(() => store.getObjectWorldMatrix('a')).toThrow('有限')
    store.upsertObject({ ...store.getObject('r')!, transform: local() })
    expect(store.getObjectWorldMatrix('a')[3]).toEqual([1e200, 0, 0])
  })
})
