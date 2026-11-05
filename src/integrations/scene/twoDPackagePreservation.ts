import type { SceneFourPackagePayload } from './sceneFourPackage'
import type { SceneSaveEdits } from '@/scene-platform/core/sceneSaveEdits'
import { attachDataBindingOverflow, mergeDataBindingOverflow, SERVER_PERSISTED_DATA_BINDING_LIMIT } from './dataBindingOverflow'
import { visitThreeDObjectReferences } from './threeDObjectReferences'
import { assertNoPublicRequestReferences } from './publicRequestReferences'
import {
  isEditableBehaviorRecord, isRecord, layerIdOf, layerKeyOf, mergeEditedInstanceDependencies,
  mergeEditedTarget, records, targetIdOf, type JsonRecord,
} from './threeDPackageEditMerge'
const isDeletedThreeDOwner = (value: unknown, ids: ReadonlySet<string>) =>
  isRecord(value) && value.domain === 'threeD' && typeof value.instanceId === 'string' && ids.has(value.instanceId)
const parse = (value: string): JsonRecord => {
  const parsed: unknown = JSON.parse(value)
  if (!isRecord(parsed)) throw new Error('场景数据包必须是对象')
  return parsed
}
/** 原始修订只在活动编辑会话保留一份，退出时释放，不进入二维历史或浏览器持久化。 */
const originals = new Map<string, SceneFourPackagePayload>()
export const retainOriginalScenePackages = (sceneId: string, payload: SceneFourPackagePayload) => {
  // 在允许编辑前验证四包整体可解析，不能把损坏数据当作空三维场景。
  for (const value of Object.values(payload)) parse(value)
  originals.set(sceneId, { ...payload })
}
export const releaseOriginalScenePackages = (sceneId: string) => { originals.delete(sceneId) }
export const hasOriginalScenePackages = (sceneId: string) => originals.has(sceneId)

/** 删除公共请求按最终四包复查，包含未加载及尚未接管的原始依赖。 */
export function assertPublicRequestRemovalAllowed(payload: SceneFourPackagePayload, deleted: ReadonlySet<string>) {
  if (!deleted.size) return
  const scene = parse(payload.sceneJson)
  assertNoPublicRequestReferences(scene.sceneActions, deleted)
  assertNoPublicRequestReferences(parse(payload.dependenciesJson), deleted)
  assertNoPublicRequestReferences(parse(payload.threeDJson), deleted)
  assertNoPublicRequestReferences(parse(payload.twoDJson), deleted)
}

/** 判断依赖是否明确且仅属于二维；未知归属必须保全，防止删掉尚未支持的扩展数据。 */
const isTwoDOwner = (value: unknown) => isRecord(value) && value.domain === 'twoD'
const isOnlyTwoD = (value: unknown) => {
  if (!isRecord(value)) return false
  if (Array.isArray(value.owners)) return value.owners.length > 0 && value.owners.every(isTwoDOwner)
  return isTwoDOwner(value.owner) || value.domain === 'twoD'
}
const isGeneratedTwoD = (value: unknown) => isOnlyTwoD(value) ||
  (isRecord(value) && Array.isArray(value.owners) && value.owners.some(isTwoDOwner))

/** 只识别合同中的目标编号，不按名称或任意文本推断引用。 */
export function assertNoDeletedObjectReferences(value: unknown, ids: ReadonlySet<string>, owner: string) {
  if (visitThreeDObjectReferences(value, (_record, _key, id) => ids.has(id))) {
    throw new Error(`${owner}仍引用待删除节点，请先移除引用`)
  }
}

