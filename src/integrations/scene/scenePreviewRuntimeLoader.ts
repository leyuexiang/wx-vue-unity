import {
  MemorySceneRuntime,
  createSceneStore,
  resolveSceneStreamingConfigForRuntime,
  type SceneDefinition,
  type SceneRepository,
  type SceneRuntime,
  type SceneStore,
} from '@/scene-platform'
import type { RenderSceneApiLike, ThreeRuntimeOptions } from '@/types/legacyRuntimePort'
import { INTERACTIVE_EVENT_ENUM } from '@/enums/scenePanelEnum'
import { evaluateConditionBlock } from '@/utils/renderScene/conditionRuntime'
import type renderScene from '@/utils/renderScene'
import { createEditorSceneInteractionActionRuntimePort } from './editorSceneInteractionActionRuntime'
import { getLegacyRenderSceneApiFromRuntime } from './editorLegacyRenderSceneAccess'
import { loadEditorSceneDefinition } from './editorSceneLoadAdapter'
import { readImportedVegetationAddress } from './importVegetationPublication'
import { applyEditorSceneCameraToRuntime } from './editorSceneSettingsAdapter'
import { readSceneGlobalStateFromDefinition } from './editorSceneGlobalStateAdapter'
import { SceneDataPollingRuntime } from './widgetRuntime'
import {
  collectScenePackageResourceReferences,
  resolvePublishedVegetationAssetUrls,
  resolvePublishedSceneAssetUrls,
} from './sceneAssetUrlResolver'
import {
  appendEditorWidgetSceneFragment,
  applyEditorWidgetSceneFragment,
  mergeEditorWidgetSceneFragmentSnapshot,
  resolveEditorWidgetSceneFragment,
  type EditorWidgetSceneFragmentApplier,
} from './editorSceneWidgetSnapshotAdapter'
import type { WidgetSceneFragment } from './widgetRuntime/widgetSceneFragment'
import type { WidgetLayerNode } from '@/types/threeScene'
import { collectWidgetGroupWidgetIds } from '@/utils/widgetLayer'
import {
  assembleSceneDefinitionFromRuntimeFragments,
  type SceneRuntimePublishedFragment,
} from './sceneRuntimeFragmentAssembler'
import {
  createSceneRuntimeFragmentLoader,
  type SceneRuntimeFragmentLoader,
} from './sceneRuntimeFragmentLoader'

export type ScenePreviewRuntimeLoadSource = 'scene-definition' | 'empty'

/**
 * 旧 Three 预览模块只在当前项目集成层可见，不扩展平台层 RenderSceneApiLike 契约。
 * 这样未来迁移宿主或移除旧 renderScene 时，SceneRuntime 接口不会反向依赖编辑器数据调度细节。
 */
type LegacyPreviewDataPollingApi = RenderSceneApiLike & {
  scenePreviewModules?: {
    setRequestContext: (context: {
      getPublicRequests: () => ReturnType<
        typeof readSceneGlobalStateFromDefinition
      >['publicRequests']
      getRequestGlobalConfig: () => ReturnType<
        typeof readSceneGlobalStateFromDefinition
      >['requestGlobalConfig']
      getRuntimeContext?: () => { sceneId?: string | null }
    }) => void
    setDataPollingManagedExternally: (managed: boolean) => void
  }
}

export interface ScenePreviewRuntimeLoaderOptions {
  /** 预览页真实承载 Runtime 的 DOM 容器。 */
  container: HTMLElement
  /** 项目场景 id，用于从项目接口加载 SceneDefinition。 */
  sceneId: string
  /** 测试或特殊来源可注入仓库；默认复用项目接口仓库。 */
  repository?: Pick<SceneRepository, 'load'>
  /**
   * 旧 renderScene 的 CSS 选择器。
   * 仅 local3d 过渡 Runtime 会消费，GIS Runtime 会忽略该配置。
   */
  renderSelector?: string
  /**
   * 旧 renderScene 仍需要的最小 Store 桥接。
   * 这里不传入编辑态 Store 实例，只传函数级桥接，防止预览链路拥有编辑态数据真源。
   */
  renderSceneStoreBridge?: ThreeRuntimeOptions['storeBridge'] | null
  /**
   * 旧 renderScene 创建工厂。
   * 预览页传入真实工厂，单测传入假 Runtime，避免加载真实 WebGL。
   */
  renderSceneFactory?: ThreeRuntimeOptions['renderSceneFactory']
  /**
   * Runtime 创建工厂。
   * 默认按 SceneDefinition.type 创建 Three/Cesium Runtime；测试可注入假 Runtime 验证加载顺序。
   */
  runtimeFactory?: (scene: SceneDefinition) => SceneRuntime
  /**
   * 二维片段应用器。
   * 默认写回现有 widget 仓库，测试可注入桩函数观察是否恢复。
   */
  applyWidgetFragment?: EditorWidgetSceneFragmentApplier
  /** 发布预览首次显示隐藏组件时使用的增量应用器；默认只向现有二维仓库追加目标。 */
  appendWidgetFragment?: EditorWidgetSceneFragmentApplier
  /** 发布运行态编号；传入后只读取三个完整发布包和按需实例依赖，不再读取编辑草稿。 */
  publicationId?: string
  /** 测试或宿主可注入分片协调器；生产环境使用真实发布接口。 */
  fragmentLoaderFactory?: (publicationId: string) => SceneRuntimeFragmentLoader
}

export interface ScenePreviewRuntimeLoadResult {
  scene: SceneDefinition | null
  runtime: SceneRuntime | null
  runtimeType: SceneRuntime['type'] | null
  renderSceneApi: RenderSceneApiLike | null
  loadedBy: ScenePreviewRuntimeLoadSource
}

type ScenePreviewRuntimeFragments = {
  manifest: SceneRuntimePublishedFragment
  threeDFragments: readonly SceneRuntimePublishedFragment[]
  twoDFragments: readonly SceneRuntimePublishedFragment[]
}

