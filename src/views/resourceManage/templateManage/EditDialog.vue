<template>
  <!--
    弹层传送到 body，避免管理内容区的固定定位层级使弹窗被左侧固定栏覆盖；桌面与窄视口
    均由 Element Plus 的视口遮罩统一居中，表单不再依赖页面主画布的最小宽度。
    注释必须位于组件标签外，Vue 模板编译器不能在起始标签的属性区解析多行 HTML 注释。
  -->
  <el-dialog
    class="manage-dialog template-manage-dialog"
    modal-class="template-manage-dialog-overlay"
    :model-value="visible"
    width="672px"
    align-center
    :append-to-body="true"
    :show-close="false"
    :close-on-click-modal="false"
    :close-on-press-escape="false"
    @update:model-value="$emit('update:visible', $event)"
    @closed="handleReset"
  >
    <!--
      按 Figma 编辑模板弹窗拆分标题、表单和底栏三段。模板截图外框为 672px，因此在
      复用图片管理弹窗规则的基础上单独校准宽度；短视口只滚动表单主体，避免操作区被遮挡。
    -->
    <div class="template-dialog__top">
      <!--
        编辑器的“另存为模板”与资源管理的“编辑模板”共用完全相同的 Figma 表单结构。
        标题根据模式切换，避免复制一份视觉样式后在两个入口逐步产生像素偏差。
      -->
      <span class="template-dialog__title">{{ dialogTitle }}</span>
      <button
        type="button"
        class="template-dialog__close"
        :aria-label="`关闭${dialogTitle}弹窗`"
        :disabled="submitting"
        @click="handleCancel"
      >
        <el-icon><Close /></el-icon>
      </button>
    </div>

    <div v-loading="detailLoading" class="template-dialog__body">
      <el-form
        ref="ruleFormRef"
        class="template-dialog__form"
        :model="ruleForm"
        :rules="rules"
        label-width="0"
        label-position="top"
        :validate-on-rule-change="false"
      >
        <!-- 名称和描述属于同一基础字段组，组内 16px、与后续字段组 24px 的间距来自 Figma。 -->
        <div class="template-dialog__basic-group">
          <el-form-item prop="templateName" class="template-dialog__field">
            <div class="template-dialog__field-content">
              <label class="template-dialog__label"><i>*</i>模板名称：</label>
              <el-input
                v-model="ruleForm.templateName"
                class="template-dialog__control"
                maxlength="50"
                clearable
                placeholder="请输入名称"
                :disabled="detailLoading || submitting"
              />
            </div>
          </el-form-item>

          <el-form-item prop="templateDesc" class="template-dialog__field">
            <div class="template-dialog__field-content">
              <label class="template-dialog__label">模板描述：</label>
              <el-input
                v-model="ruleForm.templateDesc"
                class="template-dialog__control template-dialog__textarea"
                type="textarea"
                :rows="3"
                maxlength="500"
                placeholder="请输入描述"
                :disabled="detailLoading || submitting"
              />
            </div>
          </el-form-item>
        </div>

        <div class="template-dialog__row">
          <!-- 下拉浮层保留在弹窗内，避免传送到 body 后被模态弹窗遮挡并拦截点击。 -->
          <!-- 模板类型为两个固定产品枚举，编辑和另存模式共用同一必填下拉，不请求字典接口。 -->
          <el-form-item
            prop="templateType"
            class="template-dialog__field template-dialog__field--half"
          >
            <div class="template-dialog__field-content">
              <label class="template-dialog__label"><i>*</i>模板类型：</label>
              <el-select
                v-model="ruleForm.templateType"
                class="template-dialog__control"
                popper-class="manage-dropdown-popper manage-select-popper"
                placeholder="请选择类型"
                :options="TEMPLATE_TYPE_OPTIONS"
                :teleported="false"
                :disabled="detailLoading || submitting"
                @change="handleTemplateTypeChange"
              />
            </div>
          </el-form-item>

          <el-form-item prop="category" class="template-dialog__field template-dialog__field--half">
            <div class="template-dialog__field-content">
              <label class="template-dialog__label"><i>*</i>模板分类：</label>
              <el-select
                v-model="ruleForm.category"
                class="template-dialog__control"
                popper-class="manage-dropdown-popper manage-select-popper"
                placeholder="请选择分类"
                :options="categories"
                :teleported="false"
                :disabled="detailLoading || submitting"
              />
            </div>
          </el-form-item>
        </div>

        <!--
          旧模板资源编辑接口仍没有元素类型字段，因此编辑模式保持只读；快照另存接口已经明确
          提供 saveScope，另存模式允许选择并映射为 twoD、threeD、all。
        -->
        <div
          class="template-dialog__element-type"
          :aria-label="isSaveAsMode ? '模板保存范围' : '模板元素类型，编辑接口暂未开放修改'"
          :title="isSaveAsMode ? '请选择模板保存范围' : '模板元素类型编辑接口暂未开放'"
        >
          <el-radio-group
            v-model="elementTypePresentation"
            class="template-dialog__radio-group"
            :disabled="!isSaveAsMode || detailLoading || submitting"
          >
            <el-radio value="2D">2D元素</el-radio>
            <el-radio value="3D">3D元素</el-radio>
            <el-radio value="2D_3D">2D+3D元素</el-radio>
          </el-radio-group>
        </div>

        <el-form-item
          v-if="props.mode !== 'save-as' || !DIM3D_ADMIN_API"
          prop="coverImageId"
          class="template-dialog__field template-dialog__cover-field"
        >
          <div class="template-dialog__field-content">
            <label class="template-dialog__label">封面图片：</label>
            <el-upload
              ref="coverUploadRef"
              class="template-cover-upload"
              accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
              :show-file-list="false"
              :auto-upload="true"
              :http-request="handleCoverUpload"
              :before-upload="beforeCoverUpload"
              :disabled="detailLoading || coverUploading || submitting"
            >
              <div v-if="coverPreviewUrl" class="template-cover-upload__preview">
                <img :src="coverPreviewUrl" alt="模板封面" class="template-cover-upload__image" />
                <span class="template-cover-upload__replace">更换</span>
              </div>
              <div v-else class="template-cover-upload__empty">
                <el-icon><Plus /></el-icon>
                <span>{{ coverUploading ? '上传中' : '上传图片' }}</span>
              </div>
            </el-upload>
            <p class="template-dialog__hint">注意:点击上传封面图片，支持jpg/png/webp,不超过5MB</p>
          </div>
        </el-form-item>
      </el-form>
    </div>

    <template #footer>
      <div class="template-dialog__footer">
        <el-button class="template-dialog__cancel" :disabled="submitting" @click="handleCancel">
          取消
        </el-button>
        <el-button
          class="template-dialog__save"
          type="primary"
          :loading="submitting"
          :disabled="detailLoading || coverUploading || submitting"
          @click="handleConfirm"
        >
          保存
        </el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { Close, Plus } from '@element-plus/icons-vue'
