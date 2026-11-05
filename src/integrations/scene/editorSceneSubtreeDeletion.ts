import type { ViewportHost } from '@/scene-platform'
import { createDeleteSceneSubtreesCommand } from '@/scene-platform/commands/deleteSceneSubtreesCommand'
import { useSceneWidgetStore } from '@/stores/sceneEditStore'
import { runConfirmedEditorCommand } from './editorSceneCommandTransaction'
import { beginEditorSceneOperation, editorSceneOperation } from './editorSceneOperationGate'
import { getActiveSceneViewportHost } from './editorScenePlatformHost'
import { readEditorSceneGlobalStateSnapshot } from './editorSceneGlobalStateAdapter'
import { assertNoDeletedObjectReferences, assertOriginalThreeDDeletionAllowed } from './twoDPackagePreservation'

/** 行内删除和多选删除共用确认与补偿，操作对象以权威草稿编号为准。 */
export async function deleteEditorSceneSubtrees(host: ViewportHost, ids: readonly string[]): Promise<boolean> {
  if (!ids.length || editorSceneOperation.value || getActiveSceneViewportHost() !== host) return false
  const widgets = useSceneWidgetStore()
  const store = host.getStore()
  const command = createDeleteSceneSubtreesCommand(ids, (selected) => {
    const deleted = new Set([...store.getDeletedObjectIds(), ...selected])
    assertOriginalThreeDDeletionAllowed(store.getScene().id, deleted, store.getHierarchyEditedIds(), store.captureSaveEdits())
    assertNoDeletedObjectReferences(readEditorSceneGlobalStateSnapshot()?.sceneActions, deleted, '场景动作')
    for (const object of store.getObjects()) {
      if (!deleted.has(object.id)) {
        assertNoDeletedObjectReferences(object.metadata?.statusList, deleted, `「${object.name}」`)
        assertNoDeletedObjectReferences(object.metadata?.interactiveEvent, deleted, `「${object.name}」`)
      }
    }
    for (const { component } of widgets.totalWidgets ?? []) {
      const name = String((component.option as Record<string, unknown> | undefined)?.label || component.info.name)
      assertNoDeletedObjectReferences(component.statusList, deleted, `二维部件「${name}」`)
      assertNoDeletedObjectReferences(component.interactiveEvent, deleted, `二维部件「${name}」`)
    }
  })
  const release = beginEditorSceneOperation('deleteSceneNodes')
  try {
    return await runConfirmedEditorCommand(host, 'execute', command, () => getActiveSceneViewportHost() === host)
  } finally {
    release()
  }
}
