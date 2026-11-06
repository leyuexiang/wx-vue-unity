import { cloneDeep } from 'lodash-es'
import {
  createDeleteObjectCommand,
  createUpdateObjectNameCommand,
  pruneSceneStreamingChunkObjectReferences,
  type CommandBus,
  type SceneCommand,
  type SceneObject,
  type SceneStore,
} from '@/scene-platform'
import { createSnowflakeId } from '@/utils/snowflakeId'
import { ensureEditorSceneStreamingChunks } from './editorSceneStreamingChunkAdapter'

export type EditorSceneObjectMutationSkipReason =
  | 'missing-store'
  | 'missing-command-bus'
  | 'missing-object-id'
  | 'missing-object'
  | 'empty-name'
  | 'unchanged-name'
  | 'locked-object'
  | 'unsupported-object'

export type RenameEditorSceneObjectInStoreResult =
  | {
      status: 'applied'
      objectId: string
      name: string
    }
  | {
      status: 'skipped'
      reason: EditorSceneObjectMutationSkipReason
    }

export type RemoveEditorSceneObjectFromStoreResult =
  | {
      status: 'applied'
      objectId: string
    }
  | {
      status: 'skipped'
      reason: Extract<
        EditorSceneObjectMutationSkipReason,
        'missing-store' | 'missing-object-id' | 'missing-object' | 'locked-object'
      >
    }

export type DeleteEditorSceneObjectWithCommandResult =
  | {
      status: 'applied'
      objectId: string
    }
  | {
      status: 'skipped'
      reason:
        | Extract<
            EditorSceneObjectMutationSkipReason,
            'missing-store' | 'missing-object-id' | 'missing-object' | 'locked-object'
          >
        | 'missing-command-bus'
    }

export type DuplicateEditorSceneObjectWithCommandResult =
  | {
      status: 'applied'
      sourceObjectId: string
      duplicatedObjectId: string
    }
  | {
      status: 'skipped'
      reason:
        | Extract<
            EditorSceneObjectMutationSkipReason,
            | 'missing-store'
            | 'missing-object-id'
            | 'missing-object'
            | 'locked-object'
            | 'unsupported-object'
          >
        | 'missing-command-bus'
    }

export interface RenameEditorSceneObjectInStoreOptions {
  store?: SceneStore | null
  objectId?: string | null
  name: string
}

export interface RenameEditorSceneObjectWithCommandOptions
  extends RenameEditorSceneObjectInStoreOptions {
  commandBus?: Pick<CommandBus, 'execute'> | null
}

export interface RemoveEditorSceneObjectFromStoreOptions {
  store?: SceneStore | null
  objectId?: string | null
}

export interface DeleteEditorSceneObjectWithCommandOptions {
  store?: SceneStore | null
  commandBus?: Pick<CommandBus, 'execute'> | null
  objectId?: string | null
}

export interface DuplicateEditorSceneObjectWithCommandOptions {
  store?: SceneStore | null
  commandBus?: Pick<CommandBus, 'execute'> | null
  objectId?: string | null
}

export interface EditorSceneKeyboardShortcutOptions {
  key?: string
  target?: EventTarget | null
  composing?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
}

export type EditorSceneTransformShortcutMode = 'translate' | 'rotate' | 'scale'

export interface ShouldDeleteEditorSceneObjectByKeyboardOptions {
  key?: string
  target?: EventTarget | null
  composing?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
}

const EDITOR_SCENE_OBJECT_DELETE_KEYS = new Set(['Delete', 'Backspace'])

/** Q/W/E 与“移动/旋转/缩放”的展示顺序保持一致，避免跨运行时维护两套键位映射。 */
const EDITOR_SCENE_TRANSFORM_SHORTCUTS: Readonly<Record<string, EditorSceneTransformShortcutMode>> =
  {
    q: 'translate',
    w: 'rotate',
    e: 'scale',
  }

const isEditableKeyboardTarget = (target: EventTarget | null) => {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false

  const tagName = target.tagName.toLowerCase()
  return (
    tagName === 'input' ||
    tagName === 'textarea' ||
    tagName === 'select' ||
    target.isContentEditable ||
    Boolean(target.closest('[contenteditable="true"]'))
  )
}

