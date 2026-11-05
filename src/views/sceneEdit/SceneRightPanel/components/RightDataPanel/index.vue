<template>
  <!-- 数据页签复用右侧属性外壳的唯一滚动容器，避免再次叠加 100% 高度和内边距。 -->
  <div
    class="scene-edit-property-content scene-edit-right-data-panel"
    data-scene-right-panel="true"
    :inert="Boolean(editorSceneOperation) || undefined"
  >
    <template v-if="editableConfig && selectionKind !== 'none'">
      <!-- 成对翻页仍使用现有请求面板；此区域只保存分页参数和响应路径的适配关系。 -->
      <RecordPaginationDataPanel
        v-if="recordPaginationWidget && recordPaginationBinding && recordPaginationDataConfig"
        :key="recordPaginationWidget.id"
        :binding="recordPaginationBinding"
        :config="recordPaginationDataConfig"
        :public-requests="sceneRequestStore.scenePublicRequestList"
        @update:binding="updateRecordPaginationBinding"
      />
      <!-- 请求项列表：名称按顺序自动生成，内部使用稳定 id，折叠只影响当前面板展示。 -->
      <section class="request-items-panel">
        <div class="request-items-panel__header">
          <span class="panel-title">数据请求</span>
          <ScenePropertyButton
            class="scene-edit-right-data-panel__header-action"
            size="small"
            :disabled="requestItems.length >= 5"
            @click="addRequestItem"
          >
            添加请求
          </ScenePropertyButton>
        </div>
        <div class="request-items-panel__list">
          <div
            v-for="item in requestItems"
            :key="item.id"
            :class="['request-item-tab', { 'is-active': item.id === activeRequestId }]"
          >
            <button
              type="button"
              class="request-item-tab__select"
              @click="selectRequestItem(item.id)"
            >
              <span class="request-item-tab__title">{{ item.name }}</span>
              <span class="request-item-tab__type">{{
                requestTypeLabel(item.config.request.type)
              }}</span>
            </button>
            <button
              type="button"
              class="request-item-tab__collapse"
              :aria-label="isRequestExpanded(item.id) ? '折叠请求' : '展开请求'"
              @click.stop="toggleRequestItem(item.id)"
            >
              <el-icon
                :class="[
                  'request-item-tab__arrow',
                  { 'is-collapsed': !isRequestExpanded(item.id) },
                ]"
              >
                <ArrowDown />
              </el-icon>
            </button>
            <el-tooltip v-if="requestItems.length > 1" content="删除请求" placement="top">
              <button
                type="button"
                class="request-item-tab__remove"
                aria-label="删除请求"
                @click.stop="removeRequestItem(item.id)"
              >
                <el-icon><Delete /></el-icon>
              </button>
            </el-tooltip>
          </div>
        </div>
      </section>

      <template v-if="activeRequestItem && isRequestExpanded(activeRequestItem.id)">
        <section class="panel-block">
          <!-- 请求来源选择只有一层语义，标题直接承担字段说明，避免重复显示“请求方式”。 -->
          <div class="panel-title">请求方式</div>
          <ScenePropertySelect
            v-model="editableConfig.request.type"
            @change="handleRequestTypeChange"
          >
            <el-option
              v-for="item in requestTypeOptions"
              :key="item.value"
              :label="item.label"
              :value="item.value"
            />
          </ScenePropertySelect>
        </section>

        <section
          v-if="editableConfig.request.type === 'ajax'"
          class="panel-block panel-block--figma-divider"
        >
          <div class="request-card request-card--summary">
            <div class="request-card__header">
              <span class="panel-title">动态请求</span>
              <ScenePropertyButton
                class="scene-edit-right-data-panel__header-action"
                size="small"
                @click="openAjaxConfigDialog"
              >
                编辑配置
              </ScenePropertyButton>
            </div>

            <!--
            Figma 明确将弹窗外的请求配置定义为只读摘要。这里使用语义化文字行而非禁用输入框，
            既避免产生“可以直接编辑”的误导，也让值列在面板拉宽后自然吸收剩余空间。
          -->
            <dl class="request-summary">
              <div class="request-summary__row">
                <dt>请求类型</dt>
                <dd>普通请求</dd>
              </div>
              <div class="request-summary__row">
                <dt>请求方式</dt>
                <dd>{{ ajaxRequestConfig.requestHttpType || '暂无' }}</dd>
              </div>
              <div class="request-summary__row">
                <dt>轮询间隔</dt>
                <dd>
                  {{ resolvedAjaxRequestConfig.requestInterval ?? 0
                  }}{{ intervalUnitLabel(resolvedAjaxRequestConfig.requestIntervalUnit) }}
                </dd>
              </div>
              <div class="request-summary__row">
                <dt>源地址</dt>
                <dd>{{ resolvedAjaxRequestConfig.requestOriginUrl || '暂无' }}</dd>
              </div>
              <div class="request-summary__row">
                <dt>组件地址</dt>
                <dd>{{ resolvedAjaxRequestConfig.requestUrl || '暂无' }}</dd>
              </div>
            </dl>
          </div>
        </section>

        <section
          v-if="editableConfig.request.type === 'public'"
          class="panel-block panel-block--figma-divider"
        >
          <div class="public-request">
            <div class="panel-title">公共接口</div>

            <!--
            公共接口是 Figma 定义的独立复合区块：名称使用共享下拉框，地址只做只读文字摘要。
            两行共用 65px 标签列和弹性内容列，右侧面板拉宽时只扩展内容列，不重复查询接口数据。
          -->
            <div class="public-request__body">
              <div class="public-request__row">
                <span class="public-request__label">请求名称</span>
                <ScenePropertySelect
                  :model-value="publicRequestConfig.publicRequestId"
                  placeholder="选择公共接口"
                  clearable
                  filterable
                  @change="handlePublicRequestSelect"
                >
                  <!--
                  选项文本统一取组合函数已归一的名称，兼容旧场景 `requestName`。
                  下拉框只消费轻量选项数组，避免模板内重复处理公共接口完整配置。
                -->
                  <el-option
                    v-for="item in publicRequestOptions"
                    :key="item.value"
                    :label="item.label"
                    :value="item.value"
                  />
                </ScenePropertySelect>
              </div>
              <div class="public-request__row">
                <span class="public-request__label">接口地址</span>
                <div class="public-request__address" :title="publicRequestAddress">
                  {{ publicRequestAddress }}
                </div>
              </div>
            </div>

            <div class="public-request__actions">
              <ScenePropertyButton
                class="public-request__action is-accent"
                size="small"
                @click="openPublicRequestDialog()"
              >
                新增接口
              </ScenePropertyButton>
              <ScenePropertyButton
                class="public-request__action"
                size="small"
                :disabled="!currentPublicRequest"
                @click="openPublicRequestDialog(currentPublicRequest)"
              >
                编辑接口
              </ScenePropertyButton>
              <ScenePropertyButton
                class="public-request__action"
                size="small"
                :disabled="!currentPublicRequest"
                @click="deleteCurrentPublicRequest"
              >
                删除接口
              </ScenePropertyButton>
            </div>
          </div>
        </section>

        <section
          v-if="editableConfig.request.type === 'dataset'"
          class="panel-block panel-block--figma-divider"
        >
          <div class="panel-label">数据集引用</div>
          <div class="dataset-row">
            <span
              v-if="currentDatasetProperty?.dataSourceId"
              class="scene-edit-dataset-property-chip text-[12px] leading-[18px] rounded-[4px] px-2 py-1 cursor-pointer"
              @click="openDatasetDialog"
            >
              {{ generateBindPropertyText(currentDatasetProperty) }}
            </span>
            <ScenePropertyButton v-else type="primary" link @click="openDatasetDialog"
              >选择数据集字段</ScenePropertyButton
            >
            <ScenePropertyButton text @click="clearDatasetProperty">清空</ScenePropertyButton>
          </div>
          <p v-if="datasetFieldLoadError" class="error-text mt-2">{{ datasetFieldLoadError }}</p>
        </section>

        <section v-if="showRequestTest" class="panel-block panel-block--figma-divider request-test">
          <div class="panel-label">测试</div>
          <!--
          “发送请求”继续复用共享按钮，只通过业务修饰类还原 Figma 的整行描边形态；
          按钮宽度跟随可调右侧面板，禁止写死 292px。
        -->
          <ScenePropertyButton class="request-test__send" type="primary" @click="handleTestRequest">
            发送请求
          </ScenePropertyButton>
          <p v-if="requestTestHint" :class="['request-test__hint', { 'is-error': requestError }]">
            {{ requestTestHint }}
          </p>
        </section>

        <!--
        配置顺序严格对应数据流：请求先产出原始数据，过滤器随后生成可映射的数据，最后才绑定属性。
        这里只交换可视区块的渲染位置，不重排 editableConfig 内的 bindings 或 filterFn，
        因而不会改变已保存组件的数据、映射结果或历史记录。
      -->
        <section
          v-if="showFilterSection"
          class="panel-block panel-block--figma-divider data-filter"
        >
          <div class="data-filter__header">
            <div class="panel-title">数据过滤</div>
            <ScenePropertyButton
              class="scene-edit-right-data-panel__header-action"
              size="small"
              @click="filterEditorVisible = true"
            >
              {{ editableConfig.filterFn ? '编辑过滤器' : '新增过滤器' }}
            </ScenePropertyButton>
          </div>
          <div class="data-filter__hint">
            自定义过滤器：直接对接口原始返回值执行JS转换，返回值会作为最终数据内容继续参与映射和显示。
          </div>
          <!--
          已配置的函数不在数据面板重复展开，避免代码摘要与弹窗编辑器出现两份入口和两套删除语义。
          过滤器始终通过标题栏的“新增/编辑过滤器”按钮查看和修改，数据面板只保留流程说明。
        --></section>

        <section class="panel-block panel-block--figma-divider">
          <div v-if="isThreeMapSelection" class="three-map-data-policy">
            <div class="panel-label">数据角色</div>
            <ScenePropertySelect
              :model-value="threeMapRole"
              @update:model-value="handleThreeMapRoleChange"
            >
              <el-option label="省份数据" value="province" />
              <el-option label="飞线数据" value="flight" />
              <el-option label="点位数据" value="point" />
            </ScenePropertySelect>
            <div class="panel-label">合并策略</div>
            <ScenePropertySelect
              :model-value="threeMapMergeMode"
              @update:model-value="handleThreeMapMergeModeChange"
            >
              <el-option label="合并静态配置" value="merge" />
              <el-option label="替换当前角色" value="replace" />
            </ScenePropertySelect>
          </div>
          <!--
          共享列表内部负责表头、可变数量行、删除列和新增入口；数据页只提供字段选项与写回规则。
          所有存在绑定的映射行都使用操作列；图表与三维对象可新增，二维普通组件和打点只支持删除。
        -->
          <ScenePropertyMappingList
            :items="mappingItems"
            :variant="mappingListVariant"
            :title="mappingSectionTitle"
            :label-header="mappingHeadLabel"
            :add-label="
              isChartWidgetSelection || selectionKind === 'object' ? '添加数据项' : '添加映射项'
            "
            @add="handleMappingItemAdd"
            @remove="handleMappingItemRemove"
          >
            <template #label="{ item }">
              <!--
              所有人工目标字段统一使用“可选可填”下拉：常用属性可直接选择，自定义字段可输入后回车
              或失焦提交；自动识别项继续只读展示。来源字段仍使用右侧独立下拉，避免把两种字段混淆。
            -->
              <ScenePropertySelect
                v-if="item.targetSelectable"
                :model-value="item.label"
                allow-create
                default-first-option
                filterable
                placeholder="选择或输入字段"
                @change="
                  (value: string | number | boolean | undefined) =>
                    updateManualBindingTarget(item, String(value || ''))
                "
                @blur="(event: FocusEvent) => handleManualBindingTargetBlur(item, event)"
              >
                <el-option
                  v-for="target in getManualBindingTargetOptions(item)"
                  :key="target.targetPath"
                  :label="target.label"
                  :value="target.targetPath"
                />
              </ScenePropertySelect>
              <span v-else>{{ item.label }}</span>
            </template>
            <template #control="{ item }">
              <ScenePropertySelect
                :model-value="item.sourceField"
                clearable
                filterable
                @change="
                  (value: string | number | boolean | undefined) =>
                    handleMappingItemChange(item, value as string | undefined)
                "
              >
                <el-option
                  v-for="field in availableFields"
                  :key="field"
                  :label="field"
                  :value="field"
                />
              </ScenePropertySelect>
            </template>
            <template #status="{ item }">
              <span :class="statusClass(getFieldStatus(item.sourceField || ''))">
                {{ getFieldStatus(item.sourceField || '') }}
              </span>
            </template>
            <template #after>
              <p v-if="isTableWidgetSelection" class="panel-hint mt-2">
                表格按列映射数据字段；未配置的列继续使用原始字段。
              </p>
              <p v-if="selectionKind === 'marking'" class="panel-hint mt-2">
                打点组件按“每条数据生成一个实例”处理，`position` 为必填映射。
              </p>
              <p
                v-if="selectionKind === 'marking' && !markingPositionReady"
                class="error-text mt-2"
              >
                打点组件必须配置 `position` 映射。
              </p>
              <p v-if="isThreeMapSelection" class="panel-hint mt-2">
                必填字段不可删除；未知省份和不完整经纬度行会被跳过并产生诊断。
              </p>
            </template>
          </ScenePropertyMappingList>
        </section>

        <section class="panel-block panel-block--figma-divider">
          <!--
          Figma“富文本框”由共享复合组件统一标题、编辑区、按钮顺序和窄面板换行。
          本面板仅保留静态数据导入、下载以及动态数据只读预览等业务逻辑。
        -->
          <ScenePropertyRichTextBlock
            v-model="staticJsonText"
            :error="staticJsonError"
            :read-only="editableConfig.request.type !== 'static'"
            :display-value="dataContentDisplay"
            :importable="editableConfig.request.type === 'static'"
            downloadable
            placeholder="请输入 JSON 数组数据"
            @import="triggerImport"
            @download="downloadCurrentJson"
          />

          <input
            ref="fileInputRef"
            class="hidden"
            type="file"
            accept=".json,.txt"
            @change="handleImportFile"
          />
        </section>
      </template>
    </template>

    <el-empty v-else description="暂无可配置的数据对象" />
  </div>

  <!-- 弹窗通过组件片段与主体并列挂载；主体根节点已在上方闭合，这里不再重复结束一个不存在的容器。 -->
  <SetDatasetDialog ref="datasetDialogRef" @onConfirm="handleDatasetPropertyConfirm" />

  <RequestConfigPanel
    v-model:visible="publicRequestDialogVisible"
    :config="publicRequestDraft"
    :global-config="sceneRequestStore.sceneRequestGlobalConfig"
    :show-name-field="true"
    defer-confirmation
    :name-value="publicRequestDraft.name"
    @update:name="publicRequestDraft.name = $event"
    @confirm-global="handleGlobalRequestConfigConfirm"
    @confirm="handlePublicRequestConfigConfirm"
    @send-request="handlePublicRequestSend"
  />

  <RequestConfigPanel
    v-model:visible="ajaxConfigDialogVisible"
    :config="ajaxRequestConfig"
    :global-config="sceneRequestStore.sceneRequestGlobalConfig"
    @confirm-global="handleGlobalRequestConfigConfirm"
    @confirm="handleAjaxConfigConfirm"
    @send-request="handleAjaxConfigSend"
  />

  <FilterEditorDialog
    v-model:visible="filterEditorVisible"
    :filter-fn="editableConfig?.filterFn"
    :request-config="currentRequestConfig"
    :public-requests="sceneRequestStore.scenePublicRequestList"
    :global-config="resolvedAjaxRequestConfig"
    :preview-raw="latestRequestRaw"
    @confirm="handleFilterConfirm"
  />
