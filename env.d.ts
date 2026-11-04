/// <reference types="vite/client" />
/// <reference types="unplugin-icons/types/vue" />

interface ImportMetaEnv {
  readonly VITE_DEV_SERVER_PORT?: string
  /** 本项目后端使用admin，参考服务留空。 */
  readonly VITE_DIM3D_API_MODE?: string
  readonly VITE_AUTH_OPERATION_TENANT_ID?: string
  readonly VITE_AUTH_TENANT_ID?: string
  readonly VITE_UNITY_RESOURCE_API_ORIGIN?: string
  readonly VITE_UNITY_RESOURCE_DOWNLOAD_ORIGINS?: string
  /** 旧运营应用编号兼容项；新部署分别配置运营端和租户端，服务器根仍统一。 */
  readonly VITE_AUTH_CLIENT_ID?: string
  /** 独立运营登录的公开应用编号。 */
  readonly VITE_AUTH_OPERATION_CLIENT_ID?: string
  /** 独立租户登录的公开应用编号，不从游客凭据变量读取。 */
  readonly VITE_AUTH_TENANT_CLIENT_ID?: string
  /** 参考服务暂未确认续期能力，只有自建后端实现续期协议才启用。 */
  readonly VITE_AUTH_REFRESH_ENABLED?: string
  readonly VITE_EMBED_DATA_API_ALLOWED_ORIGINS?: string
  readonly VITE_PUBLIC_PREVIEW_GUEST_PHONENUMBER?: string
  readonly VITE_PUBLIC_PREVIEW_GUEST_PASSWORD?: string
  readonly VITE_PUBLIC_PREVIEW_GUEST_CLIENT_ID?: string
}

declare module 'splitpanes' {
  import { DefineComponent } from 'vue'

  interface SplitpanesProps {
    horizontal?: boolean
    pushOtherPanes?: boolean
    maximizePanes?: boolean
    rtl?: boolean
    firstSplitter?: boolean
  }

  interface PaneProps {
    size?: number
    minSize?: number
    maxSize?: number
  }

  interface PaneData {
    id: string
    size: number
    minSize?: number
    maxSize?: number
  }

  interface SplitterData {
    id: string
    index: number
  }

  interface SplitpanesEvents {
    ready: () => void
    resize: (panes: PaneData[]) => void
    resized: (panes: PaneData[]) => void
    'pane-click': (pane: PaneData) => void
    'pane-maximize': (pane: PaneData) => void
    'pane-add': (pane: PaneData) => void
    'pane-remove': (pane: PaneData) => void
    'splitter-click': (splitter: SplitterData) => void
    'splitter-dblclick': (splitter: SplitterData) => void
  }

  const Splitpanes: DefineComponent<SplitpanesProps, object, object, object, object, object, object, SplitpanesEvents>
  const Pane: DefineComponent<PaneProps>

  export { Splitpanes, Pane }
  export default Splitpanes
}