const isSceneEditorPopupKeyboardTarget = (target: EventTarget | null) => {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false

  return Boolean(
    target.closest('.scene-edit-drawer') ||
      target.closest('.scene-edit-dialog') ||
      target.closest('.scene-edit-popover') ||
      target.closest('.scene-edit-popper') ||
      target.closest('.scene-edit-structure-menu') ||
      target.closest('.el-overlay') ||
      target.closest('.el-popper') ||
      target.closest('.el-select-dropdown') ||
      target.closest('.el-cascader__dropdown') ||
      target.closest('.el-color-dropdown') ||
      target.closest('.el-picker__popper'),
  )
}

/**
 * 判断键盘事件是否来自可输入控件或编辑器浮层。
 *
 * 窗口级快捷键会在捕获阶段先于业务组件收到事件，因此必须在统一边界过滤表单、富文本、抽屉、
 * 对话框和下拉面板，避免用户输入 Q/W/E 或 Ctrl+D 时意外修改场景。
 */
const isBlockedEditorSceneKeyboardTarget = (target: EventTarget | null): boolean =>
  isEditableKeyboardTarget(target) || isSceneEditorPopupKeyboardTarget(target)

/**
 * 判断 Ctrl/Cmd+D 是否应交给场景复制入口。
 *
 * 只接受不带 Shift/Alt 的标准组合键；输入法合成和编辑器浮层内按键完整保留给当前控件。
 */
export const shouldDuplicateEditorSceneObjectByKeyboard = ({
  key,
  target,
  composing,
  ctrlKey,
  metaKey,
  shiftKey,
  altKey,
}: EditorSceneKeyboardShortcutOptions): boolean => {
  if (key?.toLowerCase() !== 'd') return false
  if (composing || shiftKey || altKey || (!ctrlKey && !metaKey)) return false
  return !isBlockedEditorSceneKeyboardTarget(target ?? null)
}

/**
 * 把无修饰键的 Q/W/E 解析为统一操控器模式。
 *
 * 返回 null 表示事件应继续交给浏览器或当前控件；调用方只有在确实选中三维对象时才执行切换，
 * 从而避免二维部件编辑期间误改变隐藏的三维操控器状态。
 */
export const resolveEditorSceneTransformShortcut = ({
  key,
  target,
  composing,
  ctrlKey,
  metaKey,
  shiftKey,
  altKey,
}: EditorSceneKeyboardShortcutOptions): EditorSceneTransformShortcutMode | null => {
  if (!key || composing || ctrlKey || metaKey || shiftKey || altKey) return null
  if (isBlockedEditorSceneKeyboardTarget(target ?? null)) return null
  return EDITOR_SCENE_TRANSFORM_SHORTCUTS[key.toLowerCase()] ?? null
}

/**
 * 创建可持久化的三维对象副本，并移除只能由运行时重新生成的旧引擎身份。
 *
 * 资产、样式、看板、交互和业务元数据都需要深复制，避免修改副本时污染源对象；Three Object3D 的
 * uuid 与旧 onlyUuid 不能沿用，否则两个领域对象会映射到同一个引擎实例。嵌入式功能组件的 effect.id
 * 通常与对象 id 相同，此时同步改成新 id，保证后续属性命令仍能精确命中副本。
 */
const createDuplicatedEditorSceneObject = (
  source: SceneObject,
  duplicatedObjectId: string,
): SceneObject => {
  const duplicated = cloneDeep(source)
  duplicated.id = duplicatedObjectId
  if (duplicated.effect?.id === source.id) duplicated.effect.id = duplicatedObjectId

  if (duplicated.metadata) {
    delete duplicated.metadata.engineObjectUuid
    delete duplicated.metadata.legacyOnlyUuid
  }

  return duplicated
}

/**
 * 将结构树重命名结果写回场景仓库（SceneStore）。
 *
 * 过渡期的名称编辑需要同时覆盖旧 Three 场景和新的只读数据源。这里只处理 Store 快照：
 * - 先裁剪空白，保持和旧弹窗的 trim 行为一致；
 * - 名称未变化时直接跳过，避免触发 RuntimeBridge 的冗余 upsert；
 * - 只替换 name 字段，保留对象变换、资产、样式、图层和业务元数据。
 */
export const renameEditorSceneObjectInStore = ({
  store,
  objectId,
  name,
}: RenameEditorSceneObjectInStoreOptions): RenameEditorSceneObjectInStoreResult => {
  if (!store) return { status: 'skipped', reason: 'missing-store' }
  if (!objectId) return { status: 'skipped', reason: 'missing-object-id' }

  const nextName = name.trim()
  if (!nextName) return { status: 'skipped', reason: 'empty-name' }

  const object = store.getObject(objectId)
  if (!object) return { status: 'skipped', reason: 'missing-object' }
  if (object.name === nextName) return { status: 'skipped', reason: 'unchanged-name' }

  store.upsertObject({
    ...object,
    name: nextName,
  })

  return {
    status: 'applied',
    objectId,
    name: nextName,
  }
}

