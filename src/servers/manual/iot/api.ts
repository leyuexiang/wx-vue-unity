import request from '@/request'
import { DIM3D_SERVER_URL } from '@/servers/manual/dim3d/api/constants'
import { authContext } from '@/auth/authContext'
import { hasIotPermission } from '@/auth/iotNavigation'

export type IotKind = 'connectors' | 'bindings' | 'messages'
export interface IotRow {
  id: string
  connectorId: string
  name?: string
  connectorType?: 'MQTT' | 'HTTPS' | 'MOCK'
  enabled?: boolean
  version?: number
  endpoint?: string
  credentialRef?: string
  configJson?: string
  externalDeviceId?: string
  deviceId?: string
  sceneId?: string
  objectId?: string
  mappingRevision?: string
  pointMappingJson?: string
  status?: string
  eventId?: string
  pointCode?: string
  retryCount?: number
  receivedAt?: string | number
  createTime?: string | number
  updateTime?: string | number
}
export interface IotPageQuery {
  pageNo: number
  pageSize: number
  connectorId?: string
  externalDeviceId?: string
  connectorType?: string
  sceneId?: string
  objectId?: string
  enabled?: boolean
  status?: string
}
export interface IotPage { list: IotRow[]; total: number }
export interface IotRuntime {
  effectiveStatus: string
  persistedStatus?: string
  leaseActive: boolean
  observedAt?: string | number
  runtimeLeaseUntil?: string | number
  version?: number
}
export interface IotConnectionResult { outcome: string; elapsedMillis: number; topicCount: number; message: string }
/** 三维状态投影返回的单点最新快照；空数据表示尚未收到或已经过期。 */
export interface IotStateSnapshot {
  eventId: string
  schemaVersion: string
  eventTime: string
  tenantId: number
  deviceId: string
  pointCode: string
  value: unknown
  valueType: 'BOOLEAN' | 'NUMBER' | 'STRING' | string
  unit?: string
  quality?: string
  sceneId?: string
  objectId?: string
  mappingRevision?: string
  replay?: boolean
  traceId?: string
}
interface Envelope<T> { code: number; data: T; msg?: string }
export const IOT_RESOURCES = { connectors: 'connector', bindings: 'device-binding', messages: 'message-inbox' } as const
export const IOT_VERSION_CONFLICT = 1009001011
export class IotApiError extends Error {
  constructor(readonly code: number, message: string) { super(message); this.name = 'IotApiError' }
}
/** 所有编号先校验再转字符串，拒绝已丢失精度的数值。 */
export function iotId(value: unknown): string {
  if ((typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value)) ||
      (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)) return String(value)
  throw new Error('接口编号格式错误，请刷新后重试')
}
function requirePermission(kind: IotKind, action: string) {
  if (!hasIotPermission(`iot:${IOT_RESOURCES[kind]}:${action}`)) throw new IotApiError(403, '当前账号没有此操作权限')
}
/** 使用标准后台路径与共享认证头，不复制令牌、租户或平台路由逻辑。 */
async function call<T>(kind: IotKind, action: string, method = 'GET', params?: object, data?: object): Promise<T> {
  const identity = authContext.get()
  const response = await request<Envelope<T>>(`${DIM3D_SERVER_URL}/admin-api/iot/${IOT_RESOURCES[kind]}/${action}`, {
    method, params, data, skipPlatformPath: true,
  })
  // 身份切换后的迟到结果不得写入新账号页面。
  const current = authContext.get()
  if (!identity || current?.accessToken !== identity.accessToken || current?.tenantId !== identity.tenantId ||
      current?.platformType !== identity.platformType) throw new Error('登录身份已变化，请重新进入页面')
  if (response?.code !== 200) {
    const code = Number(response?.code || 500)
    const safeMessages: Record<number, string> = {
      1009001001: '连接器不存在', 1009001002: '连接器编号已存在', 1009001004: '点位映射配置无效',
      1009001006: '当前记录不允许重放', 1009001011: '配置已被修改，当前表单已保留，请重新读取详情后核对',
      1009001012: '连接器编号创建后不可修改', 1009001013: '协议参数配置无效',
      1009001101: '设备绑定不存在', 1009001102: '外部设备绑定已存在',
      403: '当前账号没有此操作权限', 404: '物联网服务尚不可用',
    }
    throw new IotApiError(code, safeMessages[code] ?? '操作未完成，请检查服务状态后重试')
  }
  return response.data
}
export async function getIotPage(kind: IotKind, params: IotPageQuery): Promise<IotPage> {
  requirePermission(kind, 'query')
  if (!Number.isInteger(params.pageNo) || params.pageNo < 1 || !Number.isInteger(params.pageSize) ||
    params.pageSize < 1 || params.pageSize > 100) throw new Error('分页范围无效')
  const page = await call<{ list: (Omit<IotRow, 'id'> & { id: unknown })[]; total: number }>(kind, 'page', 'GET', params)
  if (!page || !Array.isArray(page.list) || !Number.isFinite(page.total) || page.total < 0) throw new Error('分页响应格式错误')
  return { total: page.total, list: page.list.map(row => ({ ...row, id: iotId(row.id) })) }
}
export async function getIotDetail(kind: 'connectors' | 'bindings', id: string): Promise<IotRow> {
  requirePermission(kind, 'query')
  const row = await call<IotRow | null>(kind, 'get', 'GET', { id: iotId(id) })
  if (!row) throw new Error('记录已不存在，请刷新列表')
  return { ...row, id: iotId(row.id) }
}
export async function saveIot(kind: 'connectors' | 'bindings', form: Partial<IotRow>): Promise<void> {
  const action = form.id ? 'update' : 'create'
  requirePermission(kind, action)
  // 仅提交合同字段，避免把运行状态或列表字段写回后台。
  const fields = kind === 'connectors'
    ? ['id', 'version', 'connectorId', 'name', 'connectorType', 'endpoint', 'credentialRef', 'configJson']
    : ['id', 'connectorId', 'externalDeviceId', 'deviceId', 'sceneId', 'objectId', 'mappingRevision', 'pointMappingJson', 'enabled']
  const data = Object.fromEntries(fields.filter(key => form[key as keyof IotRow] !== undefined)
    .map(key => [key, form[key as keyof IotRow]]))
  // JSON列接受空对象，不提交空字符串；清空映射由后端明确覆盖原有规则。
  if (kind === 'connectors' && !form.configJson?.trim()) data.configJson = '{}'
  if (form.id) data.id = iotId(form.id)
  await call(kind, action, form.id ? 'PUT' : 'POST', undefined, data)
}
export async function deleteIot(kind: 'connectors' | 'bindings', id: string): Promise<void> {
  requirePermission(kind, 'delete')
  await call(kind, 'delete', 'DELETE', { id: iotId(id) })
}
export async function toggleIotConnector(id: string, enabled: boolean): Promise<void> {
  requirePermission('connectors', 'update')
  await call('connectors', enabled ? 'enable' : 'disable', 'POST', { id: iotId(id) })
}
export async function getIotRuntime(id: string): Promise<IotRuntime> {
  requirePermission('connectors', 'query')
  return call('connectors', 'runtime', 'GET', { id: iotId(id) })
}

