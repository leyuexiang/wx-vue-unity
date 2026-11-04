import request from '@/request.ts'
import { getDim3dHeaders } from './auth'
import { DIM3D_ADMIN_API, DIM3D_API_PREFIX } from './constants'
import type { Dim3dTemplateType } from './template'

/**
 * 三维字典项通用结构。
 * dictValue 是提交给业务接口的编码，dictLabel 是页面展示名称；场景分类和发布访问模式均复用该契约。
 */
export interface Dim3dDictionaryItem {
  dictCode?: number | string
  dictLabel?: string
  dictValue?: string
  dictType?: string
}

/** 三维模型分类字典项，保留业务别名便于现有调用方表达语义。 */
export type Dim3dModelCategoryItem = Dim3dDictionaryItem

export interface Dim3dDictionaryResponse {
  code?: number
  msg?: string
  data?: Dim3dModelCategoryItem[] | null
}

/** 148管理接口使用精简字典列表；只合并并发读取，避免跨登录身份长期缓存。 */
let adminDictionaryRequest: Promise<Dim3dDictionaryResponse> | undefined
const getDictionary = (type: string, options?: Record<string, unknown>) => {
  if (!adminDictionaryRequest) {
    adminDictionaryRequest = request<{ code?: number; msg?: string; data?: Array<{ dictType?: string; label?: string; value?: string }> }>(
      `${DIM3D_API_PREFIX}/system/dict-data/simple-list`,
      { method: 'GET', headers: getDim3dHeaders(), passAuth: true, skipPlatformPath: true, ...options },
    ).then((response) => ({ ...response, data: response.data?.map((item) => ({
      dictType: item.dictType, dictLabel: item.label, dictValue: item.value,
    })) })).finally(() => { adminDictionaryRequest = undefined })
  }
  return adminDictionaryRequest.then((response) => ({ ...response, data: response.data?.filter((item) => item.dictType === type) }))
}

/**
 * 将真实模型分类字典转换为编码到中文名称的映射。
 * 统一在适配层处理空格和大小写，避免管理页、编辑器资源面板各自实现后出现显示不一致。
 */
export function createDim3dModelCategoryLabelMap(
  items: Dim3dDictionaryItem[] = [],
): Map<string, string> {
  const labels = new Map<string, string>()
  for (const item of items) {
    const value = String(item.dictValue ?? '').trim()
    const label = String(item.dictLabel ?? '').trim()
    if (value && label) labels.set(value.toLowerCase(), label)
  }
  return labels
}

/**
 * 根据模型记录的分类编码读取中文分类名称。
 * 当后端已经返回不同于编码的 categoryName 时允许兼容；如果两者都是编码则返回空串，
 * 防止鉴权或字典异常时把 ICBC、ABC 这类 dictValue 误渲染到用户界面。
 */
export function getDim3dModelCategoryLabel(
  labels: Map<string, string>,
  category?: unknown,
  categoryName?: unknown,
) {
  const categoryValue = String(category ?? '').trim()
  const mappedLabel = categoryValue ? labels.get(categoryValue.toLowerCase()) : undefined
  if (mappedLabel) return mappedLabel

  const fallbackName = String(categoryName ?? '').trim()
  // 仅接受明显的中文名称作为降级值；纯英文、数字和下划线组合通常仍是 dictValue 编码。
  const isLikelyCode = /^[A-Za-z0-9_.:-]+$/.test(fallbackName)
  if (fallbackName && fallbackName !== categoryValue && !isLikelyCode) return fallbackName
  return ''
}

/**
 * 图标分类字典与模型分类字典使用相同的 dictValue、dictLabel 字段契约。
 * 直接复用已经过空值和大小写处理的映射逻辑，避免两个管理页产生不同的分类展示规则。
 */
export const createDim3dIconCategoryLabelMap = createDim3dModelCategoryLabelMap
export const getDim3dIconCategoryLabel = getDim3dModelCategoryLabel

/** 模板分类与既有资源分类遵循同一字典字段契约。 */
export type Dim3dTemplateCategoryItem = Dim3dModelCategoryItem
export const createDim3dTemplateCategoryLabelMap = createDim3dModelCategoryLabelMap
export const getDim3dTemplateCategoryLabel = getDim3dModelCategoryLabel

/**
 * 将字典响应转换为下拉框选项。
 * 过滤缺失编码或名称的脏数据，确保筛选和提交永远不会发送空值。
 */
