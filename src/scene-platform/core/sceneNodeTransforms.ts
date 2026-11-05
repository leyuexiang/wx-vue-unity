import type { SceneNodeIndex } from './sceneNodeIndexCache'
import type { LocalTransform, SceneObject } from './types'
import { createSceneNodeWorkQueue, SceneNodeWorkFlag, type SceneNodeWorkQueue } from './sceneNodeWorkQueue'

type Vec = [number, number, number]
type ReadonlyVec = readonly [number, number, number]
/** 三列线性变换加一列平移；只读派生结果可以表达剪切，不参与业务持久化。 */
export type SceneNodeMatrix = readonly [ReadonlyVec, ReadonlyVec, ReadonlyVec, ReadonlyVec]
type TransformNode = Pick<SceneObject, 'id' | 'parentInstanceId' | 'transform'>
const identity: SceneNodeMatrix = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, 0]]
const dot = (a: ReadonlyVec, b: ReadonlyVec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: ReadonlyVec, b: ReadonlyVec): Vec => [
  a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0],
]
const length = (v: ReadonlyVec) => Math.hypot(...v)
const scaled = (v: ReadonlyVec, s: number): Vec => [v[0] * s, v[1] * s, v[2] * s]
const add = (a: ReadonlyVec, b: ReadonlyVec): Vec => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]

const assertFiniteMatrix = (matrix: SceneNodeMatrix) => {
  for (const column of matrix) {
    if (!column.every(Number.isFinite)) throw new Error('节点变换必须为有限数值')
  }
}

/** 复用原换父级的内禀XYZ欧拉角与列式仿射矩阵约定，角度单位保持弧度。 */
function localMatrix(t: LocalTransform): SceneNodeMatrix {
  if (!t.position.every(Number.isFinite) || !t.rotation.every(Number.isFinite) ||
      !(typeof t.scale === 'number' ? Number.isFinite(t.scale) : t.scale.every(Number.isFinite))) {
    throw new Error('节点变换必须为有限数值')
  }
  const [x, y, z] = t.rotation
  const a = Math.cos(x), b = Math.sin(x), c = Math.cos(y), d = Math.sin(y), e = Math.cos(z), f = Math.sin(z)
  const scale: ReadonlyVec = typeof t.scale === 'number' ? [t.scale, t.scale, t.scale] : t.scale
  return [
    scaled([c * e, a * f + b * e * d, b * f - a * e * d], scale[0]),
    scaled([-c * f, a * e - b * f * d, b * e + a * f * d], scale[1]),
    scaled([d, -b * c, a * c], scale[2]),
    // 平移列也归派生缓存所有，不把业务数组直接暴露为矩阵内容。
    [t.position[0], t.position[1], t.position[2]],
  ]
}

function multiply(a: SceneNodeMatrix, b: SceneNodeMatrix): SceneNodeMatrix {
  const direction = (v: ReadonlyVec): Vec => add(add(scaled(a[0], v[0]), scaled(a[1], v[1])), scaled(a[2], v[2]))
  return [direction(b[0]), direction(b[1]), direction(b[2]), add(direction(b[3]), a[3])]
}

/** 一批换父级共用目标逆矩阵；拒绝不可逆或无法用局部平移旋转缩放保存的姿态。 */
export function createSceneRelativeTransform(parent: SceneNodeMatrix): (world: SceneNodeMatrix) => LocalTransform {
  assertFiniteMatrix(parent)
  const [x, y, z, translation] = parent
  const rows = [cross(y, z), cross(z, x), cross(x, y)] as const
  const determinant = dot(x, rows[0])
  if (!Number.isFinite(determinant) || Math.abs(determinant) <= 1e-10 * length(x) * length(y) * length(z)) {
    throw new Error('目标父级的变换无法求逆')
  }
  const inverseDirection = (v: ReadonlyVec): Vec => [dot(rows[0], v) / determinant, dot(rows[1], v) / determinant, dot(rows[2], v) / determinant]
  return (world) => {
    assertFiniteMatrix(world)
    return relativeTransform(world, translation, inverseDirection)
  }
}

