import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { authContext } from '@/auth/authContext'
const transport = vi.hoisted(() => vi.fn())
vi.mock('@/request', () => ({ default: transport }))
import { getIotPage, saveIot, iotId, replayIot, getIotState, IotApiError } from '../api'
const login = (permissions = ['*:*:*']) => authContext.set({
  accessToken: 'fake', clientId: 'web', tenantId: '7', platformType: 'tenant', roles: [], permissions,
})
beforeEach(() => { transport.mockReset(); login() })
afterEach(() => authContext.clear())

it('分页使用标准后台路径，保留长编号并拒绝全量分页', async () => {
  transport.mockResolvedValue({ code: 200, data: { list: [{ id: '9007199254740993', connectorId: 'a' }], total: 21 } })
  const result = await getIotPage('bindings', { pageNo: 2, pageSize: 10, enabled: false })
  expect(result.list[0]?.id).toBe('9007199254740993')
  expect(transport).toHaveBeenCalledWith(expect.stringContaining('/admin-api/iot/device-binding/page'), expect.objectContaining({
    skipPlatformPath: true, params: { pageNo: 2, pageSize: 10, enabled: false },
  }))
  await expect(getIotPage('bindings', { pageNo: 1, pageSize: -1 })).rejects.toThrow('分页范围')
  expect(transport).toHaveBeenCalledTimes(1)
  expect(() => iotId(Number.MAX_SAFE_INTEGER + 1)).toThrow('编号')
})
it('只读身份不能从处理器写入或重放', async () => {
  login(['iot:connector:query', 'iot:message-inbox:query'])
  await expect(saveIot('connectors', { connectorId: 'a' })).rejects.toThrow('权限')
  await expect(replayIot('event-1')).rejects.toThrow('权限')
  expect(transport).not.toHaveBeenCalled()
})
it('保存只发送合同字段与原版本，业务冲突按错误返回', async () => {
  transport.mockResolvedValue({ code: 1009001011, msg: '含秘密的服务错误' })
  await expect(saveIot('connectors', {
    id: '4', connectorId: 'a', version: 3, name: '原表单', enabled: true, status: 'CONNECTED',
  })).rejects.toMatchObject({ code: 1009001011, message: expect.stringContaining('表单已保留') })
  expect(transport).toHaveBeenCalledWith(expect.stringContaining('/connector/update'), expect.objectContaining({
    method: 'PUT', data: { id: '4', connectorId: 'a', version: 3, name: '原表单', configJson: '{}' },
  }))
})
it('身份切换后拒绝旧分页结果，不把非200或空封套当成功', async () => {
  let finish!: (value: unknown) => void
  transport.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const pending = getIotPage('connectors', { pageNo: 1, pageSize: 10 })
  authContext.clear()
  finish({ code: 200, data: { list: [], total: 0 } })
  await expect(pending).rejects.toThrow('身份已变化')
  login()
  transport.mockResolvedValue({ code: 0, data: true })
  await expect(replayIot('event-1')).rejects.toBeInstanceOf(IotApiError)
})

it('查询三维点位状态保留快照字段并允许服务端返回空值', async () => {
  transport.mockResolvedValueOnce({ code: 200, data: {
    eventId: 'event-1', schemaVersion: '1.0', eventTime: '2026-11-12T01:00:00Z', tenantId: 7,
    deviceId: 'device-1', pointCode: 'temperature', value: 26.125, valueType: 'NUMBER', quality: 'GOOD',
  } }).mockResolvedValueOnce({ code: 200, data: null })
  await expect(getIotState(' device-1 ', ' temperature ')).resolves.toMatchObject({ value: 26.125 })
  await expect(getIotState('device-1', 'temperature')).resolves.toBeNull()
  expect(transport).toHaveBeenNthCalledWith(1, expect.stringContaining('/admin-api/dimensions/iot-state/get'), expect.objectContaining({
    skipPlatformPath: true, params: { deviceId: 'device-1', pointCode: 'temperature' },
  }))
})

it('状态查询拒绝非法参数、身份切换和跨租户错误', async () => {
  await expect(getIotState('', 'temperature')).rejects.toThrow('不能为空')
  transport.mockResolvedValueOnce({ code: 403, msg: '不要把服务端错误原文回显到页面' })
  await expect(getIotState('device-1', 'temperature')).rejects.toMatchObject({ code: 403 })
  let finish!: (value: unknown) => void
  transport.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const pending = getIotState('device-1', 'temperature')
  authContext.set({ accessToken: 'new-token', clientId: 'web', tenantId: '8', platformType: 'tenant', roles: [], permissions: ['*:*:*'] })
  finish({ code: 200, data: null })
  await expect(pending).rejects.toThrow('身份已变化')
})
