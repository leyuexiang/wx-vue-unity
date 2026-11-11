import type { EffectSpec, SceneDefinition, SceneStore } from '@/scene-platform'
import { createUpdateWeatherEffectCommand } from '@/scene-platform/commands/updateWeatherEffectCommand'
import {
  createDefaultEnviroWeatherConfig, createEnviroWeatherEffect, hasWeatherProvider,
  isSupportedEnviroWeatherConfig, isWeatherRecord, MAIN_WEATHER_EFFECT_ID,
  validateEnviroWeatherConfig, type EnviroWeatherConfig,
} from '@/scene-platform/effects/weather'
import type { SceneCommand } from '@/scene-platform/commands/types'

let editGuard: (() => boolean) | null = null
export function setEditorWeatherEditGuard(guard: () => boolean): () => void {
  editGuard = guard
  return () => { if (editGuard === guard) editGuard = null }
}
export const isEditorWeatherWriteAllowed = () => editGuard?.() !== false

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value, function (key, serialized) {
  // Inspect the original before toJSON conversion, preserving the four-package strict JSON boundary.
  const original: unknown = this[key]
  if (original === undefined && !Array.isArray(this)) return serialized
  if (original === undefined || ['function', 'symbol', 'bigint'].includes(typeof original) ||
    (typeof original === 'number' && !Number.isFinite(original)) ||
    (typeof original === 'object' && original !== null && !Array.isArray(original) && !isWeatherRecord(original)))
    throw new Error('天气配置只能包含普通 JSON 数据和有限数字。')
  return serialized
})) as T

/** Effects are authoritative. settings.weather is consulted only for unedited legacy scenes. */
export function getPersistableWeatherConfig(scene: SceneDefinition): Record<string, unknown> {
  const weather = scene.effects.find(effect => effect.type === 'weather' && effect.id === MAIN_WEATHER_EFFECT_ID)
    ?? scene.effects.find(effect => effect.type === 'weather')
  if (weather) return clone(weather.params)
  // Provider weather is restored into effects on import. Falling back to its source snapshot here
  // would resurrect a deliberately deleted weather-main effect on save or object reprojection.
  return isWeatherRecord(scene.settings.weather) && !hasWeatherProvider(scene.settings.weather) ? clone(scene.settings.weather) : {}
}

/** Four-package restoration is idempotent; never hand provider data to the legacy normalizer. */
export function restorePersistedWeatherEffects(effects: readonly EffectSpec[], weather: unknown): EffectSpec[] {
  const current = effects.find(effect => effect.type === 'weather' && hasWeatherProvider(effect.params))
  const persisted = hasWeatherProvider(weather)
    ? { id: MAIN_WEATHER_EFFECT_ID, type: 'weather' as const, params: clone(weather as Record<string, unknown>) }
    : undefined
  const existing = current ?? persisted ?? effects.find(effect => effect.type === 'weather')
  if (existing) return [...effects.filter(effect => effect.type !== 'weather'), { ...existing, id: MAIN_WEATHER_EFFECT_ID }]
  return [...effects]
}

