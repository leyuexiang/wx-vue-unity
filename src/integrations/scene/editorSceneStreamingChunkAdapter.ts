import type {
  BoundingVolume,
  RuntimeStreamingOptions,
  SceneChunk,
  SceneDefinition,
  SceneObject,
  SceneStreamingConfig,
  SceneStore,
  StreamingGroup,
} from '@/scene-platform'
import {
  EDITOR_AUTO_STREAMING_CHUNK_TAG,
  EDITOR_AUTO_STREAMING_GROUP_ID,
  isEditorAutoStreamingChunk,
  pruneSceneStreamingChunkObjectReferences,
} from '@/scene-platform'

/** 保持原有模块导出，避免属性面板和测试调用方因常量迁移到核心层而改用内部路径。 */
export { EDITOR_AUTO_STREAMING_GROUP_ID }

/** 自动补齐区块时采用的稳定分组编号，避免每次打开场景生成不同 ID。 */
/**
 * 编辑器资源管理系统的默认策略。
 *
 * 新场景和缺失 streaming 字段的旧场景均默认进入资源托管；资源模型或本地基础几何体会生成区块，
 * 因此不会把影像、地形、原生三维瓦片或普通编辑元素误交给用户模型流式调度。
 */
export const DEFAULT_EDITOR_SCENE_STREAMING_OPTIONS: Required<RuntimeStreamingOptions> = {
  enabled: true,
  targetFps: 30,
  maxLoadingJobs: 4,
  maxLoadedChunks: 128,
  memoryBudgetMB: 512,
  unloadDelayMs: 3000,
  hysteresis: 0.15,
}

/**
 * 把缺少区块清单的已启用流式场景补齐为可调度的用户模型区块。
 *
 * 资源管理页只提供资产引用，旧场景迁移也可能只有 SceneObject 而没有 chunks/groups。
 * 这里用对象已保存的变换生成保守包围范围：本地场景使用球体，GIS 场景使用小地理区域。
 * 该函数只返回纯 JSON 数据，不读取或保存 Three/Cesium 运行时对象。
 */
export const ensureEditorSceneStreamingChunks = (scene: SceneDefinition): SceneDefinition => {
  /**
   * 缺失 streaming 只代表历史数据没有资源管理字段，编辑器打开或首次拖入资源时自动补齐默认配置。
   * 显式 enabled=false 仍是用户选择，必须保持关闭并且不生成任何区块。
   */
  const existingStreaming = scene.streaming
  const hasExplicitEnabled = typeof existingStreaming?.options?.enabled === 'boolean'
  const streaming: SceneStreamingConfig = hasExplicitEnabled
    ? (existingStreaming as SceneStreamingConfig)
    : {
        ...existingStreaming,
        chunks: existingStreaming?.chunks ?? [],
        groups: existingStreaming?.groups ?? [],
        options: {
          ...DEFAULT_EDITOR_SCENE_STREAMING_OPTIONS,
          ...(existingStreaming?.options ?? {}),
        },
      }
  /**
   * 删除场景对象后，历史自动区块可能仍引用旧编号；运行时区块索引会拒绝这类引用，
   * 导致重开或切换场景失败。核心层先按对象编号过滤失效引用；编辑器再丢弃跨场景区块，
   * 保持历史场景切换时的索引边界，不改变仍有效的手工空间范围。
   */
  const prunedStreaming = pruneSceneStreamingChunkObjectReferences({
    id: scene.id,
    objects: scene.objects,
    streaming,
  })
  /** ensure 已经构造了完整 streaming；兜底分支只用于类型收窄，不会在正常数据中触发。 */
  const baseStreaming: SceneStreamingConfig = prunedStreaming ?? streaming
  const validChunks = baseStreaming.chunks.filter((chunk) => chunk.sceneId === scene.id)
  const repairedStreaming: SceneStreamingConfig =
    validChunks.length !== baseStreaming.chunks.length
      ? { ...baseStreaming, chunks: validChunks }
      : baseStreaming
  const hasAddedDefaultConfig = repairedStreaming !== existingStreaming

  /** 显式关闭资源管理时仍保存修复后的索引，但不补齐自动区块。 */
  if (repairedStreaming?.options?.enabled === false) {
    return hasAddedDefaultConfig ? { ...scene, streaming: repairedStreaming } : scene
  }

  /**
   * 远端的失效引用修复与本地的基础几何流式范围同时生效：先基于修复后的区块索引判断归属，
   * 再只为尚未归属的模型或本地基础几何体补建自动区块，避免把已删除对象重新带回索引。
   */
  const streamableObjects = scene.objects.filter((object) =>
    isStreamableEditorObject(object, scene.type),
  )
  if (streamableObjects.length === 0) {
    return hasAddedDefaultConfig ? { ...scene, streaming: repairedStreaming } : scene
  }

  const assignedObjectIds = new Set(repairedStreaming.chunks.flatMap((chunk) => chunk.objectIds))
  const unassignedObjects = streamableObjects.filter((object) => !assignedObjectIds.has(object.id))
  if (unassignedObjects.length === 0) {
    return hasAddedDefaultConfig ? { ...scene, streaming: repairedStreaming } : scene
  }

  const existingGroup = repairedStreaming.groups.find(
    (group) => group.id === EDITOR_AUTO_STREAMING_GROUP_ID,
  )
  const group: StreamingGroup = existingGroup ?? {
    id: EDITOR_AUTO_STREAMING_GROUP_ID,
    mode: 'near-camera',
    preloadRadius: 500,
    visibleRadius: 400,
    unloadRadius: 700,
    priority: 100,
  }

  const chunks: SceneChunk[] = unassignedObjects.map((object) => ({
    id: `${scene.id}:auto-chunk:${object.id}`,
    sceneId: scene.id,
    bounds: createObjectChunkBounds(object),
    objectIds: [object.id],
    assetIds: object.asset?.id ? [object.asset.id] : [],
    streamingGroupId: group.id,
    priority: 100,
    tags: [EDITOR_AUTO_STREAMING_CHUNK_TAG],
  }))

  return {
    ...scene,
    streaming: {
      ...repairedStreaming,
      chunks: [...repairedStreaming.chunks, ...chunks],
      groups: existingGroup ? repairedStreaming.groups : [...repairedStreaming.groups, group],
    },
  }
}

