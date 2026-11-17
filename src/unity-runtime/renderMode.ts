export type UnityRenderMode = 'cloud' | 'webgpu'

export const isUnityRenderMode = (value: unknown): value is UnityRenderMode =>
  value === 'cloud' || value === 'webgpu'

/** Deployment settings contain addresses only. Credentials and scene data never enter the URL. */
export const unityRenderConfig = {
  cloud: {
    signalUrl: String(import.meta.env.VITE_UNITY_CLOUD_SIGNAL_URL || '').trim(),
    appId: String(import.meta.env.VITE_UNITY_CLOUD_APP_ID || '').trim(),
    sceneKey: String(import.meta.env.VITE_UNITY_CLOUD_SCENE_KEY || '').trim(),
    connectionId: String(import.meta.env.VITE_UNITY_CLOUD_CLIENT_ID || '').trim(),
  },
  webgpu: {
    // 默认入口随前端子目录部署，显式空值仍可关闭入口，完整地址继续支持独立网关。
    bootstrapUrl: String(import.meta.env.VITE_UNITY_WEB_BOOTSTRAP_URL ?? './unity-runtime/bootstrap').trim(),
  },
}

export const isUnityRenderModeConfigured = (mode: UnityRenderMode): boolean =>
  mode === 'cloud'
    ? Boolean(unityRenderConfig.cloud.signalUrl && unityRenderConfig.cloud.appId && unityRenderConfig.cloud.sceneKey)
    : Boolean(unityRenderConfig.webgpu.bootstrapUrl)

export const unityRenderModeLabel = (mode: UnityRenderMode): string =>
  mode === 'cloud' ? 'Unity 云渲染' : 'Unity WebGPU'
