import request from '@/request'
import { getDim3dHeaders } from './auth'
import { DIM3D_ADMIN_API, DIM3D_API_PREFIX, DIM3D_PLATFORM_API_PREFIX } from './constants'
import { addDim3dModel, editDim3dModel, type Dim3dModelForm } from './model'

/** 导入生命周期与目录属于同一平台，签名上传仍直接请求对象存储。 */
export const MODEL_IMPORT_URL = `${DIM3D_PLATFORM_API_PREFIX}/dim3d/model-imports`
export const MODEL_UPLOAD_URL = `${DIM3D_PLATFORM_API_PREFIX}/dim3d/resource/uploadConvert`
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
/** 只有转换就绪后才交给表单。仅原位替换需要在保存时传回导入操作编号。 */
export type ReadyModelUpload = {
  modelFileId: string
  replacementOperationId?: string
}

interface LegacyModelUpload {
  id?: string
  resourceType?: string
}

interface SourceTarget { uploadUrl: string; method: 'PUT'; expiresInSeconds: number; sourceSize: string; sourceSha256: string }

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
/** 服务端资源编号遵循有符号 64 位正整数范围，禁止用数值形式接收长编号。 */
const isModelFileId = (value: unknown): value is string =>
  typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n
const states = new Set(['RECEIVING', 'QUEUED', 'VERIFYING_SOURCE', 'CONVERTING', 'VALIDATING', 'PUBLISHING', 'FAILED', 'COMMITTED', 'CANCELLED', 'CONFLICT', 'EXPIRED'])
/** 编号始终保留字符串。已提交状态还必须携带有效修订，转换就绪可先交给目录表单。 */
export function validateImportStatus(value: ModelImportStatus, operationId: string): ModelImportStatus {
  if (!value || value.operationId !== operationId || !isModelFileId(value.resourceId) ||
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
    headers: getDim3dHeaders(), passAuth: true, signal,
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


/** 上传轮询只等待转换完成，目录提交的最终结果由新增或编辑回执确认。 */
async function waitForConvertedModel(
  initial: ModelImportStatus,
  signal: AbortSignal,
): Promise<ModelImportStatus> {
  const deadline = Date.now() + 10 * 60 * 1000
  let state = validateImportStatus(initial, initial.operationId)
  while (state.importStatus !== 'PUBLISHING' && state.importStatus !== 'COMMITTED') {
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

/** 新增由后端处理原包和入队，继续传旧归属参数以进入受管上传分支。 */
export async function uploadModel(
  file: File,
  resourceBelong: 'SYSTEM' | 'MINE',
  signal: AbortSignal,
  onStage: (text: string) => void,
  replaceResourceId?: string,
): Promise<ReadyModelUpload> {
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
    const response = await request<{ code: number; msg?: string; data?: ModelImportStatus | LegacyModelUpload }>(
      MODEL_UPLOAD_URL, {
        method: 'POST', data, requestType: 'form', headers: getDim3dHeaders(), passAuth: true,
        skipPlatformPath: !DIM3D_ADMIN_API,
        signal, timeout: 10 * 60 * 1000,
      })
    if (response?.code !== 200 || !response.data) {
      throw new Error(response?.msg || '模型上传失败，未取得有效导入回执')
    }
    signal.throwIfAborted()
    const receipt = response.data
    if (!('operationId' in receipt)) {
      // 同步转换直接给出文件元信息。只有明确为模型且编号有效，才可跳过状态轮询。
      if (receipt.resourceType !== 'MODEL' || !isModelFileId(receipt.id)) {
        throw new Error('模型上传回执缺少有效文件编号')
      }
      return { modelFileId: receipt.id }
    }
    checkedId(receipt.operationId)
    state = receipt
  }
  onStage('处理中')
  const converted = await waitForConvertedModel(state, signal)
  return {
    modelFileId: converted.resourceId,
    ...(replaceResourceId ? { replacementOperationId: converted.operationId } : {}),
  }
}

/** 上传只提供可信文件编号。正式提交统一走目录表单，空回执表示事务已经完成。 */
export async function saveUploadedModel(
  uploaded: ReadyModelUpload,
  directory: Omit<Dim3dModelForm, 'modelFileId'>,
  signal: AbortSignal,
  directoryId?: string,
): Promise<void> {
  if (!isModelFileId(uploaded.modelFileId)) throw new Error('模型文件编号无效')
  const operationId = uploaded.replacementOperationId
  if (operationId) {
    checkedId(operationId)
    if (!directoryId) throw new Error('缺少原模型目录编号')
  }
  const body: Dim3dModelForm = { ...directory, modelFileId: uploaded.modelFileId }
  const options = { signal, skipPlatformPath: !DIM3D_ADMIN_API, timeout: 10 * 60 * 1000 }
  if (directoryId) {
    await editDim3dModel(directoryId, body, {
      ...options,
      // 受管替换继续使用原操作和原资源编号；历史目录绑定新文件时无需传操作编号。
      ...(operationId ? { params: { operationId } } : {}),
    })
  } else {
    await addDim3dModel(body, options)
  }
}
