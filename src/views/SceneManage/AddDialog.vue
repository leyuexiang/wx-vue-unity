<template>
  <el-dialog
    class="manage-dialog scene-manage-dialog"
    modal-class="scene-manage-dialog-overlay"
    :model-value="visible"
    width="640px"
    align-center
    :show-close="false"
    :close-on-click-modal="false"
    @update:model-value="$emit('update:visible', $event)"
    @closed="handelRest(ruleFormRef)"
  >
    <!-- 弹窗采用 Figma 的标题栏、表单主体、底部操作区三段式结构，避免默认标题间距造成偏移。 -->
    <div class="scene-dialog__top">
      <span class="scene-dialog__title">{{ editRecord ? '编辑场景' : '新增场景' }}</span>
      <button
        type="button"
        class="scene-dialog__close"
        aria-label="关闭场景弹窗"
        @click="handelCancel(ruleFormRef)"
      >
        <el-icon><Close /></el-icon>
      </button>
    </div>

    <div class="scene-dialog__body">
      <el-form
        ref="ruleFormRef"
        class="scene-dialog__form"
        :model="ruleForm"
        :rules="rules"
        label-width="0"
        label-position="top"
        :validate-on-rule-change="false"
      >
        <el-form-item prop="name" class="scene-dialog__field">
          <label class="scene-dialog__label"><i>*</i>场景名称：</label>
          <el-input
            v-model="ruleForm.name"
            class="scene-dialog__control"
            maxlength="50"
            clearable
            placeholder="茶道体验"
          />
        </el-form-item>

        <el-form-item prop="description" class="scene-dialog__field">
          <label class="scene-dialog__label">场景描述：</label>
          <el-input
            v-model="ruleForm.description"
            class="scene-dialog__control scene-dialog__textarea"
            type="textarea"
            maxlength="200"
            placeholder="传统茶道文化虚拟体验"
          />
        </el-form-item>

        <el-form-item prop="category" class="scene-dialog__field">
          <label class="scene-dialog__label">场景分类：</label>
          <el-select
            v-model="ruleForm.category"
            class="scene-dialog__control"
            popper-class="manage-dropdown-popper manage-select-popper"
            :options="sceneCategoryOptions"
          />
        </el-form-item>

        <el-form-item prop="sceneType" class="scene-dialog__field">
          <label class="scene-dialog__label">场景类型：</label>
          <el-radio-group
            v-model="ruleForm.sceneType"
            class="scene-dialog__radio-group"
            :disabled="Boolean(editRecord)"
          >
            <el-radio value="GisScene">GIS场景</el-radio>
            <el-radio value="CommScene">非GIS场景</el-radio>
          </el-radio-group>
        </el-form-item>

        <el-form-item prop="coverList" class="scene-dialog__field scene-dialog__upload-field">
          <label class="scene-dialog__label">封面图片：</label>
          <el-upload
            ref="coverUploadRef"
            class="scene-cover-upload"
            accept=".jpg,.jpeg,.png,.webp"
            :show-file-list="false"
            :auto-upload="true"
            :http-request="handleCoverUpload"
            :before-upload="beforeAvatarUpload"
            :disabled="coverUploading"
          >
            <div v-if="currentCover" class="scene-cover-upload__preview">
              <img
                :src="currentCover.url"
                alt="场景封面"
                class="scene-cover-upload__image"
                @click.stop="handlePictureCardPreview(currentCover)"
              />
              <div class="scene-cover-upload__mask">
                <button
                  type="button"
                  class="scene-cover-upload__replace"
                  :disabled="coverUploading"
                  @click.stop.prevent="openCoverPicker"
                >
                  {{ coverUploading ? '更换中...' : '更换封面' }}
                </button>
              </div>
            </div>
            <div v-else class="scene-cover-upload__empty">
              <el-icon class="scene-cover-upload__plus"><Plus /></el-icon>
              <span>{{ coverUploading ? '上传中...' : '上传图片' }}</span>
            </div>
          </el-upload>
          <span class="scene-dialog__upload-tip"
            >注:点击上传封面图片，支持JPG/PNG/WEBP,不超过5MB</span
          >
        </el-form-item>
      </el-form>
    </div>

    <template #footer>
      <div class="scene-dialog__footer">
        <el-button class="scene-dialog__cancel" @click="handelCancel(ruleFormRef)">取消</el-button>
        <el-button class="scene-dialog__save" type="primary" @click="handleConfirm(ruleFormRef)"
          >保存</el-button
        >
      </div>
    </template>
  </el-dialog>

  <el-dialog v-model="dialogVisible" class="manage-dialog">
    <img w-full :src="dialogImageUrl" alt="Preview Image" />
  </el-dialog>
