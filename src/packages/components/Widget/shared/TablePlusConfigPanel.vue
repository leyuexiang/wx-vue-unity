<template>
  <TableConfigPanelShell :option="option">
    <div class="table-plus-config-panel">
      <setting-item-box name="对齐方式" :alone="true">
        <ScenePropertySelect v-model="option.align" size="small">
          <el-option label="靠左" value="left" />
          <el-option label="居中" value="center" />
          <el-option label="靠右" value="right" />
        </ScenePropertySelect>
      </setting-item-box>

      <setting-item-box name="表头名称" :alone="true">
        <ScenePropertyInput v-model="headerText" placeholder="英文逗号分隔" />
      </setting-item-box>

      <setting-item-box name="列宽" :alone="true">
        <ScenePropertyNumberInput v-model="option.colWidth" :min="40" size="small" />
      </setting-item-box>

      <setting-item-box name="行高" :alone="true">
        <ScenePropertyNumberInput v-model="option.rowHeight" :min="20" size="small" />
      </setting-item-box>

      <setting-item-box name="表头" :alone="true">
        <ScenePropertySwitch v-model="option.style.colHeaders" />
      </setting-item-box>

      <setting-item-box name="外边框" :alone="true">
        <ScenePropertySwitch v-model="option.style.bordered" />
      </setting-item-box>

      <setting-item-box name="水平线" :alone="true">
        <ScenePropertySwitch v-model="option.style.hLine" />
      </setting-item-box>

      <setting-item-box name="垂直线" :alone="true">
        <ScenePropertySwitch v-model="option.style.vLine" />
      </setting-item-box>

      <setting-item-box name="字体大小" :alone="true">
        <ScenePropertyNumberInput v-model="option.style.fontSize" :min="10" size="small" />
      </setting-item-box>

      <setting-item-box name="背景颜色" :alone="true">
        <ScenePropertyColorPicker v-model="option.style.background" variant="swatch" />
      </setting-item-box>

      <setting-item-box name="表头背景" :alone="true">
        <ScenePropertyColorPicker v-model="option.style.headerBackground" variant="swatch" />
      </setting-item-box>

      <setting-item-box name="文字颜色" :alone="true">
        <ScenePropertyColorPicker v-model="option.style.textColor" variant="swatch" />
      </setting-item-box>

      <setting-item-box name="表头文字" :alone="true">
        <ScenePropertyColorPicker v-model="option.style.headerTextColor" variant="swatch" />
      </setting-item-box>

      <setting-item-box name="边框颜色" :alone="true">
        <ScenePropertyColorPicker v-model="option.style.borderColor" variant="swatch" />
      </setting-item-box>

      <template v-if="variant === 'zebra' || variant === 'pagination'">
        <setting-item-box name="显示斑马纹" :alone="true">
          <ScenePropertySwitch v-model="option.style.stripe" />
        </setting-item-box>

        <setting-item-box name="斑马纹颜色" :alone="true">
          <ScenePropertyColorPicker v-model="option.style.stripeColor" variant="swatch" />
        </setting-item-box>
      </template>

      <template v-if="variant === 'scroll'">
        <setting-item-box name="是否轮播" :alone="true">
          <ScenePropertySwitch v-model="option.swiper" />
        </setting-item-box>

        <setting-item-box name="最大展示数" :alone="true">
          <ScenePropertyNumberInput v-model="option.maxNum" :min="1" size="small" />
        </setting-item-box>

        <setting-item-box name="轮播间隔（秒）" :alone="true">
          <ScenePropertyNumberInput v-model="option.waitTime" :min="0.5" :step="0.5" size="small" />
        </setting-item-box>

        <setting-item-box name="轮播方式" :alone="true">
          <ScenePropertySelect v-model="option.carousel" size="small">
            <el-option label="单行轮播" value="single" />
            <el-option label="整页轮播" value="page" />
          </ScenePropertySelect>
        </setting-item-box>
      </template>

      <template v-if="variant === 'pagination'">
        <setting-item-box name="默认页码" :alone="true">
          <ScenePropertyNumberInput v-model="pagination.page" :min="1" size="small" />
        </setting-item-box>

        <setting-item-box name="每页数量" :alone="true">
          <ScenePropertyNumberInput v-model="pagination.pageSize" :min="1" size="small" />
        </setting-item-box>

        <setting-item-box name="每页选项" :alone="true">
          <ScenePropertyInput v-model="pageSizeText" placeholder="5,10,20,30" />
        </setting-item-box>

        <setting-item-box name="数据总数" :alone="true">
          <ScenePropertyNumberInput v-model="pagination.total" :min="0" size="small" />
        </setting-item-box>

        <setting-item-box name="最大页码按钮" :alone="true">
          <ScenePropertyNumberInput
            v-model="pagination.maxPageBtn"
            :min="5"
            :step="2"
            size="small"
          />
        </setting-item-box>

        <template v-if="linkConfig">
          <setting-item-box name="固定基础地址" :alone="true">
            <ScenePropertyInput v-model="linkConfig.baseUrl" placeholder="请输入页面地址或站内路径" />
          </setting-item-box>

          <setting-item-box name="行地址字段" :alone="true">
            <ScenePropertySelect v-model="linkConfig.urlKey" size="small">
              <el-option label="使用固定基础地址" value="" />
              <el-option
                v-for="field in availableFields"
                :key="field.key"
                :label="field.label"
                :value="field.key"
              />
            </ScenePropertySelect>
          </setting-item-box>

          <setting-item-box name="链接参数" :alone="true">
            <div class="table-plus-link-params">
              <div
                v-for="(parameter, index) in linkParameters"
                :key="index"
                class="table-plus-link-params__row"
              >
                <ScenePropertyInput v-model="parameter.name" placeholder="参数名" />
                <ScenePropertySelect
                  v-model="parameter.valueKey"
                  size="small"
                  placeholder="来源字段"
                >
                  <el-option
                    v-for="field in availableFields"
                    :key="field.key"
                    :label="field.label"
                    :value="field.key"
                  />
                </ScenePropertySelect>
                <ScenePropertyButton
                  text
                  native-type="button"
                  :icon="Delete"
                  :aria-label="`删除参数 ${parameter.name || index + 1}`"
                  title="删除参数"
                  @click="removeLinkParameter(index)"
                />
              </div>

              <ScenePropertyButton text native-type="button" :icon="Plus" @click="addLinkParameter">
                添加参数
              </ScenePropertyButton>
            </div>
          </setting-item-box>

          <setting-item-box name="链接文字" :alone="true">
            <ScenePropertyInput v-model="linkConfig.text" placeholder="点击查看" />
          </setting-item-box>

          <setting-item-box name="新页签打开" :alone="true">
            <ScenePropertySwitch v-model="linkOpensInNewWindow" />
          </setting-item-box>
        </template>
      </template>
    </div>
  </TableConfigPanelShell>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { PropType } from 'vue'
