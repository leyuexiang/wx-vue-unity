import {
  createDim3dTemplateCategoryLabelMap,
  getDim3dTemplateCategoryDictionary,
  getDim3dTemplateCategoryLabel,
} from '@/servers/manual/dim3d/api/dictionary'
import {
  getDim3dTemplateInfo,
  pageDim3dTemplate,
  pageDim3dSceneTemplate,
  DIM3D_TEMPLATE_TYPE,
  type Dim3dTemplateDetailVo,
  type Dim3dTemplatePageParams,
  type Dim3dTemplatePageVo,
  type Dim3dTemplateSceneType,
  type Dim3dTemplateSaveScope,
  type Dim3dTemplateType,
} from '@/servers/manual/dim3d/api/template'
import { getDim3dOssFileById } from '@/servers/manual/dim3d/api/oss'

/** 编辑器模板卡片的数据结构；保留模板业务编号和快照编号，供后续实例化流程使用。 */
export interface TemplateResourceItem {
  id: string
  /** 后端明确返回的模板场景编号；缺失时为空，禁止把模板业务编号冒充场景编号。 */
  templateSceneId: string
  name: string
  description: string
  templateType: Dim3dTemplateType
  category: string
  categoryName: string
  coverUrl: string
  saveScope?: Dim3dTemplateSaveScope
  sceneType?: Dim3dTemplateSceneType
}

/** 模板列表的折叠分组；两个模板字典的分类会按中文名称合并为同一层级。 */
export interface TemplateResourceGroup {
  name: string
  key: string
  children: TemplateResourceItem[]
}

const normalizeText = (value: unknown) => String(value ?? '').trim()

const TEMPLATE_SAVE_SCOPE_BY_NORMALIZED_VALUE: Readonly<Record<string, Dim3dTemplateSaveScope>> =
  Object.freeze({
    twod: 'twoD',
    threed: 'threeD',
    all: 'all',
  })

/**
 * 规范化模板保存范围。
 *
 * 后端契约使用 twoD/threeD 驼峰值；比较前转小写可以兼容历史大小写差异，但必须再映射回
 * 领域枚举，不能把 twod/threed 直接断言成原枚举，否则二维和三维模板都会被误判为缺字段。
 */
export function normalizeTemplateSaveScope(value: unknown): Dim3dTemplateSaveScope | undefined {
  const normalizedValue = normalizeText(value).toLowerCase()
  return TEMPLATE_SAVE_SCOPE_BY_NORMALIZED_VALUE[normalizedValue]
}

/** 兼容模板分页和模板详情的别名字段，禁止凭模板名称猜测场景类型。 */
const readTemplateMetadata = (row: Dim3dTemplatePageVo | Dim3dTemplateDetailVo) => {
  const source = row as (Dim3dTemplatePageVo | Dim3dTemplateDetailVo) & Record<string, unknown>
  const saveScope = normalizeTemplateSaveScope(
    source.saveScope ?? source.templateSaveScope ?? source.sceneSaveScope,
  )
  const sceneType = normalizeText(
    source.sceneType ?? source.sourceSceneType ?? source.templateSceneType,
  ).toLowerCase() as Dim3dTemplateSceneType
  const templateSceneId = normalizeText(
    source.templateSceneId ?? source.sceneId ?? source.templateId ?? source.templateFileId,
  )
  return {
    saveScope,
    sceneType: ['gis', 'local3d'].includes(sceneType) ? sceneType : undefined,
    templateSceneId,
  }
}

/** 合并模板分页和详情元数据；缺字段时仅使用模板专用接口补充，不查询普通场景。 */
export function mergeTemplateMetadata(
  row: Dim3dTemplatePageVo,
  detail: Dim3dTemplateDetailVo | undefined,
) {
  const rowMetadata = readTemplateMetadata(row)
  const detailMetadata = detail ? readTemplateMetadata(detail) : undefined
  const templateSceneId = rowMetadata.templateSceneId || detailMetadata?.templateSceneId || ''

  return {
    templateSceneId,
    saveScope: rowMetadata.saveScope ?? detailMetadata?.saveScope,
    sceneType: rowMetadata.sceneType ?? detailMetadata?.sceneType,
  }
}