</template>

<script setup lang="ts">
import { Close, Plus } from '@element-plus/icons-vue'
import {
  ElMessage,
  type UploadFile,
  type FormInstance,
  type FormRules,
  type UploadInstance,
  type UploadProps,
  type UploadRequestOptions,
  type UploadUserFile,
} from 'element-plus'
import { toData } from '@/utils/asyncHandler'
import type { TransferListItem } from './index.vue'
import {
  addDim3dScene,
  editDim3dScene,
  type Dim3dSceneForm,
} from '@/servers/manual/dim3d/api/scene'
import { getDim3dOssFileById, uploadDim3dOssFile } from '@/servers/manual/dim3d/api/oss'
import {
  DEFAULT_PROJECT_SCENE_TYPE,
  resolveProjectSceneType,
  type ProjectSceneType,
} from './sceneType'

interface RuleForm {
  name: string
  /** 场景描述提交到新场景基础信息接口。 */
  description: string
  /** 场景分类保存字典 dictValue，展示名称由父页面字典选项提供。 */
  category: string
  sceneType: ProjectSceneType
  coverList: UploadUserFile[]
}

interface SceneCategoryOption {
  label: string
  value: string
}

type CoverFile = UploadFile & { url: string; response?: { data?: string } }

const props = defineProps({
  visible: { type: Boolean, default: false },
  editRecord: { type: Object as PropType<TransferListItem> },
  /** 场景分类由正式字典接口提供，弹窗只消费父页面传入的展示和值映射。 */
  sceneCategoryOptions: { type: Array as PropType<SceneCategoryOption[]>, default: () => [] },
})
const emit = defineEmits(['update:visible', 'updateList'])

type UploadError = Parameters<NonNullable<UploadRequestOptions['onError']>>[0]

const ruleFormRef = ref<FormInstance>()
const coverUploadRef = ref<UploadInstance>()
const ruleForm = reactive<RuleForm>({
  name: '',
  description: '',
  category: '',
  sceneType: DEFAULT_PROJECT_SCENE_TYPE,
  coverList: [],
})
const rules = reactive<FormRules<RuleForm>>({
  name: [
    { required: true, message: '请输入名称', trigger: 'blur' },
    { min: 1, max: 50, message: '名称长度在 1 到 50 个字符之间', trigger: 'blur' },
  ],
  // 后端允许未分类；尚未配置分类字典时不能让空下拉框阻止新增场景。
  category: [{ validator: (_rule, value, callback) => {
    callback(props.sceneCategoryOptions.length > 0 && !value ? new Error('请选择场景分类') : undefined)
  }, trigger: 'change' }],
  sceneType: [{ required: true, message: '请选择场景类型', trigger: 'change' }],
})

const dialogImageUrl = ref('')
const dialogVisible = ref(false)
const coverUploading = ref(false)

/**
 * 预览区只有在当前封面同时具备可访问 url 时才会渲染。
 * 这里通过类型守卫把模板里的封面对象收窄到可预览结构，去掉 `as any` 强转。
 */
const currentCover = computed<CoverFile | undefined>(() => {
  const cover = ruleForm.coverList[0]
  if (!cover?.url) return undefined
  return cover as CoverFile
})

let editInitRequestId = 0

