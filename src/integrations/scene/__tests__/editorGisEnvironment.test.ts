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

  it.each([undefined, 'https://previous.example/gis-source/tile/old'])('重开时按稳定字符串编号恢复完整 HTTPS 地址：%s', async savedUrl => {
    vi.stubEnv('VITE_GIS_SOURCE_URL', '/gis-source')
    const { ensureEditorGisDefaultImageryLayer } = await import('../editorGisDefaultLayerAdapter')
    const current = { ...tile, id: '2344945282589520749', path: 'https://maps.example/gis-source/World_%E5%BD%B1%E5%83%8F' }
    const scene = createSceneDefinition({ id: 'reopen-gis', name: '重开场景', type: 'gis' })
    scene.layers = [{ id: 'local', name: '影像', type: 'imagery', provider: 'local', url: savedUrl,
      visible: true, locked: false, order: 0, metadata: { tileId: current.id } }]
    const result = await ensureEditorGisDefaultImageryLayer(scene, {
      api: { listGisTile: async () => ({ code: 200, data: [current], msg: '成功' }) },
    })
    expect(result.layers[0]?.url).toBe(current.path)
    expect(result.layers[0]?.metadata?.tileId).toBe(current.id)
  })

  it('优先使用真实描述中的覆盖范围和图像格式，避免按中心点裁切实际影像', async () => {
    const { createEditorGisLocalImageryLayerOptions } = await import('../editorGisDefaultLayerAdapter')
    const metadata = { ...tile, bounds: [110, 19, 112, 21], fileExtension: 'png' }
    const options = createEditorGisLocalImageryLayerOptions(metadata)
    expect(options.rectangleDegrees).toEqual([110, 19, 112, 21])
    expect(options.fileExtension).toBe('png')
  })

  it('完整全球范围不因中心点是零而被裁成零度附近的局部切片', async () => {
    const { createEditorGisLocalImageryLayerOptions } = await import('../editorGisDefaultLayerAdapter')
    const metadata = { ...tile, longitude: '0', latitude: '0', bounds: [-180, -90, 180, 90] }
    expect(createEditorGisLocalImageryLayerOptions(metadata).rectangleDegrees).toEqual([-180, -90, 180, 90])
  })
})