import { Delete, Plus } from '@element-plus/icons-vue'
import type { TablePlusOption, TablePlusVariant } from './tableTypes'
import { parseNumberList, parseTextList } from './tableRuntime'
import TableConfigPanelShell from './TableConfigPanelShell.vue'

const props = defineProps({
  option: { type: Object as PropType<TablePlusOption>, required: true },
  variant: { type: String as PropType<TablePlusVariant>, required: true },
})

const pageSizeText = computed({
  get: () => (props.option.pagination?.pageSizeOptions || []).join(','),
  set: (value: string) => {
    if (props.option.pagination) props.option.pagination.pageSizeOptions = parseNumberList(value)
  },
})

const headerText = computed({
  get: () => (props.option.dataset?.dimensions || []).map((item) => item.title).join(','),
  set: (value: string) => {
    const titles = parseTextList(value)
    /** 表头只改展示名称，稳定 key 继续与数据字段对应。 */
    props.option.dataset.dimensions = props.option.dataset.dimensions.map((column, index) => ({
      ...column,
      title: titles[index] || column.title,
    }))
  },
})

/** 分页预设始终提供该对象；初始化阶段的回退用于兼容旧场景缺失 pagination 的情况。 */
const createPagination = () => {
  if (!props.option.pagination) {
    props.option.pagination = {
      page: 1,
      pageSize: 10,
      pageSizeOptions: [5, 10, 20, 30],
      maxPageBtn: 5,
      total: props.option.dataset?.source?.length || 0,
    }
  }
  return props.option.pagination
}

