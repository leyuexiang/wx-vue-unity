import type { RequestOptionsInit } from 'umi-request'
import { extend } from 'umi-request'
import { getAccessToken, toLogin } from './utils/auth'
import { ElNotification } from 'element-plus'
import { getStandaloneSessionVersion, hasStandaloneSession, refreshStandalone } from './auth/standalone'
import { authContext } from './auth/authContext'
import { getAuthProvider, isEmbeddedMode } from './auth/runtime'
import { normalizeAccessToken } from './auth/accessToken'
import { resolvePlatformApiUrl } from './auth/platformApiPathResolver'

const ERR_CODE_MSG = {
  400: '请求错误',
  401: '未授权',
  403: '禁止访问',
  404: '资源不存在',
  405: '请求方式不允许',
  406: '请求格式错误',
  410: '资源已删除',
  422: '验证错误',
  500: '服务器错误',
  502: '网关错误',
  503: '服务不可用',
  504: '网关超时',
} as const

interface ResponseData {
  code: number
  content: unknown
  msg: string
}

/**
 * 请求级错误策略。部分阶段三接口会在后端尚未部署时返回 404，调用方可以只对
 * “资源不存在”关闭全局通知，再自行呈现空状态；其他状态仍沿用全局错误提示。
 */
interface RequestErrorOptions extends RequestOptionsInit {
  suppressNotFoundNotification?: boolean
  /** 预览票据重试期间静默凭证类 403，最终重试失败时由请求方恢复通知。 */
  suppressPreviewCredentialNotification?: boolean
  /** 发布预览使用独立 ticket；匿名预览的 401/403 不应影响宿主登录态。 */
  publicPreview?: boolean
  /** 公开预览首轮探测强制匿名走运营端，不读取 authHandoff 等现有身份。 */
  anonymousPublicPreview?: boolean
  /**
   * 调用方已经提供完整业务路径时保持原值，不参与租户/运营端路径分流。
   * 属性数据面板的请求属于此类：接口路径由用户配置，与宿主平台权限无关。
   */
  skipPlatformPath?: boolean
  /**
   * 数据面板允许用户显式配置 Authorization、ClientId 等请求头；启用后仅补充缺失的系统凭证，
   * 不覆盖调用方已经传入的同名请求头值。
   */
  preserveConfiguredHeaders?: boolean
}

type RequestStatusError = Error & { code?: number; status?: number }

const request = extend({ timeout: 30 * 1000 })

function getPassAuth(url: string, options: RequestOptionsInit) {
  const isDataMiddleware =
    import.meta.env.VITE_DATA_MIDDLEWARE_PREFIX &&
    url.startsWith(import.meta.env.VITE_DATA_MIDDLEWARE_PREFIX)
  return options?.passAuth || isDataMiddleware
}

/** 仅第一方项目接口的 401 才能代表外层登录态失效，第三方 401 不得触发父页面跳转。 */
function isEmbeddedFirstPartyUrl(url: string): boolean {
  try {
    const parsed = new URL(url, window.location.origin)
    const dataPrefix = String(import.meta.env.VITE_DATA_MIDDLEWARE_PREFIX || '').replace(/\/+$/, '')
    if (
      parsed.origin === window.location.origin &&
      (parsed.pathname.startsWith('/admin-api/') ||
        parsed.pathname.startsWith('/api/') ||
        (dataPrefix && parsed.pathname.startsWith(`${dataPrefix}/`)))
    ) {
      return true
    }
    const configuredOrigins = [
      import.meta.env.VITE_DIM3D_SERVER_URL,
      import.meta.env.VITE_DATA_MIDDLEWARE_URL,
    ]
      .filter(Boolean)
      .map((item) => new URL(String(item)).origin)
    return configuredOrigins.includes(parsed.origin)
  } catch {
    return url.startsWith('/admin-api/') || url.startsWith('/api/')
  }
}

const createRequestStatusError = (status: number, message: string): RequestStatusError => {
  const error = new Error(message) as RequestStatusError
  error.code = status
  error.status = status
  return error
}

/** 旧接口可能用业务码 401 表示资源权限不足，不能误判为平台登录失效。 */
function isResourcePermissionDeniedMessage(message: string): boolean {
  return /访问权限不存在|无访问权限|没有访问权限|权限不足|无权访问|禁止访问/.test(message)
}

/**
 * 公开预览票据尚未同步时，后端会以业务 403 返回这类提示。
 * 只有明确命中凭证语义才允许在重试期间静默，避免误伤真实的权限拒绝通知。
 */
