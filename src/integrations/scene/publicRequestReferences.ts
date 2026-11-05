/** 只读取公共请求的正式引用字段，采用迭代遍历以兼容深层动作配置。 */
export function assertNoPublicRequestReferences(value: unknown, deleted: ReadonlySet<string>) {
  if (!deleted.size) return
  const pending = [value]
  const visited = new WeakSet<object>()
  while (pending.length) {
    const item = pending.pop()
    if (!item || typeof item !== 'object' || visited.has(item)) continue
    visited.add(item)
    if (Array.isArray(item)) {
      for (const entry of item) pending.push(entry)
      continue
    }
    for (const [key, field] of Object.entries(item)) {
      if ((key === 'publicRequestId' || key === 'publicRequestKey') && typeof field === 'string' && deleted.has(field)) {
        throw new Error('公共接口仍被其他请求项或场景配置引用，请先解除绑定')
      }
      if (field && typeof field === 'object') pending.push(field)
    }
  }
}