import {
  ElMessage,
  type FormInstance,
  type FormRules,
  type UploadInstance,
  type UploadProps,
  type UploadRequestOptions,
} from 'element-plus'
import { to } from '@/utils/asyncHandler'
import { getDim3dOssFileById, uploadDim3dOssFile } from '@/servers/manual/dim3d/api/oss'
import { DIM3D_ADMIN_API } from '@/servers/manual/dim3d/api/constants'
import {
  editDim3dTemplate,
  getDim3dTemplateInfo,
  type Dim3dTemplateType,
} from '@/servers/manual/dim3d/api/template'
import {
  createTemplateEditPayload,
  getTemplateEditMissingFieldMessage,
  type TemplateEditFormState,
} from './templateEditState'
import { DEFAULT_TEMPLATE_TYPE, TEMPLATE_TYPE_OPTIONS } from './config'
import type { EditorDim3dSceneTemplateForm } from '@/integrations/scene/editorDim3dSceneTemplateService'

/** 列表卡片只作为打开详情的最小上下文，完整可保存字段必须从详情接口取得。 */
interface TemplateEditRecord {
  id: string
  imgPath?: string
}

interface TemplateOption {
  value: string
  label: string
}

type TemplateElementType = '2D' | '3D' | '2D_3D'

/** 设计稿元素范围与新接口 saveScope 的唯一映射，禁止依赖中英文文案推断请求值。 */
const ELEMENT_TYPE_TO_SAVE_SCOPE = {
  '2D': 'twoD',
  '3D': 'threeD',
  '2D_3D': 'all',
} as const satisfies Record<TemplateElementType, EditorDim3dSceneTemplateForm['saveScope']>

type UploadError = Parameters<NonNullable<UploadRequestOptions['onError']>>[0]

const props = defineProps({
  visible: { type: Boolean, default: false },
  /**
   * save-as 供场景编辑器提交当前四包快照，不读取旧模板详情，也绝不调用模板资源编辑接口。
   * 两种模式仅复用同一套表单视觉，提交字段严格按各自真实契约分流。
   */
  mode: { type: String as PropType<'edit' | 'save-as'>, default: 'edit' },
  editRecord: { type: Object as PropType<TemplateEditRecord> },
  categories: { type: Array as PropType<TemplateOption[]>, default: () => [] },
  /**
   * 另存动作由场景编辑页注入，使共享弹窗只负责表单与提交态，不直接读取 SceneStore 或运行时。
   * 回调成功返回表示后端已通过严格响应校验；抛错时弹窗保持打开，方便用户直接修正后重试。
   */
  saveAsHandler: {
    type: Function as PropType<(form: EditorDim3dSceneTemplateForm) => Promise<unknown>>,
  },
})
const emit = defineEmits(['update:visible', 'updateList', 'template-type-change'])