/** 判断模板是否适用于当前场景：纯二维跨场景可用，三维模板必须匹配 GIS/本地三维。 */
export function isTemplateVisibleInScene(
  item: Pick<TemplateResourceItem, 'saveScope' | 'sceneType'>,
  currentSceneType: Dim3dTemplateSceneType | null,
) {
  if (item.saveScope === 'twoD') return true
  // 非纯二维模板必须同时具备明确范围、来源场景和当前场景；字段缺失时隐藏，禁止跨场景误展示。
  if (item.saveScope !== 'threeD' && item.saveScope !== 'all') return false
  if (!item.sceneType || !currentSceneType) return false
  return item.sceneType === currentSceneType
}

/** 同一模板编号只创建一个详情请求，防止两个字典结果异常重复时产生冗余访问。 */
const resolveTemplateDetail = (
  id: string,
  detailCache: Map<string, Promise<Dim3dTemplateDetailVo | undefined>>,
) => {
  let detailPromise = detailCache.get(id)
  if (!detailPromise) {
    detailPromise = getDim3dTemplateInfo(id, { suppressNotFoundNotification: true })
      .then((response) => response?.data)
      .catch(() => undefined)
    detailCache.set(id, detailPromise)
  }
  return detailPromise
}

const resolveCoverUrl = async (coverImageId: unknown) => {
  const id = normalizeText(coverImageId)
  if (!id) return ''
  try {
    const response = await getDim3dOssFileById(id, { suppressNotFoundNotification: true })
    const file = response?.data?.find((item) => normalizeText(item.ossId) === id)
    return normalizeText(file?.url)
  } catch {
    return ''
  }
}

const toTemplateItem = async (
  row: Dim3dTemplatePageVo,
  templateType: Dim3dTemplateType,
  categoryLabels: Map<string, string>,
  detailCache: Map<string, Promise<Dim3dTemplateDetailVo | undefined>>,
  coverCache: Map<string, Promise<string>>,
): Promise<TemplateResourceItem | null> => {
  const id = normalizeText(row.id)
  if (!id) return null
  const rowMetadata = readTemplateMetadata(row)
  const needsMetadata =
    !rowMetadata.templateSceneId || !rowMetadata.saveScope || !rowMetadata.sceneType
  const detailPromise = needsMetadata
    ? resolveTemplateDetail(id, detailCache)
    : Promise.resolve(undefined)
  // 模板分页历史字段为 coverImageId，快照模板接口可能返回 coverAssetId；两者都只作为封面 OSS 编号。
  const coverId = normalizeText(
    row.coverImageId ?? (row as Dim3dTemplatePageVo & Record<string, unknown>).coverAssetId,
  )
  let coverPromise = coverCache.get(coverId)
  if (!coverPromise) {
    coverPromise = resolveCoverUrl(coverId)
    coverCache.set(coverId, coverPromise)
  }
  const category = normalizeText(row.category)
  const categoryName =
    getDim3dTemplateCategoryLabel(categoryLabels, category, row.categoryName) || '未分类'
  // 模板详情和封面地址互不依赖，并行等待以减少首屏耗时。
  const [detail, coverUrl] = await Promise.all([detailPromise, coverPromise])
  const metadata = mergeTemplateMetadata(row, detail)
  return {
    id,
    templateSceneId: metadata.templateSceneId,
    name: normalizeText(row.templateName) || '未命名模板',
    description: normalizeText(row.templateDesc),
    templateType,
    category,
    categoryName,
    coverUrl,
    saveScope: metadata.saveScope,
    sceneType: metadata.sceneType,
  }
}

/** 限制封面查询并发，避免模板数量较多时瞬间占满连接池。 */
const resolveRowsWithConcurrency = async (
  rows: Dim3dTemplatePageVo[],
  templateType: Dim3dTemplateType,
  categoryLabels: Map<string, string>,
  detailCache: Map<string, Promise<Dim3dTemplateDetailVo | undefined>>,
  coverCache: Map<string, Promise<string>>,
  limit = 8,
) => {
  const result: Array<TemplateResourceItem | null> = Array(rows.length).fill(null)
  let cursor = 0
  const worker = async () => {
    while (cursor < rows.length) {
      const index = cursor++
      try {
        result[index] = await toTemplateItem(
          rows[index],
          templateType,
          categoryLabels,
          detailCache,
          coverCache,
        )
      } catch {
        result[index] = null
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, rows.length) }, worker))
  return result.filter((item): item is TemplateResourceItem => Boolean(item))
}

