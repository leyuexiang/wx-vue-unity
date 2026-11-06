import type {
  Dim3dTemplatePageParams,
  Dim3dTemplateStatus,
  Dim3dTemplateType,
} from '@/servers/manual/dim3d/api/template'

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
