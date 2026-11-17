import type { EffectSpec } from '../../core/types'
import { hasWeatherProvider } from './enviroWeatherValidation'
import type {
  WeatherV2AtmosphereParams,
  WeatherV2CloudParams,
  WeatherV2CloudQuality,
  WeatherV2CloudShadowParams,
  WeatherV2EffectParams,
  WeatherV2FogParams,
  WeatherV2LightShaftParams,
  WeatherV2Mode,
  WeatherV2QualityParams,
  WeatherV2QualityProfile,
  WeatherV2RainParams,
  WeatherV2RainImpactParams,
  WeatherV2ShadowParams,
  WeatherV2SnowParams,
  WeatherV2SunTimeMode,
  WeatherV2SunParams,
  WeatherV2SurfaceParams,
} from './weatherTypes'

export const MAIN_WEATHER_EFFECT_ID = 'weather-main'

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K]
}

const DEFAULT_SUN: WeatherV2SunParams = {
  enabled: true,
  dateTimeIso: '2025-06-21T04:00:00Z',
  timeMode: 'fixed',
  timeOfDayMinutes: 720,
  azimuthDeg: 135,
  elevationDeg: 72,
  // 颜色以 CSS 十六进制文本保存，保证场景文件可跨运行时持久化和回放。
  color: '#ffffff',
  // 默认太阳光强度按天气系统面板标定值初始化，确保新场景与面板首屏一致。
  intensity: 6.99,
  colorTemperature: 6500,
  dynamicLighting: true,
  shadowEnabled: true,
}

/**
 * 各质量档的基础阴影配置。
 * 编辑器默认优先保证阴影边缘平滑且层次明显，因此所有档位统一启用软阴影，并将暗度设为 0.52；
 * 用户或场景文件显式传入的 shadow 字段仍会在 normalizeWeatherV2Params 中覆盖这些默认值。
 */
const DEFAULT_SHADOW_BY_PROFILE: Record<WeatherV2QualityProfile, WeatherV2ShadowParams> = {
  'editor-low': {
    enabled: true,
    mapSize: 1024,
    softShadows: true,
    darkness: 0.52,
    maximumDistance: 7000,
  },
  balanced: {
    enabled: true,
    mapSize: 2048,
    softShadows: true,
    darkness: 0.52,
    maximumDistance: 12000,
  },
  showcase: {
    enabled: true,
    mapSize: 4096,
    softShadows: true,
    darkness: 0.52,
    maximumDistance: 24000,
  },
}

const DEFAULT_ATMOSPHERE: WeatherV2AtmosphereParams = {
  skyVisible: true,
  groundVisible: true,
  hazeIntensity: 0.05,
  hueShift: 0.02,
  saturationShift: 0.04,
  brightnessShift: 0.32,
  lightIntensity: 30,
  perFragment: true,
  rayleighScaleHeight: 9000,
  mieScaleHeight: 1600,
}

const DEFAULT_CLOUDS: WeatherV2CloudParams = {
  enabled: false,
  coverage: 0,
  altitude: 1800,
  thickness: 600,
  opacity: 0.7,
  brightness: 1,
  density: 0.45,
  noiseScale: 0.00012,
  detailStrength: 0.35,
  windDirectionDeg: 0,
  windSpeed: 0,
  quality: 'off',
}

const DEFAULT_CLOUD_SHADOW: WeatherV2CloudShadowParams = {
  enabled: false,
  opacity: 0,
  scale: 1,
  softness: 0.5,
  speed: 0,
  textureScale: 0.35,
  maxDistance: 60000,
  followWind: true,
}

const DEFAULT_FOG: WeatherV2FogParams = {
  enabled: false,
  startHeight: 500,
  endHeight: 1500,
  startOpacity: 1,
  endOpacity: 0,
  color: '#ffffff',
  alpha: 1,
}

const DEFAULT_LIGHT_SHAFTS: WeatherV2LightShaftParams = {
  enabled: false,
  intensity: 0,
  decay: 0.95,
  samples: 32,
  noiseStrength: 0,
  maxDistance: 50000,
}

