import type { SceneObject } from '../core/types'
import type { SceneCommand } from './types'
import { captureSceneObjectUpdateRollback } from './sceneObjectRollback'

/**
 * 局部三维模型的几何偏移。
 *
 * 它表达“把每个子网格的局部几何中心移至目标坐标”，与 Object3D 的位置、旋转、缩放不同。
 * 为保持历史场景与现有保存接口兼容，值仍保存在 metadata.offset；命令和 Runtime 脏标记则独立
 * 处理，避免该字段被误判成资产变化并触发模型重载。
 */
export interface SceneObjectGeometryOffset {
  x: number
  y: number
  z: number
}

interface UpdateObjectGeometryOffsetCommand extends SceneCommand {
  objectId: string
  getOffset: () => SceneObjectGeometryOffset
}

const isUpdateObjectGeometryOffsetCommand = (
  command: SceneCommand,
): command is UpdateObjectGeometryOffsetCommand =>
  command.name === 'UpdateObjectGeometryOffset' &&
  typeof (command as Partial<UpdateObjectGeometryOffsetCommand>).objectId === 'string' &&
  typeof (command as Partial<UpdateObjectGeometryOffsetCommand>).getOffset === 'function'

/**
 * 校验并复制输入，避免 Vue 表单后续原地修改同一对象时污染已入栈的命令快照。
 */
const normalizeOffset = (offset: SceneObjectGeometryOffset): SceneObjectGeometryOffset => {
  if (![offset.x, offset.y, offset.z].every(Number.isFinite)) {
    throw new Error('几何偏移必须是有限数字')
  }

  return { x: offset.x, y: offset.y, z: offset.z }
}

/**
 * 创建几何偏移更新命令。
 *
 * 每次写入只改 metadata.offset，保留设备编号、交互配置等其它编辑器元数据。连续输入由
 * 调用方按轴提供编辑会话；撤销与重做恢复快照，再由 RuntimeBridge 同步
 * 真实 Three 几何体，页面层不会直接接触 BufferGeometry（缓冲几何体）。
 */
export function createUpdateObjectGeometryOffsetCommand(
  objectId: string,
  offset: SceneObjectGeometryOffset,
  mergeSession?: symbol,
): SceneCommand {
  let previousObject: SceneObject | null = null
  let nextOffset = normalizeOffset(offset)

  const command: UpdateObjectGeometryOffsetCommand = {
    name: 'UpdateObjectGeometryOffset',
    captureRollback: (store) => captureSceneObjectUpdateRollback(store, objectId),
    objectId,
    mergeSession,
    getOffset: () => ({ ...nextOffset }),
    execute: (store) => {
      if (!previousObject) previousObject = store.getObject(objectId)

      const current = store.getObject(objectId)
      if (!current) {
        throw new Error(`Object not found: ${objectId}`)
      }
      if (store.isObjectEffectivelyLocked(objectId)) {
        throw new Error(`Locked object cannot update geometry offset: ${objectId}`)
      }

      store.upsertObject({
        ...current,
        metadata: { ...current.metadata, offset: { ...nextOffset } },
      })
    },
    undo: (store) => {
      if (previousObject) store.upsertObject(previousObject)
    },
    mergeWith: (nextCommand) => {
      if (!isUpdateObjectGeometryOffsetCommand(nextCommand)) return false
      if (nextCommand.objectId !== objectId) return false

      nextOffset = normalizeOffset(nextCommand.getOffset())
      return true
    },
  }

  return command
}
