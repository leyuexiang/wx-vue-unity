type ReferenceRecord = Record<string, unknown>
const isRecord = (value: unknown): value is ReferenceRecord => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const directKeys = new Set(['actionTargetUuid', 'observationTargetUuid', 'sourceModelValue', 'targetModelValue'])

/** 只遍历已约定的实例引用字段，二维目标、资源编号和普通文本不参与重写。 */
export function visitThreeDObjectReferences(
  value: unknown,
  visit: (record: ReferenceRecord, key: string, id: string) => boolean,
): boolean {
  const pending = [value]
  const visited = new WeakSet<object>()
  const check = (record: ReferenceRecord, key: string) => {
    const id = record[key]
    return typeof id === 'string' && visit(record, key, id)
  }
  while (pending.length) {
    const item = pending.pop()
    if (!item || typeof item !== 'object' || visited.has(item)) continue
    visited.add(item)
    if (Array.isArray(item)) {
      for (const entry of item) pending.push(entry)
      continue
    }
    if (!isRecord(item)) continue
    for (const [key, field] of Object.entries(item)) {
      if (directKeys.has(key) && check(item, key)) return true
      if ((key === 'targets' || key === 'observationTargets') && Array.isArray(field)) {
        if (field.some((target) => isRecord(target) && target.domain === 'threeD' && check(target, 'instanceId'))) return true
      }
      if (key === 'parameterSource' && isRecord(field) && field.kind === 'object' && check(field, 'id')) return true
      if (field && typeof field === 'object') pending.push(field)
    }
  }
  return false
}
