import request from '@/request'
import type {
  ComponentDataConfig,
  PublicRequestReferenceConfig,
  AjaxRequestConfig,
  RequestGlobalConfig,
  RequestHttpMethod,
  RequestIntervalUnit,
  PublicRequestConfig,
} from '@/types/data-config'
import {
  findPublicRequestByConfig,
  getPublicRequests,
  getRequestGlobalConfig,
  mergeAjaxRequestWithGlobalConfig,
} from './dataRequestHelpers'
import { evaluateTemplateString, executeDynamicCode } from '@/utils/dynamicCode'
import { getDataSourceAdapter } from './dataSourceAdapters'
import { resolveDataRequestUrl } from './dataRequestUrl'
import {
  assertEmbeddedDataRequestUrl,
  getEmbeddedSceneId,
  mergeDataRequestAuthHeaders,
  type DataRequestRuntimeContext,
} from './dataRequestSecurity'
export type { DataRequestRuntimeContext } from './dataRequestSecurity'

/**
 * 仅在嵌入模式为查询参数追加当前场景编号。
 *
 * 通过浅拷贝生成新的参数对象，保证 `requestQuery`、公共接口配置以及编辑器 Store
 * 中的原始对象不会被运行时参数写回。独立模式完全保留原有参数。
 */
const appendRuntimeSceneId = (
  params: Record<string, unknown> | undefined,
  runtimeContext?: DataRequestRuntimeContext,
) => {
  const nextParams = { ...(params || {}) }
  const sceneId = getEmbeddedSceneId(runtimeContext)
  if (sceneId) nextParams.sceneId = sceneId
  return nextParams
}

/**
 * 按路径从接口响应里提取真实结果。
 *
 * 这里沿用项目既有的点路径读取规则。
 * 当路径为空时直接返回原始数据，保证静态数据、公共请求和普通接口都能复用同一入口。
 */
export const extractResult = (data: unknown, resultPath?: string) => {
  if (!resultPath) return data
  return resultPath.split('.').reduce((result: unknown, key) => {
    return result && typeof result === 'object'
      ? (result as Record<string, unknown>)[key]
      : undefined
  }, data)
}

/**
 * 通过字符串函数对提取结果做二次加工。
 *
 * 这个能力主要服务历史配置兼容。
 * 没有过滤函数时直接返回原值，避免无意义的 `Function` 开销。
 */
export const newFunctionHandle = (data: unknown, res: unknown, funcStr?: string): unknown => {
  if (!funcStr) return data
  return executeDynamicCode('data-filter', { data, res }, funcStr, data)
}

/**
 * 把轮询数值和单位换算成毫秒。
 */
export const intervalUnitHandle = (num: number, unit: RequestIntervalUnit): number => {
  const value = Number(num) || 0
  switch (unit) {
    case 'second':
      return value * 1000
    case 'minute':
      return value * 60 * 1000
    case 'hour':
      return value * 60 * 60 * 1000
    case 'day':
      return value * 24 * 60 * 60 * 1000
    default:
      return value
  }
}

/**
 * 递归执行模板字符串替换。
 *
 * 兼容字符串、数组和普通对象。
 * 出错时保留原始值，避免把请求参数整体打崩。
 */
export const translateStr = (
  str: string | Record<string, unknown> | unknown[],
): string | Record<string, unknown> | unknown[] => {
  if (typeof str === 'string') {
    return evaluateTemplateString(str)
  }

  if (Array.isArray(str)) {
    return str.map((item) =>
      typeof item === 'string' || Array.isArray(item) || (item && typeof item === 'object')
        ? translateStr(item as string | Record<string, unknown> | unknown[])
        : item,
    )
  }

  const result: Record<string, unknown> = {}
  Object.keys(str).forEach((key) => {
    result[key] = translateStr(str[key] as string | Record<string, unknown> | unknown[])
  })
  return result
}

/**
 * 生成一份完整的空请求参数结构。
 *
 * 右侧表单和配置归一化阶段都会复用这份默认骨架。
 */
export const createEmptyRequestParams = (): AjaxRequestConfig['requestParams'] => ({
  Header: {},
  Params: {},
  Body: {
    json: '',
    xml: '',
    'x-www-form-urlencoded': {},
    'form-data': {},
  },
})