function relativeTransform(world: SceneNodeMatrix, translation: ReadonlyVec,
  inverseDirection: (direction: ReadonlyVec) => Vec): LocalTransform {
  const columns = [inverseDirection(world[0]), inverseDirection(world[1]), inverseDirection(world[2])] as const
  const scale: Vec = [length(columns[0]), length(columns[1]), length(columns[2])]
  if (scale.some((value) => !Number.isFinite(value) || value <= 1e-10)) throw new Error('节点的缩放无法表示')
  if (dot(cross(columns[0], columns[1]), columns[2]) < 0) scale[0] *= -1
  const u = scaled(columns[0], 1 / scale[0]), v = scaled(columns[1], 1 / scale[1]), w = scaled(columns[2], 1 / scale[2])
  // 世界矩阵可以含剪切，局部协议不能表示时必须保留原树而非近似分解。
  if (Math.max(Math.abs(dot(u, v)), Math.abs(dot(u, w)), Math.abs(dot(v, w))) > 1e-7) {
    throw new Error('换父级会产生无法保存的剪切变换')
  }
  const cosY = Math.hypot(w[1], w[2])
  const angleY = Math.atan2(w[0], cosY)
  const singular = cosY < 1e-10
  const position = inverseDirection(add(world[3], scaled(translation, -1)))
  if (!position.every(Number.isFinite)) throw new Error('换父级后的局部位置无法保存')
  return {
    kind: 'local', position,
    rotation: [singular ? Math.atan2(v[2], v[1]) : Math.atan2(-w[1], w[2]), angleY, singular ? 0 : Math.atan2(-v[0], u[0])],
    scale,
  }
}

/**
 * 场景存储拥有的纯数据变换缓存，读取经过结构校验的会话索引。
 * 调用方在变换/父级变化及删除恢复时登记失效，重载/回滚时清理。
 * 查询前只清除涉及子树的世界矩阵；计算沿公共父链复用，不依赖引擎层级。
 */
export function createSceneNodeTransformCache(readIndex: () => SceneNodeIndex<TransformNode>, sharedWork?: SceneNodeWorkQueue) {
  const locals = new Map<string, SceneNodeMatrix>()
  const worlds = new Map<string, SceneNodeMatrix>()
  const work = sharedWork ?? createSceneNodeWorkQueue(readIndex)
  work.subscribe(SceneNodeWorkFlag.Transform, (id) => { worlds.delete(id) })
  const chain: Array<{ id: string; transform: LocalTransform }> = []

  const readLocalTransform = (index: SceneNodeIndex<TransformNode>, id: string) => {
    const node = index.nodesById.get(id)
    if (!node) throw new Error(`节点不存在：${id}`)
    const transform = node.transform
    if (transform.kind !== 'local') throw new Error('仅支持本地坐标节点变换查询')
    return { node, transform }
  }
  const readLocalMatrix = (id: string, transform: LocalTransform) => {
    let matrix = locals.get(id)
    if (!matrix) {
      matrix = localMatrix(transform)
      assertFiniteMatrix(matrix)
      locals.set(id, matrix)
    }
    return matrix
  }

  return {
    getLocalMatrix: (id: string): SceneNodeMatrix => {
      const { transform } = readLocalTransform(readIndex(), id)
      return readLocalMatrix(id, transform)
    },
    getWorldMatrix: (id?: string): SceneNodeMatrix => {
      const index = readIndex()
      work.flush(index)
      if (id === undefined) return identity
      if (!index.nodesById.has(id)) throw new Error(`节点不存在：${id}`)
      const cached = worlds.get(id)
      if (cached) return cached
      let cursor = id
      try {
        while (cursor && !worlds.has(cursor)) {
          const { node, transform } = readLocalTransform(index, cursor)
          chain.push({ id: cursor, transform })
          cursor = node.parentInstanceId ?? ''
        }
        let world = worlds.get(cursor) ?? identity
        // 深链使用显式工作栈，先父后子；第二个兄弟查询直接复用公共父链。
        for (let i = chain.length - 1; i >= 0; i--) {
          const item = chain[i]!
          world = multiply(world, readLocalMatrix(item.id, item.transform))
          assertFiniteMatrix(world)
          worlds.set(item.id, world)
        }
        return world
      } finally {
        // 输入失败也释放临时父链引用，后续修复数据后可以继续查询。
        chain.length = 0
      }
    },
    invalidate: (id: string) => {
      locals.delete(id)
      // 删除或替换时立即释放自身矩阵，后代失效留到本批最终索引就绪后处理。
      worlds.delete(id)
      if (worlds.size) work.mark(id, SceneNodeWorkFlag.Transform)
    },
    clear: () => {
      locals.clear()
      worlds.clear()
      work.clear(SceneNodeWorkFlag.Transform)
      chain.length = 0
    },
  }
}