function isPreviewCredentialErrorMessage(message: unknown): boolean {
  return (
    typeof message === 'string' &&
    /访问凭证|访问令牌|凭证|令牌|ticket|token|过期|无效|expired|invalid/i.test(message)
  )
}

/** 判断当前业务错误是否处于“预览凭证重试中且暂不通知”的窗口。 */
function shouldSuppressPreviewCredentialNotification(
  options: RequestOptionsInit,
  code: unknown,
  message: unknown,
): boolean {
  const requestOptions = options as RequestErrorOptions
  return (
    requestOptions.publicPreview === true &&
    requestOptions.suppressPreviewCredentialNotification === true &&
    code === 403 &&
    isPreviewCredentialErrorMessage(message)
  )
}

const shouldSuppressNotFoundNotification = (options: RequestOptionsInit, status: number) =>
  status === 404 && Boolean((options as RequestErrorOptions).suppressNotFoundNotification)

/**
 * 根据请求响应，进行 blob 流文件下载。
 */
function blobFileDownload(res: Response) {
  let filename = 'downloadFile'
  const disposition = res.headers.get('content-disposition')
  if (disposition) {
    const name = disposition
      .split(';')
      .find((item) => /filename/i.test(item))
      ?.split('=')[1]
    if (name) {
      filename = name
    }
  }

  res.blob().then((blob) => {
    if ('msSaveOrOpenBlob' in navigator) {
      // @ts-expect-error navigator.msSaveOrOpenBlob' is of type 'unknown'
      navigator.msSaveOrOpenBlob(blob, filename)
    } else {
      const element = document.createElement('a')
      element.download = filename
      element.style.display = 'none'
      element.href = URL.createObjectURL(blob)
      document.body.appendChild(element)
      element.click()
      URL.revokeObjectURL(element.href)
      document.body.removeChild(element)
    }
  })
}

function handleBlobDownload(response: Response, options: RequestOptionsInit) {
  if (
    options.responseType === 'blob' &&
    !response.headers.get('Content-Type')?.includes('application/json')
  ) {
    blobFileDownload(response.clone())
    return true
  }

  return false
}

async function handle401(
  response: Response,
  options: RequestOptionsInit,
  message: string = ERR_CODE_MSG[401],
): Promise<Response> {
  const authOptions = options as RequestOptionsInit & { __authRetry?: boolean; __standaloneVersion?: number }
  const publicPreview = Boolean((options as RequestErrorOptions & { publicPreview?: boolean }).publicPreview)
  const requestUrl = response.url || String(authOptions.url || '')
  // 登录平台已经切换时，上一轮请求的 401 只能结束自身，不能刷新或清除新平台身份。
  const isObsoleteIdentity = () => authOptions.__standaloneVersion !== undefined &&
    authOptions.__standaloneVersion !== getStandaloneSessionVersion()
  if (isObsoleteIdentity()) return Promise.reject(createRequestStatusError(401, message))

  /**
   * 受限预览虽然沿用发布预览接口，但同时携带租户鉴权上下文。任何运行阶段的第一方 401
   * 都要通知组合根回到租户登录页；不能只依赖首屏 openPreview 的 try/catch。
   */
  const isAuthenticatedPreview =
    typeof window !== 'undefined' &&
    window.location.pathname.endsWith('/scenePreview') &&
    authContext.hasValidContext()
  if (!publicPreview && isAuthenticatedPreview && isEmbeddedFirstPartyUrl(requestUrl)) {
    if (!isResourcePermissionDeniedMessage(message)) {
      window.dispatchEvent(new CustomEvent('xr-center-auth-expired', { detail: { message } }))
    }
    return Promise.reject(createRequestStatusError(401, message))
  }

  /**
   * 内嵌模式的登录态归父页面所有。HTTP 401 与业务 401 都只通知父页面一次，
   * iframe 不刷新令牌、不重试请求，也不修改 window.location。
   */
  if (isEmbeddedMode() && !publicPreview && isEmbeddedFirstPartyUrl(requestUrl)) {
    if (isResourcePermissionDeniedMessage(message)) {
      return Promise.reject(createRequestStatusError(401, message))
    }
    // 编辑器独立页签没有 iframe provider；通过 DOM 事件交给组合根显示“关闭编辑器”提示。
    // 管理 iframe 仍由 provider 向外层项目发送 XR_CENTER_AUTH_EXPIRED。
    const provider = getAuthProvider()
    if (provider) provider.notifyAuthExpired(message)
    else if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('xr-center-auth-expired', { detail: { message } }))
    }
    return Promise.reject(createRequestStatusError(401, message))
  }

  // 独立编辑页签只接收访问身份，不持有独立续期会话；失效时交给组合根保留画布并提示重新进入。
  if (!publicPreview && !(options as RequestErrorOptions).preserveConfiguredHeaders &&
    !hasStandaloneSession() && authContext.get() && isEmbeddedFirstPartyUrl(requestUrl)) {
    if (!isResourcePermissionDeniedMessage(message)) {
      window.dispatchEvent(new CustomEvent('xr-center-auth-expired', { detail: { message } }))
    }
    return Promise.reject(createRequestStatusError(401, message))
  }

  // 仅由当前独立会话实际注入凭据的第一方请求允许续期；第三方、手配凭据及公开票据各自处理错误。
  const usesStandalone = Boolean((options as RequestOptionsInit & { __standaloneAuth?: boolean }).__standaloneAuth)
  if (publicPreview || !usesStandalone || !isEmbeddedFirstPartyUrl(requestUrl) || isResourcePermissionDeniedMessage(message)) {
    return Promise.reject(createRequestStatusError(401, message))
  }
  if (!authOptions.__authRetry && await refreshStandalone()) {
    if (isObsoleteIdentity()) return Promise.reject(createRequestStatusError(401, message))
    // 共享续期承诺在失败后也会释放；请求最多重放一次，不保留无法拒绝的回调队列。
    return request(authOptions.url || requestUrl, { ...authOptions, __authRetry: true })
  }
  if (isObsoleteIdentity()) return Promise.reject(createRequestStatusError(401, message))
  void toLogin()
  return Promise.reject(createRequestStatusError(401, message))
}