/**
 * 判断请求封装是否把浏览器原生响应直接透传出来。
 *
 * `src/request.ts` 在 HTTP 状态异常时会返回原生 Response，以便全局通知能先弹出。
 * 数据配置面板需要的是已经解析好的业务数据；如果继续把 Response 当普通对象解析，
 * 就会把 500、404 这类失败误归一化为空表格，最终导致“请求成功”的错误反馈。
 */
const isNativeResponse = (value: unknown): value is Response =>
  typeof Response !== 'undefined' && value instanceof Response

/**
 * 把未知异常整理成用户能看懂的短文案。
 *
 * 业务错误由请求拦截器以 `{ code, msg }` 抛出，网络错误通常是 Error，
 * HTTP 异常也可能是原生 Response。只读取非空文本，不把整个响应或请求头拼入提示。
 */
const getRequestErrorMessage = (error: unknown) => {
  if (isNativeResponse(error)) {
    const statusText = error.statusText ? ` ${error.statusText}` : ''
    return `接口返回 HTTP ${error.status}${statusText}`
  }

  if (error && typeof error === 'object') {
    const details = error as { msg?: unknown; message?: unknown }
    // 优先保留后端业务说明；空白或非文本 msg 回退至标准异常的 message。
    if (typeof details.msg === 'string' && details.msg.trim()) return details.msg.trim()
    if (typeof details.message === 'string' && details.message.trim()) return details.message.trim()
  }

  if (typeof error === 'string' && error.trim()) return error.trim()

  return '请检查接口地址、跨域配置、请求参数或服务器状态'
}

/**
 * 数据执行层的统一失败类型。
 * 保留原始异常链及可识别的错误码，便于上层展开定位；不保存额外请求配置副本。
 * 使用独立类型识别已包装异常，避免跨入口传播时重复添加“请求执行失败”前缀。
 */
class DataRequestExecutionError extends Error {
  readonly cause: unknown
  readonly code?: string | number
  readonly status?: number

  constructor(error: unknown) {
    super(`请求执行失败：${getRequestErrorMessage(error)}`)
    this.name = 'DataRequestExecutionError'
    // 项目当前的标准库类型尚不支持 Error 的第二个构造参数，显式保留原因以兼容现有编译目标。
    this.cause = error
    if (error && typeof error === 'object') {
      const details = error as { code?: unknown; status?: unknown }
      if (typeof details.code === 'number' || typeof details.code === 'string') {
        this.code = details.code
      }
      if (typeof details.status === 'number') this.status = details.status
    }
  }
}

/**
 * 数据请求失败必须继续向上抛出。
 *
 * 右侧面板的成功提示以 Promise 是否 reject 为准；如果这里返回 null，
 * 上层会把失败当成“空数据成功”，从而出现控制台报错但界面提示成功的问题。
 */
const throwRequestExecutionError = (error: unknown): never => {
  // 底层只整理并抛出，由轮询、交互或面板入口统一记录，避免同一失败打印两遍。
  throw error instanceof DataRequestExecutionError ? error : new DataRequestExecutionError(error)
}

/**
 * 从请求响应中提取真实载荷，并拦截 HTTP 失败响应。
 *
 * 成功接口通常返回业务对象、数组，或 `{ data/content }` 包装对象。
 * 如果收到原生 Response，说明请求封装没有拿到可解析业务数据；
 * 在数据配置场景下应直接判定为失败，避免把错误页面或 500 响应当成空表。
 */
export const resolveRequestPayload = (response: unknown) => {
  if (isNativeResponse(response)) {
    throwRequestExecutionError(response)
  }

  if (response && typeof response === 'object') {
    const responseRecord = response as { data?: unknown; content?: unknown }
    if (responseRecord.data !== undefined) return responseRecord.data
    if (responseRecord.content !== undefined) return responseRecord.content
  }

  return response
}

/**
 * 从对象响应中寻找唯一的数组字段。
 *
 * 很多第三方接口会返回 `{ message, date, events: [...] }` 这类结构。
 * 右侧数据面板最终需要二维行数据；当对象里只有一个“对象数组”字段时，
 * 这个数组通常就是用户真正想绑定和展示的数据列表。
 *
 * 注意这里必须排除字符串数组等值数组。
 * 例如过滤器返回单条事件对象时，里面会有 `tags: string[]`；
 * 如果把 tags 误判成行数据，后续会因为数组元素不是对象而得到空数据。
 */