/** 标题由入口模式集中派生，保证可见标题和关闭按钮无障碍名称始终一致。 */
const isSaveAsMode = computed(() => props.mode === 'save-as')
const dialogTitle = computed(() => (isSaveAsMode.value ? '另存为模板' : '编辑模板'))

const ruleFormRef = ref<FormInstance>()
const coverUploadRef = ref<UploadInstance>()
const detailLoading = ref(false)
const coverUploading = ref(false)
const submitting = ref(false)
const coverPreviewUrl = ref('')
/** 编辑模式仅展示该状态；另存模式会通过固定映射生成真实 saveScope。 */
const elementTypePresentation = ref<TemplateElementType>('2D')
let initController: AbortController | undefined
let uploadController: AbortController | undefined
let latestInitRequestId = 0

/**
 * 编辑功能不预填详情字段；另存模式可传入固定默认类型，使弹窗打开即与设计稿的行业方案一致。
 * 模板文件仍只由模板详情回填；资源归属由保存适配层按“模板仅属于系统资源”的业务规则固定补齐。
 */
const createEmptyForm = (templateType?: Dim3dTemplateType): TemplateEditFormState => ({
  templateName: '',
  templateDesc: '',
  templateType,
  category: '',
  templateFileId: '',
  coverImageId: undefined,
})
const ruleForm = reactive<TemplateEditFormState>(createEmptyForm())

const rules = computed<FormRules<TemplateEditFormState>>(() => ({
  templateName: [
    { required: true, message: '请输入模板名称', trigger: 'blur' },
    { min: 1, max: 50, message: '模板名称长度为 1 到 50 个字符', trigger: 'blur' },
  ],
  // 两种模式都必须明确选择固定模板类型，后续接口补齐字段时无需再次调整表单契约。
  templateType: [{ required: true, message: '请选择模板类型', trigger: 'change' }],
  // 另存和编辑都必须提交模板分类；另存接口字段名为 category，不是 sceneCategory。
  category: [{ required: true, message: '请选择模板分类', trigger: 'change' }],
}))

/**
 * 封面编号是 OSS 业务编号，不是可直接访问的 URL。优先复用列表已解析的地址，缺失时
 * 才精确查询对应 ossId；查询失败不清空编号，用户仍可保存名称、描述或分类的修改。
 */
const resolveCoverPreviewUrl = async (
  coverImageId: string,
  listedUrl: string | undefined,
  signal: AbortSignal,
) => {
  const existingUrl = String(listedUrl ?? '').trim()
  if (existingUrl) return existingUrl
  if (!coverImageId) return ''

  const [error, response] = await to(
    getDim3dOssFileById(coverImageId, { signal, suppressNotFoundNotification: true }),
  )
  if (error || signal.aborted) return ''
  return (
    response?.data?.find((file) => String(file.ossId ?? '').trim() === coverImageId)?.url?.trim() ||
    ''
  )
}

/**
 * 每次打开都从详情接口重建表单，避免列表缺 templateFileId 时发生空字段保存。请求序号和
 * AbortController 双重保护快速切卡、关闭弹窗等场景，过期响应不会回写当前表单。
 */
const initializeEditForm = async (record?: TemplateEditRecord) => {
  const requestId = ++latestInitRequestId
  initController?.abort()
  const controller = new AbortController()
  initController = controller
  const id = String(record?.id ?? '').trim()

  Object.assign(ruleForm, createEmptyForm())
  coverPreviewUrl.value = ''
  elementTypePresentation.value = '2D'
  ruleFormRef.value?.clearValidate()

  if (!id) {
    ElMessage.error('当前模板缺少有效编号，无法编辑')
    emit('update:visible', false)
    return
  }

  detailLoading.value = true
  const [error, response] = await to(
    getDim3dTemplateInfo(id, { signal: controller.signal, suppressNotFoundNotification: true }),
  )
  if (requestId !== latestInitRequestId || controller.signal.aborted || !props.visible) return

  if (error || !response?.data || (response.code !== undefined && response.code !== 200)) {
    ElMessage.error(error?.message || response?.msg || '模板详情加载失败，请稍后重试')
    emit('update:visible', false)
    detailLoading.value = false
    return
  }

  const detail = response.data
  const coverImageId = String(detail.coverImageId ?? '').trim()
  Object.assign(ruleForm, {
    templateName: String(detail.templateName ?? '').trim(),
    templateDesc: String(detail.templateDesc ?? '').trim(),
    templateType: detail.templateType as Dim3dTemplateType | undefined,
    category: String(detail.category ?? '').trim(),
    templateFileId: String(detail.templateFileId ?? '').trim(),
    coverImageId: coverImageId || undefined,
  })

  const coverUrl = await resolveCoverPreviewUrl(coverImageId, record?.imgPath, controller.signal)
  if (requestId !== latestInitRequestId || controller.signal.aborted || !props.visible) return
  coverPreviewUrl.value = coverUrl
  detailLoading.value = false
  await nextTick()
  ruleFormRef.value?.clearValidate()
}

