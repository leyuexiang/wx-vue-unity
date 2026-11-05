import { cloneDeep, isEqual } from 'lodash-es'
import type BaseWidgetConfig from '@/packages/components/BaseWidgetConfig'
import type { WidgetLayerNode } from '@/types/threeScene'

export interface WidgetHistoryEntry {
  id: string
  parentId?: string
  component: BaseWidgetConfig
}

export interface WidgetHistorySnapshot {
  /** 本次命令真正影响的部件编号；应用快照时不会覆盖无关部件。 */
  widgetIds: string[]
  /** 目标状态中的完整部件配置；缺失的受影响编号表示该部件应被移除。 */
  widgets: WidgetHistoryEntry[]
  /** 仅结构类操作携带图层树，普通属性编辑不复制整棵树。 */
  widgetLayerTree?: WidgetLayerNode[]
  /** 撤销或重做后需要恢复的部件选中态。 */
  currentWidgetsIds: string[] | null
  currentWidgetGroupId: string | null
  /** 结构树分组多选态；可与 currentWidgetsIds 同时存在以支持混合成组。 */
  currentWidgetGroupIds: string[]
}

export interface WidgetHistoryCommandContext {
  /** 把纯快照应用回二维仓库，命令本身不直接依赖状态管理实现。 */
  applyWidgetHistorySnapshot: (snapshot: WidgetHistorySnapshot) => void
  /** 捕获真正受影响的配置、层级和选择，保留与命令无关的部件引用。 */
  createWidgetHistorySnapshot?: (ids: string[], options: { includeLayerTree: boolean }) => WidgetHistorySnapshot
}

/**
 * 二维部件快照命令。
 *
 * 该命令不再继承旧历史模块的 Command 基类，只实现统一命令总线适配器需要的最小协议。
 * 二维仓库仍采用“先应用、后登记”语义，因此首次提交由 CommandBus.recordExecuted 入栈，
 * 后续撤销和重做分别调用这里的 undo、redo。
 */
export default class WidgetCommand {
  readonly name: string
  readonly mergeSession?: symbol
  private readonly oldSnapshot: WidgetHistorySnapshot
  private newSnapshot: WidgetHistorySnapshot
  private readonly context: WidgetHistoryCommandContext

  constructor(
    name: string,
    oldSnapshot: WidgetHistorySnapshot,
    newSnapshot: WidgetHistorySnapshot,
    context: WidgetHistoryCommandContext,
    mergeSession?: symbol,
  ) {
    this.name = name
    this.oldSnapshot = cloneDeep(oldSnapshot)
    this.newSnapshot = cloneDeep(newSnapshot)
    this.context = context
    this.mergeSession = mergeSession
  }

  /** 同一输入会话只合并单部件属性，且上一笔末态必须与下一笔基线一致。 */
  mergeWith(next: WidgetCommand): boolean {
    const current = this.newSnapshot
    const before = next.oldSnapshot
    if (this.mergeSession === undefined || this.mergeSession !== next.mergeSession ||
        this.context.applyWidgetHistorySnapshot !== next.context.applyWidgetHistorySnapshot ||
        current.widgetLayerTree || before.widgetLayerTree ||
        current.widgetIds.length !== 1 || before.widgetIds.length !== 1 ||
        current.widgetIds[0] !== before.widgetIds[0] || !isEqual(current.widgets, before.widgets)) return false
    this.newSnapshot = next.newSnapshot
    return true
  }

  captureRollback(): (() => void) | undefined {
    if (!this.context.createWidgetHistorySnapshot) return undefined
    const ids = [...new Set([...this.oldSnapshot.widgetIds, ...this.newSnapshot.widgetIds])]
    const snapshot = this.context.createWidgetHistorySnapshot(ids, {
      includeLayerTree: !!(this.oldSnapshot.widgetLayerTree || this.newSnapshot.widgetLayerTree),
    })
    return () => this.context.applyWidgetHistorySnapshot(snapshot)
  }

  undo(): void {
    this.context.applyWidgetHistorySnapshot(this.oldSnapshot)
  }

  redo(): void {
    this.context.applyWidgetHistorySnapshot(this.newSnapshot)
  }
}
