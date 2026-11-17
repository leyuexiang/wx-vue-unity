import {
  createDefaultWeatherV2Effect,
  type EffectSpec,
  MAIN_WEATHER_EFFECT_ID,
  normalizeWeatherV2Params,
  type WeatherV2EffectParams,
} from '@/scene-platform'
import { hasWeatherProvider } from '@/scene-platform/effects/weather/enviroWeatherValidation'

type WeatherEffectOverrides = Parameters<typeof createDefaultWeatherV2Effect>[0]

const LEGACY_EDITOR_DEFAULT_VOLUMETRIC_CLOUDS: WeatherV2EffectParams['clouds'] = {
  enabled: true,
  coverage: 0.63,
  altitude: 2000,
  thickness: 7000,
  opacity: 0.74,
  brightness: 1.18,
  density: 0.52,
  noiseScale: 0.00015,
  detailStrength: 0.42,
  windDirectionDeg: 90,
  windSpeed: 18,
  quality: 'high',
}

const LEGACY_EDITOR_DEFAULT_VOLUMETRIC_CLOUD_SHADOW: WeatherV2EffectParams['cloudShadow'] = {
  enabled: true,
  opacity: 0.16,
  scale: 3.2,
  softness: 0.68,
  speed: 0.9,
  textureScale: 1,
  maxDistance: 180000,
  followWind: true,
}

const PREVIOUS_GRAY_EDITOR_DEFAULT_VOLUMETRIC_CLOUDS: WeatherV2EffectParams['clouds'] = {
  enabled: true,
  coverage: 0.45,
  altitude: 2800,
  thickness: 2800,
  opacity: 0.68,
  brightness: 1.08,
  density: 0.38,
  noiseScale: 0.00012,
  detailStrength: 0.32,
  windDirectionDeg: 90,
  windSpeed: 8,
  quality: 'medium',
}

const PREVIOUS_BALANCED_EDITOR_DEFAULT_VOLUMETRIC_CLOUDS: WeatherV2EffectParams['clouds'] = {
  enabled: true,
  coverage: 0.45,
  altitude: 2800,
  thickness: 2800,
  opacity: 0.68,
  brightness: 1.12,
  density: 0.38,
  noiseScale: 0.00012,
  detailStrength: 0.32,
  windDirectionDeg: 90,
  windSpeed: 8,
  quality: 'medium',
}

const PREVIOUS_LIGHT_EDITOR_DEFAULT_VOLUMETRIC_CLOUD_SHADOW: WeatherV2EffectParams['cloudShadow'] =
  {
    enabled: true,
    opacity: 0.06,
    scale: 4.8,
    softness: 0.82,
    speed: 0.45,
    textureScale: 0.75,
    maxDistance: 120000,
    followWind: true,
  }

export const EDITOR_DEFAULT_VOLUMETRIC_CLOUDS: WeatherV2EffectParams['clouds'] = {
  enabled: true,
  coverage: 0.5,
  altitude: 5000,
  thickness: 6250,
  opacity: 1,
  brightness: 1,
  density: 0.55,
  noiseScale: 0.00012,
  detailStrength: 0.35,
  windDirectionDeg: 90,
  windSpeed: 100,
  quality: 'high',
}

export const EDITOR_DEFAULT_VOLUMETRIC_CLOUD_SHADOW: WeatherV2EffectParams['cloudShadow'] = {
  enabled: true,
  opacity: 0.35,
  scale: 1,
  softness: 0.5,
  speed: 1,
  textureScale: 1,
  maxDistance: 250000,
  followWind: true,
}

export const createEditorDefaultVolumetricCloudEffect = (
  overrides: WeatherEffectOverrides = {},
): EffectSpec =>
  createDefaultWeatherV2Effect({
    enabled: true,
    mode: 'cloudy',
    ...overrides,
    sun: {
      enabled: true,
      dateTimeIso: '2025-12-28T07:00:00Z',
      azimuthDeg: 130,
      elevationDeg: 68,
      // 编辑器 GIS 新场景与天气面板共用 6.99 的太阳光默认强度。
      intensity: 6.99,
      dynamicLighting: false,
      /**
       * 编辑器 GIS 默认天气必须允许太阳阴影参与渲染。
       *
       * Cesium 的阴影开关由 `sun.enabled && sun.shadowEnabled && shadow.enabled`
       * 三项共同决定；这里若关闭 `shadowEnabled`，所有没有显式天气配置的 GIS
       * 场景都会在加载时永久关闭模型阴影。用户仍可通过天气面板或传入覆盖项关闭。
       */
      shadowEnabled: true,
      ...overrides.sun,
    },
    shadow: {
      enabled: true,
      // 编辑器新建或升级场景默认使用平滑软阴影，并保持 0.52 的阴影暗度。
      softShadows: true,
      darkness: 0.52,
      maximumDistance: 12000,
      ...overrides.shadow,
    },
    atmosphere: {
      skyVisible: true,
      groundVisible: true,
      hazeIntensity: 0.035,
      hueShift: 0.02,
      saturationShift: 0.08,
      brightnessShift: 0.36,
      lightIntensity: 30,
      ...overrides.atmosphere,
    },
    clouds: {
      ...EDITOR_DEFAULT_VOLUMETRIC_CLOUDS,
      ...overrides.clouds,
    },
    cloudShadow: {
      ...EDITOR_DEFAULT_VOLUMETRIC_CLOUD_SHADOW,
      ...overrides.cloudShadow,
    },
    quality: {
      profile: 'editor-low',
      targetFps: 30,
      autoDowngrade: false,
      ...overrides.quality,
    },
  })