watch(
  () => props.editRecord,
  async (record) => {
    const requestId = ++editInitRequestId
    if (!record) {
      Object.assign(ruleForm, {
        name: '',
        description: '',
        category: props.sceneCategoryOptions[0]?.value || '',
        sceneType: DEFAULT_PROJECT_SCENE_TYPE,
        coverList: [],
      })
      return
    }

    const { name, description, photoAddress, imgPath, sceneType } = record
    const coverAssetId = String(photoAddress ?? '').trim()
    // 列表中的 imgPath 可能已经是解析后的地址；缺失时按 OSS 编号查询，禁止把编号拼成路径。
    // 列表适配层只会把可展示地址写入 imgPath，因此相对地址也可以直接用于回显。
    let coverUrl = String(imgPath ?? '').trim()
    if (!coverUrl && coverAssetId) {
      try {
        const response = await getDim3dOssFileById(coverAssetId, {
          suppressNotFoundNotification: true,
        })
        coverUrl =
          response.data
            ?.find((file) => String(file.ossId ?? '').trim() === coverAssetId)
            ?.url?.trim() || ''
      } catch {
        coverUrl = ''
      }
    }
    if (requestId !== editInitRequestId) return
    const coverList =
      coverAssetId && coverUrl
        ? [{ name: 'coverImg', url: coverUrl, response: { data: coverAssetId } }]
        : []
    const recordCategory = String(record.sceneCategory ?? record.project ?? '').trim()
    Object.assign(ruleForm, {
      name,
      description: description || '',
      // 编辑时优先回显后端分类编码，避免保存未修改的场景时覆盖原分类。
      category: recordCategory || props.sceneCategoryOptions[0]?.value || '',
      sceneType: resolveProjectSceneType(sceneType),
      coverList,
    })
  },
  { immediate: true },
)

/** 字典异步返回后，新增表单才补齐首个分类；编辑表单已有分类时不覆盖用户或后端值。 */
watch(
  () => props.sceneCategoryOptions,
  (options) => {
    if (!props.editRecord && !ruleForm.category) ruleForm.category = options[0]?.value || ''
  },
  { deep: true },
)

