import request from '@/request'
import { getDim3dHeaders } from './auth'
import { DIM3D_ADMIN_API, DIM3D_API_PREFIX } from './constants'

export const MODEL_IMPORT_URL = `${DIM3D_API_PREFIX}/dim3d/model-imports`
export const MODEL_UPLOAD_URL = `${DIM3D_API_PREFIX}/dim3d/resource/uploadConvert`
export const MODEL_IMPORT_MAX_BYTES = 500 * 1024 * 1024
interface ModelImportBase {
  operationId: string
  targetFormat: 'gltf' | 'glb'
  source: { size: string; sha256: string }
}
export type ModelImportRequest = ModelImportBase & (
  { operationType: 'CREATE'; resourceScope: 'GLOBAL_SYSTEM' | 'TENANT_SHARED'; metadata: { resourceName: string; assetName: string } } |
  { operationType: 'REPLACE'; resourceId: string; expectedRevision: string }
)
export interface ModelImportStatus {
  operationId: string
  resourceId: string
  importStatus: string
  operationStatus: string
  targetFormat: 'gltf' | 'glb'
  committedRevision: string | null
  errorMessage: string | null
  retryable: boolean
}
interface SourceTarget { uploadUrl: string; method: 'PUT'; expiresInSeconds: number; sourceSize: string; sourceSha256: string }

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const states = new Set(['RECEIVING', 'QUEUED', 'VERIFYING_SOURCE', 'CONVERTING', 'VALIDATING', 'PUBLISHING', 'FAILED', 'COMMITTED', 'CANCELLED', 'CONFLICT', 'EXPIRED'])
/** 编号不转Number，避免雪花编号精度丢失；仅COMMITTED原操作可以向表单释放可用编号。 */
export function validateImportStatus(value: ModelImportStatus, operationId: string): ModelImportStatus {
  if (!value || value.operationId !== operationId || typeof value.resourceId !== 'string' ||
      !/^[1-9]\d{0,18}$/.test(value.resourceId) || BigInt(value.resourceId) > 9223372036854775807n ||
      !states.has(value.importStatus) || !['UPLOADING', 'VERIFYING', 'COMMITTED', 'FAILED', 'CANCELLED', 'CONFLICT', 'EXPIRED'].includes(value.operationStatus) ||
      !['gltf', 'glb'].includes(value.targetFormat)) throw new Error('模型导入响应格式错误')
  if (value.importStatus === 'COMMITTED' || value.operationStatus === 'COMMITTED') {
    if (value.importStatus !== 'COMMITTED' || value.operationStatus !== 'COMMITTED' ||
        typeof value.committedRevision !== 'string' || !/^[1-9]\d{0,18}$/.test(value.committedRevision) ||
        BigInt(value.committedRevision) > 9223372036854775807n) throw new Error('模型尚未取得有效的提交回执')
  }
  return value
}

async function api<T>(path: string, signal: AbortSignal, body?: unknown): Promise<T> {
  if (!DIM3D_ADMIN_API) throw new Error('当前服务暂不支持新的模型导入，请联系管理员')
  const result = await request<{ code: number; msg?: string; data: T }>(`${MODEL_IMPORT_URL}${path}`, {
    method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { data: body }),
    headers: getDim3dHeaders(), passAuth: true, skipPlatformPath: true, signal,
    suppressNotFoundNotification: true,
  }).catch((error: unknown) => {
    const status = (error as { response?: { status?: number }; status?: number })
    if (status?.response?.status === 404 || status?.status === 404) throw new Error('模型导入服务尚未启用，请联系管理员')
    throw error
  })
  if (result?.code !== 200 || !result.data) throw new Error(result?.msg || '模型导入失败，服务可能尚未启用')
  return result.data
}
function checkedId(id: string) { if (!uuid.test(id)) throw new Error('导入操作编号无效'); return encodeURIComponent(id) }
export async function createModelImport(body: ModelImportRequest, signal: AbortSignal) {
  checkedId(body.operationId)
  return validateImportStatus(await api<ModelImportStatus>('', signal, body), body.operationId)
}
export async function getModelImport(id: string, signal: AbortSignal) {
  return validateImportStatus(await api<ModelImportStatus>(`/${checkedId(id)}`, signal), id)
}
export async function submitModelImport(id: string, signal: AbortSignal) {
  return validateImportStatus(await api<ModelImportStatus>(`/${checkedId(id)}/submit`, signal, {}), id)
}
/** 确认目录字段后由原导入操作发布，回执仍要核对资源身份。 */
export interface ModelImportDirectory {
  modelName: string
  category: string
  modelDesc?: string
  /** 省略时替换保留原封面，显式空值清空。编号保持字符串精度。 */
  coverImageId?: string | null
  isPaid?: 'FREE' | 'PAID'
  /** 数据库整数分，付费时必填，免费时为零。 */
  price?: number
}