export interface ScenePreviewRuntimeController {
  load: () => Promise<ScenePreviewRuntimeLoadResult>
  /** 从当前页面内存分片缓存首次创建隐藏组件；刷新或卸载后该缓存立即失效。 */
  activateWidgets: (widgetIds: readonly string[]) => Promise<void>
  /** 按完整二维图层树解析分组成员，并在切换分组前批量创建其运行时实例。 */
  activateWidgetGroups: (groupIds: readonly string[]) => Promise<void>
  /** 首次点击发布态三维对象时补齐其事件、数据和资源依赖，并返回当前对象快照。 */
  activateSceneObject: (objectId: string) => Promise<SceneDefinition['objects'][number] | null>
  /** 交互/状态动作等待目标三维实例及首次数据就绪；已准备目标同步复用。 */
  prepareSceneObjects: (objectIds: readonly string[]) => void | Promise<void>
  dispose: () => void
}

const createEmptyPreviewRuntimeLoadResult = (): ScenePreviewRuntimeLoadResult => ({
  scene: null,
  runtime: null,
  runtimeType: null,
  renderSceneApi: null,
  loadedBy: 'empty',
})

const createDefaultPreviewRuntime = (
  scene: SceneDefinition,
  options: ScenePreviewRuntimeLoaderOptions,
) => new MemorySceneRuntime(scene.type)


const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value))

/**
 * 发布预览只应恢复真正参与生成的植被。
 *
 * 编辑器首次拖入模型时可能会把没有任何启用规则的植被编制草稿一并保存到三维包；这类草稿没有
 * 运行时产物，且公开发布包不会为它提供模型地址。保留它会在统一 SceneDefinition 校验阶段被当成
 * 正式植被，最终以“speciesCatalog.modelAsset.url 缺失”阻断整页预览。编辑态仍保留原草稿，这里只
 * 在公开预览的内存快照中剔除无效植被字段。
 */
const stripUnpublishedVegetationDraft = (content: unknown): unknown => {
  if (!isRecord(content) || !isRecord(content.vegetation)) return content

  const vegetation = content.vegetation
  const hasEnabledRule =
    Array.isArray(vegetation.rules) &&
    vegetation.rules.some((rule) => isRecord(rule) && rule.enabled === true)
  const hasImportedTiles = Array.isArray(vegetation.layers) && vegetation.layers.some((layer) =>
    isRecord(layer) && isRecord(layer.tilesetAsset) && isRecord(layer.tilesetAsset.metadata) &&
    readImportedVegetationAddress(layer.tilesetAsset.metadata.publicVegetationSource),
  )
  if (vegetation.enabled === true && (hasEnabledRule || hasImportedTiles || isRecord(vegetation.publication))) return content

  const { vegetation: _unusedVegetation, ...withoutVegetation } = content
  return withoutVegetation
}

/** 读取可用于运行时加载的资源地址；发布快照中的稳定编号本身不能替代地址。 */
const hasRuntimeAssetUrl = (
  value: unknown,
  resolvedAssetUrls: Readonly<Record<string, string>> = {},
): boolean => {
  if (!isRecord(value)) return false
  const stableId = readVegetationAssetId(value, '')
  if (stableId && typeof resolvedAssetUrls[stableId] === 'string') return true
  return ['url', 'address', 'resourceUrl', 'contentUrl', 'path'].some(
    (key) => typeof value[key] === 'string' && value[key].trim().length > 0,
  )
}

/** 提取植被资产的稳定编号，仅用于向用户定位公开预览缺失的资源描述。 */
const readVegetationAssetId = (value: unknown, fallback: string): string => {
  if (!isRecord(value)) return fallback
  for (const key of ['id', 'resourceKey', 'assetId']) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  return fallback
}

/**
 * 公开预览只读取发布四包和票据保护的运行态接口，不能调用编辑态植被历史或资源中心接口补地址。
 * 当前三维包会主动移除 URL，而现有预览依赖接口只接受普通实例编号，未返回植被聚合资源的地址。
 * 因此在领域校验前把这类缺口转换为明确提示，避免用户看到无法定位的通用定义校验错误。
 */
const assertPublishedVegetationPreviewResources = (
  threeDContent: unknown,
  resolvedAssetUrls: Readonly<Record<string, string>> = {},
): void => {
  const threeD = isRecord(threeDContent) ? threeDContent : undefined
  const vegetation = threeD && isRecord(threeD.vegetation) ? threeD.vegetation : undefined
  /** 没有稳定发布引用的旧草稿由后续领域校验处理；这里只诊断已发布植被的公开恢复缺口。 */
  if (!vegetation || !isRecord(vegetation.publication)) return

  const missingAssets: string[] = []
  const appendIfMissing = (asset: unknown, fallback: string) => {
    if (!hasRuntimeAssetUrl(asset, resolvedAssetUrls)) {
      missingAssets.push(readVegetationAssetId(asset, fallback))
    }
  }

  appendIfMissing(vegetation.publication.manifestAsset, '发布清单')
  appendIfMissing(vegetation.publication.tilesetAsset, '发布根瓦片')
  ;(Array.isArray(vegetation.layers) ? vegetation.layers : []).forEach((layer, index) => {
    if (!isRecord(layer)) return
    const layerLabel =
      typeof layer.id === 'string' && layer.id.trim() ? layer.id.trim() : `图层${index + 1}`
    appendIfMissing(layer.manifestAsset, `${layerLabel}:清单`)
    appendIfMissing(layer.tilesetAsset, `${layerLabel}:根瓦片`)
    const densityAssets = isRecord(layer.densityTilesetAssets)
      ? layer.densityTilesetAssets
      : undefined
    for (const preset of ['high', 'balanced', 'performance']) {
      if (densityAssets?.[preset] !== undefined) {
        appendIfMissing(densityAssets[preset], `${layerLabel}:${preset}`)
      }
    }
  })
  ;(Array.isArray(vegetation.speciesCatalog) ? vegetation.speciesCatalog : []).forEach(
    (species, index) => {
      if (!isRecord(species)) return
      appendIfMissing(species.modelAsset, `物种${index + 1}:模型`)
    },
  )

  if (!missingAssets.length) return
  const summary = [...new Set(missingAssets)].slice(0, 5).join('、')
  const suffix = missingAssets.length > 5 ? '等' : ''
  throw new Error(
    `公开预览缺少植被运行时资源地址（${summary}${suffix}）。当前预览接口未返回植被聚合资源的地址或签名，请后端在预览票据链路补充植被资源描述后重新发布场景。`,
  )
}

