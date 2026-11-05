<template>
  <div class="page-pagination-config-panel">
    <section class="scene-edit-property-section">
      <div class="scene-edit-property-section__header">图文样式</div>
      <div class="scene-edit-property-section__body">
        <ScenePropertyRow label="默认选中" control-fill>
          <ScenePropertySelect v-model="option.value" placeholder="请选择默认按钮">
            <el-option
              v-for="item in items"
              :key="item.id"
              :label="item.label"
              :value="item.eventValue"
            />
          </ScenePropertySelect>
        </ScenePropertyRow>
        <ScenePropertyRow label="每屏按钮" control-fill>
          <ScenePropertyNumberInput
            v-model="option.pageSize"
            :min="pageSizeRange.min"
            :max="pageSizeRange.max"
            :step="1"
            aria-label="每屏按钮数量"
          />
        </ScenePropertyRow>
        <ScenePropertyRow label="图片宽度" control-fill>
          <ScenePropertyNumberInput
            v-model="option.imageWidth"
            :min="sizeRanges.imageWidth.min"
            :max="sizeRanges.imageWidth.max"
            :step="1"
            ><template #suffix>px</template></ScenePropertyNumberInput
          >
        </ScenePropertyRow>
        <ScenePropertyRow label="图片高度" control-fill>
          <ScenePropertyNumberInput
            v-model="option.imageHeight"
            :min="sizeRanges.imageHeight.min"
            :max="sizeRanges.imageHeight.max"
            :step="1"
            ><template #suffix>px</template></ScenePropertyNumberInput
          >
        </ScenePropertyRow>
        <ScenePropertyRow label="图文间距" control-fill>
          <ScenePropertyNumberInput
            v-model="option.imageTextGap"
            :min="sizeRanges.imageTextGap.min"
            :max="sizeRanges.imageTextGap.max"
            :step="1"
            ><template #suffix>px</template></ScenePropertyNumberInput
          >
        </ScenePropertyRow>
        <ScenePropertyRow label="按钮间距" control-fill>
          <ScenePropertyNumberInput
            v-model="option.itemGap"
            :min="sizeRanges.itemGap.min"
            :max="sizeRanges.itemGap.max"
            :step="1"
            ><template #suffix>px</template></ScenePropertyNumberInput
          >
        </ScenePropertyRow>
        <ScenePropertyRow label="标签字体" control-fill>
          <ScenePropertySelect v-model="option.labelFontFamily" size="small">
            <el-option
              v-for="font in fontOptions"
              :key="font.value"
              :label="font.label"
              :value="font.value"
            />
          </ScenePropertySelect>
        </ScenePropertyRow>
        <ScenePropertyRow label="文字字号" control-fill>
          <ScenePropertyNumberInput
            v-model="option.labelFontSize"
            :min="sizeRanges.labelFontSize.min"
            :max="sizeRanges.labelFontSize.max"
            :step="1"
            ><template #suffix>px</template></ScenePropertyNumberInput
          >
        </ScenePropertyRow>
        <ScenePropertyRow label="文字粗细" control-fill>
          <ScenePropertySelect v-model="option.labelFontWeight" size="small">
            <el-option
              v-for="weight in fontWeightOptions"
              :key="weight.value"
              :label="weight.label"
              :value="weight.value"
            />
          </ScenePropertySelect>
        </ScenePropertyRow>
        <ScenePropertyRow label="文字颜色">
          <ScenePropertyColorPicker
            v-model="option.labelFontColor"
            variant="swatch"
            label="文字颜色"
          />
        </ScenePropertyRow>
        <ScenePropertyRow label="选中文字">
          <ScenePropertyColorPicker
            v-model="option.activeTextColor"
            variant="swatch"
            label="选中文字颜色"
          />
        </ScenePropertyRow>
        <ScenePropertyRow
          label="背景图片"
          class="page-pagination-config-panel__resource-row"
          control-fill
        >
          <div class="page-pagination-config-panel__resource">
            <ScenePropertyImageResourcePicker v-model="option.backgroundImage" />
          </div>
        </ScenePropertyRow>
        <ScenePropertyRow
          label="上一页箭头"
          class="page-pagination-config-panel__resource-row"
          control-fill
        >
          <div class="page-pagination-config-panel__resource">
            <ScenePropertyImageResourcePicker
              v-model="option.previousArrowUrl"
              v-model:resource-key="option.previousArrowResourceKey"
            />
          </div>
        </ScenePropertyRow>
        <ScenePropertyRow
          label="下一页箭头"
          class="page-pagination-config-panel__resource-row"
          control-fill
        >
          <div class="page-pagination-config-panel__resource">
            <ScenePropertyImageResourcePicker
              v-model="option.nextArrowUrl"
              v-model:resource-key="option.nextArrowResourceKey"
            />
          </div>
        </ScenePropertyRow>
      </div>
    </section>

    <section class="scene-edit-property-section">
      <div class="scene-edit-property-section__header">按钮配置</div>
      <div class="scene-edit-property-section__body">
        <ScenePropertyRow label="按钮操作" control-fill>
          <ScenePropertyButton width="100%" @click="addItem">新增按钮</ScenePropertyButton>
        </ScenePropertyRow>
        <ScenePropertyRow
          label="按钮列表"
          class="page-pagination-config-panel__list-row"
          control-fill
        >
          <div class="page-pagination-config-panel__list" role="list" aria-label="页面分页器按钮">
            <button
              v-for="(item, index) in items"
              :key="item.id"
              type="button"
              class="page-pagination-config-panel__list-item"
              :class="{ 'is-selected': selectedItemId === item.id }"
              @click="selectedItemId = item.id"
            >
              <img
                v-if="item.iconUrl"
                :src="item.iconUrl"
                alt=""
                class="page-pagination-config-panel__list-image"
              />
              <span v-else class="page-pagination-config-panel__list-index">{{ index + 1 }}</span>
              <span class="page-pagination-config-panel__list-label">{{
                item.label || '未命名按钮'
              }}</span>
            </button>
          </div>
        </ScenePropertyRow>

        <template v-if="selectedItem">
          <ScenePropertyRow label="按钮文字" control-fill>
            <ScenePropertyInput v-model.trim="selectedItem.label" placeholder="请输入按钮文字" />
          </ScenePropertyRow>
          <!-- 旧配置缺少样式时只显示默认值，选择按钮不写入持久化配置。 -->
          <ScenePropertyRow label="文字字体" control-fill>
            <ScenePropertySelect
              :model-value="selectedItem.fontFamily ?? PAGE_PAGINATION_APPEARANCE_DEFAULTS.labelFontFamily"
              size="small"
              @update:model-value="selectedItem.fontFamily = String($event)"
            >
              <el-option
                v-for="font in fontOptions"
                :key="font.value"
                :label="font.label"
                :value="font.value"
              />
            </ScenePropertySelect>
          </ScenePropertyRow>
          <ScenePropertyRow label="文字字号" control-fill>
            <ScenePropertyNumberInput
              :model-value="selectedItem.fontSize ?? PAGE_PAGINATION_APPEARANCE_DEFAULTS.labelFontSize"
              :min="sizeRanges.labelFontSize.min"
              :max="sizeRanges.labelFontSize.max"
              :step="1"
              @update:model-value="selectedItem.fontSize = $event ?? undefined"
            >
              <template #suffix>px</template>
            </ScenePropertyNumberInput>
          </ScenePropertyRow>
          <ScenePropertyRow label="文字颜色">
            <ScenePropertyColorPicker
              :model-value="selectedItem.fontColor ?? PAGE_PAGINATION_APPEARANCE_DEFAULTS.labelFontColor"
              variant="swatch"
              label="当前按钮文字颜色"
              @update:model-value="selectedItem.fontColor = $event ?? undefined"
            />
          </ScenePropertyRow>
          <ScenePropertyRow label="文字粗细" control-fill>
            <ScenePropertySelect
              :model-value="selectedItem.fontWeight ?? PAGE_PAGINATION_APPEARANCE_DEFAULTS.labelFontWeight"
              size="small"
              @update:model-value="updateItemFontWeight"
            >
              <el-option
                v-for="weight in fontWeightOptions"
                :key="weight.value"
                :label="weight.label"
                :value="weight.value"
              />
            </ScenePropertySelect>
          </ScenePropertyRow>
          <ScenePropertyRow label="事件值" control-fill>
            <!-- 事件值作为“当前部件值”参与条件匹配，跳转地址仍在交互动作中配置。 -->
            <ScenePropertyInput
              :model-value="selectedItem.eventValue"
              :error-message="eventValueError"
              placeholder="用于交互规则匹配"
              @update:model-value="updateEventValue"
            />
          </ScenePropertyRow>
          <ScenePropertyRow
            label="普通图片"
            class="page-pagination-config-panel__resource-row"
            control-fill
          >
            <div class="page-pagination-config-panel__resource">
              <ScenePropertyImageResourcePicker
                v-model="selectedItem.iconUrl"
                v-model:resource-key="selectedItem.iconResourceKey"
              />
            </div>
          </ScenePropertyRow>
          <ScenePropertyRow
            label="选中图片"
            class="page-pagination-config-panel__resource-row"
            control-fill
          >
            <div class="page-pagination-config-panel__resource">
              <ScenePropertyImageResourcePicker
                v-model="selectedItem.activeIconUrl"
                v-model:resource-key="selectedItem.activeIconResourceKey"
              />
            </div>
          </ScenePropertyRow>
          <ScenePropertyRow label="按钮排序" control-fill>
            <div class="page-pagination-config-panel__sort-actions">
              <ScenePropertyButton width="100%" :disabled="selectedIndex <= 0" @click="moveItem(-1)"
                >上移</ScenePropertyButton
              >
              <ScenePropertyButton
                width="100%"
                :disabled="selectedIndex < 0 || selectedIndex >= items.length - 1"
                @click="moveItem(1)"
                >下移</ScenePropertyButton
              >
            </div>
          </ScenePropertyRow>
          <ScenePropertyRow label="按钮操作" control-fill>
            <ScenePropertyButton
              width="100%"
              type="danger"
              plain
              :disabled="items.length <= 1"
              @click="removeSelectedItem"
              >删除当前按钮</ScenePropertyButton
            >
          </ScenePropertyRow>
        </template>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, type PropType } from 'vue'
