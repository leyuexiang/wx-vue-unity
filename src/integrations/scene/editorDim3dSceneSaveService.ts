import { preserveUneditedThreeDDomain } from './twoDPackagePreservation'
import type { SceneDefinition } from '@/scene-platform'
import type { SceneSaveEdits } from '@/scene-platform/core/sceneSaveEdits'
import {
  createDim3dSceneSaveAllBody,
  saveAllDim3dScene,
  type Dim3dSceneSaveAllBody,
  type Dim3dSceneSaveAllResponse,
  type Dim3dSceneSaveResult,
} from '@/servers/manual/dim3d/api/sceneRuntime'

/**
 * 当前编辑页持有的后端保存上下文。
 *
 * 锁令牌只由编辑器根组件管理并向保存入口注入，保存组件和领域 Store 都不读取会话存储，
 * 从而避免锁凭证横向扩散到平台核心或浏览器本地场景仓储。
 */
export interface EditorDim3dSceneSaveContext {
  sceneId: string
  lockToken: string
  baseRevisionNo?: number
}

/** 保存成功后供编辑器根组件更新的后端书签。 */
export interface EditorDim3dSceneSaveBookmark {
  sceneId: string
  requestId: string
  revisionId?: string
  revisionNo?: number
  lockVersion?: number
  savedTime?: string
}

export interface EditorDim3dSceneSaveServiceOptions {
  /** 由实际运行端确定允许保存变换的实例，二维编辑仍保全原三维域。 */
  editableTransformIds?: ReadonlySet<string>
  /** 显式层级命令接管的实例，含受到兄弟顺序变化影响的节点。 */
  editableHierarchyIds?: ReadonlySet<string>
  /** 仅显式删除允许从原始四包移除实例。 */
  deletedObjectIds?: ReadonlySet<string>
  /** 只将实际编辑的图层和实例字段合入原四包。 */
  saveEdits?: SceneSaveEdits
  /** 单元测试可注入接口替身；生产路径始终使用四包整体保存接口。 */
  saveAll?: (body: Dim3dSceneSaveAllBody) => Promise<Dim3dSceneSaveAllResponse>
  /** 单元测试可注入固定幂等键；生产路径每次点击保存生成一个新键。 */
  createRequestId?: () => string
  changeSummary?: string
}

const SCENE_ID_PATTERN = /^[1-9]\d*$/

/** 为单次保存生成幂等键；不支持原生 UUID 时使用时间戳和随机片段保证页签内唯一。 */
const createSaveRequestId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `scene-save-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

const assertOptionalNonNegativeInteger = (value: number | undefined, fieldName: string) => {
  if (value === undefined) return
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${fieldName} 必须是非负整数。`)
  }
}

const assertSaveContext = (context: EditorDim3dSceneSaveContext) => {
  const sceneId = context.sceneId.trim()
  const lockToken = context.lockToken.trim()
  if (!SCENE_ID_PATTERN.test(sceneId)) {
    throw new Error('当前场景缺少有效编号，无法保存。')
  }
  if (!lockToken) {
    throw new Error('当前场景编辑锁令牌不存在，无法保存。')
  }
  assertOptionalNonNegativeInteger(context.baseRevisionNo, 'baseRevisionNo')
  return { sceneId, lockToken }
}

/**
 * 严格校验四包整体保存结果。
 *
 * HTTP 请求成功不等于业务保存成功。只有业务码为 200、明确未冲突且后端返回同一场景编号时，
 * 才允许页面清除脏状态；任何缺失或不一致都按保存失败处理，防止空响应被误报为成功。
 */
const assertSaveSucceeded = (
  response: Dim3dSceneSaveAllResponse,
  sceneId: string,
): Dim3dSceneSaveResult & { sceneId: string; conflict: false } => {
  if (response.code !== 200) {
    throw new Error(response.msg?.trim() || `场景保存失败，业务码：${String(response.code)}`)
  }
  if (!response.data) {
    throw new Error('场景保存接口未返回保存结果。')
  }
  if (response.data.conflict !== false) {
    const conflictRevision = response.data.conflictRevisionNo
    throw new Error(
      conflictRevision === undefined
        ? '场景保存发生版本冲突，请重新进入编辑器后再保存。'
        : `场景保存发生版本冲突，服务端当前修订号为 ${conflictRevision}。`,
    )
  }
  if (response.data.sceneId !== sceneId) {
    throw new Error(`场景保存接口返回了不一致的场景编号：${String(response.data.sceneId ?? '')}`)
  }
  return response.data as Dim3dSceneSaveResult & { sceneId: string; conflict: false }
}

/**
 * 将完整 SceneDefinition 一次转换为四包并调用唯一的 saveAll 接口。
 *
 * 本服务不包含 localStorage、分包补偿或四接口并发逻辑。四个 JSON 字符串属于同一个请求，
 * 由后端在同一行覆盖；请求失败时仅抛错并保留页面内存中的编辑状态。
 */
export const saveEditorSceneToDim3d = async (
  scene: SceneDefinition,
  context: EditorDim3dSceneSaveContext,
  options: EditorDim3dSceneSaveServiceOptions = {},
): Promise<EditorDim3dSceneSaveBookmark> => {
  const { sceneId, lockToken } = assertSaveContext(context)
  const requestId = (options.createRequestId ?? createSaveRequestId)().trim()
  if (!requestId) throw new Error('保存请求幂等键不能为空。')

  /**
   * scene.id 是编辑器领域对象的运行时标识，复制场景后可能仍来自源快照；保存身份必须使用
   * 已取得编辑锁的上下文 sceneId。转换器只把该编号放在请求顶层，sceneJson 内不再保存主键。
   */
  const body = createDim3dSceneSaveAllBody({ scene, sceneId }, lockToken, {
    requestId,
    ...(context.baseRevisionNo === undefined ? {} : { baseRevisionNo: context.baseRevisionNo }),
    ...(options.changeSummary?.trim() ? { changeSummary: options.changeSummary.trim() } : {}),
  })
  // 一次提交四包：合并当前二维与新建三维对象，同时保全尚未接入编辑的原三维域。
  const protectedBody = { ...body, ...preserveUneditedThreeDDomain(
    sceneId, body, options.editableTransformIds, options.editableHierarchyIds, options.deletedObjectIds, options.saveEdits,
  ) }
  const response = await (options.saveAll ?? saveAllDim3dScene)(protectedBody)
  const result = assertSaveSucceeded(response, sceneId)

  return {
    sceneId,
    requestId,
    ...(result.revisionId ? { revisionId: result.revisionId } : {}),
    ...(result.revisionNo === undefined ? {} : { revisionNo: result.revisionNo }),
    ...(result.lockVersion === undefined ? {} : { lockVersion: result.lockVersion }),
    ...(result.savedTime ? { savedTime: result.savedTime } : {}),
  }
}
