import { ElMessage } from 'element-plus'
import { nextTick, type ComputedRef, type Ref } from 'vue'
import type {
  AjaxRequestConfig,
  ComponentDataConfig,
  PublicRequestConfig,
  PublicRequestReferenceConfig,
} from '@/types/data-config'
import type { DatasetProperty } from '@/types/threeScene'
import {
  assignFilterFn,
  commitPublicRequestDraft,
  createPublicRequestDraft,
  deleteCurrentRightDataPanelPublicRequest,
} from './rightDataPanelRequestHelpers'
import {
  applyRightDataPanelDatasetProperty,
  clearRightDataPanelDatasetRequest,
  createRightDataPanelDownloadSnapshot,
  createRightDataPanelPublicRequestReference,
  downloadRightDataPanelJson,
  readRightDataPanelImportFile,
  triggerRightDataPanelFileInput,
} from './rightDataPanelActionHelpers'

interface CreateRightDataPanelUiActionOptions {
  editableConfig: Ref<ComponentDataConfig | null>
  latestRequestRaw: Ref<unknown>
  setPublicRequestConfig: (config: PublicRequestReferenceConfig) => void
  currentPublicRequest: ComputedRef<PublicRequestConfig | null>
  publicRequestDraft: PublicRequestConfig
  publicRequestDialogVisible: Ref<boolean>
  scenePublicRequestList: ComputedRef<PublicRequestConfig[]>
  commitPublicRequestChange: (nextList: PublicRequestConfig[], publicRequestId: string | null) => Promise<boolean>
  capturePublicRequestTarget: () => (() => boolean)
  persistSoon: () => void
  handleTestRequest: () => Promise<void>
  fileInputRef: Ref<HTMLInputElement | null>
  staticJsonText: Ref<string>
  dataContentDisplay: Ref<string>
  availableDatasetFields: Ref<string[]>
  loadedDatasetKey: Ref<string>
  datasetDialogRef: Ref<{ showDialog: (datasetProperty?: DatasetProperty | null) => Promise<void> } | null>
  currentDatasetProperty: ComputedRef<DatasetProperty | null>
  syncPreviewFromLatestRaw: () => void
}

/**
 * 聚合右侧数据面板里与“界面动作”强相关的一组处理器。
 *
 * 这些动作本身不负责推导响应式状态，只负责响应按钮、弹窗和导入导出行为。
 * 单独抽出来后，主组合函数可以专注在状态装配与数据流编排，不再被一串 UI 动作函数撑大。
 */
export const createRightDataPanelUiActions = (
  options: CreateRightDataPanelUiActionOptions,
) => {
  let dialogTargetIsCurrent: (() => boolean) | undefined
  const handlePublicRequestSelect = (value: string | number | boolean | undefined) => {
    options.setPublicRequestConfig(createRightDataPanelPublicRequestReference(value))
    options.latestRequestRaw.value = null
    options.persistSoon()
  }

  const openPublicRequestDialog = (target?: PublicRequestConfig | null) => {
    dialogTargetIsCurrent = options.capturePublicRequestTarget()
    Object.assign(options.publicRequestDraft, createPublicRequestDraft(target))
    options.publicRequestDialogVisible.value = true
  }

  /**
   * 名称与请求配置由弹窗同一次确认事件提交。
   * 显式名称参数用于区分“本次输入”与配置对象中可能残留的旧 name 字段。
   */
  const handlePublicRequestConfigConfirm = async (
    config: AjaxRequestConfig,
    confirmedName?: string,
  ) => {
    if (!dialogTargetIsCurrent?.()) {
      ElMessage.warning('编辑对象已切换，请重新打开公共接口配置')
      return
    }
    const result = commitPublicRequestDraft({
      currentList: options.scenePublicRequestList.value,
      draft: options.publicRequestDraft,
      config,
      confirmedName,
      shouldBindSelectedPublicRequest: options.editableConfig.value?.request.type === 'public',
    })
    if (result.warningMessage) {
      ElMessage.warning(result.warningMessage)
      return
    }

    try {
      if (!await options.commitPublicRequestChange(result.nextList, result.nextSelectedPublicRequestId)) return
      Object.assign(options.publicRequestDraft, result.nextDraft)
      options.publicRequestDialogVisible.value = false
      // 等待联合写入后的表单回读，再使用最新的请求和接口配置发送。
      await nextTick()
      void options.handleTestRequest()
    } catch (error) {
      ElMessage.warning(error instanceof Error ? error.message : '无法保存公共接口')
    }
  }

  const handlePublicRequestSend = () => {
    if (!options.editableConfig.value || options.editableConfig.value.request.type !== 'public') return
    void options.handleTestRequest()
  }

  const deleteCurrentPublicRequest = async () => {
    const result = deleteCurrentRightDataPanelPublicRequest({
      currentList: options.scenePublicRequestList.value,
      currentRequestId: options.currentPublicRequest.value?.id,
      shouldClearSelectedPublicRequest: options.editableConfig.value?.request.type === 'public',
    })
    if (!result) return

    try {
      await options.commitPublicRequestChange(result.nextList, result.nextSelectedPublicRequestId)
    } catch (error) {
      ElMessage.warning(error instanceof Error ? error.message : '无法删除公共接口')
    }
  }

  const removeFilterFn = () => {
    if (!options.editableConfig.value) return
    options.editableConfig.value = assignFilterFn(options.editableConfig.value)
    options.syncPreviewFromLatestRaw()
    options.persistSoon()
  }

  const handleFilterConfirm = (filterFn: string, previewPayload?: unknown) => {
    if (!options.editableConfig.value) return
    options.editableConfig.value = assignFilterFn(options.editableConfig.value, filterFn)
    if (previewPayload !== null && previewPayload !== undefined) {
      options.latestRequestRaw.value = previewPayload
    }
    options.syncPreviewFromLatestRaw()
    options.persistSoon()
  }

  const openDatasetDialog = () => {
    options.datasetDialogRef.value?.showDialog(options.currentDatasetProperty.value)
  }

  const clearDatasetProperty = () => {
    if (!options.editableConfig.value) return
    const nextState = clearRightDataPanelDatasetRequest()
    options.editableConfig.value.request.config = nextState.requestConfig
    options.availableDatasetFields.value = nextState.availableDatasetFields
    options.loadedDatasetKey.value = nextState.loadedDatasetKey
    options.persistSoon()
  }

  const handleDatasetPropertyConfirm = (datasetProperty: DatasetProperty) => {
    if (!options.editableConfig.value) return
    options.editableConfig.value.request.config = applyRightDataPanelDatasetProperty(datasetProperty)
    options.persistSoon()
  }

  const triggerImport = () => {
    triggerRightDataPanelFileInput(options.fileInputRef.value)
  }

  const handleImportFile = async (event: Event) => {
    const importedText = await readRightDataPanelImportFile(event)
    if (importedText === null) return
    options.staticJsonText.value = importedText
  }

  const downloadCurrentJson = () => {
    const payload = createRightDataPanelDownloadSnapshot(
      options.editableConfig.value?.request.type,
      options.staticJsonText.value,
      options.dataContentDisplay.value,
    )
    downloadRightDataPanelJson(payload)
  }

  return {
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
  }
}