</template>

<script setup lang="ts">
import SetDatasetDialog from './SetDatasetDialog/index.vue'
import RequestConfigPanel from './RequestConfigPanel/index.vue'
import FilterEditorDialog from './FilterEditorDialog/index.vue'
import RecordPaginationDataPanel from './RecordPaginationDataPanel/index.vue'
import ScenePropertyMappingList from '@/components/ScenePropertyMappingList/index.vue'
import ScenePropertyRichTextBlock from '@/components/ScenePropertyRichTextBlock/index.vue'
import { ArrowDown, Delete } from '@element-plus/icons-vue'
import { computed } from 'vue'
import type { CommandBus } from '@/scene-platform'
import { editorSceneOperation } from '@/integrations/scene/editorSceneOperationGate'
import type {
  ScenePropertyMappingListItem,
  ScenePropertyMappingListVariant,
} from '@/components/ScenePropertyMappingList/index.vue'
import { generateBindPropertyText } from './utils'
import type { BindingOption } from './rightDataPanelConstants'
import { useRightDataPanel, type RightDataPanelTargetKind } from './useRightDataPanel'

const props = withDefaults(
  defineProps<{
    /**
     * 数据面板目标类型。
     * 二维部件入口传 widget，三维对象入口传 sceneObject，旧入口默认 auto。
     */
    targetKind?: RightDataPanelTargetKind
    /** 三维配置经命令总线写入会话历史；二维旧入口不需要该参数。 */
    commandBus?: Pick<CommandBus, 'execute'> | null
  }>(),
  {
    targetKind: 'auto',
  },
)

