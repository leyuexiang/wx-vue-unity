<template>
  <el-dialog
    class="manage-dialog icon-manage-dialog"
    modal-class="icon-manage-dialog-overlay"
    :model-value="visible"
    width="640px"
    align-center
    :show-close="false"
    :close-on-click-modal="false"
    :close-on-press-escape="false"
    @update:model-value="$emit('update:visible', $event)"
    @closed="handleReset(ruleFormRef)"
  >
    <!--
      严格复用模型管理弹窗的三段式结构，并按 Figma 节点 2140:4561 的尺寸重新校准：
      标题栏 48px、内容宽 592px、底部操作区 73px。自定义关闭按钮用于消除
      Element Plus 默认标题栏的内边距差异，确保标题和关闭图标分别距两侧 24px。
    -->
    <div class="icon-dialog__top">
      <span class="icon-dialog__title">{{ editRecord ? '编辑图片' : '新增图片' }}</span>
      <button
        type="button"
        class="icon-dialog__close"
        aria-label="关闭新增图片弹窗"
        :disabled="submitting"
        @click="handleCancel"
      >
        <el-icon><Close /></el-icon>
      </button>
    </div>

    <div class="icon-dialog__body">
      <el-form
        ref="ruleFormRef"
        class="icon-dialog__form"
        :model="ruleForm"
        :rules="rules"
        label-width="0"
        label-position="top"
        :validate-on-rule-change="false"
      >
        <!-- 名称与描述在设计稿中属于同一组，组内间距 16px，和后续字段间距 24px。 -->
        <div class="icon-dialog__basic-group">
          <el-form-item prop="name" class="icon-dialog__field">
            <div class="icon-dialog__field-content">
              <label class="icon-dialog__label"><i>*</i>图片名称：</label>
              <el-input
                v-model="ruleForm.name"
                class="icon-dialog__control"
                maxlength="50"
                clearable
                placeholder="请输入名称"
              />
            </div>
          </el-form-item>

          <el-form-item prop="description" class="icon-dialog__field">
            <div class="icon-dialog__field-content">
              <label class="icon-dialog__label">图片描述：</label>
              <el-input
                v-model="ruleForm.description"
                class="icon-dialog__control icon-dialog__textarea"
                type="textarea"
                :rows="3"
                maxlength="200"
                placeholder="请输入描述"
              />
            </div>
          </el-form-item>
        </div>

        <el-form-item prop="category" class="icon-dialog__field">
          <div class="icon-dialog__field-content">
            <label class="icon-dialog__label"><i>*</i>图片分类：</label>
            <el-select
              v-model="ruleForm.category"
              class="icon-dialog__control"
              popper-class="manage-dropdown-popper manage-select-popper"
              placeholder="请选择图片分类"
              :options="categories"
            />
          </div>
        </el-form-item>

        <el-form-item prop="resourceBelong" class="icon-dialog__field">
          <div class="icon-dialog__field-content">
            <label class="icon-dialog__label"><i>*</i>资源归属：</label>
            <el-radio-group v-model="ruleForm.resourceBelong" class="icon-dialog__radio-group">
              <el-radio
                v-for="option in resourceBelongOptions"
                :key="option.value"
                :value="option.value"
              >
                {{ option.label }}
              </el-radio>
            </el-radio-group>
          </div>
        </el-form-item>

        <el-form-item prop="iconFileId" class="icon-dialog__field icon-dialog__upload-field">
          <div class="icon-dialog__field-content">
            <label class="icon-dialog__label"><i>*</i>图片文件：</label>
            <el-upload
              ref="fileUploadRef"
              class="icon-file-upload"
              drag
              name="file"
              :accept="ICON_FILE_ACCEPT"
              :show-file-list="false"
              :auto-upload="true"
              :limit="1"
              :http-request="handleFileUpload"
              :before-upload="beforeFileUpload"
              :disabled="fileUploading || submitting"
            >
              <div class="icon-file-upload__content">
                <!-- 上传图形直接使用 Figma 节点 2140:4651 的矢量路径，避免临时网络资源失效。 -->
                <svg
                  class="icon-file-upload__icon"
                  width="40"
                  height="40"
                  viewBox="0 0 40 40"
                  fill="none"
                  aria-hidden="true"
                >
                  <circle cx="20" cy="20" r="20" fill="currentColor" fill-opacity="0.1" />
                  <path :d="UPLOAD_ICON_PATH" fill="currentColor" />
                </svg>
                <span class="icon-file-upload__title">{{ uploadTitle }}</span>
                <span class="icon-file-upload__tip">
                  支持格式：.webp、.svg、.png、.jpg、.jpeg
                </span>
                <span class="icon-file-upload__tip">单个文件不超过5MB</span>
              </div>
            </el-upload>
          </div>
        </el-form-item>
      </el-form>
    </div>

    <template #footer>
      <div class="icon-dialog__footer">
        <el-button class="icon-dialog__cancel" :disabled="submitting" @click="handleCancel">
          取消
        </el-button>
        <el-button
          class="icon-dialog__save"
          type="primary"
          :loading="submitting"
          :disabled="fileUploading || submitting"
          @click="handleConfirm(ruleFormRef)"
        >
          保存
        </el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { Close } from '@element-plus/icons-vue'
