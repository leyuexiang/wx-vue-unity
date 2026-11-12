import type {
  ModelMaterialAlphaMode,
  ModelMaterialProfile,
  ModelMaterialRule,
  ModelMaterialRuleSource,
} from './types'
import {
  buildRecommendedMaterialProfile,
  findModelMaterialRule,
  DEFAULT_MODEL_MATERIAL_ALPHA_CUTOFF,
} from './modelMaterialProfile'

export { buildRecommendedMaterialProfile }

/** glTF 材质的最小字段集合，只读取与透明诊断相关的部分。 */
interface GltfMaterialDoc {
  name?: string
  alphaMode?: string
  alphaCutoff?: number
  doubleSided?: boolean
  pbrMetallicRoughness?: {
    baseColorTexture?: {
      index?: number
    }
  }
}

interface GltfTextureDoc {
  source?: number
}

interface GltfImageDoc {
  uri?: string
  bufferView?: number
  mimeType?: string
}

interface GltfBufferViewDoc {
  buffer?: number
  byteOffset?: number
  byteLength?: number
}

interface GltfBufferDoc {
  uri?: string
}

/** 解析后的轻量 glTF 包，只保留材质预检需要的 JSON 与内嵌二进制块。 */
export interface ParsedGltfPackageLite {
  document: GltfDocumentLite
  binaryChunk: Uint8Array | null
  isBinary: boolean
}

/** 只读取与材质诊断相关的 glTF 顶层字段，未知扩展保持原样。 */
export interface GltfDocumentLite {
  asset?: Record<string, unknown>
  buffers?: GltfBufferDoc[]
  bufferViews?: GltfBufferViewDoc[]
  images?: GltfImageDoc[]
  materials?: GltfMaterialDoc[]
  textures?: GltfTextureDoc[]
  [key: string]: unknown
}

/** 单个材质的诊断信息，索引与 glTF 原始材质数组一一对应。 */
export interface GltfMaterialInspectionItem {
  /** glTF 材质索引，与 `materials` 数组下标一致。 */
  materialIndex: number
  /** 材质名称，便于资源页展示和人工核对。 */
  materialName?: string
  /** glTF 原始声明的透明模式；缺失时按 glTF 规范视为 OPAQUE。 */
  declaredAlphaMode: 'OPAQUE' | 'MASK' | 'BLEND'
  /** glTF 原始声明的裁切阈值；仅 MASK 模式有意义。 */
  declaredAlphaCutoff?: number
  /** glTF 原始声明是否双面。 */
  declaredDoubleSided: boolean
  /** 基础色贴图纹理索引。 */
  baseColorTextureIndex?: number
  /** 基础色贴图对应的图片索引；从纹理数组追溯得到。 */
  baseColorImageIndex?: number
  /** 贴图中是否检测到透明像素；无法读取时为 undefined，由调用方决定是否走名称兜底。 */
  hasTransparentPixels?: boolean
  /** 是否建议自动修复为裁切透明（仅当原声明为 OPAQUE 且贴图确实镂空时建议）。 */
  autoFixCandidate: boolean
}

/** 整份 glTF 资产的材质诊断结果。 */
export interface GltfMaterialInspectionResult {
  /** 按材质索引排序的逐条诊断。 */
  materials: GltfMaterialInspectionItem[]
  /** 是否存在建议自动修复为裁切透明的材质。 */
  hasCutoutCandidate: boolean
  /** 是否存在显式混合透明材质。 */
  hasBlendMaterial: boolean
  /** 是否存在显式裁切透明材质。 */
  hasMaskMaterial: boolean
}

/**
 * 图像透明检测器，接受图像 Blob 返回是否为二值镂空贴图。
 *
 * 返回 true 只代表“二值裁切透明”，不是泛泛的“存在透明通道”；连续半透明会返回 false，避免玻璃、水面
 * 被误归类为叶片或栅栏。
 */
export type ImageAlphaDetector = (image: Blob) => Promise<boolean>

/** 图片 Blob 读取器，供调用方按 glTF image 索引接入外部资源、data URI 或 GLB 内嵌贴图。 */
export type GltfImageBlobReader = (imageIndex: number) => Promise<Blob | null>