export async function publishModelImport(
  id: string,
  resourceId: string,
  directory: ModelImportDirectory,
  signal: AbortSignal,
) {
  const status = validateImportStatus(await api<ModelImportStatus>(`/${checkedId(id)}/publish`, signal, directory), id)
  if (status.resourceId !== resourceId || !['PUBLISHING', 'COMMITTED'].includes(status.importStatus)) {
    throw new Error('发布回执与目标资源不一致')
  }
  return status
}

/** 编辑文件时取得并发修订再替换原资源，不能暗中创建另一业务资源身份。 */
export async function getModelResourceRevision(resourceId: string, signal: AbortSignal): Promise<string> {
  if (!/^[1-9]\d{0,18}$/.test(resourceId)) throw new Error('原模型资源编号无效')
  const response = await request<{ code: number; data?: { currentRevision: string } }>(`${DIM3D_API_PREFIX}/dim3d/resources/${encodeURIComponent(resourceId)}/current`, {
    method: 'GET', headers: getDim3dHeaders(), passAuth: true, skipPlatformPath: true, signal,
  })
  const revision = response.data?.currentRevision
  if (response.code !== 200 || typeof revision !== 'string' || !/^[1-9]\d{0,18}$/.test(revision) || BigInt(revision) > 9223372036854775807n) throw new Error('原资源尚未纳入受控导入，不能直接替换')
  return revision
}

/** 签名PUT使用独立fetch，绝不携带业务Authorization、ClientId或租户头，也不进入401刷新逻辑。 */
export async function uploadModelSource(body: ModelImportRequest, file: File, signal: AbortSignal): Promise<void> {
  const target = await api<SourceTarget>(`/${checkedId(body.operationId)}/source-target`, signal, {})
  if (target.method !== 'PUT' || target.sourceSize !== body.source.size || target.sourceSha256 !== body.source.sha256) throw new Error('原文件上传目标与本次导入不一致')
  const url = new URL(target.uploadUrl)
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('原文件上传目标无效')
  const response = await fetch(url.href, { method: 'PUT', body: file, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal })
  if (!response.ok) throw new Error('原始模型上传失败，请使用原任务重试')
}

/** 网络响应丢失后复用原操作，不创建第二个资源；已入队/已提交则不重复上传。 */
export async function receiveModelImport(body: ModelImportRequest, file: File, signal: AbortSignal, onStage: (text: string) => void) {
  if (file.size <= 0 || file.size > MODEL_IMPORT_MAX_BYTES || String(file.size) !== body.source.size) throw new Error('原文件大小与导入请求不一致或超过500MB')
  onStage('正在创建导入任务')
  const state = await createModelImport(body, signal)
  if (state.targetFormat !== body.targetFormat || (body.operationType === 'REPLACE' && state.resourceId !== body.resourceId)) throw new Error('导入响应与目标资源不一致')
  if (state.importStatus !== 'RECEIVING') return state
  onStage('正在上传原始模型')
  await uploadModelSource(body, file, signal)
  onStage('正在提交导入任务')
  return submitModelImport(body.operationId, signal)
}


