import { getDim3dOssFileById } from '@/servers/manual/dim3d/api/oss'
import {
  getDim3dModelInfo,
  pageDim3dModel,
  type Dim3dResourceBelong,
  type Dim3dModelPageVo,
} from '@/servers/manual/dim3d/api/model'
import { getDim3dResourceInfo, buildDim3dResourceUrl } from '@/servers/manual/dim3d/api/resource'
import {
  createDim3dModelCategoryLabelMap,
  getDim3dModelCategoryDictionary,
  getDim3dModelCategoryLabel,
} from '@/servers/manual/dim3d/api/dictionary'
import { DRAG_MODEL_ENUM, MODEL_ENUM } from '@/enums'
import type { FileModel } from '@/types/threeScene'
import { getFileExtension } from '@/utils/utils'

/**
 * 资源面板折叠分组的通用结构。
 * 合并系统几何体与阶段三文件模型时保留子项的联合类型，避免用 `any` 丢失后续拖拽数据的类型约束。
 */
interface ResourceGroup<T> {
  name: string
  key: string
  children: T[]
}

/** 阶段三模型接口解析出的折叠分组。 */
export type ModelResourceGroup = ResourceGroup<FileModel>

/** 解析后的阶段三模型，保留后端编号用于稳定 Vue key 和调试追踪。 */
interface ResolvedModelResource extends FileModel {
  /** 兼容资源面板现有卡片 key，使用模型记录编号而不是随机值。 */
  id: string
  resourceId: string
}

/**
 * 模型文件的冻结资源身份。
 *
 * 当前上传和编辑流程替换文件时会生成新的modelFileId，因此该编号既是文件身份，也是本次不可变版本。
 * 后续资源服务提供独立内容哈希时，可只替换version来源，不需要改动植被或场景请求协议。
 */
interface ResolvedModelFileAsset {
  id: string
  url: string
  version?: string
  managed?: true
}

const normalizeText = (value: unknown) => String(value ?? '').trim()

