/** 去除配置末尾斜杠，保证所有派生地址只出现一个路径分隔符。 */
const normalizeServerUrl = (value: unknown) =>
  String(value || '')
    .trim()
    .replace(/\/+$/, '')

/**
 * 三维新接口统一服务器根地址，只允许在环境配置中维护协议、IP 和端口。
 * 未配置时降级为同源相对地址，避免在源码中固化某一台服务器并方便网关反向代理部署。
 */
export const DIM3D_SERVER_URL = normalizeServerUrl(import.meta.env.VITE_DIM3D_SERVER_URL)
/** 本项目后端按租户请求头鉴权，参考服务仍保留原平台路径协议。 */
export const DIM3D_ADMIN_API = import.meta.env.VITE_DIM3D_API_MODE === 'admin'

/** 模型、图标、字典、上传、对象存储和资源详情共用的 `/api` 根路径。 */
export const DIM3D_API_PREFIX = `${DIM3D_SERVER_URL}/${DIM3D_ADMIN_API ? 'admin-api' : 'api'}`

/**
 * 三维接口的基础前缀。
 *
 * 平台路径不再在常量中固定为 `operation`，统一由请求拦截器根据认证上下文在 `/api`
 * 后插入 `operation` 或 `tenant/web`。保留这个弃用别名只是为了兼容尚未迁移的外部扩展；
 * 新增接口必须使用 `DIM3D_API_PREFIX`，否则租户端请求会被错误地锁定到运营端。
 */
/** @deprecated 请改用 DIM3D_API_PREFIX；该别名不再包含固定的 operation 路径段。 */
export const DIM3D_OPERATION_API_PREFIX = DIM3D_API_PREFIX

/**
 * 模型预览资源使用独立对象存储服务，服务器地址同样只能来自环境配置。
 * 保留结尾 `/amm/`，调用方只需追加接口返回的相对路径。
 */
const dim3dAmmServerUrl = normalizeServerUrl(import.meta.env.VITE_DIM3D_AMM_SERVER_URL)
export const DIM3D_AMM_PREFIX = `${dim3dAmmServerUrl}/amm/`
