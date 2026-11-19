import { DRAG_MODEL_ENUM } from '@/enums'
import {
  createCreateObjectCommand,
  mapEditorCreationToGisSceneObject,
  mapEditorCreationToSceneObject,
  type PickWorldPoint,
  type ScreenPoint,
  type SceneObject,
  type ViewportHost,
} from '@/scene-platform'
import { projectObjectForUnity } from '@/unity-runtime/runtime/projectSceneForUnity'
import type { EditorCreationModel } from './editorCreationRouter'
import { runConfirmedEditorCommand } from './editorSceneCommandTransaction'
import { appLogger } from '@/utils/logger'
import { createSnowflakeId } from '@/utils/snowflakeId'
import { beginEditorSceneOperation, editorSceneOperation } from './editorSceneOperationGate'
import { getActiveSceneViewportHost } from './editorScenePlatformHost'

/** 创建可作为父级的空业务节点，沿用 Unity 投影确认和撤销。 */
export async function createEditorUnityGroup(host: ViewportHost, isActive: () => boolean): Promise<string | null> {
  const store = host.getStore()
  if (getActiveSceneViewportHost() !== host || !isActive() || editorSceneOperation.value ||
    store.getScene().type !== 'local3d' || !host.getRuntime().id.startsWith('unity-')) return null
  const release = beginEditorSceneOperation('createObject')
  try {
    const id = createSnowflakeId()
    if (store.getObject(id) || store.getDeletedObjectIds().has(id)) throw new Error('分组编号重复，请重试')
    let order = 0
    for (const node of store.getObjects()) {
      if (!node.parentInstanceId && !node.layerId) order = Math.max(order, node.order + 1)
    }
    if (order > 2147483647) throw new Error('根节点顺序已达上限，无法创建分组')
    const group: SceneObject = {
      id, name: '新建分组', type: 'group', visible: true, locked: false, order,
      transform: { kind: 'local', position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 },
    }
    projectObjectForUnity(group, store.getScene().id)
    const applied = await runConfirmedEditorCommand(host, 'execute', createCreateObjectCommand(group), isActive,
      () => store.setSelectedObjectId(id))
    return applied && isActive() ? id : null
  } finally {
    release()
  }
}

/**
 * 将资源卡片接入统一命令历史和运行时桥接；调用方在等待期间持有场景操作门禁。
 * 不直接发送创建消息，避免绕过资源登记或重复实例化；现有双端运行时负责加载资源投影。
 */
export async function createEditorUnityObject(
  model: EditorCreationModel,
  point: { clientX: number; clientY: number },
  context: {
    host: ViewportHost
    isActive: () => boolean
    /** 把浏览器释放点换成舞台逻辑像素，禁止将窗口坐标直接当作相机坐标。 */
    toRuntimeScreenPoint?: (point: { clientX: number; clientY: number }) => ScreenPoint | null
  },
): Promise<string | null> {
  if (!context.isActive()) return null
  if (model.modelType !== DRAG_MODEL_ENUM.Model && model.modelType !== DRAG_MODEL_ENUM.CustomModel
    && model.modelType !== DRAG_MODEL_ENUM.Geometry) {
    throw new Error('当前渲染暂不支持拖入此类三维资源')
  }
  const { host } = context
  const store = host.getStore()
  const scene = store.getScene()
  const screenPoint = context.toRuntimeScreenPoint?.(point)
  let position: PickWorldPoint['position']
  if (screenPoint) {
    try {
      const picked = await host.getRuntime().pickWorldPosition(screenPoint)
      if (picked?.kind === (scene.type === 'gis' ? 'geo' : 'local') &&
        picked.position?.length === 3 && picked.position.every(Number.isFinite)) position = picked.position
    } catch (error) {
      // 普通场景应将定位错误告知用户。地理场景保留原有的默认落点行为。
      if (scene.type !== 'gis') throw error
      appLogger.warn('EditorUnityCreation', 'GIS 拖放落点读取失败，已回退到场景默认坐标', error)
    }
  }
  if (!context.isActive() || store.getScene().id !== scene.id) return null
  if (scene.type === 'local3d' && context.toRuntimeScreenPoint && !position) {
    throw new Error('释放位置没有可用的地面落点，请拖到画面中的地面后重试')
  }
  const resolvedPosition = position && { longitude: position[0], latitude: position[1], height: position[2] }
  const object = scene.type === 'gis'
    ? mapEditorCreationToGisSceneObject(model, {
        point, scene, resolvedPosition: resolvedPosition ?? null, useSceneDefaultPositionWhenUnresolved: true,
      })
    : mapEditorCreationToSceneObject(model, { point })
  if (!object) throw new Error('无法创建该三维资源')

  // 创建命令写入真实本地坐标，渲染、保存和重做共享同一落点。
  if (position && object.transform.kind === 'local') object.transform.position = position
  // 成功拾取时保留地表经纬高；回退场景原点时清除历史视觉偏移，保存值与默认海拔一致。
  if (!position && object.type === 'model' && object.transform.kind === 'geo' && scene.coordinateSystem.kind === 'wgs84') {
    object.transform.height = scene.coordinateSystem.defaultHeight
  }
  object.metadata = {
    ...object.metadata,
    unityDropMapping: position ? 'runtime-world-position' : 'scene-default',
  }
  if ((model.modelType === DRAG_MODEL_ENUM.Model || model.modelType === DRAG_MODEL_ENUM.CustomModel)
    && (!model.resourceAsset?.id?.trim() || !object.asset?.url)) {
    throw new Error('模型缺少稳定资源编号或加载地址，请刷新资源列表后重试')
  }
  // 在写入历史前复用正式协议投影校验，不支持的几何体不能产生空壳对象或撤销记录。
  projectObjectForUnity(object)
  const command = createCreateObjectCommand(object)
  const applied = await runConfirmedEditorCommand(host, 'execute', command, context.isActive,
    () => store.setSelectedObjectId(object.id))
  return applied && context.isActive() ? object.id : null
}
