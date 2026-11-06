import { describe, expect, it } from 'vitest'
import { getHierarchyRowScrollTop, getHierarchyWindow, HIERARCHY_ROW_HEIGHT } from '../sceneHierarchyWindow'

const rowHeight = HIERARCHY_ROW_HEIGHT

describe('结构树滚动窗口', () => {
  it('两万行只渲染视口及缓冲，首尾窗口保持在列表范围内', () => {
    const count = 20_000
    const viewport = 10 * rowHeight
    expect(getHierarchyWindow(count, 0, viewport)).toEqual({
      start: 0, end: 16, height: count * rowHeight, offset: 0,
    })
    expect(getHierarchyWindow(count, 5_000 * rowHeight + 1, viewport)).toEqual({
      start: 4_994, end: 5_017, height: count * rowHeight, offset: 4_994 * rowHeight,
    })
    expect(getHierarchyWindow(count, count * rowHeight, viewport)).toMatchObject({ start: 19_984, end: count })
  })

  it('折叠、视口变大或清空后，旧滚动位置也能得到有效范围', () => {
    const top = 5_000 * rowHeight
    expect(getHierarchyWindow(30, top, 10 * rowHeight)).toMatchObject({ start: 14, end: 30 })
    expect(getHierarchyWindow(4, top, 10 * rowHeight)).toMatchObject({ start: 0, end: 4 })
    expect(getHierarchyWindow(0, top, 10 * rowHeight)).toEqual({ start: 0, end: 0, height: 0, offset: 0 })
  })

  it('定位只滚动必要距离，目标行进入渲染窗口', () => {
    const viewport = 10 * rowHeight
    const initialTop = 2 * rowHeight
    expect(getHierarchyRowScrollTop(2, initialTop, viewport)).toBe(initialTop)
    expect(getHierarchyRowScrollTop(11, initialTop, viewport)).toBe(initialTop)
    expect(getHierarchyRowScrollTop(1, initialTop, viewport)).toBe(rowHeight)
    const target = 19_999
    const top = getHierarchyRowScrollTop(target, initialTop, viewport)
    const range = getHierarchyWindow(target + 1, top, viewport)
    expect(top).toBe(19_990 * rowHeight)
    expect(range.start).toBeLessThanOrEqual(target)
    expect(range.end).toBeGreaterThan(target)
  })
})
