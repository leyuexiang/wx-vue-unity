import request from '@/request'
import { getDim3dHeaders } from './auth'
import { DIM3D_ADMIN_API, DIM3D_API_PREFIX } from './constants'

export const MODEL_IMPORT_URL = `${DIM3D_API_PREFIX}/dim3d/model-imports`
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
export async function publishModelImport(
  id: string,
  resourceId: string,
  directory: { modelName: string; category: string; modelDesc?: string },
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