/**
 * 编辑器内可进入平台流式调度的对象。
 *
 * 这里覆盖资源模型和本地三维场景基础几何体：前者沿用 GLB / GLTF 的资产索引，后者依赖对象
 * 自身的稳定 ID。GIS 基础几何体仍由 Cesium 常驻渲染，不进入该区块链路；图片、标注、图层和
 * 场景特效同样不纳入加载预算。
 */
const isStreamableEditorObject = (object: SceneObject, sceneType: SceneDefinition['type']): boolean =>
  (sceneType === 'local3d' && object.type === 'primitive') ||
  (object.type === 'model' && (object.asset?.kind === 'glb' || object.asset?.kind === 'gltf'))

/**
 * 判断两个可序列化包围体是否完全一致。
 *
 * 该判断只在对象变换提交、撤销或重做的低频边界执行，使用定长数值比较，避免序列化字符串和
 * 临时数组带来的内存分配；不同包围体类型直接视为变化。
 */
const isBoundingVolumeEqual = (left: BoundingVolume, right: BoundingVolume): boolean => {
  if (left.type !== right.type) return false

  if (left.type === 'sphere' && right.type === 'sphere') {
    return (
      left.center[0] === right.center[0] &&
      left.center[1] === right.center[1] &&
      left.center[2] === right.center[2] &&
      left.radius === right.radius
    )
  }

  if (left.type === 'aabb' && right.type === 'aabb') {
    return (
      left.min[0] === right.min[0] &&
      left.min[1] === right.min[1] &&
      left.min[2] === right.min[2] &&
      left.max[0] === right.max[0] &&
      left.max[1] === right.max[1] &&
      left.max[2] === right.max[2]
    )
  }

  if (left.type === 'region' && right.type === 'region') {
    return (
      left.west === right.west &&
      left.south === right.south &&
      left.east === right.east &&
      left.north === right.north &&
      left.minHeight === right.minHeight &&
      left.maxHeight === right.maxHeight
    )
  }

  return false
}

/**
 * 用模型最新持久化变换刷新其自动区块空间边界。
 *
 * 编辑器自动区块是一模型一区块，因此可以通过对象编号在一次区块遍历中精确更新，不扫描运行时
 * 场景树。手工区块、混合多对象区块和非资源模型全部保持原样，避免自动逻辑覆盖用户明确配置。
 */
export const updateEditorSceneStreamingChunkBounds = (
  scene: SceneDefinition,
  object: SceneObject,
): SceneDefinition => {
  const streaming = scene.streaming
  if (!streaming || !isStreamableEditorObject(object, scene.type)) return scene

  let hasChangedBounds = false
  const chunks = streaming.chunks.map((chunk) => {
    const isMatchingAutoChunk =
      chunk.objectIds.length === 1 &&
      chunk.objectIds[0] === object.id &&
      isEditorAutoStreamingChunk(chunk.id, chunk.tags, chunk.streamingGroupId)
    if (!isMatchingAutoChunk) return chunk

    const bounds = createObjectChunkBounds(object)
    if (isBoundingVolumeEqual(chunk.bounds, bounds)) return chunk

    hasChangedBounds = true
    return { ...chunk, bounds }
  })

  if (!hasChangedBounds) return scene
  return {
    ...scene,
    streaming: {
      ...streaming,
      chunks,
    },
  }
}

/**
 * 让自动区块持续跟随场景对象变换。
 *
 * 监听领域对象更新可以同时覆盖操纵器拖拽、属性面板输入、撤销和重做。只有空间边界确实变化时
 * 才替换 streaming 并发出一次事件；事件本身不会再次触发对象更新，因此不存在订阅递归。
 * 返回的停止函数必须在画布卸载时调用，防止旧场景状态仓库被页面闭包继续持有。
 */
export const bindEditorSceneStreamingChunksToObjectTransforms = (store: SceneStore): (() => void) =>
  store.subscribe((event) => {
    if (event.type !== 'objectUpserted') return

    const scene = store.getScene()
    const updatedScene = updateEditorSceneStreamingChunkBounds(scene, event.object)
    if (updatedScene === scene) return
    store.updateSceneStreaming(updatedScene.streaming, 'loadNormalization')
  })

/** 根据持久化变换构造保守包围范围，避免依赖尚未创建或已被卸载的引擎对象。 */
const createObjectChunkBounds = (object: SceneObject): BoundingVolume => {
  if (object.transform.kind === 'geo') {
    const { longitude, latitude, height } = object.transform
    return {
      type: 'region',
      west: longitude - 0.001,
      south: latitude - 0.001,
      east: longitude + 0.001,
      north: latitude + 0.001,
      minHeight: height - 100,
      maxHeight: height + 100,
    }
  }

  const [x, y, z] = object.transform.position
  const radius = resolveLocalChunkRadius(object)
  return {
    type: 'sphere',
    center: [x, y, z],
    radius,
  }
}

/** 优先使用资源预处理写入的包围半径；缺失时使用可控的保守默认值。 */
const resolveLocalChunkRadius = (object: SceneObject): number => {
  const metadata = object.metadata
  if (metadata && typeof metadata === 'object') {
    const value = (metadata as Record<string, unknown>).streamingRadius
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  }
  return 10
}