/** 单次 GLB / GLTF 资产预检的配置。 */
export interface InspectGltfAssetBytesOptions {
  /** 资产原始地址，用于把 JSON glTF 中的相对贴图路径解析为绝对地址。 */
  sourceUrl: string
  /** 资产二进制内容；可以是 .glb 字节，也可以是 .gltf JSON 字节。 */
  bytes: ArrayBuffer
  /** 可选自定义图像检测器；测试或宿主后处理服务可注入无浏览器依赖的实现。 */
  imageDetector?: ImageAlphaDetector
  /** 可选自定义图片读取器；提供后会覆盖默认 data URI / 外部 URL / GLB 内嵌贴图读取逻辑。 */
  getImageBlob?: GltfImageBlobReader
  /** 自动生成档案时使用的裁切阈值，缺省为统一默认值。 */
  defaultAlphaCutoff?: number
}

/** 单次 GLB / GLTF 资产预检的纯数据输出。 */
export interface InspectGltfAssetBytesResult {
  /** 解析出的轻量包，便于上传后处理复用 JSON 与 BIN 块，不包含引擎对象。 */
  packageData: ParsedGltfPackageLite
  /** 材质级诊断结果。 */
  inspection: GltfMaterialInspectionResult
  /** 基于诊断生成的推荐档案；没有透明声明或候选材质时为 null。 */
  recommendedProfile: ModelMaterialProfile | null
}

/**
 * 从 ArrayBuffer 中解析 GLB 或 GLTF 的 JSON 文档。
 *
 * 只解析 JSON 部分并返回轻量文档对象，不做几何或动画处理；二进制 chunk 原样返回，
 * 供后续按 bufferView 读取嵌入贴图时使用。
 */
export function parseGltfPackage(
  sourceUrl: string,
  bytes: ArrayBuffer,
): ParsedGltfPackageLite | null {
  const uint8 = new Uint8Array(bytes)
  if (isGlb(uint8)) {
    const view = new DataView(bytes)
    const jsonLength = view.getUint32(12, true)
    const jsonStart = 20
    const jsonEnd = jsonStart + jsonLength
    if (jsonEnd > uint8.byteLength || view.getUint32(16, true) !== 0x4e4f534a) return null
    const document = parseGltfJson(uint8.slice(jsonStart, jsonEnd))
    if (!document) return null
    if (jsonEnd + 8 > uint8.byteLength) return { document, binaryChunk: null, isBinary: true }
    const binaryLength = view.getUint32(jsonEnd, true)
    const binaryStart = jsonEnd + 8
    const binaryEnd = binaryStart + binaryLength
    const binaryChunk = binaryEnd <= uint8.byteLength && view.getUint32(jsonEnd + 4, true) === 0x004e4942
      ? uint8.slice(binaryStart, binaryEnd)
      : null
    return { document, binaryChunk, isBinary: true }
  }

  const document = parseGltfJson(uint8)
  if (!document) return null
  rewriteRelativeUris(document, sourceUrl)
  return { document, binaryChunk: null, isBinary: false }
}

/**
 * 对 GLB / GLTF 字节做完整材质预检。
 *
 * 该入口是 M002 的平台核心边界：只读取资产字节、图片透明信息并输出 `ModelMaterialProfile` 建议，
 * 不创建 Three / Cesium 对象，也不修改传入的场景数据。上传服务、资源管理页或离线任务均可复用它。
 */
export async function inspectGltfAssetBytes(
  options: InspectGltfAssetBytesOptions,
): Promise<InspectGltfAssetBytesResult | null> {
  const packageData = parseGltfPackage(options.sourceUrl, options.bytes)
  if (!packageData) return null

  const imageDetector = options.imageDetector ?? detectCutoutAlphaImage
  const readImageBlob = options.getImageBlob
    ?? createGltfImageBlobReader(packageData.document, packageData.binaryChunk)
  const inspection = await inspectGltfMaterials(packageData.document, imageDetector, readImageBlob)
  const recommendedProfile = buildRecommendedMaterialProfile(inspection, {
    defaultAlphaCutoff: options.defaultAlphaCutoff,
  })

  return { packageData, inspection, recommendedProfile }
}

/**
 * 对一份 glTF 文档做材质诊断。
 *
 * 只基于 JSON 元数据和可选的贴图透明检测，不修改原始文档；调用方根据结果决定是生成
 * `ModelMaterialProfile`，还是在 Runtime 层做兼容修复。
 */