const {
  sceneRequestStore,
  recordPaginationWidget,
  recordPaginationBinding,
  recordPaginationDataConfig,
  updateRecordPaginationBinding,
  editableConfig,
  requestItems,
  activeRequestId,
  isRequestExpanded,
  activeRequestItem,
  selectRequestItem,
  toggleRequestItem,
  addRequestItem,
  removeRequestItem,
  staticJsonText,
  staticJsonError,
  requestError,
  latestRequestRaw,
  fileInputRef,
  datasetDialogRef,
  datasetFieldLoadError,
  publicRequestDialogVisible,
  ajaxConfigDialogVisible,
  filterEditorVisible,
  publicRequestDraft,
  availableFields,
  fixedManualBindingTargetOptions,
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
  chartManualBindingTargetOptions,
  showRequestTest,
  showFilterSection,
  markingPositionReady,
  currentRequestConfig,
  getBindingSourceField,
  objectManualMappingItems,
  objectManualBindingTargetOptions,
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
} = useRightDataPanel({ targetKind: props.targetKind, commandBus: props.commandBus })

type ThreeMapRole = import('@/types/data-config').ThreeMapDatasetRole
type ThreeMapTarget = import('@/types/data-config').ThreeMapTargetField
type ThreeMapRule = import('@/types/data-config').ThreeMapBindingRule