const pagination = createPagination()

/**
 * 源分页表格只在“操作”列声明跳转脚本；迁移后把脚本参数拆成可编辑的静态字段。
 * 初始化阶段为旧场景补齐配置，后续表格渲染只读取声明，不执行任意 JavaScript。
 */
const paginationLinkColumn =
  props.variant === 'pagination'
    ? props.option.dataset?.dimensions?.find((column) => column.link || column.key === 'action')
    : undefined

if (paginationLinkColumn && !paginationLinkColumn.link) {
  paginationLinkColumn.link = {
    // 旧场景缺失目标时等待用户配置，已有链接继续保留原值。
    baseUrl: '',
    params: [{ name: 'id', valueKey: 'drawingId' }],
    text: '点击查看',
    target: '_blank',
  }
}

/** 打开旧场景配置时补齐新参数数组，同时保留旧字段供未升级的运行时继续读取。 */
if (paginationLinkColumn?.link && !paginationLinkColumn.link.params) {
  const name = paginationLinkColumn.link.queryParam?.trim() || 'id'
  const valueKey = paginationLinkColumn.link.valueKey?.trim() || paginationLinkColumn.key
  paginationLinkColumn.link.params = [{ name, valueKey }]
}

const linkConfig = computed(
  () =>
    props.option.dataset?.dimensions?.find((column) => column.link || column.key === 'action')
      ?.link,
)

/**
 * 地址和参数字段允许使用不展示为表格列的行数据，例如 detailUrl、token。
 * 合并列定义与实际行字段后统一供下拉框复用，避免链接元数据被迫显示成表格列。
 */
const availableFields = computed(() => {
  const fields = new Map<string, string>()
  props.option.dataset?.dimensions?.forEach((column) => fields.set(column.key, column.title))
  props.option.dataset?.source?.forEach((row) => {
    Object.keys(row).forEach((key) => {
      if (!fields.has(key)) fields.set(key, key)
    })
  })
  return [...fields].map(([key, title]) => ({
    key,
    label: title === key ? key : `${title}（${key}）`,
  }))
})

const linkParameters = computed(() => linkConfig.value?.params || [])

const addLinkParameter = () => {
  if (!linkConfig.value) return
  if (!linkConfig.value.params) linkConfig.value.params = []
  linkConfig.value.params.push({ name: '', valueKey: '' })
}

const removeLinkParameter = (index: number) => {
  linkConfig.value?.params?.splice(index, 1)
}

const linkOpensInNewWindow = computed({
  get: () => linkConfig.value?.target !== '_self',
  set: (value: boolean) => {
    if (linkConfig.value) linkConfig.value.target = value ? '_blank' : '_self'
  },
})
</script>

<style scoped lang="scss">
.table-plus-link-params {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  min-width: 0;
}
.table-plus-link-params__row {
  display: grid;
  grid-template-columns: minmax(0, 0.85fr) minmax(0, 1.15fr) 28px;
  gap: 4px;
  align-items: center;
  min-width: 0;
}
.table-plus-link-params__row :deep(.scene-edit-property-button) {
  width: 28px;
  min-width: 28px;
  padding: 0;
}
</style>
