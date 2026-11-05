import type { ViewportHost } from '@/scene-platform'

type ActiveSceneViewportHostListener = (host: ViewportHost | null) => void

let activeSceneViewportHost: ViewportHost | null = null
const activeSceneViewportHostListeners = new Set<ActiveSceneViewportHostListener>()

const notifyActiveSceneViewportHostChange = () => {
  activeSceneViewportHostListeners.forEach((listener) => listener(activeSceneViewportHost))
}

/**
 * 登记当前 sceneEdit 页面正在使用的 ViewportHost。
 *
 * 过渡期 ViewportHost 仍由 SceneCanvas 创建和销毁，左侧对象树、右侧属性面板等兄弟组件
 * 只能通过这个薄适配层拿到平台 Store。这里不创建 Store、不修改平台核心，只保存当前页面宿主引用。
 */
export const setActiveSceneViewportHost = (host: ViewportHost) => {
  if (activeSceneViewportHost !== host) activeSceneViewportHost?.getCommandBus().breakHistoryMerge()
  activeSceneViewportHost = host
  notifyActiveSceneViewportHostChange()
}

/**
 * 主动刷新当前活动 ViewportHost。
 *
 * 同一个宿主内部可能通过 replaceScene 从本地三维 Runtime 切到 GIS Runtime，
 * 宿主引用不变，但 Runtime 能力、场景类型和可用工具都会变化。
 * 左右面板订阅的是活动宿主快照，所以需要一个显式刷新入口通知它们重新读取宿主内部状态。
 */
export const refreshActiveSceneViewportHost = (host?: ViewportHost | null) => {
  if (host && activeSceneViewportHost !== host) return
  notifyActiveSceneViewportHostChange()
}

/**
 * 清理当前活动 ViewportHost。
 *
 * 传入 host 时会做引用校验，避免旧页面异步卸载时误清掉新页面刚登记的宿主。
 */
export const clearActiveSceneViewportHost = (host?: ViewportHost | null) => {
  if (host && activeSceneViewportHost !== host) return
  activeSceneViewportHost?.getCommandBus().breakHistoryMerge()
  activeSceneViewportHost = null
  notifyActiveSceneViewportHostChange()
}

export const getActiveSceneViewportHost = () => activeSceneViewportHost

/**
 * 订阅活动 ViewportHost 变化。
 *
 * 订阅后立即回放当前宿主，组件不需要再额外调用 getActiveSceneViewportHost；
 * 返回值用于组件卸载时释放监听，避免路由切换后残留闭包。
 */
export const subscribeActiveSceneViewportHost = (
  listener: ActiveSceneViewportHostListener,
) => {
  activeSceneViewportHostListeners.add(listener)
  listener(activeSceneViewportHost)

  return () => {
    activeSceneViewportHostListeners.delete(listener)
  }
}
