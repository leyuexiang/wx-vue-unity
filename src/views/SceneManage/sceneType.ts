import {
  createSceneDefinition,
  serializeSceneDefinition,
  type SceneType,
} from '@/scene-platform'

export type ProjectSceneType = 'CommScene' | 'GisScene'
export type SceneTypeFilterValue = ProjectSceneType | 'all'

export const DEFAULT_PROJECT_SCENE_TYPE: ProjectSceneType = 'CommScene'
export const SCENE_TYPE_ALL: SceneTypeFilterValue = 'all'
const DEFAULT_GIS_SCENE_LONGITUDE = 104.0668
const DEFAULT_GIS_SCENE_LATITUDE = 30.5728

export const SCENE_TYPE_OPTIONS: Array<{ label: string; value: ProjectSceneType }> = [
  { label: '普通三维场景', value: 'CommScene' },
  { label: '地理信息场景', value: 'GisScene' },
]

export const SCENE_TYPE_FILTER_OPTIONS: Array<{ label: string; value: SceneTypeFilterValue }> = [
  { label: '全部类型', value: SCENE_TYPE_ALL },
  ...SCENE_TYPE_OPTIONS,
]

const PROJECT_SCENE_TYPE_TO_DEFINITION_TYPE: Record<ProjectSceneType, SceneType> = {
  CommScene: 'local3d',
  GisScene: 'gis',
}

/** 新增和从模板创建弹窗共用同一组文案及接口值。 */
export const SCENE_CREATION_TYPE_OPTIONS: ReadonlyArray<{ label: string; value: SceneType }> = [
  { label: 'GIS场景', value: PROJECT_SCENE_TYPE_TO_DEFINITION_TYPE.GisScene },
  { label: '非GIS场景', value: PROJECT_SCENE_TYPE_TO_DEFINITION_TYPE.CommScene },
]
/** 从纯二维模板创建场景时使用与普通新增相同的默认类型。 */
export const DEFAULT_SCENE_CREATION_TYPE = PROJECT_SCENE_TYPE_TO_DEFINITION_TYPE[DEFAULT_PROJECT_SCENE_TYPE]

/** 把管理页既有的场景类型枚举转换为场景接口值。 */
export const toDefinitionSceneType = (type: ProjectSceneType): SceneType =>
  PROJECT_SCENE_TYPE_TO_DEFINITION_TYPE[type]

const SCENE_TYPE_LABEL_MAP = new Map<ProjectSceneType, string>(
  SCENE_TYPE_OPTIONS.map((item) => [item.value, item.label]),
)

/**
 * 列表卡片的角标与元信息区域空间固定为 294.4px 卡片规格，使用 Figma 的紧凑类型文案。
 * 该映射只影响展示，筛选项和接口枚举仍复用 SCENE_TYPE_OPTIONS 的完整业务名称和值。
 */
const PROJECT_SCENE_CARD_TYPE_LABEL_MAP: Record<ProjectSceneType, string> = {
  CommScene: '普通场景',
  GisScene: 'GIS场景',
}

export const isProjectSceneType = (value: unknown): value is ProjectSceneType =>
  value === 'CommScene' || value === 'GisScene'

/**
 * 把后端业务场景类型规范化为前端可识别枚举。
 * 存量接口可能返回空值或不同大小写文本，统一默认到普通三维场景，避免列表渲染中断。
 */
export const resolveProjectSceneType = (value: unknown): ProjectSceneType => {
  if (isProjectSceneType(value)) return value

  const sceneTypeText = `${value ?? ''}`.toLowerCase()
  return sceneTypeText.includes('gis') ? 'GisScene' : DEFAULT_PROJECT_SCENE_TYPE
}

export const getProjectSceneTypeLabel = (value: unknown): string =>
  SCENE_TYPE_LABEL_MAP.get(resolveProjectSceneType(value)) ?? '普通三维场景'

/** 返回场景卡片的紧凑类型文案，避免封面角标与元信息在固定宽度中截断。 */
export const getProjectSceneCardTypeLabel = (value: unknown): string =>
  PROJECT_SCENE_CARD_TYPE_LABEL_MAP[resolveProjectSceneType(value)]

export interface CreateDefaultProjectSceneConfigInfoOptions {
  sceneType: ProjectSceneType
  name: string
  sceneId?: string
}

/**
 * 为新建场景生成最小 SceneDefinition。
 *
 * 新建接口返回 id 前，sceneId 允许为空字符串；后端按接口调整文档负责落库时回填真实 id。
 * 编辑已有场景时不能调用该方法覆盖旧配置，否则会丢失已保存对象、图层和交互配置。
 */
export const createDefaultProjectSceneConfigInfo = ({
  sceneType,
  name,
  sceneId = '',
}: CreateDefaultProjectSceneConfigInfoOptions): string => {
  const definitionType = toDefinitionSceneType(sceneType)

  if (definitionType === 'gis') {
    return serializeSceneDefinition(
      createSceneDefinition({
        id: sceneId,
        name,
        type: definitionType,
        coordinateSystem: {
          kind: 'wgs84',
          terrainEnabled: false,
          defaultLongitude: DEFAULT_GIS_SCENE_LONGITUDE,
          defaultLatitude: DEFAULT_GIS_SCENE_LATITUDE,
          defaultHeight: 0,
        },
      }),
    )
  }

  return serializeSceneDefinition(
    createSceneDefinition({
      id: sceneId,
      name,
      type: definitionType,
      coordinateSystem: {
        kind: 'local',
        unit: 'meter',
        upAxis: 'Y',
        gridEnabled: true,
      },
    }),
  )
}