/**
 * 查询当前租户的设备点位最新值。
 * 查询接口不复用管理菜单权限，服务端会单独校验 dimensions:iot-state:query。
 */
export async function getIotState(deviceId: string, pointCode: string, scope?: { sceneId: string; objectId: string }): Promise<IotStateSnapshot | null> {
  const normalizedDeviceId = deviceId.trim()
  const normalizedPointCode = pointCode.trim()
  if (!normalizedDeviceId || !normalizedPointCode || normalizedDeviceId.length > 256 || normalizedPointCode.length > 256) {
    throw new Error('设备编号和点位编码不能为空且不能超过256个字符')
  }
  const identity = authContext.get()
  if (!identity || !authContext.hasValidContext()) throw new IotApiError(401, '请先登录')
  const response = await request<Envelope<IotStateSnapshot | null>>(`${DIM3D_SERVER_URL}/admin-api/dimensions/iot-state/get`, {
    method: 'GET',
    // 运行时携带实例范围，服务端按已保存场景校验。
    params: { deviceId: normalizedDeviceId, pointCode: normalizedPointCode, ...scope },
    skipPlatformPath: true,
  })
  // 身份切换后的迟到快照不得写入新场景运行态。
  const current = authContext.get()
  if (!current || current.accessToken !== identity.accessToken || current.tenantId !== identity.tenantId ||
      current.platformType !== identity.platformType) throw new Error('登录身份已变化，请重新进入页面')
  if (response?.code !== 200) {
    const code = Number(response?.code || 500)
    throw new IotApiError(code, code === 401 || code === 403 ? '当前账号没有物联网状态查询权限' : '物联网状态查询失败')
  }
  if (response.data === null || response.data === undefined) return null
  const snapshot = response.data
  if (typeof snapshot !== 'object' || !snapshot.eventId || !snapshot.deviceId || !snapshot.pointCode ||
      snapshot.deviceId !== normalizedDeviceId || snapshot.pointCode !== normalizedPointCode ||
      typeof snapshot.eventTime !== 'string' || typeof snapshot.schemaVersion !== 'string') {
    throw new Error('物联网状态响应格式错误')
  }
  return snapshot
}
export async function validateIotMqtt(form: Partial<IotRow>): Promise<void> {
  requirePermission('connectors', form.id ? 'update' : 'create')
  await call('connectors', 'validate-mqtt-config', 'POST', undefined, {
    endpoint: form.endpoint, credentialRef: form.credentialRef, configJson: form.configJson,
  })
}
export async function testIotMqtt(id: string): Promise<IotConnectionResult> {
  requirePermission('connectors', 'update')
  return call('connectors', 'test-mqtt', 'POST', undefined, { id: iotId(id), timeoutSeconds: 10 })
}
export async function replayIot(eventId: string): Promise<void> {
  requirePermission('messages', 'replay')
  if (!eventId?.trim()) throw new Error('事件编号缺失')
  await call('messages', 'replay', 'POST', { eventId })
}