/**
 * 另存为模式不具备已有模板编号，打开时按固定默认类型重置本地表单，禁止触发详情查询。
 * 复用同一份清理逻辑可避免从编辑模式切换到另存为模式时残留旧封面或异步响应回写。
 */
const initializeSaveAsForm = () => {
  latestInitRequestId += 1
  initController?.abort()
  initController = undefined
  Object.assign(ruleForm, createEmptyForm(DEFAULT_TEMPLATE_TYPE))
  coverPreviewUrl.value = ''
  elementTypePresentation.value = '2D'
  ruleFormRef.value?.clearValidate()
}

/**
 * 模板类型变化后立即清空旧分类，并通知入口页面加载对应模板类型的独立字典。
 * 分类编码属于类型专属值域，不能把行业方案已选编码带到展厅模板提交请求中。
 */
const handleTemplateTypeChange = (value: Dim3dTemplateType) => {
  if (!isSaveAsMode.value) return
  ruleForm.category = ''
  emit('template-type-change', value)
}

watch([() => props.visible, () => props.editRecord, () => props.mode], ([visible, record]) => {
  if (!visible) return
  if (isSaveAsMode.value) {
    initializeSaveAsForm()
    return
  }
  void initializeEditForm(record)
})

/** 上传前同时校验扩展名和媒体类型，兼容部分浏览器未提供 MIME 类型的合法图片文件。 */
const beforeCoverUpload: UploadProps['beforeUpload'] = (rawFile) => {
  const extension = rawFile.name.split('.').pop()?.toLowerCase() || ''
  const allowedExtensions = new Set(['jpg', 'jpeg', 'png', 'webp'])
  const allowedMimeTypes = new Set(['image/jpeg', 'image/png', 'image/webp'])
  const typeAllowed = !rawFile.type || allowedMimeTypes.has(rawFile.type.toLowerCase())
  if (!allowedExtensions.has(extension) || !typeAllowed) {
    ElMessage.error('当前仅能上传 jpg、png 或 webp 图片')
    return false
  }
  if (rawFile.size > 5 * 1024 * 1024) {
    ElMessage.error('图片大小需小于5MB')
    return false
  }
  return true
}

/** 将上传异常转换成 Element Plus 标准错误对象，确保失败后控件仍可再次选择文件。 */
const createUploadError = (error: unknown, options: UploadRequestOptions) => {
  const message = error instanceof Error ? error.message : String(error || '封面上传失败')
  return Object.assign(new Error(message), {
    name: 'UploadAjaxError',
    status: 0,
    method: options.method,
    url: options.action,
  }) as UploadError
}

/**
 * 上传成功只写入 ossId，url 仅用于本次即时预览。替换上传异常时原编号和原预览均会恢复，
 * 这样编辑其他字段时不会意外丢失已绑定封面；关闭弹窗时中止请求避免异步回写。
 */
const handleCoverUpload = async (options: UploadRequestOptions) => {
  if (coverUploading.value) {
    options.onError?.(createUploadError(new Error('封面图片正在上传，请稍候'), options))
    return
  }

  const previousCoverId = ruleForm.coverImageId
  const previousPreviewUrl = coverPreviewUrl.value
  const controller = new AbortController()
  uploadController = controller
  coverUploading.value = true

  try {
    const response = await uploadDim3dOssFile(options.file as File, { signal: controller.signal })
    if (controller.signal.aborted) return
    const ossId = String(response.data?.ossId ?? '').trim()
    if (response.code !== 200) throw new Error(response.msg || '封面上传失败')
    if (!ossId) throw new Error('封面上传成功但缺少文件编号')

    ruleForm.coverImageId = ossId
    coverPreviewUrl.value = response.data?.url?.trim() || ''
    coverUploadRef.value?.clearFiles()
    options.onSuccess?.(response)
    ElMessage.success('封面上传成功')
  } catch (error) {
    if (controller.signal.aborted) return
    ruleForm.coverImageId = previousCoverId
    coverPreviewUrl.value = previousPreviewUrl
    coverUploadRef.value?.clearFiles()
    options.onError?.(createUploadError(error, options))
    ElMessage.error(error instanceof Error ? error.message : '封面上传失败，请重试')
  } finally {
    if (uploadController === controller) {
      uploadController = undefined
      coverUploading.value = false
    }
  }
}

