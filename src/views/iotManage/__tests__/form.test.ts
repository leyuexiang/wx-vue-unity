import { expect, it } from 'vitest'
import { validateIotForm, formatIotTime } from '../form'
const connector = { connectorId: 'a', name: '测试', connectorType: 'MQTT' as const,
  endpoint: 'ssl://broker.invalid:8883', credentialRef: 'IOT_MQTT_TEST',
  configJson: '{"topics":["a/b"],"qos":1}' }
it('编辑必须保留服务端版本，MQTT不接受密码、通配主题或非QoS1', () => {
  expect(validateIotForm('connectors', connector)).toBe('')
  expect(validateIotForm('connectors', { ...connector, id: '1' })).toContain('版本')
  for (const configJson of ['{"topics":["#"],"qos":1}', '{"topics":["a"],"qos":0}',
    '{"topics":["a"],"qos":1,"password":"secret"}']) {
    expect(validateIotForm('connectors', { ...connector, configJson })).not.toBe('')
  }
})
it('映射数字参数保持JSON数字，拒绝无效结构而不重写数值文本', () => {
  const binding = { connectorId: 'a', externalDeviceId: 'b', mappingRevision: 'v1' }
  expect(validateIotForm('bindings', { ...binding, pointMappingJson: '{"points":{"a":{"scale":0.1234567890123456789}}}' })).toBe('')
  for (const pointMappingJson of ['[]', '{"points":[]}', '{"points":{"a":{"scale":"1"}}}',
    '{"points":{"a":{"valueType":"wrong"}}}']) {
    expect(validateIotForm('bindings', { ...binding, pointMappingJson })).not.toBe('')
  }
})
it('后端毫秒时间戳与ISO日期都可显示，缺失观测不伪造当前时间', () => {
  expect(formatIotTime(undefined)).toBe('—')
  expect(formatIotTime('invalid')).toBe('—')
  expect(formatIotTime(1794268800000)).toContain('2026')
})