const THREE_MAP_ROLE_TARGETS: Record<
  ThreeMapRole,
  Array<{ field: ThreeMapTarget; required: boolean; valueType: ThreeMapRule['valueType'] }>
> = {
  province: [
    { field: 'provinceName', required: true, valueType: 'string' },
    { field: 'value', required: false, valueType: 'number' },
    { field: 'label', required: false, valueType: 'string' },
    { field: 'labelEn', required: false, valueType: 'string' },
    { field: 'color', required: false, valueType: 'color' },
    { field: 'visible', required: false, valueType: 'boolean' },
    { field: 'popup', required: false, valueType: 'boolean' },
    { field: 'infoTitle', required: false, valueType: 'string' },
    { field: 'infoContent', required: false, valueType: 'string' },
    { field: 'infoLevel', required: false, valueType: 'string' },
  ],
  flight: [
    { field: 'sourceProvince', required: false, valueType: 'string' },
    { field: 'sourceLongitude', required: false, valueType: 'number' },
    { field: 'sourceLatitude', required: false, valueType: 'number' },
    { field: 'targetProvince', required: false, valueType: 'string' },
    { field: 'targetLongitude', required: false, valueType: 'number' },
    { field: 'targetLatitude', required: false, valueType: 'number' },
    { field: 'id', required: false, valueType: 'string' },
    { field: 'name', required: false, valueType: 'string' },
    { field: 'value', required: false, valueType: 'number' },
    { field: 'color', required: false, valueType: 'color' },
    { field: 'arcHeight', required: false, valueType: 'number' },
    { field: 'width', required: false, valueType: 'number' },
    { field: 'speed', required: false, valueType: 'number' },
    { field: 'visible', required: false, valueType: 'boolean' },
  ],
  point: [
    { field: 'provinceName', required: false, valueType: 'string' },
    { field: 'longitude', required: false, valueType: 'number' },
    { field: 'latitude', required: false, valueType: 'number' },
    { field: 'id', required: false, valueType: 'string' },
    { field: 'name', required: false, valueType: 'string' },
    { field: 'value', required: false, valueType: 'number' },
    { field: 'level', required: false, valueType: 'string' },
    { field: 'color', required: false, valueType: 'color' },
    { field: 'size', required: false, valueType: 'number' },
    { field: 'icon', required: false, valueType: 'string' },
    { field: 'visible', required: false, valueType: 'boolean' },
  ],
}

