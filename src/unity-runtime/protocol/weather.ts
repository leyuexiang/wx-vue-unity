import type { EnviroWeatherConfig } from '@/scene-platform/effects/weather'

export type RuntimeWeatherConfig = Omit<EnviroWeatherConfig, 'migration'>
export interface WeatherState {
  weatherRevision: number
  acceptedRevision: number
  targetState: RuntimeWeatherConfig | null
  effectiveQuality: string | null
  transitionState: 'released' | 'transitioning' | 'settled' | 'failed'
  warnings: string[]
  resolved?: Record<string, number | boolean>
  currentTime?: string
}
export interface WeatherDescription {
  provider: 'enviro3'
  schemaVersions: number[]
  readiness: { ready: boolean; reason?: string; modules: Record<string, boolean> }
  presets: Array<{ id: string; displayName: string }>
  supportedControls: Record<string, boolean>
  parameterDescriptors: Record<string, { min: number; max: number; reason?: string }>
  qualityProfiles: string[]
  warnings: string[]
  state: WeatherState
}