export function inspectGltfMaterials(
  document: GltfDocumentLite,
  imageDetector?: ImageAlphaDetector,
  getImageBlob?: GltfImageBlobReader,
): Promise<GltfMaterialInspectionResult> {
  return _inspectGltfMaterials(document, imageDetector, getImageBlob)
}

async function _inspectGltfMaterials(
  document: GltfDocumentLite,
  imageDetector?: ImageAlphaDetector,
  getImageBlob?: GltfImageBlobReader,
): Promise<GltfMaterialInspectionResult> {
  const materials = document.materials ?? []
  const textures = document.textures ?? []
  const items: GltfMaterialInspectionItem[] = []
  let hasCutoutCandidate = false
  let hasBlendMaterial = false
  let hasMaskMaterial = false

  const needImageDetection = Boolean(imageDetector && getImageBlob)

  for (let index = 0; index < materials.length; index += 1) {
    const material = materials[index]
    const rawMode = (material.alphaMode ?? 'OPAQUE').toUpperCase()
    const declaredAlphaMode = normalizeAlphaMode(rawMode)
    const baseColorTextureIndex = material.pbrMetallicRoughness?.baseColorTexture?.index
    const baseColorImageIndex = typeof baseColorTextureIndex === 'number'
      ? textures[baseColorTextureIndex]?.source
      : undefined

    if (declaredAlphaMode === 'BLEND') hasBlendMaterial = true
    if (declaredAlphaMode === 'MASK') hasMaskMaterial = true

    const item: GltfMaterialInspectionItem = {
      materialIndex: index,
      materialName: material.name?.trim() || undefined,
      declaredAlphaMode,
      declaredAlphaCutoff: material.alphaCutoff,
      declaredDoubleSided: material.doubleSided === true,
      baseColorTextureIndex,
      baseColorImageIndex,
      autoFixCandidate: false,
    }

    // 只有原声明为 OPAQUE 且有基础色贴图时，才进入自动修复候选判断；
    // 显式声明的 MASK / BLEND 都是创作意图，绝不覆盖。
    if (declaredAlphaMode === 'OPAQUE' && typeof baseColorImageIndex === 'number' && needImageDetection) {
      // 延迟到下面统一检测，这里先占位
      item.autoFixCandidate = false
    }

    items.push(item)
  }

  // 如果提供了图像检测器，统一读取一次贴图并更新结果，避免同一个图片索引重复解码。
  if (imageDetector && getImageBlob) {
    const imageCache = new Map<number, boolean | null>()

    for (const item of items) {
      if (item.declaredAlphaMode !== 'OPAQUE') continue
      if (typeof item.baseColorImageIndex !== 'number') continue

      const imageIndex = item.baseColorImageIndex
      if (!imageCache.has(imageIndex)) {
        const blob = await getImageBlob(imageIndex)
        if (!blob) {
          imageCache.set(imageIndex, null)
        } else {
          try {
            const hasAlpha = await imageDetector(blob)
            imageCache.set(imageIndex, hasAlpha)
          } catch {
            imageCache.set(imageIndex, null)
          }
        }
      }

      const hasAlpha = imageCache.get(imageIndex)
      if (hasAlpha !== null) {
        item.hasTransparentPixels = hasAlpha
        if (hasAlpha) {
          item.autoFixCandidate = true
          hasCutoutCandidate = true
        }
      }
    }
  }

  return { materials: items, hasCutoutCandidate, hasBlendMaterial, hasMaskMaterial }
}


/** 规范化 glTF alphaMode 字符串。 */
function normalizeAlphaMode(raw: string): 'OPAQUE' | 'MASK' | 'BLEND' {
  if (raw === 'MASK') return 'MASK'
  if (raw === 'BLEND') return 'BLEND'
  return 'OPAQUE'
}

/**
 * 基于 Canvas 2D 的二值透明贴图检测。
 *
 * 把贴图缩到小尺寸后统计像素：
 * - 纯透明像素比例 >= 2%
 * - 完全不透明像素比例 >= 25%
 * - 半透明像素比例 <= 2%
 * 同时满足时判定为二值镂空（叶片/标签类），而不是玻璃等连续半透明材质。
 */