/** 自动等待封装在接口层，弹窗只消费转换完成或目录提交完成的结果。 */
async function waitForModel(
  initial: ModelImportStatus,
  target: 'PUBLISHING' | 'COMMITTED',
  signal: AbortSignal,
): Promise<ModelImportStatus> {
  const deadline = Date.now() + 10 * 60 * 1000
  let state = validateImportStatus(initial, initial.operationId)
  while (state.importStatus !== target && state.importStatus !== 'COMMITTED') {
    signal.throwIfAborted()
    if (['FAILED', 'CANCELLED', 'EXPIRED', 'CONFLICT'].includes(state.importStatus)) {
      throw new Error(state.errorMessage || '模型处理失败，请重新上传')
    }
    if (Date.now() >= deadline) throw new Error('模型处理超时，请稍后重试')
    // 单次轮询结束即移除监听器，关闭弹窗会立即释放定时器和在途请求。
    await new Promise<void>((resolve, reject) => {
      const cancel = () => { clearTimeout(timer); reject(signal.reason) }
      const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve() }, 1500)
      signal.addEventListener('abort', cancel, { once: true })
      if (signal.aborted) cancel()
    })
    state = await getModelImport(initial.operationId, signal)
    if (state.resourceId !== initial.resourceId) throw new Error('模型处理结果与上传资源不一致')
  }
  signal.throwIfAborted()
  return state
}

/** 新增走单次业务上传，摘要、原包存储及转换入队由后端处理。 */
export async function uploadModel(
  file: File,
  resourceBelong: 'SYSTEM' | 'MINE',
  signal: AbortSignal,
  onStage: (text: string) => void,
  replaceResourceId?: string,
): Promise<ModelImportStatus> {
  if (!/\.zip$/i.test(file.name) || file.size <= 0 || file.size > MODEL_IMPORT_MAX_BYTES) {
    throw new Error('请选择1字节至500MB的ZIP模型压缩包')
  }
  onStage('上传中')
  let state: ModelImportStatus
  if (replaceResourceId) {
    // 既有编辑替换保留原资源及并发修订规则，细节收在适配层。
    const { hashModelFile } = await import('@/utils/modelImport/hashFile')
    const expectedRevision = await getModelResourceRevision(replaceResourceId, signal)
    const sha256 = await hashModelFile(file, signal)
    const operationId = globalThis.crypto.randomUUID()
    state = await receiveModelImport({ operationId, operationType: 'REPLACE', resourceId: replaceResourceId,
      expectedRevision, targetFormat: 'glb', source: { size: String(file.size), sha256 } }, file, signal, onStage)
  } else {
    const data = new FormData()
    data.append('file', file)
    data.append('resourceBelong', resourceBelong)
    const response = await request<{ code: number; msg?: string; data: ModelImportStatus }>(
      MODEL_UPLOAD_URL, {
        method: 'POST', data, requestType: 'form', headers: getDim3dHeaders(), passAuth: true, skipPlatformPath: true,
        signal, timeout: 10 * 60 * 1000,
      })
    if (response.code !== 200 || !response.data || !uuid.test(response.data.operationId)) {
      throw new Error(response.msg || '模型上传失败')
    }
    state = response.data
  }
  onStage('处理中')
  return waitForModel(state, 'PUBLISHING', signal)
}

/** 保存复用模型新增入口，原操作编号保证响应丢失后再次保存仍只有一条目录。 */
export async function saveUploadedModel(
  uploaded: ModelImportStatus,
  directory: ModelImportDirectory,
  signal: AbortSignal,
  replacing = false,
): Promise<ModelImportStatus> {
  checkedId(uploaded.operationId)
  let state: ModelImportStatus
  if (replacing) state = await publishModelImport(uploaded.operationId, uploaded.resourceId, directory, signal)
  else {
    const response = await request<{ code: number; msg?: string; data: ModelImportStatus }>(
      `${DIM3D_API_PREFIX}/dim3d/model/add`, {
        method: 'POST', data: { ...directory, operationId: uploaded.operationId, resourceId: uploaded.resourceId },
        headers: getDim3dHeaders(), passAuth: true, skipPlatformPath: true, signal,
      })
    if (response.code !== 200 || !response.data) throw new Error(response.msg || '模型保存失败')
    state = validateImportStatus(response.data, uploaded.operationId)
    if (state.resourceId !== uploaded.resourceId) throw new Error('模型保存结果与上传资源不一致')
  }
  return waitForModel(state, 'COMMITTED', signal)
}