export function createDim3dDictionaryOptions(items: Dim3dDictionaryItem[] = []) {
  return items
    .map((item) => ({
      value: String(item.dictValue ?? '').trim(),
      label: String(item.dictLabel ?? '').trim(),
    }))
    .filter((item) => item.value && item.label)
}

/**
 * 使用三维服务鉴权读取正式的 dim3d_model_category 模型分类字典，供模型管理和编辑器资源面板共用。
 * 字典的 dictValue 作为模型接口的分类编码，dictLabel 作为页面展示名称，禁止回退到临时字典接口。
 */
export function getDim3dModelCategoryDictionary(options?: Record<string, unknown>) {
  if (DIM3D_ADMIN_API) return getDictionary('dim3d_model_category', options)
  return request<Dim3dDictionaryResponse>(
    `${DIM3D_API_PREFIX}/system/dict/data/type/dim3d_model_category`,
    {
      method: 'GET',
      headers: getDim3dHeaders(),
      passAuth: true,
      // 字典是三维资源的公共元数据，平台差异只作用于资源列表接口。
      skipPlatformPath: true,
      ...(options || {}),
    },
  )
}

/**
 * 使用三维服务鉴权读取正式的 dim3d_icon_category 图标分类字典。
 * dictValue 是图标分页筛选和新增、编辑提交的分类编码，dictLabel 仅用于中文展示。
 */
export function getDim3dIconCategoryDictionary(options?: Record<string, unknown>) {
  return request<Dim3dDictionaryResponse>(
    `${DIM3D_API_PREFIX}/system/dict/data/type/dim3d_icon_category`,
    {
      method: 'GET',
      headers: getDim3dHeaders(),
      passAuth: true,
      // 字典是三维资源的公共元数据，平台差异只作用于资源列表接口。
      skipPlatformPath: true,
      ...(options || {}),
    },
  )
}

/**
 * 读取指定模板类型的分类字典。
 *
 * 行业方案和展厅模板由后端维护为两个独立字典，调用方必须传入模板类型，避免把一类
 * 模板的分类编码提交到另一类模板的分页或保存接口。保留无类型调用的旧地址兼容逻辑，
 * 便于尚未迁移的旧页面平滑升级；新的模板管理和另存入口均显式传入模板类型。
 */
export function getDim3dTemplateCategoryDictionary(
  templateTypeOrOptions?: Dim3dTemplateType | Record<string, unknown>,
  options?: Record<string, unknown>,
) {
  const hasTemplateType = typeof templateTypeOrOptions === 'string'
  const templateType = hasTemplateType ? templateTypeOrOptions : undefined
  const requestOptions = hasTemplateType ? options : templateTypeOrOptions
  const dictionaryType = templateType || 'dim3d_template_category'

  return request<Dim3dDictionaryResponse>(
    `${DIM3D_API_PREFIX}/system/dict/data/type/${encodeURIComponent(dictionaryType)}`,
    {
      method: 'GET',
      headers: getDim3dHeaders(),
      passAuth: true,
      // 字典是三维资源的公共元数据，平台差异只作用于资源列表接口。
      skipPlatformPath: true,
      ...(requestOptions || {}),
    },
  )
}

/** 读取场景分类字典；dictValue 用于场景分页和新增/编辑提交，dictLabel 用于页面展示。 */
export function getDim3dSceneCategoryDictionary(options?: Record<string, unknown>) {
  if (DIM3D_ADMIN_API) return getDictionary('dim3d_scene_category', options)
  return request<Dim3dDictionaryResponse>(
    `${DIM3D_API_PREFIX}/system/dict/data/type/dim3d_scene_category`,
    {
      method: 'GET',
      headers: getDim3dHeaders(),
      passAuth: true,
      // 字典是三维资源的公共元数据，平台差异只作用于资源列表接口。
      skipPlatformPath: true,
      ...(options || {}),
    },
  )
}

/** 读取场景发布访问模式字典；发布接口直接提交字典 dictValue，不再维护本地枚举映射。 */
export function getDim3dAccessModeDictionary(options?: Record<string, unknown>) {
  if (DIM3D_ADMIN_API) return getDictionary('dim3d_access_mode', options)
  return request<Dim3dDictionaryResponse>(
    `${DIM3D_API_PREFIX}/system/dict/data/type/dim3d_access_mode`,
    {
      method: 'GET',
      headers: getDim3dHeaders(),
      passAuth: true,
      // 字典是三维资源的公共元数据，平台差异只作用于资源列表接口。
      skipPlatformPath: true,
      ...(options || {}),
    },
  )
}