export async function detectCutoutAlphaImage(image: Blob): Promise<boolean> {
  if (typeof createImageBitmap !== 'function') return false
  const bitmap = await createImageBitmap(image)
  try {
    const sampleSize = 32
    const canvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(sampleSize, sampleSize)
      : document.createElement('canvas')
    canvas.width = sampleSize
    canvas.height = sampleSize
    // 两种画布都明确请求二维上下文，收窄联合类型后再访问像素接口。
    const context = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
    if (!context) return false
    context.drawImage(bitmap, 0, 0, sampleSize, sampleSize)
    const pixels = context.getImageData(0, 0, sampleSize, sampleSize).data
    let transparentCount = 0
    let opaqueCount = 0
    let translucentCount = 0
    for (let index = 3; index < pixels.length; index += 4) {
      const alpha = pixels[index]
      if (alpha <= 10) transparentCount += 1
      else if (alpha >= 245) opaqueCount += 1
      else translucentCount += 1
    }
    const sampleCount = pixels.length / 4
    return transparentCount >= sampleCount * 0.02
      && opaqueCount >= sampleCount * 0.25
      && translucentCount <= sampleCount * 0.02
  } finally {
    bitmap.close()
  }
}

/**
 * 从 GLB 的二进制 chunk 中按 bufferView 索引取出对应字节。
 *
 * 只用于嵌入贴图（image.bufferView 指向 BIN chunk）的情况；外部贴图（image.uri）由调用方自己拉取。
 */
export function readBufferViewFromBinaryChunk(
  binaryChunk: Uint8Array | null,
  bufferViewIndex: number,
  document: GltfDocumentLite,
): Uint8Array | null {
  if (!binaryChunk) return null
  const bufferView = document.bufferViews?.[bufferViewIndex]
  if (!bufferView) return null
  // 目前只处理 buffer 0（GLB 的 BIN chunk）；外部 .bin 文件不在这里处理。
  if (bufferView.buffer !== undefined && bufferView.buffer !== 0) return null
  const offset = bufferView.byteOffset ?? 0
  const length = bufferView.byteLength ?? 0
  if (offset + length > binaryChunk.byteLength) return null
  return binaryChunk.slice(offset, offset + length)
}

/**
 * 创建默认图片读取器。
 *
 * 支持三类来源：
 * - data URI：直接解码；
 * - image.uri：由 `parseGltfPackage` 预先转成绝对 URL 后拉取；
 * - image.bufferView：从 GLB 的 BIN chunk 读取。
 *
 * 读取失败返回 null，预检结果会保守标记为“无法确认”，不会阻断资产上传或场景打开。
 */
export function createGltfImageBlobReader(
  document: GltfDocumentLite,
  binaryChunk: Uint8Array | null,
): GltfImageBlobReader {
  return async (imageIndex) => {
    const image = document.images?.[imageIndex]
    if (!image) return null

    if (image.uri) {
      return isDataUri(image.uri)
        ? decodeDataUriToBlob(image.uri)
        : fetchImageBlob(image.uri)
    }

    if (typeof image.bufferView !== 'number') return null
    const bytes = readBufferViewFromBinaryChunk(binaryChunk, image.bufferView, document)
    return bytes ? new Blob([bytes], { type: image.mimeType ?? 'application/octet-stream' }) : null
  }
}

/** 判断 URL 是否指向 glTF / GLB 资产。 */
export function isGltfAssetUrl(url: string): boolean {
  return /\.gl(?:tf|b)(?:$|[?#])/i.test(url)
}

function isGlb(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 12 && new DataView(bytes.buffer, bytes.byteOffset, 12).getUint32(0, true) === 0x46546c67
}

function parseGltfJson(bytes: Uint8Array): GltfDocumentLite | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes).trim())
    return parsed && typeof parsed === 'object' ? parsed as GltfDocumentLite : null
  } catch {
    return null
  }
}

function isDataUri(value: string): boolean {
  return value.startsWith('data:')
}

/** 判断是否已经是浏览器可直接解析的绝对地址或项目根路径地址。 */
function isAbsoluteLikeUri(value: string): boolean {
  return /^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith('/')
}