const threeMapRules = computed(() =>
  (editableConfig.value?.bindings ?? []).filter(
    (binding): binding is ThreeMapRule => binding.kind === 'three-map',
  ),
)
const threeMapRole = computed<ThreeMapRole>(
  () => editableConfig.value?.threeMapRole ?? threeMapRules.value[0]?.datasetRole ?? 'province',
)
const threeMapMergeMode = computed(() => editableConfig.value?.mergeMode ?? 'merge')

const handleThreeMapRoleChange = (value: unknown) => {
  if (!editableConfig.value || typeof value !== 'string') return
  if (!['province', 'flight', 'point'].includes(value)) return
  const role = value as ThreeMapRole
  editableConfig.value.threeMapRole = role
  editableConfig.value.bindings = editableConfig.value.bindings.filter(
    (binding) => binding.kind !== 'three-map',
  )
  editableConfig.value.bindings.push(
    ...THREE_MAP_ROLE_TARGETS[role]
      .filter((target) => target.required)
      .map((target) => ({
        kind: 'three-map' as const,
        datasetRole: role,
        sourceField: '',
        targetField: target.field,
        valueType: target.valueType,
      })),
  )
  persistSoon()
}

const handleThreeMapMergeModeChange = (value: unknown) => {
  if (!editableConfig.value || (value !== 'merge' && value !== 'replace')) return
  editableConfig.value.mergeMode = value
  persistSoon()
}