const findOnlyArrayFieldValue = (payload: unknown) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined

  const arrayValues = Object.values(payload as Record<string, unknown>).filter(
    (value): value is unknown[] =>
      Array.isArray(value) &&
      value.every((item) => Boolean(item && typeof item === 'object' && !Array.isArray(item))),
  )
  return arrayValues.length === 1 ? arrayValues[0] : undefined
}

/**
 * 推导过滤器和二维表归一化的默认输入值。
 *
 * 优先级保持向后兼容：
 * 1. 接口包装对象里的 data；
 * 2. 接口包装对象里的 content；
 * 3. 对象响应中的唯一数组字段；
 * 4. 原始响应本身。
 *
 * 这样既兼容后端常见 `{ data: [...] }`，也能直接支持 Uapis 这类 `{ events: [...] }` 响应。
 */
export const resolveDefaultRequestDataPayload = (payload: unknown) => {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const payloadRecord = payload as { data?: unknown; content?: unknown }
    if (payloadRecord.data !== undefined) return payloadRecord.data
    if (payloadRecord.content !== undefined) return payloadRecord.content

    const onlyArrayFieldValue = findOnlyArrayFieldValue(payload)
    if (onlyArrayFieldValue !== undefined) return onlyArrayFieldValue
  }

  return payload
}

/**
 * 把“最终数据内容”转换成二维表行。
 *
 * 这里不再继续自动拆唯一数组字段，因为过滤器返回值已经是用户指定的最终结果。
 * 如果用户返回单个对象，就把它作为单行数据；如果返回对象数组，就按多行数据处理。
 */
const normalizeFinalRows = (
  payload: unknown,
): { dimensions: string[]; source: Record<string, unknown>[] } => {
  const source = Array.isArray(payload)
    ? payload.filter((item): item is Record<string, unknown> =>
        Boolean(item && typeof item === 'object'),
      )
    : payload && typeof payload === 'object'
      ? [payload as Record<string, unknown>]
      : []

  return {
    dimensions: source[0] ? Object.keys(source[0]) : [],
    source,
  }
}

/**
 * 按结构化请求参数执行自定义请求。
 *
 * 该入口主要兼容旧项目遗留的 Header、Params、Body 分栏配置能力。
 */
export const customizeHttpRequest = async (
  config: AjaxRequestConfig,
  globalConfig: RequestGlobalConfig = getRequestGlobalConfig(),
  runtimeContext?: DataRequestRuntimeContext,
) => {
  const mergedConfig = mergeAjaxRequestWithGlobalConfig(config, globalConfig)
  const {
    requestHttpType,
    requestHeaders = {},
    requestBody = '',
    requestContentType,
    requestParams,
    requestParamsBodyType,
    requestSQLContent,
  } = mergedConfig

  let headers: Record<string, unknown> = {
    ...(requestParams?.Header || {}),
    ...(requestHeaders || {}),
  }
  headers = translateStr(headers) as Record<string, unknown>

  let data: Record<string, unknown> | FormData | string = {}
  switch (requestParamsBodyType || 'none') {
    case 'none':
      break
    case 'json': {
      headers['Content-Type'] = 'application/json'
      const jsonStr = requestParams?.Body?.json || requestBody || ''
      const translated = translateStr(jsonStr)
      data = typeof translated === 'string' ? JSON.parse(translated) : translated
      break
    }
    case 'xml': {
      headers['Content-Type'] = 'application/xml'
      data = translateStr(requestParams?.Body?.xml || '') as string
      break
    }
    case 'x-www-form-urlencoded': {
      headers['Content-Type'] = 'application/x-www-form-urlencoded'
      const formData = new FormData()
      const bodyParams = requestParams?.Body?.['x-www-form-urlencoded'] || {}
      for (const key in bodyParams) {
        formData.set(key, String(translateStr(bodyParams[key] as string | Record<string, unknown>)))
      }
      data = formData
      break
    }
    case 'form-data': {
      headers['Content-Type'] = 'multipart/form-data'
      const formData = new FormData()
      const bodyParams = requestParams?.Body?.['form-data'] || {}
      for (const key in bodyParams) {
        formData.set(key, String(translateStr(bodyParams[key] as string | Record<string, unknown>)))
      }
      data = formData
      break
    }
  }

  if (requestContentType === 'sql') {
    headers['Content-Type'] = 'application/json'
    data = requestSQLContent || { sql: '' }
  }

  try {
    const resolved = resolveRequestAddress(mergedConfig)
    const { url } = resolved
    assertEmbeddedDataRequestUrl(url)
    // 依 URL 来源补齐平台凭证；显式配置的 Authorization 与 ClientId 保持优先。
    headers = mergeDataRequestAuthHeaders(url, headers)
    const options: Record<string, unknown> = {
      method: requestHttpType || 'GET',
      headers,
      passAuth: mergedConfig.useAuth === false,
      // 数据面板的地址是用户配置的业务接口，必须按原值发送；它不属于平台路由分流，
      // 因此禁止 request.ts 根据当前宿主平台自动插入 operation 或 tenant/web 段。
      skipPlatformPath: true,
      // 用户配置的 Header 必须完整透传；系统凭证只在对应 Header 缺失时补充。
      preserveConfiguredHeaders: true,
      dataPanelRequest: true,
      publicPreview: runtimeContext?.publicPreview === true,
    }
    // 场景编号属于宿主必需参数，在地址占位字段移除后追加，不能被业务占位意外消费。
    const params = appendRuntimeSceneId(resolved.params, runtimeContext)
    if (Object.keys(params).length > 0) {
      options.params = params
    }
    if (
      requestHttpType !== 'GET' &&
      data &&
      (typeof data !== 'object' || Object.keys(data).length > 0)
    ) {
      options.data = data
    }
    return await request(url, options)
  } catch (error) {
    throwRequestExecutionError(error)
  }
}