const DEFAULT_RAIN: WeatherV2RainParams = {
  enabled: false,
  intensity: 0,
  speed: 600,
  windDirectionDeg: 0,
  size: 1,
  opacity: 0.75,
  impact: {
    enabled: true,
    spawnRate: 24,
    radius: 0.5,
    lifetime: 1.2,
    maxRipples: 64,
  },
}

const DEFAULT_SNOW: WeatherV2SnowParams = {
  enabled: false,
  intensity: 0,
  speed: 220,
  windDirectionDeg: 0,
  size: 1,
  opacity: 0.85,
}

const DEFAULT_SURFACE: WeatherV2SurfaceParams = {
  wetness: 0,
  puddle: 0,
  rippleStrength: 0,
  puddleSlopeLimitDeg: 18,
  roughness: 0.35,
  reflectionStrength: 0.4,
  accumulation: 0,
  evaporation: 0.08,
  snowAmount: 0,
  snowSoftness: 0.5,
}

const DEFAULT_QUALITY: WeatherV2QualityParams = {
  profile: 'editor-low',
  targetFps: 30,
  autoDowngrade: true,
  cloudBudget: 24,
  particleBudget: 3000,
  textureScale: 0.5,
  maxTextureSize: 1024,
}

export const DEFAULT_WEATHER_V2_PARAMS: WeatherV2EffectParams = {
  enabled: true,
  mode: 'clear',
  sun: DEFAULT_SUN,
  shadow: DEFAULT_SHADOW_BY_PROFILE['editor-low'],
  atmosphere: DEFAULT_ATMOSPHERE,
  clouds: DEFAULT_CLOUDS,
  cloudShadow: DEFAULT_CLOUD_SHADOW,
  fog: DEFAULT_FOG,
  lightShafts: DEFAULT_LIGHT_SHAFTS,
  rain: DEFAULT_RAIN,
  snow: DEFAULT_SNOW,
  surface: DEFAULT_SURFACE,
  quality: DEFAULT_QUALITY,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function mergeParams<T extends object>(defaults: T, input: unknown): T {
  if (!isRecord(input)) return { ...defaults }
  return { ...defaults, ...input } as T
}

function normalizeMode(value: unknown): WeatherV2Mode {
  return value === 'cloudy' ||
    value === 'fog' ||
    value === 'rain' ||
    value === 'snow' ||
    value === 'night'
    ? value
    : 'clear'
}

function normalizeQualityProfile(value: unknown): WeatherV2QualityProfile {
  return value === 'balanced' || value === 'showcase' ? value : 'editor-low'
}

function normalizeCloudQuality(value: unknown): WeatherV2CloudQuality {
  return value === 'low' || value === 'medium' || value === 'high' ? value : 'off'
}

function normalizeSunTimeMode(value: unknown): WeatherV2SunTimeMode {
  return value === 'realtime' ? 'realtime' : 'fixed'
}

function normalizeTimeOfDayMinutes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_SUN.timeOfDayMinutes
  return Math.min(1439, Math.max(0, Math.floor(value)))
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback
}

function normalizeFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function normalizeBoundedNumber(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

function normalizeRangeOrDefault(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : fallback
}

function normalizeRainImpactParams(input: unknown): WeatherV2RainImpactParams {
  const source = isRecord(input) ? input : {}
  const maxRipples = normalizeRangeOrDefault(
    source.maxRipples,
    0,
    512,
    DEFAULT_RAIN.impact.maxRipples,
  )
  return {
    enabled:
      typeof source.enabled === 'boolean' ? source.enabled : DEFAULT_RAIN.impact.enabled,
    spawnRate: Math.floor(normalizeRangeOrDefault(
      source.spawnRate,
      0,
      120,
      DEFAULT_RAIN.impact.spawnRate,
    )),
    radius: normalizeRangeOrDefault(source.radius, 0.01, 10, DEFAULT_RAIN.impact.radius),
    lifetime: normalizeRangeOrDefault(source.lifetime, 0.05, 10, DEFAULT_RAIN.impact.lifetime),
    maxRipples: Math.floor(maxRipples),
  }
}

function normalizeRainParams(input: unknown): WeatherV2RainParams {
  const merged = mergeParams(DEFAULT_RAIN, input)
  return {
    ...merged,
    intensity: normalizeBoundedNumber(merged.intensity, 0, 1, DEFAULT_RAIN.intensity),
    speed: normalizeRangeOrDefault(merged.speed, 100, 1000, DEFAULT_RAIN.speed),
    windDirectionDeg: normalizeFiniteNumber(merged.windDirectionDeg, DEFAULT_RAIN.windDirectionDeg),
    size: normalizeBoundedNumber(merged.size, 0.01, 10, DEFAULT_RAIN.size),
    opacity: normalizeBoundedNumber(merged.opacity, 0, 1, DEFAULT_RAIN.opacity),
    impact: normalizeRainImpactParams(isRecord(input) ? input.impact : undefined),
  }
}

function normalizeSurfaceParams(input: unknown): WeatherV2SurfaceParams {
  const merged = mergeParams(DEFAULT_SURFACE, input)
  return {
    ...merged,
    wetness: normalizeBoundedNumber(merged.wetness, 0, 1, DEFAULT_SURFACE.wetness),
    puddle: normalizeBoundedNumber(merged.puddle, 0, 1, DEFAULT_SURFACE.puddle),
    rippleStrength: normalizeBoundedNumber(
      merged.rippleStrength,
      0,
      1,
      DEFAULT_SURFACE.rippleStrength,
    ),
    puddleSlopeLimitDeg: normalizeRangeOrDefault(
      merged.puddleSlopeLimitDeg,
      0,
      90,
      DEFAULT_SURFACE.puddleSlopeLimitDeg,
    ),
    roughness: normalizeRangeOrDefault(merged.roughness, 0, 1, DEFAULT_SURFACE.roughness),
    reflectionStrength: normalizeRangeOrDefault(
      merged.reflectionStrength,
      0,
      1,
      DEFAULT_SURFACE.reflectionStrength,
    ),
    accumulation: normalizeRangeOrDefault(
      merged.accumulation,
      0,
      1,
      DEFAULT_SURFACE.accumulation,
    ),
    evaporation: normalizeRangeOrDefault(merged.evaporation, 0, 1, DEFAULT_SURFACE.evaporation),
  }
}

/**
 * 太阳颜色由颜色控件写入 CSS 字符串。空值和非字符串回退到默认白光，避免运行时把无效值传入引擎。
 * 具体 CSS 色值由 Cesium 的颜色解析器负责识别，以兼容历史场景中已保存的合法格式。
 */
function normalizeSunColor(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_SUN.color
  const color = value.trim()
  return color || DEFAULT_SUN.color
}

/** 太阳强度限定为 0 至 10，覆盖从关闭光照到高亮调试的有效范围。 */
function normalizeSunIntensity(value: unknown): number {
  return Math.min(10, Math.max(0, normalizeFiniteNumber(value, DEFAULT_SUN.intensity)))
}

function normalizeFogParams(input: unknown): WeatherV2FogParams {
  const source = isRecord(input) ? input : {}
  const legacyDensity = normalizeFiniteNumber(source.density, DEFAULT_FOG.alpha)

  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : DEFAULT_FOG.enabled,
    startHeight: normalizeFiniteNumber(source.startHeight, DEFAULT_FOG.startHeight),
    endHeight: normalizeFiniteNumber(source.endHeight, DEFAULT_FOG.endHeight),
    startOpacity: normalizeFiniteNumber(source.startOpacity, DEFAULT_FOG.startOpacity),
    endOpacity: normalizeFiniteNumber(source.endOpacity, DEFAULT_FOG.endOpacity),
    color: typeof source.color === 'string' ? source.color : DEFAULT_FOG.color,
    alpha: normalizeFiniteNumber(source.alpha, legacyDensity),
  }
}

function normalizeLightShaftParams(input: unknown): WeatherV2LightShaftParams {
  const source = isRecord(input) ? input : {}

  return {
    enabled:
      typeof source.enabled === 'boolean' ? source.enabled : DEFAULT_LIGHT_SHAFTS.enabled,
    intensity: normalizeFiniteNumber(source.intensity, DEFAULT_LIGHT_SHAFTS.intensity),
    decay: normalizeFiniteNumber(source.decay, DEFAULT_LIGHT_SHAFTS.decay),
    samples: normalizePositiveInteger(source.samples, DEFAULT_LIGHT_SHAFTS.samples),
    noiseStrength: normalizeFiniteNumber(
      source.noiseStrength,
      DEFAULT_LIGHT_SHAFTS.noiseStrength,
    ),
    maxDistance: normalizePositiveInteger(source.maxDistance, DEFAULT_LIGHT_SHAFTS.maxDistance),
  }
}

