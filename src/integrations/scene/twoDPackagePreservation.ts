import { hasWeatherProvider } from '@/scene-platform/effects/weather'
import { CURRENT_VEGETATION_SCHEMA_VERSION } from '@/scene-platform/core/vegetation'
import { projectThreeDObjectForCopyCheck, type SceneFourPackagePayload } from './sceneFourPackage'
import type { SceneStore } from '@/scene-platform'
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
/** 四包都是不可变文本，保存捕获后不再读取可能已被重载的会话缓存。 */
export const captureOriginalScenePackages = (sceneId: string) => originals.get(sceneId) ?? null

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

const legacyTargetFields = new Set([
  'id', 'componentType', 'type', 'initialOwnVisible', 'initialEffectiveVisible', 'layerId', 'order', 'resourceKeys',
  'metadata', 'style', 'effect', 'light', 'firstPerson', 'billboard',
])
const owns = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key)

/** 原字段可以是投影的子集。数组须逐项对应，避免把不同的动作或请求视为同一记录。 */
function containsOriginalCopyData(original: unknown, projected: unknown, compareValues = true): boolean {
  const pending: Array<[unknown, unknown]> = [[original, projected]]
  while (pending.length) {
    const [before, after] = pending.pop()!
    if (before === after) continue
    if (Array.isArray(before) && Array.isArray(after) && before.length === after.length) {
      before.forEach((value, index) => pending.push([value, after[index]]))
    } else if (isRecord(before) && isRecord(after)) {
      for (const [key, value] of Object.entries(before)) {
        if (!owns(after, key)) return false
        pending.push([value, after[key]])
      }
    } else if (compareValues || before === null || after === null ||
      typeof before === 'object' || typeof before !== typeof after) return false
  }
  return true
}

/** 未投影的原档字段或依赖必须在分配副本前拒绝，源记录由既有保存保全。 */
export function assertOriginalThreeDCopyAllowed(store: SceneStore, ids: ReadonlySet<string>) {
  const sceneId = store.getScene().id
  const original = originals.get(sceneId)
  if (!original) return
  const threeD = parse(original.threeDJson)
  const originalIds = new Set<string>()
  const dependencies = parse(mergeDataBindingOverflow(original.sceneJson, original.dependenciesJson).dependenciesJson)
  const projections = new Map<string, ReturnType<typeof projectThreeDObjectForCopyCheck>>()
  const verifiedDependencies = new Set<unknown>()
  const getProjection = (id: string) => {
    let value = projections.get(id)
    if (!value) {
      value = projectThreeDObjectForCopyCheck(store.getObject(id)!, sceneId)
      projections.set(id, value)
    }
    return value
  }
  const reject = (id: string) => {
    throw new Error(`节点「${store.getObject(id)?.name ?? id}」含有无法完整复制的原档扩展或依赖`)
  }
  for (const target of [...records(threeD.objects), ...records(threeD.components)]) {
    const id = targetIdOf(target)
    if (!id) continue
    originalIds.add(id)
    if (!ids.has(id)) continue
    const projected = getProjection(id).target
    if (Object.keys(target).some((key) => !owns(projected, key) && !legacyTargetFields.has(key) &&
      key !== 'layerKey' && key !== 'parentInstanceId')) reject(id)
    const rawContent = typeof target.contentJson === 'string' ? parse(target.contentJson) : target.contentJson
    const currentContent = projected.contentJson
    if (rawContent != null && !containsOriginalCopyData(rawContent, currentContent)) reject(id)
    for (const key of ['metadata', 'style', 'effect', 'light', 'firstPerson', 'billboard'] as const) {
      if (target[key] != null && !containsOriginalCopyData(target[key], currentContent[key])) reject(id)
    }
    if (target.transform != null && !containsOriginalCopyData(target.transform, projected.transform, false)) reject(id)
    const resourceKeys = target.resourceRefKeys ?? target.resourceKeys
    if (Array.isArray(resourceKeys) && resourceKeys.some((key) => !projected.resourceRefKeys.includes(String(key)))) reject(id)
  }
  for (const [kind, group] of Object.entries(dependencies)) {
    for (const record of records(group)) {
      const owners = Array.isArray(record.owners) ? [...record.owners, record.owner] : [record.owner]
      for (const owner of owners) {
        if (!isRecord(owner) || owner.domain !== 'threeD' || typeof owner.instanceId !== 'string' || !ids.has(owner.instanceId)) continue
        const id = owner.instanceId
        const projected = getProjection(id)
        if (kind === 'resources' && projected.target.resourceRefKeys.includes(String(record.resourceKey)) &&
          Object.keys(owner).every((key) => ['domain', 'ownerType', 'instanceId'].includes(key))) continue
        if (kind === 'dataBindings' || kind === 'behaviors' || kind === 'deviceBindings') {
          const match = projected[kind].find((candidate) =>
            !verifiedDependencies.has(candidate) && containsOriginalCopyData(record, candidate))
          if (match) {
            verifiedDependencies.add(match)
            continue
          }
        }
        reject(id)
      }
    }
  }
  return originalIds
}

