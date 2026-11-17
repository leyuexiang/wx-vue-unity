import type { IotRow } from '@/servers/manual/iot/api'

/** 只验证配置，不把解析后的浮点数写回文本，保留十进制映射参数的原始精度。 */
export function validateIotForm(kind: 'connectors' | 'bindings', form: Partial<IotRow>): string {
  const required = (value: unknown, max: number) => typeof value === 'string' && !!value.trim() && value.length <= max
  if (!required(form.connectorId, 64)) return '请填写不超过64个字符的连接器编号'
  if (kind === 'connectors') {
    if (!required(form.name, 128)) return '请填写不超过128个字符的连接器名称'
    if (!['MQTT', 'HTTPS', 'MOCK'].includes(form.connectorType ?? '')) return '请选择协议类型'
    if (form.id && (!Number.isInteger(form.version) || (form.version ?? 0) < 1)) return '配置版本缺失，请重新读取详情'
    if ((form.endpoint?.length ?? 0) > 512 || (form.credentialRef?.length ?? 0) > 128) return '服务地址或凭据引用过长'
    if ((form.configJson?.length ?? 0) > 65536) return '协议配置不能超过65536个字符'
    if (form.connectorType === 'MQTT') {
      if (!required(form.endpoint, 512) || !/^IOT_MQTT_[A-Z0-9_]+$/.test(form.credentialRef ?? '')) return '请填写服务地址及有效的MQTT凭据引用'
      try {
        const url = new URL(form.endpoint!)
        if (!['ssl:', 'tcp:'].includes(url.protocol) || !url.hostname || !url.port ||
          url.username || url.password || url.search || url.hash || url.pathname) return 'MQTT地址格式无效，请移除账号、密码与路径'
        const config = JSON.parse(form.configJson ?? '')
        if (!config || Array.isArray(config) || Object.keys(config).some(key => !['topics', 'qos'].includes(key)) ||
          config.qos !== 1 || !Array.isArray(config.topics) || config.topics.length < 1 || config.topics.length > 32 ||
          config.topics.some((topic: unknown) => typeof topic !== 'string' || !topic.trim() ||
            new TextEncoder().encode(topic).length > 512 || /[+#\u0000]/.test(topic))) return 'MQTT仅支持1～32个确切主题、QoS 1，配置不能包含密码'
      } catch { return 'MQTT地址或配置JSON格式无效' }
    } else {
      // HTTPS/MOCK 不新增明文秘密入口；扩展参数仅允许非敏感JSON。
      if (form.configJson?.trim()) {
        try {
          const config = JSON.parse(form.configJson)
          if (!config || typeof config !== 'object' || Array.isArray(config) ||
            /"(?:password|secret|token|authorization)"\s*:/i.test(form.configJson)) return '配置只允许非敏感JSON对象，凭据请使用引用'
        } catch { return '协议配置JSON格式无效' }
      }
    }
    return ''
  }
  if (!required(form.externalDeviceId, 128)) return '请填写不超过128个字符的外部设备编号'
  if (!required(form.mappingRevision, 64)) return '请填写不超过64个字符的映射版本'
  for (const value of [form.deviceId, form.sceneId, form.objectId]) {
    if ((value?.length ?? 0) > 128) return '内部设备、场景和对象编号不能超过128个字符'
  }
  if (!form.pointMappingJson?.trim()) return ''
  if (form.pointMappingJson.length > 65536) return '点位映射不能超过65536个字符'
  try {
    const root = JSON.parse(form.pointMappingJson)
    if (!root || typeof root !== 'object' || Array.isArray(root)) return '点位映射必须是JSON对象'
    if (root.points == null) return ''
    if (typeof root.points !== 'object' || Array.isArray(root.points)) return 'points必须是按点位编码索引的对象'
    for (const [code, value] of Object.entries(root.points)) {
      if (!code.trim() || !value || typeof value !== 'object' || Array.isArray(value)) return '每个点位必须配置为对象'
      const mapping = value as Record<string, unknown>
      for (const field of ['scale', 'offset']) {
        if (mapping[field] != null && (typeof mapping[field] !== 'number' || !Number.isFinite(mapping[field]))) return 'scale和offset必须是JSON数字'
      }
      for (const field of ['pointCode', 'targetUnit', 'valueType']) {
        if (mapping[field] != null && typeof mapping[field] !== 'string') return '点位名称、单位和值类型必须是字符串'
      }
      if (mapping.valueType != null && !['NUMBER', 'BOOLEAN', 'STRING', 'JSON'].includes(String(mapping.valueType).toUpperCase())) return '不支持的点位值类型'
    }
    return ''
  } catch { return '点位映射JSON格式无效' }
}

/** 平台默认返回毫秒时间戳，同时兼容网关保留的ISO字符串；空值不补当前时间。 */
export function formatIotTime(value: string | number | undefined): string {
  if (value === undefined || value === null || value === '') return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { hour12: false })
}
export const IOT_STATUS: Record<string, string> = {
  DISABLED: '已停用', NOT_APPLICABLE: '不适用MQTT观测', UNOBSERVED: '尚未观测',
  LEASE_EXPIRED: '租约已失效', CONNECTED: '已连接', DISCONNECTED: '未连接',
  AUTH_FAILED: '认证失败', ERROR: '运行异常', UNKNOWN: '状态未知',
  CLAIMED: '处理中', PUBLISHED: '已发布', FAILED: '投递失败', DEAD_LETTER: '死信', ARCHIVED: '已归档',
}
