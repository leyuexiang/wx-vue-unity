import type { SceneStore } from './sceneStore'
import type { SceneCommand } from '../commands/types'

/**
 * CommandBus 负责统一执行命令并提供 undo/redo。
 *
 * 约束：
 * - Command 修改业务数据，二维外部仓库使用专用快照恢复入口；
 * - Runtime 的同步由 RuntimeBridge 订阅 SceneStore 事件完成；
 * - 任何执行新命令都会清空 redo 栈，保持线性历史。
 */
export type CommandTransactionEvent = 'begin' | 'commit' | 'rollback'
type CommandHistoryEvent =
  | { type: 'clear' }
  | { type: 'execute' | 'undo' | 'redo' | 'cancel'; command: SceneCommand }
export interface ConfirmedCommandTransaction {
  /** 补偿失败时可重试；反向数据恢复最多成功应用一次。 */
  applicationFailed?: boolean
  applicationError?: unknown
  isCurrent: () => boolean
  restore: () => void
  commit: () => void
  finishRollback: () => void
}
export interface CommandBus {
  /** 当前持久化编辑状态的会话内身份，撤销/重做可回到相同身份。 */
  getHistoryState: () => number
  /** 独立持久化写入使旧命令端点无法证明当前数据等价。 */
  invalidateHistoryState: () => void
  beginConfirmed: (action: 'execute' | 'undo' | 'redo', command?: SceneCommand) => ConfirmedCommandTransaction | null
  /** 读取本次撤销或重做的目标，用于在执行前确定需要等待的运行端。 */
  getReplayCommand: (direction: 'undo' | 'redo') => SceneCommand | undefined
  /** 结束当前合并窗口，保留已有历史，供保存、切换场景和交互使用。 */
  breakHistoryMerge: () => void
  subscribeTransaction: (listener: (event: CommandTransactionEvent) => void) => () => void
  execute: (command: SceneCommand) => void
  /**
   * 登记已经由外部编辑事务应用完成的命令。
   *
   * 旧 Three 编辑器和二维仓库均采用“先改状态、再保存快照”的语义。该入口只写统一历史栈，
   * 不重复调用 command.execute；后续重做仍由标准 execute 恢复新状态。
   */
  recordExecuted: (command: SceneCommand) => void
  undo: () => boolean
  redo: () => boolean
  /** 当前是否处于撤销/重做回放阶段，供运行时屏蔽回放触发的二次历史提交。 */
  getIsExecuting: () => boolean
  /** 暂存命令等待确认期间，编辑入口必须在修改外部仓库之前检查。 */
  getIsPending: () => boolean
  /**
   * 订阅撤销栈或重做栈变化。
   *
   * 二维快照命令只改变 Pinia 状态，不一定触发 SceneStore 事件；独立历史订阅能让工具栏和保存状态
   * 无需伪造场景对象更新，也能及时读取最新可撤销、可重做步数。
   */
  subscribeHistory: (listener: (event: CommandHistoryEvent) => void) => () => void
  /**
   * 取消刚执行且尚未被其他命令穿插的同一条命令。
   *
   * 仅供“命令已经写入 Store，但异步 Runtime 创建最终失败”的补偿路径使用：
   * 它会恢复 Store、移除撤销记录，并且不把失败创建放入重做栈，避免用户重做出空壳对象。
   */
  cancelLatest: (command: SceneCommand) => boolean
  clear: () => void
  getUndoSize: () => number
  getRedoSize: () => number
}

/**
 * 创建一个与具体 Store 绑定的 CommandBus。
 */