const updateThreeMapBinding = (targetField: ThreeMapTarget, sourceField: string | undefined) => {
  if (!editableConfig.value) return
  const target = THREE_MAP_ROLE_TARGETS[threeMapRole.value].find(
    (item) => item.field === targetField,
  )
  if (!target) return
  const others = editableConfig.value.bindings.filter(
    (binding) => binding.kind !== 'three-map' || binding.targetField !== targetField,
  )
  if (sourceField || target.required) {
    others.push({
      kind: 'three-map',
      datasetRole: threeMapRole.value,
      sourceField: sourceField ?? '',
      targetField,
      valueType: target.valueType,
    })
  }
  editableConfig.value.bindings = others
  persistSoon()
}

/** 请求项标题使用中文业务名称，避免模板内重复遍历请求类型选项。 */
const requestTypeLabel = (type: string) =>
  requestTypeOptions.value.find((item) => item.value === type)?.label || '静态数据'

/**
 * 将图表映射和普通属性映射归一成共享列表数据。
 *
 * 左列呈现组件需要接收的目标字段，右列下拉呈现接口或数据集的来源字段：
 * - 图表目标字段由图表家族和原始数据模板识别，并与来源字段按索引一一对应；
 * - 普通组件直接使用绑定目标路径作为目标字段。
 * 计算过程只遍历当前可见映射一次；列表渲染和状态查询直接复用 sourceField，避免模板重复查找绑定规则。
 */
const mappingItems = computed<ScenePropertyMappingListItem[]>(() => {
  if (isThreeMapSelection.value) {
    const rules = new Map(threeMapRules.value.map((rule) => [rule.targetField, rule]))
    return THREE_MAP_ROLE_TARGETS[threeMapRole.value].map((target) => ({
      key: `three-map:${target.field}`,
      label: `${target.field}${target.required ? ' *' : ''}`,
      targetPath: target.field,
      sourceField: rules.get(target.field)?.sourceField ?? '',
      removable: !target.required && rules.has(target.field),
    }))
  }
  if (isChartWidgetSelection.value) {
    const origins = chartRule.value.measureFields.map(
      (_, index) => chartRule.value.targetMeasureFieldOrigins?.[index] || 'inferred',
    )
    const dimensionTarget = chartRule.value.targetDimensionField?.trim() || ''
    const items: ScenePropertyMappingListItem[] = dimensionTarget
      ? [
          {
            key: 'chart-dimension',
            // 左侧展示组件目标，右侧 sourceField 才是用户从接口结果中选择的来源字段。
            label: dimensionTarget,
            sourceField: chartRule.value.dimensionField,
            // 自动维度和自动度量统一允许删除；删除后由请求级记录阻止字段刷新重新生成。
            removable: true,
          },
        ]
      : []
    const measures: ScenePropertyMappingListItem[] = []
    chartRule.value.measureFields.forEach((sourceField, measureIndex) => {
      const targetField = chartRule.value.targetMeasureFields?.[measureIndex]?.trim() || ''
      const origin = origins[measureIndex]
      // 自动行被前序请求占用后会被清理；人工空白行仍要保留供用户继续填写。
      if (!targetField && origin !== 'manual') return
      measures.push({
        key: `chart-measure-${measureIndex}`,
        label: targetField,
        sourceField,
        measureIndex,
        // 自动识别项只读目标名，人工项可通过可输入下拉修改目标；两类项都允许删除。
        targetEditable: origin === 'manual',
        targetSelectable: origin === 'manual',
        removable: true,
      })
    })
    return [...items, ...measures]
  }

  if (selectionKind.value === 'object') {
    return objectManualMappingItems.value.map((item) => ({
      key: item.key,
      label: item.targetPath,
      sourceField: item.sourceField,
      // 三维模型与三维组件的映射均由用户手动配置，因此每行可改目标、可改来源、可删除。
      targetEditable: true,
      targetSelectable: true,
      removable: true,
    }))
  }

  return targetBindings.value
    .map((target) => {
      const sourceField = target.sourceField ?? getBindingSourceField(target.targetPath)
      return {
        key: target.key || target.targetPath,
        // 普通组件展示真实属性路径，保持与数据绑定规则和配置结构一致。
        label: target.label,
        targetPath: target.targetPath,
        sourceField,
        // 固定目标只在已经绑定来源时显示删除；自定义人工行即使为空也可主动删除。
        // 自定义人工行的目标字段与三维模型保持一致，既可下拉选固定目标，也可输入任意扩展路径。
        targetEditable: Boolean(target.key),
        targetSelectable: Boolean(target.key),
        removable: Boolean(target.key) || Boolean(sourceField),
      }
    })
    .filter((item) => {
      /**
       * 固定自动映射被删除后，绑定数组中已没有该行，但固定目标集合仍必须继续存在，
       * 供自动识别和目标字段下拉使用。因此这里按“是否有来源或稳定人工编号”决定是否展示：
       * - 自动绑定有来源字段，展示完整映射行；
       * - 删除后的自动目标无来源字段，整行隐藏；
       * - 手动新增行有稳定编号，即使目标和来源均为空，也保留为待编辑草稿。
       */
      return Boolean(item.sourceField) || Boolean(item.targetSelectable)
    })
})