export function assertOriginalThreeDDeletionAllowed(
  sceneId: string,
  ids: ReadonlySet<string>,
  editedHierarchyIds?: ReadonlySet<string>,
  saveEdits?: SceneSaveEdits,
  original = captureOriginalScenePackages(sceneId),
) {
  if (!original) return
  const threeD = parse(original.threeDJson)
  for (const node of [...records(threeD.objects), ...records(threeD.components)]) {
    const id = targetIdOf(node) ?? ''
    if (ids.has(String(node.parentInstanceId ?? '')) && !ids.has(id) && !editedHierarchyIds?.has(id)) {
      throw new Error('原始草稿仍有子节点引用待删除节点，请重新打开场景后重试')
    }
    if (ids.has(id)) continue
    const edited = saveEdits?.objects.get(id)
    const content = typeof node.contentJson === 'string' ? parse(node.contentJson) : node.contentJson
    const withoutEditedMetadata = (value: unknown) => {
      if (!isRecord(value) || !edited?.size) return value
      const metadata = { ...value }
      for (const key of ['statusList', 'interactiveEvent', 'dataConfig', 'deviceBinding'] as const) {
        if (edited.has(key)) delete metadata[key]
      }
      return metadata
    }
    assertNoDeletedObjectReferences({
      ...node,
      metadata: withoutEditedMetadata(node.metadata),
      contentJson: isRecord(content) ? { ...content, metadata: withoutEditedMetadata(content.metadata) } : content,
    }, ids, '原始三维实例扩展')
  }
  const dependencies = parse(mergeDataBindingOverflow(original.sceneJson, original.dependenciesJson).dependenciesJson)
  for (const [kind, group] of Object.entries(dependencies)) {
    const managed = kind === 'behaviors' || kind === 'dataBindings' || kind === 'deviceBindings' || kind === 'resources'
    for (const record of records(group)) {
      if (!managed && (isDeletedThreeDOwner(record.owner, ids) ||
        (Array.isArray(record.owners) && record.owners.some((owner) => isDeletedThreeDOwner(owner, ids))))) {
        throw new Error('待删除节点拥有未接管的原档依赖，无法安全删除')
      }
      if (isTwoDOwner(record.owner) || (managed && isDeletedThreeDOwner(record.owner, ids))) continue
      if (kind !== 'resources' && Array.isArray(record.owners) && record.owners.some((owner) => isDeletedThreeDOwner(owner, ids))) {
        throw new Error('待删除节点拥有未接管的共享依赖，无法安全删除')
      }
      // 面板已编辑的可回读行为由生成包复查，其他原始依赖按原记录校验。
      if (kind === 'behaviors' && isRecord(record.owner) && record.owner.domain === 'threeD' &&
        typeof record.owner.instanceId === 'string' &&
        isEditableBehaviorRecord(record, saveEdits?.objects.get(record.owner.instanceId))) continue
      assertNoDeletedObjectReferences(record, ids, '原始三维草稿中的依赖')
    }
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
// 兼容包中的未知对象字段随已确认编辑合并，数组的删除和顺序由调用方按业务身份处理。
const mergeRecords = (original: unknown, current: unknown): JsonRecord => ({
  ...(isRecord(original) ? original : {}),
  ...Object.fromEntries(Object.entries(isRecord(current) ? current : {}).map(([key, value]) => [
    key, isRecord(value) && isRecord(original) && isRecord(original[key])
      ? mergeRecords(original[key], value) : value,
  ])),
})

const rowId = (row: unknown) => isRecord(row) && typeof row.id === 'string' ? row.id : undefined
const mergeOrderedRows = (original: unknown, current: unknown, merge = mergeRecords): unknown[] => {
  const previous = Array.isArray(original) ? original : []
  const byId = new Map(previous.map(row => [rowId(row), row]))
  const next = Array.isArray(current) ? current : []
  return [...next.map(row => {
    const id = rowId(row)
    return id ? merge(byId.get(id), row) : row
  }), ...previous.filter(row => !rowId(row))]
}

const isGisLayer = (value: unknown): value is JsonRecord => isRecord(value) &&
  ['imagery', 'terrain', 'tileset', 'vector'].includes(String(value.layerType ?? value.type))

const isWeatherEffect = (value: unknown): value is JsonRecord => isRecord(value) && value.type === 'weather'

export function preserveUneditedThreeDDomain(
  sceneId: string,
  generated: SceneFourPackagePayload,
  editableTransformIds?: ReadonlySet<string>,
  editableHierarchyIds?: ReadonlySet<string>,
  deletedObjectIds?: ReadonlySet<string>,
  saveEdits?: SceneSaveEdits,
  original = captureOriginalScenePackages(sceneId),
): SceneFourPackagePayload {
  if (!original) return generated
  const before = parse(mergeDataBindingOverflow(original.sceneJson, original.dependenciesJson).dependenciesJson)
  const after = parse(generated.dependenciesJson)
  const originalTwoD = parse(original.twoDJson)
  const generatedTwoD = parse(generated.twoDJson)
  const originalThreeD = parse(original.threeDJson)
  const generatedThreeD = parse(generated.threeDJson)
  const deleted = deletedObjectIds ?? new Set<string>()
  if (deleted.size) assertOriginalThreeDDeletionAllowed(sceneId, deleted, editableHierarchyIds, saveEdits, original)
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
  const domains = saveEdits?.domains
  const editedEffects = saveEdits?.effects
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
  if (domains?.has('settings')) threeD.baseConfig = mergeRecords(originalThreeD.baseConfig, generatedThreeD.baseConfig)
  const originalBase = isRecord(originalThreeD.baseConfig) ? originalThreeD.baseConfig : {}
  const generatedBase = isRecord(generatedThreeD.baseConfig) ? generatedThreeD.baseConfig : {}
  const gisChanged = domains?.has('gis') === true
  const originalGisLayerIds = new Set<string>()
  const currentGisLayerIds = new Set<string>()
  if (gisChanged) {
    const baseConfig = isRecord(threeD.baseConfig) ? threeD.baseConfig : {}
    const settings = isRecord(baseConfig.settings) ? { ...baseConfig.settings } : {}
    const three = isRecord(settings.three) ? { ...settings.three } : {}
    const nextSettings = isRecord(generatedBase.settings) ? generatedBase.settings : {}
    const nextThree = isRecord(nextSettings.three) ? nextSettings.three : {}
    if (nextThree.gis === undefined) delete three.gis
    else three.gis = nextThree.gis
    if (Object.keys(three).length) settings.three = three
    else delete settings.three
    const currentGisLayers = records(generatedBase.gisLayers).filter(isGisLayer)
    const mergeGisLayers = (original: unknown) => {
      const previousById = new Map<string, JsonRecord>()
      const preserved = (Array.isArray(original) ? original : []).filter(layer => {
        const id = isGisLayer(layer) ? layerIdOf(layer) : undefined
        if (!id) return true
        previousById.set(id, layer)
        originalGisLayerIds.add(id)
        return false
      })
      return [...preserved, ...currentGisLayers.map(layer => {
        const id = layerIdOf(layer)
        if (!id) return layer
        currentGisLayerIds.add(id)
        const previous = previousById.get(id)
        const merged = { ...previous, ...layer }
        const sourceChanged = previous?.url !== layer.url || previous?.provider !== layer.provider ||
          JSON.stringify(previous?.resourceRefKeys) !== JSON.stringify(layer.resourceRefKeys)
        if (sourceChanged) {
          for (const field of ['url', 'resourceRefKeys', 'options', 'metadata'] as const) {
            if (!(field in layer)) delete merged[field]
          }
        }
        return merged
      })]
    }
    threeD.baseConfig = {
      ...baseConfig, settings,
      coordinateSystem: mergeRecords(baseConfig.coordinateSystem, generatedBase.coordinateSystem),
      gisLayers: mergeGisLayers(originalBase.gisLayers),
    }
    threeD.layers = mergeGisLayers(originalThreeD.layers)
  }
  const originalEffects = Array.isArray(originalThreeD.effects) ? originalThreeD.effects : []
  const weatherChanged = ((hasWeatherProvider(originalBase.weather) || hasWeatherProvider(generatedBase.weather)) &&
    JSON.stringify(originalBase.weather) !== JSON.stringify(generatedBase.weather)) ||
    originalEffects.some(effect => isWeatherEffect(effect) && hasWeatherProvider(effect.params) &&
      JSON.stringify(effect.params) !== JSON.stringify(generatedBase.weather))
  if (weatherChanged) {
    threeD.baseConfig = { ...(isRecord(threeD.baseConfig) ? threeD.baseConfig : {}), weather: generatedBase.weather ?? {} }
  }
  if (domains?.has('cameraPaths')) {
    threeD.cameraPaths = mergeOrderedRows(originalThreeD.cameraPaths, generatedThreeD.cameraPaths, (before, after) => {
      const path = mergeRecords(before, after)
      if (isRecord(after) && Array.isArray(after.waypoints))
        path.waypoints = mergeOrderedRows(isRecord(before) ? before.waypoints : undefined, after.waypoints)
      return path
    })
  }
  const vegetation = generatedThreeD.vegetation
  const vegetationChanged = domains?.has('vegetation') === true ||
    (isRecord(vegetation) && vegetation.schemaVersion === CURRENT_VEGETATION_SCHEMA_VERSION &&
      JSON.stringify(originalThreeD.vegetation) !== JSON.stringify(vegetation))
  if (vegetationChanged) {
    if (generatedThreeD.vegetation === undefined) delete threeD.vegetation
    else threeD.vegetation = mergeRecords(originalThreeD.vegetation, generatedThreeD.vegetation)
  }
  if (domains?.has('streamingPolicy')) {
    const before = isRecord(threeD.streaming) ? threeD.streaming : {}
    const after = isRecord(generatedThreeD.streaming) ? generatedThreeD.streaming : {}
    const streaming = mergeRecords(before, after)
    if (after.options === undefined) delete streaming.options
    for (const key of ['groups', 'chunks'] as const)
      streaming[key] = mergeOrderedRows(before[key], after[key])
    threeD.streaming = streaming
  }
  if (editedEffects?.size || (weatherChanged && Array.isArray(originalThreeD.effects))) {
    const after = new Map(records(generatedThreeD.effects).map(effect => [rowId(effect), effect]))
    const effects = originalEffects.flatMap(effect => {
      const id = rowId(effect)
      if (!id || !editedEffects?.has(id)) {
        return weatherChanged && isWeatherEffect(effect) ? [] : [effect]
      }
      const next = after.get(id)
      after.delete(id)
      if (!next) return []
      const merged = mergeRecords(effect, next)
      if (!Array.isArray(next.assetRefs)) delete merged.assetRefs
      return [merged]
    })
    for (const id of editedEffects ?? []) {
      const next = after.get(id)
      if (next) effects.push(next)
    }
    threeD.effects = effects
  }
  const originalLayers = Array.isArray(threeD.layers) ? threeD.layers : []
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
  const isEditedEffectOwner = (value: unknown) => isRecord(value) && value.domain === 'threeD' &&
    value.ownerType === 'effect' && typeof value.ownerKey === 'string' && editedEffects?.has(value.ownerKey)
  const isVegetationOwner = (value: unknown) => vegetationChanged && isRecord(value) && value.domain === 'threeD' &&
    value.ownerType === 'vegetation-native-species'
  const isRemovedOwner = (value: unknown) => isDeletedThreeDOwner(value, deleted) ||
    isLayerOwner(value, removedLayers) || isEditedEffectOwner(value) || isVegetationOwner(value) ||
    (gisChanged && isLayerOwner(value, originalGisLayerIds))
  const isCurrentOwner = (value: unknown) => isTwoDOwner(value) ||
    isLayerOwner(value, newLayerKeys) || isEditedEffectOwner(value) || isVegetationOwner(value) ||
    (gisChanged && isLayerOwner(value, currentGisLayerIds)) ||
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
  const originalScene = parse(original.sceneJson)
  const generatedScene = parse(generated.sceneJson)
  const scene: JsonRecord = { ...originalScene, ...generatedScene,
    ...(isRecord(originalScene.metadata) || isRecord(generatedScene.metadata)
      ? { metadata: mergeRecords(originalScene.metadata, generatedScene.metadata) } : {}) }
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
    threeDJson: newIds.size || targetsChanged || layersChanged || deleted.size || domains?.size || editedEffects?.size ||
      weatherChanged || vegetationChanged
      ? JSON.stringify(threeD) : original.threeDJson,
    twoDJson: JSON.stringify({ ...originalTwoD, ...generatedTwoD, components,
      ...(isRecord(originalTwoD.canvas) || isRecord(generatedTwoD.canvas)
        ? { canvas: mergeRecords(originalTwoD.canvas, generatedTwoD.canvas) } : {}) }),
    dependenciesJson: JSON.stringify(merged),
  }
  const requestKey = (record: JsonRecord) => String(record.publicRequestKey ?? record.requestKey ?? record.id ?? '')
  const currentRequestKeys = new Set(records(scene.publicRequests).map(requestKey))
  const removedRequestKeys = new Set(records(parse(original.sceneJson).publicRequests)
    .map(requestKey).filter(key => key && !currentRequestKeys.has(key)))
  assertPublicRequestRemovalAllowed(result, removedRequestKeys)
  return result
}
