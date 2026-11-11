import { describe, expect, it } from 'vitest'
import type { VegetationPolygonRule } from '@/scene-platform'
import { listVegetationRegions } from '../editorVegetationRegions'

function polygon(id: string, name: string, seedOffset: number): VegetationPolygonRule {
  return {
    id, name, seedOffset, kind: 'polygon', enabled: true, layerId: 'forest', priority: 0,
    polygon: { rings: [] }, speciesMix: [], distribution: 'poisson', densityPerHectare: 100, minimumSpacingM: 5,
  }
}

describe('listVegetationRegions', () => {
  it('keeps separate frames with the same name and groups non-adjacent patches by saved identity', () => {
    const west = { id: 'west', name: '影像种植区' }
    const east = { id: 'east', name: west.name }
    const first = { ...polygon('a', '斑块 1', 0), imageryRegion: west }
    const second = { ...polygon('b', '斑块 2', 1), imageryRegion: west }
    const third = { ...polygon('c', '斑块 1', 2), imageryRegion: east }
    const manual = polygon('manual', '手绘区', 3)

    expect(listVegetationRegions([first, third, manual, second])).toEqual([
      { id: 'imagery:west', name: west.name, kind: 'imagery', patches: [first, second] },
      { id: 'imagery:east', name: east.name, kind: 'imagery', patches: [third] },
      { id: manual.id, name: manual.name, kind: 'polygon', rule: manual },
    ])
  })

  it('groups legacy batches by numbering and seed offsets, including pieces created by clipping', () => {
    const first = polygon('imagery-planting-a', '影像植被区 1', 3)
    const clipped = polygon('imagery-planting-b', first.name, first.seedOffset)
    const third = polygon('imagery-planting-c', '影像植被区 3', 5)
    const nextBatch = polygon('imagery-planting-d', '影像植被区 1', 6)

    expect(listVegetationRegions([first, clipped, third, nextBatch])).toEqual([
      { id: `imagery:${first.id}`, name: '影像种植区', kind: 'imagery', patches: [first, clipped, third] },
      { id: `imagery:${nextBatch.id}`, name: '影像种植区', kind: 'imagery', patches: [nextBatch] },
    ])
  })
})
