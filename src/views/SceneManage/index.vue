<template>
  <FixedPublicationDialog v-if="DIM3D_ADMIN_API" v-model="fixedPublishVisible" :scene-id="fixedPublishSceneId" @published="getList" />
  <div class="manage-page manage-theme manage-list-page manage-scene-page">
    <ManagePageTopBar title="场景列表" breadcrumb="场景管理/场景列表">
      <template #actions>
        <!-- 新增仍只进入场景页原有处理器，迁移位置不会改变弹窗状态或接口行为。 -->
        <el-button
          class="manage-toolbar-button manage-toolbar-button--primary"
          icon="Plus"
          @click="handleOperate(OperateEnum.Add)"
        >
          新增场景
        </el-button>
      </template>

      <ManageFilterBar
        class="manage-scene-page__filter-panel"
        label="场景筛选"
        actions-class="manage-scene-page__filter-actions"
      >
        <div class="manage-filter-bar__field">
          <label for="manage-scene-name">场景名称：</label>
          <el-input
            id="manage-scene-name"
            v-model="draftFilters.name"
            placeholder="输入场景名称"
            clearable
            suffix-icon="Search"
          />
        </div>

        <div class="manage-filter-bar__field">
          <label for="manage-scene-type">场景类型：</label>
          <el-select
            id="manage-scene-type"
            v-model="draftFilters.sceneType"
            popper-class="manage-dropdown-popper manage-select-popper"
            :options="SCENE_TYPE_FILTER_OPTIONS"
          />
        </div>

        <div class="manage-filter-bar__field">
          <label for="manage-scene-status">状态：</label>
          <el-select
            id="manage-scene-status"
            v-model="draftFilters.status"
            popper-class="manage-dropdown-popper manage-select-popper"
            :options="statusOptions"
          />
        </div>

        <div class="manage-filter-bar__field">
          <label for="manage-scene-tenant">所属租户：</label>
          <el-select
            id="manage-scene-tenant"
            v-model="draftFilters.tenant"
            popper-class="manage-dropdown-popper manage-select-popper manage-tenant-select-popper"
            :options="filterTenantOptions"
            :loading="filterTenantSelect.loading"
            :no-data-text="filterTenantSelect.error || '暂无租户'"
            :no-match-text="filterTenantSelect.error || '未找到匹配租户'"
            :debounce="300"
            filterable
            remote
            clearable
            :reserve-keyword="false"
            :remote-method="searchFilterTenants"
            @visible-change="handleFilterTenantVisibleChange"
            @end-reached="handleFilterTenantEndReached"
          />
        </div>
        <template #actions>
          <el-button class="manage-scene-page__query-button" type="primary" @click="applyFilters"
            >查询</el-button
          >
          <el-button class="manage-scene-page__reset-button" @click="resetFilters">重置</el-button>
        </template>
      </ManageFilterBar>
    </ManagePageTopBar>

    <!-- 场景页同样使用 Figma 中间区域的白底容器，避免只有模型页出现独立内容底板。 -->
    <section class="manage-resource-content-panel">
      <nav class="manage-model-page__categories" aria-label="场景分类">
        <button
          v-for="category in categoryNavigation"
          :key="category.value"
          class="manage-model-page__category"
          :class="{ 'is-active': selectedProjectCategory === category.value }"
          type="button"
          :aria-pressed="selectedProjectCategory === category.value"
          @click="selectProjectCategory(category.value)"
        >
          {{ category.label }}
        </button>
      </nav>

      <ResourceLayout
        :list="list"
        :total="total"
        :current-page="pagination.page"
        :page-size="pagination.size"
        @paginationChange="handlePaginationChange"
        @mediaClick="handleMediaPreview"
      >
        <template #media-extra="{ record }">
          <!--
          只有接口明确返回 0/1 时才展示发布角标；缺失状态不能被猜测为“未发布”。
          文案由 formatList 根据真实 isPublish 字段生成，避免把场景类型或默认值当成状态。
        -->
          <span class="manage-scene-card__type">{{ record.sceneCardTypeLabel }}</span>
          <span
            v-if="record.publishStatusLabel"
            class="manage-model-card__status"
            :class="record.isPublish === 1 ? 'is-online' : 'is-offline'"
          >
            {{ record.publishStatusLabel }}
          </span>
        </template>

        <template #content="{ record }">
          <div class="manage-resource-card__body">
            <!-- 场景信息区沿用模型卡片的固定层级，避免描述和元数据把卡片高度撑开。 -->
            <div class="manage-model-card__information">
              <div class="manage-grid-card__title text-ellipsis" :title="record.name">
                {{ record.name }}
              </div>
              <div
                class="manage-model-card__description text-ellipsis"
                :title="record.description || '--'"
              >
                {{ record.description || '--' }}
              </div>
              <div
                class="manage-model-card__meta text-ellipsis"
                :title="`${record.sceneCardTypeLabel}·${formatTime(record.updateTime)}`"
              >
                <span class="manage-model-card__meta-category">{{
                  record.sceneCardTypeLabel
                }}</span>
                <span class="manage-model-card__meta-separator" aria-hidden="true">·</span>
                <time class="mono-text">{{ formatTime(record.updateTime) }}</time>
              </div>
            </div>

            <div class="manage-model-card__footer">
              <el-button
                class="manage-model-card__edit manage-scene-card__enter"
                title="进入场景"
                @click.stop.prevent="handleOperate(OperateEnum.Enter, record)"
              >
                进入
              </el-button>

              <div class="manage-model-card__actions">
                <el-button
                  circle
                  class="manage-model-card__more"
                  title="编辑信息"
                  aria-label="编辑信息"
                  @click.stop.prevent="handleOperate(OperateEnum.Edit, record)"
                >
                  <!-- 使用 Figma Write 矢量资源，避免组件库默认 EditPen 图形产生视觉偏差。 -->
                  <img
                    class="manage-scene-card__action-icon"
                    :src="manageCardActionIcons.write"
                    alt=""
                    aria-hidden="true"
                  />
                </el-button>
                <!-- 场景发布按钮按状态切换图标；封面仅在场景已发布时进入预览页。 -->
                <el-button
                  circle
                  class="manage-model-card__more"
                  :title="record.isPublish === 1 ? '取消发布场景' : '发布场景'"
                  :aria-label="record.isPublish === 1 ? '取消发布场景' : '发布场景'"
                  @click.stop.prevent="handleOperate(OperateEnum.TogglePublish, record)"
                >
                  <!-- 未发布使用无斜杠纸飞机，已发布使用带斜杠纸飞机，明确区分反向动作。 -->
                  <img
                    class="manage-scene-card__action-icon"
                    :src="
                      record.isPublish === 1
                        ? manageCardActionIcons.send
                        : manageCardActionIcons.publish
                    "
                    alt=""
                    aria-hidden="true"
                  />
                </el-button>
                <!-- 复制、删除等后续接口动作收进更多菜单，保持模型卡片的操作密度。 -->
                 <el-dropdown
                   trigger="click"
                   placement="bottom-end"
                   :popper-class="sceneCardMenuPopperClass"
                   :disabled="sceneCardCapabilities.menuActions.length === 0"
                 >
                  <span class="outline-none" @click.stop>
                    <el-button
                      circle
                      icon="MoreFilled"
                    class="manage-model-card__more"
                    title="更多操作"
                    aria-label="更多操作"
                    :disabled="sceneCardCapabilities.menuActions.length === 0"
                  />
                </span>
                <template #dropdown>
                  <el-dropdown-menu>
                     <el-dropdown-item v-if="DIM3D_ADMIN_API" @click.stop="openPublishDialog(record)">
                       发布管理
                     </el-dropdown-item>
                     <el-dropdown-item
                       v-if="canUseSceneCardAction(sceneCardCapabilities, 'copy')"
                       @click.stop="handleOperate(OperateEnum.Copy, record)"
                     >
                       复制
                     </el-dropdown-item>
                     <el-dropdown-item
                       v-if="canUseSceneCardAction(sceneCardCapabilities, 'authorize')"
                       @click.stop="handleOperate(OperateEnum.Authorize, record)"
                     >
                       授权
                     </el-dropdown-item>
                     <SceneJsonDownload
                       :scene-id="String(record.id)"
                       :scene-name="record.name"
                     />
                     <el-dropdown-item
                       v-if="canUseSceneCardAction(sceneCardCapabilities, 'delete')"
                       class="manage-card-menu-popper__danger"
                       @click.stop="handleOperate(OperateEnum.Delete, record)"
                      >
                        删除
                      </el-dropdown-item>
                    </el-dropdown-menu>
                  </template>
                </el-dropdown>
              </div>
            </div>
          </div>
        </template>
      </ResourceLayout>
    </section>

    <!-- AddDialog 内部包含两个 Teleport 弹窗，根节点是片段；不向片段传递无效 class，避免 Vue 属性继承警告。 -->
    <AddDialog
      v-model:visible="addDialogVisible"
      :editRecord="editRecord"
      :scene-category-options="sceneCategoryOptions"
      @updateList="getList"
    />

    <!-- 接入管理弹窗主题；传送到页面根节点后仍由根主题属性控制面板与控件颜色。 -->
    <el-dialog
      v-model="enterDialog.visible"
      class="manage-dialog"
      title="选择渲染方式"
      width="420px"
      append-to-body
      align-center
    >
      <p class="manage-scene-render-choice__scene">{{ enterDialog.record?.name }}</p>
      <div class="manage-scene-render-choice__options">
        <button
          v-for="option in renderModeOptions"
          :key="option.label"
          type="button"
          class="manage-scene-render-choice__option"
          :disabled="!option.configured || (option.mode === 'webgpu' && !browserWebGpuAvailable)"
          @click="openSceneEditor(option.mode)"
        >
          <strong>{{ option.label }}</strong>
          <span>{{ option.mode === 'webgpu' && !browserWebGpuAvailable ? '当前浏览器或页面环境不支持 WebGPU' : option.configured ? option.description : '尚未配置，暂不可进入' }}</span>
        </button>
      </div>
    </el-dialog>

    <!-- 发布流程复用管理端弹窗容器；最终提交调用新版场景发布接口。 -->
    <el-dialog
      v-model="publishDialog.visible"
      class="manage-scene-publish-dialog"
      :class="{
        'is-success': publishDialog.step === 'success',
        'is-error': publishDialog.step === 'error',
      }"
      modal-class="manage-scene-publish-overlay"
      width="640px"
      align-center
      :show-close="false"
      :close-on-click-modal="false"
      :close-on-press-escape="false"
    >
      <div class="manage-scene-publish-dialog__top">
        <span class="manage-scene-publish-dialog__title">{{ publishDialog.title }}</span>
        <button
          type="button"
          class="manage-scene-publish-dialog__close"
          @click="closePublishDialog"
        >
          ×
        </button>
      </div>
      <div class="manage-scene-publish-dialog__body">
        <template v-if="publishDialog.step === 'form'">
          <p class="manage-scene-publish-dialog__hint">发布后，场景可按以下方式访问</p>
          <label class="manage-scene-publish-dialog__label">场景名称：</label>
          <el-input :model-value="publishDialog.record?.name || ''" disabled />
          <label class="manage-scene-publish-dialog__label">访问模式：</label>
          <!-- 下拉层挂载到 body，显式复用管理端统一样式，保持选中态与其他下拉框一致。 -->
          <el-select
            v-model="publishDialog.mode"
            class="manage-scene-publish-dialog__control"
            popper-class="manage-dropdown-popper manage-select-popper"
            :options="publishModeOptions"
            :loading="accessModeLoading"
            :disabled="!publishModeOptions.length"
            @change="publishDialog.modeTouched = true"
          />
          <span v-if="publishDialog.incompatibleMode" class="manage-scene-publish-dialog__tip">
            当前场景已有访问模式“{{ publishDialog.incompatibleMode }}”，当前平台不支持，请重新选择合法模式。
          </span>
          <template v-if="requiresAccessPassword">
            <label class="manage-scene-publish-dialog__label">访问密码：</label>
            <el-input
              v-model="publishDialog.password"
              type="password"
              show-password
              placeholder="请输入访问密码"
            />
            <span class="manage-scene-publish-dialog__tip"
              >访问密码：支持数字、字母、特殊字符（!@#$%^&amp;*()-_）</span
            >
          </template>
        </template>
        <template v-else-if="publishDialog.step === 'confirm'">
          <p>确定要将场景「{{ publishDialog.record?.name }}」发布吗？</p>
        </template>
        <template v-else-if="publishDialog.step === 'success'">
          <p class="manage-scene-publish-dialog__success-text">
            {{
              publishDialog.alreadyPublished
                ? '该版本已发布，当前访问设置未发生变化。'
                : '场景已发布，你可以复制下方链接分享给用户访问。'
            }}
          </p>
          <label class="manage-scene-publish-dialog__label">场景访问链接</label>
          <div class="manage-scene-publish-dialog__url-row">
            <el-input :model-value="publishDialog.url" readonly />
            <el-button class="manage-scene-publish-dialog__copy" @click="copyPublishUrl"
              >复制</el-button
            >
          </div>
        </template>
        <template v-else>
          <p class="manage-scene-publish-dialog__error-main">
            发布过程中出现问题，你可以选择重试或放弃本次操作。
          </p>
          <p class="manage-scene-publish-dialog__error-detail">{{ publishDialog.error }}</p>
        </template>
      </div>
      <div v-if="publishDialog.step !== 'success'" class="manage-scene-publish-dialog__footer">
        <el-button class="manage-scene-publish-dialog__cancel" @click="closePublishDialog"
          >取消</el-button
        >
        <el-button
          v-if="publishDialog.step === 'form'"
          class="manage-scene-publish-dialog__save"
          type="primary"
          :disabled="!publishDialog.mode"
          @click="publishDialog.step = 'confirm'"
          >确认发布</el-button
        >
        <el-button
          v-else-if="publishDialog.step === 'confirm'"
          class="manage-scene-publish-dialog__save"
          type="warning"
          :disabled="!publishDialog.mode"
          @click="submitPublish"
          >确认发布</el-button
        >
        <el-button
          v-else-if="publishDialog.step === 'error'"
          class="manage-scene-publish-dialog__save"
          type="primary"
          @click="submitPublish"
          >重试</el-button
        >
      </div>
    </el-dialog>

    <!-- 场景授权弹窗复用管理端弹窗容器与主题变量，授权编号始终按字符串提交。 -->
    <el-dialog
      v-model="authorizationDialog.visible"
      class="manage-scene-authorize-dialog"
      modal-class="manage-scene-authorize-overlay"
      width="608px"
      align-center
      :show-close="false"
      :close-on-click-modal="false"
      :close-on-press-escape="false"
    >
      <div class="manage-scene-authorize-dialog__top">
        <span class="manage-scene-authorize-dialog__title">场景授权</span>
        <button
          type="button"
          class="manage-scene-authorize-dialog__close"
          aria-label="关闭"
          @click="closeAuthorizationDialog"
        >
          ×
        </button>
      </div>
      <div class="manage-scene-authorize-dialog__body">
        <div class="manage-scene-authorize-dialog__scene">
          <span class="manage-scene-authorize-dialog__label">授权场景</span>
          <span class="manage-scene-authorize-dialog__scene-name">{{
            authorizationDialog.record?.name || '--'
          }}</span>
        </div>
        <label class="manage-scene-authorize-dialog__label" for="manage-scene-grant-tenant">
          <span class="manage-scene-authorize-dialog__required">*</span>选择租户：
        </label>
        <!-- 租户选项来自正式分页接口；输入关键字执行服务端模糊搜索，滚动到底继续加载下一页。 -->
        <el-select
          id="manage-scene-grant-tenant"
          v-model="authorizationDialog.grantTenantId"
          class="manage-scene-authorize-dialog__control"
          popper-class="manage-dropdown-popper manage-select-popper manage-tenant-select-popper"
          :options="authorizationTenantSelect.options"
          :loading="authorizationTenantSelect.loading"
          :no-data-text="authorizationTenantSelect.error || '暂无租户'"
          :no-match-text="authorizationTenantSelect.error || '未找到匹配租户'"
          :debounce="300"
          filterable
          remote
          clearable
          :reserve-keyword="false"
          :remote-method="searchAuthorizationTenants"
          placeholder="请选择租户"
          :disabled="authorizationDialog.submitting"
          @visible-change="handleAuthorizationTenantVisibleChange"
          @end-reached="handleAuthorizationTenantEndReached"
          @keyup.enter="submitAuthorization"
        />
        <label class="manage-scene-authorize-dialog__label" for="manage-scene-grant-description">
          授权说明：
        </label>
        <el-input
          id="manage-scene-grant-description"
          v-model="authorizationDialog.description"
          type="textarea"
          :rows="3"
          maxlength="200"
          show-word-limit
          placeholder="请输入授权说明（可选）"
          :disabled="authorizationDialog.submitting"
        />
      </div>
      <div class="manage-scene-authorize-dialog__footer">
        <el-button
          class="manage-scene-authorize-dialog__cancel"
          :disabled="authorizationDialog.submitting"
          @click="closeAuthorizationDialog"
        >
          取消
        </el-button>
        <el-button
          class="manage-scene-authorize-dialog__save"
          type="primary"
          :loading="authorizationDialog.submitting"
          @click="submitAuthorization"
        >
          确认授权
        </el-button>
      </div>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import FixedPublicationDialog from '@/components/FixedPublicationDialog.vue'
