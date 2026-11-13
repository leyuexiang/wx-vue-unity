import { describe, expect, it, vi } from 'vitest'
import type { SceneObject } from '@/scene-platform'
import { createEmptyDataConfig } from '@/types/data-config'
import { getIotState } from '@/servers/manual/iot/api'
import { SceneDataPollingRuntime } from '../widgetRuntime/sceneDataPollingRuntime'

vi.mock('@/servers/manual/iot/api', () => ({
  getIotState: vi.fn(),
}))

const mockedGetIotState = vi.mocked(getIotState)

describe('三维实例物联网状态绑定', () => {
  it('按设备和点位查询状态并复用对象属性映射', async () => {
    const dataConfig = createEmptyDataConfig([{ value: true }])
    dataConfig.request = {
      type: 'adapter',
      config: {
        adapterId: 'iot-state',
        config: {
          deviceId: 'iot-resident-device-01', pointCode: 'temperature', delivery: 'polling', pollIntervalSeconds: 5,
        },
      },
    }
    dataConfig.requests![0]!.bindings = [{
      kind: 'object', targetPath: 'visible', sourceField: 'value', valueType: 'boolean',
    }]
    const object: SceneObject = {
      id: 'pump-01', name: '泵', type: 'model', visible: true, locked: false, order: 0, assetRefs: [],
      transform: { kind: 'local', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      metadata: {
        dataConfig,
      },
    }
    mockedGetIotState.mockResolvedValue({
      eventId: 'event-1', schemaVersion: '1.0', eventTime: '2026-11-13T03:28:00Z', tenantId: 2,
      deviceId: 'iot-resident-device-01', pointCode: 'temperature', value: false, valueType: 'BOOLEAN',
    })
    const applied: SceneObject[] = []
    const applyObject = vi.fn((next: SceneObject) => { applied.push(next) })
    const runtime = new SceneDataPollingRuntime({
      getSceneObjects: () => [object],
      getPublicRequests: () => [],
      getRequestGlobalConfig: () => ({ requestOriginUrl: '', requestInterval: null, requestIntervalUnit: 'second', requestParams: { Header: {} } }),
      getRuntimeContext: () => ({ sceneId: '42' }),
      applySceneObject: applyObject,
    })

    try {
      await runtime.start()
      expect(mockedGetIotState).toHaveBeenCalledWith('iot-resident-device-01', 'temperature', { sceneId: '42', objectId: 'pump-01' })
      expect(applied.at(-1)?.visible).toBe(false)
      expect(applyObject).toHaveBeenCalledWith(expect.objectContaining({ visible: false }), { runtimeOnly: true })
      expect(object.visible).toBe(true)
    } finally {
      runtime.dispose()
    }
  })
})
