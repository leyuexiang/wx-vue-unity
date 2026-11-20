import type { SceneSettings, SceneType } from '@/scene-platform'
import type { UnityCameraConfig, UnityCameraState } from '../protocol/types'

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const number = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined
const tuple = (value: unknown): [number, number, number] | undefined =>
  Array.isArray(value) && value.length === 3 && value.every(item => number(item) !== undefined)
    ? [value[0], value[1], value[2]] : undefined
const readOrientation = (value: unknown): NonNullable<UnityCameraConfig['orientation']> => {
  const angles = record(value)
  return { heading: number(angles.heading), pitch: number(angles.pitch), roll: number(angles.roll) }
}

/** 把播放器读数转成现有四包相机格式。保留未知配置，剔除已被新姿态取代的旧目标点。 */
export function captureUnityCameraSettings(settings: SceneSettings, type: SceneType, state: UnityCameraState): SceneSettings {
  const gis = type === 'gis'
  const position = tuple(state.position)
  const { heading, pitch, roll } = readOrientation(state.orientation)
  if (!position || (gis && (Math.abs(position[0]) > 180 || Math.abs(position[1]) > 90)) ||
      heading === undefined || pitch === undefined || roll === undefined) {
    throw new Error('Unity 返回的相机位置或姿态无效，无法保存当前视角')
  }
  const { position: _position, destination: _destination, target: _target, near: _near, far: _far,
    ...previous } = record(settings.camera)
  return {
    ...settings,
    camera: {
      ...previous,
      kind: gis ? 'cesium' : 'three',
      ...(gis ? { destination: position } : { position }),
      orientation: { ...record(previous.orientation), heading, pitch, roll },
      fov: state.fov,
      // 地理相机的自动裁剪值随视角变化，省略裁剪面才能在重开后继续自动调整。
      ...(state.automaticClipping ? {} : { near: state.near, far: state.far }),
    },
  }
}

export function getUnityCameraConfig(settings: SceneSettings, type: SceneType): UnityCameraConfig {
  const camera = record(settings.camera)
  const kind = type === 'gis' ? 'cesium' : 'three'
  const rendering = record(settings.rendering)
  const aa = record(rendering.antialiasing)
  const config: UnityCameraConfig = {}
  if (camera.kind === kind) {
    config.position = tuple(type === 'gis' ? camera.destination : camera.position)
    if (type === 'gis' && config.position && (Math.abs(config.position[0]) > 180 || Math.abs(config.position[1]) > 90))
      delete config.position
    // 普通场景的历史配置可能只有目标点，新快照使用播放器回传的三轴姿态。
    if (type !== 'gis') config.target = tuple(camera.target)
    if (config.position && Object.keys(record(camera.orientation)).length) config.orientation = readOrientation(camera.orientation)
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