export function normalizeWeatherV2Params(input: unknown = {}): WeatherV2EffectParams {
  const source = isRecord(input) ? input : {}
  const quality = mergeParams(DEFAULT_QUALITY, source.quality)
  const normalizedQuality = {
    ...quality,
    profile: normalizeQualityProfile(quality.profile),
  }
  const profileShadow = DEFAULT_SHADOW_BY_PROFILE[normalizedQuality.profile]
  const shadowSource = mergeParams(profileShadow, source.shadow)
  const sunSource = mergeParams(DEFAULT_SUN, source.sun)

  return {
    ...DEFAULT_WEATHER_V2_PARAMS,
    ...source,
    enabled:
      typeof source.enabled === 'boolean' ? source.enabled : DEFAULT_WEATHER_V2_PARAMS.enabled,
    mode: normalizeMode(source.mode),
    presetId: typeof source.presetId === 'string' ? source.presetId : undefined,
    sun: {
      ...sunSource,
      enabled: typeof sunSource.enabled === 'boolean' ? sunSource.enabled : DEFAULT_SUN.enabled,
      dateTimeIso:
        typeof sunSource.dateTimeIso === 'string' || sunSource.dateTimeIso === null
          ? sunSource.dateTimeIso
          : DEFAULT_SUN.dateTimeIso,
      timeMode: normalizeSunTimeMode(sunSource.timeMode),
      timeOfDayMinutes: normalizeTimeOfDayMinutes(sunSource.timeOfDayMinutes),
      color: normalizeSunColor(sunSource.color),
      intensity: normalizeSunIntensity(sunSource.intensity),
    },
    shadow: {
      ...shadowSource,
      enabled:
        typeof shadowSource.enabled === 'boolean' ? shadowSource.enabled : profileShadow.enabled,
      mapSize: normalizePositiveInteger(shadowSource.mapSize, profileShadow.mapSize),
      softShadows:
        typeof shadowSource.softShadows === 'boolean'
          ? shadowSource.softShadows
          : profileShadow.softShadows,
      darkness:
        typeof shadowSource.darkness === 'number' && Number.isFinite(shadowSource.darkness)
          ? shadowSource.darkness
          : profileShadow.darkness,
      maximumDistance: normalizePositiveInteger(
        shadowSource.maximumDistance,
        profileShadow.maximumDistance,
      ),
    },
    atmosphere: mergeParams(DEFAULT_ATMOSPHERE, source.atmosphere),
    clouds: {
      ...mergeParams(DEFAULT_CLOUDS, source.clouds),
      quality: normalizeCloudQuality(mergeParams(DEFAULT_CLOUDS, source.clouds).quality),
    },
    cloudShadow: mergeParams(DEFAULT_CLOUD_SHADOW, source.cloudShadow),
    fog: normalizeFogParams(source.fog),
    lightShafts: normalizeLightShaftParams(source.lightShafts),
    rain: normalizeRainParams(source.rain),
    snow: mergeParams(DEFAULT_SNOW, source.snow),
    surface: normalizeSurfaceParams(source.surface),
    quality: normalizedQuality,
  }
}

export function createDefaultWeatherV2Effect(
  params: DeepPartial<WeatherV2EffectParams> = {},
): EffectSpec {
  return {
    id: MAIN_WEATHER_EFFECT_ID,
    type: 'weather',
    params: normalizeWeatherV2Params(params) as unknown as Record<string, unknown>,
  }
}

export function normalizeWeatherV2Effect(effect: EffectSpec): EffectSpec {
  if (effect.type !== 'weather' || hasWeatherProvider(effect.params)) return effect
  return {
    ...effect,
    params: normalizeWeatherV2Params(effect.params) as unknown as Record<string, unknown>,
  }
}
