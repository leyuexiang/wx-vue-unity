/**
 * 实例配置在领域对象metadata中保存一份，Unity properties和四包只是同一配置的投影。
 * 名称以领域对象为准；不修改源配置、不按同名模型或资源键猜测身份。
 */
const record = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是对象`)
  return value as Record<string, unknown>
}

export const projectInstanceDefinition = (
  value: unknown,
  target: { instanceId: string; resourceId: string; name: string; sceneId?: string },
): Record<string, unknown> | undefined => {
  if (value === undefined) return undefined
  const definition = record(value, '实例配置')
  if (definition.schemaVersion !== 'jtyf.instance-definition.v1') throw new Error('实例配置版本不受支持')
  const identity = record(definition.identity, '实例身份')
  if (identity.instanceType !== 'Model' || identity.instanceId !== target.instanceId ||
      typeof identity.sceneId !== 'string' || !identity.sceneId.trim() ||
      (target.sceneId !== undefined && identity.sceneId !== target.sceneId)) {
    throw new Error('实例配置与当前对象身份不一致')
  }
  const resource = record(definition.resource, '实例资源')
  if (typeof resource.resourceId !== 'string' || !/^[1-9][0-9]{0,18}$/.test(resource.resourceId) || resource.resourceId !== target.resourceId) {
    throw new Error('实例配置与模型资源身份不一致')
  }
  const pages = record(definition.pages, '实例页签')
  const base = record(pages.base, '基础配置')
  const data = record(pages.data, '数据配置')
  if (!Array.isArray(data.bindings)) throw new Error('数据绑定必须是数组')
  for (const item of data.bindings) {
    const binding = record(item, '数据绑定')
    if (!Array.isArray(binding.fields)) throw new Error('绑定字段必须是数组')
    for (const item of binding.fields) {
      if (Object.prototype.hasOwnProperty.call(record(item, '绑定字段'), 'value')) throw new Error('数据绑定定义不能保存实时测量值')
    }
  }
  // 仅复制修改路径，其余未知JSON仍由既有四包纯数据校验与复制边界保留。
  return { ...definition, pages: { ...pages, base: { ...base, name: target.name } } }
}
