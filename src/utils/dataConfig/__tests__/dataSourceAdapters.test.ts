import { describe, expect, it, vi } from 'vitest'
import { getIotState } from '@/servers/manual/iot/api'
import { getDataSourceAdapter, listDataSourceAdapters } from '../dataSourceAdapters'

vi.mock('@/servers/manual/iot/api', () => ({ getIotState: vi.fn() }))

describe('数据源适配器注册表', () => {
  it('注册 IoT 状态适配器并统一输出数据行', async () => {
    vi.mocked(getIotState).mockResolvedValue({
      eventId: 'event-1', schemaVersion: '1.0', eventTime: '2026-11-13T03:28:00Z', tenantId: 2,
      deviceId: 'device-1', pointCode: 'temperature', value: 31.2, valueType: 'NUMBER', unit: 'C', quality: 'GOOD',
    })
    const adapter = getDataSourceAdapter('iot-state')!
    const config = adapter.normalizeConfig({ deviceId: ' device-1 ', pointCode: ' temperature ', delivery: 'auto' })
    expect(config).toMatchObject({ deviceId: 'device-1', pointCode: 'temperature', delivery: 'auto' })
    await expect(adapter.read(config!)).resolves.toMatchObject({
      dimensions: expect.arrayContaining(['value', 'eventTime', 'quality']),
      source: [{ value: 31.2, unit: 'C', pointCode: 'temperature' }],
    })
    expect(listDataSourceAdapters().map((item) => item.id)).toEqual(['iot-state'])
  })
})