/** 后端编号允许有符号 64 位正整数，拒绝已被 JSON 数值精度截断的关联。 */
const resolveManagedModelAsset = (value: unknown): ResolvedModelFileAsset | null => {
  if (typeof value !== 'string' && !(typeof value === 'number' && Number.isSafeInteger(value))) return null
  const id = String(value)
  if (!/^[1-9]\d{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n) return null
  return { id, url: `unity-resource://${id}`, managed: true }
}

/**
 * 系统资源和我的资源面板会分别调用分组加载函数；模块级 Promise 保证分类字典只请求一次。
 * 请求失败时清空缓存，后续重新进入面板仍可重试，不会永久记住一次性的网络错误。
 */
let modelCategoryLabelMapPromise: Promise<Map<string, string>> | undefined
const loadModelCategoryLabelMap = async () => {
  if (!modelCategoryLabelMapPromise) {
    modelCategoryLabelMapPromise = getDim3dModelCategoryDictionary()
      .then((response) =>
        createDim3dModelCategoryLabelMap(
          Array.isArray(response?.data) ? response.data : [],
        ),
      )
      .catch((error) => {
        modelCategoryLabelMapPromise = undefined
        throw error
      })
  }
  return modelCategoryLabelMapPromise
}

/**
 * 受控目录直接使用关联编号，签发与格式选择交给 Unity。旧目录继续解析文件编号和地址。
 *
 * modelFileId优先读取分页结果，缺失时只补查一次模型详情。页面列表偶尔会直接返回完整地址，但仍
 * 必须先取得modelFileId；否则植被请求只能拿到模型业务编号，无法冻结实际GLB文件身份。
 */
const resolveModelFileAsset = async (
  model: Dim3dModelPageVo,
): Promise<ResolvedModelFileAsset | null> => {
  if (model.resourceId != null) return resolveManagedModelAsset(model.resourceId)
  let modelFileId = normalizeText(model.modelFileId)
  if (!modelFileId) {
    const modelId = normalizeText(model.id)
    if (!modelId) return null
    const detail = await getDim3dModelInfo(modelId, { suppressNotFoundNotification: true })
    if (detail?.code !== 200) return null
    // 分页尚未返回关联时，以同一条目录的详情为准；坏关联不能降级到旧文件。
    if (detail.data?.resourceId != null) {
      return normalizeText(detail.data.id) === modelId ? resolveManagedModelAsset(detail.data.resourceId) : null
    }
    modelFileId = normalizeText(detail.data?.modelFileId)
  }
  if (!modelFileId) return null

  const directUrl = [model.modelFileUrl, model.modelFilePath]
    .map(normalizeText)
    .find((value) => /^https?:\/\//i.test(value))
  if (directUrl) {
    return { id: modelFileId, url: directUrl, version: modelFileId }
  }

  const response = await getDim3dResourceInfo(modelFileId, { suppressNotFoundNotification: true })
  const data = response?.data
  const resourceRelativePath = normalizeText(data?.resourceRelativePath)
  if (
    response?.code !== 200 ||
    normalizeText(data?.id) !== modelFileId ||
    normalizeText(data?.resourceType).toUpperCase() !== 'MODEL' ||
    !resourceRelativePath
  ) {
    return null
  }

  const url = buildDim3dResourceUrl(resourceRelativePath)
  return url ? { id: modelFileId, url, version: modelFileId } : null
}

/** 按 ossId 查询模型封面，失败时返回空串并由卡片使用默认图。 */
const resolveCoverUrl = async (coverImageId: unknown) => {
  const id = normalizeText(coverImageId)
  if (!id) return ''
  const response = await getDim3dOssFileById(id, { suppressNotFoundNotification: true })
  const file = response?.data?.find((item) => normalizeText(item.ossId) === id)
  return normalizeText(file?.url)
}

const toModelItem = async (
  model: Dim3dModelPageVo,
  coverCache: Map<string, Promise<string>>,
): Promise<ResolvedModelResource | null> => {
  const resourceId = normalizeText(model.id)
  const modelFileAsset = await resolveModelFileAsset(model)
  // 编号或地址任一缺失都不渲染卡片，防止拖入后生成无法冻结资源身份的场景或植被规则。
  if (!resourceId || !modelFileAsset) return null

  const filePath = modelFileAsset.url
  const extension = modelFileAsset.managed ? '' : getFileExtension(filePath).toLowerCase() as MODEL_ENUM
  const fileType = modelFileAsset.managed ? MODEL_ENUM.UNITY_MODEL
    : extension && extension !== MODEL_ENUM.UNITY_MODEL && Object.values(MODEL_ENUM).includes(extension) ? extension : MODEL_ENUM.GLB
  const coverId = normalizeText(model.coverImageId)
  let coverPromise = coverCache.get(coverId)
  if (!coverPromise) {
    coverPromise = resolveCoverUrl(coverId)
    coverCache.set(coverId, coverPromise)
  }
  const coverUrl = await coverPromise
  return {
    id: resourceId,
    name: normalizeText(model.modelName) || '未命名模型',
    modelType: DRAG_MODEL_ENUM.CustomModel,
    icon: coverUrl,
    filePath,
    fileType,
    resourceId,
    // 目录编号用于卡片和分类，依赖使用受管关联编号或旧模型文件编号。
    resourceAsset: { id: modelFileAsset.id, url: filePath, ...(modelFileAsset.version ? { version: modelFileAsset.version } : {}) },
  }
}

/** 限制同时进行的详情、资源和封面请求数量，避免大分页把浏览器连接池和内存一次性占满。 */
const resolveRowsWithConcurrency = async (rows: Dim3dModelPageVo[], limit = 8) => {
  const result: Array<ResolvedModelResource | null> = Array(rows.length).fill(null)
  let cursor = 0
  const coverCache = new Map<string, Promise<string>>()
  const worker = async () => {
    while (cursor < rows.length) {
      const index = cursor++
      try {
        result[index] = await toModelItem(rows[index], coverCache)
      } catch {
        // 单个模型详情、资源或封面失败时跳过该卡片，其他分类仍继续显示。
        result[index] = null
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, rows.length) }, worker))
  return result
}

/**
 * 通过新 `/dim3d/model/page` 接口加载模型并按后端分类分组。
 * 请求适配器内部会注入阶段三 Authorization 和 ClientId，不再调用旧项目资源服务接口。
 */
export async function loadDim3dModelGroups(
  resourceBelong: Dim3dResourceBelong,
): Promise<ModelResourceGroup[]> {
  const [response, categoryLabels] = await Promise.all([
    pageDim3dModel({ resourceBelong, status: 'ONLINE', pageNum: 1, pageSize: 9999 }),
    // 字典失败不阻断模型资源加载；没有中文映射时按已有 categoryName 或“未分类”降级。
    loadModelCategoryLabelMap().catch(() => new Map<string, string>()),
  ])
  const rows = Array.isArray(response?.rows) ? response.rows : []
  const rowById = new Map(rows.map((row) => [normalizeText(row.id), row]))
  const resolved = (await resolveRowsWithConcurrency(rows)).filter(
    (item): item is ResolvedModelResource => Boolean(item),
  )
  const groups = new Map<string, ModelResourceGroup>()

  for (const item of resolved) {
    const source = rowById.get(item.resourceId)
    const category =
      getDim3dModelCategoryLabel(categoryLabels, source?.category, source?.categoryName) || '未分类'
    // 分类编码大小写差异不应生成两个折叠项，折叠标题始终使用字典中文名称。
    const key = `dim3d-model-${category.toLowerCase()}`
    let group = groups.get(key)
    if (!group) {
      group = { name: category, key, children: [] }
      groups.set(key, group)
    }
    group.children.push(item)
  }

  return [...groups.values()]
}

/**
 * 将动态模型分组并入既有内置分组，同名分类只保留一个折叠项。
 * 返回值保留内置子项与文件模型的联合类型，调用方可按各自拖拽上下文完成安全收窄。
 */
export function mergeModelResourceGroups<T>(
  base: ResourceGroup<T>[],
  dynamic: ModelResourceGroup[],
): ResourceGroup<T | FileModel>[] {
  const merged: ResourceGroup<T | FileModel>[] = base.map((group) => ({
    ...group,
    children: [...group.children],
  }))
  const byName = new Map(merged.map((group) => [group.name.trim().toLowerCase(), group]))
  for (const group of dynamic) {
    const normalizedName = group.name.trim().toLowerCase()
    const target = byName.get(normalizedName)
    if (target) target.children.push(...group.children)
    else {
      const copy = { ...group, children: [...group.children] }
      merged.push(copy)
      byName.set(normalizedName, copy)
    }
  }
  return merged
}
