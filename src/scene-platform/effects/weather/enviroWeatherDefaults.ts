import type { EffectSpec } from '../../core/types'
import type { EnviroWeatherConfig } from './enviroWeatherTypes'
import { MAIN_WEATHER_EFFECT_ID } from './weatherDefaults'
import { validateEnviroWeatherConfig } from './enviroWeatherValidation'

/** Stable project defaults. Merely opening a panel never inserts this configuration. */
export function createDefaultEnviroWeatherConfig(): EnviroWeatherConfig {
  return {
    provider: 'enviro3', schemaVersion: 1, enabled: true, presetId: 'clear',
    transition: { mode: 'smooth' },
    time: { mode: 'fixed', date: '2026-06-21', minutesOfDay: 720, utcOffsetHours: 8 },
    location: { source: 'scene', latitude: null, longitude: null },
    overrides: createInheritedEnviroWeatherOverrides(), quality: { profile: 'medium' },
  }
}

export function createInheritedEnviroWeatherOverrides(): EnviroWeatherConfig['overrides'] {
  return {
    clouds: { enabled: null, coveragePercent: null, baseHeightMeters: null },
    fog: { enabled: null, densityPercent: null, heightMeters: null },
    wind: { strengthPercent: null, directionDeg: null },
    lighting: { directMultiplier: null, ambientMultiplier: null },
  }
}

export function createEnviroWeatherEffect(config = createDefaultEnviroWeatherConfig()): EffectSpec {
  const issues = validateEnviroWeatherConfig(config)
  if (issues.length) throw new Error(issues.join('\n'))
  return { id: MAIN_WEATHER_EFFECT_ID, type: 'weather', params: JSON.parse(JSON.stringify(config)) }
}

export function selectEnviroWeatherPreset(config: EnviroWeatherConfig, presetId: string): EnviroWeatherConfig {
  return { ...config, presetId, overrides: createInheritedEnviroWeatherOverrides() }
}