export function assertOriginalThreeDDeletionAllowed(
  sceneId: string,
  ids: ReadonlySet<string>,
  editedHierarchyIds?: ReadonlySet<string>,
  saveEdits?: SceneSaveEdits,
) {
  const original = originals.get(sceneId)
  if (!original) return
  const threeD = parse(original.threeDJson)
  for (const node of [...records(threeD.objects), ...records(threeD.components)]) {
    const id = targetIdOf(node) ?? ''
    if (ids.has(String(node.parentInstanceId ?? '')) && !ids.has(id) && !editedHierarchyIds?.has(id)) {
      throw new Error('原始草稿仍有子节点引用待删除节点，请重新打开场景后重试')
    }
  }
  for (const behavior of records(parse(original.dependenciesJson).behaviors)) {
    if (isTwoDOwner(behavior.owner) || isDeletedThreeDOwner(behavior.owner, ids)) continue
    // 面板已编辑的可回读行为由生成包复查。未接管行为继续按原记录拦截。
    if (isRecord(behavior.owner) && behavior.owner.domain === 'threeD' &&
        typeof behavior.owner.instanceId === 'string' &&
        isEditableBehaviorRecord(behavior, saveEdits?.objects.get(behavior.owner.instanceId))) continue
    assertNoDeletedObjectReferences(behavior, ids, '原始三维草稿中的交互或状态')
  }
}

/** 无法移出未进入逻辑草稿的成员时，保留原图层，避免保存悬空引用。 */
export function assertOriginalObjectLayerDeletionAllowed(
  sceneId: string, layerId: string, draftIds: ReadonlySet<string>, deletedIds: ReadonlySet<string>,
) {
  const original = originals.get(sceneId)
  if (!original) return
  const threeD = parse(original.threeDJson)
  for (const node of [...records(threeD.objects), ...records(threeD.components)]) {
    if (layerKeyOf(node) !== layerId) continue
    const id = targetIdOf(node)
    if (!id || (!draftIds.has(id) && !deletedIds.has(id))) {
      throw new Error('原始图层还有未进入草稿的成员，无法删除该图层')
    }
  }
}

/**
 * 保全尚未接入编辑的原三维域，同时保存本会话新增对象及其当前依赖。
 * Unity 明确接管的原实例可更新变换，其余原实例保留；新增实例按稳定编号识别。
 * 同一资源先保留原三维拥有者，再合并当前二维和新增三维拥有者，避免共享资源丢失或重复登记。
 */