function nearlyEqual(value: number, expected: number): boolean {
  return Math.abs(value - expected) < 0.000001
}

function matchesClouds(
  clouds: WeatherV2EffectParams['clouds'],
  expected: WeatherV2EffectParams['clouds'],
): boolean {
  return (
    clouds.enabled === expected.enabled &&
    clouds.quality === expected.quality &&
    nearlyEqual(clouds.coverage, expected.coverage) &&
    nearlyEqual(clouds.altitude, expected.altitude) &&
    nearlyEqual(clouds.thickness, expected.thickness) &&
    nearlyEqual(clouds.opacity, expected.opacity) &&
    nearlyEqual(clouds.brightness, expected.brightness) &&
    nearlyEqual(clouds.density, expected.density) &&
    nearlyEqual(clouds.noiseScale, expected.noiseScale) &&
    nearlyEqual(clouds.detailStrength, expected.detailStrength) &&
    nearlyEqual(clouds.windDirectionDeg, expected.windDirectionDeg) &&
    nearlyEqual(clouds.windSpeed, expected.windSpeed)
  )
}

function matchesCloudShadow(
  cloudShadow: WeatherV2EffectParams['cloudShadow'],
  expected: WeatherV2EffectParams['cloudShadow'],
): boolean {
  return (
    cloudShadow.enabled === expected.enabled &&
    cloudShadow.followWind === expected.followWind &&
    nearlyEqual(cloudShadow.opacity, expected.opacity) &&
    nearlyEqual(cloudShadow.scale, expected.scale) &&
    nearlyEqual(cloudShadow.softness, expected.softness) &&
    nearlyEqual(cloudShadow.speed, expected.speed) &&
    nearlyEqual(cloudShadow.textureScale, expected.textureScale) &&
    nearlyEqual(cloudShadow.maxDistance, expected.maxDistance)
  )
}

export function isLegacyEditorDefaultVolumetricCloudEffect(effect: EffectSpec): boolean {
  if (effect.id !== MAIN_WEATHER_EFFECT_ID || effect.type !== 'weather') return false
  if (hasWeatherProvider(effect.params)) return false

  const params = normalizeWeatherV2Params(effect.params)
  const isOldOvercastDefault =
    params.enabled &&
    params.mode === 'cloudy' &&
    params.sun.enabled === false &&
    nearlyEqual(params.sun.elevationDeg, 58) &&
    nearlyEqual(params.atmosphere.hazeIntensity, 0.06) &&
    nearlyEqual(params.atmosphere.brightnessShift, 0.02) &&
    nearlyEqual(params.atmosphere.lightIntensity, 8) &&
    matchesClouds(params.clouds, LEGACY_EDITOR_DEFAULT_VOLUMETRIC_CLOUDS) &&
    matchesCloudShadow(params.cloudShadow, LEGACY_EDITOR_DEFAULT_VOLUMETRIC_CLOUD_SHADOW)

  const isPreviousGrayDefault =
    params.enabled &&
    params.mode === 'cloudy' &&
    params.sun.enabled === true &&
    nearlyEqual(params.sun.elevationDeg, 68) &&
    nearlyEqual(params.atmosphere.hazeIntensity, 0.035) &&
    nearlyEqual(params.atmosphere.brightnessShift, 0.36) &&
    nearlyEqual(params.atmosphere.lightIntensity, 30) &&
    matchesClouds(params.clouds, PREVIOUS_GRAY_EDITOR_DEFAULT_VOLUMETRIC_CLOUDS) &&
    matchesCloudShadow(params.cloudShadow, PREVIOUS_LIGHT_EDITOR_DEFAULT_VOLUMETRIC_CLOUD_SHADOW)

  const isPreviousBalancedDefault =
    params.enabled &&
    params.mode === 'cloudy' &&
    params.sun.enabled === true &&
    nearlyEqual(params.sun.elevationDeg, 68) &&
    nearlyEqual(params.atmosphere.hazeIntensity, 0.035) &&
    nearlyEqual(params.atmosphere.brightnessShift, 0.36) &&
    nearlyEqual(params.atmosphere.lightIntensity, 30) &&
    matchesClouds(params.clouds, PREVIOUS_BALANCED_EDITOR_DEFAULT_VOLUMETRIC_CLOUDS) &&
    matchesCloudShadow(params.cloudShadow, PREVIOUS_LIGHT_EDITOR_DEFAULT_VOLUMETRIC_CLOUD_SHADOW)

  return isOldOvercastDefault || isPreviousGrayDefault || isPreviousBalancedDefault
}

export function upgradeLegacyEditorDefaultVolumetricCloudEffect(effect: EffectSpec): EffectSpec {
  if (!isLegacyEditorDefaultVolumetricCloudEffect(effect)) return effect

  const upgradedEffect = createEditorDefaultVolumetricCloudEffect()
  return {
    ...effect,
    params: upgradedEffect.params,
  }
}
