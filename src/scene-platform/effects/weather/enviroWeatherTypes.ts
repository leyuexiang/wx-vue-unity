export interface EnviroWeatherConfig {
  provider: 'enviro3'
  schemaVersion: 1
  enabled: boolean
  presetId: string
  transition: { mode: 'instant' | 'smooth' }
  time: { mode: 'fixed' | 'system'; date: string; minutesOfDay: number; utcOffsetHours: number }
  location: { source: 'scene' | 'custom'; latitude: number | null; longitude: number | null }
  overrides: {
    clouds: { enabled: boolean | null; coveragePercent: number | null; baseHeightMeters: number | null }
    fog: { enabled: boolean | null; densityPercent: number | null; heightMeters: number | null }
    wind: { strengthPercent: number | null; directionDeg: number | null }
    lighting: { directMultiplier: number | null; ambientMultiplier: number | null }
  }
  quality: { profile: 'low' | 'medium' | 'high' }
  /** Persistence only. Strip before transport. Never silently truncate legacy data. */
  migration?: { from: 'weather-v2' | 'legacy'; omitted: string[]; legacyBackup: Record<string, unknown> }
}

/** Product limits pending P0 visual calibration; runtime descriptors may narrow them. */
export const ENVIRO_WEATHER_RANGES = {
  'clouds.coveragePercent': [0, 100], 'clouds.baseHeightMeters': [100, 20000],
  'fog.densityPercent': [0, 100], 'fog.heightMeters': [-1000, 10000],
  'wind.strengthPercent': [0, 100], 'wind.directionDeg': [0, 359],
  'lighting.directMultiplier': [0, 3], 'lighting.ambientMultiplier': [0, 3],
} as const
