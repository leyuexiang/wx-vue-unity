<template>
  <ScenePropertyDialog
    :model-value="visible"
    class="request-config-panel"
    title="请求配置"
    :width="804"
    :close-on-click-modal="false"
    :close-on-press-escape="false"
    @update:model-value="$emit('update:visible', $event)"
  >
    <!-- 公共接口比动态请求多一个名称字段，其余弹窗结构和配置能力完全共用。 -->
    <div v-if="showNameField" class="rcp-name-field">
      <span class="rcp-label">
        名称
        <!-- 公共接口名称已在保存入口强制校验；此星号仅提供稳定的视觉必填提示。 -->
        <span class="rcp-label__required" aria-label="必填">*</span>
      </span>
      <ScenePropertyInput
        v-model.trim="draftName"
        placeholder="请输入公共接口名称"
        :error-message="nameError"
        aria-label="公共接口名称"
      />
    </div>

    <!-- 两张配置卡片采用单开折叠，避免同时展开后把弹窗撑出设计高度。 -->
    <el-scrollbar max-height="720px" class="rcp-scrollbar">
      <div class="rcp-content">
        <RequestGlobalConfig
          :config="globalDraft"
          :edit-disabled="editDisabled"
          :expanded="expandedSection === 'global'"
          @update:config="handleGlobalUpdate"
          @update:edit-disabled="editDisabled = $event"
          @update:expanded="handleSectionToggle('global', $event)"
        />
        <RequestTargetConfig
          :config="draft"
          :global-config="globalDraft"
          :expanded="expandedSection === 'target'"
          @update:config="draft = $event"
          @update:expanded="handleSectionToggle('target', $event)"
        />
      </div>
    </el-scrollbar>

    <!-- 底部操作栏 -->
    <template #footer>
      <div class="rcp-footer">
        <ScenePropertyButton @click="handleCancel">取消</ScenePropertyButton>
        <ScenePropertyButton type="primary" @click="handleSaveAndSend">
          {{ saveBtnText || '保存&发送请求' }}
        </ScenePropertyButton>
      </div>
    </template>
  </ScenePropertyDialog>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { cloneDeep } from 'lodash-es'
import ScenePropertyDialog from '@/components/ScenePropertyDialog/index.vue'
import type {
  AjaxRequestConfig,
  RequestGlobalConfig as SceneRequestGlobalConfig,
} from '@/types/data-config'
import RequestGlobalConfig from '../RequestGlobalConfig/index.vue'
import RequestTargetConfig from '../RequestTargetConfig/index.vue'

const props = defineProps<{
  visible: boolean
  config: AjaxRequestConfig
  globalConfig: SceneRequestGlobalConfig
  showNameField?: boolean
  nameValue?: string
  saveBtnText?: string
  /** 联合事务由父级确认成功后关闭弹窗并发送请求。 */
  deferConfirmation?: boolean
}>()

const emit = defineEmits<{
  'update:visible': [value: boolean]
  /** 名称与配置原子提交，父级无需依赖 update:name 事件先完成响应式回写。 */
  confirm: [config: AjaxRequestConfig, confirmedName?: string]
  confirmGlobal: [config: SceneRequestGlobalConfig]
  sendRequest: []
  'update:name': [name: string]
}>()

const draft = ref<AjaxRequestConfig>(cloneDeep(props.config))
const draftName = ref(props.nameValue || '')
/** 公共接口名称为空时仅标记当前弹窗草稿，禁止把无效名称写入公共接口列表。 */
const nameError = ref('')
const editDisabled = ref(true)
/**
 * Figma 的两个弹窗状态互为镜像：默认展开当前元素，切换时只展开目标卡片。
 * 状态仅存在于弹窗草稿周期，不写入场景配置，重新打开时保持一致的默认视图。
 */
const expandedSection = ref<'global' | 'target' | null>('target')
/**
 * 全局配置草稿与当前请求草稿分离。
 * 这样“全局公共配置”才不会再写回当前对象自身，切换到别的控件/图表时也能复用同一份场景级配置。
 */
const globalDraft = ref<SceneRequestGlobalConfig>(cloneDeep(props.globalConfig))

watch(
  () => props.visible,
  (val) => {
    if (val) {
      draft.value = cloneDeep(props.config)
      globalDraft.value = cloneDeep(props.globalConfig)
      draftName.value = props.nameValue || ''
      nameError.value = ''
      editDisabled.value = true
      expandedSection.value = 'target'
    }
  },
)

/**
 * 用户补全名称后即时撤销必填提示；空白输入仍保留提示，避免误以为仅输入空格即可保存。
 * 该监听只更新局部视觉状态，不触发公共接口保存或网络请求。
 */
watch(draftName, (value) => {
  if (value.trim()) {
    nameError.value = ''
  }
})

function handleGlobalUpdate(config: SceneRequestGlobalConfig) {
  globalDraft.value = config
}

function handleSectionToggle(section: 'global' | 'target', expanded: boolean) {
  expandedSection.value = expanded ? section : null
}

function handleCancel() {
  /** 取消只关闭草稿弹窗，不向父级提交任何配置，保证公共接口和动态请求行为一致。 */
  emit('update:visible', false)
}