/** 所有可配置数据对象均允许增删映射；固定目标集合仍由具体组件类型决定。 */
const mappingListVariant = computed<ScenePropertyMappingListVariant>(() =>
  isThreeMapSelection.value
    ? 'fixed'
    : isChartWidgetSelection.value ||
        selectionKind.value === 'object' ||
        selectionKind.value === 'widget' ||
        selectionKind.value === 'marking'
      ? 'editable-addable'
      : 'fixed',
)

/**
 * 测试提示只在动态请求尚未填写地址或实际请求失败时显示。
 * 公共请求复用同一测试区，但不应错误提示用户去编辑“动态请求”配置。
 */
const requestTestHint = computed(() => {
  if (requestError.value) return requestError.value
  if (editableConfig.value?.request.type !== 'ajax') return ''

  const { requestOriginUrl, requestUrl } = resolvedAjaxRequestConfig.value
  return requestOriginUrl || requestUrl ? '' : '请先在“编辑配置”里填写服务与地址'
})

/**
 * 公共接口地址只在当前选择变化时计算一次，模板和 title 提示复用同一结果。
 * 地址为空时统一显示“暂无”，避免在模板中重复拼接和产生空字符串占位。
 */
const publicRequestAddress = computed(() => {
  if (!currentRequestConfig.value) return '暂无'

  const address = `${currentRequestConfig.value.requestOriginUrl || ''}${
    currentRequestConfig.value.requestUrl || ''
  }`
  return address || '暂无'
})

/**
 * 共享映射列表使用通用字符串承载目标路径，写回业务配置前需收窄为当前面板允许的绑定目标。
 * 直接复用 targetBindings 作为唯一有效来源，既避免不安全的类型断言，也阻止异常路径进入持久化配置。
 */
const isBindingTargetPath = (targetPath: string): targetPath is BindingOption['targetPath'] =>
  targetBindings.value.some((target) => target.targetPath === targetPath)

/**
 * 单一写入口根据共享行携带的稳定标识更新业务配置。
 * 图表维度、图表数值和普通目标字段不会在组件内部互相推断，避免错误写入其它映射。
 */
const handleMappingItemChange = (item: ScenePropertyMappingListItem, value: string | undefined) => {
  if (isThreeMapSelection.value && item.targetPath) {
    updateThreeMapBinding(item.targetPath as ThreeMapTarget, value)
    return
  }
  if (item.measureIndex !== undefined) {
    // 自动图表匹配项清空来源时等同于删除整行，必须释放目标字段并记录删除意图；
    // 手动新增项清空来源仍保留空白草稿，方便用户稍后继续配置。
    if (!value && !item.targetSelectable) {
      removeChartMeasureField(item.measureIndex)
      return
    }
    updateChartMeasureField(item.measureIndex, value)
    return
  }
  if (item.targetSelectable && selectionKind.value === 'object') {
    updateObjectManualBindingSource(String(item.key), value)
    return
  }
  if (item.targetEditable) {
    updateFixedBindingSource(String(item.key), value)
    return
  }
  if (item.key === 'chart-dimension') {
    // 图表自动维度清空时走整行删除，避免字段刷新后只恢复来源字段而继续占用目标字段。
    if (!value) {
      removeChartDimension()
      return
    }
    chartRule.value.dimensionField = value || ''
    persistSoon()
    return
  }
  if (item.targetPath && isBindingTargetPath(item.targetPath)) {
    // 普通组件/图标/打点的自动匹配项清空时也要删除整行，并把目标字段释放给其它请求。
    if (!value && !item.targetEditable) {
      removeFixedTargetBinding(String(item.key), item.targetPath)
      return
    }
    handleBindingFieldChange(item.targetPath, value)
  }
}

