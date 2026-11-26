import {
  getDim3dSceneTemplateInfo,
  readDim3dTemplateMetadata,
  type Dim3dTemplateMetadata,
  type Dim3dTemplatePageParams,
  type Dim3dTemplatePageVo,
  type Dim3dTemplateSaveScope,
  type Dim3dTemplateStatus,
  type Dim3dTemplateType,
} from '@/servers/manual/dim3d/api/template'
import { SCENE_CREATION_TYPE_OPTIONS } from '../../SceneManage/sceneType'

/** 模板页筛选状态拆分为草稿和已提交两层时共用的最小数据形态。 */
export interface TemplateListFilterState {
  search: string
  status: 'all' | Dim3dTemplateStatus
  category: string
  templateType: Dim3dTemplateType
}

/** 分页参数与筛选状态合并后的只读输入，便于页面和单元测试复用同一映射规则。 */
export interface TemplateListRequestState extends TemplateListFilterState {
  pageNum: number
  pageSize: number
}

/**
 * 将页面状态转换为模板分页接口参数。
 * “全部”只在用户界面存在，进入接口前必须折叠为 undefined，避免后端收到伪枚举导致结果异常。
 */
export function createTemplateListRequestParams(
  state: TemplateListRequestState,
): Dim3dTemplatePageParams {
  return {
    includeSnapshots: true,
    pageNum: state.pageNum,
    pageSize: state.pageSize,
    templateName: state.search.trim() || undefined,
    templateType: state.templateType,
    category: state.category.trim() || undefined,
    status: state.status === 'all' ? undefined : state.status,
  }
}

/**
 * 删除当前页最后一项时回退到上一页；其他情形保持当前页，防止删除操作无意义地重置筛选结果。
 */
export function getTemplatePageAfterDeletion(currentPage: number, currentItemCount: number) {
  return currentItemCount <= 1 && currentPage > 1 ? currentPage - 1 : currentPage
}

/**
 * 列表缺少主键时会生成本地渲染键。该函数用于拦截删除和上下线，避免把回退键误提交给后端。
 */
export function isTemplateBusinessId(id: unknown) {
  const normalizedId = String(id ?? '').trim()
  return Boolean(normalizedId) && !normalizedId.startsWith('template-missing-')
}

const TEMPLATE_SCOPE_LABELS: Readonly<Record<Dim3dTemplateSaveScope, string>> = {
  twoD: '2D',
  threeD: '3D',
  all: '2D+3D',
}

/** 卡片只在含三维内容时展示来源场景类型。纯二维模板的目标类型由创建人决定。 */
export function getTemplateSnapshotLabel({ saveScope, sceneType }: Dim3dTemplateMetadata) {
  if (!saveScope) return ''
  const scopeLabel = TEMPLATE_SCOPE_LABELS[saveScope]
  const typeLabel = saveScope !== 'twoD'
    ? SCENE_CREATION_TYPE_OPTIONS.find((option) => option.value === sceneType)?.label
    : undefined
  return typeLabel ? `${scopeLabel} · ${typeLabel}` : scopeLabel
}

/** 纯二维模板无须查询来源类型，含三维则必须从模板资料取得两项字段。 */
export function hasTemplateCreationMetadata({ saveScope, sceneType }: Dim3dTemplateMetadata) {
  return saveScope === 'twoD' || (saveScope !== undefined && sceneType !== undefined)
}

/** 分页值优先，详情仅补齐缺项。快照编号用于核对身份，详情接口使用模板业务编号。 */
export async function resolveTemplateSnapshotMetadata(
  row: Dim3dTemplatePageVo,
): Promise<Dim3dTemplateMetadata> {
  const metadata = readDim3dTemplateMetadata(row)
  const templateSceneId = String(row.templateSceneId ?? '').trim()
  if (!templateSceneId || !isTemplateBusinessId(row.id) || hasTemplateCreationMetadata(metadata)) return metadata

  const { data } = await getDim3dSceneTemplateInfo(String(row.id).trim(), { suppressNotFoundNotification: true })
  if (!data || String(data.templateSceneId ?? '').trim() !== templateSceneId) return metadata
  const detail = readDim3dTemplateMetadata(data)
  return {
    saveScope: metadata.saveScope ?? detail.saveScope,
    sceneType: metadata.sceneType ?? detail.sceneType,
  }
}