/** 解析 glTF 常见 data URI 贴图；格式异常时按不可读处理，避免抛错中断整份模型预检。 */
function decodeDataUriToBlob(uri: string): Blob | null {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/i.exec(uri)
  if (!match) return null

  const mimeType = match[1] || 'application/octet-stream'
  const isBase64 = Boolean(match[2])
  const payload = match[3] ?? ''
  try {
    if (isBase64) {
      const binaryString = atob(payload)
      const bytes = new Uint8Array(binaryString.length)
      for (let index = 0; index < binaryString.length; index += 1) {
        bytes[index] = binaryString.charCodeAt(index)
      }
      return new Blob([bytes], { type: mimeType })
    }
    return new Blob([decodeURIComponent(payload)], { type: mimeType })
  } catch {
    return null
  }
}

/** 读取外部图片资源；网络失败、跨域失败或非 2xx 响应都按不可读处理。 */
async function fetchImageBlob(url: string): Promise<Blob | null> {
  if (typeof fetch !== 'function') return null
  try {
    const response = await fetch(url)
    return response.ok ? response.blob() : null
  } catch {
    return null
  }
}

/** 把 JSON glTF 中的相对路径资源转成绝对 URL；Blob URL 没有目录语义，不做转换。 */
function rewriteRelativeUris(document: GltfDocumentLite, sourceUrl: string): void {
  for (const buffer of document.buffers ?? []) {
    if (buffer.uri && !isDataUri(buffer.uri)) buffer.uri = resolveGltfSiblingUri(buffer.uri, sourceUrl)
  }
  for (const image of document.images ?? []) {
    if (image.uri && !isDataUri(image.uri)) image.uri = resolveGltfSiblingUri(image.uri, sourceUrl)
  }
}

/**
 * 解析 JSON glTF 中相对同级资源。
 *
 * `new URL(relative, base)` 要求 base 是完整绝对地址；项目里常见 `/dts/assets/a.gltf` 这类根路径。
 * 这里对根路径和普通相对路径做轻量拼接，既避免抛错，也不引入路径库到浏览器核心层。
 */