import { DIM3D_ADMIN_API } from '@/servers/manual/dim3d/api/constants'
import { revokeFixedPublication } from '@/integrations/scene/fixedPublicationManagement'
const fixedPublishVisible = ref(false)
const fixedPublishSceneId = ref('')
import SceneJsonDownload from './components/SceneJsonDownload/index.vue'
import ResourceLayout from './layout/index.vue'
import { toData } from '@/utils/asyncHandler'
import { useRouter } from 'vue-router'
import { authContext } from '@/auth/authContext'
import {
  createTabAuthHandoff,
  createTabAuthWindowName,
  installTabAuthResponder,
} from '@/auth/tabAuthHandoff'
import { ElMessage } from 'element-plus'
import { isUnityRenderModeConfigured, type UnityRenderMode } from '@/unity-runtime/renderMode'
import AddDialog from './AddDialog.vue'
import manageCardPublishIcon from '@/assets/icons/manage-card-publish.svg'
import manageCardWriteIcon from '@/assets/icons/manage-card-write.svg'
import manageCardSendIcon from '@/assets/icons/manage-card-send.svg'
import manageCardPublishLightIcon from '@/assets/icons/manage-card-publish-light.svg'
import manageCardSendLightIcon from '@/assets/icons/manage-card-send-light.svg'
import manageCardWriteLightIcon from '@/assets/icons/manage-card-write-light.svg'
import { CATEGORY_ALL } from './const'
import {
  openManageDeleteConfirm,
  openManageSceneUnpublishConfirm,
} from '../manageShared/confirm'
import { useManageTheme } from '../manageShared/manageTheme'
import {
  pageDim3dScene,
  getDim3dSceneInfo,
  removeDim3dScene,
  copyDim3dScene,
  publishDim3dScene,
  cancelDim3dScene,
  grantDim3dSceneTenant,
  type Dim3dScenePageVo,
} from '@/servers/manual/dim3d/api/scene'
import { getDim3dCurrentVegetationPublication } from '@/servers/manual/dim3d/api/vegetation'
import {
  createDim3dDictionaryOptions,
  getDim3dAccessModeDictionary,
  getDim3dSceneCategoryDictionary,
} from '@/servers/manual/dim3d/api/dictionary'
import { getDim3dOssFileById } from '@/servers/manual/dim3d/api/oss'
import {
  createOperationTenantSelectOptions,
  pageOperationTenants,
  type OperationTenantSelectOption,
} from '@/servers/manual/dim3d/api/tenant'
import {
  getProjectSceneCardTypeLabel,
  getProjectSceneTypeLabel,
  SCENE_TYPE_ALL,
  SCENE_TYPE_FILTER_OPTIONS,
  type SceneTypeFilterValue,
} from './sceneType'
import ManageFilterBar from '../manageShared/ManageFilterBar.vue'
import ManagePageTopBar from '../manageShared/ManagePageTopBar.vue'
import {
  assertVegetationPublicationMatches,
  readSavedVegetationPublicationIdentity,
} from './vegetationPublicationValidation'
import {
  canUseSceneCardAction,
  getScenePublishAccessModeLabel,
  getCurrentManagementCapabilities,
  requiresScenePublishPassword,
  resolveScenePublishAccessModes,
  type ScenePublishAccessModeOption,
} from '@/auth/capabilities'