const beforeAvatarUpload: UploadProps['beforeUpload'] = (rawFile) => {
  const isImg = /image\/*/.test(rawFile.type)
  if (!isImg) {
    ElMessage.error('当前仅能上传图片资源')
    return false
  }

  const isLtMaxSize = rawFile.size / 1024 / 1024 < 5
  if (!isLtMaxSize) {
    ElMessage.error('图片大小需小于 5MB')
    return false
  }

  return true
}

const handlePictureCardPreview: UploadProps['onPreview'] = (uploadFile) => {
  dialogImageUrl.value = uploadFile.url || ''
  dialogVisible.value = true
}

const openCoverPicker = () => {
  if (coverUploading.value) return

  const uploadRoot = coverUploadRef.value?.$el as HTMLElement | undefined
  const fileInput = uploadRoot?.querySelector('input[type="file"]') as HTMLInputElement | null
  fileInput?.click()
}

const handleCoverUpload = async (options: UploadRequestOptions) => {
  const oldObjectName = currentCover.value?.response?.data
  coverUploading.value = true

  try {
    const uploadResponse = await uploadDim3dOssFile(options.file as File)
    if (uploadResponse.code !== 200 || !uploadResponse.data?.ossId) {
      throw new Error(uploadResponse.msg || '新封面上传失败')
    }

    const uploadedOssId = String(uploadResponse.data.ossId)
    let uploadedUrl = uploadResponse.data.url?.trim() || ''
    // 部分网关上传响应只返回编号；补查 OSS 获取地址，确保新上传封面立即可见。
    if (!uploadedUrl) {
      const previewResponse = await getDim3dOssFileById(uploadedOssId, {
        suppressNotFoundNotification: true,
      })
      uploadedUrl =
        previewResponse.data
          ?.find((file) => String(file.ossId ?? '').trim() === uploadedOssId)
          ?.url?.trim() || ''
    }
    ruleForm.coverList = [
      {
        name: options.file.name,
        url: uploadedUrl,
        response: { data: uploadedOssId },
      },
    ]

    await nextTick()
    coverUploadRef.value?.clearFiles()
    ElMessage.success(oldObjectName ? '封面更换成功' : '封面上传成功')
    options.onSuccess?.(uploadResponse)
  } catch (error) {
    const err = error as Error
    ElMessage.error(err.message || '封面处理失败，请重试')
    const uploadError = Object.assign(new Error(err.message), {
      name: 'UploadAjaxError',
      status: 0,
      method: options.method,
      url: options.action,
    }) as UploadError
    options.onError?.(uploadError)
  } finally {
    coverUploading.value = false
  }
}

const handleConfirm = async (formEl?: FormInstance) => {
  if (!formEl) return
  await formEl.validate(async (valid) => {
    if (!valid) {
      ElMessage.error('请填写完整信息')
      return
    }

    const { name, sceneType, coverList } = ruleForm
    const isEdit = Boolean(props.editRecord?.id)
    const photoAddress = (coverList[0]?.response as { data?: string } | undefined)?.data

    const infos: Dim3dSceneForm = {
      name,
      sceneDesc: ruleForm.description.trim() || undefined,
      sceneCategory: ruleForm.category || undefined,
      sceneType: sceneType === 'GisScene' ? 'gis' : 'local3d',
      coverAssetId: photoAddress,
    }

    const [err] = await toData(
      isEdit ? editDim3dScene(String(props.editRecord?.id), infos) : addDim3dScene(infos),
    )

    if (err) return

    ElMessage.success('保存成功')
    emit('updateList')
    handelCancel(formEl)
  })
}

const handelCancel = (formEl?: FormInstance) => {
  handelRest(formEl)
  emit('update:visible', false)
}

const handelRest = (formEl?: FormInstance) => {
  coverUploading.value = false
  coverUploadRef.value?.clearFiles()
  formEl?.resetFields()
}
</script>

<style scoped lang="scss">
/* 场景弹窗复用管理页主题变量，保证通过 Teleport 渲染的暗色弹窗同步切换。 */
:global(.scene-manage-dialog-overlay.el-overlay) {
  background: rgb(0 0 0 / 40%);
  backdrop-filter: none;
}
:global(.scene-manage-dialog.el-dialog) {
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
:global(.scene-manage-dialog .el-dialog__header) {
  display: none;
}
:global(.scene-manage-dialog .el-dialog__body),
:global(.scene-manage-dialog .el-dialog__footer) {
  padding: 0 !important;
}
.scene-dialog__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 48px;
  padding: 0 24px;
  border-bottom: 1px solid var(--manage-color-line, #e5e5e5);
}
.scene-dialog__title,
.scene-dialog__label,
.scene-dialog__control,
.scene-dialog__radio-group,
.scene-dialog__footer,
.scene-dialog__upload-tip {
  font-family: 'Source Han Sans SC', 'Microsoft YaHei', sans-serif;
  font-synthesis: none;
  letter-spacing: 0;
}
.scene-dialog__title {
  font-size: 16px;
  line-height: 24px;
  color: var(--manage-text, rgb(0 0 0 / 85%));
}
.scene-dialog__close {
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
.scene-dialog__body {
  padding: 24px 24px 0;
}
.scene-dialog__form {
  display: flex;
  flex-direction: column;
  gap: 24px;
}
.scene-dialog__field {
  width: 100%;
  margin: 0;
}
.scene-dialog__field :deep(.el-form-item__content) {
  display: block;
  line-height: normal;
}
.scene-dialog__field :deep(.el-form-item__error) {
  padding-top: 2px;
  line-height: 16px;
}
.scene-dialog__label {
  display: block;
  height: 22px;
  margin-bottom: 8px;
  font-size: 14px;
  font-weight: 400;
  line-height: 22px;
  color: var(--manage-text-2, #595959);
}
.scene-dialog__label i {
  font-style: normal;
  color: #ed7b2f;
}
.scene-dialog__control {
  width: 100%;
}
.scene-dialog__control :deep(.el-input__wrapper),
.scene-dialog__control :deep(.el-select__wrapper) {
  height: 32px;
  min-height: 32px;
  padding: 0 16px;
  border-radius: 8px;
  box-shadow: inset 0 0 0 1px var(--manage-color-line-component, #d9d9d9) !important;
}
.scene-dialog__control :deep(.el-input__inner),
.scene-dialog__control :deep(.el-select__selected-item),
.scene-dialog__textarea :deep(.el-textarea__inner) {
  font-family: inherit;
  font-size: 14px;
  line-height: 22px;
  color: var(--manage-text, #333333);
}
.scene-dialog__textarea :deep(.el-textarea__inner) {
  height: 90px !important;
  min-height: 90px !important;
  padding: 5px 16px;
  resize: none;
  border-radius: 8px;
  box-shadow: inset 0 0 0 1px var(--manage-color-line-component, #d9d9d9) !important;
}
.scene-dialog__radio-group {
  display: flex;
  gap: 24px;
  align-items: center;
  height: 22px;
}
.scene-dialog__radio-group :deep(.el-radio) {
  height: 22px;
  margin-right: 0;
}
.scene-dialog__radio-group :deep(.el-radio__label) {
  padding-left: 8px;
  font-size: 14px;
  line-height: 22px;
  color: var(--manage-text, #333333);
}
.scene-dialog__radio-group :deep(.el-radio__inner) {
  width: 16px;
  height: 16px;
  border-color: #b8b9bb;
}
.scene-dialog__radio-group :deep(.el-radio__input.is-checked .el-radio__inner) {
  background: transparent;
  border-color: var(--manage-accent, #51a195);
}
.scene-dialog__radio-group :deep(.el-radio__input.is-checked .el-radio__inner::after) {
  width: 8px;
  height: 8px;
  background: var(--manage-accent, #51a195);
}
.scene-cover-upload {
  width: 72px;
  height: 72px;
}
.scene-cover-upload :deep(.el-upload) {
  width: 72px;
  height: 72px;
  background: transparent;
  border: 0;
}
.scene-cover-upload__preview,
.scene-cover-upload__empty {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 72px;
  height: 72px;
  overflow: hidden;
  border-radius: 4px;
}
.scene-cover-upload__preview {
  background: var(--manage-color-upload-surface, #f6f8f9);
  border: 1px solid var(--manage-color-upload-border, #d9d9d9);
}
.scene-cover-upload__image {
  display: block;
  width: 100%;
  height: 100%;
  cursor: pointer;
  object-fit: cover;
}
.scene-cover-upload__empty {
  flex-direction: column;
  gap: 4px;
  color: var(--manage-accent, #51a195);
  background: var(--manage-color-upload-surface, #f6f8f9);
  border: 1px dashed var(--manage-color-upload-border, #d9d9d9);
}
.scene-cover-upload__plus {
  font-size: 24px;
}
.scene-cover-upload__mask {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgb(0 0 0 / 45%);
  opacity: 0;
  transition: opacity 0.2s ease;
}
.scene-cover-upload :deep(.el-upload:hover) .scene-cover-upload__mask {
  opacity: 1;
}
.scene-cover-upload__replace {
  padding: 2px 5px;
  font-size: 11px;
  color: #ffffff;
  cursor: pointer;
  background: var(--manage-accent, #51a195);
  border: 0;
  border-radius: 3px;
}
.scene-dialog__upload-field {
  min-height: 132px;
}
.scene-dialog__upload-tip {
  display: block;
  margin-top: 8px;
  font-size: 12px;
  line-height: 22px;
  color: var(--manage-text-3, #cccccc);
  white-space: nowrap;
}
.scene-dialog__footer {
  display: flex;
  gap: 16px;
  justify-content: flex-end;
  min-height: 73px;
  padding-top: 16px;
  margin: 24px 24px 0;
  border-top: 1px solid var(--manage-color-line, #e5e5e5);
}
.scene-dialog__footer .el-button {
  width: 65px;
  height: 32px;
  padding: 0;
  margin: 0;
  font-family: inherit;
  font-size: 14px;
  line-height: 22px;
  border-radius: 4px;
  box-shadow: none;
}
.scene-dialog__cancel {
  color: var(--manage-accent, #51a195) !important;
  background: transparent !important;
  border-color: var(--manage-accent, #51a195) !important;
}
.scene-dialog__save {
  color: #ffffff !important;
  background: var(--manage-accent, #51a195) !important;
  border-color: var(--manage-accent, #51a195) !important;
}

@media (height <= 786px) {
  :global(.scene-manage-dialog.el-dialog) {
    max-height: calc(100vh - 32px);
  }
  .scene-dialog__body {
    max-height: calc(100vh - 177px);
    overflow-y: auto;
  }
}

@media (width <= 680px) {
  .scene-dialog__top,
  .scene-dialog__body {
    padding-right: 16px;
    padding-left: 16px;
  }
  .scene-dialog__footer {
    margin-right: 16px;
    margin-left: 16px;
  }
}
</style>