import {
  ElMessage,
  type FormInstance,
  type FormRules,
  type UploadInstance,
  type UploadProps,
  type UploadRequestOptions,
  type UploadUserFile,
} from 'element-plus'
import { to } from '@/utils/asyncHandler'
import type { TransferListItem } from './index.vue'
import { uploadDim3dOssFile } from '@/servers/manual/dim3d/api/oss'
import { addDim3dIcon, editDim3dIcon, type Dim3dIconForm } from '@/servers/manual/dim3d/api/icon'
import { authContext } from '@/auth/authContext'
import { getResourceBelongOptions } from '../resourceScope'

interface RuleForm {
  name: string
  description: string
  category?: number
  resourceBelong: 'SYSTEM' | 'MINE'
  /** 图片上传接口返回的对象存储编号；后端契约仍使用 iconFileId，不能改成展示文案。 */
  iconFileId: string
  /** 仅保存已上传文件的展示信息，接口提交时不会发送该数组。 */
  fileList: UploadUserFile[]
}

type IconEditRecord = TransferListItem & {
  iconName?: string
  iconDesc?: string
  iconFileId?: string
  resourceBelong?: 'SYSTEM' | 'MINE'
}
type UploadError = Parameters<NonNullable<UploadRequestOptions['onError']>>[0]

/**
 * 原生文件选择框只展示产品允许的五种扩展名，避免额外媒体类型描述在 Windows 筛选项中
 * 产生不一致的“自定义文件”文案；上传前仍由 beforeFileUpload 做扩展名、媒体类型和大小校验。
 */
const ICON_FILE_ACCEPT = '.webp,.svg,.png,.jpg,.jpeg'

const props = defineProps({
  visible: { type: Boolean, default: false },
  editRecord: { type: Object as PropType<IconEditRecord> },
  originCategories: { type: Array as PropType<DimensionsApi.ResourceType[]>, default: () => [] },
  categories: { type: Array as PropType<{ label: string; value: number }[]>, default: () => [] },
})
const emit = defineEmits(['update:visible', 'updateList'])

/** 租户端新增图片只能归属“我的资源”；平台类型仅从已校验的内存鉴权上下文读取。 */
const isTenantPlatform = authContext.getPlatformType() === 'tenant'
const resourceBelongOptions = getResourceBelongOptions(authContext.getPlatformType())
const defaultResourceBelong: RuleForm['resourceBelong'] = isTenantPlatform ? 'MINE' : 'SYSTEM'

/** 租户只能提交我的资源；运营端按保存时选中的目标归属提交，可继续使用原文件。 */
const normalizeResourceBelong = (value?: RuleForm['resourceBelong']): RuleForm['resourceBelong'] =>
  isTenantPlatform ? 'MINE' : value || defaultResourceBelong

const ruleFormRef = ref<FormInstance>()
const fileUploadRef = ref<UploadInstance>()
const fileUploading = ref(false)
const submitting = ref(false)
let uploadController: AbortController | undefined