import ScenePropertyButton from '@/components/ScenePropertyButton/index.vue'
import ScenePropertyInput from '@/components/ScenePropertyInput/index.vue'
import ScenePropertyNumberInput from '@/components/ScenePropertyNumberInput/index.vue'
import ScenePropertySelect from '@/components/ScenePropertySelect/index.vue'
import ScenePropertyImageResourcePicker from '@/components/ScenePropertyImageResourcePicker/index.vue'
import ScenePropertyRow from '@/views/sceneEdit/SceneRightPanel/components/PropertyControls/ScenePropertyRow/index.vue'
import ScenePropertyColorPicker from '@/components/ScenePropertyColorPicker/index.vue'
import Config, { type PagePaginationItem } from './config'
import {
  PAGE_PAGINATION_APPEARANCE_DEFAULTS,
  PAGE_PAGINATION_FONT_OPTIONS,
  PAGE_PAGINATION_FONT_WEIGHT_OPTIONS,
  PAGE_PAGINATION_SIZE_RANGES,
} from './appearance'
import {
  PAGE_PAGINATION_PAGE_SIZE_RANGE,
  createPagePaginationItem,
  normalizePagePaginationItems,
} from './model'

defineOptions({ name: 'VPagePaginationConfigPanel' })
const props = defineProps({
  option: { type: Object as PropType<Config['option']>, required: true },
})
const selectedItemId = ref('')
const pageSizeRange = PAGE_PAGINATION_PAGE_SIZE_RANGE
const sizeRanges = PAGE_PAGINATION_SIZE_RANGES
const fontOptions = PAGE_PAGINATION_FONT_OPTIONS
const fontWeightOptions = PAGE_PAGINATION_FONT_WEIGHT_OPTIONS
if (!Array.isArray(props.option.items)) {
  // 旧场景可能缺少按钮数组；面板打开时补为空数组，避免资源市场控件访问异常。
  props.option.items = []
}

