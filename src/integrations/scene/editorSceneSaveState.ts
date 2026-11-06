import type { CommandBus, SceneStore, SceneStoreEvent } from '@/scene-platform'

export interface EditorSceneSaveStateSnapshot {
  revision: number
  savedRevision: number
  dirty: boolean
  saving: boolean
  lastErrorMessage: string | null
}

type SaveStateStore = Pick<SceneStore, 'subscribe'>
type SaveStateBus = Pick<CommandBus,
  'subscribeHistory' | 'getHistoryState' | 'invalidateHistoryState' | 'getIsExecuting' | 'breakHistoryMerge'>

export interface EditorSceneSaveCheckpoint {
  readonly session: symbol
  readonly revision: number
  readonly historyState: number | undefined
}

export interface EditorSceneSaveAttempt {
  readonly checkpoint: EditorSceneSaveCheckpoint
}

export interface EditorSceneSaveStateTracker {
  bindStore: (store: SaveStateStore | null, commandBus?: SaveStateBus | null) => void
  captureCheckpoint: () => EditorSceneSaveCheckpoint
  beginSave: (checkpoint?: EditorSceneSaveCheckpoint) => EditorSceneSaveAttempt
  isCurrentSave: (attempt: EditorSceneSaveAttempt) => boolean
  markSaved: (attempt?: EditorSceneSaveAttempt) => EditorSceneSaveStateSnapshot
  /** 整场景导入在宿主刷新完成后显式标为未保存，不能把替换事件当成服务器干净基线。 */
  markDirty: () => EditorSceneSaveStateSnapshot
  markFailed: (error: unknown, attempt?: EditorSceneSaveAttempt) => EditorSceneSaveStateSnapshot
  getSnapshot: () => EditorSceneSaveStateSnapshot
  dispose: () => void
}

type EditorSceneSaveStateListener = (snapshot: EditorSceneSaveStateSnapshot) => void

/** 逐项覆盖场景事件，新事件需明确是否会进入保存快照。 */
const DATA_CHANGE_EVENTS: Record<SceneStoreEvent['type'], boolean> = {
  sceneLoaded: false,
  sceneSettingsUpdated: true,
  sceneStreamingUpdated: true,
  objectUpserted: true,
  objectRemoved: true,
  objectHierarchyChanged: true,
  layerUpserted: true,
  layerRemoved: true,
  effectUpserted: true,
  effectRemoved: true,
  cameraPathsUpdated: true,
  vegetationUpdated: true,
  selectionChanged: false,
  effectSelectionChanged: false,
  cameraPathWaypointSelectionChanged: false,
}

const FALLBACK_SAVE_ERROR_MESSAGE = '场景保存失败'

const toErrorReason = (error: unknown) => {
  if (error instanceof Error && error.message.trim()) return error.message.trim()
  if (typeof error === 'string' && error.trim()) return error.trim()
  return FALLBACK_SAVE_ERROR_MESSAGE
}

/**
 * 生成保存失败提示。
 *
 * 提示必须明确两件事：
 * - 保存请求失败，没有把当前改动标记为已保存；
 * - 用户仍可修复接口、网络或数据问题后再次保存。
 */
export const buildEditorSceneSaveFailureMessage = (error: unknown) => {
  return `${toErrorReason(error)}；当前改动已保留，请修复问题后重试`
}

/**
 * 创建编辑器保存状态跟踪器。
 *
 * 该跟踪器只服务 sceneEdit 保存按钮：
 * - 订阅 SceneStore 领域变更及外部仓库的已确认历史，计算页面级脏状态；
 * - 保存成功才推进 savedRevision；
 * - 保存失败只记录失败原因，不回滚 Store，也不清空脏状态。
 *
 * 这里放在 integrations/scene，而不是 SceneStore 核心层，是为了避免把当前产品的保存提示、
 * 后端错误文案和按钮状态写入可迁移的平台内核。
 */
