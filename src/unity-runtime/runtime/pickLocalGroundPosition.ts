import type { PickWorldPoint, ScreenPoint } from '@/scene-platform'
import type { UnityCameraState } from '../protocol/types'

type FrameSize = { width: number; height: number }

/** 将普通场景的透视相机视线与起始场景的零高度地面相交。 */
export function pickLocalGroundPosition(
  point: ScreenPoint,
  viewport: FrameSize,
  frame: FrameSize,
  camera: UnityCameraState,
): PickWorldPoint | null {
  const { position, orientation, fov, near, far } = camera
  if (!Array.isArray(position) || position.length !== 3 || !position.every(Number.isFinite) ||
    !orientation || ![orientation.heading, orientation.pitch, orientation.roll, fov, near, far].every(Number.isFinite) ||
    fov <= 0 || fov >= 180) return null

  // 输入点是舞台逻辑像素。云端如按比例显示视频，调用方已扣除留白，画面宽高比仍取原始帧。
  const u = 2 * point.x / viewport.width - 1
  const v = 1 - 2 * point.y / viewport.height
  if (!(Math.abs(u) <= 1 && Math.abs(v) <= 1) || frame.width <= 0 || frame.height <= 0) return null
  const halfHeight = Math.tan(fov * Math.PI / 360)
  const x = u * halfHeight * frame.width / frame.height
  const y = v * halfHeight

  // 相机接口的俯仰和横滚与引擎欧拉角反号。按引擎的 Z、X、Y 顺序旋转视线，前向分量取 1。
  const roll = -orientation.roll
  const pitch = -orientation.pitch
  const rollX = Math.cos(roll) * x - Math.sin(roll) * y
  const rollY = Math.sin(roll) * x + Math.cos(roll) * y
  const worldY = Math.cos(pitch) * rollY - Math.sin(pitch)
  const pitchZ = Math.sin(pitch) * rollY + Math.cos(pitch)
  if (Math.abs(worldY) < 1e-8) return null

  // 视线没有归一化，求出的系数正是相机前向深度，可直接和近、远裁剪面比较。
  const depth = -position[1] / worldY
  if (!Number.isFinite(depth) || depth < near || depth > far) return null
  const headingCos = Math.cos(orientation.heading)
  const headingSin = Math.sin(orientation.heading)
  const worldX = headingCos * rollX + headingSin * pitchZ
  const worldZ = headingCos * pitchZ - headingSin * rollX
  const hitX = position[0] + depth * worldX
  const hitZ = position[2] + depth * worldZ
  if (!Number.isFinite(hitX) || !Number.isFinite(hitZ)) return null
  return { kind: 'local', position: [hitX, 0, hitZ], source: 'raycaster' }
}
