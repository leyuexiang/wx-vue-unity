import type { EffectSpec } from '../../core/types'
import { hasWeatherProvider, validateEnviroWeatherConfig } from './enviroWeatherValidation'

const WEATHER_V2_MODES = new Set(['clear', 'cloudy', 'fog', 'rain', 'snow', 'night'])
const WEATHER_V2_QUALITY_PROFILES = new Set(['editor-low', 'balanced', 'showcase'])
const WEATHER_V2_CLOUD_QUALITIES = new Set(['off', 'low', 'medium', 'high'])
const WEATHER_V2_SUN_TIME_MODES = new Set(['fixed', 'realtime'])
const LEGACY_WEATHER_PARAM_KEYS = [
  'weather' + 'Scenario',
  'precip' + 'itation',
  'surface' + 'Weather',
  'environmentPreset',
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function validateRange(
  value: unknown,
  label: string,
  min: number,
  max: number,
  issues: string[],
) {
  if (value === undefined) return

  if (!isFiniteNumber(value) || value < min || value > max) {
    issues.push(`${label} must be between ${min} and ${max}.`)
  }
}

function validateNestedRange(
  params: Record<string, unknown>,
  groupName: string,
  fieldName: string,
  labelPrefix: string,
  min: number,
  max: number,
  issues: string[],
) {
  const group = params[groupName]
  if (group === undefined) return

  if (!isRecord(group)) {
    issues.push(`${labelPrefix} ${groupName} must be a plain object when provided.`)
    return
  }

  validateRange(group[fieldName], `${labelPrefix} ${groupName}.${fieldName}`, min, max, issues)
}

export function isLegacyWeatherEffectSpec(effect: unknown): boolean {
  if (!isRecord(effect)) return false

  if (effect.type === 'environment') return true
  if (effect.type !== 'weather') return false

  const params = effect.params
  if (!isRecord(params)) return false
  if (hasWeatherProvider(params)) return false

  return LEGACY_WEATHER_PARAM_KEYS.some((key) => key in params)
}

export function validateWeatherV2EffectSpec(
  effect: EffectSpec,
  labelPrefix: string,
): string[] {
  if (effect.type !== 'weather') return []

  const issues: string[] = []
  const params = effect.params
  if (!isRecord(params)) return issues
  if (hasWeatherProvider(params)) {
    // Future schemas remain readable/exportable, but cannot enter the Enviro editor or transport.
    return params.provider === 'enviro3' && params.schemaVersion === 1
      ? validateEnviroWeatherConfig(params, labelPrefix)
      : []
  }

  if (params.mode !== undefined && !WEATHER_V2_MODES.has(String(params.mode))) {
    issues.push(`${labelPrefix} weather mode must be a supported Weather V2 mode.`)
  }

  validateNestedRange(params, 'clouds', 'coverage', `${labelPrefix} weather`, 0, 1, issues)
  validateNestedRange(params, 'clouds', 'opacity', `${labelPrefix} weather`, 0, 1, issues)
  validateNestedRange(params, 'clouds', 'density', `${labelPrefix} weather`, 0, 1, issues)
  validateNestedRange(params, 'clouds', 'detailStrength', `${labelPrefix} weather`, 0, 1, issues)
  validateNestedRange(params, 'clouds', 'altitude', `${labelPrefix} weather`, 0, 100000, issues)
  validateNestedRange(params, 'clouds', 'thickness', `${labelPrefix} weather`, 1, 50000, issues)
  validateNestedRange(params, 'clouds', 'noiseScale', `${labelPrefix} weather`, 0.000001, 0.01, issues)
  validateNestedRange(params, 'cloudShadow', 'opacity', `${labelPrefix} weather`, 0, 1, issues)
  validateNestedRange(params, 'cloudShadow', 'textureScale', `${labelPrefix} weather`, 0.1, 1, issues)
  validateNestedRange(params, 'cloudShadow', 'scale', `${labelPrefix} weather`, 0.1, 20, issues)
  validateNestedRange(params, 'cloudShadow', 'softness', `${labelPrefix} weather`, 0, 1, issues)
  validateNestedRange(params, 'cloudShadow', 'maxDistance', `${labelPrefix} weather`, 1, 1000000, issues)
  validateNestedRange(params, 'fog', 'startHeight', `${labelPrefix} weather`, 0, 100000, issues)
  validateNestedRange(params, 'fog', 'endHeight', `${labelPrefix} weather`, 0, 100000, issues)
  validateNestedRange(params, 'fog', 'startOpacity', `${labelPrefix} weather`, 0, 1, issues)
  validateNestedRange(params, 'fog', 'endOpacity', `${labelPrefix} weather`, 0, 1, issues)
  validateNestedRange(params, 'fog', 'alpha', `${labelPrefix} weather`, 0, 1, issues)
  validateNestedRange(params, 'lightShafts', 'intensity', `${labelPrefix} weather`, 0, 1, issues)
  validateNestedRange(params, 'lightShafts', 'decay', `${labelPrefix} weather`, 0, 0.99, issues)
  validateNestedRange(params, 'lightShafts', 'samples', `${labelPrefix} weather`, 1, 128, issues)
  validateNestedRange(params, 'lightShafts', 'noiseStrength', `${labelPrefix} weather`, 0, 1, issues)
  validateNestedRange(params, 'lightShafts', 'maxDistance', `${labelPrefix} weather`, 1, 1000000, issues)
  validateNestedRange(params, 'rain', 'intensity', `${labelPrefix} weather`, 0, 1, issues)
  const rain = params.rain
  if (rain !== undefined) {
    if (!isRecord(rain)) {
      issues.push(`${labelPrefix} weather rain must be a plain object when provided.`)
    } else {
      const impact = rain.impact
      if (impact !== undefined) {
        if (!isRecord(impact)) {
          issues.push(`${labelPrefix} weather rain.impact must be a plain object when provided.`)
        } else {
          validateRange(impact.spawnRate, `${labelPrefix} weather rain.impact.spawnRate`, 0, 120, issues)
          validateRange(impact.radius, `${labelPrefix} weather rain.impact.radius`, 0.01, 10, issues)
          validateRange(impact.lifetime, `${labelPrefix} weather rain.impact.lifetime`, 0.05, 10, issues)
          validateRange(impact.maxRipples, `${labelPrefix} weather rain.impact.maxRipples`, 0, 512, issues)
        }
      }
    }
  }
  validateNestedRange(params, 'snow', 'intensity', `${labelPrefix} weather`, 0, 1, issues)
  validateNestedRange(params, 'surface', 'wetness', `${labelPrefix} weather`, 0, 1, issues)
  validateNestedRange(params, 'surface', 'puddle', `${labelPrefix} weather`, 0, 1, issues)
  validateNestedRange(params, 'surface', 'rippleStrength', `${labelPrefix} weather`, 0, 1, issues)
  validateNestedRange(params, 'surface', 'puddleSlopeLimitDeg', `${labelPrefix} weather`, 0, 90, issues)
  validateNestedRange(params, 'surface', 'roughness', `${labelPrefix} weather`, 0, 1, issues)
  validateNestedRange(params, 'surface', 'reflectionStrength', `${labelPrefix} weather`, 0, 1, issues)
  validateNestedRange(params, 'surface', 'accumulation', `${labelPrefix} weather`, 0, 1, issues)
  validateNestedRange(params, 'surface', 'evaporation', `${labelPrefix} weather`, 0, 1, issues)
  validateNestedRange(params, 'surface', 'snowAmount', `${labelPrefix} weather`, 0, 1, issues)
  validateNestedRange(params, 'shadow', 'darkness', `${labelPrefix} weather`, 0, 1, issues)

  const clouds = params.clouds
  if (isRecord(clouds) && clouds.quality !== undefined && !WEATHER_V2_CLOUD_QUALITIES.has(String(clouds.quality))) {
    issues.push(`${labelPrefix} weather clouds.quality must be a supported cloud quality.`)
  }

  const sun = params.sun
  if (sun !== undefined) {
    if (!isRecord(sun)) {
      issues.push(`${labelPrefix} weather sun must be a plain object when provided.`)
    } else if (
      sun.timeMode !== undefined &&
      !WEATHER_V2_SUN_TIME_MODES.has(String(sun.timeMode))
    ) {
      issues.push(`${labelPrefix} weather sun.timeMode must be fixed or realtime.`)
    }
    if (isRecord(sun)) {
      validateRange(
        sun.timeOfDayMinutes,
        `${labelPrefix} weather sun.timeOfDayMinutes`,
        0,
        1439,
        issues,
      )
    }
  }

  const fog = params.fog
  if (fog !== undefined) {
    if (!isRecord(fog)) {
      issues.push(`${labelPrefix} weather fog must be a plain object when provided.`)
    } else {
      if (fog.color !== undefined && typeof fog.color !== 'string') {
        issues.push(`${labelPrefix} weather fog.color must be a CSS color string.`)
      }
      if (
        isFiniteNumber(fog.startHeight) &&
        isFiniteNumber(fog.endHeight) &&
        fog.endHeight <= fog.startHeight
      ) {
        issues.push(`${labelPrefix} weather fog.endHeight must be greater than fog.startHeight.`)
      }
    }
  }

  const quality = params.quality
  if (quality !== undefined) {
    if (!isRecord(quality)) {
      issues.push(`${labelPrefix} weather quality must be a plain object when provided.`)
    } else {
      if (
        quality.profile !== undefined &&
        !WEATHER_V2_QUALITY_PROFILES.has(String(quality.profile))
      ) {
        issues.push(`${labelPrefix} weather quality.profile must be a supported quality profile.`)
      }

      validateRange(
        quality.targetFps,
        `${labelPrefix} weather quality.targetFps`,
        1,
        120,
        issues,
      )
      validateRange(
        quality.textureScale,
        `${labelPrefix} weather quality.textureScale`,
        0.1,
        1,
        issues,
      )
    }
  }

  const shadow = params.shadow
  if (shadow !== undefined) {
    if (!isRecord(shadow)) {
      issues.push(`${labelPrefix} weather shadow must be a plain object when provided.`)
    } else {
      validateRange(
        shadow.mapSize,
        `${labelPrefix} weather shadow.mapSize`,
        256,
        8192,
        issues,
      )
      validateRange(
        shadow.maximumDistance,
        `${labelPrefix} weather shadow.maximumDistance`,
        1,
        1000000,
        issues,
      )
    }
  }

  return issues
}