function resolveGltfSiblingUri(uri: string, sourceUrl: string): string {
  if (isAbsoluteLikeUri(uri)) return uri
  try {
    return new URL(uri, sourceUrl).toString()
  } catch {
    const cleanSource = sourceUrl.split(/[?#]/, 1)[0] ?? ''
    const slashIndex = cleanSource.lastIndexOf('/')
    const basePath = slashIndex >= 0 ? cleanSource.slice(0, slashIndex + 1) : ''
    return `${basePath}${uri}`
  }
}


/**
 * 将统一材质档案规则应用到 glTF 文档，返回实际更新的材质数量。
 *
 * 只按 materialIndex 精确定位修改，不做名称猜测，避免同名材质误修。state !== 'ready'
 * 的档案不会修改文档，保证未经人工确认或服务端派生的检测结果不会直接进入发布产物。
 */
export function applyMaterialProfileToGltfDocument(
  document: GltfDocumentLite,
  profile: Readonly<ModelMaterialProfile>,
): number {
  if (profile.state !== 'ready') return 0

  let updatedCount = 0
  const materials = document.materials ?? []

  for (let index = 0; index < materials.length; index += 1) {
    const material = materials[index]
    const rule = findModelMaterialRule(profile, index, material.name)
    if (!rule || rule.selector.materialIndex === undefined) continue
    if (index !== rule.selector.materialIndex) continue

    const targetMode = mapPlatformAlphaModeToGltf(rule.alphaMode)
    if (material.alphaMode === targetMode
      && (rule.alphaMode !== 'mask'
        || material.alphaCutoff === rule.alphaCutoff)
      && material.doubleSided === rule.doubleSided) {
      continue
    }

    material.alphaMode = targetMode
    if (rule.alphaMode === 'mask') {
      material.alphaCutoff = rule.alphaCutoff ?? DEFAULT_MODEL_MATERIAL_ALPHA_CUTOFF
    } else {
      delete material.alphaCutoff
    }
    material.doubleSided = Boolean(rule.doubleSided)
    updatedCount += 1
  }

  return updatedCount
}

/**
 * 把修改后的 glTF 文档重新编码成完整包。
 *
 * - GLB：重写 JSON chunk，BIN chunk 原样保留，确保嵌入贴图和几何数据不变
 * - JSON glTF：直接重新编码 JSON，二进制资源仍按原始 URI 引用
 *
 * 返回的是纯字节和 MIME 类型，不创建任何 Blob URL；是否生成对象地址由调用方决定，避免核心层持有
 * 需要手动释放的浏览器资源。
 */
export function encodeGltfPackage(packageData: ParsedGltfPackageLite): { bytes: Uint8Array; mimeType: string } | null {
  const jsonBytes = encodeGltfJson(packageData.document)
  if (!jsonBytes) return null

  if (packageData.isBinary) {
    const blob = createPatchedGlbBlob(jsonBytes, packageData.binaryChunk)
    return { bytes: new Uint8Array(blob), mimeType: 'model/gltf-binary' }
  }

  return { bytes: jsonBytes, mimeType: 'model/gltf+json' }
}

/**
 * 从原始资产字节 + 材质档案生成派生模型字节。
 *
 * 这是 M006 的核心纯数据入口：上传后处理、发布清单回填、Runtime 兼容修复都走同一套规则，避免
 * Cesium / Three / 后端各改各的出现漂移。失败返回 null，调用方回退原始资产。
 */
export function createDerivedModelFromProfile(
  sourceUrl: string,
  bytes: ArrayBuffer,
  profile: Readonly<ModelMaterialProfile>,
): { bytes: Uint8Array; mimeType: string; updatedMaterialCount: number } | null {
  const packageData = parseGltfPackage(sourceUrl, bytes)
  if (!packageData) return null

  const updatedCount = applyMaterialProfileToGltfDocument(packageData.document, profile)
  if (updatedCount === 0) return null

  const encoded = encodeGltfPackage(packageData)
  if (!encoded) return null

  return { bytes: encoded.bytes, mimeType: encoded.mimeType, updatedMaterialCount: updatedCount }
}

/** 将平台统一透明模式映射回 glTF 规范字符串。 */
function mapPlatformAlphaModeToGltf(mode: ModelMaterialRule['alphaMode']): string {
  if (mode === 'mask') return 'MASK'
  if (mode === 'blend') return 'BLEND'
  return 'OPAQUE'
}

/** 使用标准 GLB 块重新封装 JSON；BIN 块保持原字节，嵌入贴图与几何索引不会变化。 */
function createPatchedGlbBlob(json: Uint8Array, binaryChunk: Uint8Array | null): Uint8Array {
  const paddedJson = padGltfChunk(json, 0x20)
  const paddedBinary = binaryChunk ? padGltfChunk(binaryChunk, 0) : null
  const totalLength = 12 + 8 + paddedJson.byteLength + (paddedBinary ? 8 + paddedBinary.byteLength : 0)
  const output = new Uint8Array(totalLength)
  const view = new DataView(output.buffer)
  view.setUint32(0, 0x46546c67, true)
  view.setUint32(4, 2, true)
  view.setUint32(8, totalLength, true)
  view.setUint32(12, paddedJson.byteLength, true)
  view.setUint32(16, 0x4e4f534a, true)
  output.set(paddedJson, 20)
  if (paddedBinary) {
    const binaryHeader = 20 + paddedJson.byteLength
    view.setUint32(binaryHeader, paddedBinary.byteLength, true)
    view.setUint32(binaryHeader + 4, 0x004e4942, true)
    output.set(paddedBinary, binaryHeader + 8)
  }
  return output
}

/** glTF chunk 按 4 字节对齐，不足时填充指定字节。 */
function padGltfChunk(chunk: Uint8Array, paddingByte: number): Uint8Array {
  const paddedLength = Math.ceil(chunk.byteLength / 4) * 4
  if (paddedLength === chunk.byteLength) return chunk
  const padded = new Uint8Array(paddedLength)
  padded.set(chunk)
  padded.fill(paddingByte, chunk.byteLength)
  return padded
}

/** 将 glTF 文档编码为 UTF-8 JSON 字节；编码失败返回 null，由调用方走回退逻辑。 */
function encodeGltfJson(document: GltfDocumentLite): Uint8Array | null {
  try {
    return new TextEncoder().encode(JSON.stringify(document))
  } catch {
    return null
  }
}

// 导出类型，避免各使用方重复声明
export type { ModelMaterialRule, ModelMaterialRuleSource }