// 场景列表统一使用 dim3d 分页接口参数，场景编号和筛选值按新接口契约传递。
type SceneListQueryParams = import('@/servers/manual/dim3d/api/scene').Dim3dScenePageParams

const router = useRouter()
installTabAuthResponder()
const enterDialog = reactive<{ visible: boolean; record: TransferListItem | null }>({ visible: false, record: null })
const browserWebGpuAvailable = typeof navigator !== 'undefined' && 'gpu' in navigator && window.isSecureContext
const renderModeOptions = [
  { mode: 'cloud' as const, label: 'Unity 云渲染', description: '由服务器渲染并传输画面', configured: isUnityRenderModeConfigured('cloud') },
  { mode: 'webgpu' as const, label: 'Unity WebGPU', description: '在当前浏览器加载 Unity Web 构建', configured: isUnityRenderModeConfigured('webgpu') },
  { mode: null, label: '现有编辑模式', description: '继续使用当前场景配置编辑器', configured: true },
]

/**
 * 场景卡片只消费认证上下文转换后的能力快照，不直接读取 iframe 消息或平台字段。
 * 模板、事件处理器和授权入口共用同一份能力，避免只隐藏“授权”菜单而保留调用路径。
 */
const managementCapabilities = getCurrentManagementCapabilities()
const sceneCardCapabilities = managementCapabilities.scene

/**
 * 下载场景文件需要更宽的菜单，其他场景沿用卡片菜单的默认宽度。
 * 发布管理按接口模式独立显示，菜单高度由实际渲染的操作项撑开。
 */
const sceneCardMenuBaseClass = 'manage-dropdown-popper manage-card-menu-popper manage-scene-card-menu-popper'
const sceneCardMenuPopperClass =
  sceneCardCapabilities.canDownloadJson
    ? `${sceneCardMenuBaseClass} manage-scene-card-menu-popper--wide`
    : sceneCardMenuBaseClass

/**
 * 为新页签生成不含敏感信息的一次性交接地址。
 *
 * URL 只携带随机交接编号；令牌、客户端编号、角色和权限继续通过同源短时信封、window.name
 * 或跨页签消息传递。禁止把完整鉴权上下文编码到查询参数或片段，避免凭据进入地址栏、历史记录、
 * 截图和分享链接。
 */
const withTabAuthHandoff = (href: string): string => {
  const url = new URL(href, window.location.origin)
  const context = authContext.get()
  if (!context) return url.toString()
  const handoffId = createTabAuthHandoff(context)
  if (!handoffId) return url.toString()
  url.searchParams.set('authHandoff', handoffId)
  // 管理页运行在 XrCenter 内嵌框架中，必须明确使用当前内嵌应用源站，避免新页签
  // 按外层宿主地址解析相对路径，进而导致 localStorage/sessionStorage 不在同一来源。
  return url.toString()
}
const { theme: manageTheme } = useManageTheme()

/**
 * 外部 SVG 通过 img 标签加载时无法继承按钮的 currentColor；暗色卡片改用专用亮色资源。
 * 下线图标含有与卡片底色相同的擦除线，按主题整体反色会破坏该镂空，因此必须整组切换资源。
 */
const manageCardActionIcons = computed(() =>
  manageTheme.value === 'dark'
    ? {
        write: manageCardWriteLightIcon,
        publish: manageCardPublishLightIcon,
        send: manageCardSendLightIcon,
      }
    : {
        write: manageCardWriteIcon,
        publish: manageCardPublishIcon,
        send: manageCardSendIcon,
      },
)

type PublishDialogStep = 'form' | 'confirm' | 'success' | 'error'
type DictionaryOption = { value: string; label: string }
/** 发布访问模式由平台能力与正式字典求交集后生成，避免展示或提交平台不支持的枚举。 */
const publishModeOptions = ref<ScenePublishAccessModeOption[]>([])
const accessModeLoading = ref(false)
const publishDialog = reactive({
  visible: false,
  title: '确认发布',
  step: 'form' as PublishDialogStep,
  mode: '',
  password: '',
  url: '',
  error: '',
  modeLoading: false,
  modeTouched: false,
  incompatibleMode: '',
  alreadyPublished: false,
  record: undefined as TransferListItem | undefined,
})

/** 授权弹窗状态集中管理，避免切换卡片时残留上一次授权的租户编号。 */
const authorizationDialog = reactive({
  visible: false,
  record: undefined as TransferListItem | undefined,
  grantTenantId: '',
  description: '',
  submitting: false,
})

const openPublishDialog = async (record: TransferListItem) => {
  if (DIM3D_ADMIN_API) {
    fixedPublishSceneId.value = String(record.id ?? '')
    fixedPublishVisible.value = true
    return
  }
  publishDialog.visible = true
  publishDialog.title = '确认发布'
  publishDialog.step = 'form'
  // 字典完成后立即提供当前平台允许的首个选项；读取历史值只负责回填，不得阻塞下拉操作。
  publishDialog.mode = publishModeOptions.value[0]?.value || ''
  publishDialog.password = ''
  publishDialog.url = ''
  publishDialog.error = ''
  publishDialog.modeLoading = true
  publishDialog.modeTouched = false
  publishDialog.incompatibleMode = ''
  publishDialog.alreadyPublished = false
  publishDialog.record = record

  const sceneId = String(record.id ?? '').trim()
  if (!/^[1-9]\d*$/.test(sceneId)) {
    publishDialog.modeLoading = false
    publishDialog.error = '当前场景缺少有效编号'
    return
  }

  const [error, response] = await toData(getDim3dSceneInfo(sceneId))
  if (publishDialog.record !== record) return
  publishDialog.modeLoading = false
  if (error) {
    publishDialog.error = '当前场景访问模式读取失败，请稍后重试'
    return
  }

  // 用户已经主动选择新模式时，历史详情返回不能覆盖用户选择。
  if (publishDialog.modeTouched) return

  // toData 已经拆出响应体的 data 字段，此处直接读取场景详情中的访问模式。
  const currentMode = response?.accessMode?.trim().toUpperCase() || ''
  if (!currentMode) {
    publishDialog.mode = publishModeOptions.value[0]?.value || ''
    return
  }

  if (publishModeOptions.value.some((option) => option.value === currentMode)) {
    publishDialog.mode = currentMode as ScenePublishAccessModeOption['value']
    return
  }

  // 历史模式不属于当前平台时只展示提示，不自动改写为首个合法模式。
  publishDialog.incompatibleMode = getScenePublishAccessModeLabel(currentMode)
}

/** 访问模式编码由字典维护；仅依据编码语义识别需要密码的模式，不维护完整本地枚举。 */
const requiresAccessPassword = computed(() => requiresScenePublishPassword(publishDialog.mode))

/**
 * 整场发布前读取当前保存四包和服务端植被当前版本，校验三项稳定身份。
 *
 * 普通场景、空植被草稿或没有启用规则时不增加植被请求；存在启用种植规则时必须先有正式发布引用。
 * 校验在场景发布写请求前完成，整场发布本身不冻结植被版本。
 */
