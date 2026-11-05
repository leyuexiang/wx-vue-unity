import type { ViewportHost } from '@/scene-platform'
import { createCopySceneSubtreesCommand } from '@/scene-platform/commands/copySceneSubtreesCommand'
import { createSnowflakeId } from '@/utils/snowflakeId'
import { runConfirmedEditorCommand } from './editorSceneCommandTransaction'
import { beginEditorSceneOperation, editorSceneOperation } from './editorSceneOperationGate'
import { getActiveSceneViewportHost } from './editorScenePlatformHost'
import { visitThreeDObjectReferences } from './threeDObjectReferences'

/** 复制由权威草稿生成；三维投影确认后才登记历史。 */
export async function copyEditorSceneSubtrees(host: ViewportHost, ids: readonly string[]): Promise<boolean> {
  if (!ids.length || editorSceneOperation.value || getActiveSceneViewportHost() !== host) return false
  const command = createCopySceneSubtreesCommand([...ids], createSnowflakeId, (copy, copies) => {
    // 依赖包按实例拥有者和局部键共同索引。保留请求、动作及状态的局部键，避免破坏实例内联动。
    const remap = (record: Record<string, unknown>, key: string, id: string) => {
      const copyId = copies.get(id)
      if (copyId !== undefined) record[key] = copyId
      return false
    }
    visitThreeDObjectReferences(copy.metadata?.statusList, remap)
    visitThreeDObjectReferences(copy.metadata?.interactiveEvent, remap)
  })
  const release = beginEditorSceneOperation('copySceneNodes')
  try {
    return await runConfirmedEditorCommand(host, 'execute', command, () => getActiveSceneViewportHost() === host)
  } finally {
    release()
  }
}