/** 根据映射行类型选择对应的目标字段选项，始终不读取当前请求的来源字段。 */
const getManualBindingTargetOptions = (item: ScenePropertyMappingListItem): BindingOption[] => {
  if (item.measureIndex !== undefined) return chartManualBindingTargetOptions.value
  if (selectionKind.value === 'object') return objectManualBindingTargetOptions.value
  return fixedManualBindingTargetOptions.value
}

/**
 * 统一更新所有人工目标字段。
 * 映射列表只负责呈现交互，具体写回仍按图表、三维对象、二维控件/打点三条已有业务链路分流，
 * 防止不同类型的人工行因复用同一个下拉事件而互相覆盖。
 */
const updateManualBindingTarget = (item: ScenePropertyMappingListItem, value: string) => {
  if (item.measureIndex !== undefined) {
    updateChartTargetMeasureField(item.measureIndex, value)
    return
  }
  if (selectionKind.value === 'object') {
    updateObjectManualBindingTarget(String(item.key), value)
    return
  }
  updateFixedBindingTarget(String(item.key), value)
}

/**
 * 统一处理人工目标字段失焦提交。
 * 选择框的失焦事件有时由包装节点触发，需回退读取当前活动的输入元素，确保用户直接输入后点击空白区域
 * 也能保存；已通过下拉选择提交的值不会因为失焦读取不到文本而被清空。
 */
const handleManualBindingTargetBlur = (item: ScenePropertyMappingListItem, event: FocusEvent) => {
  /**
   * Element Plus 点击非焦点区域时会构造一个没有 target 的合成 blur 事件；此时输入框仍是
   * 当前活动元素，因此回退读取 activeElement，避免用户点击空白区域后丢失最后一次输入。
   */
  const inputElement =
    event.target instanceof HTMLInputElement
      ? event.target
      : document.activeElement instanceof HTMLInputElement
        ? document.activeElement
        : null
  const inputValue = inputElement?.value
  if (typeof inputValue !== 'string' || !inputValue.trim()) return
  updateManualBindingTarget(item, inputValue)
}

/** 所有可配置对象均支持手动增加；三维对象、控件和打点新增自定义目标字段。 */
const handleMappingItemAdd = () => {
  if (isChartWidgetSelection.value) {
    addChartMeasureField()
    return
  }
  if (selectionKind.value === 'object') addObjectManualBinding()
  if (selectionKind.value === 'widget' || selectionKind.value === 'marking') addFixedBinding()
}

/**
 * 所有映射类型统一从这里删除。
 *
 * 普通控件和打点虽然使用固定目标集合，但删除时仍要清除绑定并记录目标字段；否则字段
 * 刷新或请求测试会再次按目标字段自动补齐。打点的 position 删除后保留必填错误提示，
 * 让用户明确知道运行时不会生成实例，而不是悄悄恢复一条无法删除的默认绑定。
 */
const handleMappingItemRemove = (item: ScenePropertyMappingListItem) => {
  if (!item.removable) return
  if (isThreeMapSelection.value && item.targetPath) {
    updateThreeMapBinding(item.targetPath as ThreeMapTarget, undefined)
    return
  }
  if (item.targetSelectable && selectionKind.value === 'object') {
    removeObjectManualBinding(String(item.key))
    return
  }
  if (item.key === 'chart-dimension') {
    removeChartDimension()
    return
  }
  if (item.measureIndex !== undefined) {
    removeChartMeasureField(item.measureIndex)
    return
  }
  // 自定义人工行允许目标为空，必须通过 targetEditable 判断，不能只判断 targetPath。
  if (
    (item.targetEditable || item.targetPath) &&
    (selectionKind.value === 'widget' || selectionKind.value === 'marking')
  ) {
    removeFixedTargetBinding(String(item.key), item.targetPath || '')
  }
}
</script>

<style scoped src="./index.scss" lang="scss"></style>
