import { DRAG_MODEL_ENUM } from '@/enums'
import {
  createCreateObjectCommand,
  mapEditorCreationToGisSceneObject,
  mapEditorCreationToSceneObject,
  type ScreenPoint,
  type ViewportHost,
} from '@/scene-platform'
import { projectObjectForUnity } from '@/unity-runtime/runtime/projectSceneForUnity'
import type { EditorCreationModel } from './editorCreationRouter'
import { runConfirmedEditorCommand } from './editorSceneCommandTransaction'
import { appLogger } from '@/utils/logger'

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
  let resolvedPosition: { longitude: number; latitude: number; height: number } | null = null
  if (scene.type === 'gis') {
    const screenPoint = context.toRuntimeScreenPoint?.(point)
    if (screenPoint) {
      try {
        const picked = await host.getRuntime().pickWorldPosition(screenPoint)
        const position = picked?.kind === 'geo' ? picked.position : undefined
        if (position && position.every(Number.isFinite)) {
          resolvedPosition = { longitude: position[0], latitude: position[1], height: position[2] }
        }
      } catch (error) {
        // Unity 未实现拾取能力或射线没有落点时，仍按场景默认坐标创建，不阻断整个拖拽入口。
        appLogger.warn('EditorUnityCreation', 'GIS 拖放落点读取失败，已回退到场景默认坐标', error)
      }
    }
  }
  const object = scene.type === 'gis'
    ? mapEditorCreationToGisSceneObject(model, {
        point, scene, resolvedPosition, useSceneDefaultPositionWhenUnresolved: true,
      })
    : mapEditorCreationToSceneObject(model, { point })
  if (!object) throw new Error('无法创建该三维资源')

  // 成功拾取时保留地表经纬高；回退场景原点时清除历史视觉偏移，保存值与默认海拔一致。
  if (!resolvedPosition && object.type === 'model' && object.transform.kind === 'geo' && scene.coordinateSystem.kind === 'wgs84') {
    object.transform.height = scene.coordinateSystem.defaultHeight
  }
  object.metadata = {
    ...object.metadata,
    unityDropMapping: resolvedPosition ? 'runtime-world-position' : 'scene-default',
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
