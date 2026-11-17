import { cloneDeep } from 'lodash-es'
import type {
  AjaxRequestConfig,
  ComponentDataConfig,
  DatasetRequestConfig,
  PublicRequestConfig,
} from '@/types/data-config'
import type { DatasetProperty } from '@/types/threeScene'
import { buildChartEditorContent } from '@/utils/dataConfig'
import {
  normalizePublicRequestName,
  resolvePublicRequestName,
} from '@/utils/dataConfig/publicRequestName'
import { createEmptyAdapterRequest, createEmptyAjaxRequest, createEmptyPublicRequest } from './rightDataPanelDataHelpers'

export interface SwitchRequestTypeOptions {
  currentConfig: ComponentDataConfig
  nextRequestType: ComponentDataConfig['request']['type']
  previousDatasetProperty: DatasetProperty | null
  previousPublicId: string | null
  isChartWidgetSelection: boolean
  selectedChartComponent?: Parameters<typeof buildChartEditorContent>[0]
}

export interface SwitchRequestTypeResult {
  nextConfig: ComponentDataConfig
  staticJsonText: string
}

/**
 * 合并公共接口草稿与本次弹窗确认值。
 *
 * 二次编辑时，草稿中的正式 `name` 仍可能是旧值，而弹窗会把用户刚输入的名称随
 * `requestName` 一起提交。若直接合并后再按“正式字段优先”归一化，旧 `name` 会错误覆盖
 * 新 `requestName`。这里明确让本次提交值优先，并只深复制一次，保证下拉列表立即消费新名称。
 */
function mergeConfirmedPublicRequest(
  draft: PublicRequestConfig,
  config: AjaxRequestConfig,
  confirmedName?: string,
): PublicRequestConfig {
  const normalizedName = resolveConfirmedPublicRequestName(draft, config, confirmedName)
  return normalizePublicRequestName(
    cloneDeep({
      ...draft,
      ...config,
      /** 正式字段与旧协议兼容字段同时写入，禁止后续加载再次产生名称分叉。 */
      name: normalizedName,
      requestName: normalizedName,
    }),
  )
}

/**
 * 解析一次公共接口确认动作真正提交的名称。
 *
 * `confirmedName` 是弹窗随确认事件原子提交的新值，优先级最高；未提供时才兼容旧入口写入的
 * `requestName`。通用读取器仍保持正式 `name` 优先，避免改变历史场景加载规则。
 */
function resolveConfirmedPublicRequestName(
  draft: PublicRequestConfig,
  config: AjaxRequestConfig,
  confirmedName?: string,
): string {
  if (confirmedName !== undefined) return confirmedName.trim()

  const legacyConfirmedName =
    typeof config.requestName === 'string' ? config.requestName.trim() : ''
  return legacyConfirmedName || resolvePublicRequestName(config) || resolvePublicRequestName(draft)
}

/**
 * 将已完成归一化的公共接口写入列表。
 * 内部函数不再深复制，确认链路可复用同一份结果，避免一次保存重复处理完整请求参数。
 */
function upsertConfirmedPublicRequest(
  list: PublicRequestConfig[],
  nextDraft: PublicRequestConfig,
): PublicRequestConfig[] {
  const nextList = [...list]
  const index = nextList.findIndex((item) => item.id === nextDraft.id)
  if (index >= 0) {
    nextList.splice(index, 1, nextDraft)
  } else {
    nextList.unshift(nextDraft)
  }
  return nextList
}

/**
 * 构建切换请求类型后的新配置。
 * 这里集中处理静态、数据集、动态请求、公共接口四种分支，避免组件里散落切换逻辑。
 */
export function switchRequestTypeConfig(
  options: SwitchRequestTypeOptions,
): SwitchRequestTypeResult {
  const nextConfig = cloneDeep(options.currentConfig)
  nextConfig.request.type = options.nextRequestType

  let staticJsonText = ''
  if (options.nextRequestType === 'static') {
    nextConfig.request.config = { data: nextConfig.dataset.source }
    staticJsonText =
      options.isChartWidgetSelection && options.selectedChartComponent
        ? JSON.stringify(
            buildChartEditorContent(options.selectedChartComponent, nextConfig) ?? [],
            null,
            2,
          )
        : JSON.stringify(nextConfig.dataset.source, null, 2)
  } else if (options.nextRequestType === 'dataset') {
    nextConfig.request.config = createDatasetRequestConfig(options.previousDatasetProperty)
  } else if (options.nextRequestType === 'ajax') {
    nextConfig.request.config = createEmptyAjaxRequest()
  } else if (options.nextRequestType === 'public') {
    nextConfig.request.config = { publicRequestId: options.previousPublicId }
  } else if (options.nextRequestType === 'adapter') {
    nextConfig.request.config = createEmptyAdapterRequest()
  }

  return { nextConfig, staticJsonText }
}

/**
 * 创建数据集请求配置。
 * 保持数据集请求对象结构稳定，便于回填和清空走同一条路径。
 */
export function createDatasetRequestConfig(
  datasetProperty: DatasetProperty | null,
): DatasetRequestConfig {
  return { datasetProperty }
}

/**
 * 将过滤器写入当前请求配置。
 *
 * 多请求面板的 `editableConfig` 与活动请求项共享同一个配置引用，请求返回时也会用该引用
 * 判断结果是否仍属于当前请求。因此这里必须原地更新，不能通过展开运算创建新对象；否则用户
 * 保存过滤器后立即发送请求时，活动请求项仍指向旧对象，本次有效响应会被防串写校验误丢弃。
 * 空字符串会被归一成 undefined，统一表达“无过滤器”。
 */
