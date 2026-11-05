import { normalizeBillboardConfig } from '../core/billboard'
import type { BillboardConfig, SceneObject } from '../core/types'
import type { SceneCommand } from './types'
import { captureSceneObjectUpdateRollback } from './sceneObjectRollback'

interface UpdateBillboardCommand extends SceneCommand {
  objectId: string
  getNextConfig: () => BillboardConfig | null
}

const isUpdateBillboardCommand = (command: SceneCommand): command is UpdateBillboardCommand =>
  command.name === 'UpdateBillboard' &&
  typeof (command as Partial<UpdateBillboardCommand>).objectId === 'string' &&
  typeof (command as Partial<UpdateBillboardCommand>).getNextConfig === 'function'

/**
 * 创建看板配置更新命令。
 *
 * - 输入会先经过 normalizeBillboardConfig 归一化，Runtime 不再重复做边界校验；
 * - 整条 billboard 整体替换，避免 content/appearance 半更新导致画布与配置不同步；
 * - 属性面板可按字段提供连续编辑会话，同一会话合并为一条撤销记录；
 * - 传入 null 表示清除看板配置，对象回退到普通图片 Sprite 行为。
 */
export function createUpdateBillboardCommand(
  objectId: string,
  nextConfig: BillboardConfig | null,
  mergeSession?: symbol,
): SceneCommand {
  let previousObject: SceneObject | null = null
  /**
   * 归一化在命令创建时做一次，后续合并只保留最新归一化结果。
   * 这样 execute/undo 都不会重复调用归一化函数，也避免同一条命令内的前后快照口径不一致。
   */
  let normalizedNext = nextConfig === null ? null : normalizeBillboardConfig(nextConfig)

  const command: UpdateBillboardCommand = {
    name: 'UpdateBillboard',
    captureRollback: (store) => captureSceneObjectUpdateRollback(store, objectId),
    objectId,
    mergeSession,
    getNextConfig: () => normalizedNext,
    execute: (store) => {
      if (!previousObject) previousObject = store.getObject(objectId)

      const current = store.getObject(objectId)
      if (!current) {
        throw new Error(`Object not found: ${objectId}`)
      }
      if (store.isObjectEffectivelyLocked(objectId)) {
        throw new Error(`Locked object cannot update billboard: ${objectId}`)
      }

      const next: SceneObject = { ...current }
      if (normalizedNext === null) {
        delete next.billboard
      } else {
        next.billboard = normalizedNext
      }
      store.upsertObject(next)
    },
    undo: (store) => {
      if (previousObject) store.upsertObject(previousObject)
    },
    mergeWith: (nextCommand) => {
      if (!isUpdateBillboardCommand(nextCommand)) return false
      if (nextCommand.objectId !== objectId) return false
      normalizedNext = nextCommand.getNextConfig()
      return true
    },
  }

  return command
}
