import type { SceneObject, ViewportHost } from '@/scene-platform'
import { createCopySceneSubtreesCommand } from '@/scene-platform/commands/copySceneSubtreesCommand'
import { createSnowflakeId } from '@/utils/snowflakeId'
import { runConfirmedEditorCommand } from './editorSceneCommandTransaction'
import { beginEditorSceneOperation, editorSceneOperation } from './editorSceneOperationGate'
import { getActiveSceneViewportHost } from './editorScenePlatformHost'
import { visitThreeDObjectReferences } from './threeDObjectReferences'
import { assertOriginalThreeDCopyAllowed } from './twoDPackagePreservation'
import { isRecord } from './threeDPackageEditMerge'

const independentReferenceFields = new Set([
  'resourceId', 'resourceKey', 'deviceId', 'bindingKey', 'publicRequestId', 'publicRequestKey', 'actionTargetWidgetIds',
])

/** 只改写有合同的实例引用；不确定的编号要求先处理扩展再复制。 */
function prepareSubtreeCopy(
  copy: SceneObject,
  copies: ReadonlyMap<string, string>,
  source: SceneObject,
  hasInstance: (id: string) => boolean,
) {
  const known = new WeakMap<object, Set<string>>()
  const remember = (record: object, key: string) => {
    let fields = known.get(record)
    if (!fields) known.set(record, fields = new Set())
    fields.add(key)
  }
  const remap = (record: Record<string, unknown>, key: string, id: string) => {
    remember(record, key)
    const copyId = copies.get(id)
    if (copyId !== undefined) record[key] = copyId
    return false
  }
  const metadata = copy.metadata
  visitThreeDObjectReferences(metadata?.statusList, remap)
  visitThreeDObjectReferences(metadata?.interactiveEvent, remap)
  const definition = metadata?.instanceDefinition
  if (definition !== undefined) {
    const identity = isRecord(definition) ? definition.identity : undefined
    if (!isRecord(identity) || identity.instanceId !== source.id) throw new Error('实例配置与源节点编号不一致')
    identity.instanceId = copy.id
    remember(identity, 'instanceId')
    remember(identity, 'sceneId')
    if (isRecord(definition) && isRecord(definition.pages) && isRecord(definition.pages.base)) {
      definition.pages.base.name = copy.name
      remember(definition.pages.base, 'name')
    }
  }
  const deviceBinding = metadata?.deviceBinding
  if (isRecord(deviceBinding) && isRecord(deviceBinding.owner) && deviceBinding.owner.domain === 'threeD') {
    if (deviceBinding.owner.instanceId !== source.id) throw new Error('设备绑定与源节点编号不一致')
    deviceBinding.owner.instanceId = copy.id
    remember(deviceBinding.owner, 'instanceId')
  }
  const pending: unknown[] = [metadata, copy.style, copy.effect, copy.billboard, copy.light]
  const seen = new WeakSet<object>()
  while (pending.length) {
    const value = pending.pop()
    if ((typeof value === 'string' || typeof value === 'number') && hasInstance(String(value))) {
      throw new Error(`节点「${source.name}」的扩展包含未声明的实例引用，无法复制`)
    }
    if (!value || typeof value !== 'object' || seen.has(value)) continue
    seen.add(value)
    for (const [key, field] of Object.entries(value)) {
      if (known.get(value)?.has(key) || independentReferenceFields.has(key) ||
        (key === 'instanceId' && isRecord(value) && value.domain === 'twoD')) continue
      pending.push(field)
    }
  }
}

/** 复制由权威草稿生成；三维投影确认后才登记历史。 */
export async function copyEditorSceneSubtrees(host: ViewportHost, ids: readonly string[]): Promise<boolean> {
  if (!ids.length || editorSceneOperation.value || getActiveSceneViewportHost() !== host) return false
  const store = host.getStore()
  let originalIds: ReadonlySet<string> | undefined
  const command = createCopySceneSubtreesCommand([...ids], createSnowflakeId,
    (copy, copies, source) => prepareSubtreeCopy(copy, copies, source, (id) => Boolean(originalIds?.has(id) || store.getObject(id))),
    (sources) => { originalIds = assertOriginalThreeDCopyAllowed(store, sources) })
  const release = beginEditorSceneOperation('copySceneNodes')
  try {
    return await runConfirmedEditorCommand(host, 'execute', command, () => getActiveSceneViewportHost() === host)
  } finally {
    // 历史只需要已准备的副本，原档编号集合无需随撤销记录保留。
    originalIds = undefined
    release()
  }
}
