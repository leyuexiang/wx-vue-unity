/** 行高与结构树样式共用，含两像素行间距。 */
export const HIERARCHY_ROW_HEIGHT = 38
const OVERSCAN = 6

/** 窗口随容器尺寸变化，折叠后旧滚动位置先钳制到新内容范围。 */
export function getHierarchyWindow(count: number, scrollTop: number, viewportHeight: number) {
  const height = count * HIERARCHY_ROW_HEIGHT
  const top = Math.max(0, Math.min(scrollTop, height - viewportHeight))
  const start = Math.max(0, Math.floor(top / HIERARCHY_ROW_HEIGHT) - OVERSCAN)
  const end = Math.min(count, Math.ceil((top + viewportHeight) / HIERARCHY_ROW_HEIGHT) + OVERSCAN)
  return { start, end, height, offset: start * HIERARCHY_ROW_HEIGHT }
}

/** 已完整可见的行保留滚动位置，视口外只移动到能看见目标的最近位置。 */
export function getHierarchyRowScrollTop(index: number, scrollTop: number, viewportHeight: number) {
  const rowTop = index * HIERARCHY_ROW_HEIGHT
  if (rowTop < scrollTop || viewportHeight < HIERARCHY_ROW_HEIGHT) return rowTop
  const rowBottom = rowTop + HIERARCHY_ROW_HEIGHT
  return rowBottom > scrollTop + viewportHeight ? rowBottom - viewportHeight : scrollTop
}