/** 读取二维组件自身的初始显隐，兼容完整 widget 快照和结构化分片回退两种形态。 */
const isWidgetInitiallyVisible = (widget: WidgetSceneFragment['widgets'][number]) => {
  const component = widget.component as unknown as Record<string, unknown>
  const option = isRecord(component.option) ? component.option : {}
  const ownVisible =
    option.visible ?? component.visible ?? (widget as unknown as Record<string, unknown>).visible
  return ownVisible !== false
}

/**
 * 计算初始有效显示组件。
 * 分组显隐、组件自身显隐和组件父子层级显隐都取交集；父级隐藏时，子级即使自身为显示状态，
 * 也不能在发布预览首屏创建实例。父链结果使用记忆化缓存，避免每个组件重复遍历相同祖先。
 */
const collectInitiallyVisibleWidgetIds = (fragment: WidgetSceneFragment): string[] => {
  const hiddenByGroup = new Set<string>()
  fragment.widgetLayerTree.forEach((node) => {
    if (node.type !== 'group' || node.visible !== false) return
    collectWidgetGroupWidgetIds(fragment.widgetLayerTree, node.id).forEach((widgetId) =>
      hiddenByGroup.add(widgetId),
    )
  })

  const widgetById = new Map(fragment.widgets.map((widget) => [widget.id, widget]))
  const parentVisibilityCache = new Map<string, boolean>()
  const resolvingIds = new Set<string>()

  const isWidgetVisibleThroughParents = (widgetId: string): boolean => {
    const cached = parentVisibilityCache.get(widgetId)
    if (cached !== undefined) return cached

    // 异常循环关系不能阻塞发布预览；循环节点按当前节点自身状态继续计算。
    if (resolvingIds.has(widgetId)) return true
    resolvingIds.add(widgetId)

    const widget = widgetById.get(widgetId)
    const parentId = widget?.parentId
    const parent = parentId ? widgetById.get(parentId) : undefined
    const parentOwnVisible = parent ? isWidgetInitiallyVisible(parent) : true
    const visible =
      !parentId || !parent || (parentOwnVisible && isWidgetVisibleThroughParents(parentId))

    resolvingIds.delete(widgetId)
    parentVisibilityCache.set(widgetId, visible)
    return visible
  }

  return fragment.widgets
    .filter(
      (widget) =>
        widget.id &&
        !hiddenByGroup.has(widget.id) &&
        isWidgetInitiallyVisible(widget) &&
        isWidgetVisibleThroughParents(widget.id),
    )
    .map((widget) => widget.id)
}

/** 保留当前已创建组件对应的结构节点；完整结构树仍由页面内存缓存持有。 */
const filterWidgetLayerTree = (
  tree: readonly WidgetLayerNode[],
  widgetIds: ReadonlySet<string>,
): WidgetLayerNode[] => {
  const retainedGroupIds = new Set(
    tree
      .filter((node) => node.type === 'group')
      .filter((group) =>
        collectWidgetGroupWidgetIds([...tree], group.id).some((widgetId) =>
          widgetIds.has(widgetId),
        ),
      )
      .map((group) => group.id),
  )
  const filtered: WidgetLayerNode[] = []
  tree.forEach((node) => {
    if (node.type === 'widget') {
      if (widgetIds.has(node.id)) filtered.push(node)
      return
    }
    if (!retainedGroupIds.has(node.id)) return
    const children = node.children.filter((widgetId) => widgetIds.has(widgetId))
    const childGroupIds = (node.childGroupIds || []).filter((groupId) =>
      retainedGroupIds.has(groupId),
    )
    const filteredGroup = { ...node, children }
    if (childGroupIds.length) filteredGroup.childGroupIds = childGroupIds
    else delete filteredGroup.childGroupIds
    filtered.push(filteredGroup)
  })
  return filtered
}

/** 从全量内存配置中挑出当前允许创建实例的二维组件。 */
const selectWidgetFragment = (
  fragment: WidgetSceneFragment,
  widgetIds: readonly string[],
): WidgetSceneFragment => {
  const selectedIds = new Set(widgetIds)
  return {
    widgets: fragment.widgets.filter((widget) => selectedIds.has(widget.id)),
    widgetLayerTree: filterWidgetLayerTree(fragment.widgetLayerTree, selectedIds),
    widgetCanvas: fragment.widgetCanvas,
  }
}

/**
 * 从直接激活的二维部件开始递归收集默认可见的子部件。
 *
 * 直接命中的外层部件无论自身默认显隐如何都必须先创建；从第二层开始严格检查默认显隐，
 * 一旦某个子部件默认关闭就停止该分支，避免只创建了弹窗容器却遗漏其可见内容，或把关闭
 * 子树中的孙节点错误地提前实例化。该索引一次建立父子关系，避免每个节点反复扫描全量组件。
 */