/** 只在切换组件时补全缺失字段，不覆盖用户已经配置的图片或外观。 */
watch(
  () => props.option,
  (option) => {
    if (!Array.isArray(option.items)) option.items = []
    option.imageWidth ??= PAGE_PAGINATION_APPEARANCE_DEFAULTS.imageWidth
    option.imageHeight ??= PAGE_PAGINATION_APPEARANCE_DEFAULTS.imageHeight
    option.imageTextGap ??= PAGE_PAGINATION_APPEARANCE_DEFAULTS.imageTextGap
    option.itemGap ??= PAGE_PAGINATION_APPEARANCE_DEFAULTS.itemGap
    option.fontSize ??= PAGE_PAGINATION_APPEARANCE_DEFAULTS.fontSize
    option.textColor ??= PAGE_PAGINATION_APPEARANCE_DEFAULTS.textColor
    option.activeTextColor ??= PAGE_PAGINATION_APPEARANCE_DEFAULTS.activeTextColor
    option.labelFontFamily ??= PAGE_PAGINATION_APPEARANCE_DEFAULTS.labelFontFamily
    option.labelFontSize ??= PAGE_PAGINATION_APPEARANCE_DEFAULTS.labelFontSize
    option.labelFontColor ??= PAGE_PAGINATION_APPEARANCE_DEFAULTS.labelFontColor
    option.labelFontWeight ??= PAGE_PAGINATION_APPEARANCE_DEFAULTS.labelFontWeight
    option.previousArrowUrl ??= ''
    option.nextArrowUrl ??= ''
    if (!option.items.some((item) => item.eventValue === option.value)) {
      option.value = option.items[0]?.eventValue || ''
    }
  },
  { immediate: true },
)

