import type { PlatformType } from './authTypes'

/** 网关允许部署在同源代理子路径，解析时保留其来源与路径边界。 */
export function getConfiguredDim3dBase(origin: string): URL | undefined {
  const configured = String(import.meta.env.VITE_DIM3D_SERVER_URL || '').trim()
  if (!configured) return undefined
  try {
    return new URL(configured, origin)
  } catch {
    return undefined
  }
}

/** 收集第一方接口根路径；仅这些根路径会插入平台段，避免误改第三方绝对地址。 */
function getFirstPartyRoots(): string[] {
  const dataMiddlewarePrefix = String(import.meta.env.VITE_DATA_MIDDLEWARE_PREFIX || '/data-center')
    .trim()
    .replace(/\/+$/, '')
  return [...new Set(['/admin-api', '/api', dataMiddlewarePrefix].filter(Boolean))]
}

function insertPlatformSegment(pathname: string, root: string, platformType: PlatformType): string {
  if (pathname !== root && !pathname.startsWith(`${root}/`)) return pathname

  const suffix = pathname.slice(root.length)
  const currentSegment = suffix.split('/').filter(Boolean)[0]
  if (currentSegment === 'operation') {
    if (currentSegment !== platformType) {
      throw new Error(`接口路径平台类型冲突：当前为 ${platformType}，路径却包含 ${currentSegment}`)
    }
    return pathname
  }
  // 租户端真实平台前缀为 tenant/web。对已经改写过的新路径保持幂等；
  // 对历史接口中的 /tenant/ 统一升级为 /tenant/web/，避免继续请求旧租户入口。
  if (currentSegment === 'tenant') {
    const tenantSuffix = suffix.slice('/tenant'.length)
    if (tenantSuffix === '/web' || tenantSuffix.startsWith('/web/')) {
      if (platformType === 'tenant') return pathname
      throw new Error(`接口路径平台类型冲突：当前为 ${platformType}，路径却包含 tenant/web`)
    }
    if (platformType === 'tenant') return `${root}/tenant/web${tenantSuffix}`
    // tenant 也可能是原有业务路径；运营端在其外层补充 operation。
    return `${root}/operation${suffix}`
  }
  const platformPath = platformType === 'tenant' ? 'tenant/web' : 'operation'
  return `${root}/${platformPath}${suffix}`
}

/**
 * 为第一方项目接口插入 tenant/web 或 operation 路径段。
 *
 * 相对地址只处理 /admin-api 与 /api；绝对地址仅处理当前页面同源或配置的三维服务地址。
 * 函数保持查询参数与哈希不变，并具备幂等性，适合请求重试时重复调用。
 */
export function resolvePlatformApiUrl(url: string, platformType: PlatformType): string {
  const isAbsolute = /^[a-z][a-z\d+.-]*:\/\//i.test(url)
  const baseOrigin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin
  const parsed = new URL(url, baseOrigin)
  const allowedAbsoluteOrigins = new Set([baseOrigin])
  const dim3dBase = getConfiguredDim3dBase(baseOrigin)
  if (dim3dBase) allowedAbsoluteOrigins.add(dim3dBase.origin)
  const configuredServerUrls = [
    import.meta.env.VITE_DATA_MIDDLEWARE_URL,
  ]
  for (const serverUrl of configuredServerUrls) {
    try {
      if (serverUrl) allowedAbsoluteOrigins.add(new URL(String(serverUrl)).origin)
    } catch {
      // 环境变量格式错误由部署检查负责；这里不扩大允许范围。
    }
  }
  if (isAbsolute && !allowedAbsoluteOrigins.has(parsed.origin)) return url

  // 本项目管理API使用统一路径，租户隔离由服务端校验tenant-id与令牌归属。
  if (import.meta.env.VITE_DIM3D_API_MODE === 'admin' && parsed.pathname.startsWith('/admin-api/')) return url

  // 生产同源代理可能带 /dts-api，模型平台段应插在该代理下的 /api 之后。
  const dim3dPrefix = dim3dBase?.origin === parsed.origin
    ? dim3dBase.pathname.replace(/\/+$/, '')
    : ''
  const roots = dim3dPrefix ? [`${dim3dPrefix}/api`, ...getFirstPartyRoots()] : getFirstPartyRoots()
  const root = roots.find(candidate => parsed.pathname === candidate || parsed.pathname.startsWith(`${candidate}/`))
  const pathname = root ? insertPlatformSegment(parsed.pathname, root, platformType) : parsed.pathname
  if (pathname === parsed.pathname) return url
  parsed.pathname = pathname

  return isAbsolute ? parsed.toString() : `${parsed.pathname}${parsed.search}${parsed.hash}`
}