/**
 * 构建编辑器模板分页参数。
 *
 * “模板只展示在系统资源页签”属于编辑器界面归属，不等同于模板分页数据的 resourceBelong 字段。
 * 新快照模板没有该旧字段，因此查询口径必须与模板管理一致，只按模板类型和分页条件读取。
 */
export function createEditorTemplatePageParams(
  templateType: Dim3dTemplateType,
  pageNum: number,
  pageSize: number,
): Dim3dTemplatePageParams {
  return { templateType, pageNum, pageSize }
}

const loadAllTemplateRows = async (templateType: Dim3dTemplateType) => {
  const pageSize = 100
  const loadRows = async (
    loader: typeof pageDim3dTemplate,
  ): Promise<Dim3dTemplatePageVo[]> => {
    const firstPage = await loader(createEditorTemplatePageParams(templateType, 1, pageSize))
    const firstRows = Array.isArray(firstPage?.rows) ? firstPage.rows : []
    const total = Math.max(Number(firstPage?.total) || 0, firstRows.length)
    const pageCount = Math.ceil(total / pageSize)
    if (pageCount <= 1) return firstRows

    const rows = [...firstRows]
    // 分批并行，避免模板数量异常时一次性创建过多请求占满浏览器连接池。
    const pageConcurrency = 8
    for (let start = 2; start <= pageCount; start += pageConcurrency) {
      const pages = await Promise.all(
        Array.from({ length: Math.min(pageConcurrency, pageCount - start + 1) }, (_, index) =>
          loader(createEditorTemplatePageParams(templateType, start + index, pageSize)),
        ),
      )
      rows.push(...pages.flatMap((page) => (Array.isArray(page?.rows) ? page.rows : [])))
    }
    return rows
  }

  const legacyRows = await loadRows(pageDim3dTemplate)
  let snapshotRows: Dim3dTemplatePageVo[] = []
  try {
    // 148 尚未部署新路由时保留旧模板列表；部署后自动合并快照模板。
    snapshotRows = await loadRows(pageDim3dSceneTemplate)
  } catch {
    snapshotRows = []
  }
  return [...legacyRows, ...snapshotRows]
}

/**
 * 查询两类模板并按分类合并。
 *
 * 模板列表和元数据只通过模板分页、模板详情获取，不通过普通场景分页关联。
 */
export async function loadDim3dTemplateGroups(): Promise<TemplateResourceGroup[]> {
  const templateTypes: Dim3dTemplateType[] = [
    DIM3D_TEMPLATE_TYPE.INDUSTRY,
    DIM3D_TEMPLATE_TYPE.EXHIBITION,
  ]
  const sources = await Promise.all(
    templateTypes.map(async (templateType) => {
      const [rows, dictionary] = await Promise.all([
        loadAllTemplateRows(templateType),
        getDim3dTemplateCategoryDictionary(templateType, {
          suppressNotFoundNotification: true,
        }).catch(() => ({ data: [] })),
      ])
      const labels = createDim3dTemplateCategoryLabelMap(
        Array.isArray(dictionary?.data) ? dictionary.data : [],
      )
      return { templateType, rows, labels }
    }),
  )

  const detailCache = new Map<string, Promise<Dim3dTemplateDetailVo | undefined>>()
  const coverCache = new Map<string, Promise<string>>()
  const results = await Promise.all(
    sources.map(({ templateType, rows, labels }) =>
      resolveRowsWithConcurrency(rows, templateType, labels, detailCache, coverCache),
    ),
  )

  const groups = new Map<string, TemplateResourceGroup>()
  for (const items of results) {
    for (const item of items) {
      const normalizedName = item.categoryName.toLowerCase()
      let group = groups.get(normalizedName)
      if (!group) {
        group = {
          name: item.categoryName,
          key: `dim3d-template-${normalizedName}`,
          children: [],
        }
        groups.set(normalizedName, group)
      }
      group.children.push(item)
    }
  }
  return [...groups.values()]
}
