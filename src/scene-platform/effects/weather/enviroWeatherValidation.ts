import { ENVIRO_WEATHER_RANGES, type EnviroWeatherConfig } from './enviroWeatherTypes'

export function isWeatherRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** Every explicit provider is opaque to Weather V2, including future providers. */
export function hasWeatherProvider(value: unknown): boolean {
  return isWeatherRecord(value) && Object.prototype.hasOwnProperty.call(value, 'provider')
}

export function isSupportedEnviroWeatherConfig(value: unknown): value is EnviroWeatherConfig {
  return isWeatherRecord(value) && value.provider === 'enviro3' && value.schemaVersion === 1 &&
    validateEnviroWeatherConfig(value).length === 0
}

export function isGregorianWeatherDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number) as [number, number, number]
  if (year < 1 || month < 1 || month > 12 || day < 1) return false
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!
}

export function validateEnviroWeatherConfig(value: unknown, prefix = 'weather'): string[] {
  const issues: string[] = []
  if (!isWeatherRecord(value)) return [`${prefix} must be a plain object.`]
  const check = (valid: boolean, path: string) => { if (!valid) issues.push(`${prefix}.${path} is invalid.`) }
  check(value.provider === 'enviro3', 'provider')
  check(value.schemaVersion === 1, 'schemaVersion')
  check(typeof value.enabled === 'boolean', 'enabled')
  check(typeof value.presetId === 'string' && value.presetId.trim().length > 0 && value.presetId.length <= 128, 'presetId')
  const transition = isWeatherRecord(value.transition) ? value.transition : {}
  check(transition.mode === 'instant' || transition.mode === 'smooth', 'transition.mode')
  const time = isWeatherRecord(value.time) ? value.time : {}
  check(time.mode === 'fixed' || time.mode === 'system', 'time.mode')
  check(isGregorianWeatherDate(time.date), 'time.date')
  check(Number.isInteger(time.minutesOfDay) && Number(time.minutesOfDay) >= 0 && Number(time.minutesOfDay) <= 1439, 'time.minutesOfDay')
  // Installed Enviro 3.3.2 uses an integer offset. Fractional offsets are not advertised.
  check(Number.isInteger(time.utcOffsetHours) && Number(time.utcOffsetHours) >= -13 && Number(time.utcOffsetHours) <= 13, 'time.utcOffsetHours')
  const location = isWeatherRecord(value.location) ? value.location : {}
  check(location.source === 'scene' || location.source === 'custom', 'location.source')
  for (const [key, max] of [['latitude', 90], ['longitude', 180]] as const) {
    const number = location[key]
    check(number === null || (typeof number === 'number' && Number.isFinite(number) && Math.abs(number) <= max), `location.${key}`)
  }
  if (location.source === 'custom') check(location.latitude !== null && location.longitude !== null, 'location.coordinates')
  const overrides = isWeatherRecord(value.overrides) ? value.overrides : {}
  for (const group of ['clouds', 'fog', 'wind', 'lighting']) check(isWeatherRecord(overrides[group]), `overrides.${group}`)
  for (const [path, [min, max]] of Object.entries(ENVIRO_WEATHER_RANGES)) {
    const [group, key] = path.split('.') as [string, string]
    const record = isWeatherRecord(overrides[group]) ? overrides[group] : {}
    const number = record[key]
    check(number === null || (typeof number === 'number' && Number.isFinite(number) && number >= min && number <= max), `overrides.${path}`)
  }
  for (const group of ['clouds', 'fog']) {
    const record = isWeatherRecord(overrides[group]) ? overrides[group] : {}
    check(record.enabled === null || typeof record.enabled === 'boolean', `overrides.${group}.enabled`)
  }
  const quality = isWeatherRecord(value.quality) ? value.quality : {}
  check(quality.profile === 'low' || quality.profile === 'medium' || quality.profile === 'high', 'quality.profile')
  if (value.migration !== undefined) {
    const migration = isWeatherRecord(value.migration) ? value.migration : {}
    check(migration.from === 'weather-v2' || migration.from === 'legacy', 'migration.from')
    check(Array.isArray(migration.omitted) && migration.omitted.every(item => typeof item === 'string'), 'migration.omitted')
    check(isWeatherRecord(migration.legacyBackup) && JSON.stringify(migration.legacyBackup).length <= 32768, 'migration.legacyBackup')
  }
  return issues
}