function handleSaveAndSend() {
  /**
   * 公共接口名称是列表选择、保存和后续组件引用的稳定展示字段，不能允许空值提交。
   * 校验失败时在当前弹窗展示共享输入错误提示，并在 emit 前直接返回，因而不会关闭弹窗或修改任何配置。
   */
  const normalizedName = draftName.value.trim()
  if (props.showNameField && !normalizedName) {
    nameError.value = '请输入公共接口名称'
    return
  }

  const confirmedConfig = cloneDeep(draft.value)
  if (props.showNameField) {
    /**
     * update:name 继续同步父级草稿；确认事件同时显式携带本次名称，保存逻辑不再依赖
     * 两个事件的处理顺序。兼容字段只用于旧协议，写入列表时会与正式 name 保持一致。
     */
    emit('update:name', normalizedName)
    confirmedConfig.requestName = normalizedName
  }
  emit('confirmGlobal', cloneDeep(globalDraft.value))
  emit('confirm', confirmedConfig, props.showNameField ? normalizedName : undefined)
  if (props.deferConfirmation) return
  emit('sendRequest')
  emit('update:visible', false)
}
</script>

<style scoped lang="scss">
/**
 * 请求配置弹窗必须覆盖编辑器历史主题中的渐变背景、18px 标题留白和胶囊按钮。
 * 弹窗传送到 body 后仍保留 request-config-panel 类，因此用带路由根节点的全局选择器限定作用域；
 * 这样可以精确落实 Figma 节点 1:5133/1:5265，又不会改变其它共享属性弹窗的外观。
 */
:global(body.scene-edit-route-open .request-config-panel.scene-edit-dialog) {
  /** Element Plus 弹窗根默认带 16px 内边距；必须清零，设计留白仅由头部、正文和底部各自承担。 */
  padding: 0 !important;
  overflow: hidden;
  background: #1d2a35 !important;
  border: 1px solid rgb(255 255 255 / 5%) !important;
  border-radius: 4px !important;
  box-shadow: none !important;
}
:global(body.scene-edit-route-open .request-config-panel .el-dialog__header) {
  box-sizing: border-box;
  height: 55px !important;
  padding: 20px 20px 12px !important;
  margin: 0 !important;
  background: #1d2a35 !important;
  border-bottom: 1px solid rgb(255 255 255 / 5%) !important;
}
:global(body.scene-edit-route-open .request-config-panel .el-dialog__title) {
  font-size: 16px;
  font-weight: 500;
  line-height: 23px;
  color: #ffffff;
}
:global(body.scene-edit-route-open .request-config-panel .el-dialog__headerbtn) {
  top: 19px;
  right: 20px;
  width: 16px;
  height: 16px;
}
:global(body.scene-edit-route-open .request-config-panel .el-dialog__close) {
  font-size: 16px;
  color: rgb(255 255 255 / 60%);
}
:global(body.scene-edit-route-open .request-config-panel .el-dialog__body) {
  padding: 0 !important;
  overflow: hidden;
  background: #1d2a35 !important;
}
:global(body.scene-edit-route-open .request-config-panel .el-dialog__footer) {
  box-sizing: border-box;
  height: 64px;
  padding: 12px 20px 20px !important;
  background: #1d2a35 !important;
  border-top: 1px solid rgb(255 255 255 / 5%) !important;
}
:global(body.scene-edit-route-open .request-config-panel .rcp-footer .scene-edit-property-button) {
  height: 32px;
  min-height: 32px;
  padding: 2px 12px;
  font-size: 14px;
  font-weight: 400;
  line-height: 20px;
  border-radius: 2px !important;
  transform: none;
}
:global(
  body.scene-edit-route-open
    .request-config-panel
    .rcp-footer
    .scene-edit-property-button.el-button--primary
) {
  background: #48998e !important;
  border-color: #48998e !important;
}
:global(
  body.scene-edit-route-open
    .request-config-panel
    .rcp-footer
    .scene-edit-property-button:not(.el-button--primary)
) {
  color: rgb(255 255 255 / 80%);
  background: transparent !important;
  border-color: rgb(255 255 255 / 40%) !important;
}
.rcp-name-field {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 0 20px 12px;
}
.rcp-label {
  flex-shrink: 0;
  font-size: 13px;
  color: var(--scene-edit-text-2);
}
.rcp-label__required {
  margin-left: 2px;
  color: #e16e6e;
}
.rcp-scrollbar {
  min-width: 0;
}
.rcp-content {
  display: flex;
  flex-direction: column;
  gap: 20px;
  min-width: 0;
  padding: 0 20px 12px;
}
.rcp-footer {
  display: flex;
  gap: 16px;
  align-items: center;
  justify-content: flex-end;
  width: 100%;
}

/** 窄弹窗收紧内容留白并允许底部信息换行，避免安全边距之外再产生内部横向滚动。 */
/* stylelint-disable-next-line scss/at-rule-no-unknown -- 插值后的构建产物是浏览器标准 @container。 */
@#{'container'} scene-property-dialog (width <= 620px) {
  .rcp-content {
    gap: 12px;
    padding: 0 12px 12px;
  }
  .rcp-footer {
    gap: 12px;
  }
}
</style>