/** Only unambiguous legacy controls migrate. Unsupported fields are explicitly backed up. */
export function migrateLegacyWeatherConfig(raw: Record<string, unknown>): EnviroWeatherConfig {
  if (hasWeatherProvider(raw)) {
    if (!isSupportedEnviroWeatherConfig(raw)) throw new Error('天气配置版本不支持编辑，请升级播放器与编辑器。')
    return clone(raw)
  }
  if (JSON.stringify(raw).length > 32768) throw new Error('旧天气配置超过迁移备份上限，请先导出原场景。')
  const config = createDefaultEnviroWeatherConfig()
  const mode = String(raw.mode ?? raw.weatherType ?? '')
  const modes: Record<string, string> = { clear: 'clear', cloudy: 'cloudy', fog: 'foggy', foggy: 'foggy', rain: 'rain', snow: 'snow', night: 'clear' }
  if (modes[mode]) config.presetId = modes[mode]
  if (typeof raw.enabled === 'boolean') config.enabled = raw.enabled
  const sun = isWeatherRecord(raw.sun) ? raw.sun : {}
  config.time.mode = sun.timeMode === 'realtime' || sun.timeMode === 'system' ? 'system' : 'fixed'
  if (Number.isInteger(sun.utcOffsetHours) && Number(sun.utcOffsetHours) >= -13 && Number(sun.utcOffsetHours) <= 13)
    config.time.utcOffsetHours = Number(sun.utcOffsetHours)
  // ISO supplies one coherent local date/time; an explicit minute count takes precedence for time only.
  if (typeof sun.dateTimeIso === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/i.test(sun.dateTimeIso)) {
    const stamp = Date.parse(sun.dateTimeIso)
    if (Number.isFinite(stamp)) {
      const local = new Date(stamp + config.time.utcOffsetHours * 3600000)
      config.time.date = local.toISOString().slice(0, 10)
      config.time.minutesOfDay = local.getUTCHours() * 60 + local.getUTCMinutes()
    }
  }
  if (Number.isInteger(sun.timeOfDayMinutes) && Number(sun.timeOfDayMinutes) >= 0 && Number(sun.timeOfDayMinutes) < 1440)
    config.time.minutesOfDay = Number(sun.timeOfDayMinutes)
  if (mode === 'night') {
    config.time.mode = 'fixed'
    config.time.minutesOfDay = 0
  }
  const clouds = isWeatherRecord(raw.clouds) ? raw.clouds : {}
  if (typeof clouds.enabled === 'boolean') config.overrides.clouds.enabled = clouds.enabled
  if (typeof clouds.coverage === 'number' && clouds.coverage >= 0 && clouds.coverage <= 1)
    config.overrides.clouds.coveragePercent = clouds.coverage * 100
  if (typeof clouds.altitude === 'number' && clouds.altitude >= 100 && clouds.altitude <= 20000)
    config.overrides.clouds.baseHeightMeters = clouds.altitude
  const fog = isWeatherRecord(raw.fog) ? raw.fog : {}
  if (typeof fog.enabled === 'boolean') config.overrides.fog.enabled = fog.enabled
  // Cesium opacity/scattering/wind speed and light intensity do not share Enviro units.
  const quality = isWeatherRecord(raw.quality) ? raw.quality : {}
  config.quality.profile = quality.profile === 'editor-low' ? 'low' : quality.profile === 'showcase' ? 'high' : 'medium'
  config.migration = {
    from: isWeatherRecord(raw.sun) ? 'weather-v2' : 'legacy',
    omitted: ['旧阴影、散射、降水材质、雾密度、风速和绝对光强未转换；保留于 legacyBackup'],
    legacyBackup: clone(raw),
  }
  const issues = validateEnviroWeatherConfig(config)
  if (issues.length) throw new Error(issues.join('\n'))
  return config
}

export function getEditableEnviroWeatherConfig(scene: SceneDefinition): EnviroWeatherConfig {
  const raw = getPersistableWeatherConfig(scene)
  return Object.keys(raw).length ? migrateLegacyWeatherConfig(raw) : createDefaultEnviroWeatherConfig()
}

/** Unity editor environments are always enabled; normalize only at scene entry, never on panel mount. */
export function ensureEnabledEditorSceneWeather(scene: SceneDefinition): SceneDefinition {
  let config: EnviroWeatherConfig
  try { config = getEditableEnviroWeatherConfig(scene) }
  catch { return scene } // Opaque future provider data must remain intact and read-only.
  const raw = getPersistableWeatherConfig(scene)
  if (isSupportedEnviroWeatherConfig(raw) && raw.enabled) return scene
  return { ...scene, effects: [
    ...scene.effects.filter(effect => effect.type !== 'weather'),
    createEnviroWeatherEffect({ ...config, enabled: true }),
  ] }
}

/** Permission is checked at the write boundary, including callers outside the panel. */
export function updateEditorSceneWeather(options: {
  store: SceneStore
  execute: (command: SceneCommand) => unknown
  canEdit: () => boolean
  config: EnviroWeatherConfig
  gestureId?: string
}): void {
  if (!isEditorWeatherWriteAllowed() || !options.canEdit() || options.store.getScene().settings.readOnly === true) throw new Error('当前场景没有天气编辑权限。')
  const current = getPersistableWeatherConfig(options.store.getScene())
  if (hasWeatherProvider(current) && !isSupportedEnviroWeatherConfig(current))
    throw new Error('未知天气版本不能降级写入。')
  options.execute(createUpdateWeatherEffectCommand({
    effect: createEnviroWeatherEffect(options.config), mergeKey: options.gestureId,
  }))
}

/** Legacy backups and migration notes never cross the Unity boundary. */
export function getRuntimeEnviroWeatherConfig(scene: SceneDefinition): Omit<EnviroWeatherConfig, 'migration'> | null {
  const raw = getPersistableWeatherConfig(scene)
  if (!isSupportedEnviroWeatherConfig(raw)) return null
  const { migration: _migration, ...config } = clone(raw)
  return config
}