/**
 * 保存先执行可见字段校验，再校验隐藏的模板文件编号，最后通过统一适配器生成请求体。
 * 这一顺序既不让用户看到无关的内部字段校验，也确保提交锁阻止连续点击造成重复编辑。
 */
const handleConfirm = async () => {
  if (!ruleFormRef.value || submitting.value) return
  if (detailLoading.value || coverUploading.value) {
    ElMessage.warning(detailLoading.value ? '模板详情仍在加载，请稍候' : '封面图片仍在上传，请稍候')
    return
  }

  const valid = await ruleFormRef.value.validate().catch(() => false)
  if (!valid) {
    ElMessage.error('请填写完整信息')
    return
  }

  /**
   * 另存模式将模板类型、模板分类和其他元数据交给场景编辑页，由其采集同一时刻的四包快照。
   * 模板分类必须映射为后端要求的 category 字段，不能复用场景分类字段名。
   */
  if (isSaveAsMode.value) {
    if (!props.saveAsHandler) {
      ElMessage.error('另存为模板处理器未就绪')
      return
    }
    if (!ruleForm.templateType) {
      ElMessage.error('请选择模板类型')
      return
    }
    const form: EditorDim3dSceneTemplateForm = {
      name: ruleForm.templateName.trim(),
      templateType: ruleForm.templateType,
      category: ruleForm.category.trim(),
      saveScope: ELEMENT_TYPE_TO_SAVE_SCOPE[elementTypePresentation.value],
      ...(ruleForm.templateDesc.trim() ? { sceneDesc: ruleForm.templateDesc.trim() } : {}),
      ...(String(ruleForm.coverImageId ?? '').trim()
        ? { coverAssetId: String(ruleForm.coverImageId).trim() }
        : {}),
    }

    submitting.value = true
    const [error] = await to(props.saveAsHandler(form))
    submitting.value = false
    if (error) {
      ElMessage.error(error.message || '另存为模板失败，请稍后重试')
      return
    }

    ElMessage.success('另存为模板成功')
    emit('update:visible', false)
    return
  }

  const missingMessage = getTemplateEditMissingFieldMessage(ruleForm)
  if (missingMessage) {
    ElMessage.error(missingMessage)
    return
  }
  const body = createTemplateEditPayload(ruleForm)
  const id = String(props.editRecord?.id ?? '').trim()
  if (!body || !id) {
    ElMessage.error(body ? '当前模板缺少有效编号，无法保存' : '模板信息不完整，暂不能保存')
    return
  }

  submitting.value = true
  const [error, response] = await to(editDim3dTemplate(id, body))
  submitting.value = false
  if (error || (response?.code !== undefined && response.code !== 200)) {
    ElMessage.error(error?.message || response?.msg || '编辑模板失败，请稍后重试')
    return
  }

  ElMessage.success('编辑模板成功')
  emit('updateList')
  emit('update:visible', false)
}

/** 保存期间锁定关闭动作，正常关闭时仅触发父级状态变更，清理留给 closed 动画完成事件。 */
const handleCancel = () => {
  if (submitting.value) return
  emit('update:visible', false)
}

/**
 * 关闭完成后统一中止尚未结束的详情和上传请求，并清空本地预览，防止下次打开短暂展示
 * 上一次模板数据。请求序号递增后，任何迟到响应均无法回写已重置表单。
 */
const handleReset = () => {
  latestInitRequestId += 1
  initController?.abort()
  uploadController?.abort()
  initController = undefined
  uploadController = undefined
  detailLoading.value = false
  coverUploading.value = false
  submitting.value = false
  coverPreviewUrl.value = ''
  elementTypePresentation.value = '2D'
  coverUploadRef.value?.clearFiles()
  Object.assign(ruleForm, createEmptyForm())
  ruleFormRef.value?.clearValidate()
}
</script>