export function assignFilterFn(
  config: ComponentDataConfig,
  filterFn?: string,
): ComponentDataConfig {
  config.filterFn = filterFn || undefined
  return config
}

/**
 * 把公共接口草稿写回列表。
 * 已存在同 id 项时替换，否则插到列表头部，保持新建接口优先可见。
 */
export function upsertPublicRequest(
  list: PublicRequestConfig[],
  draft: PublicRequestConfig,
  config: AjaxRequestConfig,
): PublicRequestConfig[] {
  /** 弹窗确认值必须覆盖草稿旧名称，避免二次编辑后列表仍显示保存前的标签。 */
  const nextDraft = mergeConfirmedPublicRequest(draft, config)
  return upsertConfirmedPublicRequest(list, nextDraft)
}

/**
 * 删除指定公共接口。
 * 当目标不存在时返回原列表，避免无意义的新数组写回。
 */
export function removePublicRequestById(
  list: PublicRequestConfig[],
  requestId?: string | null,
): PublicRequestConfig[] {
  if (!requestId) return list
  const nextList = list.filter((item) => item.id !== requestId)
  return nextList.length === list.length ? list : nextList
}

/**
 * 为公共接口弹窗生成初始草稿。
 * 编辑态深拷贝已有接口；新建态则返回全新的默认请求草稿。
 */
export function createPublicRequestDraft(target?: PublicRequestConfig | null): PublicRequestConfig {
  return target ? cloneDeep(target) : createEmptyPublicRequest()
}

export interface ConfirmPublicRequestDraftOptions {
  currentList: PublicRequestConfig[]
  draft: PublicRequestConfig
  config: AjaxRequestConfig
  /** 弹窗本次提交的名称；与请求配置同一次事件传递，避免依赖独立更新事件的执行顺序。 */
  confirmedName?: string
  shouldBindSelectedPublicRequest: boolean
}

export interface ConfirmPublicRequestDraftResult {
  nextList: PublicRequestConfig[]
  nextDraft: PublicRequestConfig
  nextSelectedPublicRequestId: string | null
}

export interface CommitPublicRequestDraftResult extends ConfirmPublicRequestDraftResult {
  warningMessage: string
}

/**
 * 确认公共接口草稿并返回下一步状态。
 *
 * 组件层只需要根据结果回写列表、当前草稿和选中引用，
 * 不再重复拼装“新增/编辑后是否绑定到当前 dataConfig”的判断。
 */
export function confirmPublicRequestDraft(
  options: ConfirmPublicRequestDraftOptions,
): ConfirmPublicRequestDraftResult {
  /**
   * 不依赖 `update:name` 与 `confirm` 的事件先后：即使父级草稿还保留旧名称，
   * 本次确认配置中的新名称也会优先成为正式名称并写回列表。
   */
  const nextDraft = mergeConfirmedPublicRequest(
    options.draft,
    options.config,
    options.confirmedName,
  )
  return {
    nextList: upsertConfirmedPublicRequest(options.currentList, nextDraft),
    nextDraft,
    nextSelectedPublicRequestId: options.shouldBindSelectedPublicRequest ? nextDraft.id : null,
  }
}

/**
 * 在真正写回公共接口列表前，先统一完成名称校验与结果包装。
 *
 * 组件层只需要判断是否存在 warningMessage，
 * 然后按返回结果批量写回 Store 和当前选中引用即可。
 */
export function commitPublicRequestDraft(
  options: ConfirmPublicRequestDraftOptions,
): CommitPublicRequestDraftResult {
  const confirmedName = resolveConfirmedPublicRequestName(
    options.draft,
    options.config,
    options.confirmedName,
  )
  if (!confirmedName) {
    return {
      nextList: options.currentList,
      nextDraft: options.draft,
      nextSelectedPublicRequestId: null,
      warningMessage: '请输入公共接口名称',
    }
  }

  return {
    /** 复用已规范化名称，确保校验值与最终写入值完全一致。 */
    ...confirmPublicRequestDraft({ ...options, confirmedName }),
    warningMessage: '',
  }
}

export interface DeletePublicRequestOptions {
  currentList: PublicRequestConfig[]
  currentRequestId?: string | null
  shouldClearSelectedPublicRequest: boolean
}

export interface DeletePublicRequestResult {
  nextList: PublicRequestConfig[]
  nextSelectedPublicRequestId: string | null
}

/**
 * 删除公共接口并返回删除后的联动结果。
 *
 * 当前面板如果正引用被删接口，需要同步清空引用；否则保持原状态不动。
 */
export function deletePublicRequest(
  options: DeletePublicRequestOptions,
): DeletePublicRequestResult {
  return {
    nextList: removePublicRequestById(options.currentList, options.currentRequestId),
    nextSelectedPublicRequestId: options.shouldClearSelectedPublicRequest ? null : null,
  }
}

/**
 * 删除当前公共接口并统一处理“空选中”场景。
 *
 * 这样组件层不需要重复判断当前是否真的存在选中接口，
 * 可以直接消费一个稳定的删除结果对象。
 */
export function deleteCurrentRightDataPanelPublicRequest(
  options: DeletePublicRequestOptions,
): DeletePublicRequestResult | null {
  if (!options.currentRequestId) return null
  return deletePublicRequest(options)
}