/**
 * 把“接口原始返回值 + 提取路径 + 过滤器”稳定转换成表格数据。
 *
 * 当没有过滤器时，这个入口等价于旧的响应行归一化逻辑；
 * 统一收口能避免维护两份几乎相同的解析流程。
 */
export const transformRequestPayloadToRows = (
  payload: unknown,
  resultPath?: string,
  filterFn?: string,
) => {
  const extracted = extractResult(payload, resultPath)
  const defaultDataPayload = resolveDefaultRequestDataPayload(extracted)
  const filtered = newFunctionHandle(defaultDataPayload, payload, filterFn)
  return normalizeFinalRows(filtered)
}

/**
 * 构建已合并配置的原始请求地址，仅用于判空，不提前求值或重复合并全局配置。
 */
const buildRequestUrl = (config: AjaxRequestConfig) =>
  `${config.requestOriginUrl || ''}${config.requestUrl || ''}`.trim()

/**
 * 结构化请求和旧简单请求共用地址解析，保证编辑器、公共请求、预览与轮询行为一致。
 * 查询参数旧别名保留原有优先级；交互赋值器已经同步更新两处，因此读取到最新记录编号。
 */
const resolveRequestAddress = (config: AjaxRequestConfig) =>
  resolveDataRequestUrl(
    buildRequestUrl(config),
    translateStr({ ...config.requestParams?.Params, ...config.requestQuery }) as Record<
      string,
      unknown
    >,
  )

/**
 * 构建简单请求模式下的请求参数，使用已解析的查询参数，避免重复发送地址占位字段。
 */
const buildRequestOptions = (
  config: AjaxRequestConfig,
  params: Record<string, unknown>,
  runtimeContext?: DataRequestRuntimeContext,
) => {
  const method = (config.requestHttpType || 'GET') as RequestHttpMethod
  const headers = { ...(config.requestHeaders || {}) }
  const options: Record<string, unknown> = {
    method,
    headers,
    passAuth: config.useAuth === false,
    // 简单请求与结构化请求保持一致：配置路径和平台权限解耦，禁止自动拼接平台段。
    skipPlatformPath: true,
    // 用户配置的 Header 必须完整透传；系统凭证只在对应 Header 缺失时补充。
    preserveConfiguredHeaders: true,
    publicPreview: runtimeContext?.publicPreview === true,
  }

  const runtimeParams = appendRuntimeSceneId(params, runtimeContext)
  if (Object.keys(runtimeParams).length > 0) {
    options.params = runtimeParams
  }

  if (method !== 'GET' && config.requestBody) {
    try {
      options.data = JSON.parse(config.requestBody)
    } catch {
      options.data = config.requestBody
    }
  }

  return options
}

/**
 * 执行一条请求配置并归一化返回数据。
 *
 * 这里统一兼容：
 * 1. 结构化请求参数；
 * 2. SQL 模式；
 * 3. 旧配置的简单请求模式。
 */