<style scoped lang="scss">
/* 遮罩使用 Figma 的 40% 黑色，专用类覆盖全局管理弹窗的装饰效果而不影响其他弹窗。 */
:global(.template-manage-dialog-overlay.el-overlay) {
  background: rgb(0 0 0 / 40%);
  backdrop-filter: none;
}
:global(.template-manage-dialog.el-dialog) {
  /* Figma 截图外框为 672px，配合 24px 两侧内边距后得到 624px 内容宽度。 */
  width: 672px !important;
  max-width: calc(100vw - 32px);
  padding: 0;
  overflow: hidden;
  background: var(--manage-color-panel, #ffffff);
  border: 0;
  border-radius: 8px;
  box-shadow: 0 8px 24px rgb(0 0 0 / 12%);
  backdrop-filter: none;
}

/*
  场景编辑器入口使用深色主题：仅在该路由为复用弹窗注入管理主题令牌，资源管理页自身的
  明暗主题变量不受影响。背景不在这里强制覆盖，继续由编辑器全局对话框规则统一控制。
*/
:global(body.scene-edit-route-open .el-overlay.el-modal-dialog .template-manage-dialog.el-dialog) {
  /* 直接复用管理页深色模式的实际令牌，保证两个入口的面板和控件颜色一致。 */
  --manage-color-panel: #1f2e3f;
  --manage-color-panel-deep: #182638;
  --manage-color-input: #152333;
  --manage-color-text-primary: rgb(255 255 255 / 80%);
  --manage-color-text-secondary: rgb(255 255 255 / 68%);
  --manage-color-text-tertiary: rgb(255 255 255 / 40%);
  --manage-color-line: rgb(255 255 255 / 14%);
  --manage-color-line-component: rgb(255 255 255 / 16%);
  --manage-color-line-hover: rgb(255 255 255 / 28%);
  --manage-color-upload-surface: #152333;
  --manage-color-upload-border: rgb(255 255 255 / 16%);
  --manage-color-accent: #51a195;
  --manage-bg-input: var(--manage-color-input);
  --manage-text: var(--manage-color-text-primary);
  --manage-text-2: var(--manage-color-text-secondary);
  --manage-text-3: var(--manage-color-text-tertiary);
  --manage-accent: var(--manage-color-accent);
  --el-bg-color: var(--manage-color-panel);
  --el-fill-color-blank: var(--manage-color-panel);
  --el-fill-color-light: var(--manage-color-input);
  --el-text-color-primary: var(--manage-color-text-primary);
  --el-text-color-regular: var(--manage-color-text-secondary);
  --el-text-color-placeholder: var(--manage-color-text-tertiary);
  --el-border-color: var(--manage-color-line);
  --el-border-color-light: var(--manage-color-line);
  --el-color-primary: var(--manage-color-accent);

  background: var(--manage-color-panel) !important;
  border: 1px solid var(--manage-color-line) !important;
  box-shadow: 0 16px 40px rgb(0 0 0 / 30%) !important;
}

/*
  场景主题在 body 层对 Element Plus 控件使用了更深的通用规则；以下高优先级选择器仅覆盖
  这一个复用弹窗，修正描述框白底、输入框底色和管理页深色模式不一致的问题。
*/
:global(body.scene-edit-route-open .template-manage-dialog .el-input__wrapper),
:global(body.scene-edit-route-open .template-manage-dialog .el-select__wrapper),
:global(body.scene-edit-route-open .template-manage-dialog .el-textarea__inner) {
  color: var(--manage-text) !important;
  background: var(--manage-color-input) !important;
  background-color: var(--manage-color-input) !important;
  border-color: var(--manage-color-line-component) !important;
  box-shadow: inset 0 0 0 1px var(--manage-color-line-component) !important;
}
:global(body.scene-edit-route-open .template-manage-dialog .el-input__inner),
:global(body.scene-edit-route-open .template-manage-dialog .el-select__selected-item),
:global(body.scene-edit-route-open .template-manage-dialog .el-select__placeholder),
:global(body.scene-edit-route-open .template-manage-dialog .el-input__icon),
:global(body.scene-edit-route-open .template-manage-dialog .el-select__icon),
:global(body.scene-edit-route-open .template-manage-dialog .el-textarea__inner) {
  color: var(--manage-text) !important;
}
:global(body.scene-edit-route-open .template-manage-dialog .el-input__inner::placeholder),
:global(body.scene-edit-route-open .template-manage-dialog .el-textarea__inner::placeholder) {
  color: var(--manage-text-3) !important;
}
:global(body.scene-edit-route-open .template-manage-dialog .template-dialog__top),
:global(body.scene-edit-route-open .template-manage-dialog .template-dialog__footer) {
  border-color: var(--manage-color-line) !important;
}
:global(body.scene-edit-route-open .template-manage-dialog .template-dialog__label),
:global(body.scene-edit-route-open .template-manage-dialog .template-dialog__title),
:global(
  body.scene-edit-route-open .template-manage-dialog .template-dialog__radio-group .el-radio__label
) {
  color: var(--manage-text-2) !important;
}
:global(body.scene-edit-route-open .template-manage-dialog .template-cover-upload__empty),
:global(body.scene-edit-route-open .template-manage-dialog .template-cover-upload__preview) {
  color: var(--manage-accent) !important;
  background: var(--manage-color-upload-surface) !important;
  border-color: var(--manage-color-upload-border) !important;
}
:global(body.scene-edit-route-open .template-manage-dialog .template-dialog__hint) {
  color: var(--manage-text-3) !important;
}

/* 下拉层由 Element Plus 传送到 body，单独补齐管理页深色模式的面板、选项和选中态。 */
:global(body.scene-edit-route-open .manage-select-popper.el-select__popper),
:global(body.scene-edit-route-open .manage-select-popper .el-select-dropdown),
:global(body.scene-edit-route-open .manage-select-popper .el-scrollbar),
:global(body.scene-edit-route-open .manage-select-popper .el-scrollbar__view) {
  color: rgb(255 255 255 / 68%) !important;
  background: #1f2e3f !important;
  border-color: rgb(255 255 255 / 14%) !important;
}
:global(body.scene-edit-route-open .manage-select-popper .el-select-dropdown__item) {
  color: rgb(255 255 255 / 68%) !important;
  background: transparent !important;
}
:global(body.scene-edit-route-open .manage-select-popper .el-select-dropdown__item:hover),
:global(body.scene-edit-route-open .manage-select-popper .el-select-dropdown__item.hover),
:global(body.scene-edit-route-open .manage-select-popper .el-select-dropdown__item.is-hovering) {
  color: #ffffff !important;
  background: rgb(81 161 149 / 16%) !important;
}
:global(body.scene-edit-route-open .manage-select-popper .el-select-dropdown__item.selected),
:global(body.scene-edit-route-open .manage-select-popper .el-select-dropdown__item.is-selected) {
  color: #ffffff !important;
  background: #51a195 !important;
}
:global(body.scene-edit-route-open .manage-select-popper .el-popper__arrow::before) {
  background: #1f2e3f !important;
  border-color: rgb(255 255 255 / 14%) !important;
}
:global(.template-manage-dialog.el-dialog::before),
:global(.template-manage-dialog .el-dialog__header) {
  display: none;
}
:global(.template-manage-dialog .el-dialog__body),
:global(.template-manage-dialog .el-dialog__footer) {
  padding: 0 !important;
}
:global(.template-manage-dialog .el-dialog__body) {
  color: var(--manage-text-2, #595959);
}
.template-dialog__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 48px;
  padding: 0 24px;
  border-bottom: 1px solid var(--manage-color-line, #e5e5e5);
}
.template-dialog__title,
.template-dialog__label,
.template-dialog__control,
.template-dialog__radio-group,
.template-dialog__hint,
.template-dialog__footer {
  font-family: 'Source Han Sans SC', 'Microsoft YaHei', sans-serif;
  font-synthesis: none;
  letter-spacing: 0;
}
.template-dialog__title {
  font-size: 16px;
  font-weight: 400;
  line-height: 24px;
  color: var(--manage-text, rgb(0 0 0 / 85%));
}
.template-dialog__close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  font-size: 16px;
  color: var(--manage-text-2, rgb(0 0 0 / 45%));
  cursor: pointer;
  background: transparent;
  border: 0;
}
.template-dialog__close:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
.template-dialog__body {
  padding: 24px 24px 0;
}
.template-dialog__form {
  display: flex;
  flex-direction: column;
  gap: 24px;
}
.template-dialog__basic-group {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.template-dialog__row {
  display: flex;
  gap: 16px;
  width: 100%;
}
.template-dialog__field,
.template-dialog__field-content {
  width: 100%;
}
.template-dialog__field {
  margin-bottom: 0;
}
.template-dialog__field--half {
  flex: 1 1 0;
  min-width: 0;
}
.template-dialog__field :deep(.el-form-item__content) {
  display: block;
  line-height: normal;
}
.template-dialog__field :deep(.el-form-item__error) {
  z-index: 2;
  padding-top: 2px;
  line-height: 16px;
}
.template-dialog__label {
  display: block;
  height: 22px;
  margin-bottom: 8px;
  font-size: 14px;
  font-weight: 400;
  line-height: 22px;
  color: var(--manage-text-2, #595959);
}
.template-dialog__label i {
  font-style: normal;
  color: #ed7b2f;
}
.template-dialog__control {
  width: 100%;
}
.template-dialog__control :deep(.el-input__wrapper),
.template-dialog__control :deep(.el-select__wrapper) {
  height: 32px;
  min-height: 32px;
  padding: 0 16px;
  border-radius: 8px;
  box-shadow: inset 0 0 0 1px var(--manage-color-line-component, #d9d9d9) !important;
}
.template-dialog__control :deep(.el-input__inner),
.template-dialog__control :deep(.el-select__selected-item),
.template-dialog__textarea :deep(.el-textarea__inner) {
  font-family: 'Source Han Sans SC', 'Microsoft YaHei', sans-serif;
  font-size: 14px;
  line-height: 22px;
}
.template-dialog__textarea :deep(.el-textarea__inner) {
  height: 90px !important;
  min-height: 90px !important;
  padding: 5px 16px;
  resize: none;
  border-radius: 8px;
  box-shadow: inset 0 0 0 1px var(--manage-color-line-component, #d9d9d9) !important;
}
.template-dialog__element-type {
  display: flex;
  align-items: center;
  min-height: 22px;
}
.template-dialog__radio-group {
  display: flex;
  gap: 24px;
  align-items: center;
  height: 22px;
}
.template-dialog__radio-group :deep(.el-radio) {
  height: 22px;
  margin-right: 0;
}

/* 接口未开放的只读单选仍按 Figma 正常态显示，不用 Element Plus 的灰色禁用视觉误导状态。 */
.template-dialog__radio-group :deep(.el-radio.is-disabled),
.template-dialog__radio-group :deep(.el-radio__input.is-disabled + .el-radio__label) {
  color: var(--manage-text, #333333);
  cursor: not-allowed;
}
.template-dialog__radio-group :deep(.el-radio__label) {
  padding-left: 8px;
  font-size: 14px;
  line-height: 22px;
  color: var(--manage-text, #333333);
}
.template-dialog__radio-group :deep(.el-radio__inner) {
  width: 16px;
  height: 16px;
  border-color: #b8b9bb;
}
.template-dialog__radio-group :deep(.el-radio__input.is-checked .el-radio__inner) {
  background: transparent;
  border-color: var(--manage-accent, #51a195);
}
.template-dialog__radio-group :deep(.el-radio__input.is-checked .el-radio__inner::after) {
  width: 8px;
  height: 8px;
  background: var(--manage-accent, #51a195);
}
.template-dialog__radio-group :deep(.el-radio__input.is-disabled .el-radio__inner) {
  background: transparent;
  border-color: #b8b9bb;
}
.template-dialog__radio-group :deep(.el-radio__input.is-disabled.is-checked .el-radio__inner) {
  border-color: var(--manage-accent, #51a195);
}
.template-dialog__radio-group
  :deep(.el-radio__input.is-disabled.is-checked .el-radio__inner::after) {
  background: var(--manage-accent, #51a195);
}
.template-cover-upload {
  width: 72px;
  height: 72px;
}
.template-cover-upload :deep(.el-upload) {
  width: 72px;
  height: 72px;
  border: 0;
}
.template-cover-upload__empty,
.template-cover-upload__preview {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 72px;
  height: 72px;
  overflow: hidden;
  color: var(--manage-accent, #51a195);
  background: var(--manage-color-upload-surface, #fafafa);
  border: 1px solid var(--manage-color-upload-border, #d9d9d9);
  border-radius: 8px;
}
.template-cover-upload__empty :deep(.el-icon) {
  margin-bottom: 3px;
  font-size: 14px;
  color: #cfcfcf;
}
.template-cover-upload__empty span,
.template-cover-upload__replace {
  font-size: 12px;
  line-height: 20px;
}
.template-cover-upload__image {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.template-cover-upload__replace {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  color: #ffffff;
  text-align: center;
  background: rgb(0 0 0 / 45%);
}
.template-dialog__hint {
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 22px;
  color: var(--manage-text-3, #b8b9bb);
}
.template-dialog__footer {
  display: flex;
  gap: 16px;
  justify-content: flex-end;
  min-height: 73px;
  padding-top: 16px;
  margin: 24px 24px 0;
  border-top: 1px solid var(--manage-color-line, #e5e5e5);
}
.template-dialog__footer .el-button {
  width: 65px;
  height: 32px;
  padding: 0;
  margin: 0;
  font-family: 'Source Han Sans SC', 'Microsoft YaHei', sans-serif;
  font-size: 14px;
  font-weight: 400;
  line-height: 22px;
  border-radius: 4px;
  box-shadow: none;
}
.template-dialog__cancel {
  color: var(--manage-accent, #51a195) !important;
  background: transparent !important;
  border-color: var(--manage-accent, #51a195) !important;
}
.template-dialog__save {
  color: #ffffff !important;
  background: var(--manage-accent, #51a195) !important;
  border-color: var(--manage-accent, #51a195) !important;
}

/* 短视口保持标题和按钮锚定，只让长表单独立滚动，并继承管理弹窗的绿色细滚动条。 */
@media (height <= 786px) {
  :global(.template-manage-dialog.el-dialog) {
    max-height: calc(100vh - 32px);
  }
  .template-dialog__body {
    max-height: calc(100vh - 177px);
    overflow-y: auto;
    scrollbar-color: var(--manage-color-dialog-scrollbar-thumb, #b4d5d1) transparent;
    scrollbar-width: thin;
  }
  .template-dialog__body::-webkit-scrollbar {
    width: 5px;
  }
  .template-dialog__body::-webkit-scrollbar-thumb {
    background: var(--manage-color-dialog-scrollbar-thumb, #b4d5d1);
    border-radius: 4px;
  }
}

@media (width <= 680px) {
  .template-dialog__top,
  .template-dialog__body {
    padding-right: 16px;
    padding-left: 16px;
  }
  .template-dialog__row {
    flex-direction: column;
  }
  .template-dialog__footer {
    margin-right: 16px;
    margin-left: 16px;
  }
}
</style>
