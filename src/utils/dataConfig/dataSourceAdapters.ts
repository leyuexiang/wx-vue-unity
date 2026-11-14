import { getIotPage, getIotState, type IotStateSnapshot } from '@/servers/manual/iot/api'

export type DataSourceAdapterId = 'iot-state'

export interface IotStateAdapterConfig {
  deviceId: string
  pointCode: string
  delivery: 'auto' | 'websocket' | 'polling'
  pollIntervalSeconds: number
}

export interface DataSourceAdapterContext {
  signal?: AbortSignal
}

export interface DataSourceAdapterOption {
  label: string
  value: string | number
  dependsOnValue?: string
}

export interface DataSourceAdapterField {
  key: string
  label: string
  kind: 'select' | 'number' | 'text'
  required?: boolean
  options?: readonly DataSourceAdapterOption[]
  dependsOn?: string
}

export interface DataSourceAdapterResult {
  dimensions: string[]
  source: Record<string, unknown>[]
  raw: unknown
  meta: Record<string, unknown>
}

export interface DataSourceAdapter<TConfig = unknown> {
  readonly id: DataSourceAdapterId
  readonly label: string
  createDefaultConfig: () => TConfig
  normalizeConfig: (value: unknown) => TConfig | null
  readonly configFields: readonly DataSourceAdapterField[]
  readonly dimensions?: readonly string[]
  loadConfigOptions?: (scope?: { sceneId?: string; objectId?: string }) => Promise<Record<string, DataSourceAdapterOption[]>>
  read: (config: TConfig, context?: DataSourceAdapterContext) => Promise<DataSourceAdapterResult>
}

const normalizeText = (value: unknown) => typeof value === 'string' ? value.trim() : ''

const iotStateAdapter: DataSourceAdapter<IotStateAdapterConfig> = {
  id: 'iot-state',
  label: '物联网状态',
  dimensions: ['value', 'eventTime', 'quality', 'unit', 'deviceId', 'pointCode'],
  createDefaultConfig: () => ({ deviceId: '', pointCode: '', delivery: 'auto', pollIntervalSeconds: 5 }),
  configFields: [
    { key: 'deviceId', label: '设备编号', kind: 'select', required: true },
    { key: 'pointCode', label: '点位编码', kind: 'select', required: true, dependsOn: 'deviceId' },
    {
      key: 'delivery', label: '交付方式', kind: 'select', required: true,
      options: [
        { label: '自动（WebSocket 优先）', value: 'auto' },
        { label: 'WebSocket 实时推送', value: 'websocket' },
        { label: '状态查询轮询', value: 'polling' },
      ],
    },
    {
      key: 'pollIntervalSeconds', label: '轮询间隔（秒）', kind: 'number',
      options: [1, 5, 10, 30, 60].map((value) => ({ label: String(value), value })),
    },
  ],
  loadConfigOptions: async (scope) => {
    const page = await getIotPage('bindings', { pageNo: 1, pageSize: 100, enabled: true, ...scope })
    const devices = new Map<string, DataSourceAdapterOption>()
    const points = new Map<string, DataSourceAdapterOption>()
    page.list.forEach((item) => {
      const deviceId = item.deviceId?.trim()
      if (!deviceId || item.enabled === false || (scope?.sceneId && item.sceneId !== scope.sceneId)
        || (scope?.objectId && item.objectId !== scope.objectId)) return
      // 设备绑定接口返回映射配置，标准点位优先取映射后的编码。
      let mapped: Record<string, { pointCode?: unknown }> = {}
      try { mapped = JSON.parse(item.pointMappingJson || '{}')?.points ?? {} } catch { /* 跳过无效映射 */ }
      const codes = new Set(Object.entries(mapped).map(([source, value]) => normalizeText(value?.pointCode) || source))
      if (item.pointCode?.trim()) codes.add(item.pointCode.trim())
      if (!codes.size) return
      devices.set(deviceId, { label: deviceId, value: deviceId })
      for (const pointCode of codes) {
        points.set(JSON.stringify([deviceId, pointCode]), { label: pointCode, value: pointCode, dependsOnValue: deviceId })
      }
    })
    return { deviceId: [...devices.values()], pointCode: [...points.values()] }
  },
  normalizeConfig: (value) => {
    if (!value || typeof value !== 'object') return null
    const record = value as Record<string, unknown>
    const deviceId = normalizeText(record.deviceId)
    const pointCode = normalizeText(record.pointCode)
    if (!deviceId || !pointCode) return null
    const delivery = record.delivery === 'websocket' || record.delivery === 'polling' ? record.delivery : 'auto'
    const pollIntervalSeconds = Number(record.pollIntervalSeconds)
    return {
      deviceId,
      pointCode,
      delivery,
      pollIntervalSeconds: Number.isFinite(pollIntervalSeconds) && pollIntervalSeconds > 0
        ? Math.max(1, pollIntervalSeconds)
        : 5,
    }
  },
  read: async (config, context) => {
    if (context?.signal?.aborted) throw new DOMException('请求已取消', 'AbortError')
    const snapshot: IotStateSnapshot | null = await getIotState(config.deviceId, config.pointCode)
    if (!snapshot) return { dimensions: [], source: [], raw: null, meta: { delivery: config.delivery } }
    return {
      dimensions: ['value', 'eventTime', 'quality', 'unit', 'deviceId', 'pointCode'],
      source: [{
        value: snapshot.value,
        eventTime: snapshot.eventTime,
        quality: snapshot.quality,
        unit: snapshot.unit,
        deviceId: snapshot.deviceId,
        pointCode: snapshot.pointCode,
      }],
      raw: snapshot,
      meta: { delivery: config.delivery, eventId: snapshot.eventId, stateVersion: snapshot.eventId },
    }
  },
}

const adapters: ReadonlyMap<DataSourceAdapterId, DataSourceAdapter<any>> = new Map([
  [iotStateAdapter.id, iotStateAdapter],
])

export const getDataSourceAdapter = (id: string): DataSourceAdapter<any> | undefined => adapters.get(id as DataSourceAdapterId)

export const listDataSourceAdapters = (): readonly DataSourceAdapter<any>[] => [...adapters.values()]