const collectEnabledWidgetIdsFromRoots = (
  fragment: WidgetSceneFragment,
  rootWidgetIds: readonly string[],
  shouldActivateRoot: (widget: WidgetSceneFragment['widgets'][number]) => boolean,
): string[] => {
  const widgetById = new Map(fragment.widgets.map((widget) => [widget.id, widget]))
  const childWidgetIdsByParentId = new Map<string, string[]>()
  fragment.widgets.forEach((widget) => {
    if (!widget.parentId) return
    const childIds = childWidgetIdsByParentId.get(widget.parentId) ?? []
    childIds.push(widget.id)
    childWidgetIdsByParentId.set(widget.parentId, childIds)
  })

  const visitedWidgetIds = new Set<string>()
  const enabledWidgetIds = new Set<string>()
  const visitWidget = (widgetId: string, isActivatedRoot: boolean) => {
    if (visitedWidgetIds.has(widgetId)) return
    const widget = widgetById.get(widgetId)
    if (!widget) return

    /** 直接动作目标由动作本身显式激活；其子节点必须遵守各自默认显隐。 */
    if (isActivatedRoot ? !shouldActivateRoot(widget) : !isWidgetInitiallyVisible(widget)) return

    visitedWidgetIds.add(widgetId)
    enabledWidgetIds.add(widgetId)
    ;(childWidgetIdsByParentId.get(widgetId) || []).forEach((childWidgetId) =>
      visitWidget(childWidgetId, false),
    )
  }

  new Set(rootWidgetIds.filter((widgetId) => widgetId && widgetId.trim())).forEach((widgetId) =>
    visitWidget(widgetId, true),
  )
  return [...enabledWidgetIds]
}

/**
 * 从完整发布图层树递归解析分组激活目标。
 *
 * 被事件直接点名的外层分组会被显式切换为启用，因此忽略它自身的默认 visible；其下的子分组
 * 和组件仍严格遵守各自默认状态：禁用子分组及默认隐藏组件不进入本次依赖批次，避免把尚未真正
 * 显示的内容提前实例化。索引和访问集合均按一次遍历建立，保证大型二维画布切页不会反复扫描树。
 */
const collectEnabledWidgetIdsInGroups = (
  fragment: WidgetSceneFragment,
  groupIds: readonly string[],
): string[] => {
  const groupById = new Map(
    fragment.widgetLayerTree
      .filter((node): node is Extract<WidgetLayerNode, { type: 'group' }> => node.type === 'group')
      .map((group) => [group.id, group] as const),
  )
  const widgetById = new Map(fragment.widgets.map((widget) => [widget.id, widget]))
  const visitedGroupIds = new Set<string>()
  const groupWidgetRootIds = new Set<string>()
  const parentVisibilityCache = new Map<string, boolean>()
  const resolvingWidgetIds = new Set<string>()

  const isWidgetVisibleThroughParents = (widgetId: string): boolean => {
    const cached = parentVisibilityCache.get(widgetId)
    if (cached !== undefined) return cached
    /** 异常循环关系不应阻塞发布预览；循环节点按当前分支继续计算。 */
    if (resolvingWidgetIds.has(widgetId)) return true
    resolvingWidgetIds.add(widgetId)

    const widget = widgetById.get(widgetId)
    const parentId = widget?.parentId
    const parent = parentId ? widgetById.get(parentId) : undefined
    const visible =
      !parentId ||
      !parent ||
      (isWidgetInitiallyVisible(parent) && isWidgetVisibleThroughParents(parentId))

    resolvingWidgetIds.delete(widgetId)
    parentVisibilityCache.set(widgetId, visible)
    return visible
  }

  const visitGroup = (groupId: string, isActivatedRoot: boolean) => {
    if (visitedGroupIds.has(groupId)) return
    const group = groupById.get(groupId)
    if (!group || (!isActivatedRoot && group.visible === false)) return

    visitedGroupIds.add(groupId)
    group.children.forEach((widgetId) => groupWidgetRootIds.add(widgetId))
    ;(group.childGroupIds || []).forEach((childGroupId) => visitGroup(childGroupId, false))
  }

  new Set(groupIds.filter((groupId) => groupId && groupId.trim())).forEach((groupId) =>
    visitGroup(groupId, true),
  )

  /** 分组下的直接部件仍要检查自己的默认状态和父部件状态，再递归其可见子部件。 */
  return collectEnabledWidgetIdsFromRoots(
    fragment,
    [...groupWidgetRootIds],
    (widget) => isWidgetInitiallyVisible(widget) && isWidgetVisibleThroughParents(widget.id),
  )
}

/** 把筛选后的二维片段写回场景副本，不修改包含全量缓存的原始 SceneDefinition。 */
const withWidgetFragment = (scene: SceneDefinition, fragment: WidgetSceneFragment) =>
  mergeEditorWidgetSceneFragmentSnapshot(scene, fragment)

/**
 * 创建预览页运行态加载器。
 *
 * 该加载器只负责“SceneDefinition -> Runtime”：
 * - 不创建 ViewportHost；
 * - 不创建 SceneStore；
 * - 不创建 CommandBus 或 RuntimeBridge；
 * - 加载失败或仓库暂无内容时交由页面保留空运行时，避免重复请求或写入不完整数据。
 */
