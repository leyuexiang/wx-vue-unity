<template>
  <div class="scene-edit-resource-content">
    <!-- 搜索入口固定在资源面板顶部，长资源列表只滚动下方内容。 -->
    <div class="scene-edit-resource-search">
      <el-input
        v-model.trim="searchValue"
        @input="handleSearch"
        placeholder="搜索"
        :prefix-icon="Search"
        clearable
      />
    </div>
    <el-scrollbar class="scene-edit-resource-scroll">
      <div class="scene-edit-resource-groups">
        <el-collapse v-model="activeNames" expand-icon-position="left">
          <el-collapse-item
            :title="item.name"
            :name="item.key"
            v-for="item in collapseList"
            :key="item.key"
          >
            <div class="scene-edit-resource-grid">
              <div
                :draggable="!isDragDisabled(base)"
                :aria-disabled="isDragDisabled(base) || undefined"
                @dragstart="onDragStart($event, base)"
                v-for="base in item.children"
                @dragend="onDragEnd"
                :key="getDragItemKey(base)"
                class="scene-edit-resource-card"
              >
                <img
                  draggable="false"
                  @dragstart.prevent
                  @drag.prevent
                  :src="base.icon || errorImage"
                  class="scene-edit-resource-card__image"
                />
                <span class="scene-edit-resource-card__name">{{ base.name }}</span>
              </div>
            </div>
            <p v-if="item.key === 'camera' && firstPersonDisabledReason" class="first-person-disabled-hint">
              {{ firstPersonDisabledReason }}
            </p>
          </el-collapse-item>
        </el-collapse>
      </div>
    </el-scrollbar>
  </div>
</template>

<script setup lang="ts">
import { Search } from '@element-plus/icons-vue'
import errorImage from '@/assets/images/error.png'
import { systemDataList } from '@/config/leftDragDataList'
import { filterDataList } from '@/utils/utils'
import type { GeometryModel, FileModel, EffectDragItem } from '@/types/threeScene'
import type { LightDragItem, FirstPersonDragItem } from '@/integrations/scene/editorCreationRouter'
import { computed, ref, getCurrentInstance, onBeforeUnmount, onMounted } from 'vue'
import { throttle } from 'lodash-es'
import { DRAG_MODEL_ENUM, MITT_ON_KEY_ENUM } from '@/enums/index'
import type { RuntimeCapabilities } from '@/scene-platform'
import { subscribeActiveSceneViewportHost } from '@/integrations/scene/editorScenePlatformHost'
import {
  filterEditorSceneDragGroupsByRuntimeCapabilities,
  getEditorSceneRuntimeCapabilities,
  getFirstPersonDragDisabledReason,
} from '@/integrations/scene/editorSceneToolCapabilityAdapter'
import { loadDim3dModelGroups, mergeModelResourceGroups } from '../modelResource'

const { $eventBus } = getCurrentInstance()?.proxy || {}

/** 系统面板接受实际可创建的编辑器联合，地图不再伪装为模型或几何体。 */
type SystemDragItem = GeometryModel | FileModel | EffectDragItem | LightDragItem | FirstPersonDragItem
type SystemDragGroup = { name: string; key: string; children: SystemDragItem[] }

const searchValue = ref('')
const runtimeCapabilities = ref<RuntimeCapabilities | null>(null)
const firstPersonDisabledReason = computed(() => getFirstPersonDragDisabledReason(runtimeCapabilities.value))
const isDragDisabled = (item: SystemDragItem) =>
  item.modelType === DRAG_MODEL_ENUM.FirstPerson && Boolean(firstPersonDisabledReason.value)
const collapseList = ref<SystemDragGroup[]>([])
const dim3dModelGroups = ref<Awaited<ReturnType<typeof loadDim3dModelGroups>>>([])
// 默认展开所有当前可用折叠项。
const activeNames = ref<string[]>([])
let stopScenePlatformHostSubscription: (() => void) | null = null

const getAvailableSystemDataList = (): SystemDragGroup[] =>
  filterEditorSceneDragGroupsByRuntimeCapabilities(
    systemDataList,
    runtimeCapabilities.value,
  ) as SystemDragGroup[]

const syncCollapseList = () => {
  /**
   * 先按渲染能力过滤系统资源，再按搜索词缩小列表。
   * 关闭灯光能力时，整组灯光资源直接省略，搜索也只匹配当前可用的入口。
   */
  collapseList.value = filterDataList(
    searchValue.value,
    mergeModelResourceGroups(getAvailableSystemDataList(), dim3dModelGroups.value),
  ) as SystemDragGroup[]
  activeNames.value = collapseList.value.map((item) => item.key)
}

/**
 * 系统资源由“内置资源 + 阶段三系统模型”组成。
 * 接口失败时保留内置资源，避免鉴权服务暂时不可用导致编辑器基础几何体消失。
 */
const loadSystemModels = async () => {
  try {
    const modelGroups = await loadDim3dModelGroups('SYSTEM')
    dim3dModelGroups.value = modelGroups
    syncCollapseList()
  } catch {
    // 阶段三接口错误不覆盖已有内置资源，页面仍可继续编辑基础场景。
  }
}

const handleSearch = throttle(() => {
  syncCollapseList()
}, 500)

// 播放器未就绪或不支持时保留资源卡和说明，同时拦截可能已开始的拖拽事件。
const onDragStart = (event: DragEvent, item: SystemDragItem) => {
  if (isDragDisabled(item)) {
    event.preventDefault()
    return
  }
  $eventBus?.emit(MITT_ON_KEY_ENUM.MODEL_DRAG_START, item)
}

/** 几何体使用唯一编号，文件模型没有编号时使用文件路径和名称构造稳定渲染键。 */
const getDragItemKey = (item: SystemDragItem) =>
  'id' in item ? String(item.id) : `${item.filePath}:${item.name}`

const onDragEnd = () => {
  $eventBus?.emit(MITT_ON_KEY_ENUM.MODEL_DRAG_CANCEL)
}

syncCollapseList()

onMounted(() => {
  stopScenePlatformHostSubscription = subscribeActiveSceneViewportHost((host) => {
    runtimeCapabilities.value = getEditorSceneRuntimeCapabilities(host)
    syncCollapseList()
  })
  void loadSystemModels()
})

onBeforeUnmount(() => {
  stopScenePlatformHostSubscription?.()
  stopScenePlatformHostSubscription = null
  handleSearch.cancel()
})
</script>

<style scoped lang="scss">
.scene-edit-resource-card[aria-disabled='true'] {
  cursor: not-allowed;
  opacity: 0.55;
}

.first-person-disabled-hint {
  margin: 0 8px 8px;
  font-size: 12px;
  line-height: 1.5;
  color: rgb(255 255 255 / 70%);
}
</style>