/** Figma 节点 2140:4651 的原始云朵路径；分段拼接仅用于满足项目单行长度规范。 */
const UPLOAD_ICON_PATH = [
  'M20 10C23.866 10 27 13.134 27 17C27 17.1135 26.9973 17.2264 26.992 17.3386',
  'C29.3265 18.16 31 20.3846 31 23C31 26.3137 28.3137 29 25 29H15C11.6863 29 9 26.3137 9 23',
  'C9 20.3846 10.6735 18.16 13.008 17.3386C13.0027 17.2264 13 17.1135 13 17C13 13.134 16.134 10 20 10Z',
  'M20 12C17.2386 12 15 14.2386 15 17C15 17.0815 15.0019 17.1626 15.0058 17.2434L15.0766 18.7309',
  'L13.6718 19.2252C12.0844 19.7837 11 21.2889 11 23C11 25.2091 12.7909 27 15 27H25',
  'C27.2091 27 29 25.2091 29 23C29 20.79 27.21 19 25 19C23.233 19 21.7337 20.1457 21.2042 21.7347',
  'L19.3064 21.1021C20.1005 18.7185 22.35 17 25 17C25 14.2386 22.7614 12 20 12Z',
].join('')

const createEmptyForm = (): RuleForm => ({
  name: '',
  description: '',
  category: props.categories[0]?.value,
  // 运营端保持设计稿的系统资源默认值；租户端按权限模型默认选中我的资源。
  resourceBelong: defaultResourceBelong,
  iconFileId: '',
  fileList: [],
})
const ruleForm = reactive<RuleForm>(createEmptyForm())

const rules = reactive<FormRules<RuleForm>>({
  name: [
    { required: true, message: '请输入图片名称', trigger: 'blur' },
    { min: 1, max: 50, message: '图片名称长度为 1 到 50 个字符', trigger: 'blur' },
  ],
  category: [{ required: true, message: '请选择图片分类', trigger: 'change' }],
  resourceBelong: [{ required: true, message: '请选择资源归属', trigger: 'change' }],
  iconFileId: [{ required: true, message: '请上传图片文件', trigger: 'change' }],
})

/** 上传态和已上传态只替换主提示文本，上传区几何尺寸始终与设计稿一致。 */
const uploadTitle = computed(() => {
  if (fileUploading.value) return '图片文件上传中'
  const fileName = ruleForm.fileList[0]?.name?.trim()
  return (
    fileName || (ruleForm.iconFileId ? '图片文件已上传，点击可更换' : '点击上传或拖拽文件到此处')
  )
})

/**
 * 编辑详情的分类字段是后端编码，选择器使用旧分类接口的数字编号。
 * 映射只读取现有分类数据，找不到时保持空值，不构造不存在的业务分类。
 */
const resolveCategoryId = (record?: IconEditRecord) => {
  if (!record) return props.categories[0]?.value
  const rawCategory = String(record.category ?? '').trim()
  return (
    props.originCategories.find((item) => String(item.typeCode ?? '') === rawCategory)?.id ??
    props.categories.find((item) => String(item.value) === rawCategory)?.value
  )
}

/** 每次打开弹窗都从当前详情重建表单，避免关闭后的 resetFields 造成同一记录再次打开时为空。 */
const syncForm = (record?: IconEditRecord) => {
  const fileName = record?.imgPath ? '已上传图片' : ''
  Object.assign(ruleForm, {
    name: record?.iconName?.trim() || record?.name?.trim() || '',
    description:
      record?.iconDesc?.trim() ||
      (record?.description && record.description !== '--' ? record.description : ''),
    category: resolveCategoryId(record),
    resourceBelong: normalizeResourceBelong(record?.resourceBelong),
    iconFileId: String(record?.iconFileId ?? '').trim(),
    fileList: fileName && record?.imgPath ? [{ name: fileName, url: record.imgPath }] : [],
  })
  void nextTick(() => ruleFormRef.value?.clearValidate())
}

watch(
  [
    () => props.visible,
    () => props.editRecord,
    () => props.originCategories,
    () => props.categories,
  ],
  ([visible, record]) => {
    if (visible) syncForm(record)
  },
  { immediate: true },
)

const allowedExtensions = new Set(['webp', 'svg', 'png', 'jpg', 'jpeg'])
const allowedMimeTypes = new Set(['image/webp', 'image/svg+xml', 'image/png', 'image/jpeg'])
const MAX_FILE_SIZE = 5 * 1024 * 1024

/**
 * 同时校验扩展名、浏览器提供的媒体类型和 5MB 上限。
 * 对媒体类型为空的合法 SVG 兼容处理，但有媒体类型时不允许扩展名与内容类型明显冲突。
 */
