import { SCENE_EDITOR_BRAND_CONFIG } from './constant'
import { appLogger } from '@/utils/logger'

export type SceneEditorBrandConfig = {
  softwareName: string
  projectNameFallback: string
  logoSrc: string
  logoAlt: string
  /** 管理侧栏可以覆盖项目名称和标识，场景编辑器仍读取原有品牌字段。 */
  managementBrand?: { projectName: string; logoSrc: string }
}

export type LoadSceneEditorBrandConfigOptions = {
  url?: string
  fetcher?: typeof fetch
  onError?: (error: unknown) => void
}

const joinBaseUrl = (baseUrl: string, path: string) =>
  `${baseUrl.replace(/\/?$/, '/')}${path.replace(/^\//, '')}`

/**
 * 将品牌配置中的本地资源路径挂到应用基路径下。
 *
 * public 配置文件无法读取 Vite 环境变量；统一在这里解析相对路径和根相对路径，
 * 使开发环境的 /images 与生产环境的 /threeWeb/images 都能命中同一份静态资源，
 * 同时保留外部 http、数据和协议相对地址，方便按项目覆盖品牌图。
 *
 * @param source 品牌配置提供的原始资源地址。
 * @param baseUrl 应用部署基路径；默认读取当前 Vite 构建配置，测试可显式传入目标子路径。
 * @returns 可直接交给图片元素使用的完整资源地址。
 */
export const resolveSceneEditorBrandAssetUrl = (
  source: string,
  baseUrl = import.meta.env.BASE_URL || '/',
) => {
  const value = source.trim()
  if (!value || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(value)) return value

  return joinBaseUrl(baseUrl, value)
}

export const SCENE_EDITOR_BRAND_CONFIG_URL = joinBaseUrl(
  import.meta.env.BASE_URL,
  'config/scene-editor-brand.json',
)

export const getDefaultSceneEditorBrandConfig = (): SceneEditorBrandConfig => ({
  ...SCENE_EDITOR_BRAND_CONFIG,
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const resolveRequiredText = (
  source: Record<string, unknown>,
  key: string,
  fallback: string,
) => {
  const value = source[key]
  if (typeof value !== 'string') return fallback

  const text = value.trim()
  return text || fallback
}

const resolveOptionalText = (
  source: Record<string, unknown>,
  key: string,
  fallback: string,
) => {
  const value = source[key]
  return typeof value === 'string' ? value.trim() : fallback
}

export const normalizeSceneEditorBrandConfig = (
  value: unknown,
  fallback = getDefaultSceneEditorBrandConfig(),
): SceneEditorBrandConfig => {
  if (!isRecord(value)) return { ...fallback }

  const softwareName = resolveRequiredText(value, 'softwareName', fallback.softwareName)
  const logoSrc = resolveOptionalText(value, 'logoSrc', fallback.logoSrc)
  const management = isRecord(value.managementBrand) ? value.managementBrand : undefined

  return {
    softwareName,
    projectNameFallback: resolveRequiredText(
      value,
      'projectNameFallback',
      fallback.projectNameFallback,
    ),
    logoSrc,
    logoAlt: resolveRequiredText(value, 'logoAlt', fallback.logoAlt || softwareName),
    // 缺省字段继承共同品牌，空Logo地址可显式隐藏管理侧栏的标识。
    ...(management && {
      managementBrand: {
        projectName: resolveRequiredText(management, 'projectName', softwareName),
        logoSrc: resolveOptionalText(management, 'logoSrc', logoSrc),
      },
    }),
  }
}

export const loadSceneEditorBrandConfig = async ({
  url = SCENE_EDITOR_BRAND_CONFIG_URL,
  fetcher = typeof fetch === 'function' ? fetch : undefined,
  onError,
}: LoadSceneEditorBrandConfigOptions = {}): Promise<SceneEditorBrandConfig> => {
  const fallback = getDefaultSceneEditorBrandConfig()

  if (!fetcher) return fallback

  try {
    const response = await fetcher(url, { cache: 'no-store' })
    if (!response.ok) {
      throw new Error(`Failed to load scene editor brand config: ${response.status}`)
    }

    return normalizeSceneEditorBrandConfig(await response.json(), fallback)
  } catch (error) {
    if (onError) {
      onError(error)
    } else {
      appLogger.warn('SceneEditorBrandConfig', 'Runtime brand config fallback applied', error)
    }

    return fallback
  }
}