export const createScenePreviewRuntimeLoader = (
  options: ScenePreviewRuntimeLoaderOptions,
): ScenePreviewRuntimeController => {
  let runtime: SceneRuntime | null = null
  /** local3d 预览也需要独立的 SceneStore，供三维地图接管层和省级点击规则读取发布快照。 */
  let previewSceneStore: SceneStore | null = null
  let fragmentLoader: SceneRuntimeFragmentLoader | null = null
  let runtimeFragments: ScenePreviewRuntimeFragments | undefined
  let cachedWidgetFragment: WidgetSceneFragment | null = null
  /** 二维请求轮询不依赖旧 Three 实例，因此 GIS 与 local3d 发布场景共用同一控制器。 */
  let sceneDataPollingRuntime: SceneDataPollingRuntime | null = null
  /** 按需依赖已补全的三维对象只保存在当前发布会话，用于统一请求调度，不回写基础三包。 */
  const runtimeDataObjects = new Map<string, SceneDefinition['objects'][number]>()
  /** 首屏地图对象要参与数据轮询，但点击前仍需从行为分片补齐完整交互配置。 */
  const preloadedRuntimeObjectIds = new Set<string>()
  /** 发布依赖响应生成的地址索引只存在于当前预览控制器内存，释放页面时同步清空。 */
  let runtimeResolvedAssetUrls: Readonly<Record<string, string>> = {}
  /** 三个基础包中的资源引用只建立一次内存索引，按批补全地址时复用，避免反复扫描全场景。 */
  let runtimePackageResourceReferences: readonly Record<string, unknown>[] = []
  const mountedWidgetIds = new Set<string>()
  const widgetActivationInflight = new Map<string, Promise<void>>()
  /** 已请求过三维对象依赖的编号；事件重复点击时只复用当前发布会话缓存，不重复组装场景。 */
  const activatedSceneObjectIds = new Set<string>()
  const sceneObjectActivationInflight = new Map<
    string,
    Promise<SceneDefinition['objects'][number] | null>
  >()
  const preparedActionObjectIds = new Set<string>()
  const actionObjectInflight = new Map<string, Promise<void>>()
  const mountedObjectIds = new Set<string>()
  const objectMountWaiters = new Map<string, () => void>()
  let stopObjectLifecycle: (() => void) | undefined
  let disposed = false

  const dispose = () => {
    disposed = true
    stopObjectLifecycle?.()
    stopObjectLifecycle = undefined
    objectMountWaiters.forEach((resolve) => resolve())
    objectMountWaiters.clear()
    mountedObjectIds.clear()
    preparedActionObjectIds.clear()
    actionObjectInflight.clear()
    runtime?.setObjectActivationResolver?.(null)
    sceneDataPollingRuntime?.dispose()
    sceneDataPollingRuntime = null
    previewSceneStore = null
    runtime?.dispose()
    fragmentLoader?.dispose()
    fragmentLoader = null
    runtimeFragments = undefined
    cachedWidgetFragment = null
    runtimeResolvedAssetUrls = {}
    runtimePackageResourceReferences = []
    runtimeDataObjects.clear()
    preloadedRuntimeObjectIds.clear()
    mountedWidgetIds.clear()
    widgetActivationInflight.clear()
    activatedSceneObjectIds.clear()
    sceneObjectActivationInflight.clear()
    runtime = null
  }

  const toAssemblyFragment = (fragment: {
    publicationId?: string
    fragmentType?: string
    fragmentKey?: string
    contentJson?: string
    content?: unknown
    contentHash?: string
  }): SceneRuntimePublishedFragment => ({
    publicationId: fragment.publicationId,
    fragmentType: fragment.fragmentType,
    fragmentKey: fragment.fragmentKey,
    contentJson: fragment.contentJson ?? JSON.stringify(fragment.content ?? {}),
    contentHash: fragment.contentHash,
  })

  /** 将实例依赖片段中的资源数组合并为资源解析器可消费的最小依赖包。 */
  const collectRuntimeResources = (
    fragments: readonly { content?: unknown }[],
  ): { resources: unknown[] } => ({
    resources: fragments.flatMap((fragment) => {
      const content = isRecord(fragment.content) ? fragment.content : undefined
      return Array.isArray(content?.resources) ? content.resources : []
    }),
  })

  /**
   * 按本次真正激活的实例批量读取依赖并生成新的运行态场景快照。
   *
   * 地址只合并到当前控制器内存；基础三包和依赖片段始终重新交给统一组装器，因此 GIS、local3d
   * 与二维组件不会复制三套恢复逻辑。已加载实例由 fragmentLoader 缓存，重复激活不会再次请求。
   */
  const activateRuntimeTargets = async (targetIds: readonly string[]) => {
    if (disposed || !fragmentLoader || !runtimeFragments) return null
    const ids = [...new Set(targetIds.filter((id) => typeof id === 'string' && id.trim()))]
    if (!ids.length) {
      return {
        activated: { behaviors: [], resourceMetas: [] },
        scene: assembleSceneDefinitionFromRuntimeFragments({
          ...runtimeFragments,
          options: {
            sceneId: options.sceneId || undefined,
            resolvedAssetUrls: runtimeResolvedAssetUrls,
          },
        }),
      }
    }

    const activated = await fragmentLoader.activateTargets(ids)
    if (disposed || !runtimeFragments) return null
    const resolvedUrls = resolvePublishedSceneAssetUrls(
      collectRuntimeResources(activated.behaviors),
      activated.resourceMetas ?? [],
      {
        /** 历史发布包若遗漏 resources，允许从基础包的 resourceRefKeys 恢复同编号资源。 */
        additionalResources: runtimePackageResourceReferences,
        // 植被资源接口已提供物种模型地址，普通依赖接口缺少元数据时直接复用该地址。
        knownAssetUrls: runtimeResolvedAssetUrls,
      },
    )
    runtimeResolvedAssetUrls = { ...runtimeResolvedAssetUrls, ...resolvedUrls }
    const assembledScene = assembleSceneDefinitionFromRuntimeFragments({
      ...runtimeFragments,
      behaviorFragments: activated.behaviors.map(toAssemblyFragment),
      options: {
        sceneId: options.sceneId || undefined,
        resolvedAssetUrls: runtimeResolvedAssetUrls,
      },
    })
    ids.forEach((objectId) => {
      const object = assembledScene.objects.find((item) => item.id === objectId)
      if (object) {
        runtimeDataObjects.set(objectId, object)
        preloadedRuntimeObjectIds.delete(objectId)
      }
    })
    return {
      activated,
      scene: assembledScene,
    }
  }

  /**
   * 从当前页面内存缓存首次创建隐藏二维组件。
   * 同一批目标共享一个 Promise，连续动作不会重复请求实例依赖或重复安装 Vue 组件；页面刷新、
   * 离开或 controller.dispose 后缓存与请求代次均失效，下一次预览会从 resolve 重新开始。
   */
  const activateWidgets = async (widgetIds: readonly string[]) => {
    if (disposed || !fragmentLoader || !runtimeFragments || !cachedWidgetFragment) return
    const cachedIds = new Set(cachedWidgetFragment.widgets.map((widget) => widget.id))
    const uniqueIds = [...new Set(widgetIds.filter((id) => id && cachedIds.has(id)))]
    /** 直接部件动作与分组动作统一递归激活其默认可见子树。 */
    const activationIds = collectEnabledWidgetIdsFromRoots(
      cachedWidgetFragment,
      uniqueIds,
      () => true,
    )
    const missingIds = activationIds.filter(
      (id) => !mountedWidgetIds.has(id) && !widgetActivationInflight.has(id),
    )
    const running = activationIds
      .map((id) => widgetActivationInflight.get(id))
      .filter((task): task is Promise<void> => Boolean(task))

    if (missingIds.length) {
      const task = (async () => {
        const activation = await activateRuntimeTargets(missingIds)
        if (disposed || !activation || !cachedWidgetFragment) return
        const activationScene = activation.scene
        const activatedFragment = selectWidgetFragment(
          resolveEditorWidgetSceneFragment(activationScene),
          missingIds,
        )
        if (!activatedFragment.widgets.length) {
          throw new Error(`二维分片缓存中缺少待激活组件：${missingIds.join('、')}`)
        }
        /**
         * 增量安装只追加本批组件，但必须携带完整发布图层树。
         * 若只传本批裁剪树，下一次激活其它子分组时会覆盖已加载成员的父子关系；仓库会根据当前
         * 已安装组件再次裁剪这棵完整树，不会因此创建未激活的组件或提前发起依赖请求。
         */
        const appendFragment = {
          ...activatedFragment,
          widgetLayerTree: cachedWidgetFragment.widgetLayerTree,
        }
        await appendEditorWidgetSceneFragment(
          withWidgetFragment(activationScene, appendFragment),
          options.appendWidgetFragment,
        )
        if (disposed) return
        activatedFragment.widgets.forEach((widget) => mountedWidgetIds.add(widget.id))
        /** 新显示的隐藏组件可能携带新的动态请求；刷新任务索引后才允许其开始轮询。 */
        await sceneDataPollingRuntime?.start()
        // 翻页列表独立于普通轮询，激活完成也必须等待其首次列表，后续赋值才不会被默认初始化覆盖。
        await sceneDataPollingRuntime?.waitForTargets('widget', missingIds)
      })()
      missingIds.forEach((id) => widgetActivationInflight.set(id, task))
      void task
        .finally(() => missingIds.forEach((id) => widgetActivationInflight.delete(id)))
        .catch(() => undefined)
      running.push(task)
    }

    await Promise.all(running)
  }

  /**
   * 页面框架的切页动作只保存分组编号，不能把分组成员硬编码到事件配置中。
   * 首屏应用二维片段时，隐藏分组及其成员会被裁剪出 Pinia 仓库，但完整图层树仍保存在
   * `cachedWidgetFragment`；这里先从该不可变缓存解析所有后代部件，再复用同一个按实例去重的
   * 激活入口，确保行为、数据绑定、资源地址和组件实例在同一批次完成恢复。
   */
  const activateWidgetGroups = async (groupIds: readonly string[]) => {
    if (disposed || !cachedWidgetFragment) return

    const uniqueGroupIds = [...new Set(groupIds.filter((id) => id && id.trim()))]
    if (!uniqueGroupIds.length) return

    await activateWidgets(collectEnabledWidgetIdsInGroups(cachedWidgetFragment, uniqueGroupIds))
  }

  /**
   * 发布 GIS 画布点击不能依赖首次 loadScene 时的三维行为配置。
   * 三维对象的行为属于实例依赖，只有命中对象后才按对象编号补齐；请求和组装结果在当前会话内
   * 按编号复用，避免重复点击触发重复网络请求或重复解析完整发布包。
   */
  const activateSceneObject = async (objectId: string) => {
    const normalizedObjectId = objectId.trim()
    if (disposed || !normalizedObjectId || !fragmentLoader || !runtimeFragments) return null

    if (activatedSceneObjectIds.has(normalizedObjectId)) {
      return runtimeDataObjects.get(normalizedObjectId) ?? null
    }

    /**
     * local3d Runtime 可能已通过区块激活器补齐同一个对象；发布 GIS 点击再次命中时直接复用该快照，
     * 避免仅因为激活入口不同而重复读取实例依赖。对象未进入缓存时才继续走当前点击的按需请求。
     */
    const cachedObject = runtimeDataObjects.get(normalizedObjectId)
    if (cachedObject && !preloadedRuntimeObjectIds.has(normalizedObjectId)) {
      activatedSceneObjectIds.add(normalizedObjectId)
      return cachedObject
    }

    const existingTask = sceneObjectActivationInflight.get(normalizedObjectId)
    if (existingTask) return existingTask

    const task = (async () => {
      const activation = await activateRuntimeTargets([normalizedObjectId])
      if (disposed || !activation) return null
      const object = activation.scene.objects.find(({ id }) => id === normalizedObjectId) ?? null
      if (object) runtimeDataObjects.set(normalizedObjectId, object)
      activatedSceneObjectIds.add(normalizedObjectId)
      return object
    })()
    sceneObjectActivationInflight.set(normalizedObjectId, task)
    try {
      return await task
    } finally {
      sceneObjectActivationInflight.delete(normalizedObjectId)
    }
  }

  /**
   * 原生三维动作和旧兼容动作共用准备屏障。流式对象还未真实挂载时保留动作，
   * 由引擎挂载通知唤醒；每个编号仅持有一个等待者，不使用轮询或固定延迟猜测就绪时间。
   */
  const prepareSceneObjects = (objectIds: readonly string[]): void | Promise<void> => {
    if (disposed || !fragmentLoader || !runtime) return
    const pending: Promise<void>[] = []
    for (const id of new Set(objectIds.filter(Boolean))) {
      if (preparedActionObjectIds.has(id)) continue
      let task = actionObjectInflight.get(id)
      if (!task) {
        const currentRuntime = runtime
        task = (async () => {
          const object = await activateSceneObject(id)
          if (disposed || currentRuntime !== runtime) return
          if (!object) throw new Error(`动作目标不存在：${id}`)
          if (!currentRuntime.hasObject(id)) await currentRuntime.upsertObject(object)
          if (disposed) return
          await sceneDataPollingRuntime?.start()
          await sceneDataPollingRuntime?.waitForTargets('object', [id])
          if (disposed) return
          // 独立呈现器接管的特效无普通引擎映射；模型及常规三维组件等待真正的实例挂载。
          if (stopObjectLifecycle && object.type !== 'effect' && !mountedObjectIds.has(id)) {
            await new Promise<void>((resolve) => objectMountWaiters.set(id, resolve))
          }
          if (!disposed && currentRuntime === runtime) preparedActionObjectIds.add(id)
        })()
        actionObjectInflight.set(id, task)
        const currentTask = task
        void task
          .finally(() => {
            if (actionObjectInflight.get(id) === currentTask) actionObjectInflight.delete(id)
          })
          .catch(() => undefined)
      }
      pending.push(task)
    }
    if (pending.length) return Promise.all(pending).then(() => undefined)
  }

  const load = async (): Promise<ScenePreviewRuntimeLoadResult> => {
    if (disposed) {
      return createEmptyPreviewRuntimeLoadResult()
    }

    let result: Awaited<ReturnType<typeof loadEditorSceneDefinition>>
    if (options.publicationId?.trim()) {
      /** 发布态严格以 publicationId 为数据源；GIS 与 local3d 共用同一分片协议。 */
      fragmentLoader =
        options.fragmentLoaderFactory?.(options.publicationId.trim()) ??
        createSceneRuntimeFragmentLoader({ publicationId: options.publicationId.trim() })
      const initial = await fragmentLoader.loadInitial()
      /** 空植被编制草稿不属于公开运行态；先在内存中剔除，再执行资源诊断和领域校验。 */
      const publishedThreeDContent = stripUnpublishedVegetationDraft(initial.threeD.content)
      /**
       * 公开票据链路新增植被资源聚合接口后，先把发布入口和模型受控地址放入当前会话索引，
       * 再验证植被资源完整性。这样不会把地址缺失误报为 SceneDefinition 非法，也不会调用
       * 编辑态植被发布历史接口。
       */
      if (initial.vegetationResources && initial.vegetationResources.code !== 'OK') {
        throw new Error(
          initial.vegetationResources.message?.trim() ||
            `公开预览植被资源不可用：${initial.vegetationResources.code}`,
        )
      }
      runtimeResolvedAssetUrls = initial.vegetationResources
        ? {
            ...runtimeResolvedAssetUrls,
            ...resolvePublishedVegetationAssetUrls(
              publishedThreeDContent,
              initial.vegetationResources,
            ),
          }
        : runtimeResolvedAssetUrls
      assertPublishedVegetationPreviewResources(publishedThreeDContent, runtimeResolvedAssetUrls)
      /**
       * 三个完整职责包先合成为组装器的唯一入口记录。这里仅在内存中建立包装对象，
       * 不改变后端原文，也不重新生成任何发布数据；后续仍由统一组装器决定 GIS 或 local3d。
       */
      const initialAssembly = {
        manifest: toAssemblyFragment({
          publicationId: initial.sceneBasic.publicationId,
          fragmentType: 'manifest',
          fragmentKey: `${initial.sceneBasic.publicationId}:runtime-root`,
          content: {
            sceneJson: initial.sceneBasic.content,
            threeDJson: publishedThreeDContent,
            twoDJson: initial.twoD.content,
          },
        }),
        threeDFragments: [],
        twoDFragments: [],
      }
      runtimePackageResourceReferences = collectScenePackageResourceReferences(
        publishedThreeDContent,
        initial.twoD.content,
      )
      const scene = assembleSceneDefinitionFromRuntimeFragments({
        ...initialAssembly,
        options: {
          sceneId: options.sceneId || undefined,
          resolvedAssetUrls: runtimeResolvedAssetUrls,
        },
      })
      runtimeFragments = initialAssembly
      result = { scene, loadedBy: 'scene-definition' }
    } else {
      result = await loadEditorSceneDefinition(options.sceneId, {
        repository: options.repository,
      })
    }
    if (!result.scene) {
      return createEmptyPreviewRuntimeLoadResult()
    }
    /**
     * 发布二维分片在当前页面内存中保留全量配置；这里只建立不可持久化的组件缓存，
     * 真正写入二维仓库的组件集合会在首屏阶段按初始有效显隐筛选。
     */
    cachedWidgetFragment = fragmentLoader ? resolveEditorWidgetSceneFragment(result.scene) : null

    const nextRuntime =
      options.runtimeFactory?.(result.scene) ?? createDefaultPreviewRuntime(result.scene, options)
    runtime = nextRuntime

    /**
     * Runtime 只在常驻对象或区块真正准备创建时调用该补全器。返回对象保持输入顺序，未进入本批次的
     * 三维实例不会读取依赖，也不会提前解析资源地址。
     */
    nextRuntime.setObjectActivationResolver?.(async (objectIds) => {
      const activation = await activateRuntimeTargets(objectIds)
      if (!activation) return []
      const objectsById = new Map(activation.scene.objects.map((object) => [object.id, object]))
      const resolvedObjects = objectIds
        .map((objectId) => objectsById.get(objectId))
        .filter((object): object is SceneDefinition['objects'][number] => Boolean(object))
      /**
       * 依赖补全器正在被 Runtime 等待时不能同步反向 upsert；放到微任务中刷新调度器，
       * 避免对象首轮数据应用再次进入同一个激活补全器形成递归。
       */
      if (sceneDataPollingRuntime && resolvedObjects.length) {
        queueMicrotask(() => void sceneDataPollingRuntime?.start())
      }
      return resolvedObjects
    })

    await nextRuntime.mount(options.container)
    if (disposed) {
      return createEmptyPreviewRuntimeLoadResult()
    }

    /**
     * mount 只准备引擎容器，真实内容统一由 SceneDefinition 写入。
     * 这样预览页和编辑页使用同一份序列化数据，后续 GIS/local3d 分流也只依赖 scene.type。
     */
    /**
     * 预览只在 Runtime 装载边界解析 `preview` 覆盖。返回给页面、二维部件和保存链路的仍是完整原始
     * SceneDefinition，因此预览的临时内存／并发预算绝不会覆盖编辑器基线或写回本地 JSON。
     */
    const runtimeStreaming = resolveSceneStreamingConfigForRuntime(
      result.scene.streaming,
      'preview',
    )
    const runtimeScene =
      runtimeStreaming === result.scene.streaming
        ? result.scene
        : { ...result.scene, streaming: runtimeStreaming }
    runtimeScene.objects.forEach((object) => {
      if (object.type === 'effect' && object.effect?.type === 'three-map') {
        runtimeDataObjects.set(object.id, object)
        preloadedRuntimeObjectIds.add(object.id)
      }
    })
    /**
     * 发布态必须在恢复任何场景对象前关闭编辑能力。
     * 部分旧 Three 创建入口会在对象恢复时自动高亮并挂载 TransformControls，若等到 loadScene
     * 完成后再切换，只能清理最后一个对象，期间仍可能残留 Gizmo 或产生一帧可见闪烁。
     */
    nextRuntime.setEditingEnabled?.(false)
    // 在首轮创建前订阅挂载事件，后续动作无需反向读取具体引擎对象判断就绪。
    stopObjectLifecycle = nextRuntime.subscribeObjectLifecycle?.((event) => {
      if (disposed) return
      if (event.type === 'mounted') {
        mountedObjectIds.add(event.objectId)
        objectMountWaiters.get(event.objectId)?.()
        objectMountWaiters.delete(event.objectId)
      } else {
        mountedObjectIds.delete(event.objectId)
        preparedActionObjectIds.delete(event.objectId)
      }
    })
    await nextRuntime.loadScene(runtimeScene)
    if (disposed) {
      return createEmptyPreviewRuntimeLoadResult()
    }

    /**
     * local3d 发布预览不经过编辑器 ViewportHost；因此这里补上与编辑态相同的地图接管层，
     * 否则 ThreeRuntime 会跳过 three-map 对象，预览中既没有地图点击拾取，也不会显示省级信息框。
     */
    previewSceneStore = createSceneStore(runtimeScene)
    const legacyRenderSceneApi = getLegacyRenderSceneApiFromRuntime(
      nextRuntime,
    ) as renderScene | null
    const previewActionRuntime = createEditorSceneInteractionActionRuntimePort({
      getRuntime: () => nextRuntime,
      getSceneApi: () => legacyRenderSceneApi,
      isActive: () => !disposed,
    })
    // 二维发布预览不创建三维呈现器；组件缓存、首次显示和依赖加载继续复用来源流程。

    if (fragmentLoader && runtimeFragments) {
      /**
       * 首屏只激活初始有效显示的二维组件；隐藏组件仅保留在 cachedWidgetFragment，
       * 不进入 Pinia 仓库，因此不会创建 Vue 节点、ECharts 实例或提前启动数据请求。
       */
      const initialWidgetIds = cachedWidgetFragment
        ? collectInitiallyVisibleWidgetIds(cachedWidgetFragment)
        : []
      const activation = await activateRuntimeTargets(initialWidgetIds)
      const initialScene = activation?.scene ?? result.scene
      const initialFragment = selectWidgetFragment(
        resolveEditorWidgetSceneFragment(initialScene),
        initialWidgetIds,
      )
      await applyEditorWidgetSceneFragment(
        withWidgetFragment(initialScene, initialFragment),
        options.applyWidgetFragment,
      )
      initialFragment.widgets.forEach((widget) => mountedWidgetIds.add(widget.id))
    } else {
      await applyEditorWidgetSceneFragment(result.scene, options.applyWidgetFragment)
    }
    if (disposed) {
      return createEmptyPreviewRuntimeLoadResult()
    }

    /**
     * 发布预览直接从 sceneJson 组装出的 SceneDefinition 读取场景级请求上下文。
     * 不写编辑器 Pinia 请求仓库，避免公开预览与同一浏览器中的编辑任务共享可变状态。
     */
    const sceneRequestState = readSceneGlobalStateFromDefinition(result.scene)
    const legacyPreviewDataPollingApi = legacyRenderSceneApi as LegacyPreviewDataPollingApi | null
    /**
     * 发布页的旧模块仍负责历史数据集、打点和交互事件，但所有二维、三维远程请求统一交给
     * SceneDataPollingRuntime。只读请求上下文来自本次发布快照，不访问编辑器全局仓库。
     */
    legacyPreviewDataPollingApi?.scenePreviewModules?.setRequestContext({
      getPublicRequests: () => sceneRequestState.publicRequests,
      getRequestGlobalConfig: () => sceneRequestState.requestGlobalConfig,
      getRuntimeContext: () => ({ sceneId: result.scene?.id ?? null, publicPreview: true }),
    })
    legacyPreviewDataPollingApi?.scenePreviewModules?.setDataPollingManagedExternally(true)
    sceneDataPollingRuntime = new SceneDataPollingRuntime({
      getPublicRequests: () => sceneRequestState.publicRequests,
      getRequestGlobalConfig: () => sceneRequestState.requestGlobalConfig,
      getRuntimeContext: () => ({ sceneId: result.scene?.id ?? null, publicPreview: true }),
      // 三维数据仅保全，二维阶段不启动三维远程绑定。
      getSceneObjects: () => [],
      applySceneObject: async (object) => {
        await nextRuntime.upsertObject(object)
        previewSceneStore?.upsertObject(object)
      },
    })
    await sceneDataPollingRuntime.start()
    if (disposed) {
      return createEmptyPreviewRuntimeLoadResult()
    }

    await applyEditorSceneCameraToRuntime(result.scene, nextRuntime)
    if (disposed) {
      return createEmptyPreviewRuntimeLoadResult()
    }

    return {
      scene: result.scene,
      runtime: nextRuntime,
      runtimeType: nextRuntime.type,
      renderSceneApi: legacyRenderSceneApi,
      loadedBy: result.loadedBy,
    }
  }

  return {
    load,
    activateWidgets,
    activateWidgetGroups,
    activateSceneObject,
    prepareSceneObjects,
    dispose,
  }
}