const validateVegetationBeforeScenePublish = async (sceneId: string) => {
  const sceneResponse = await getDim3dSceneInfo(sceneId)
  const savedPublication = readSavedVegetationPublicationIdentity(sceneResponse)
  if (!savedPublication) return

  let currentPublication
  try {
    currentPublication = await getDim3dCurrentVegetationPublication(sceneId)
  } catch (error) {
    const status =
      error instanceof Error
        ? ((error as Error & { status?: number; code?: number }).status ??
          (error as Error & { code?: number }).code)
        : undefined
    if (status === 404) {
      throw new Error('服务端没有当前植被正式版本，请先生成并发布植被后再发布场景。')
    }
    throw new Error(
      error instanceof Error && error.message
        ? `服务端当前植被版本核对失败：${error.message}`
        : '服务端当前植被版本核对失败，请稍后重试。',
    )
  }

  assertVegetationPublicationMatches(sceneId, savedPublication, currentPublication)
}

const closePublishDialog = () => {
  publishDialog.visible = false
  publishDialog.record = undefined
}

const submitPublish = async () => {
  const record = publishDialog.record
  // 新接口场景编号可能超过安全整数范围，发布路径禁止转换为 Number。
  const sceneId = String(record?.id ?? '').trim()
  if (!record || !/^[1-9]\d*$/.test(sceneId)) {
    publishDialog.step = 'error'
    publishDialog.title = '发布失败提示'
    publishDialog.error = '当前场景缺少有效编号'
    return
  }
  if (publishDialog.incompatibleMode) {
    publishDialog.step = 'form'
    publishDialog.error = '当前访问模式不属于当前平台，请重新选择后再发布'
    return
  }
  if (!publishModeOptions.value.some((option) => option.value === publishDialog.mode)) {
    publishDialog.step = 'error'
    publishDialog.title = '发布失败提示'
    publishDialog.error = '当前没有可用的访问模式，请刷新后重试'
    return
  }
  if (requiresAccessPassword.value) {
    const password = publishDialog.password
    if (!password || password.length < 6 || password.length > 32) {
      publishDialog.step = 'form'
      publishDialog.error = '访问密码长度需为 6 到 32 位'
      ElMessage.warning(publishDialog.error)
      return
    }
    if (!/^[A-Za-z0-9!@#$%^&*()_\-]+$/.test(password)) {
      publishDialog.step = 'form'
      publishDialog.error = '访问密码仅支持数字、字母及 !@#$%^&*()-_'
      ElMessage.warning(publishDialog.error)
      return
    }
  }
  try {
    // 只有详情与当前植被版本核对通过后，才允许调用整场发布写接口。
    await validateVegetationBeforeScenePublish(sceneId)
  } catch (error) {
    publishDialog.step = 'error'
    publishDialog.title = '发布失败提示'
    publishDialog.error = error instanceof Error ? error.message : '植被版本核对失败，请稍后重试。'
    return
  }
  const [error, publishResult] = await toData(
    publishDim3dScene(String(sceneId), {
      // 新版发布接口要求 accessMode 必填；直接提交字典 dictValue，避免本地映射遗漏后端新增模式。
      accessMode: publishDialog.mode,
      accessPassword: requiresAccessPassword.value ? publishDialog.password : undefined,
    }),
  )
  if (error) {
    publishDialog.step = 'error'
    publishDialog.title = '发布失败提示'
    const responseError = error as { msg?: string; message?: string }
    publishDialog.error = responseError.msg || responseError.message || '网络异常或服务不可用。'
    return
  }
  publishDialog.step = 'success'
  // alreadyPublished=true 表示请求成功但没有创建新发布记录，界面必须与实际发布成功明确区分。
  publishDialog.alreadyPublished = publishResult?.alreadyPublished === true
  publishDialog.title = publishDialog.alreadyPublished ? '该版本已发布' : '发布成功提示'
  // 预览地址只携带编辑场景编号；发布编号和票据由预览页调用 resolve 后取得。
  const sceneType = record.sceneType === 'GisScene' ? 'gis' : 'local3d'
  publishDialog.url =
    `${window.location.origin}/scenePreview?sceneId=${encodeURIComponent(sceneId)}` +
    `&sceneType=${sceneType}`
  await getList()
}

const copyPublishUrl = async () => {
  if (!publishDialog.url) return
  await navigator.clipboard?.writeText(publishDialog.url)
  ElMessage.success('链接已复制')
}

const openAuthorizationDialog = async (record: TransferListItem) => {
  authorizationDialog.visible = true
  authorizationDialog.record = record
  authorizationDialog.grantTenantId = ''
  authorizationDialog.description = ''
  // 每次打开均从第一页重新读取，避免沿用上一次弹窗中的搜索词或已失效租户。
  void loadTenantOptions(authorizationTenantSelect, true, '')
}

const closeAuthorizationDialog = () => {
  if (authorizationDialog.submitting) return
  authorizationDialog.visible = false
  authorizationDialog.record = undefined
  authorizationDialog.grantTenantId = ''
  authorizationDialog.description = ''
}

const submitAuthorization = async () => {
  const sceneId = String(authorizationDialog.record?.id ?? '').trim()
  const grantTenantId = authorizationDialog.grantTenantId.trim()
  if (!sceneId || !grantTenantId) {
    ElMessage.warning('请选择要授权的租户')
    return
  }
  authorizationDialog.submitting = true
  const [error] = await toData(grantDim3dSceneTenant({ sceneId, grantTenantId }))
  authorizationDialog.submitting = false
  if (error) {
    const responseError = error as { msg?: string; message?: string }
    ElMessage.error(responseError.msg || responseError.message || '授权失败，请稍后重试')
    return
  }
  ElMessage.success('授权成功')
  authorizationDialog.grantTenantId = ''
  authorizationDialog.description = ''
}

enum OperateEnum {
  Add = 'Add',
  Edit = 'Edit',
  Delete = 'Delete',
  Preview = 'Preview',
  Copy = 'Copy',
  TogglePublish = 'TogglePublish',
  Enter = 'Enter',
  Authorize = 'Authorize',
}

const formatList = (list?: Dim3dScenePageVo[]) => {
  if (!list) return []
  return list.map((item) => {
    // 旧接口类型没有声明 description，但历史响应可能携带该展示字段；仅在适配层读取。
    const sceneTypeText = String(item.sceneType ?? '').toLowerCase()
    const sceneType = sceneTypeText.includes('gis') ? 'GisScene' : 'CommScene'
    /* 接口字段是可选的，仅把明确的 0/1 视为可展示发布状态。 */
    const hasPublishStatus = item.publishStatus === 0 || item.publishStatus === 1
    const publishStatusLabel = hasPublishStatus
      ? item.publishStatus === 1
        ? '已发布'
        : '未发布'
      : ''

    return {
      ...item,
      // 新场景接口的主键和名称字段固定为 sceneId、name，列表卡片与编辑器统一使用这两个字段。
      id: String(item.sceneId ?? ''),
      name: String(item.name ?? '').trim(),
      description: item.sceneDesc || '',
      // coverAssetId 是 OSS 编号，真实图片地址由 resolveSceneCoverUrls 查询后从缓存读取。
      // photoAddress 始终保留编号，编辑保存时必须把编号提交给后端而不是提交 URL。
      imgPath:
        item.coverUrl || coverUrlByAssetId.value.get(String(item.coverAssetId ?? '').trim()) || '',
      photoAddress: String(item.coverAssetId ?? '').trim(),
      isPublish: item.publishStatus,
      // 仅保留列表返回值用于管理信息展示；预览分片编号必须重新从 resolve 响应取得。
      publishedPublicationId: String(item.publishedPublicationId ?? '').trim(),
      project: item.sceneCategory || '',
      updateTime: item.updateTime || '',
      sceneType,
      sceneTypeLabel: getProjectSceneTypeLabel(sceneType),
      sceneCardTypeLabel: getProjectSceneCardTypeLabel(sceneType),
      category: publishStatusLabel,
      publishStatusLabel,
    }
  })
}

const formatTime = (value?: string) => {
  if (!value) return '--'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

export type TransferListItem = ReturnType<typeof formatList>[0]

defineOptions({ name: 'SceneManage' })

const originList = ref<Dim3dScenePageVo[]>([])
const originTotal = ref(0)
/** 场景分类选项来自 dim3d_scene_category 字典，编码用于筛选，名称用于展示。 */
const sceneCategoryOptions = ref<DictionaryOption[]>([])
let sceneDictionariesLoaded = false
/** 场景封面 OSS 编号到真实访问地址的响应式缓存，避免卡片直接猜测存储路径。 */
const coverUrlByAssetId = ref(new Map<string, string>())
const pagination = reactive({ page: 1, size: 10 })

interface SceneFilters {
  name: string
  sceneType: SceneTypeFilterValue
  status: number | typeof CATEGORY_ALL
  tenant: string
}

/**
 * “全部租户”不能使用空字符串作为下拉值：Element Plus 会把空值当成未选择并显示占位符。
 * 使用页面内部专用哨兵值保留“全部租户”文案，发起接口请求时再转换为 undefined。
 */
const ALL_TENANTS_FILTER_VALUE = '__all_tenants__'

const createDefaultFilters = (): SceneFilters => ({
  name: '',
  sceneType: SCENE_TYPE_ALL,
  status: CATEGORY_ALL,
  tenant: ALL_TENANTS_FILTER_VALUE,
})
const draftFilters = reactive<SceneFilters>(createDefaultFilters())
const appliedFilters = reactive<SceneFilters>(createDefaultFilters())
const SCENE_CATEGORY_ALL = ''
const selectedProjectCategory = ref(SCENE_CATEGORY_ALL)

const addDialogVisible = ref(false)
const editRecord = ref<TransferListItem>()

const statusOptions = [
  { label: '全部', value: CATEGORY_ALL },
  { label: '已发布', value: 1 },
  { label: '未发布', value: 0 },
]

/** 单个远程租户下拉框的分页状态；两个控件相互独立，避免搜索授权租户时覆盖筛选框选中项。 */
interface TenantRemoteSelectState {
  options: OperationTenantSelectOption[]
  keyword: string
  page: number
  total: number
  loadedRowCount: number
  /** 首次打开或关键词变更时的加载状态；组件会显示空态加载提示。 */
  loading: boolean
  /**
   * 触底分页的后台追加状态。必须与 loading 分离：元素增强组件库（Element Plus）在 loading 时会卸载滚动容器，
   * 若分页也使用该状态，滚动条会回到起点并产生明显的“刷新”体感。
   */
  loadingMore: boolean
  error: string
  requestVersion: number
}

const TENANT_OPTION_PAGE_SIZE = 20
const createTenantRemoteSelectState = () =>
  reactive<TenantRemoteSelectState>({
    options: [],
    keyword: '',
    page: 0,
    total: 0,
    loadedRowCount: 0,
    loading: false,
    loadingMore: false,
    error: '',
    requestVersion: 0,
  })

const filterTenantSelect = createTenantRemoteSelectState()
const authorizationTenantSelect = createTenantRemoteSelectState()
/** 筛选框保留“全部租户”；授权框只允许选择接口返回的真实租户。 */
const filterTenantOptions = computed(() => [
  { label: '全部租户', value: ALL_TENANTS_FILTER_VALUE },
  ...filterTenantSelect.options,
])

/**
 * 加载租户下拉选项。重置查询允许覆盖仍在途的旧请求，并通过版本号丢弃晚到响应；
 * 追加查询保持滚动容器挂载，并原地补充选项，避免触底时菜单重置、滚动条跳回顶部。
 */
const loadTenantOptions = async (
  state: TenantRemoteSelectState,
  reset: boolean,
  keyword = state.keyword,
) => {
  const normalizedKeyword = keyword.trim()
  if (
    !reset &&
    (state.loading || state.loadingMore || (state.page > 0 && state.loadedRowCount >= state.total))
  )
    return

  const requestVersion = reset ? ++state.requestVersion : state.requestVersion
  const nextPage = reset ? 1 : state.page + 1
  if (reset) {
    state.keyword = normalizedKeyword
    state.page = 0
    state.total = 0
    state.loadedRowCount = 0
    state.options = []
    // 新搜索会使旧分页响应失效，此处同步解除旧的分页锁，保证新搜索可正常完成。
    state.loadingMore = false
  }
  // 仅首次加载/搜索显示组件级 loading；分页阶段保留原菜单和滚动位置。
  if (reset) state.loading = true
  else state.loadingMore = true
  state.error = ''

  try {
    const page = await pageOperationTenants({
      searchValue: normalizedKeyword || undefined,
      pageNum: nextPage,
      pageSize: TENANT_OPTION_PAGE_SIZE,
    })
    // 用户已输入新关键词时，旧请求即使更晚返回也不能覆盖当前结果。
    if (requestVersion !== state.requestVersion) return

    const loadedOptions = createOperationTenantSelectOptions(page.rows)
    if (reset) {
      state.options = loadedOptions
    } else {
      /**
       * 原地追加可保留已挂载选项和滚动容器的身份；按 tenantId 去重，
       * 兼容后端页码边界存在重复数据的情况，避免重复渲染与无效布局计算。
       */
      const existingTenantIds = new Set(state.options.map((option) => option.value))
      loadedOptions.forEach((option) => {
        if (!existingTenantIds.has(option.value)) {
          state.options.push(option)
          existingTenantIds.add(option.value)
        }
      })
    }
    state.page = nextPage
    state.total = page.total
    state.loadedRowCount = reset ? page.rows.length : state.loadedRowCount + page.rows.length
  } catch (error) {
    if (requestVersion !== state.requestVersion) return
    const responseError = error as { msg?: string; message?: string }
    state.error = responseError.msg || responseError.message || '租户列表加载失败'
    if (reset) state.options = []
  } finally {
    if (requestVersion === state.requestVersion) {
      if (reset) state.loading = false
      else state.loadingMore = false
    }
  }
}

/** Element Plus 在 remote 模式下按 debounce 延迟调用，关键词直接透传 searchValue 做服务端模糊搜索。 */
const searchFilterTenants = (keyword: string) =>
  void loadTenantOptions(filterTenantSelect, true, keyword)
const searchAuthorizationTenants = (keyword: string) =>
  void loadTenantOptions(authorizationTenantSelect, true, keyword)

const handleFilterTenantVisibleChange = (visible: boolean) => {
  if (visible && filterTenantSelect.page === 0 && !filterTenantSelect.loading) {
    void loadTenantOptions(filterTenantSelect, true, '')
  }
}
const handleAuthorizationTenantVisibleChange = (visible: boolean) => {
  if (visible && authorizationTenantSelect.page === 0 && !authorizationTenantSelect.loading) {
    void loadTenantOptions(authorizationTenantSelect, true, '')
  }
}

/** 下拉滚动触底后按页追加；非底部方向事件不触发网络请求。 */
const handleFilterTenantEndReached = (direction: string) => {
  if (direction === 'bottom') void loadTenantOptions(filterTenantSelect, false)
}
const handleAuthorizationTenantEndReached = (direction: string) => {
  if (direction === 'bottom') void loadTenantOptions(authorizationTenantSelect, false)
}
/** 当前页分类对应的服务端总数，避免直接用当前页行数作为分类统计。 */
const sceneCategoryTotals = ref(new Map<string, number>())
/** 不受当前分类筛选影响的总数，专门用于“全部”分类标签。 */
const sceneCategoryAllTotal = ref(0)
let latestSceneCategoryTotalsRequestId = 0
/** 场景分类导航使用字典名称展示；数量由同一筛选条件下的独立统计请求提供。 */
const categoryNavigation = computed(() => {
  return [
    {
      // 当前列表可能已经按某个分类过滤，不能直接复用 originTotal 作为“全部”总数。
      label: `全部（${sceneCategoryAllTotal.value}）`,
      value: SCENE_CATEGORY_ALL,
    },
    ...sceneCategoryOptions.value.map((option) => ({
      label: `${option.label}（${sceneCategoryTotals.value.get(option.value) ?? 0}）`,
      value: option.value,
    })),
  ]
})

/** 新接口已经按 pageNum/pageSize 返回当前页，页面只负责格式化，不能再次切片。 */
const total = computed(() => originTotal.value)
const list = computed(() => formatList(originList.value))

/** 新场景接口只返回封面 OSS 编号，必须通过资源接口解析可访问地址后再渲染卡片。 */
const resolveSceneCoverUrls = async (rows: Dim3dScenePageVo[], requestId: number) => {
  const ids = [
    ...new Set(
      rows
        .map((row) => String(row.coverAssetId ?? '').trim())
        .filter((id) => id && !coverUrlByAssetId.value.has(id)),
    ),
  ]
  if (!ids.length) return

  const results = await Promise.all(
    ids.map(async (id) => {
      try {
        const response = await getDim3dOssFileById(id, {
          suppressNotFoundNotification: true,
        })
        const file = response.data?.find((item) => String(item.ossId ?? '').trim() === id)
        return [id, file?.url?.trim() || ''] as const
      } catch {
        return [id, ''] as const
      }
    }),
  )

  if (requestId !== latestSceneListRequestId) return
  const next = new Map(coverUrlByAssetId.value)
  results.forEach(([id, url]) => {
    if (url) next.set(id, url)
  })
  coverUrlByAssetId.value = next
}

/**
 * 所有场景查询都从这里生成参数。Element Plus 下拉框初始化期间可能短暂回写空值，
 * 非法或空的筛选值统一折叠为“全部”，避免视觉上仍是默认项却生成不同请求。
 */
const buildSceneListQueryParams = (): SceneListQueryParams => {
  return {
    sceneName: appliedFilters.name.trim() || undefined,
    // 新场景分页接口同时支持本地三维与 GIS；只有“全部”才省略类型参数。
    sceneType:
      appliedFilters.sceneType === 'GisScene'
        ? 'gis'
        : appliedFilters.sceneType === 'CommScene'
          ? 'local3d'
          : undefined,
    sceneCategory: selectedProjectCategory.value || undefined,
    tenantId:
      appliedFilters.tenant && appliedFilters.tenant !== ALL_TENANTS_FILTER_VALUE
        ? appliedFilters.tenant
        : undefined,
    publishStatus:
      appliedFilters.status === 0 || appliedFilters.status === 1
        ? appliedFilters.status
        : undefined,
  }
}

/** 场景列表请求代次；快速筛选或翻页时只允许最后一次响应更新页面。 */
let latestSceneListRequestId = 0

const getList = async () => {
  const requestId = ++latestSceneListRequestId
  const params = buildSceneListQueryParams()

  try {
    const data = await pageDim3dScene({
      ...params,
      pageNum: pagination.page,
      pageSize: pagination.size,
    })
    if (requestId !== latestSceneListRequestId) return
    originList.value = data.rows || []
    originTotal.value = data.total || 0
    // 未选择分类时，当前分页接口的 total 就是未筛选总数，可直接复用，避免额外请求。
    if (selectedProjectCategory.value === SCENE_CATEGORY_ALL) {
      sceneCategoryAllTotal.value = data.total || 0
    }
    if (sceneDictionariesLoaded) void loadSceneCategoryTotals(requestId)
    await resolveSceneCoverUrls(originList.value, requestId)
  } catch {
    if (requestId !== latestSceneListRequestId) return
    originList.value = []
    originTotal.value = 0
  }
}

/**
 * 首次加载场景分类和发布访问模式字典。
 * 两个字典与场景列表相互独立，使用并行请求减少首屏等待；失败时保留空选项，避免伪造编码。
 */
const loadSceneDictionaries = async () => {
  accessModeLoading.value = true
  try {
    const [[categoryError, categoryData], [accessModeError, accessModeData]] = await Promise.all([
      toData(getDim3dSceneCategoryDictionary({ suppressNotFoundNotification: true })),
      // 当前固定发布服务提供自己的能力，不能把空旧字典补成未实现的公开权限。
      DIM3D_ADMIN_API ? Promise.resolve([undefined, []] as const) : toData(getDim3dAccessModeDictionary({ suppressNotFoundNotification: true })),
    ])

    sceneCategoryOptions.value =
      !categoryError && Array.isArray(categoryData)
        ? createDim3dDictionaryOptions(categoryData)
        : []
    publishModeOptions.value =
      !accessModeError && Array.isArray(accessModeData)
        ? [...
            resolveScenePublishAccessModes(
              managementCapabilities,
              createDim3dDictionaryOptions(accessModeData),
            ),
          ]
        : []
    sceneDictionariesLoaded = true
    // 字典请求和列表请求并行时，列表可能先返回；字典到达后补发一次分类统计。
    if (latestSceneListRequestId > 0) void loadSceneCategoryTotals(latestSceneListRequestId)
  } finally {
    accessModeLoading.value = false
  }
}

/** 首载并行读取字典和场景列表，避免筛选字典阻塞主列表渲染。 */
onBeforeMount(() => {
  void Promise.all([loadSceneDictionaries(), getList()])
})

/**
 * 对字典中的每个分类按相同筛选条件查询真实 total，避免把当前页行数误当分类总数。
 * 新接口暂未提供分类聚合字段，因此只发起 pageSize=1 的最小统计请求。
 */
const loadSceneCategoryTotals = async (requestId: number) => {
  // 统计必须覆盖字典中的全部分类，不能只统计当前页出现的分类。
  const categoryValues = sceneCategoryOptions.value.map((option) => option.value)
  if (!categoryValues.length) {
    if (requestId === latestSceneListRequestId) {
      sceneCategoryTotals.value = new Map()
      // 没有分类字典时只能使用当前列表总数；此时页面不会存在可选分类筛选。
      sceneCategoryAllTotal.value = originTotal.value
    }
    return
  }

  const categoryRequestId = ++latestSceneCategoryTotalsRequestId
  // 当前已选分类只影响主列表，分类统计请求需要移除该条件后逐项查询。
  const baseParams = { ...buildSceneListQueryParams(), sceneCategory: undefined }
  /**
   * “全部”总数与分类统计使用同一组名称、类型、状态和租户条件，但必须移除分类条件。
   * 已处于“全部”时直接复用主列表 total；切换到具体分类后才补发一次无分类统计请求。
   */
  const allTotalPromise =
    selectedProjectCategory.value === SCENE_CATEGORY_ALL
      ? Promise.resolve(originTotal.value)
      : pageDim3dScene({ ...baseParams, pageNum: 1, pageSize: 1 })
          .then((page) => page.total || 0)
          .catch(() => 0)
  const categoryTotalsPromise = Promise.all(
    categoryValues.map(async (category) => {
      try {
        const page = await pageDim3dScene({
          ...baseParams,
          sceneCategory: category,
          pageNum: 1,
          pageSize: 1,
        })
        return [category, page.total || 0] as const
      } catch {
        return [category, 0] as const
      }
    }),
  )
  const [allTotal, results] = await Promise.all([allTotalPromise, categoryTotalsPromise])

  if (
    requestId !== latestSceneListRequestId ||
    categoryRequestId !== latestSceneCategoryTotalsRequestId
  ) {
    return
  }
  sceneCategoryAllTotal.value = allTotal
  sceneCategoryTotals.value = new Map(results)
}

const handlePaginationChange = (data: { page: number; size: number }) => {
  // 服务端分页需要在页码或页长变化后重新请求当前页；同值回写直接忽略，避免重复请求。
  if (pagination.page === data.page && pagination.size === data.size) return
  pagination.page = data.page
  pagination.size = data.size
  void getList()
}

const applyFilters = () => {
  Object.assign(appliedFilters, draftFilters)
  pagination.page = 1
  pagination.size = 10
  void getList()
}

const resetFilters = () => {
  Object.assign(draftFilters, createDefaultFilters())
  selectedProjectCategory.value = SCENE_CATEGORY_ALL
  applyFilters()
}

const selectProjectCategory = (value: string) => {
  if (selectedProjectCategory.value === value) return
  selectedProjectCategory.value = value
  pagination.page = 1
  void getList()
}

const openSceneEditor = (mode: UnityRenderMode | null) => {
  const record = enterDialog.record
  if (!record || (mode && !isUnityRenderModeConfigured(mode)) || (mode === 'webgpu' && !browserWebGpuAvailable)) return
  const sceneId = String(record.id ?? '').trim()
  /**
   * 新场景接口的路径编号按字符串契约传递，不能先转换为 Number。
   * 这里仅校验非空，避免大整数精度丢失或把有效业务编号转换成 NaN；
   * 编辑器和预览页均继续按字符串保存该编号，避免长整型在路由链路中失真。
   */
  if (!sceneId || sceneId === 'undefined' || sceneId === 'null' || sceneId === 'NaN') {
    ElMessage.warning('当前场景缺少有效编号，暂不能进入编辑器')
    return
  }
  /**
   * 锁申请必须由编辑器页自己完成。内嵌管理页先申请锁再 window.open 存在不可恢复竞态：
   * 页签创建或跨来源导航失败时，管理页无法可靠释放刚申请的锁，最终造成“无人编辑但场景被占用”。
   * 这里先打开编辑页，再由编辑器初始化阶段申请锁；锁定时编辑器会自行关闭当前页签。
   */
  const { href } = router.resolve({
    path: '/sceneEdit',
    query: {
      id: sceneId,
      name: record.name,
      sceneType: record.sceneType === 'GisScene' ? 'gis' : 'local3d',
      ...(mode ? { renderMode: mode } : {}),
      // 独立预览页不能读取父页面内存上下文，平台类型必须写入 URL。
      platformType: authContext.getPlatformType() || 'operation',
    },
  })
  const targetHref = withTabAuthHandoff(href)
  const editorWindow = window.open(targetHref, '_blank')
  if (!editorWindow) {
    ElMessage.warning('编辑器页签打开失败，请允许浏览器弹窗后重试')
    return
  }
  try {
    const context = authContext.get()
    if (context) editorWindow.name = createTabAuthWindowName(context)
  } catch {
    // 新页签已经开始加载时，鉴权走地址上的 authHandoff。
  }
  enterDialog.visible = false
}

const OperateActionMap = {
  [OperateEnum.Enter]: (record: TransferListItem) => {
    enterDialog.record = record
    enterDialog.visible = true
  },
  [OperateEnum.Preview]: (record: TransferListItem) => {
    const sceneId = String(record.id ?? '').trim()
    if (!/^[1-9]\d*$/.test(sceneId)) {
      ElMessage.warning('当前场景缺少有效编号，暂不能进入发布预览')
      return
    }
    const { href } = router.resolve({
      path: '/scenePreview',
      query: {
        // 固定发布和旧场景解析使用不同合同，由列表返回的发布编号判断入口。
        ...(/^PUB-[1-9]\d{0,18}$/.test(record.publishedPublicationId || '')
          ? { publicationId: record.publishedPublicationId }
          : { sceneId }),
        sceneType: record.sceneType === 'GisScene' ? 'gis' : 'local3d',
      },
    })
    // 公开场景仍可匿名访问；个人/企业场景优先复用 iframe 已取得的租户登录态，避免已登录用户
    // 打开新页签后被重复要求登录。空白页签必须在点击事件内同步创建，防止浏览器拦截弹窗。
    const previewWindow = window.open('', '_blank')
    if (!previewWindow) {
      ElMessage.warning('预览页签打开失败，请允许浏览器弹窗后重试')
      return
    }
    previewWindow.document.title = '场景预览加载中'
    const context = authContext.get()
    if (context) previewWindow.name = createTabAuthWindowName(context)
    previewWindow.location.href = withTabAuthHandoff(href)
  },
  [OperateEnum.TogglePublish]: async (record: TransferListItem) => {
    // 发布和取消发布直接使用字符串编号，避免 19 位场景 ID 发生精度截断。
    const sceneId = String(record.id ?? '').trim()
    if (!/^[1-9]\d*$/.test(sceneId)) {
      ElMessage.warning('当前场景缺少有效编号，暂不能切换发布状态')
      return
    }

    // 发布按钮只切换明确的 0/1 状态，避免接口字段缺失时误发请求。
    if (record.isPublish !== 0 && record.isPublish !== 1) {
      ElMessage.warning('当前场景发布状态未知，暂不能切换发布状态')
      return
    }

    if (record.isPublish === 0) {
      openPublishDialog(record)
      return
    }

    try {
      await openManageSceneUnpublishConfirm(record.name)
    } catch {
      return
    }
    // 固定发布撤销只作用于当前记录；其他平台沿用原取消发布接口。
    const [error] = await toData(DIM3D_ADMIN_API
      ? revokeFixedPublication(record.publishedPublicationId || '').then(data => ({ data }))
      : cancelDim3dScene(String(sceneId)))
    if (error) {
      ElMessage.error('取消发布场景失败，请稍后重试')
      return
    }

    // 重新读取新接口结果，保证状态角标、筛选计数和按钮动作同步更新。
    await getList()
  },
  [OperateEnum.Add]: () => {
    editRecord.value = void 0
    addDialogVisible.value = true
  },
  [OperateEnum.Edit]: (record: TransferListItem) => {
    editRecord.value = record
    addDialogVisible.value = true
  },
  [OperateEnum.Copy]: async (record: TransferListItem) => {
    if (!canUseSceneCardAction(sceneCardCapabilities, 'copy')) {
      return ElMessage.warning('当前场景不可复制')
    }
    const [err] = await toData(copyDim3dScene(String(record.id)))
    if (err) return ElMessage.error('复制失败')
    getList()
  },
  [OperateEnum.Authorize]: (record: TransferListItem) => {
    if (!canUseSceneCardAction(sceneCardCapabilities, 'authorize')) {
      ElMessage.warning('当前场景不可授权')
      return
    }
    void openAuthorizationDialog(record)
  },
  [OperateEnum.Delete]: (record: TransferListItem) => {
    if (!canUseSceneCardAction(sceneCardCapabilities, 'delete')) {
      ElMessage.warning('当前场景不可删除')
      return
    }
    openManageDeleteConfirm('场景', record.name).then(async () => {
      await removeDim3dScene(String(record.id))
      getList()
    })
  },
}

function handleOperate(action: OperateEnum.Add): void
function handleOperate(
  action: Exclude<OperateEnum, OperateEnum.Add>,
  record: TransferListItem,
): void
function handleOperate(action: OperateEnum, record?: TransferListItem) {
  if (action === OperateEnum.Add) {
    return OperateActionMap[action]?.()
  } else if (record) {
    OperateActionMap[action]?.(record)
  }
}

/**
 * 封面点击只预览已发布场景。
 * 未发布场景没有可供预览页读取的线上版本，因此仅提示用户先发布，不打开新页签；
 * 底部“进入”按钮仍保持进入编辑器的原有语义，不受该预览门禁影响。
 */
const handleMediaPreview = (record: TransferListItem) => {
  if (record.isPublish === 0) {
    ElMessage.warning('场景未发布请先发布场景')
    return
  }
  handleOperate(OperateEnum.Preview, record)
}
</script>

<style scoped lang="scss">
/* 发布流程弹窗沿用管理弹窗的 640px 标题栏、内容区和底部操作区规范。 */
:global(.manage-scene-publish-overlay.el-overlay) {
  background: rgb(0 0 0 / 40%);
}
:global(.manage-scene-publish-dialog.el-dialog) {
  padding: 0;
  overflow: hidden;
  border-radius: 8px;
}
:global(.manage-scene-publish-dialog.is-success.el-dialog) {
  width: 525px !important;
  height: 209px;
  min-height: 209px;
}
:global(.manage-scene-publish-dialog.is-error.el-dialog) {
  box-sizing: border-box;
  width: 480px !important;
  max-width: calc(100vw - 32px) !important;
  height: 212px;
  min-height: 212px;
  max-height: calc(100vh - 32px);
  margin: 0 auto;
}
:global(.manage-scene-publish-dialog .el-dialog__header) {
  display: none;
}
:global(.manage-scene-publish-dialog .el-dialog__body) {
  padding: 0 !important;
}
.manage-scene-publish-dialog__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 48px;
  padding: 0 24px;
  border-bottom: 1px solid var(--manage-color-line, #e5e5e5);
}
.manage-scene-publish-dialog__title {
  font-size: 16px;
  color: var(--manage-text, #333333);
}
.manage-scene-publish-dialog.is-success .manage-scene-publish-dialog__title {
  display: inline-flex;
  gap: 8px;
  align-items: center;
  font-size: 16px;
  font-weight: 400;
  line-height: 24px;
  color: #00a870;
}
.manage-scene-publish-dialog.is-success .manage-scene-publish-dialog__top {
  height: 52px;
}
.manage-scene-publish-dialog.is-error .manage-scene-publish-dialog__top {
  height: 48px;
  padding: 0 24px;
}
.manage-scene-publish-dialog.is-error .manage-scene-publish-dialog__title {
  display: inline-flex;
  gap: 8px;
  align-items: center;
  font-size: 16px;
  font-weight: 400;
  line-height: 24px;
  color: #e34d59;
}
.manage-scene-publish-dialog.is-error .manage-scene-publish-dialog__title::before {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  font-size: 12px;
  font-weight: 700;
  line-height: 20px;
  color: #ffffff;
  content: '!';
  background: #e34d59;
  border-radius: 50%;
}
.manage-scene-publish-dialog.is-error .manage-scene-publish-dialog__close {
  font-size: 16px;
}
.manage-scene-publish-dialog.is-success .manage-scene-publish-dialog__title::before {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  font-size: 13px;
  font-weight: 700;
  color: #ffffff;
  content: '✓';
  background: #00a870;
  border-radius: 50%;
}
.manage-scene-publish-dialog__close {
  padding: 0;
  font-size: 18px;
  color: var(--manage-text-2, #999999);
  cursor: pointer;
  background: transparent;
  border: 0;
}
.manage-scene-publish-dialog__body {
  padding: 24px;
  color: var(--manage-text-2, #595959);
}
.manage-scene-publish-dialog.is-success .manage-scene-publish-dialog__body {
  box-sizing: border-box;
  height: 157px;
  padding: 42px 27px 0;
}
.manage-scene-publish-dialog.is-error .manage-scene-publish-dialog__body {
  box-sizing: border-box;
  height: 106px;
  padding: 26px 24px 0;
}
.manage-scene-publish-dialog__error-main,
.manage-scene-publish-dialog__error-detail {
  margin: 0;
  font-weight: 400;
}
.manage-scene-publish-dialog__error-main {
  font-size: 14px;
  line-height: 22px;
  color: #595959;
}
.manage-scene-publish-dialog__error-detail {
  margin-top: 2px;
  font-size: 12px;
  line-height: 18px;
  color: #e34d59;
}
.manage-scene-publish-dialog__success-text {
  margin: 0 0 11px;
  font-size: 14px;
  line-height: 22px;
  color: var(--manage-text-2, #595959);
}
.manage-scene-publish-dialog.is-success .manage-scene-publish-dialog__success-text {
  font-size: 14px;
  font-weight: 400;
  line-height: 22px;
  color: #595959;
}
.manage-scene-publish-dialog__body > .el-input,
.manage-scene-publish-dialog__control {
  width: 100%;
  margin-bottom: 16px;
}
.manage-scene-publish-dialog__label {
  display: block;
  margin-bottom: 8px;
  font-size: 14px;
  line-height: 22px;
}
.manage-scene-publish-dialog.is-success .manage-scene-publish-dialog__label {
  margin-bottom: 4px;
  font-size: 12px;
  line-height: 18px;
  color: #999999;
}
.manage-scene-publish-dialog__hint {
  margin: 0 0 16px;
  font-size: 14px;
}
.manage-scene-publish-dialog__tip {
  display: block;
  margin-top: -8px;
  margin-bottom: 16px;
  font-size: 12px;
  line-height: 20px;
  color: var(--manage-text-3, #999999);
}
.manage-scene-publish-dialog__error {
  color: #e34d59;
}
.manage-scene-publish-dialog__url-row {
  display: flex;
  gap: 8px;
}
.manage-scene-publish-dialog__url-row .el-input {
  flex: 1;
}
.manage-scene-publish-dialog__url-row :deep(.el-input__wrapper) {
  height: 34px;
  min-height: 34px;
  border-radius: 8px;
  box-shadow: inset 0 0 0 1px var(--manage-color-line-component, #d9d9d9) !important;
}
.manage-scene-publish-dialog__url-row :deep(.el-input__inner) {
  font-size: 14px;
  line-height: 24px;
  color: #595959;
}
.manage-scene-publish-dialog__copy {
  width: 58px !important;
  min-width: 58px !important;
  height: 34px !important;
  padding: 0 !important;
  font-size: 14px;
  font-weight: 400;
  color: var(--manage-accent, #51a195) !important;
  background: transparent !important;
  border: 1px solid var(--manage-accent, #51a195) !important;
  border-radius: 4px !important;
}
.manage-scene-publish-dialog__footer {
  display: flex;
  gap: 16px;
  justify-content: flex-end;
  padding: 16px 24px 24px;
  border-top: 1px solid var(--manage-color-line, #e5e5e5);
}
.manage-scene-publish-dialog.is-error .manage-scene-publish-dialog__footer {
  box-sizing: border-box;
  height: 58px;
  padding: 12px 24px 0;
}
.manage-scene-publish-dialog.is-error .manage-scene-publish-dialog__footer .el-button {
  width: 65px;
  min-width: 65px;
  height: 32px;
  font-size: 14px;
  line-height: 22px;
  border-radius: 4px;
}
.manage-scene-publish-dialog.is-error
  .manage-scene-publish-dialog__footer
  .manage-scene-publish-dialog__save {
  width: 65px;
  min-width: 65px;
}
.manage-scene-publish-dialog__footer .el-button {
  box-sizing: border-box;
  width: 65px;
  min-width: 65px;
  height: 32px;
  padding: 0;
  margin: 0;
  font-family: 'Source Han Sans SC', 'Microsoft YaHei', sans-serif;
  font-size: 14px;
  font-weight: 400;
  line-height: 22px;
  border-radius: 4px;
  box-shadow: none !important;
}
.manage-scene-publish-dialog__cancel {
  color: var(--manage-accent, #51a195) !important;
  background: transparent !important;
  border-color: var(--manage-accent, #51a195) !important;
}
.manage-scene-publish-dialog__save {
  color: #ffffff !important;
  background: var(--manage-accent, #51a195) !important;
  border-color: var(--manage-accent, #51a195) !important;
}
.manage-scene-publish-dialog__save:hover,
.manage-scene-publish-dialog__save:focus-visible {
  color: #ffffff !important;
  background: #3f887d !important;
  border-color: #3f887d !important;
}
.manage-scene-publish-dialog__cancel:hover,
.manage-scene-publish-dialog__cancel:focus-visible {
  color: #3f887d !important;
  background: rgb(81 161 149 / 8%) !important;
  border-color: #3f887d !important;
}

/* 授权弹窗使用与发布弹窗一致的标题栏、按钮和主题变量，保证明暗主题下尺寸统一。 */
:global(.manage-scene-authorize-overlay.el-overlay) {
  background: rgb(0 0 0 / 40%);
}
:global(.manage-scene-authorize-dialog.el-dialog) {
  --el-bg-color: #ffffff;
  --el-bg-color-overlay: #ffffff;
  --el-fill-color-blank: #ffffff;
  --el-text-color-primary: #333333;
  --el-text-color-regular: #595959;
  --el-text-color-placeholder: #cccccc;
  --el-border-color: #d9d9d9;
  --el-border-color-hover: #51a195;

  padding: 0;
  overflow: hidden;
  background: #ffffff;
  border-radius: 8px;
}
:global(.manage-scene-authorize-dialog .el-dialog__header) {
  display: none;
}
:global(.manage-scene-authorize-dialog .el-dialog__body) {
  padding: 0 !important;
}
.manage-scene-authorize-dialog__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 48px;
  padding: 0 24px;
  border-bottom: 1px solid #e2e2e2;
}
.manage-scene-authorize-dialog__title {
  font-family: 'Source Han Sans SC', 'Microsoft YaHei', sans-serif;
  font-size: 16px;
  font-weight: 400;
  line-height: 24px;
  color: rgb(0 0 0 / 85%);
}
.manage-scene-authorize-dialog__close {
  padding: 0;
  font-size: 18px;
  line-height: 24px;
  color: rgb(0 0 0 / 45%);
  cursor: pointer;
  background: transparent;
  border: 0;
}
.manage-scene-authorize-dialog__body {
  /* Figma 弹窗内容区左右上方 24px，底部留 16px，确保底部按钮位置与设计稿一致。 */
  padding: 24px 24px 16px;
  color: #595959;
}
.manage-scene-authorize-dialog__scene {
  display: flex;
  flex-direction: column;
  gap: 2px;
  align-items: flex-start;
  justify-content: center;
  min-height: 70px;
  padding: 14px 12px;
  margin-bottom: 20px;
  background: rgb(238 246 245);
  border-radius: 8px;
}
.manage-scene-authorize-dialog__label {
  display: block;
  margin-bottom: 8px;
  font-family: 'Source Han Sans SC', 'Microsoft YaHei', sans-serif;
  font-size: 14px;
  font-weight: 400;
  line-height: 22px;
  color: #595959;
}
.manage-scene-authorize-dialog__scene .manage-scene-authorize-dialog__label {
  flex: none;
  align-self: stretch;
  margin: 0;
  color: #595959;
}
.manage-scene-authorize-dialog__scene-name {
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: 'Source Han Sans SC', 'Microsoft YaHei', sans-serif;
  font-size: 14px;
  font-weight: 600;
  line-height: 22px;
  color: #006e63;
  white-space: nowrap;
}
.manage-scene-authorize-dialog__required {
  color: #ed7b2f;
}
.manage-scene-authorize-dialog__control {
  width: 100%;
  margin-bottom: 16px;
}
.manage-scene-authorize-dialog__body :deep(.el-textarea__inner) {
  box-sizing: border-box;
  min-height: 86px !important;
  padding: 8px 16px;
  font-family: 'Source Han Sans SC', 'Microsoft YaHei', sans-serif;
  font-size: 14px;
  line-height: 22px;
  color: #333333;
  resize: none;
  border-color: #d9d9d9;
  border-radius: 8px;
}
.manage-scene-authorize-dialog__body :deep(.el-input__wrapper) {
  box-sizing: border-box;
  min-height: 32px;
  padding: 5px 16px;
  border-radius: 8px;
  box-shadow: inset 0 0 0 1px #d9d9d9 !important;
}
.manage-scene-authorize-dialog__body :deep(.el-input__inner) {
  font-family: 'Source Han Sans SC', 'Microsoft YaHei', sans-serif;
  font-size: 14px;
  line-height: 22px;
  color: #333333;
}
.manage-scene-authorize-dialog__body :deep(.el-input__inner::placeholder),
.manage-scene-authorize-dialog__body :deep(.el-textarea__inner::placeholder) {
  color: #cccccc;
}
.manage-scene-authorize-dialog__body :deep(.el-select .el-input__wrapper) {
  padding-right: 8px;
}
.manage-scene-authorize-dialog__body :deep(.el-select__caret) {
  color: #bfbfbf;
}
.manage-scene-authorize-dialog__footer {
  display: flex;
  gap: 16px;
  justify-content: flex-end;
  padding: 16px 24px 20px;
  border-top: 1px solid #f0f0f0;
}
.manage-scene-authorize-dialog__footer .el-button {
  box-sizing: border-box;
  height: 32px;
  padding: 0;
  margin: 0;
  font-family: 'Source Han Sans SC', 'Microsoft YaHei', sans-serif;
  font-size: 14px;
  font-weight: 400;
  line-height: 22px;
  border-radius: 4px;
  box-shadow: none !important;
}
.manage-scene-authorize-dialog__cancel {
  width: 60px !important;
  min-width: 60px !important;
  color: #51a195 !important;
  background: transparent !important;
  border-color: #51a195 !important;
}
.manage-scene-authorize-dialog__save {
  width: 76px !important;
  min-width: 76px !important;
  color: #ffffff !important;
  background: #51a195 !important;
  border-color: #51a195 !important;
}

@media (width <= 640px) {
  :global(.manage-scene-authorize-dialog.el-dialog) {
    width: calc(100vw - 32px) !important;
    max-width: 608px;
  }
}
/* 渲染选项使用管理主题的次级面板、边框和文字颜色，避免暗色弹窗内出现固定亮色卡片。 */
.manage-scene-render-choice__scene {
  margin: 0 0 16px;
  overflow: hidden;
  color: var(--manage-text-2);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.manage-scene-render-choice__options {
  display: grid;
  gap: 10px;
}
.manage-scene-render-choice__option {
  display: flex;
  flex-direction: column;
  gap: 5px;
  width: 100%;
  padding: 14px 16px;
  color: var(--manage-text);
  text-align: left;
  cursor: pointer;
  background: var(--manage-bg-panel-2);
  border: 1px solid var(--manage-color-line-component);
  border-radius: 8px;
}
.manage-scene-render-choice__option:hover:not(:disabled),
.manage-scene-render-choice__option:focus-visible {
  background: var(--manage-color-accent-soft);
  border-color: var(--manage-accent);
}
.manage-scene-render-choice__option:focus-visible {
  outline: 2px solid var(--manage-accent);
  outline-offset: 2px;
}
.manage-scene-render-choice__option span {
  font-size: 12px;
  color: var(--manage-text-2);
}
/* 禁用选项保留清晰的原因说明，用较弱的底色区分可用状态。 */
.manage-scene-render-choice__option:disabled {
  color: var(--manage-text-2);
  cursor: not-allowed;
  background: var(--manage-bg-input);
}
</style>