/**
 * 通过统一命令总线更新模型名称。
 * 右侧属性面板和后续宿主项目共用此入口，保证改名可撤销且锁定对象无法绕过只读限制。
 */
export const renameEditorSceneObjectWithCommand = ({
  store,
  commandBus,
  objectId,
  name,
}: RenameEditorSceneObjectWithCommandOptions): RenameEditorSceneObjectInStoreResult => {
  if (!store) return { status: 'skipped', reason: 'missing-store' }
  if (!objectId) return { status: 'skipped', reason: 'missing-object-id' }
  const nextName = name.trim()
  if (!nextName) return { status: 'skipped', reason: 'empty-name' }
  const object = store.getObject(objectId)
  if (!object) return { status: 'skipped', reason: 'missing-object' }
  if (object.name === nextName) return { status: 'skipped', reason: 'unchanged-name' }
  if (!commandBus) return { status: 'skipped', reason: 'missing-command-bus' }
  if (store.isObjectEffectivelyLocked(objectId))
    return { status: 'skipped', reason: 'locked-object' }

  commandBus.execute(createUpdateObjectNameCommand(objectId, nextName))
  return { status: 'applied', objectId, name: nextName }
}

/**
 * 将结构树删除结果同步到场景仓库（SceneStore）。
 *
 * 旧删除函数负责 Three 对象、辅助器、资源释放和旧命令栈；本函数只移除 Store 中的对象快照。
 * Store 删除会触发对象树刷新，并让运行时桥（RuntimeBridge）清理平台侧 Runtime 镜像。
 */
export const removeEditorSceneObjectFromStore = ({
  store,
  objectId,
}: RemoveEditorSceneObjectFromStoreOptions): RemoveEditorSceneObjectFromStoreResult => {
  if (!store) return { status: 'skipped', reason: 'missing-store' }
  if (!objectId) return { status: 'skipped', reason: 'missing-object-id' }

  const removed = store.removeObject(objectId)
  if (!removed) return { status: 'skipped', reason: 'missing-object' }

  /**
   * 兼容尚未内置区块清理的旧 Store 实现；当前平台 Store 已在 removeObject 内完成同一操作，
   * 因此这里通常只会比较引用并直接跳过，不会产生重复事件。
   */
  const scene = store.getScene()
  const repairedStreaming = pruneSceneStreamingChunkObjectReferences({
    id: scene.id,
    objects: scene.objects,
    streaming: scene.streaming,
  })
  if (repairedStreaming !== scene.streaming) store.updateSceneStreaming(repairedStreaming, 'membership')

  return {
    status: 'applied',
    objectId,
  }
}

/**
 * 判断一次键盘事件是否应该触发三维对象删除。
 *
 * 这个 helper 专门服务画布级快捷键入口：
 * - 只响应 Delete / Backspace；
 * - 输入框、富文本、抽屉、弹窗和下拉浮层内的按键不劫持；
 * - 带 Ctrl / Meta / Alt 的组合键保留给浏览器和系统快捷键。
 */
export const shouldDeleteEditorSceneObjectByKeyboard = ({
  key,
  target,
  composing,
  ctrlKey,
  metaKey,
  altKey,
}: ShouldDeleteEditorSceneObjectByKeyboardOptions): boolean => {
  if (!key || !EDITOR_SCENE_OBJECT_DELETE_KEYS.has(key)) return false
  if (composing || ctrlKey || metaKey || altKey) return false

  /**
   * KeyboardEvent.target 在单测和部分宿主派发场景里可能缺失。
   * 统一折叠成 null 后再进入 DOM 类型守卫，避免快捷键判断把 undefined 泄到窄类型函数。
   */
  const keyboardTarget = target ?? null
  if (isBlockedEditorSceneKeyboardTarget(keyboardTarget)) return false

  return true
}

/**
 * 通过统一命令总线复制当前三维对象。
 *
 * 副本插入源对象之后，并在命令内部同时维护自动流式区块和选中态。这样一次 Ctrl/Cmd+D 只产生
 * 一条历史记录；撤销会原子恢复对象、区块与原选择，重做也不会依赖已经释放的 Three/Cesium 实例。
 * 中国 3D 地图受“一场景一个实例”领域约束，不能通过通用复制入口绕过创建命令的限制。
 */
