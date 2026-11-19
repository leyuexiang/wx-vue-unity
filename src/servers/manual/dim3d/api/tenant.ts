import request from '@/request.ts'
import { getDim3dHeaders } from './auth'
import { DIM3D_ADMIN_API, DIM3D_OPERATION_API_PREFIX } from './constants'

/**
 * 租户列表查询参数，与 operation.openapi.json 的 `/tenant/dashboard/list` 契约保持一致。
 * 下拉框当前只使用 searchValue 和分页字段，其余字段保留给后续管理端筛选复用。
 */
export interface OperationTenantPageParams {
  searchValue?: string
  companyName?: string
  licenseNumber?: string
  contactPhone?: string
  tenantType?: string
  status?: string
  createTimeStart?: string
  createTimeEnd?: string
  pageSize?: number
  pageNum?: number
  orderByColumn?: string
  isAsc?: string
}

/** 租户列表项；长整型关联字段保持字符串兼容，避免浏览器数值精度丢失。 */
export interface OperationTenantDashboardVo {
  id?: string | number
  customerId?: string | number
  tenantId?: string
  tenantCode?: string
  tenantType?: string
  companyName?: string
  licenseNumber?: string
  contactUserName?: string
  contactPhone?: string
  status?: string
}

/** 租户分页响应；兼容部分网关将标准分页结果再次包装到 data 中。 */
export interface OperationTenantPageResponse {
  total?: number
  rows?: OperationTenantDashboardVo[]
  code?: number
  msg?: string
  data?: OperationTenantPageResponse
}

/**
 * 获取可用于场景筛选和场景授权的租户列表。
 * 请求头统一从三维鉴权适配器读取，禁止页面自行拼接令牌或客户端编号。
 */
export async function pageOperationTenants(
  params: OperationTenantPageParams,
  options?: Record<string, unknown>,
) {
  if (DIM3D_ADMIN_API) {
    // 管理模式使用系统租户分页及原鉴权，将系统字段投影为场景筛选和授权所需字段。
    const response = await request<{
      code: number
      msg?: string
      data?: { list: Array<{ id: string | number; name: string }>; total: number }
    }>(`${DIM3D_OPERATION_API_PREFIX}/system/tenant/page`, {
      method: 'GET',
      params: {
        pageNo: params.pageNum,
        pageSize: params.pageSize,
        name: params.companyName || params.searchValue,
        status: 0,
      },
      headers: getDim3dHeaders(),
      passAuth: true,
      ...options,
      skipPlatformPath: true,
    })
    if (response.code !== 200 || !Array.isArray(response.data?.list)) {
      throw new Error(response.msg || '租户列表接口返回格式异常')
    }
    return {
      total: response.data.total,
      rows: response.data.list.map((row) => ({
        tenantId: String(row.id),
        companyName: row.name,
      })),
    }
  }
  const response = await request<OperationTenantPageResponse>(
    `${DIM3D_OPERATION_API_PREFIX}/tenant/dashboard/list`,
    {
      method: 'GET',
      params,
      headers: getDim3dHeaders(),
      passAuth: true,
      ...(options || {}),
    },
  )

  const page = Array.isArray(response.rows) ? response : response.data
  if (!page || !Array.isArray(page.rows)) {
    throw new Error(response.msg || '租户列表接口返回格式异常')
  }
  return {
    total: typeof page.total === 'number' ? page.total : page.rows.length,
    rows: page.rows,
  }
}

export interface OperationTenantSelectOption {
  label: string
  value: string
}

/**
 * 将接口记录转换为下拉选项。
 * tenantId 是授权与场景筛选的真实提交值；企业名称优先展示，租户编码用于区分同名企业。
 */
export function createOperationTenantSelectOptions(
  rows: OperationTenantDashboardVo[],
): OperationTenantSelectOption[] {
  const options = new Map<string, OperationTenantSelectOption>()
  for (const row of rows) {
    const value = String(row.tenantId ?? '').trim()
    if (!value || options.has(value)) continue

    const companyName = String(row.companyName ?? '').trim()
    const tenantCode = String(row.tenantCode ?? '').trim()
    const label = companyName
      ? tenantCode
        ? `${companyName}（${tenantCode}）`
        : companyName
      : tenantCode || value
    options.set(value, { label, value })
  }
  return Array.from(options.values())
}
