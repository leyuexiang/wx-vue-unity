import { computed, onBeforeUnmount, onMounted, reactive, ref, toRaw, useTemplateRef } from 'vue'
import { debounce } from 'lodash-es'
import { ElMessage } from 'element-plus'
import type {
  AjaxRequestConfig,
  ChartBindingRule,
  ComponentDataBindingRule,
  ComponentDataConfig,
  ComponentDataRequestItem,
  DatasetRequestConfig,
  PublicRequestConfig,
  PublicRequestReferenceConfig,
  RequestGlobalConfig,
} from '@/types/data-config'
import { getDataConfigRequests, syncDataConfigRequestMirror } from '@/types/data-config'
import { CHART_AUTO_MEASURE_FIELD_LIMIT, isChartBindingRule } from '@/types/data-config'
import {
  createEmptyRequestGlobalConfig,
  getDuplicateTargetFields,
  getOccupiedTargetFieldsBefore,
  getSceneObjectDataConfigByUuid,
  getWidgetDataConfigById,
  mergeAjaxRequestWithGlobalConfig,
  normalizeDataConfig,
  isTargetFieldAvailable,
  setSceneObjectDataConfigByUuid,
  setWidgetDataConfigById,
} from '@/utils/dataConfig'
import { resolvePublicRequestName } from '@/utils/dataConfig/publicRequestName'
import { useSceneRequestStore, useSceneStore, useSceneWidgetStore } from '@/stores/sceneEditStore'
import type {
  RecordPaginationBinding,
  RecordPaginationOption,
} from '@/packages/components/Control/RecordPagination/config'
import {
  getWidgetPanelLockState,
  runWidgetPanelHistoryChange,
} from '@/integrations/scene/widgetPanels'
import type { CommandBus, SceneStore } from '@/scene-platform'
import { DRAG_MODEL_ENUM } from '@/enums'
import { resolveWidgetPanelSelection } from '@/integrations/scene/widgetPanels'
import {
  getActiveSceneViewportHost,
  subscribeActiveSceneViewportHost,
} from '@/integrations/scene/editorScenePlatformHost'
import { editorSceneOperation, subscribeEditorSceneBeforeOperation } from '@/integrations/scene/editorSceneOperationGate'
import { updateEditorSceneRequestGlobalConfig } from '@/integrations/scene/editorSceneGlobalStateAdapter'
import { updateEditorScenePublicRequests, type PublicRequestBindingChange } from '@/integrations/scene/editorScenePublicRequestAdapter'
import { resolveEditorSceneObjectIdFromLegacyEngineId } from '@/integrations/scene/editorSceneRuntimeObjectIdResolver'
import {
  getEditorSceneObjectDataConfig,
  setEditorSceneObjectDataConfig,
} from '@/integrations/scene/editorSceneDataConfigAdapter'
import type SetDatasetDialog from './SetDatasetDialog/index.vue'
import {
  RIGHT_DATA_PANEL_INPUT_WIDGET_BINDINGS,
  RIGHT_DATA_PANEL_DYNAMIC_OPTION_WIDGET_KEY_NAMES,
  RIGHT_DATA_PANEL_MARKING_BINDINGS,
  RIGHT_DATA_PANEL_OBJECT_BINDINGS,
  RIGHT_DATA_PANEL_OPTION_WIDGET_KEY_NAMES,
  RIGHT_DATA_PANEL_PAGINATION_WIDGET_BINDINGS,
  RIGHT_DATA_PANEL_PAGINATION_WIDGET_KEY_NAME,
  RIGHT_DATA_PANEL_PAGE_FRAME_BINDINGS,
  RIGHT_DATA_PANEL_PAGE_FRAME_WIDGET_KEY_NAME,
  RIGHT_DATA_PANEL_QUIZ_BINDINGS,
  RIGHT_DATA_PANEL_QUIZ_WIDGET_KEY_NAME,
  RIGHT_DATA_PANEL_REQUEST_TYPE_OPTIONS,
  RIGHT_DATA_PANEL_SELECT_WIDGET_BINDINGS,
  RIGHT_DATA_PANEL_TABLE_WIDGET_KEY_NAMES,
  createTableBindingTargets,
  type BindingOption,
  type SelectionKind,
} from './rightDataPanelConstants'
import {
  autoFillChartMapping,
  createChartMappingTargetFields,
  createDefaultChartRule,
  createEmptyAjaxRequest,
  createEmptyPublicRequest,
} from './rightDataPanelDataHelpers'
import {
  appendChartMeasureField,
  appendCustomFixedBindingRule,
  appendCustomObjectBindingRule,
  createObjectManualMappingItems,
  createDefaultConfigForSelection as buildDefaultSelectionConfig,
  createFieldStatusClass,
  getBindingSourceField as resolveBindingSourceField,
  removeObjectManualBindingRule,
  removeFixedBindingRule,
  updateFixedBindingSourceField,
  updateFixedBindingTargetPath,
  getChartMeasureTargetFieldAt,
  getFieldStatus as resolveFieldStatus,
  removeChartMeasureFieldAt,
  removeChartDimensionField,
  recordDeletedAutoMappingTarget,
  resolveChartMeasureFieldOrigins,
  syncWidgetBindingsWithAvailableFields as syncWidgetBindings,
  updateBindingField,
  updateChartMeasureFieldAt,
  updateChartTargetMeasureFieldAt,
  updateObjectManualBindingSourceField,
  updateObjectManualBindingTargetPath,
} from './rightDataPanelBindingHelpers'
import { switchRequestTypeConfig } from './rightDataPanelRequestHelpers'
import {
  executeRightDataPanelTestRequest,
  loadRightDataPanelDatasetFields,
  syncRightDataPanelPreviewFromRaw,
} from './rightDataPanelPreviewHelpers'
import {
  buildRightDataPanelContentDisplay,
  buildRightDataPanelPersistedConfig,
  initializeRightDataPanelState,
  prepareRightDataPanelPersistConfig,
  resolveRightDataPanelAvailableFields,
  validateRightDataPanelStaticPayload,
  buildRightDataPanelStaticJsonText,
} from './rightDataPanelStateHelpers'
import { registerRightDataPanelWatchers } from './registerRightDataPanelWatchers'
import { createRightDataPanelUiActions } from './rightDataPanelUiActionHelpers'
import {
  createDataPanelRequestItem,
  MAX_REQUEST_COUNT,
  normalizeDataPanelRequestItems,
  renameDataPanelRequestItems,
  setDataPanelRequestExpansion,
  type DataPanelRequestItem,
} from './multiRequestPanelState'

export type RightDataPanelTargetKind = 'auto' | 'widget' | 'sceneObject'

interface UseRightDataPanelOptions {
  /**
   * 数据面板目标来源。
   * widget 只读写二维部件 component.dataConfig；
   * sceneObject 优先读写 SceneObject.metadata.dataConfig，并同步旧 mesh.userData.dataConfig；
   * auto 保留旧入口的兼容策略。
   */
  targetKind?: RightDataPanelTargetKind
  /** 三维目标由命令总线写入领域元数据，保证会话内可撤销和重做。 */
  commandBus?: Pick<CommandBus, 'execute'> | null
}

/**
 * 把固定目标和当前请求已经创建的自定义目标合并成面板选项。
 *
 * 固定目标即使尚未绑定也要保留，便于用户选择来源；自定义目标必须从当前请求的绑定读取，
 * 才能在字段刷新、请求切换和重新渲染后保持空白人工行及其稳定键，不会被自动补齐覆盖。
 */
const createFixedBindingTargets = (
  fixedTargets: readonly BindingOption[],
  bindings: ComponentDataConfig['bindings'],
  kind: 'widget' | 'marking',
) => {
  type FixedBinding = Extract<ComponentDataBindingRule, { kind: 'widget' | 'marking' }>
  const fixedPathSet = new Set(fixedTargets.map((target) => target.targetPath))
  const customBindings = bindings.filter(
    (binding): binding is FixedBinding =>
      (binding.kind === 'widget' || binding.kind === 'marking') &&
      binding.kind === kind &&
      Boolean(binding.id),
  )
  const customByFixedPath = new Map(
    customBindings
      .filter((binding) => fixedPathSet.has(binding.targetPath))
      .map((binding) => [binding.targetPath, binding]),
  )
  const fixed = fixedTargets.map((target) => {
    const customBinding = customByFixedPath.get(target.targetPath)
    return customBinding
      ? {
          ...target,
          key: `${kind}-custom:${customBinding.id}`,
          label: customBinding.targetPath || '自定义字段',
          sourceField: customBinding.sourceField,
        }
      : target
  })
  const custom = customBindings
    .filter((binding) => !fixedPathSet.has(binding.targetPath) || !binding.targetPath)
    .map((binding) => ({
      targetPath: binding.targetPath,
      label: binding.targetPath || '自定义字段',
      key: `${kind}-custom:${binding.id}`,
      sourceField: binding.sourceField,
    }))
  return [...fixed, ...custom]
}

