import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSceneDefinition } from '@/scene-platform'
import type { ListGisTileRes } from '@/servers/manual/gis/api'

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules() })

const tile: ListGisTileRes['data'][number] = {
  id: 42, gisName: '测试影像', dataType: 'SATELLITE', coordinate: 'EPSG:4326',
  level: 19, tileSize: '256', path: '/tile/sample', fileName: 'sample',
  sliceFlag: false, sliceRule: 'tms', longitude: '110', latitude: '20',
}

describe('GIS 环境配置', () => {
  it.each([
    ['', '/gis-source/tile/sample'],
    ['https://maps.example/gis-source/', 'https://maps.example/gis-source/tile/sample'],
  ])('使用当前部署地址 %s', async (sourceUrl, expected) => {
    vi.stubEnv('VITE_GIS_SOURCE_URL', sourceUrl)
    const { ensureEditorGisDefaultImageryLayer } = await import('../editorGisDefaultLayerAdapter')
    const scene = createSceneDefinition({ id: 'test-gis', name: '测试场景', type: 'gis' })
    // 旧存档只有地址也应按路径匹配，不因部署主机变化丢失图层关联。
    scene.layers = [{ id: 'local', name: '影像', type: 'imagery', provider: 'local',
      url: 'https://previous.example/gis-source/tile/sample', visible: true,
      locked: false, opacity: 1, order: 0 }]
    const result = await ensureEditorGisDefaultImageryLayer(scene, {
      api: { listGisTile: async () => ({ code: 200, data: [tile], msg: '成功' }) },
    })
    expect(result.layers[0]?.url).toBe(expected)
  })

  it('按数据声明的最高层级加载，并保留已保存的更低上限', async () => {
    const { createEditorGisLocalImageryLayerOptions } = await import('../editorGisDefaultLayerAdapter')
    expect(createEditorGisLocalImageryLayerOptions(tile).maximumLevel).toBe(19)
    expect(createEditorGisLocalImageryLayerOptions(tile, { maximumLevel: 15 }).maximumLevel).toBe(15)
  })
})