const beforeFileUpload: UploadProps['beforeUpload'] = (rawFile) => {
  const extension = rawFile.name.split('.').pop()?.toLowerCase() || ''
  const typeAllowed = !rawFile.type || allowedMimeTypes.has(rawFile.type.toLowerCase())
  if (!allowedExtensions.has(extension) || !typeAllowed) {
    ElMessage.error('仅支持 webp、svg、png、jpg、jpeg 格式的图片')
    return false
  }
  if (rawFile.size > MAX_FILE_SIZE) {
    ElMessage.error('单个图片文件不能超过5MB')
    return false
  }
  return true
}

/** 统一构造 Element Plus 需要的上传错误对象，避免用类型断言掩盖缺失字段。 */
const createUploadError = (error: unknown, options: UploadRequestOptions) => {
  const message = error instanceof Error ? error.message : String(error || '图片上传失败')
  return Object.assign(new Error(message), {
    name: 'UploadAjaxError',
    status: 0,
    method: options.method,
    url: options.action,
  }) as UploadError
}

/**
 * 上传期间只保留一个请求；弹窗关闭时通过 AbortController 中止请求，防止关闭后异步结果
 * 回写已经重置的表单。替换上传失败时保留原 iconFileId，确保编辑场景仍可保存原图片。
 */
const handleFileUpload = async (options: UploadRequestOptions) => {
  if (fileUploading.value) {
    options.onError?.(createUploadError(new Error('图片文件正在上传，请稍候'), options))
    return
  }

  const previousFileId = ruleForm.iconFileId
  const previousFileList = [...ruleForm.fileList]
  const controller = new AbortController()
  uploadController = controller
  fileUploading.value = true

  try {
    const response = await uploadDim3dOssFile(options.file as File, { signal: controller.signal })
    if (controller.signal.aborted) return

    const ossId = String(response.data?.ossId ?? '').trim()
    const fileUrl = response.data?.url?.trim() || ''
    if (response.code !== 200) throw new Error(response.msg || '图片文件上传失败')
    if (!ossId) throw new Error('图片上传成功但缺少文件编号')

    ruleForm.iconFileId = ossId
    ruleForm.fileList = [{ name: options.file.name, url: fileUrl || undefined }]
    fileUploadRef.value?.clearFiles()
    ruleFormRef.value?.clearValidate('iconFileId')
    options.onSuccess?.(response)
    ElMessage.success('图片文件上传成功')
  } catch (error) {
    if (controller.signal.aborted) return
    ruleForm.iconFileId = previousFileId
    ruleForm.fileList = previousFileList
    fileUploadRef.value?.clearFiles()
    options.onError?.(createUploadError(error, options))
    ElMessage.error(error instanceof Error ? error.message : '图片文件上传失败')
  } finally {
    if (uploadController === controller) {
      uploadController = undefined
      fileUploading.value = false
    }
  }
}

/** 表单使用分类编号，阶段三图片接口使用分类编码；转换失败时禁止发送无效请求。 */
const getCategoryCode = (categoryId?: number) =>
  props.originCategories.find((item) => item.id === categoryId)?.typeCode?.trim() || ''

const handleConfirm = async (formEl?: FormInstance) => {
  if (!formEl || submitting.value) return
  if (fileUploading.value) {
    ElMessage.warning('图片文件仍在上传，请稍候')
    return
  }

  const valid = await formEl.validate().catch(() => false)
  if (!valid) {
    ElMessage.error('请填写完整信息')
    return
  }

  const categoryCode = getCategoryCode(ruleForm.category)
  if (!categoryCode) {
    ElMessage.error('分类接口未返回有效分类编码')
    return
  }

  const body: Dim3dIconForm = {
    iconName: ruleForm.name.trim(),
    iconDesc: ruleForm.description.trim() || undefined,
    category: categoryCode,
    resourceBelong: normalizeResourceBelong(ruleForm.resourceBelong),
    // 未更换文件时提交详情回填的原编号，后端根据锁定的目录关联判断是否迁移。
    iconFileId: ruleForm.iconFileId.trim(),
  }
  const id = props.editRecord?.id ? String(props.editRecord.id) : ''

  submitting.value = true
  const [error] = await to<unknown>(id ? editDim3dIcon(id, body) : addDim3dIcon(body))
  submitting.value = false
  if (error) {
    ElMessage.error(error.message || (id ? '编辑图片失败' : '新增图片失败'))
    return
  }

  ElMessage.success(id ? '编辑图片成功' : '新增图片成功')
  emit('updateList')
  emit('update:visible', false)
}