const errorNotificationLock = new Map()
function showErrNotification(key: string, title: string, message: string) {
  if (!errorNotificationLock.has(key)) {
    errorNotificationLock.set(key, true)

    ElNotification({ title, message, type: 'error' })
  }
}

/**
 * 判断请求头集合中是否已经配置指定名称。
 * 数据面板的请求头通常是普通对象，但这里同时兼容 Headers 和元组数组，避免不同请求库
 * 适配层传入其它标准 HeadersInit 形态时误判为“未配置”而覆盖用户值。
 */
function hasHeader(headers: unknown, name: string): boolean {
  if (!headers) return false
  const normalizedName = name.toLowerCase()

  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    return headers.has(name)
  }

  if (Array.isArray(headers)) {
    return headers.some(
      (entry) =>
        Array.isArray(entry) &&
        typeof entry[0] === 'string' &&
        entry[0].toLowerCase() === normalizedName,
    )
  }

  if (typeof headers === 'object') {
    return Object.keys(headers as Record<string, unknown>).some(
      (key) => key.toLowerCase() === normalizedName,
    )
  }

  return false
}

// request 拦截器, 改变url 或 options.
request.interceptors.request.use((url, options) => {
  const embedded = isEmbeddedMode()
  const publicPreview = Boolean(
    (options as RequestErrorOptions & { publicPreview?: boolean }).publicPreview,
  )
  const anonymousPublicPreview = Boolean(
    (options as RequestErrorOptions).anonymousPublicPreview,
  )
  // 独立预览页即使在本地关闭 iframe 模式，也可能从 window.name / xrAuth 恢复宿主上下文；
  // 只要内存上下文存在，就应与内嵌模式使用同一套平台路径和请求头规则。
  const runtimeAuthContext = authContext.get()
  const embeddedContext = embedded ? runtimeAuthContext : null
  const accessToken = normalizeAccessToken(runtimeAuthContext?.accessToken ?? getAccessToken())
  const preserveConfiguredHeaders = Boolean(
    (options as RequestErrorOptions).preserveConfiguredHeaders,
  )
  let resolvedUrl = url

  /**
   * 平台接口文件只维护不带平台段的业务路径，避免同一接口复制出运营端和租户端两套地址。
   * 独立登录使用认证完成时保存的平台，内嵌部署使用父页面声明的平台。缺少身份时的运营
   * 缺省值仅兼容匿名探测；业务路由挂载前必须完成认证。公共接口由调用方跳过改写。
   */
  const requestPlatformType = anonymousPublicPreview
    ? 'operation'
    : runtimeAuthContext?.platformType ?? (!embedded ? 'operation' : undefined)
  if (requestPlatformType && !(options as RequestErrorOptions).skipPlatformPath) {
    resolvedUrl = resolvePlatformApiUrl(url, requestPlatformType)
  }
  const passAuth = getPassAuth(resolvedUrl, options)

  // 认证失效后，历史上标记 passAuth 的第一方接口也必须阻断，不能匿名继续写入业务数据。
  if (embedded && !embeddedContext && !publicPreview && isEmbeddedFirstPartyUrl(resolvedUrl)) {
    throw createRequestStatusError(401, '内嵌认证尚未完成')
  }

  // 无凭据时先阻断请求，由组合根显示登录表单，避免匿名请求与登录状态切换并发。
  if (!accessToken && !passAuth && !embedded) {
    void toLogin()
    throw createRequestStatusError(401, '请先登录')
  }
  /**
   * `passAuth` 表示调用方已经提供了专用鉴权头，不能因为独立模式的路径改写而覆盖它。
   * 三维接口的调用方会从应用程序本地存储读取临时令牌和 ClientId；此前只要 URL 被改写为
   * operation，就会误用管理端 accessToken，并在独立模式遗漏 ClientId。内嵌模式仍由父页面
   * 下发的内存鉴权上下文统一接管第一方请求，避免 iframe 回退到本地登录存储。系统令牌在
   * 自动添加到 Authorization 前会清理已有 Bearer 前缀，保证请求头只出现一层授权方案。
   */
  const shouldUseRuntimeAuth = Boolean(
    !anonymousPublicPreview && runtimeAuthContext && isEmbeddedFirstPartyUrl(resolvedUrl),
  )
  if (!passAuth || shouldUseRuntimeAuth) {
    const configuredAuthorization = preserveConfiguredHeaders && hasHeader(options.headers, 'Authorization')
    const configuredClientId = preserveConfiguredHeaders && hasHeader(options.headers, 'ClientId')
    options.headers = {
      ...options.headers,
      // 数据面板显式配置的鉴权头优先；只有缺少对应字段时才补充系统会话凭证。
      ...(!configuredAuthorization ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...(runtimeAuthContext && !configuredClientId
        ? { ClientId: runtimeAuthContext.clientId }
        : {}),
      ...(runtimeAuthContext?.tenantId && shouldUseRuntimeAuth &&
        !(preserveConfiguredHeaders && hasHeader(options.headers, 'tenant-id'))
        ? { 'tenant-id': runtimeAuthContext.tenantId } : {}),
    }
  }

  // 记录本次是否使用独立登录会话；公开预览和显式手配请求头不允许接入自动续期。
  ;(options as RequestOptionsInit & { __standaloneAuth?: boolean }).__standaloneAuth = Boolean(
    !embedded && !publicPreview && hasStandaloneSession() && shouldUseRuntimeAuth && !preserveConfiguredHeaders,
  )
  ;(options as RequestOptionsInit & { __standaloneVersion?: number }).__standaloneVersion =
    (options as RequestOptionsInit & { __standaloneAuth?: boolean }).__standaloneAuth ? getStandaloneSessionVersion() : undefined
  return { url: resolvedUrl, options }
})

// response 拦截器，提前对响应做异常处理
request.interceptors.response.use(async (response, options) => {
  // 如果 HTTP 异常，直接返回并报错
  const { status } = response
  if (status in ERR_CODE_MSG) {
    if (status === 401) return await handle401(response, options)

    const msg = ERR_CODE_MSG[status as keyof typeof ERR_CODE_MSG]
    if (shouldSuppressNotFoundNotification(options, status)) {
      // 仍然拒绝请求，让调用方把列表置空；这里只跳过全局通知。
      return Promise.reject(createRequestStatusError(status, msg))
    }
    const key = `${status}_${msg}`
    showErrNotification(key, `HTTP 状态异常`, msg)
    return response
  }

  // 处理下载文件的情况
  const downloaded = handleBlobDownload(response, options)
  if (downloaded) return response

  // 处理响应异常
  const data = (await response.clone().json()) as ResponseData
  if (data.code in ERR_CODE_MSG) {
    // HTTP 200 携带业务 401 时保留后端说明，上传等调用方可以展示真实失败原因。
    if (data.code === 401) return await handle401(response, options, data.msg || ERR_CODE_MSG[401])

    const msg = ERR_CODE_MSG[data.code as keyof typeof ERR_CODE_MSG]
    if (shouldSuppressNotFoundNotification(options, data.code)) {
      // 网关可能以 HTTP 200 携带业务 404；统一转换成带状态码的 Error，便于调用方识别。
      return Promise.reject(createRequestStatusError(data.code, data.msg || msg))
    }
    const key = `${data.code}_${data.msg}`
    if (!shouldSuppressPreviewCredentialNotification(options, data.code, data.msg)) {
      showErrNotification(key, `响应异常`, data.msg || msg)
    }
    return Promise.reject(data)
  }

  return response
})

export default request
