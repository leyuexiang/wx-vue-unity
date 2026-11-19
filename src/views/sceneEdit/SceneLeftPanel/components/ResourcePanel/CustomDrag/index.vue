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
              <!-- 两条目录可以共用同一模型文件，卡片按目录编号独立渲染。 -->
              <div
                draggable="true"
                @dragstart="() => onDragStart(base)"
                @dragend="onDragEnd"
                v-for="base in item.children"
                :key="base.resourceId"
                class="scene-edit-resource-card"
              >
                <div class="scene-edit-resource-card__body">
                  <el-image :src="base.icon || errorImage" class="scene-edit-resource-card__image">
                    <template #error>
                      <img
                        draggable="false"
                        @dragstart.prevent
                        @drag.prevent
                        :src="errorImage"
                        class="scene-edit-resource-card__fallback"
                      />
                    </template>
                  </el-image>
                  <div class="scene-edit-resource-card__name">
                    {{ base.name }}
                  </div>
                </div>
              </div>
            </div>
          </el-collapse-item>
        </el-collapse>
      </div>
    </el-scrollbar>
  </div>
</template>

<script setup lang="ts">
import { Search } from '@element-plus/icons-vue'
import errorImage from '@/assets/images/error.png'
import { filterDataList } from '@/utils/utils'
import { loadDim3dModelGroups, type ModelResourceGroup } from '../modelResource'
import { ref, getCurrentInstance, onMounted, onBeforeUnmount } from 'vue'
import { throttle } from 'lodash-es'
import { MITT_ON_KEY_ENUM } from '@/enums/index'
import type { FileModel } from '@/types/threeScene'

const { $eventBus } = getCurrentInstance()?.proxy || {}

const searchValue = ref('')

const collapseList = ref<ModelResourceGroup[]>([])
const modelGroups = ref<ModelResourceGroup[]>([])

// 默认展开所有折叠项
const activeNames = ref()

const syncCollapseList = () => {
  collapseList.value = filterDataList(searchValue.value, modelGroups.value) as ModelResourceGroup[]
  activeNames.value = collapseList.value.map((item) => item.key)
}

const loadMyModels = async () => {
  try {
    modelGroups.value = await loadDim3dModelGroups('MINE')
    syncCollapseList()
  } catch {
    // 权限失败或网关不可用时显示空分组，不回退到旧资源接口，避免混用鉴权体系。
    modelGroups.value = []
    syncCollapseList()
  }
}

onMounted(() => {
  void loadMyModels()
})

const handleSearch = throttle(() => {
  syncCollapseList()
}, 500)

// 拖拽开始
const onDragStart = (item: FileModel) => {
  $eventBus?.emit(MITT_ON_KEY_ENUM.MODEL_DRAG_START, item)
}

const onDragEnd = () => {
  $eventBus?.emit(MITT_ON_KEY_ENUM.MODEL_DRAG_CANCEL)
}

onBeforeUnmount(() => handleSearch.cancel())
</script>