const handleCancel = () => {
  if (submitting.value) return
  emit('update:visible', false)
}

/** 弹窗关闭动画结束后再清空数据，避免关闭过程中字段突然闪为空白。 */
const handleReset = (formEl?: FormInstance) => {
  uploadController?.abort()
  uploadController = undefined
  fileUploading.value = false
  submitting.value = false
  fileUploadRef.value?.clearFiles()
  Object.assign(ruleForm, createEmptyForm())
  formEl?.clearValidate()
}
</script>

<style scoped lang="scss">
/* 遮罩按 Figma 节点 2140:4560 使用 40% 黑色，不叠加管理页的毛玻璃效果。 */
:global(.icon-manage-dialog-overlay.el-overlay) {
  background: rgb(0 0 0 / 40%);
  backdrop-filter: none;
}

/* 专用类覆盖旧 manage-dialog 的渐变、描边和 16px 圆角，只影响图片新增/编辑弹窗。 */
:global(.icon-manage-dialog.el-dialog) {
  width: 640px !important;
  max-width: calc(100vw - 32px);
  padding: 0;
  overflow: hidden;
  background: var(--manage-color-panel, #ffffff);
  border: 0;
  border-radius: 8px;
  box-shadow: 0 8px 24px rgb(0 0 0 / 12%);
  backdrop-filter: none;
}
:global(.icon-manage-dialog.el-dialog::before) {
  display: none;
}
:global(.icon-manage-dialog .el-dialog__header) {
  display: none;
}
:global(.icon-manage-dialog .el-dialog__body),
:global(.icon-manage-dialog .el-dialog__footer) {
  padding: 0 !important;
}
:global(.icon-manage-dialog .el-dialog__body) {
  color: var(--manage-text-2, #595959);
}
.icon-dialog__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 48px;
  padding: 0 24px;
  border-bottom: 1px solid var(--manage-color-line, #e5e5e5);
}
.icon-dialog__title,
.icon-dialog__label,
.icon-dialog__control,
.icon-dialog__radio-group,
.icon-file-upload__content,
.icon-dialog__footer {
  font-family: 'Source Han Sans SC', 'Microsoft YaHei', sans-serif;
  font-synthesis: none;
  letter-spacing: 0;
}
.icon-dialog__title {
  font-size: 16px;
  font-weight: 400;
  line-height: 24px;
  color: var(--manage-text, rgb(0 0 0 / 85%));
}
.icon-dialog__close {
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
.icon-dialog__close:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
.icon-dialog__body {
  padding: 24px 24px 0;
}
.icon-dialog__form {
  display: flex;
  flex-direction: column;
  gap: 24px;
}
.icon-dialog__basic-group {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.icon-dialog__field,
.icon-dialog__field-content {
  width: 100%;
}
.icon-dialog__field {
  margin-bottom: 0;
}
.icon-dialog__field :deep(.el-form-item__content) {
  display: block;
  line-height: normal;
}
.icon-dialog__field :deep(.el-form-item__error) {
  z-index: 2;
  padding-top: 2px;
  line-height: 16px;
}
.icon-dialog__label {
  display: block;
  height: 22px;
  margin-bottom: 8px;
  font-size: 14px;
  font-weight: 400;
  line-height: 22px;
  color: var(--manage-text-2, #595959);
}
.icon-dialog__label i {
  font-style: normal;
  color: #ed7b2f;
}
.icon-dialog__control {
  width: 100%;
}
.icon-dialog__control :deep(.el-input__wrapper),
.icon-dialog__control :deep(.el-select__wrapper) {
  height: 32px;
  min-height: 32px;
  padding: 0 16px;
  border-radius: 8px;
  box-shadow: inset 0 0 0 1px var(--manage-color-line-component, #d9d9d9) !important;
}
.icon-dialog__control :deep(.el-input__inner),
.icon-dialog__control :deep(.el-select__selected-item),
.icon-dialog__textarea :deep(.el-textarea__inner) {
  font-family: 'Source Han Sans SC', 'Microsoft YaHei', sans-serif;
  font-size: 14px;
  line-height: 22px;
}
.icon-dialog__textarea :deep(.el-textarea__inner) {
  height: 90px !important;
  min-height: 90px !important;
  padding: 5px 16px;
  resize: none;
  border-radius: 8px;
  box-shadow: inset 0 0 0 1px var(--manage-color-line-component, #d9d9d9) !important;
}
.icon-dialog__radio-group {
  display: flex;
  gap: 24px;
  align-items: center;
  height: 22px;
}
.icon-dialog__radio-group :deep(.el-radio) {
  height: 22px;
  margin-right: 0;
}
.icon-dialog__radio-group :deep(.el-radio__label) {
  padding-left: 8px;
  font-size: 14px;
  line-height: 22px;
  color: var(--manage-text, #333333);
}
.icon-dialog__radio-group :deep(.el-radio__inner) {
  width: 16px;
  height: 16px;
  border-color: #b8b9bb;
}
.icon-dialog__radio-group :deep(.el-radio__input.is-checked .el-radio__inner) {
  background: transparent;
  border-color: var(--manage-accent, #51a195);
}
.icon-dialog__radio-group :deep(.el-radio__input.is-checked .el-radio__inner::after) {
  width: 8px;
  height: 8px;
  background: var(--manage-accent, #51a195);
}
.icon-file-upload,
.icon-file-upload :deep(.el-upload),
.icon-file-upload :deep(.el-upload-dragger) {
  width: 100%;
  height: 172px;
}
.icon-file-upload :deep(.el-upload-dragger) {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  overflow: hidden;

  /*
   * 上传区直接读取管理端主题令牌：主题切换时根节点变量会同步更新，
   * 因而弹窗内通过 Teleport 挂载的上传框也能立即切换为对应的亮暗底色。
   */
  background: var(--manage-color-upload-surface, #f6f8f9);
  border: 1px solid var(--manage-color-upload-border, #d9d9d9);
  border-radius: 8px;
}
.icon-file-upload :deep(.el-upload-dragger:hover) {
  border-color: var(--manage-accent, #51a195);
}
.icon-file-upload__content {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 395px;
  height: 124px;
  overflow: hidden;
  text-align: center;
}
.icon-file-upload__icon {
  flex: 0 0 40px;
  width: 40px;
  height: 40px;
  margin-bottom: 12px;
  color: var(--manage-accent, #51a195);
}
.icon-file-upload__title {
  display: block;
  width: 395px;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 16px;
  line-height: 24px;
  color: var(--manage-text, #333333);
  white-space: nowrap;
}
.icon-file-upload__tip {
  display: block;
  width: 395px;
  font-size: 12px;
  line-height: 22px;
  color: var(--manage-text-3, #cccccc);
}
.icon-file-upload__title + .icon-file-upload__tip {
  margin-top: 4px;
}
.icon-dialog__footer {
  display: flex;
  gap: 16px;
  justify-content: flex-end;
  min-height: 73px;
  padding-top: 16px;
  margin: 24px 24px 0;
  border-top: 1px solid var(--manage-color-line, #e5e5e5);
}
.icon-dialog__footer .el-button {
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
.icon-dialog__cancel {
  color: var(--manage-accent, #51a195) !important;
  background: transparent !important;
  border-color: var(--manage-accent, #51a195) !important;
}
.icon-dialog__save {
  color: #ffffff !important;
  background: var(--manage-accent, #51a195) !important;
  border-color: var(--manage-accent, #51a195) !important;
}

/* 小视口只让表单主体滚动，标题栏和操作按钮保持可见；桌面主画布仍使用原始固定尺寸。 */
@media (height <= 786px) {
  :global(.icon-manage-dialog.el-dialog) {
    max-height: calc(100vh - 32px);
  }
  .icon-dialog__body {
    max-height: calc(100vh - 177px);
    overflow-y: auto;
  }
}

@media (width <= 680px) {
  .icon-dialog__top,
  .icon-dialog__body {
    padding-right: 16px;
    padding-left: 16px;
  }
  .icon-dialog__footer {
    margin-right: 16px;
    margin-left: 16px;
  }
  .icon-file-upload__content,
  .icon-file-upload__title,
  .icon-file-upload__tip {
    width: 100%;
    max-width: 395px;
  }
}
</style>