export function preserveUneditedThreeDDomain(
  sceneId: string,
  generated: SceneFourPackagePayload,
  editableTransformIds?: ReadonlySet<string>,
  editableHierarchyIds?: ReadonlySet<string>,
  deletedObjectIds?: ReadonlySet<string>,
  saveEdits?: SceneSaveEdits,
): SceneFourPackagePayload {
  const original = originals.get(sceneId)
  if (!original) return generated
  const before = parse(mergeDataBindingOverflow(original.sceneJson, original.dependenciesJson).dependenciesJson)
  const after = parse(generated.dependenciesJson)
  const originalTwoD = parse(original.twoDJson)
  const generatedTwoD = parse(generated.twoDJson)
  const originalThreeD = parse(original.threeDJson)
  const generatedThreeD = parse(generated.threeDJson)
  const deleted = deletedObjectIds ?? new Set<string>()
  if (deleted.size) assertOriginalThreeDDeletionAllowed(sceneId, deleted, editableHierarchyIds, saveEdits)
  // 两类目标共用编号集合，防止类型分类变化被误判为新增实例；保存时只做线性扫描。
  const targetGroups = ['objects', 'components'] as const
  const originalIds = new Set(targetGroups.flatMap(key => records(originalThreeD[key]).map(targetIdOf)))
  const generatedGroups = targetGroups.map(key => [key, records(generatedThreeD[key])] as const)
  const currentTargets = new Map(generatedGroups.flatMap(([, group]) => group.map(target => [targetIdOf(target), target] as const)))
  const additions = generatedGroups.map(([key, group]) => [key, group
    .filter(target => typeof target.instanceId === 'string' && target.instanceId && !originalIds.has(target.instanceId))] as const)
  const newTargets = additions.flatMap(([, targets]) => targets)
  const newIds = new Set(newTargets.map(target => String(target.instanceId)))
  const threeD: JsonRecord = { ...originalThreeD }
  let targetsChanged = false
  const usedLayerKeys = new Set(newTargets.map(layerKeyOf).filter(Boolean))
  for (const [key, targets] of additions) {
    let groupChanged = false
    // 按字段合并，未知实例字段及未接管目标继续按原始快照保全。
    const originalTargets = Array.isArray(originalThreeD[key])
      ? originalThreeD[key].filter((target) => !isRecord(target) || !deleted.has(targetIdOf(target) ?? '')) : []
    const updated = originalTargets.map(target => {
      if (!isRecord(target)) return target
      const id = targetIdOf(target)
      if (!id) return target
      const current = currentTargets.get(id)
      if (!current) return target
      const editHierarchy = editableHierarchyIds?.has(id) === true
      const transform = current.transform
      const transformChanged = (editHierarchy || editableTransformIds?.has(id)) && isRecord(transform)
        && JSON.stringify(target.transform) !== JSON.stringify(transform)
      const hierarchyChanged = editHierarchy && (target.parentInstanceId !== current.parentInstanceId || target.sortNo !== current.sortNo)
      const fields = saveEdits?.objects.get(id)
      if (!transformChanged && !hierarchyChanged && !fields?.size) return target
      targetsChanged = true
      groupChanged = true
      const updated = fields?.size ? mergeEditedTarget(target, current, fields) : { ...target }
      if (fields?.has('layerId')) usedLayerKeys.add(layerKeyOf(updated))
      if (transformChanged && isRecord(transform)) updated.transform = { ...(isRecord(target.transform) ? target.transform : {}), ...transform }
      if (hierarchyChanged) {
        updated.sortNo = current.sortNo
        if (current.parentInstanceId === undefined) delete updated.parentInstanceId
        else updated.parentInstanceId = current.parentInstanceId
      }
      return updated
    })
    if (targets.length || groupChanged || deleted.size) threeD[key] = [...updated, ...targets]
  }
  // 仅合并新增实例的区块归属和显式删除，原区块扩展及未接管成员继续保留。
  if (deleted.size || newIds.size) {
    const originalStreaming = isRecord(originalThreeD.streaming) ? originalThreeD.streaming : {}
    const generatedStreaming = isRecord(generatedThreeD.streaming) ? generatedThreeD.streaming : {}
    const addedByChunk = new Map<string, { chunk: JsonRecord; ids: string[] }>()
    for (const chunk of records(generatedStreaming.chunks)) {
      if (typeof chunk.id !== 'string' || !Array.isArray(chunk.objectIds)) continue
      const ids = chunk.objectIds.filter((id): id is string => typeof id === 'string' && newIds.has(id))
      if (ids.length) addedByChunk.set(chunk.id, { chunk, ids })
    }
    const originalChunks = Array.isArray(originalStreaming.chunks) ? originalStreaming.chunks : []
    const chunks = originalChunks.flatMap((chunk) => {
      if (!isRecord(chunk)) return [chunk]
      const chunkId = typeof chunk.id === 'string' ? chunk.id : undefined
      const added = chunkId === undefined ? undefined : addedByChunk.get(chunkId)?.ids
      if (added && chunkId !== undefined) addedByChunk.delete(chunkId)
      if (!added && !Array.isArray(chunk.objectIds)) return [chunk]
      const beforeIds = Array.isArray(chunk.objectIds) ? chunk.objectIds : []
      const retained = deleted.size ? beforeIds.filter((id) => typeof id !== 'string' || !deleted.has(id)) : beforeIds
      if (!added && retained.length === beforeIds.length) return [chunk]
      const objectIds = added ? [...new Set([...retained, ...added])] : retained
      return objectIds.length ? [{ ...chunk, objectIds }] : []
    })
    const newGroupIds = new Set<unknown>()
    for (const { chunk, ids } of addedByChunk.values()) {
      chunks.push({ ...chunk, objectIds: ids })
      if (typeof chunk.streamingGroupId === 'string') newGroupIds.add(chunk.streamingGroupId)
    }
    if (Array.isArray(originalStreaming.chunks) || chunks.length) {
      const originalGroups = Array.isArray(originalStreaming.groups) ? originalStreaming.groups : []
      for (const group of originalGroups) if (isRecord(group)) newGroupIds.delete(group.id)
      // 新区块不能引用不存在的分组；只补齐该批新增成员实际用到的定义。
      const newGroups = records(generatedStreaming.groups).filter((group) => newGroupIds.has(group.id))
      threeD.streaming = {
        ...originalStreaming, chunks,
        ...(newGroups.length ? { groups: [...originalGroups, ...newGroups] } : {}),
      }
    }
  }
  const originalLayers = Array.isArray(originalThreeD.layers) ? originalThreeD.layers : []
  const currentLayers = new Map(records(generatedThreeD.layers).map(layer => [layerIdOf(layer), layer]))
  const originalLayerKeys = new Set(records(originalLayers).map(layerIdOf))
  const removedLayers = new Set<string>()
  let layersChanged = false
  const layers = originalLayers.flatMap((layer) => {
    if (!isRecord(layer)) return [layer]
    const id = layerIdOf(layer)
    if (!id || (layer.layerType ?? layer.type) !== 'object') return [layer]
    const fields = saveEdits?.layers.get(id)
    if (!fields?.size) return [layer]
    const current = currentLayers.get(id)
    if (!current && fields.has('presence')) {
      removedLayers.add(id)
      layersChanged = true
      return []
    }
    if (!current) return [layer]
    const updated = { ...layer }
    for (const field of ['name', 'visible', 'locked', 'order'] as const) {
      if (!fields.has(field)) continue
      const key = field === 'order' ? 'sortNo' : field
      if (layer[key] !== current[key]) {
        layersChanged = true
        updated[key] = current[key]
      }
    }
    return [updated]
  })
  const newLayerKeys = new Set<string>()
  for (const [id, layer] of currentLayers) {
    if (!id || originalLayerKeys.has(id) ||
        (!usedLayerKeys.has(id) && !saveEdits?.layers.get(id)?.size)) continue
    layers.push(layer)
    newLayerKeys.add(id)
    layersChanged = true
  }
  if (removedLayers.size) {
    for (const node of [...records(threeD.objects), ...records(threeD.components)]) {
      if (removedLayers.has(layerKeyOf(node) ?? '')) {
        throw new Error('删除的图层仍被原始节点引用，请先移出该图层的全部成员')
      }
    }
  }
  if (layersChanged) threeD.layers = layers
  const isLayerOwner = (value: unknown, ids: ReadonlySet<string>) =>
    isRecord(value) && value.domain === 'threeD' && value.ownerType === 'layer' &&
    typeof value.ownerKey === 'string' && ids.has(value.ownerKey)
  const isRemovedOwner = (value: unknown) => isDeletedThreeDOwner(value, deleted) || isLayerOwner(value, removedLayers)
  const isCurrentOwner = (value: unknown) => isTwoDOwner(value) ||
    isLayerOwner(value, newLayerKeys) ||
    (isRecord(value) && value.domain === 'threeD' && newIds.has(String(value.instanceId)))
  const isGeneratedCurrent = (value: unknown) => isGeneratedTwoD(value) ||
    (isRecord(value) && (isCurrentOwner(value.owner) ||
      (Array.isArray(value.owners) && value.owners.some(isCurrentOwner))))
  // 保留仍存在实例上的扩展字段；已删除部件不能因原始快照保全而复活。
  const originalComponents = new Map((Array.isArray(originalTwoD.components) ? originalTwoD.components : [])
    .filter(isRecord).map(component => [String(component.instanceId), component]))
  const components = (Array.isArray(generatedTwoD.components) ? generatedTwoD.components : [])
    .map(component => isRecord(component) ? { ...originalComponents.get(String(component.instanceId)), ...component } : component)
  const merged: JsonRecord = { ...before, ...after }
  for (const key of ['resources', 'dataBindings', 'behaviors', 'deviceBindings'] as const) {
    const retained = (Array.isArray(before[key]) ? before[key] : [])
      .filter(value => !isOnlyTwoD(value) && (!isRecord(value) || !isRemovedOwner(value.owner)))
    const current = (Array.isArray(after[key]) ? after[key] : []).filter(isGeneratedCurrent)
    if (key !== 'resources') {
      const edited = saveEdits?.objects.size
        ? mergeEditedInstanceDependencies(key, retained, records(after[key]).filter(value => !isGeneratedCurrent(value)), saveEdits.objects)
        : retained
      merged[key] = [...edited, ...current]
      continue
    }
    const resources = new Map<string, JsonRecord>()
    const removedOwnerResources = new Set<string>()
    for (const item of retained) {
      if (!isRecord(item)) throw new Error('无法无损保存资源依赖')
      const owners = Array.isArray(item.owners)
        ? item.owners.filter(owner => !isTwoDOwner(owner) && !isRemovedOwner(owner)) : undefined
      const resourceKey = String(item.resourceKey)
      if (Array.isArray(item.owners) && item.owners.some(isRemovedOwner)) {
        removedOwnerResources.add(resourceKey)
      }
      resources.set(resourceKey, { ...item, ...(owners ? { owners } : {}) })
    }
    for (const item of current) {
      if (!isRecord(item)) continue
      const key = String(item.resourceKey)
      const existing = resources.get(key)
      const owners = Array.isArray(item.owners) ? item.owners.filter(isCurrentOwner) : []
      resources.set(key, { ...(existing ?? item), owners: [...(Array.isArray(existing?.owners) ? existing.owners : []), ...owners] })
    }
    merged[key] = [...resources].filter(([resourceKey, item]) =>
      !removedOwnerResources.has(resourceKey) || (Array.isArray(item.owners) && item.owners.length > 0))
      .map(([, item]) => item)
  }
  const scene = { ...parse(original.sceneJson), ...parse(generated.sceneJson) }
  if (deleted.size) {
    assertNoDeletedObjectReferences(merged.behaviors, deleted, '保存草稿中的交互或状态')
    assertNoDeletedObjectReferences(scene.sceneActions, deleted, '保存草稿中的场景动作')
  }
  // 原档和新数据合并后重新计算绑定尾部，避免服务端截断时复活已删除的旧绑定。
  const dataBindings = Array.isArray(merged.dataBindings) ? merged.dataBindings : []
  if (isRecord(scene.metadata) || dataBindings.length > SERVER_PERSISTED_DATA_BINDING_LIMIT) {
    scene.metadata = attachDataBindingOverflow({
      scene: { metadata: isRecord(scene.metadata) ? scene.metadata : {} },
      dependencies: { dataBindings },
    }).scene.metadata
  }
  const result = {
    sceneJson: JSON.stringify(scene),
    threeDJson: newIds.size || targetsChanged || layersChanged || deleted.size ? JSON.stringify(threeD) : original.threeDJson,
    twoDJson: JSON.stringify({ ...originalTwoD, ...generatedTwoD, components }),
    dependenciesJson: JSON.stringify(merged),
  }
  const requestKey = (record: JsonRecord) => String(record.publicRequestKey ?? record.requestKey ?? record.id ?? '')
  const currentRequestKeys = new Set(records(scene.publicRequests).map(requestKey))
  const removedRequestKeys = new Set(records(parse(original.sceneJson).publicRequests)
    .map(requestKey).filter(key => key && !currentRequestKeys.has(key)))
  assertPublicRequestRemovalAllowed(result, removedRequestKeys)
  return result
}