export function createCommandBus(store: SceneStore): CommandBus {
  const MAX_HISTORY_SIZE = 220
  type HistoryEntry = { command: SceneCommand; before: number; after: number }
  const undoStack: HistoryEntry[] = []
  const redoStack: HistoryEntry[] = []
  let identitySequence = 0
  let historyState = 0
  let mergeCandidate: SceneCommand | undefined
  const breakHistoryMerge = () => { mergeCandidate = undefined }
  const invalidateHistoryState = () => {
    historyState = ++identitySequence
    breakHistoryMerge()
  }
  store.subscribe((event) => {
    if (event.type === 'sceneLoaded') invalidateHistoryState()
    else if (event.type === 'selectionChanged') breakHistoryMerge()
  })
  const getReplayCommand: CommandBus['getReplayCommand'] = (direction) => {
    const stack = direction === 'undo' ? undoStack : redoStack
    return stack[stack.length - 1]?.command
  }
  const moveHistoryState = (entry: HistoryEntry, direction: 'undo' | 'redo') => {
    const source = direction === 'undo' ? 'after' : 'before'
    const destination = direction === 'undo' ? 'before' : 'after'
    if (historyState !== entry[source]) {
      // 无历史写入可能改过命令会覆盖的字段；跨过这一边时为两个端点重新分配身份。
      entry[source] = ++identitySequence
      entry[destination] = ++identitySequence
    }
    historyState = entry[destination]
  }
  const historyListeners = new Set<(event: CommandHistoryEvent) => void>()
  let executingDepth = 0
  let pendingToken: symbol | null = null
  const transactionListeners = new Set<(event: CommandTransactionEvent) => void>()
  const transactionEvent = (event: CommandTransactionEvent) => transactionListeners.forEach((listener) => listener(event))
  const requireIdle = () => {
    if (pendingToken) throw new Error('命令正在等待运行端确认')
  }
  const apply = (operation: () => void, localOnly: boolean) => {
    executingDepth++
    try {
      // 外部仓库由专用快照恢复，无需为这类操作复制整个三维场景。
      if (localOnly) operation()
      else store.runTransaction(operation)
    }
    finally { executingDepth-- }
  }

  /** 历史监听属于低频编辑边界，使用 Set 去重并保持取消订阅为常数时间。 */
  const notifyHistoryChanged = (event: CommandHistoryEvent) => {
    historyListeners.forEach((listener) => listener(event))
  }

  /**
   * 安全释放已经无法再撤销/重做的命令资源。
   *
   * 资源清理属于历史管理的附属行为，不能因为单个 Three 对象释放失败而阻断后续编辑；
   * 因此这里捕获异常并继续清理其余历史。命令本身只会在从两个历史栈永久移除时到达此处。
   */
  const discardCommand = (command: SceneCommand | undefined): void => {
    if (!command?.onDiscard) return
    try {
      command.onDiscard()
    } catch (error) {
      console.warn('[CommandBus] 丢弃历史命令时资源清理失败', error)
    }
  }

  /** 清空指定栈并释放其中无法再恢复的运行时资源。 */
  const discardStack = (stack: HistoryEntry[]): void => {
    for (const entry of stack) discardCommand(entry.command)
    stack.length = 0
  }

  /** 清空重做栈时，栈中命令已经失去恢复机会，必须先释放其延迟资源。 */
  const discardRedoStack = (): void => {
    if (redoStack.length === 0) return
    discardStack(redoStack)
  }

  /**
   * 集中维护线性历史规则，确保直接执行命令和登记已执行命令拥有完全一致的合并、清空重做语义。
   */
  const recordExecuted = (command: SceneCommand) => {
    requireIdle()
    const previous = undoStack[undoStack.length - 1]
    const previousCommand = previous?.command
    if (previous && previousCommand && previousCommand === mergeCandidate &&
        command.mergeSession !== undefined && previousCommand.mergeSession === command.mergeSession &&
        previousCommand.name === command.name &&
        (previousCommand.confirmationScope ?? 'runtime') === (command.confirmationScope ?? 'runtime') &&
        previousCommand.mergeWith?.(command)) {
      previous.after = historyState = ++identitySequence
      /** 合并后的新命令不会进入任何历史栈，必须立即释放其独占资源，避免资源泄漏。 */
      discardCommand(command)
      discardRedoStack()
      notifyHistoryChanged({ type: 'execute', command })
      return
    }

    const before = historyState
    historyState = ++identitySequence
    undoStack.push({ command, before, after: historyState })
    mergeCandidate = command.mergeSession === undefined ? undefined : command
    if (undoStack.length > MAX_HISTORY_SIZE) {
      discardCommand(undoStack.shift()?.command)
    }
    discardRedoStack()
    notifyHistoryChanged({ type: 'execute', command })
  }

  return {
    getHistoryState: () => historyState,
    invalidateHistoryState,
    getReplayCommand,
    breakHistoryMerge,
    subscribeTransaction: (listener) => {
      transactionListeners.add(listener)
      return () => { transactionListeners.delete(listener) }
    },
    beginConfirmed: (action, suppliedCommand) => {
      requireIdle()
      const command = action === 'execute' ? suppliedCommand : getReplayCommand(action)
      if (!command) return null
      if (action !== 'execute') breakHistoryMerge()
      // 捕获失败发生在任何写入之前，外部仓库快照与场景事务使用同一边界。
      const restoreExternal = command.captureRollback?.(store)
      const localOnly = command.confirmationScope === 'local'
      if (localOnly && !restoreExternal) throw new Error('本地命令缺少回放恢复快照')
      const token = Symbol(action)
      pendingToken = token
      transactionEvent('begin')
      let restored = false
      const runtimeSelection = localOnly ? undefined : {
        objectId: store.getSelectedObjectId(),
        effectId: store.getSelectedEffectId(),
        waypoint: store.getCameraPathWaypointSelection(),
      }
      const saveEdits = localOnly ? undefined : store.captureSaveEdits()
      const requireCurrent = () => {
        if (pendingToken !== token) throw new Error('命令事务已失效')
      }
      let applicationError: unknown
      let applicationFailed = false
      try {
        apply(() => action === 'undo' ? command.undo(store) : command.execute(store), localOnly)
      } catch (error) {
        breakHistoryMerge()
        if (!restoreExternal) {
          pendingToken = null
          transactionEvent('rollback')
          throw error
        }
        // Store已由同步事务恢复，外部仓库可能部分写入，保留事务供统一恢复流程处理。
        applicationFailed = true
        applicationError = error
      }
      return {
        applicationFailed,
        applicationError,
        isCurrent: () => pendingToken === token,
        restore: () => {
          requireCurrent()
          if (restored) return
          apply(() => {
            if (restoreExternal) restoreExternal()
            if (!applicationFailed && !restoreExternal) {
              if (action === 'undo') command.execute(store)
              else command.undo(store)
            }
            // 补偿的反向写入不能扩大本会话已有的保存许可。
            if (saveEdits) store.restoreSaveEdits(saveEdits)
            if (runtimeSelection) {
              store.setSelectedObjectId(runtimeSelection.objectId)
              store.setSelectedEffectId(runtimeSelection.effectId)
              store.setCameraPathWaypointSelection(runtimeSelection.waypoint)
            }
          }, localOnly)
          restored = true
        },
        finishRollback: () => {
          requireCurrent()
          if (!restored) throw new Error('命令数据尚未恢复')
          pendingToken = null
          breakHistoryMerge()
          if (action === 'execute') discardCommand(command)
          transactionEvent('rollback')
        },
        commit: () => {
          requireCurrent()
          if (restored || applicationFailed) throw new Error('已恢复或失败的命令不能提交')
          pendingToken = null
          if (action === 'execute') recordExecuted(command)
          else {
            const source = action === 'undo' ? undoStack : redoStack
            const destination = action === 'undo' ? redoStack : undoStack
            const entry = source.pop()!
            moveHistoryState(entry, action)
            destination.push(entry)
            notifyHistoryChanged({ type: action, command })
          }
          transactionEvent('commit')
        },
      }
    },
    execute: (command) => {
      requireIdle()
      executingDepth += 1
      try {
        store.runTransaction(() => {
          command.execute(store)
        })
      } catch (error) {
        breakHistoryMerge()
        throw error
      } finally {
        executingDepth = Math.max(0, executingDepth - 1)
      }
      recordExecuted(command)
    },
    recordExecuted,
    undo: () => {
      requireIdle()
      breakHistoryMerge()
      const entry = undoStack[undoStack.length - 1]
      if (!entry) return false
      const { command } = entry
      executingDepth += 1
      try {
        store.runTransaction(() => {
          command.undo(store)
        })
      } finally {
        executingDepth = Math.max(0, executingDepth - 1)
      }
      undoStack.pop()
      moveHistoryState(entry, 'undo')
      redoStack.push(entry)
      notifyHistoryChanged({ type: 'undo', command })
      return true
    },
    redo: () => {
      requireIdle()
      breakHistoryMerge()
      const entry = redoStack[redoStack.length - 1]
      if (!entry) return false
      const { command } = entry
      executingDepth += 1
      try {
        store.runTransaction(() => {
          command.execute(store)
        })
      } finally {
        executingDepth = Math.max(0, executingDepth - 1)
      }
      redoStack.pop()
      moveHistoryState(entry, 'redo')
      undoStack.push(entry)
      notifyHistoryChanged({ type: 'redo', command })
      return true
    },
    cancelLatest: (command) => {
      requireIdle()
      /**
       * 只能取消当前栈顶的原始命令，不能从历史中间删除命令；
       * 后者会破坏后续命令依赖的 Store 快照和正常撤销顺序。
       */
      const entry = undoStack[undoStack.length - 1]
      if (entry?.command !== command) return false
      breakHistoryMerge()

      executingDepth += 1
      try {
        store.runTransaction(() => {
          command.undo(store)
        })
      } finally {
        executingDepth = Math.max(0, executingDepth - 1)
      }
      undoStack.pop()
      moveHistoryState(entry, 'undo')
      discardCommand(command)
      notifyHistoryChanged({ type: 'cancel', command })
      return true
    },
    clear: () => {
      // 宿主销毁可废弃等待中的事务，迟到确认会因令牌失效而被拒绝。
      pendingToken = null
      breakHistoryMerge()
      // 清场或重置释放历史资源，当前数据与其身份不随清栈改变。
      const hadHistory = undoStack.length > 0 || redoStack.length > 0
      discardStack(undoStack)
      discardStack(redoStack)
      if (hadHistory) notifyHistoryChanged({ type: 'clear' })
    },
    subscribeHistory: (listener) => {
      historyListeners.add(listener)
      return () => {
        historyListeners.delete(listener)
      }
    },
    getIsExecuting: () => executingDepth > 0,
    getIsPending: () => pendingToken !== null,
    getUndoSize: () => undoStack.length,
    getRedoSize: () => redoStack.length,
  }
}
