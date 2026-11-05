import type { SceneObjectSaveField } from '@/scene-platform/core/sceneSaveEdits'

export type JsonRecord = Record<string, unknown>
export const isRecord = (value: unknown): value is JsonRecord =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value))
export const records = (value: unknown): JsonRecord[] => Array.isArray(value) ? value.filter(isRecord) : []
const string = (value: unknown) => typeof value === 'string' && value ? value : undefined
const hasOwn = (value: JsonRecord, key: string) => Object.prototype.hasOwnProperty.call(value, key)

export const targetIdOf = (record: JsonRecord) => string(record.instanceId) ?? string(record.id)
export const layerKeyOf = (record: JsonRecord) => string(record.layerKey) ?? string(record.layerId)
export const layerIdOf = (record: JsonRecord) => string(record.layerKey) ?? string(record.id)

function readContent(value: unknown): JsonRecord | undefined {
  if (isRecord(value)) return value
  if (typeof value !== 'string') return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function editedContent(original: unknown, next: JsonRecord) {
  // 字符串载荷保持原格式，避免改变旧消费者读取方式。
  return typeof original === 'string' ? JSON.stringify(next) : next
}

const dependencyMetadataKeys = ['dataConfig', 'statusList', 'interactiveEvent', 'deviceId', 'deviceBinding'] as const

/** 更新实例正文的已编辑字段，清除已迁移到依赖包的同名旧镜像。 */
export function mergeEditedTarget(
  original: JsonRecord,
  generated: JsonRecord,
  fields: ReadonlySet<SceneObjectSaveField>,
): JsonRecord {
  const result = { ...original }
  for (const field of ['name', 'visible', 'locked'] as const) {
    if (fields.has(field)) result[field] = generated[field]
  }
  if (fields.has('order')) result.sortNo = generated.sortNo
  if (fields.has('layerId')) {
    delete result.layerId
    const layer = layerKeyOf(generated)
    if (layer === undefined) delete result.layerKey
    else result.layerKey = layer
  }

  const pickable = fields.has('pickable')
  const legacyKeys = dependencyMetadataKeys.filter((key) =>
    fields.has(key) || (key === 'deviceBinding' && fields.has('deviceId')) ||
    (key === 'deviceId' && fields.has('deviceBinding')))
  if (!pickable && !legacyKeys.length) return result
  const content = readContent(original.contentJson)
  if (original.contentJson != null && !content) throw new Error('实例扩展正文无法解析，不能覆盖原始配置')
  const originalMetadata = isRecord(content?.metadata) ? content.metadata : undefined
  const rootMetadata = isRecord(original.metadata) ? original.metadata : undefined
  if ((content?.metadata != null && !originalMetadata) || (original.metadata != null && !rootMetadata)) {
    throw new Error('实例扩展元数据格式未知，不能覆盖原始配置')
  }
  const generatedContent = readContent(generated.contentJson)
  const generatedMetadata = isRecord(generatedContent?.metadata) ? generatedContent.metadata : {}
  const patch = (metadata: JsonRecord, writePickable: boolean) => {
    const next = { ...metadata }
    for (const key of legacyKeys) delete next[key]
    if (pickable && writePickable) {
      if (typeof generatedMetadata.pickable === 'boolean') next.pickable = generatedMetadata.pickable
      else delete next.pickable
    }
    return next
  }
  if (rootMetadata) result.metadata = patch(rootMetadata, !originalMetadata)
  if (originalMetadata || (pickable && !rootMetadata)) {
    result.contentJson = editedContent(original.contentJson, { ...content, metadata: patch(originalMetadata ?? {}, true) })
  }
  return result
}

export type InstanceDependencyKind = 'dataBindings' | 'behaviors' | 'deviceBindings'
const ownerId = (record: JsonRecord) => {
  const owner = record.owner
  if (!isRecord(owner) || owner.domain !== 'threeD' || (owner.ownerType && owner.ownerType !== 'instance')) return
  return string(owner.instanceId)
}

const recordIsEdited = (kind: InstanceDependencyKind, record: JsonRecord, fields: ReadonlySet<SceneObjectSaveField>) => {
  if (kind === 'dataBindings') return fields.has('dataConfig')
  if (kind === 'deviceBindings') return fields.has('deviceId') || fields.has('deviceBinding')
  return (record.behaviorType === 'status' && fields.has('statusList')) ||
    (record.behaviorType === 'interaction' && fields.has('interactiveEvent'))
}

/** 只替换能在现有面板读回的记录。结构化但无编辑快照的旧记录仍由原档保全。 */
export const isEditableBehaviorRecord = (record: JsonRecord, fields: ReadonlySet<SceneObjectSaveField> | undefined) =>
  Boolean(fields && recordIsEdited('behaviors', record, fields) && isRecord(readContent(record.contentJson)?.legacyConfig))

const dependencyKey = (kind: InstanceDependencyKind, record: JsonRecord, id: string) => {
  if (kind === 'deviceBindings') return id
  const key = kind === 'dataBindings' ? string(record.bindingKey) : string(record.behaviorKey)
  return key === undefined ? undefined : JSON.stringify([id, kind === 'behaviors' ? record.behaviorType : '', key])
}

/** 按稳定编号保留仍存在的条件、动作和条件组上的扩展字段。 */
function mergeKeyedRecords(
  original: unknown, generated: unknown, key: string,
  merge: (previous: JsonRecord, next: JsonRecord) => JsonRecord,
) {
  const byKey = new Map(records(original).map(record => [record[key], record]))
  return records(generated).map(record => {
    const previous = byKey.get(record[key])
    return previous ? merge(previous, record) : record
  })
}

function mergeConditionGroup(previous: JsonRecord, next: JsonRecord) {
  const group = {
    ...previous, ...next,
    conditions: mergeKeyedRecords(previous.conditions, next.conditions, 'conditionKey', (old, current) => ({ ...old, ...current })),
    actions: mergeKeyedRecords(previous.actions, next.actions, 'actionKey', (old, current) => {
      const action = { ...old, ...current }
      if (!hasOwn(current, 'observationTargets')) delete action.observationTargets
      return action
    }),
  }
  if (!hasOwn(next, 'name')) delete (group as JsonRecord).name
  return group
}

function mergeRecord(original: JsonRecord, generated: JsonRecord, kind: InstanceDependencyKind) {
  const result = { ...original, ...generated }
  if (isRecord(original.owner) && isRecord(generated.owner)) result.owner = { ...original.owner, ...generated.owner }
  if (kind === 'deviceBindings') return result
  const priorContent = readContent(original.contentJson)
  const nextContent = readContent(generated.contentJson)
  if (nextContent) result.contentJson = editedContent(original.contentJson, { ...priorContent, ...nextContent })
  if (kind === 'behaviors') {
    if (!hasOwn(generated, 'eventType')) delete result.eventType
    result.conditionGroups = mergeKeyedRecords(
      original.conditionGroups, generated.conditionGroups, 'conditionGroupKey', mergeConditionGroup,
    )
    return result
  }

  // 配置容器的扩展键保留，已编辑的标准子项及可选字段以新快照为准。
  for (const [key, optional] of [
    ['source', 'publicRequestKey'], ['refresh', 'intervalMs'], ['filterConfig', 'filterFn'],
    ['schemaConfig', ''], ['mappingConfig', ''],
  ] as const) {
    const oldValue = original[key]
    const nextValue = generated[key]
    if (!isRecord(oldValue) || !isRecord(nextValue)) continue
    const combined = { ...oldValue, ...nextValue }
    if (optional && !hasOwn(nextValue, optional)) delete combined[optional]
    result[key] = combined
  }
  return result
}

export function mergeEditedInstanceDependencies(
  kind: InstanceDependencyKind,
  retained: unknown[],
  generated: readonly JsonRecord[],
  edits: ReadonlyMap<string, ReadonlySet<SceneObjectSaveField>>,
): unknown[] {
  const remaining = new Map<string, JsonRecord>()
  for (const record of generated) {
    const id = ownerId(record)
    const fields = id ? edits.get(id) : undefined
    if (!id || !fields || !recordIsEdited(kind, record, fields)) continue
    const key = dependencyKey(kind, record, id)
    if (key === undefined) continue
    if (remaining.has(key)) throw new Error('编辑后的实例依赖编号重复，无法合并原档')
    remaining.set(key, record)
  }
  const result: unknown[] = []
  const seenPrimaryDevices = new Set<string>()
  const clearedPrimaryDevices = new Set<string>()
  for (const record of retained) {
    const id = isRecord(record) ? ownerId(record) : undefined
    const fields = id ? edits.get(id) : undefined
    if (!id || !fields || !isRecord(record) || !recordIsEdited(kind, record, fields)) {
      result.push(record)
      continue
    }
    const key = dependencyKey(kind, record, id)
    const replacement = key === undefined ? undefined : remaining.get(key)
    if (kind === 'deviceBindings') {
      if (seenPrimaryDevices.has(id)) {
        if (clearedPrimaryDevices.has(id)) {
          throw new Error('实例有多个设备绑定，无法通过单设备面板清空，请先调整绑定')
        }
        result.push(record)
        continue
      }
      seenPrimaryDevices.add(id)
      if (!replacement) clearedPrimaryDevices.add(id)
    } else {
      const snapshot = kind === 'dataBindings' ? 'requestSnapshot' : 'legacyConfig'
      if (!isRecord(readContent(record.contentJson)?.[snapshot])) {
        if (replacement) throw new Error('实例依赖编号与未接管记录重复，请为新配置使用其他编号')
        result.push(record)
        continue
      }
    }

    if (replacement && key !== undefined) {
      result.push(mergeRecord(record, replacement, kind))
      remaining.delete(key)
    }
    // 已编辑且面板可读的原记录没有对应结果时，表示用户删除了该条配置。
  }
  for (const record of remaining.values()) result.push(record)
  return result
}
