import type { SceneStreamingConfig } from '@/scene-platform/core/types'

export type SceneType = 'local3d' | 'gis'
export type SceneObjectType = 'model' | 'image' | 'primitive' | 'light' | 'camera' | 'group'

export interface SceneTransform {
  /** wgs84: position is [longitude degrees, latitude degrees, ellipsoid height metres]; rotation is ENU. */
  space: 'local' | 'wgs84'
  position: [number, number, number]
  rotation: {
    kind: 'quaternion'
    value: [number, number, number, number]
  }
  scale: [number, number, number]
}

export interface UnityGeospatialScene {
  origin: [number, number, number]
  terrainEnabled: boolean
  layers: Array<{
    id: string
    name: string
    type: 'imagery' | 'terrain' | 'tileset' | 'vector'
    provider?: string
    url?: string
    visible: boolean
    opacity?: number
    order: number
    options?: Record<string, unknown>
  }>
}

export interface SceneObject {
  instanceId: string
  objectType: SceneObjectType
  name: string
  parentInstanceId?: string
  /** 由领域order投影，旧协议缺失时按稳定编号排序。 */
  siblingOrder?: number
  visible: boolean
  locked: boolean
  transform: SceneTransform
  resourceRefKeys: string[]
  properties: Record<string, unknown>
}

export interface SceneResource {
  resourceKey: string
  assetId: string
  kind: string
  contentHash?: string
  delivery?: {
    type: 'assetBundle' | 'addressables'
    bundleKey?: string
    assetName: string
  }
}

export interface SceneDefinition {
  schemaVersion: 1
  id: string
  name: string
  type: SceneType
  revisionNo: number
  objects: SceneObject[]
  resources: SceneResource[]
  settings: Record<string, unknown>
  geospatial?: UnityGeospatialScene
  /** 只转交场景既有流式定义，不在Unity协议层另存一份可编辑策略。 */
  streaming?: SceneStreamingConfig
  twoD: {
    canvas: Record<string, unknown>
    components: unknown[]
    layerTree: unknown[]
  }
  dependencies: {
    dataBindings: unknown[]
    behaviors: unknown[]
    deviceBindings: unknown[]
  }
}

export const createDefaultTransform = (): SceneTransform => ({
  space: 'local',
  position: [0, 0, 0],
  rotation: { kind: 'quaternion', value: [0, 0, 0, 1] },
  scale: [1, 1, 1],
})

export const createEmptyScene = (id = 'local-draft'): SceneDefinition => ({
  schemaVersion: 1,
  id,
  name: 'Unity 云渲染场景',
  type: 'local3d',
  revisionNo: 0,
  objects: [],
  resources: [],
  settings: {},
  twoD: { canvas: {}, components: [], layerTree: [] },
  dependencies: { dataBindings: [], behaviors: [], deviceBindings: [] },
})