const items = computed(() => normalizePagePaginationItems(props.option.items))
const selectedIndex = computed(() =>
  items.value.findIndex((item) => item.id === selectedItemId.value),
)
const selectedItem = computed<PagePaginationItem | null>(
  () => props.option.items.find((item) => item.id === selectedItemId.value) || null,
)

const updateItemFontWeight = (value: unknown) => {
  const item = selectedItem.value
  if (item && (typeof value === 'string' || typeof value === 'number')) item.fontWeight = value
}

const eventValueError = computed(() => {
  const current = selectedItem.value
  if (!current) return ''
  if (!current.eventValue.trim()) return '请输入事件值'
  return props.option.items.some(
    (item) => item !== current && item.eventValue.trim() === current.eventValue.trim(),
  )
    ? '事件值不可重复，否则无法区分按钮'
    : ''
})

/** 修改默认按钮的事件值时同步默认选中，避免改名后默认状态落到其他按钮。 */
const updateEventValue = (value: string | number) => {
  const item = selectedItem.value
  if (!item) return
  const isDefault = props.option.value === item.eventValue
  item.eventValue = String(value).trim()
  if (isDefault) props.option.value = item.eventValue
}

watch(
  items,
  (nextItems) => {
    if (!nextItems.some((item) => item.id === selectedItemId.value)) {
      selectedItemId.value = nextItems[0]?.id || ''
    }
  },
  { immediate: true, deep: true },
)

const addItem = () => {
  const item = createPagePaginationItem(props.option.items.length, items.value)
  props.option.items.push(item)
  selectedItemId.value = item.id
  if (props.option.items.length === 1) props.option.value = item.eventValue
}
/** 排序只移动目标对象，不复制其他按钮及其图片配置。 */
const moveItem = (offset: number) => {
  const index = selectedIndex.value
  const targetIndex = index + offset
  if (index < 0 || targetIndex < 0 || targetIndex >= props.option.items.length) return
  const [item] = props.option.items.splice(index, 1)
  props.option.items.splice(targetIndex, 0, item)
}
const removeSelectedItem = () => {
  const index = selectedIndex.value
  if (index < 0 || props.option.items.length <= 1) return
  const [removed] = props.option.items.splice(index, 1)
  // 删除默认项后保存新的默认值，使预览与再次打开场景的选中状态一致。
  if (props.option.value === removed.eventValue) {
    props.option.value = props.option.items[0]?.eventValue || ''
  }
}
</script>

<style scoped lang="scss">
.page-pagination-config-panel {
  min-width: 0;
}
.page-pagination-config-panel__list-row,
.page-pagination-config-panel__resource-row {
  align-items: start;
}
.page-pagination-config-panel__list-row :deep(.scene-edit-property-row__label),
.page-pagination-config-panel__resource-row :deep(.scene-edit-property-row__label) {
  align-items: flex-start;
}
.page-pagination-config-panel__resource {
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr);
  gap: 8px;
  align-items: center;
  width: 100%;
  min-width: 0;
}
.page-pagination-config-panel__list {
  display: flex;
  flex-direction: column;
  max-height: 168px;
  overflow: auto;
  background: var(--scene-edit-bg-input);
  border: 1px solid rgb(255 255 255 / 14%);
  border-radius: 2px;
}
.page-pagination-config-panel__list-item {
  display: flex;
  gap: 8px;
  align-items: center;
  width: 100%;
  min-height: 38px;
  padding: 3px 8px;
  color: var(--scene-edit-text);
  text-align: left;
  cursor: pointer;
  background: transparent;
  border: 0;
}
.page-pagination-config-panel__list-item:hover,
.page-pagination-config-panel__list-item:focus-visible,
.page-pagination-config-panel__list-item.is-selected {
  outline: none;
  background: rgb(90 178 165 / 16%);
}
.page-pagination-config-panel__list-index {
  flex: 0 0 24px;
  font-size: 12px;
  color: var(--scene-edit-header-primary);
  text-align: center;
}
.page-pagination-config-panel__list-image {
  flex: 0 0 28px;
  width: 28px;
  height: 28px;
  object-fit: contain;
}
.page-pagination-config-panel__list-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.page-pagination-config-panel__sort-actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 4px;
  width: 100%;
}
</style>
