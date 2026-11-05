import { cloneDeep, isEqual } from 'lodash-es'
import type { ComponentDataConfig, PublicRequestConfig, RequestGlobalConfig } from '@/types/data-config'
import { useSceneRequestStore, useSceneWidgetStore } from '@/stores/sceneEditStore'
import { getWidgetPanelLockState } from './widgetPanels'
import { normalizeDataConfig, syncWidgetOptionFromDataConfig } from '@/utils/dataConfig'
import type { SceneCommand } from '@/scene-platform'
import { readWidgetSceneFragment } from './widgetRuntime/widgetSceneFragment'
import { serializeSceneDefinitionToFourPackages } from './sceneFourPackage'
import { assertPublicRequestRemovalAllowed, preserveUneditedThreeDDomain } from './twoDPackagePreservation'
import { readEditorSceneGlobalStateSnapshot, serializeScenePublicRequests } from './editorSceneGlobalStateAdapter'
import { beginEditorSceneOperation, editorSceneOperation } from './editorSceneOperationGate'
import { getActiveSceneViewportHost } from './editorScenePlatformHost'
import { runConfirmedEditorCommand } from './editorSceneCommandTransaction'
import { isRecord } from './threeDPackageEditMerge'

export interface PublicRequestBindingChange {
  kind: 'widget' | 'sceneObject'
  id: string
  dataConfig: ComponentDataConfig
}

/** 列表及当前实例绑定一次提交，禁止删除其他消费者仍在使用的公共接口。 */
export async function updateEditorScenePublicRequests(
  nextList: readonly PublicRequestConfig[],
  binding?: PublicRequestBindingChange,
  globalConfig?: RequestGlobalConfig,
): Promise<boolean> {
  const host = getActiveSceneViewportHost()
  if (!host || editorSceneOperation.value || host.getCommandBus().getIsPending()) return false
  const requests = useSceneRequestStore()
  const widgets = useSceneWidgetStore()
  const store = host.getStore()
  const sceneId = store.getScene().id
  let sceneReplaced = false
  const current = () => !sceneReplaced && getActiveSceneViewportHost() === host && store.getScene().id === sceneId
  // 面板先处理当前关联草稿。其他待结算编辑在门禁开始前提交。
  const release = beginEditorSceneOperation('publicRequestEdit')
  const stopScene = store.subscribe(event => {
    if (event.type === 'sceneLoaded') sceneReplaced = true
  })
  try {
    const afterList = cloneDeep([...nextList])
    const keys = new Set<string>()
    for (const item of afterList) {
      if (!item.id?.trim() || keys.has(item.id)) throw new Error('公共接口编号为空或重复')
      keys.add(item.id)
    }
    const beforeList = cloneDeep(requests.scenePublicRequestList)
    const globalBefore = cloneDeep(requests.sceneRequestGlobalConfig)
    const globalAfter = globalConfig ? cloneDeep(globalConfig) : globalBefore
    const globalChanged = !isEqual(globalBefore, globalAfter)
    const deleted = new Set(beforeList.filter(item => !keys.has(item.id)).map(item => item.id))
    const listChanged = !isEqual(beforeList, afterList)
    let widgetBefore: ReturnType<typeof widgets.createWidgetHistorySnapshot> | undefined
    let widgetAfter: typeof widgetBefore
    let objectBefore: ReturnType<typeof store.getObject> = null
    let normalized: ComponentDataConfig | null = null
    let objectBindingChanged = false
    let widgetBindingChanged = false
    if (binding) {
      normalized = normalizeDataConfig(binding.dataConfig)
      if (!normalized) throw new Error('当前请求配置无效')
      if (binding.kind === 'widget') {
        const widget = widgets.getWidgetById(binding.id)
        if (!widget || getWidgetPanelLockState(binding.id).effectiveLocked) throw new Error('当前部件不存在或已锁定')
        widgetBefore = widgets.createWidgetHistorySnapshot([binding.id])
        widgetAfter = cloneDeep(widgetBefore)
        const component = widgetAfter.widgets[0]!.component
        component.dataConfig = normalized
        syncWidgetOptionFromDataConfig(component)
        widgetBindingChanged = !isEqual(widgetBefore.widgets, widgetAfter.widgets)
      } else {
        objectBefore = store.getObject(binding.id)
        if (!objectBefore || store.isObjectEffectivelyLocked(binding.id)) throw new Error('当前三维节点不存在或已锁定')
        objectBindingChanged = !isEqual(objectBefore.metadata?.dataConfig ?? null, normalized)
      }
    }
    if (!listChanged && !globalChanged && !objectBindingChanged && !widgetBindingChanged) return true

    const applyList = (list: PublicRequestConfig[], defaults: RequestGlobalConfig) => {
      if (listChanged) requests.setScenePublicRequestList(list)
      if (globalChanged) requests.setSceneRequestGlobalConfig(defaults)
    }
    const command: SceneCommand = {
      name: deleted.size ? '删除公共接口并解除当前绑定' : '保存公共接口及当前绑定',
      confirmationScope: objectBindingChanged ? 'runtime' : 'local',
      execute(activeStore) {
        applyList(afterList, globalAfter)
        if (widgetBindingChanged && widgetAfter) widgets.applyWidgetHistorySnapshot(widgetAfter)
        if (objectBindingChanged && binding) {
          const object = activeStore.getObject(binding.id)
          if (!object) throw new Error('当前三维节点已不存在')
          activeStore.upsertObject({ ...object, metadata: { ...object.metadata, dataConfig: cloneDeep(normalized) } })
        }
        if (deleted.size) {
          // 复用实际保存投影和原档合并，覆盖未加载节点、未知依赖以及绑定溢出尾部。
          const scene = activeStore.getScene()
          const globals = readEditorSceneGlobalStateSnapshot()!
          const payload = serializeSceneDefinitionToFourPackages({
            ...scene,
            settings: {
              ...scene.settings,
              publicRequests: serializeScenePublicRequests(globals.publicRequests),
              sceneActions: globals.sceneActions,
              editor: {
                ...(isRecord(scene.settings.editor) ? scene.settings.editor : {}),
                widgetSceneFragment: readWidgetSceneFragment(),
              },
            },
          })
          const preserved = preserveUneditedThreeDDomain(
            sceneId, payload, undefined, activeStore.getHierarchyEditedIds(),
            activeStore.getDeletedObjectIds(), activeStore.captureSaveEdits(),
          )
          assertPublicRequestRemovalAllowed(preserved, deleted)
        }
      },
      undo(activeStore) {
        applyList(beforeList, globalBefore)
        if (widgetBindingChanged && widgetBefore) widgets.applyWidgetHistorySnapshot(widgetBefore)
        if (objectBindingChanged && objectBefore) activeStore.upsertObject(cloneDeep(objectBefore))
      },
      captureRollback() {
        const list = cloneDeep(requests.scenePublicRequestList)
        const defaults = cloneDeep(requests.sceneRequestGlobalConfig)
        const widget = widgetBindingChanged && binding ? widgets.createWidgetHistorySnapshot([binding.id]) : undefined
        const object = objectBindingChanged && binding ? cloneDeep(store.getObject(binding.id)) : null
        return () => {
          applyList(list, defaults)
          if (widget) widgets.applyWidgetHistorySnapshot(widget)
          if (object) store.upsertObject(object)
        }
      },
    }
    return await runConfirmedEditorCommand(host, 'execute', command, current)
  } finally {
    stopScene()
    release()
  }
}