export const duplicateEditorSceneObjectWithCommand = ({
  store,
  commandBus,
  objectId,
}: DuplicateEditorSceneObjectWithCommandOptions): DuplicateEditorSceneObjectWithCommandResult => {
  if (!store) return { status: 'skipped', reason: 'missing-store' }
  if (!commandBus) return { status: 'skipped', reason: 'missing-command-bus' }
  if (!objectId) return { status: 'skipped', reason: 'missing-object-id' }

  const sourceObject = store.getObject(objectId)
  if (!sourceObject) return { status: 'skipped', reason: 'missing-object' }
  if (store.isObjectEffectivelyLocked(objectId)) {
    return { status: 'skipped', reason: 'locked-object' }
  }
  if (sourceObject.effect?.type === 'three-map' || sourceObject.firstPerson) {
    return { status: 'skipped', reason: 'unsupported-object' }
  }

  const duplicatedObjectId = createSnowflakeId()
  const duplicatedObject = createDuplicatedEditorSceneObject(sourceObject, duplicatedObjectId)
  const previousSelectedObjectId = store.getSelectedObjectId()
  const previousStreaming = cloneDeep(store.getScene().streaming)
  let insertionIndex = store.getObjects().findIndex((object) => object.id === sourceObject.id) + 1

  const command: SceneCommand = {
    name: 'DuplicateObject',
    execute: (activeStore) => {
      /** 重做前重新确认源位置，使同一命令即使经过结构重排也仍把副本放在源对象之后。 */
      const currentSourceIndex = activeStore
        .getObjects()
        .findIndex((object) => object.id === sourceObject.id)
      if (currentSourceIndex >= 0) insertionIndex = currentSourceIndex + 1

      activeStore.insertObjectAt(duplicatedObject, insertionIndex)
      const currentScene = activeStore.getScene()
      const sceneWithStreamingChunk = ensureEditorSceneStreamingChunks(currentScene)
      if (sceneWithStreamingChunk.streaming !== currentScene.streaming) {
        activeStore.updateSceneStreaming(sceneWithStreamingChunk.streaming, 'membership')
      }
      activeStore.setSelectedObjectId(duplicatedObjectId)
    },
    undo: (activeStore) => {
      activeStore.removeObject(duplicatedObjectId)
      /**
       * removeObject 会裁剪副本区块；恢复复制前的完整快照可同时保留手工区块、运行时覆盖和关闭状态。
       * cloneDeep 防止后续重做修改命令持有的历史基线。
       */
      activeStore.updateSceneStreaming(cloneDeep(previousStreaming), 'membership')
      activeStore.setSelectedObjectId(previousSelectedObjectId)
    },
  }

  commandBus.execute(command)
  return {
    status: 'applied',
    sourceObjectId: sourceObject.id,
    duplicatedObjectId,
  }
}

/**
 * 通过平台命令总线删除结构树中的三维对象。
 *
 * 这是结构树删除入口的主路径：组件只提交对象 id，真正的删除由 DeleteObjectCommand 修改
 * SceneStore，再由 RuntimeBridge 批量同步到 ThreeSceneRuntime。这样对象树删除、顶部撤销 / 重做
 * 和 Runtime 删除共享同一条历史链路。
 *
 * 注意这里会先确认 Store 中存在对象再派发命令，避免空删除也进入 undo 栈。
 */
export const deleteEditorSceneObjectWithCommand = ({
  store,
  commandBus,
  objectId,
}: DeleteEditorSceneObjectWithCommandOptions): DeleteEditorSceneObjectWithCommandResult => {
  if (!store) return { status: 'skipped', reason: 'missing-store' }
  if (!commandBus) return { status: 'skipped', reason: 'missing-command-bus' }
  if (!objectId) return { status: 'skipped', reason: 'missing-object-id' }
  if (!store.getObject(objectId)) return { status: 'skipped', reason: 'missing-object' }
  /** 锁定对象只能查看和解锁，删除写入口必须再次拦截，不能只依赖按钮禁用。 */
  if (store.isObjectEffectivelyLocked(objectId))
    return { status: 'skipped', reason: 'locked-object' }

  commandBus.execute(createDeleteObjectCommand(objectId))

  return {
    status: 'applied',
    objectId,
  }
}