/**
 * 右侧数据面板的状态、请求链路和持久化逻辑统一下沉到组合函数。
 *
 * 这样 SFC 只保留模板和弹窗组件装配，避免脚本编排继续把页面文件推回超长状态，
 * 同时也为后续拆成更细的子面板提供稳定出口。
 */
export const useRightDataPanel = (options: UseRightDataPanelOptions = {}) => {
  const targetKind = options.targetKind || 'auto'
  const sceneStore = useSceneStore()
  const sceneRequestStore = useSceneRequestStore()
  const scenePlatformStore = ref<SceneStore | null>(null)
  const scenePlatformStoreRevision = ref(0)
  let sceneLoadRevision = 0

  const editableConfig = ref<ComponentDataConfig | null>(null)
  /** 多请求列表与当前活动项。活动项沿用原有面板控件，切换时只替换该引用。 */
  const requestItems = ref<DataPanelRequestItem[]>([])
  const activeRequestId = ref('')
  /**
   * 最近一次完成初始化的数据目标标识。
   *
   * 同一对象的保存会触发仓库订阅刷新；该标识用于区分“当前对象保存后回读”和
   * “用户切换到另一个对象”，前者必须保留当前请求与折叠状态。
   */
  const initializedRequestSelectionKey = ref('')
  /**
   * 唯一展开请求的稳定编号。
   *
   * `activeRequestId` 表示当前正在编辑的请求，允许在请求折叠时继续保留编辑上下文；
   * `collapsed` 仅作为持久化字段，不再直接参与模板判断，避免两套状态互相覆盖。
   */
  const expandedRequestId = ref('')
  const staticJsonText = ref('[]')
  const staticJsonError = ref('')
  const requestError = ref('')
  const availableDatasetFields = ref<string[]>([])
  const datasetFieldLoadError = ref('')
  const latestRequestRaw = ref<unknown>(null)
  const hydrating = ref(false)
  /** 选中对象或刷新令牌变化时递增，令旧的异步初始化回调失效。 */
  const initializationRevision = ref(0)
  const loadedDatasetKey = ref('')
  const fileInputRef = ref<HTMLInputElement | null>(null)
  const datasetDialogRef = useTemplateRef<InstanceType<typeof SetDatasetDialog>>('datasetDialogRef')
  const publicRequestDialogVisible = ref(false)
  let publicRequestGlobalDraft: RequestGlobalConfig | undefined
  const ajaxConfigDialogVisible = ref(false)
  const filterEditorVisible = ref(false)
  const publicRequestDraft = reactive<PublicRequestConfig>(createEmptyPublicRequest())
  const availableFields = ref<string[]>([])
  const dataContentDisplay = ref('')

  const activeRequestIndex = computed(() =>
    Math.max(
      0,
      requestItems.value.findIndex((item) => item.id === activeRequestId.value),
    ),
  )

  const activeRequestItem = computed(() => requestItems.value[activeRequestIndex.value] || null)

  /**
   * 将面板请求项转换成运行时复用的协议结构。
   *
   * 映射唯一性校验只读取请求自身的配置，不读取根配置的首项镜像，避免活动请求切换时把
   * 请求1的字段误算到其它请求。这里每次只构造最多五项的小列表，远小于组件数据量。
   */
  const getRequestItemsForTargetValidation = (): ComponentDataRequestItem[] =>
    requestItems.value.map((item) => ({
      id: item.id,
      name: item.name,
      collapsed: item.collapsed,
      request: item.config.request,
      extractor: item.config.extractor,
      dataset: item.config.dataset,
      bindings: item.config.bindings,
      threeMapRole: item.config.threeMapRole,
      mergeMode: item.config.mergeMode,
      filterFn: item.config.filterFn,
      deletedAutoMappingTargets: item.config.deletedAutoMappingTargets,
    }))

  /** 当前请求只能使用前序请求尚未占用的目标字段，供自动补齐和下拉选项共同复用。 */
  const getActiveRequestOccupiedTargetFields = () =>
    getOccupiedTargetFieldsBefore(getRequestItemsForTargetValidation(), activeRequestIndex.value)

  /**
   * 校验当前请求写入的目标字段是否会和其它请求冲突。
   *
   * 当前请求内的重复由各映射帮助函数处理；本入口专门拦截跨请求覆盖，空字段作为人工草稿
   * 合法保留，不会占用任何目标字段。
   */
  const isActiveRequestTargetFieldAvailable = (targetField: string, currentField?: string) =>
    isTargetFieldAvailable(
      getRequestItemsForTargetValidation(),
      activeRequestIndex.value,
      targetField,
      currentField,
    )

  /** 将展开状态集中写回请求项，保证列表任意时刻最多只有一个展开项。 */
  const setExpandedRequestId = (id: string | null) => {
    expandedRequestId.value = id || ''
    setDataPanelRequestExpansion(requestItems.value, expandedRequestId.value || null)
  }

  /** 模板统一通过唯一展开编号判断内容和箭头，避免读取可能过期的 collapsed。 */
  const isRequestExpanded = (id: string) => expandedRequestId.value === id

  /**
   * 把活动项写回列表，避免编辑过程中切换请求丢失尚未触发保存的字段。
   *
   * 静态 JSON 使用独立的文本状态绑定编辑器，不能只替换 `editableConfig` 引用；
   * 切换请求前必须先把当前文本解析回活动请求，否则切换后新请求的文本会覆盖旧请求。
   * 无效 JSON 不写回配置，保留当前错误草稿，等待用户修正后再保存。
   */
  const syncActiveRequestItem = () => {
    const item = activeRequestItem.value
    if (!item || !editableConfig.value) return

    if (editableConfig.value.request.type === 'static') {
      const preparedResult = prepareRightDataPanelPersistConfig({
        config: editableConfig.value,
        staticJsonText: staticJsonText.value,
        isMarkingSelection: selectionKind.value === 'marking',
        availableDatasetFields: availableDatasetFields.value,
        isChartWidgetSelection: isChartWidgetSelection.value,
        selectedChartComponent: selectedWidget.value?.component,
      })
      if (!preparedResult.staticJsonError) {
        item.config = preparedResult.preparedConfig
        return
      }
    }

    item.config = editableConfig.value
  }

  /**
   * 切换当前编辑请求并刷新该请求专属的表单预览状态。
   *
   * 删除请求后列表索引会立即变化，此时调用方已在删除前完成同步，
   * 因而需要通过 `syncCurrent = false` 跳过一次同步，避免把旧请求写入新索引。
   */
  const activateRequestItem = (item: DataPanelRequestItem, syncCurrent = true) => {
    const changed = activeRequestId.value !== item.id
    if (changed && syncCurrent) syncActiveRequestItem()
    activeRequestId.value = item.id
    editableConfig.value = item.config
    staticJsonText.value = buildRightDataPanelStaticJsonText(
      item.config,
      item.config.request.type === 'static' && isChartWidgetSelection.value
        ? selectedWidget.value?.component
        : undefined,
    )
    latestRequestRaw.value = null
    requestError.value = ''
    refreshAvailableFields()
    refreshDataContentDisplay()
  }

  const selectRequestItem = (id: string) => {
    const next = requestItems.value.find((item) => item.id === id)
    if (!next) return
    // 标题点击始终切换到该请求并展开它；展开状态只由这一处统一写入。
    activateRequestItem(next)
    setExpandedRequestId(next.id)
    persistSoon()
  }

  const toggleRequestItem = (id: string) => {
    const item = requestItems.value.find((entry) => entry.id === id)
    if (!item) return
    if (isRequestExpanded(id)) {
      // 允许全部折叠，但不允许同时展开多个请求。
      setExpandedRequestId(null)
    } else {
      activateRequestItem(item)
      setExpandedRequestId(id)
    }
    persistSoon()
  }

  /**
   * 新增请求默认采用静态类型和组件示例数据，不会产生网络请求。
   * 默认配置中的图表槽位与 widget 的 `value` 仅是待自动识别的初始值，必须在请求入队前
   * 按前序请求占用集合清理；不能等到空静态数据刷新后再处理，否则保存校验会先发现重复目标。
   */
  const addRequestItem = () => {
    if (requestItems.value.length >= MAX_REQUEST_COUNT) {
      ElMessage.warning(`最多支持${MAX_REQUEST_COUNT}个请求`)
      return
    }
    syncActiveRequestItem()
    const nextConfig = createDefaultConfigForSelection()
    // 新请求会追加到列表末尾，因此当前已有的每一项都是它的前序请求，必须全部计入占用集合。
    // 不能复用当前活动请求的前序集合，否则在请求1展开时新增请求会重新生成重复目标字段。
    const occupiedTargets = getOccupiedTargetFieldsBefore(
      getRequestItemsForTargetValidation(),
      requestItems.value.length,
    )
    if (isChartWidgetSelection.value) {
      autoFillChartMapping(
        nextConfig,
        [],
        selectedWidget.value?.component.info.keyName || '',
        occupiedTargets,
      )
    } else if (selectionKind.value === 'widget') {
      syncWidgetBindings(nextConfig, targetBindings.value, [], occupiedTargets)
    }
    const next = createDataPanelRequestItem(nextConfig, requestItems.value.length)
    requestItems.value.push(next)
    renameDataPanelRequestItems(requestItems.value)
    selectRequestItem(next.id)
  }

  /** 删除请求立即释放其映射字段；删除最后一项时恢复示例静态请求1。 */
  const removeRequestItem = (id: string) => {
    const index = requestItems.value.findIndex((item) => item.id === id)
    if (index < 0) return
    // 先保存当前编辑项，再改变列表索引，防止删除后活动索引落到下一项造成数据串写。
    syncActiveRequestItem()
    requestItems.value.splice(index, 1)
    if (requestItems.value.length === 0) {
      requestItems.value.push(createDataPanelRequestItem(createDefaultConfigForSelection()))
    }
    renameDataPanelRequestItems(requestItems.value)
    const next = requestItems.value[Math.min(index, requestItems.value.length - 1)]
    activateRequestItem(next, false)
    setExpandedRequestId(next.id)
    persistSoon()
  }
  let stopScenePlatformHostSubscription: (() => void) | null = null
  let stopScenePlatformStoreSubscription: (() => void) | null = null

  const refreshScenePlatformStoreRevision = () => {
    scenePlatformStoreRevision.value += 1
  }

  /**
   * 订阅当前活动视口的场景仓库。
   *
   * 数据面板的三维对象配置从 F015 起以 SceneStore 元数据为保存主副本；
   * Store 事件只递增本地版本号，后续仍复用既有选中态初始化 watcher，避免在订阅回调里直接改表单。
   */
  const subscribeScenePlatformStore = (nextStore: SceneStore | null) => {
    stopScenePlatformStoreSubscription?.()
    stopScenePlatformStoreSubscription = null
    scenePlatformStore.value = nextStore
    refreshScenePlatformStoreRevision()

    if (!nextStore) return

    stopScenePlatformStoreSubscription = nextStore.subscribe((event) => {
      if (event.type === 'sceneLoaded') sceneLoadRevision++
      refreshScenePlatformStoreRevision()
    })
  }

  const selectedWidget = computed(() => {
    if (targetKind === 'sceneObject') return null
    const selection = resolveWidgetPanelSelection()
    return selection.kind === 'widget' || selection.kind === 'widgetChild' ? selection.widget : null
  })

  /** 翻页适配与外观同属组件配置，但只在数据页签编辑，不扩散到普通部件。 */
  const recordPaginationWidget = computed(() =>
    selectedWidget.value?.component.info.keyName === 'VRecordPagination'
      ? selectedWidget.value
      : null,
  )
  const recordPaginationBinding = computed(
    () =>
      (recordPaginationWidget.value?.component.option as RecordPaginationOption | undefined)
        ?.pagination,
  )
  const recordPaginationDataConfig = computed<ComponentDataConfig | null>(() => {
    if (!recordPaginationWidget.value || !editableConfig.value) return null
    return {
      ...editableConfig.value,
      requests: requestItems.value.map((item) => ({
        ...(item.id === activeRequestId.value ? editableConfig.value! : item.config),
        id: item.id,
        name: item.name,
      })),
    }
  })
  const updateRecordPaginationBinding = (pagination: RecordPaginationBinding) => {
    const widget = recordPaginationWidget.value
    if (!widget || getWidgetPanelLockState(widget.id).effectiveLocked) return
    runWidgetPanelHistoryChange('更新逐条翻页适配', [widget.id], () => {
      widget.component.option = { ...widget.component.option, pagination }
      useSceneWidgetStore().bumpWidgetRenderVersion(widget.id)
    })
    // 数据面板测试和字段识别与运行时使用同一列表提取路径，避免预览整层响应而无法选择记录字段。
    const selectedRequest = requestItems.value.find((item) => item.id === pagination.requestId)
    if (selectedRequest) {
      const config =
        selectedRequest.id === activeRequestId.value ? editableConfig.value : selectedRequest.config
      if (config && config.extractor?.resultPath !== pagination.listPath) {
        config.extractor = { resultPath: pagination.listPath }
        persistSoon()
      }
    }
  }

  /**
   * 当前编辑器状态可能仍保存旧 Three uuid；先用 Runtime 映射转为 SceneObject.id。
   * 不扫描 Three.Scene，避免属性面板每次重算都触发线性对象查找。
   */
  const selectedSceneObjectId = computed(() => {
    void scenePlatformStoreRevision.value
    const selectedId = sceneStore.currentTransformMaterialUuid
    const activeStore = scenePlatformStore.value
    if (!selectedId || !activeStore) return null
    if (activeStore.getObject(selectedId)) return selectedId
    return resolveEditorSceneObjectIdFromLegacyEngineId(
      getActiveSceneViewportHost()?.getRuntime(),
      selectedId,
    )
  })

  const selectedSceneObject = computed(() =>
    selectedSceneObjectId.value
      ? (scenePlatformStore.value?.getObject(selectedSceneObjectId.value) ?? null)
      : null,
  )

  /** 仅为尚未迁移的存量对象保留旧 Mesh 查询。 */
  const selectedLegacyMesh = computed(() => {
    if (targetKind === 'widget') return null
    const uuid = sceneStore.currentTransformMaterialUuid
    return uuid ? sceneStore.sceneApi?.getSceneObjectByUuid(uuid) || null : null
  })

  const selectedMesh = computed(() => (selectedSceneObject.value ? null : selectedLegacyMesh.value))

  const selectionKey = computed(() => {
    if (selectedWidget.value) return `widget:${selectedWidget.value.id}`
    if (selectedSceneObject.value) return `scene-object:${selectedSceneObject.value.id}`
    if (selectedMesh.value) return `mesh:${selectedMesh.value.uuid}`
    return 'none'
  })

  const sceneObjectRefreshToken = computed(
    () => `${sceneStore.transformMaterialRandomId}:${scenePlatformStoreRevision.value}`,
  )

  const selectionKind = computed<SelectionKind>(() => {
    if (selectedWidget.value) return 'widget'
    if (selectedSceneObject.value?.effect?.type === 'three-map') return 'three-map'
    if (selectedSceneObject.value?.metadata?.type === DRAG_MODEL_ENUM.Marking) return 'marking'
    if (selectedMesh.value?.userData?.type === DRAG_MODEL_ENUM.Marking) return 'marking'
    /**
     * 统一场景平台选中的三维对象可能尚未同步出旧版 Three Mesh。
     * 此时仍应进入对象数据配置链路，否则页面会误判为无可配置对象，拦截人工映射面板。
     */
    if (selectedSceneObject.value) return 'object'
    if (selectedMesh.value) return 'object'
    return 'none'
  })

  /**
   * 数据读写根据显式目标分流。
   * 二维面板不会再因为当前仍残留三维选中 uuid 而写入 mesh.userData；
   * 三维面板也不会因为画布部件选中态残留而写入 component.dataConfig。
   */
  const getCurrentTargetDataConfig = () => {
    if (selectedWidget.value) {
      return getWidgetDataConfigById(selectedWidget.value.id)
    }
    if (selectedSceneObject.value) {
      const primaryConfig = getEditorSceneObjectDataConfig({
        store: scenePlatformStore.value,
        objectId: selectedSceneObject.value.id,
      })
      if (primaryConfig) return primaryConfig

      /**
       * 已纳入 SceneStore 但尚未镜像数据配置的历史对象，首次读取时才访问旧 userData。
       * 一旦用户保存，后续路径会只读 metadata，不再重复调用旧接口。
       */
      const legacyDataConfig = selectedLegacyMesh.value
        ? getSceneObjectDataConfigByUuid(selectedLegacyMesh.value.uuid)
        : null
      return getEditorSceneObjectDataConfig({
        store: scenePlatformStore.value,
        objectId: selectedSceneObject.value.id,
        legacyDataConfig,
      })
    }
    if (selectedMesh.value) {
      return getSceneObjectDataConfigByUuid(selectedMesh.value.uuid)
    }
    return null
  }

  const setCurrentTargetDataConfig = (dataConfig: ComponentDataConfig | null) => {
    if (editorSceneOperation.value) return
    if (selectedWidget.value) {
      if (getWidgetPanelLockState(selectedWidget.value.id).effectiveLocked) return
      setWidgetDataConfigById(selectedWidget.value.id, dataConfig)
      return
    }
    if (selectedSceneObject.value) {
      /**
       * 已迁移对象只写 SceneStore。Three Runtime 会在 objectUpserted 后把 metadata.dataConfig
       * 镜像到旧 userData，页面不再直接调用旧数据配置接口。
       */
      const host = getActiveSceneViewportHost()
      const store = toRaw(scenePlatformStore.value)
      const objectId = selectedSceneObject.value.id
      const commandBus = host && host.getStore() === store ? host.getCommandBus() : options.commandBus
      if (!commandBus || !store || store.isObjectEffectivelyLocked(objectId)) return
      setEditorSceneObjectDataConfig({ store, commandBus, objectId, dataConfig })
      return
    }
    if (selectedMesh.value) {
      // 未迁移对象保持旧链路，避免历史场景在平台映射尚未建立时丢失配置。
      setSceneObjectDataConfigByUuid(selectedMesh.value.uuid, dataConfig)
    }
  }

  const isChartWidgetSelection = computed(
    () =>
      selectionKind.value === 'widget' &&
      selectedWidget.value?.component.info.packageName === 'Chart',
  )

  const isThreeMapSelection = computed(() => selectionKind.value === 'three-map')

  const isTableWidgetSelection = computed(() => {
    const keyName = selectedWidget.value?.component.info.keyName
    return (
      selectionKind.value === 'widget' &&
      Boolean(keyName && RIGHT_DATA_PANEL_TABLE_WIDGET_KEY_NAMES.has(keyName))
    )
  })

  const requestTypeOptions = computed(() => RIGHT_DATA_PANEL_REQUEST_TYPE_OPTIONS)

  const mappingSectionTitle = computed(() => {
    if (isTableWidgetSelection.value) return '列数据映射'
    // Figma 将图表和普通组件统一归入“属性映射”，具体字段差异由列表行表达。
    if (isChartWidgetSelection.value) return '属性映射'
    if (selectionKind.value === 'marking') return '实例生成映射'
    if (isThreeMapSelection.value) return '地图固定字段映射'
    return '属性映射'
  })

  const mappingHeadLabel = computed(() => {
    if (isTableWidgetSelection.value) return '列字段'
    if (isChartWidgetSelection.value) return '字段'
    // 三维人工映射与参考交互一致：左列记录可选可填的目标字段，而非固定属性标签。
    if (selectionKind.value === 'object') return '字段'
    if (isThreeMapSelection.value) return '地图字段'
    if (selectionKind.value === 'marking') return '实例属性'
    return '属性'
  })

  const targetBindings = computed(() => {
    if (selectionKind.value === 'marking') {
      return createFixedBindingTargets(
        RIGHT_DATA_PANEL_MARKING_BINDINGS,
        editableConfig.value?.bindings || [],
        'marking',
      )
    }
    if (selectionKind.value === 'widget') {
      const keyName = selectedWidget.value?.component.info.keyName
      // 浏览记录只提供用户明确配置的字段映射，不强加普通输入框的 value 目标。
      if (keyName === 'VRecordPagination') {
        return createFixedBindingTargets([], editableConfig.value?.bindings || [], 'widget')
      }
      if (isTableWidgetSelection.value) {
        return createFixedBindingTargets(
          createTableBindingTargets(
            keyName,
            selectedWidget.value?.component.option as Record<string, unknown>,
          ),
          editableConfig.value?.bindings || [],
          'widget',
        )
      }
      if (keyName === RIGHT_DATA_PANEL_PAGE_FRAME_WIDGET_KEY_NAME) {
        return createFixedBindingTargets(
          RIGHT_DATA_PANEL_PAGE_FRAME_BINDINGS,
          editableConfig.value?.bindings || [],
          'widget',
        )
      }
      if (keyName === RIGHT_DATA_PANEL_QUIZ_WIDGET_KEY_NAME) {
        return createFixedBindingTargets(
          RIGHT_DATA_PANEL_QUIZ_BINDINGS,
          editableConfig.value?.bindings || [],
          'widget',
        )
      }
      /** 分页器使用独立目标集合，其他普通组件继续沿用原有 value/options 规则。 */
      if (keyName === RIGHT_DATA_PANEL_PAGINATION_WIDGET_KEY_NAME) {
        return createFixedBindingTargets(
          RIGHT_DATA_PANEL_PAGINATION_WIDGET_BINDINGS,
          editableConfig.value?.bindings || [],
          'widget',
        )
      }
      if (keyName && RIGHT_DATA_PANEL_OPTION_WIDGET_KEY_NAMES.has(keyName)) {
        if (
          RIGHT_DATA_PANEL_DYNAMIC_OPTION_WIDGET_KEY_NAMES.has(keyName) &&
          !availableFields.value.includes('options')
        ) {
          return createFixedBindingTargets(
            RIGHT_DATA_PANEL_INPUT_WIDGET_BINDINGS,
            editableConfig.value?.bindings || [],
            'widget',
          )
        }
        return createFixedBindingTargets(
          RIGHT_DATA_PANEL_SELECT_WIDGET_BINDINGS,
          editableConfig.value?.bindings || [],
          'widget',
        )
      }
      return createFixedBindingTargets(
        RIGHT_DATA_PANEL_INPUT_WIDGET_BINDINGS,
        editableConfig.value?.bindings || [],
        'widget',
      )
    }
    return RIGHT_DATA_PANEL_OBJECT_BINDINGS
  })

  const currentDatasetProperty = computed(() => {
    const requestConfig = editableConfig.value?.request.config as DatasetRequestConfig | undefined
    return requestConfig?.datasetProperty || null
  })

  const currentPublicRequest = computed(() => {
    const requestConfig = editableConfig.value?.request.config as
      | PublicRequestReferenceConfig
      | undefined
    if (!requestConfig?.publicRequestId) return null
    return (
      sceneRequestStore.scenePublicRequestList.find(
        (item) => item.id === requestConfig.publicRequestId,
      ) || null
    )
  })

  const ajaxRequestConfig = computed<AjaxRequestConfig>({
    get() {
      if (!editableConfig.value) return createEmptyAjaxRequest()
      return editableConfig.value.request.config as AjaxRequestConfig
    },
    set(value) {
      if (!editableConfig.value) return
      editableConfig.value.request.config = value
    },
  })

  const resolvedAjaxRequestConfig = computed<AjaxRequestConfig>(() =>
    mergeAjaxRequestWithGlobalConfig(
      ajaxRequestConfig.value,
      sceneRequestStore.sceneRequestGlobalConfig || createEmptyRequestGlobalConfig(),
    ),
  )

  const publicRequestConfig = computed<PublicRequestReferenceConfig>({
    get() {
      if (!editableConfig.value) return { publicRequestId: null }
      return editableConfig.value.request.config as PublicRequestReferenceConfig
    },
    set(value) {
      if (!editableConfig.value) return
      editableConfig.value.request.config = value
    },
  })

  /**
   * 公共接口下拉选项只保留 id 与名称，避免模板在每次渲染时重复处理旧字段。
   * 未命名的历史数据给出明确占位文案，不再渲染为空白行；新建接口仍由弹窗必填校验保证名称。
   */
  const publicRequestOptions = computed(() =>
    sceneRequestStore.scenePublicRequestList.map((item) => ({
      value: item.id,
      label: resolvePublicRequestName(item) || '未命名公共接口',
    })),
  )

  /**
   * 图表自动补齐统一携带前序请求占用字段。
   *
   * 同一函数被初始化、字段刷新、测试请求和保存链路调用，集中传参可避免某个入口遗漏后
   * 又把 `product`、`data1` 等字段补回后续请求。
   */
  const autoFillActiveChartMapping = (
    config: ComponentDataConfig,
    fields: string[],
    chartKeyName: string,
  ) => autoFillChartMapping(config, fields, chartKeyName, getActiveRequestOccupiedTargetFields())

  const ensureChartRuleBinding = () => {
    if (!editableConfig.value || !isChartWidgetSelection.value) return
    const existing = editableConfig.value.bindings.find(isChartBindingRule)
    if (existing) {
      /**
       * 旧场景只有接口来源字段，没有独立的组件目标字段。
       * 这里按当前图表类型补齐目标元数据，且只补空值，避免覆盖新场景已识别出的自定义目标字段。
       */
      const targetFields = createChartMappingTargetFields(
        selectedWidget.value?.component.info.keyName || '',
        existing.measureFields.length,
      )
      // 空字符串表示用户删除了自动维度；只有旧配置完全缺失时才补齐模板默认字段。
      if (existing.targetDimensionField === undefined) {
        existing.targetDimensionField = targetFields.dimensionField
      }
      existing.targetMeasureFields = existing.measureFields.map((_, index) => {
        const hasExplicitTarget =
          Array.isArray(existing.targetMeasureFields) && index < existing.targetMeasureFields.length
        return hasExplicitTarget
          ? existing.targetMeasureFields?.[index] || ''
          : targetFields.measureFields[index]
      })
      // 新建场景始终保存来源标记；运行中缺失的位置按自动识别项保护。
      existing.targetMeasureFieldOrigins = resolveChartMeasureFieldOrigins(existing)
      autoFillActiveChartMapping(
        editableConfig.value,
        availableFields.value,
        selectedWidget.value?.component.info.keyName || '',
      )
      return
    }
    editableConfig.value.bindings = [
      createDefaultChartRule(selectedWidget.value?.component.info.keyName || ''),
    ]
    autoFillActiveChartMapping(
      editableConfig.value,
      availableFields.value,
      selectedWidget.value?.component.info.keyName || '',
    )
  }

  const chartRule = computed<ChartBindingRule>({
    get() {
      const existing = editableConfig.value?.bindings.find(isChartBindingRule)
      return existing || createDefaultChartRule(selectedWidget.value?.component.info.keyName || '')
    },
    set(value) {
      if (!editableConfig.value) return
      editableConfig.value.bindings = [value]
    },
  })

  /**
   * 图表人工度量行的目标字段快捷选项。
   * 图表只公开当前类型支持的固定度量槽位；已有自定义目标也追加到选项中，保证改名后仍能正常回显。
   * 该列表只描述组件目标字段，不混入当前请求返回的来源字段。
   */
  const chartManualBindingTargetOptions = computed<BindingOption[]>(() => {
    const chartKeyName = selectedWidget.value?.component.info.keyName || ''
    const standardTargets = createChartMappingTargetFields(
      chartKeyName,
      CHART_AUTO_MEASURE_FIELD_LIMIT,
    ).measureFields
    const customTargets = (chartRule.value.targetMeasureFields || []).filter(Boolean)
    const targetPaths = [...new Set([...standardTargets, ...customTargets])]
    return targetPaths.map((targetPath) => ({ targetPath, label: targetPath }))
  })

  /**
   * 二维控件和打点人工行的目标字段快捷选项。
   * 固定协议字段来自 targetBindings，自定义目标来自当前请求绑定；空白占位行不生成空选项，仍可直接输入。
   */
  const fixedManualBindingTargetOptions = computed<BindingOption[]>(() =>
    targetBindings.value.filter((target) => Boolean(target.targetPath.trim())),
  )

  const showRequestTest = computed(
    () =>
      editableConfig.value?.request.type === 'ajax' ||
      editableConfig.value?.request.type === 'public',
  )
  const showFilterSection = computed(
    () =>
      editableConfig.value?.request.type === 'ajax' ||
      editableConfig.value?.request.type === 'public',
  )
  const markingPositionReady = computed(
    () => selectionKind.value !== 'marking' || Boolean(getBindingSourceField('position')),
  )

  const currentRequestConfig = computed<AjaxRequestConfig | undefined>(() => {
    if (!editableConfig.value) return undefined
    if (editableConfig.value.request.type === 'ajax') {
      return resolvedAjaxRequestConfig.value
    }
    if (editableConfig.value.request.type === 'public') {
      const configRef = editableConfig.value.request.config as PublicRequestReferenceConfig
      const target = sceneRequestStore.scenePublicRequestList.find(
        (item) => item.id === configRef.publicRequestId,
      )
      return target
        ? mergeAjaxRequestWithGlobalConfig(
            target,
            sceneRequestStore.sceneRequestGlobalConfig || createEmptyRequestGlobalConfig(),
          )
        : undefined
    }
    return undefined
  })

  const syncWidgetBindingsWithAvailableFields = () => {
    if (!editableConfig.value || selectionKind.value !== 'widget' || isChartWidgetSelection.value) {
      return
    }

    // 统一复用纯函数，保证组件、图标与图表一样遵守前序请求目标字段占用规则。
    syncWidgetBindings(
      editableConfig.value,
      targetBindings.value,
      availableFields.value,
      getActiveRequestOccupiedTargetFields(),
    )
  }

  const refreshAvailableFields = () => {
    availableFields.value = resolveRightDataPanelAvailableFields(
      editableConfig.value,
      availableDatasetFields.value,
    )
    syncWidgetBindingsWithAvailableFields()
  }

  const refreshDataContentDisplay = () => {
    dataContentDisplay.value = buildRightDataPanelContentDisplay(
      editableConfig.value,
      isChartWidgetSelection.value ? selectedWidget.value?.component : undefined,
    )
  }

  const createDefaultConfigForSelection = () =>
    buildDefaultSelectionConfig(
      selectionKind.value,
      isChartWidgetSelection.value,
      selectedWidget.value?.component.info.keyName || '',
      isTableWidgetSelection.value,
    )

  const loadDatasetFields = async (
    requestConfig: DatasetRequestConfig,
    requestId = activeRequestId.value,
    requestConfigOwner: ComponentDataConfig | null = editableConfig.value,
  ) => {
    if (!requestConfig.datasetProperty?.dataSourceId || !requestConfig.datasetProperty.tableName) {
      availableDatasetFields.value = []
      loadedDatasetKey.value = ''
      return
    }

    try {
      datasetFieldLoadError.value = ''
      const result = await loadRightDataPanelDatasetFields(requestConfig)
      // 请求切换或配置替换后，旧请求的字段不能写入当前请求的面板缓存。
      if (
        activeRequestId.value !== requestId ||
        activeRequestItem.value?.config !== requestConfigOwner ||
        editableConfig.value !== requestConfigOwner
      ) {
        return
      }
      availableDatasetFields.value = result.fields
      loadedDatasetKey.value = result.loadedKey
      refreshAvailableFields()
    } catch (error) {
      if (
        activeRequestId.value !== requestId ||
        activeRequestItem.value?.config !== requestConfigOwner ||
        editableConfig.value !== requestConfigOwner
      ) {
        return
      }
      availableDatasetFields.value = []
      loadedDatasetKey.value = ''
      datasetFieldLoadError.value = error instanceof Error ? error.message : '加载字段失败'
      refreshAvailableFields()
    }
  }

  const getBindingSourceField = (targetPath: string) =>
    resolveBindingSourceField(editableConfig.value?.bindings || [], targetPath)

  /**
   * 三维模型与三维组件只展示用户实际创建的映射项。
   * 与二维 widget 的固定目标集合不同，这里不会根据属性列表或数据字段自动补齐任何一行。
   */
  const objectManualMappingItems = computed(() =>
    createObjectManualMappingItems(editableConfig.value?.bindings || []),
  )

  /**
   * 三维目标字段快捷选项会排除前序请求已经占用的字段；自定义输入仍可直接录入，
   * 保存时由映射更新函数执行同一组件内的重复校验。
   */
  const objectManualBindingTargetOptions = computed(() => {
    const occupied = getActiveRequestOccupiedTargetFields()
    return RIGHT_DATA_PANEL_OBJECT_BINDINGS.filter((option) => !occupied.has(option.targetPath))
  })

  const getFieldStatus = (field: string) => resolveFieldStatus(field, availableFields.value)

  const statusClass = (status: string) => createFieldStatusClass(status)

  const preparePersistedConfig = () => {
    if (!editableConfig.value || hydrating.value) return
    if (editableConfig.value.request.type === 'static' && staticJsonError.value) return

    const preparedResult = prepareRightDataPanelPersistConfig({
      config: editableConfig.value,
      staticJsonText: staticJsonText.value,
      isMarkingSelection: selectionKind.value === 'marking',
      availableDatasetFields: availableDatasetFields.value,
      isChartWidgetSelection: isChartWidgetSelection.value,
      selectedChartComponent: selectedWidget.value?.component,
    })
    const prepared = preparedResult.preparedConfig
    if (preparedResult.staticJsonError) {
      staticJsonError.value = preparedResult.staticJsonError
      return
    }

    refreshAvailableFields()
    refreshDataContentDisplay()

    if (isChartWidgetSelection.value) {
      editableConfig.value = prepared
      autoFillActiveChartMapping(
        prepared,
        availableFields.value,
        selectedWidget.value?.component.info.keyName || '',
      )
    }

    syncActiveRequestItem()
    const duplicateTargetFields = getDuplicateTargetFields(getRequestItemsForTargetValidation())
    if (duplicateTargetFields.length > 0) {
      ElMessage.warning(`目标字段“${duplicateTargetFields.join('、')}”已被其它请求占用`)
      return
    }
    return buildRightDataPanelPersistedConfig(prepared, requestItems.value)
  }
  const persistConfig = () => {
    const config = preparePersistedConfig()
    if (config) setCurrentTargetDataConfig(config)
  }

  const draftOwner = () => ({
    host: getActiveSceneViewportHost(),
    sceneLoadRevision,
    selection: selectionKey.value,
    initialization: initializationRevision.value,
  })
  const isCurrentDraft = (owner: ReturnType<typeof draftOwner>) =>
    owner.host === getActiveSceneViewportHost() && owner.sceneLoadRevision === sceneLoadRevision &&
    owner.selection === selectionKey.value && owner.initialization === initializationRevision.value

  // 定时器只结算排程时的草稿，切换对象或同编号重载后不能拿新表单补写旧请求。
  const pendingPersist = debounce((owner: ReturnType<typeof draftOwner>) => {
    if (!editorSceneOperation.value && isCurrentDraft(owner)) persistConfig()
  }, 300)
  const persistSoon = () => pendingPersist(draftOwner())

  const pendingStaticValidation = debounce((owner: ReturnType<typeof draftOwner>, requestId: string) => {
    if (editorSceneOperation.value || !isCurrentDraft(owner) || activeRequestId.value !== requestId) return
    if (!editableConfig.value || editableConfig.value.request.type !== 'static') return
    const validation = validateRightDataPanelStaticPayload(
      staticJsonText.value,
      selectionKind.value === 'marking',
    )
    if (validation.isValid) {
      staticJsonError.value = ''
      persistSoon()
      return
    }
    staticJsonError.value = validation.errorMessage
  }, 400)
  const validateStaticJsonSoon = () => pendingStaticValidation(draftOwner(), activeRequestId.value)
  let committingPublicRequest = false
  const flushPendingConfig = () => {
    if (committingPublicRequest) return
    pendingStaticValidation.flush()
    pendingPersist.flush()
  }
  const stopBeforeOperation = subscribeEditorSceneBeforeOperation(flushPendingConfig)

  const commitPublicRequestChange = async (nextList: PublicRequestConfig[], publicRequestId: string | null) => {
    if (editorSceneOperation.value || hydrating.value) return false
    let binding: PublicRequestBindingChange | undefined
    if (editableConfig.value?.request.type === 'public') {
      const config = preparePersistedConfig()
      if (!config) return false
      const request = getDataConfigRequests(config).find(item => item.id === activeRequestId.value)
      if (!request || request.request.type !== 'public') return false
      request.request.config = { ...request.request.config, publicRequestId }
      syncDataConfigRequestMirror(config)
      if (selectedWidget.value) binding = { kind: 'widget', id: selectedWidget.value.id, dataConfig: config }
      else if (selectedSceneObject.value) binding = { kind: 'sceneObject', id: selectedSceneObject.value.id, dataConfig: config }
      else throw new Error('当前对象尚未接入场景草稿，无法联动公共接口')
    }
    // 当前请求的待提交字段随联合命令一起提交，避免门禁结算时再登记一条历史。
    pendingStaticValidation.cancel()
    pendingPersist.cancel()
    committingPublicRequest = true
    try {
      return await updateEditorScenePublicRequests(
        nextList, binding, publicRequestDialogVisible.value ? publicRequestGlobalDraft : undefined,
      )
    } finally {
      committingPublicRequest = false
    }
  }

  const syncPreviewFromLatestRaw = () => {
    if (!editableConfig.value || latestRequestRaw.value === null) return
    if (
      editableConfig.value.request.type !== 'ajax' &&
      editableConfig.value.request.type !== 'public'
    )
      return

    const transformed = syncRightDataPanelPreviewFromRaw(
      latestRequestRaw.value,
      editableConfig.value,
    )
    editableConfig.value.dataset.dimensions = transformed.dimensions
    editableConfig.value.dataset.source = transformed.source
    refreshAvailableFields()
    refreshDataContentDisplay()
  }

  const handleBindingFieldChange = (targetPath: BindingOption['targetPath'], value?: string) => {
    if (!editableConfig.value) return
    // 来源字段写入也必须校验目标字段；否则用户先填目标、后选来源时会绕过跨请求校验。
    if (value?.trim() && !isActiveRequestTargetFieldAvailable(targetPath)) {
      ElMessage.warning(`目标字段“${targetPath}”已被其它请求占用，请修改后再保存`)
      return
    }
    editableConfig.value.bindings = updateBindingField(
      editableConfig.value.bindings,
      targetPath,
      value,
      selectionKind.value,
    )
    persistSoon()
  }

  /** 新增空白人工行，不推断目标字段或来源字段。 */
  const addObjectManualBinding = () => {
    if (!editableConfig.value || selectionKind.value !== 'object') return
    editableConfig.value.bindings = appendCustomObjectBindingRule(editableConfig.value.bindings)
    persistSoon()
  }

  /**
   * 修改三维目标字段；重复目标保持当前配置不写入，避免后续运行时出现来源覆盖顺序不确定的问题。
   */
  const updateObjectManualBindingTarget = (itemKey: string, value: string) => {
    if (!editableConfig.value || selectionKind.value !== 'object') return
    const currentTarget = objectManualMappingItems.value.find(
      (item) => item.key === itemKey,
    )?.targetPath
    const targetPath = value.trim()
    if (!isActiveRequestTargetFieldAvailable(targetPath, currentTarget)) {
      ElMessage.warning(`目标字段“${targetPath}”已被其它请求占用，请修改后再保存`)
      return
    }
    const result = updateObjectManualBindingTargetPath(
      editableConfig.value.bindings,
      itemKey,
      value,
    )
    if (result.duplicateTargetPath) {
      ElMessage.warning(`目标字段“${result.duplicateTargetPath}”已存在，请修改后再保存`)
      return
    }
    editableConfig.value.bindings = result.bindings
    persistSoon()
  }

  /** 来源字段为空时同样写回人工行，确保用户暂存的映射编辑状态不会被清理。 */
  const updateObjectManualBindingSource = (itemKey: string, value?: string) => {
    if (!editableConfig.value || selectionKind.value !== 'object') return
    const targetPath =
      objectManualMappingItems.value.find((item) => item.key === itemKey)?.targetPath.trim() || ''
    // 三维人工映射允许先填目标再填来源，来源提交时补做一次跨请求唯一性校验。
    if (value?.trim() && targetPath && !isActiveRequestTargetFieldAvailable(targetPath)) {
      ElMessage.warning(`目标字段“${targetPath}”已被其它请求占用，请修改后再保存`)
      return
    }
    editableConfig.value.bindings = updateObjectManualBindingSourceField(
      editableConfig.value.bindings,
      itemKey,
      value,
    )
    persistSoon()
  }

  /** 修改二维控件或打点的自定义目标字段；目标字段为空时仅保留人工草稿。 */
  const updateFixedBindingTarget = (itemKey: string, value: string) => {
    if (
      !editableConfig.value ||
      (selectionKind.value !== 'widget' && selectionKind.value !== 'marking')
    ) {
      return
    }
    const current = editableConfig.value.bindings.find((binding) => {
      if (binding.kind !== 'widget' && binding.kind !== 'marking') return false
      return (
        binding.kind === selectionKind.value &&
        Boolean(binding.id) &&
        `${selectionKind.value}-custom:${binding.id}` === itemKey
      )
    })
    const currentTarget =
      current && (current.kind === 'widget' || current.kind === 'marking') ? current.targetPath : ''
    const targetPath = value.trim()
    if (!isActiveRequestTargetFieldAvailable(targetPath, currentTarget)) {
      ElMessage.warning(`目标字段“${targetPath}”已被其它请求占用，请修改后再保存`)
      return
    }
    const result = updateFixedBindingTargetPath(editableConfig.value.bindings, itemKey, value)
    if (result.duplicateTargetPath) {
      ElMessage.warning(`目标字段“${result.duplicateTargetPath}”已存在，请修改后再保存`)
      return
    }
    editableConfig.value.bindings = result.bindings
    persistSoon()
  }

  /** 修改二维控件或打点自定义行的来源字段，按稳定键定位而不是按空目标字段定位。 */
  const updateFixedBindingSource = (itemKey: string, value?: string) => {
    if (
      !editableConfig.value ||
      (selectionKind.value !== 'widget' && selectionKind.value !== 'marking')
    ) {
      return
    }
    const current = editableConfig.value.bindings.find(
      (binding) =>
        (binding.kind === 'widget' || binding.kind === 'marking') &&
        binding.id &&
        `${selectionKind.value}-custom:${binding.id}` === itemKey,
    )
    const targetPath =
      current && (current.kind === 'widget' || current.kind === 'marking')
        ? current.targetPath.trim()
        : ''
    // 固定组件、图标和打点的人工行同样支持先目标后来源，来源提交不能绕过唯一性校验。
    if (value?.trim() && targetPath && !isActiveRequestTargetFieldAvailable(targetPath)) {
      ElMessage.warning(`目标字段“${targetPath}”已被其它请求占用，请修改后再保存`)
      return
    }
    editableConfig.value.bindings = updateFixedBindingSourceField(
      editableConfig.value.bindings,
      itemKey,
      value,
    )
    persistSoon()
  }

  /** 所有可配置数据对象均支持手动增加自定义映射字段。 */
  const addFixedBinding = () => {
    if (
      !editableConfig.value ||
      (selectionKind.value !== 'widget' && selectionKind.value !== 'marking')
    ) {
      return
    }
    editableConfig.value.bindings = appendCustomFixedBindingRule(
      editableConfig.value.bindings,
      selectionKind.value,
    )
    persistSoon()
  }

  /** 删除当前三维人工映射行；打点仍使用其原有的必填位置映射规则。 */
  const removeObjectManualBinding = (itemKey: string) => {
    if (!editableConfig.value || selectionKind.value !== 'object') return
    editableConfig.value.bindings = removeObjectManualBindingRule(
      editableConfig.value.bindings,
      itemKey,
    )
    persistSoon()
  }

  /**
   * 删除二维控件或打点的固定目标映射。
   *
   * 这两类映射的目标集合由组件协议固定声明，删除后页面仍可显示空白目标行；真正重要的是
   * 清除当前请求绑定并记录用户删除的目标，防止字段刷新再次按同名字段自动创建绑定。
   */
  const removeFixedTargetBinding = (itemKey: string, targetPath: string) => {
    if (
      !editableConfig.value ||
      (selectionKind.value !== 'widget' && selectionKind.value !== 'marking')
    ) {
      return
    }

    editableConfig.value = recordDeletedAutoMappingTarget(editableConfig.value, targetPath)
    editableConfig.value.bindings = removeFixedBindingRule(editableConfig.value.bindings, itemKey)
    persistSoon()
  }

  const addChartMeasureField = () => {
    // 图表只公开两个自动数据槽位；阻止手动新增第三行，避免面板再次制造组件无法消费的字段。
    if (chartRule.value.measureFields.length >= CHART_AUTO_MEASURE_FIELD_LIMIT) {
      ElMessage.warning(`图表最多支持${CHART_AUTO_MEASURE_FIELD_LIMIT}个数据项`)
      return
    }
    chartRule.value = appendChartMeasureField(chartRule.value)
    persistSoon()
  }

  const removeChartMeasureField = (index: number) => {
    const rule = chartRule.value
    const targetField = getChartMeasureTargetFieldAt(rule, index)
    const origin = resolveChartMeasureFieldOrigins(rule)[index]
    if (origin === 'inferred' && editableConfig.value) {
      // 自动字段删除必须先记录目标名，字段刷新和请求测试才能持续跳过这条映射。
      editableConfig.value = recordDeletedAutoMappingTarget(editableConfig.value, targetField)
    }
    chartRule.value = removeChartMeasureFieldAt(rule, index)
    persistSoon()
  }

  /** 删除图表维度时同样写入请求级删除记录，维度和度量共用一套自动补齐保护规则。 */
  const removeChartDimension = () => {
    if (!editableConfig.value) return
    const removed = removeChartDimensionField(chartRule.value)
    editableConfig.value = recordDeletedAutoMappingTarget(editableConfig.value, removed.targetField)
    chartRule.value = removed.rule
    persistSoon()
  }

  const updateChartMeasureField = (index: number, value?: string) => {
    const targetField = getChartMeasureTargetFieldAt(chartRule.value, index)
    // 图表新增行可以先配置来源，但只要目标已填写，就必须在来源提交时检查其它请求。
    if (value?.trim() && targetField && !isActiveRequestTargetFieldAvailable(targetField)) {
      ElMessage.warning(`目标字段“${targetField}”已被其它请求占用，请修改后再保存`)
      return
    }
    chartRule.value = updateChartMeasureFieldAt(chartRule.value, index, value)
    persistSoon()
  }

  /** 人工新增项允许修改组件目标字段名；帮助函数会拒绝对自动识别项的写入。 */
  const updateChartTargetMeasureField = (index: number, value: string | number) => {
    const rule = chartRule.value
    const targetField = String(value).trim()
    const currentTarget = getChartMeasureTargetFieldAt(rule, index)
    const duplicateInCurrentRequest =
      Boolean(targetField) &&
      (rule.targetDimensionField?.trim() === targetField ||
        (rule.targetMeasureFields || []).some(
          (field, measureIndex) => measureIndex !== index && field.trim() === targetField,
        ))
    // 图表新增行不仅不能和其它请求重复，也不能覆盖当前图表的维度或其它度量行。
    if (duplicateInCurrentRequest) {
      ElMessage.warning(`目标字段“${targetField}”已存在，请修改后再保存`)
      return
    }
    if (!isActiveRequestTargetFieldAvailable(targetField, currentTarget)) {
      ElMessage.warning(`目标字段“${targetField}”已被其它请求占用，请修改后再保存`)
      return
    }
    chartRule.value = updateChartTargetMeasureFieldAt(rule, index, targetField)
    persistSoon()
  }

  const handleRequestTypeChange = (value: string | number | boolean | undefined) => {
    if (!editableConfig.value) return
    const requestType = String(value) as ComponentDataConfig['request']['type']
    const previousDatasetProperty = currentDatasetProperty.value
    const previousPublicId = currentPublicRequest.value?.id || null
    latestRequestRaw.value = null
    requestError.value = ''
    const switchedResult = switchRequestTypeConfig({
      currentConfig: editableConfig.value,
      nextRequestType: requestType,
      previousDatasetProperty,
      previousPublicId,
      isChartWidgetSelection: isChartWidgetSelection.value,
      selectedChartComponent: selectedWidget.value?.component,
    })
    editableConfig.value = switchedResult.nextConfig
    if (requestType === 'static') {
      staticJsonText.value = switchedResult.staticJsonText
    }

    refreshAvailableFields()
    refreshDataContentDisplay()
    persistSoon()
  }

  const intervalUnitLabel = (unit?: string | null) => {
    const labelMap: Record<string, string> = { second: '秒', minute: '分', hour: '时', day: '天' }
    return labelMap[unit || 'second'] || '秒'
  }

  const openAjaxConfigDialog = () => {
    ajaxConfigDialogVisible.value = true
  }

  const handleAjaxConfigConfirm = (config: AjaxRequestConfig) => {
    if (!editableConfig.value || editableConfig.value.request.type !== 'ajax') return
    editableConfig.value.request.config = config
    persistSoon()
  }

  const handleGlobalRequestConfigConfirm = (config: RequestGlobalConfig) => {
    if (publicRequestDialogVisible.value) {
      // 公共接口弹窗的默认配置随列表和绑定一起提交。
      publicRequestGlobalDraft = config
      return
    }
    updateEditorSceneRequestGlobalConfig(config)
  }

  const handleAjaxConfigSend = () => {
    void handleTestRequest()
  }

  const handleTestRequest = async () => {
    if (!editableConfig.value) return
    /**
     * 过滤器、映射删除等动作可能替换 `editableConfig` 引用，而防抖持久化尚未执行。
     * 发送请求前立即同步活动项，保证本次请求读取最新过滤器，也保证返回后的归属校验不会把
     * 用户刚发起的有效响应误判为旧请求。这里只更新当前最多五项列表中的一项，不产生额外请求。
     */
    syncActiveRequestItem()
    const requestId = activeRequestId.value
    const requestConfigOwner = editableConfig.value
    try {
      requestError.value = ''
      const result = await executeRightDataPanelTestRequest(
        requestConfigOwner,
        sceneRequestStore.scenePublicRequestList,
        sceneRequestStore.sceneRequestGlobalConfig,
        selectionKind.value === 'marking',
        { sceneId: scenePlatformStore.value?.getScene().id },
      )
      // 异步请求返回时若面板已经切换，请求结果必须丢弃，不能写入新的活动请求。
      if (
        activeRequestId.value !== requestId ||
        activeRequestItem.value?.config !== requestConfigOwner ||
        editableConfig.value !== requestConfigOwner
      ) {
        return
      }
      latestRequestRaw.value = result.raw
      editableConfig.value.dataset.dimensions = result.dimensions
      editableConfig.value.dataset.source = result.source
      if (result.markingDataError) {
        requestError.value = result.markingDataError
        return
      }
      refreshAvailableFields()
      refreshDataContentDisplay()
      if (isChartWidgetSelection.value) {
        autoFillActiveChartMapping(
          editableConfig.value,
          availableFields.value,
          selectedWidget.value?.component.info.keyName || '',
        )
      }
      persistSoon()
      ElMessage.success('请求成功')
    } catch (error) {
      // 旧请求失败也不能污染当前请求的错误状态。
      if (
        activeRequestId.value !== requestId ||
        activeRequestItem.value?.config !== requestConfigOwner ||
        editableConfig.value !== requestConfigOwner
      ) {
        return
      }
      /**
       * “发送请求”是用户显式触发的校验动作，失败必须同时反馈到面板状态和消息提示。
       * 之前只写入 requestError，且下层会吞掉请求异常，导致 500 / 跨域失败仍可能显示成功。
       * 这里统一使用下层抛出的可读错误，保证请求失败不会被误认为配置保存成功。
       */
      const errorMessage = error instanceof Error ? error.message : '请求失败'
      requestError.value = errorMessage
      ElMessage.error(errorMessage)
    }
  }

  const {
    handlePublicRequestSelect,
    openPublicRequestDialog,
    handlePublicRequestConfigConfirm,
    handlePublicRequestSend,
    deleteCurrentPublicRequest,
    removeFilterFn,
    handleFilterConfirm,
    openDatasetDialog,
    clearDatasetProperty,
    handleDatasetPropertyConfirm,
    triggerImport,
    handleImportFile,
    downloadCurrentJson,
  } = createRightDataPanelUiActions({
    editableConfig,
    latestRequestRaw,
    setPublicRequestConfig: (config) => {
      publicRequestConfig.value = config
    },
    currentPublicRequest,
    publicRequestDraft,
    publicRequestDialogVisible,
    scenePublicRequestList: computed(() => sceneRequestStore.scenePublicRequestList),
    commitPublicRequestChange,
    capturePublicRequestTarget: () => {
      const owner = draftOwner()
      const requestId = activeRequestId.value
      return () => isCurrentDraft(owner) && activeRequestId.value === requestId
    },
    persistSoon,
    handleTestRequest,
    fileInputRef,
    staticJsonText,
    dataContentDisplay,
    availableDatasetFields,
    loadedDatasetKey,
    datasetDialogRef,
    currentDatasetProperty,
    syncPreviewFromLatestRaw,
  })

  /**
   * 选中态初始化与各类联动监听统一交给独立注册器管理。
   * 主组合函数只暴露状态和动作，避免 watch 编排继续把文件体积推高。
   */
  registerRightDataPanelWatchers({
    availableFields,
    editableConfig,
    hydrating,
    initializationRevision,
    isChartWidgetSelection,
    selectedWidget,
    ensureChartRuleBinding,
    autoFillChartMapping: autoFillActiveChartMapping,
    selectionKey,
    refreshToken: sceneObjectRefreshToken,
    requestError,
    staticJsonError,
    datasetFieldLoadError,
    availableDatasetFields,
    latestRequestRaw,
    getSelectedConfig: () =>
      normalizeDataConfig(getCurrentTargetDataConfig()) || createDefaultConfigForSelection(),
    initializeSelectionState: async (selected) => {
      const currentInitializationRevision = initializationRevision.value
      requestItems.value = normalizeDataPanelRequestItems(selected)
      const isSameSelection = initializedRequestSelectionKey.value === selectionKey.value
      const preservedActiveId = isSameSelection ? activeRequestId.value : ''
      const preservedExpandedId = isSameSelection ? expandedRequestId.value : ''
      const persistedExpandedItem = requestItems.value.find((item) => !item.collapsed)
      const activeItem =
        requestItems.value.find((item) => item.id === preservedActiveId) ||
        persistedExpandedItem ||
        requestItems.value[0]
      activeRequestId.value = activeItem?.id || ''

      /**
       * 同一对象的刷新完整保留内存展开状态，空字符串即“全部收起”。
       * 若此前展开项已被删除，退回到当前活动项；新对象则使用持久化项或请求1。
       */
      const resolvedExpandedId = isSameSelection
        ? requestItems.value.some((item) => item.id === preservedExpandedId)
          ? preservedExpandedId
          : ''
        : (persistedExpandedItem || activeItem)?.id || ''
      setExpandedRequestId(resolvedExpandedId || null)
      initializedRequestSelectionKey.value = selectionKey.value
      const initialState = initializeRightDataPanelState({
        selectedConfig: activeItem?.config || selected,
        isChartWidgetSelection: isChartWidgetSelection.value,
        selectedChartComponent: selectedWidget.value?.component,
        availableFields: availableFields.value,
      })

      editableConfig.value = initialState.editableConfig
      staticJsonText.value = initialState.staticJsonText

      if (initialState.shouldLoadDatasetFields) {
        // 根对象的 `selected.request` 是兼容镜像，始终代表请求1；字段加载必须使用活动请求。
        await loadDatasetFields(
          activeItem.config.request.config as DatasetRequestConfig,
          activeItem.id,
          activeItem.config,
        )
      }

      // 无论是否加载数据集字段，旧一轮初始化都不得继续修改当前请求的映射和预览。
      if (currentInitializationRevision !== initializationRevision.value) return

      if (initialState.shouldAutoFillChartMapping) {
        /**
         * 初始化只处理当前活动请求；直接对根配置补齐会误写请求1，并让后续请求重新出现
         * 已占用目标字段。活动项已经在上方确定，因此这里不能再使用 `selected`。
         */
        autoFillActiveChartMapping(
          activeItem.config,
          availableFields.value,
          selectedWidget.value?.component.info.keyName || '',
        )
      }

      refreshAvailableFields()
      refreshDataContentDisplay()
    },
    staticJsonText,
    validateStaticJsonSoon,
    loadedDatasetKey,
    refreshAvailableFields,
    loadDatasetFields,
  })

  onMounted(() => {
    stopScenePlatformHostSubscription = subscribeActiveSceneViewportHost((host) => {
      subscribeScenePlatformStore(host?.getStore() ?? null)
    })
  })

  onBeforeUnmount(() => {
    // 切换到事件页签前提交待保存映射；必须先于清空平台仓库，避免延迟回调
    // 回退写入旧模型数据，导致事件仍从平台元数据读到请求1的旧配置。
    stopBeforeOperation()
    flushPendingConfig()
    pendingStaticValidation.cancel()
    pendingPersist.cancel()
    stopScenePlatformHostSubscription?.()
    stopScenePlatformHostSubscription = null
    stopScenePlatformStoreSubscription?.()
    stopScenePlatformStoreSubscription = null
    scenePlatformStore.value = null
  })

  return {
    sceneRequestStore,
    recordPaginationWidget,
    recordPaginationBinding,
    recordPaginationDataConfig,
    updateRecordPaginationBinding,
    editableConfig,
    requestItems,
    activeRequestId,
    expandedRequestId,
    activeRequestIndex,
    activeRequestItem,
    isRequestExpanded,
    selectRequestItem,
    toggleRequestItem,
    addRequestItem,
    removeRequestItem,
    staticJsonText,
    staticJsonError,
    requestError,
    availableDatasetFields,
    datasetFieldLoadError,
    latestRequestRaw,
    fileInputRef,
    datasetDialogRef,
    publicRequestDialogVisible,
    ajaxConfigDialogVisible,
    filterEditorVisible,
    publicRequestDraft,
    availableFields,
    dataContentDisplay,
    selectionKind,
    isChartWidgetSelection,
    isThreeMapSelection,
    isTableWidgetSelection,
    requestTypeOptions,
    mappingSectionTitle,
    mappingHeadLabel,
    targetBindings,
    currentDatasetProperty,
    currentPublicRequest,
    ajaxRequestConfig,
    resolvedAjaxRequestConfig,
    publicRequestConfig,
    publicRequestOptions,
    chartRule,
    showRequestTest,
    showFilterSection,
    markingPositionReady,
    currentRequestConfig,
    getBindingSourceField,
    objectManualMappingItems,
    objectManualBindingTargetOptions,
    chartManualBindingTargetOptions,
    fixedManualBindingTargetOptions,
    getFieldStatus,
    statusClass,
    handleBindingFieldChange,
    addObjectManualBinding,
    updateObjectManualBindingTarget,
    updateObjectManualBindingSource,
    updateFixedBindingTarget,
    updateFixedBindingSource,
    removeObjectManualBinding,
    removeFixedTargetBinding,
    addFixedBinding,
    addChartMeasureField,
    removeChartDimension,
    removeChartMeasureField,
    updateChartMeasureField,
    updateChartTargetMeasureField,
    handleRequestTypeChange,
    intervalUnitLabel,
    openAjaxConfigDialog,
    handleAjaxConfigConfirm,
    handleGlobalRequestConfigConfirm,
    handleAjaxConfigSend,
    removeFilterFn,
    handleFilterConfirm,
    openDatasetDialog,
    clearDatasetProperty,
    handleDatasetPropertyConfirm,
    handleTestRequest,
    handlePublicRequestSelect,
    openPublicRequestDialog,
    handlePublicRequestConfigConfirm,
    handlePublicRequestSend,
    deleteCurrentPublicRequest,
    triggerImport,
    handleImportFile,
    downloadCurrentJson,
    persistSoon,
  }
}