export const createEditorSceneSaveStateTracker = (
  listener?: EditorSceneSaveStateListener,
): EditorSceneSaveStateTracker => {
  let revision = 0
  let savedRevision = 0
  let saving = false
  let savedHistoryState: number | undefined
  let session = Symbol('editor-save-session')
  let activeSave: EditorSceneSaveAttempt | undefined
  let lastErrorMessage: string | null = null
  let boundStore: SaveStateStore | null = null
  let boundBus: SaveStateBus | null = null
  let unsubscribeStore: (() => void) | null = null
  let unsubscribeHistory: (() => void) | undefined

  const getSnapshot = (): EditorSceneSaveStateSnapshot => ({
    revision,
    savedRevision,
    dirty: boundBus ? boundBus.getHistoryState() !== savedHistoryState : revision !== savedRevision,
    saving,
    lastErrorMessage,
  })

  const emit = () => {
    listener?.(getSnapshot())
    return getSnapshot()
  }

  const resetCleanState = () => {
    revision = 0
    savedRevision = 0
    savedHistoryState = boundBus?.getHistoryState()
    saving = false
    session = Symbol('editor-save-session')
    activeSave = undefined
    lastErrorMessage = null
  }

  const advanceRevision = () => {
    revision += 1
    lastErrorMessage = null
    return emit()
  }
  const markDirty = () => {
    boundBus?.invalidateHistoryState()
    return advanceRevision()
  }
  const captureCheckpoint = (): EditorSceneSaveCheckpoint => ({
    session, revision, historyState: boundBus?.getHistoryState(),
  })

  const handleStoreEvent = (event: SceneStoreEvent) => {
    if (event.type === 'sceneLoaded') {
      /**
       * 切换或重新加载场景后，以新 Store 快照作为干净基线。
       * 这避免打开已有场景后仅因初始化事件就提示“有未保存改动”。
       */
      resetCleanState()
      emit()
      return
    }

    if (!DATA_CHANGE_EVENTS[event.type] || ('origin' in event && event.origin === 'loadNormalization')) return
    // 直接执行及暂存、补偿的事件由最终历史回执代表，失败时没有新的保存身份。
    if (!boundBus?.getIsExecuting()) markDirty()
  }

  const unsubscribe = () => {
    unsubscribeHistory?.()
    unsubscribeStore?.()
    unsubscribeHistory = undefined
    unsubscribeStore = null
  }

  return {
    bindStore: (store, commandBus = null) => {
      // 同一宿主刷新能力或面板引用时，继续使用当前保存基线。
      if (boundStore === store && boundBus === commandBus) return
      unsubscribe()
      boundStore = store
      boundBus = commandBus
      resetCleanState()
      unsubscribeHistory = commandBus?.subscribeHistory((event) => {
        if (event.type !== 'clear') advanceRevision()
      })

      if (store) {
        unsubscribeStore = store.subscribe(handleStoreEvent)
      }

      emit()
    },
    captureCheckpoint,
    beginSave: (checkpoint = captureCheckpoint()) => {
      if (checkpoint.session !== session || activeSave) throw new Error('当前草稿保存状态已变化')
      boundBus?.breakHistoryMerge()
      const attempt = { checkpoint }
      activeSave = attempt
      saving = true
      lastErrorMessage = null
      emit()
      return attempt
    },
    isCurrentSave: (attempt) => activeSave === attempt,
    markSaved: (attempt = activeSave) => {
      if (!attempt || attempt !== activeSave) return getSnapshot()
      savedRevision = attempt.checkpoint.revision
      savedHistoryState = attempt.checkpoint.historyState
      saving = false
      activeSave = undefined
      lastErrorMessage = null
      return emit()
    },
    markDirty,
    markFailed: (error, attempt = activeSave) => {
      if (!attempt || attempt !== activeSave) return getSnapshot()
      saving = false
      activeSave = undefined
      lastErrorMessage = buildEditorSceneSaveFailureMessage(error)
      return emit()
    },
    getSnapshot,
    dispose: () => {
      unsubscribe()
      boundStore = null
      boundBus = null
      resetCleanState()
      emit()
    },
  }
}
