import type { SceneSettings, SceneType } from '@/scene-platform'
import type { UnityCameraConfig } from '../protocol/types'

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const number = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined
const tuple = (value: unknown): [number, number, number] | undefined =>
  Array.isArray(value) && value.length === 3 && value.every(item => number(item) !== undefined)
    ? [value[0], value[1], value[2]] : undefined

export function getUnityCameraConfig(settings: SceneSettings, type: SceneType): UnityCameraConfig {
  const camera = record(settings.camera)
  const kind = type === 'gis' ? 'cesium' : 'three'
  const rendering = record(settings.rendering)
  const aa = record(rendering.antialiasing)
  const config: UnityCameraConfig = {}
  if (camera.kind === kind) {
    config.position = tuple(type === 'gis' ? camera.destination : camera.position)
    if (type === 'gis') {
      if (config.position && (Math.abs(config.position[0]) > 180 || Math.abs(config.position[1]) > 90))
        delete config.position
      const orientation = record(camera.orientation)
      if (config.position && Object.keys(orientation).length) config.orientation = {
        heading: number(orientation.heading), pitch: number(orientation.pitch), roll: number(orientation.roll),
      }
    } else {
      config.target = tuple(camera.target)
    }
    const fov = number(camera.fov), near = number(camera.near), far = number(camera.far)
    if (fov !== undefined && fov >= 1 && fov <= 179) config.fov = fov
    if (near !== undefined && near >= .01 && near <= 10000 && far !== undefined && Math.fround(far) > Math.fround(near) && far <= 1e9) {
      config.near = near
      config.far = far
    }
  }
  if (typeof aa.mode === 'string' && ['none', 'off', 'fxaa', 'smaa', 'msaa', 'ssaa'].includes(aa.mode)) {
    config.antialiasing = { mode: aa.mode, msaaSamples: number(aa.msaaSamples), supersampleScale: number(aa.supersampleScale) }
  } else if (typeof rendering.antialias === 'boolean') {
    config.antialiasing = { mode: rendering.antialias ? 'msaa' : 'none' }
  }
  return config
}