export const executeRequestConfig = async (
  config: AjaxRequestConfig,
  resultPath?: string,
  filterFn?: string,
  globalConfig: RequestGlobalConfig = getRequestGlobalConfig(),
  runtimeContext?: DataRequestRuntimeContext,
) => {
  const mergedConfig = mergeAjaxRequestWithGlobalConfig(config, globalConfig)
  const url = buildRequestUrl(mergedConfig)
  if (!url) {
    return {
      dimensions: [] as string[],
      source: [] as Record<string, unknown>[],
      raw: null,
    }
  }

  const hasStructuredParams =
    mergedConfig.requestParams &&
    (Object.keys(mergedConfig.requestParams.Params || {}).length > 0 ||
      Object.keys(mergedConfig.requestParams.Header || {}).length > 0 ||
      mergedConfig.requestParams.Body?.json ||
      mergedConfig.requestParams.Body?.xml)
  const isSqlMode = mergedConfig.requestContentType === 'sql'
  const isNonStandardBody =
    mergedConfig.requestParamsBodyType &&
    mergedConfig.requestParamsBodyType !== 'none' &&
    mergedConfig.requestParamsBodyType !== 'json'

  let payload: unknown
  if (hasStructuredParams || isSqlMode || isNonStandardBody) {
    const response = await customizeHttpRequest(mergedConfig, globalConfig, runtimeContext)
    payload = resolveRequestPayload(response)
  } else {
    // 旧简单请求也先完成地址替换，再校验来源并补充鉴权，不能校验未解析的模板地址。
    const resolved = resolveRequestAddress(mergedConfig)
    const resolvedUrl = resolved.url
    assertEmbeddedDataRequestUrl(resolvedUrl)
    const options = buildRequestOptions(mergedConfig, resolved.params, runtimeContext)
    // 简单请求与结构化请求共用鉴权合并规则，保证三维服务令牌来源一致。
    options.headers = {
      ...mergeDataRequestAuthHeaders(resolvedUrl, options.headers as Record<string, unknown>),
    }
    options.dataPanelRequest = true
    options.publicPreview = runtimeContext?.publicPreview === true
    try {
      const response = await request(resolvedUrl, options)
      payload = resolveRequestPayload(response)
    } catch (error) {
      // 简单请求与结构化请求使用同一异常协议，防止后端对象直接进入上层后丢失 msg。
      throwRequestExecutionError(error)
    }
  }

  const normalized = transformRequestPayloadToRows(
    payload,
    resultPath || mergedConfig.resultPath,
    filterFn,
  )

  return {
    ...normalized,
    raw: payload,
  }
}

/**
 * 按组件数据配置执行请求。
 *
 * 这里只处理 `ajax/public` 两种真正需要发请求的模式。
 * `static/dataset` 由上层通过 `resolveComponentData` 直接解析。
 */
export const executeComponentRequestByType = async (
  dataConfig: ComponentDataConfig | null | undefined,
  publicRequests: PublicRequestConfig[] = getPublicRequests(),
  globalConfig: RequestGlobalConfig = getRequestGlobalConfig(),
  runtimeContext?: DataRequestRuntimeContext,
) => {
  if (!dataConfig) {
    return null
  }

  if (dataConfig.request.type === 'ajax') {
    return executeRequestConfig(
      dataConfig.request.config as AjaxRequestConfig,
      dataConfig.extractor?.resultPath,
      dataConfig.filterFn,
      globalConfig,
      runtimeContext,
    )
  }

  if (dataConfig.request.type === 'public') {
    const publicRequest = findPublicRequestByConfig(
      publicRequests,
      dataConfig.request.config as PublicRequestReferenceConfig,
    )

    if (!publicRequest) {
      return {
        dimensions: [] as string[],
        source: [] as Record<string, unknown>[],
        raw: null,
      }
    }

    return executeRequestConfig(
      publicRequest,
      dataConfig.extractor?.resultPath,
      dataConfig.filterFn,
      globalConfig,
      runtimeContext,
    )
  }

  if (dataConfig.request.type === 'adapter') {
    const requestConfig = dataConfig.request.config as { adapterId?: unknown; config?: unknown }
    const adapterId = typeof requestConfig.adapterId === 'string' ? requestConfig.adapterId : ''
    const adapter = getDataSourceAdapter(adapterId)
    const config = adapter?.normalizeConfig(requestConfig.config)
    if (!adapter || !config) return { dimensions: [], source: [], raw: null }
    return adapter.read(config)
  }

  return null
}
