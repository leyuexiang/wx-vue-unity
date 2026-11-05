import type { SceneStore } from '../store/sceneStore'

export interface SceneCommand {
  name: string
  /** 仅写外部编辑仓库的命令可本地确认，且必须提供完整补偿。其他命令默认确认运行投影。 */
  confirmationScope?: 'local' | 'runtime'
  /** 捕获当前存储的专用恢复入口，存在时替代反向执行；原无参数闭包可继续使用。 */
  captureRollback?: (store: SceneStore) => (() => void) | undefined
  /** 连续编辑显式提供会话标识，独立提交无需设置。已有滑块可沿用字段合并键。 */
  mergeSession?: symbol | string
  execute: (store: SceneStore) => void
  undo: (store: SceneStore) => void
  /**
   * 尝试把后续命令合并到当前命令。
   *
   * 总线先检查会话边界；命令再核对目标并保留首笔基线和末笔结果。
   * 该方法只允许修改命令自身的历史快照，不应直接操作 Store。
   */
  mergeWith?: (nextCommand: SceneCommand) => boolean
  /**
   * 命令从撤销栈和重做栈永久移除时调用。
   *
   * 该钩子只用于释放命令独占的运行时资源；命令仍可被撤销或重做期间绝不能调用。
   * 清理失败不会影响历史栈状态，具体容错由 CommandBus 负责。
   */
  onDiscard?: () => void
}
