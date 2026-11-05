<template>
  <div class="scene-edit-structure-panel">
    <aside class="scene-edit-structure-panel__nav" aria-label="结构分类">
      <el-tooltip
        v-for="item in structureCategoryItems"
        :key="item.value"
        :content="item.label"
        placement="right"
        popper-class="scene-edit-popover"
        :show-after="240"
      >
        <button
          type="button"
          class="scene-edit-structure-panel__nav-item"
          :class="{ 'is-active': activeStructureCategory === item.value }"
          :aria-label="`${item.label} ${item.count}`"
          :aria-pressed="activeStructureCategory === item.value"
          @click="selectStructureCategory(item.value)"
        >
          <!-- Figma 为两种状态分别提供矢量资源，直接切换资源可保持路径、透明度和颜色完全一致。 -->
          <img
            class="scene-edit-structure-panel__nav-icon"
            :src="activeStructureCategory === item.value ? item.activeIcon : item.icon"
            alt=""
            aria-hidden="true"
          />
        </button>
      </el-tooltip>
    </aside>

    <div class="scene-edit-structure-panel__content">
      <!--
        分类按钮、搜索框和创建分组栏共同组成固定区域，仅下方节点列表参与纵向滚动。
        该层级与资源面板一致，可避免长列表滚动时把高频操作入口移出可视区域。
      -->
      <div class="scene-edit-structure-panel__search p-3">
        <el-input v-model.trim="searchValue" placeholder="搜索" :prefix-icon="Search" clearable />
      </div>

      <div class="scene-edit-structure-group__header scene-edit-structure-panel__group-header">
        <div class="scene-edit-structure-group__title">
          {{ activeStructureCategory === 'widget' ? '二维组件' : activeSceneObjectLabel }}
        </div>
        <button
          v-if="activeStructureCategory === 'widget'"
          type="button"
          class="scene-edit-structure-create-group"
          :title="
            (sceneWidgetStore.currentWidgetGroupIds?.length || 0) > 0 &&
            (sceneWidgetStore.currentWidgetsIds?.length || 0) > 0
              ? '将选中分组和组件创建父分组'
              : (sceneWidgetStore.currentWidgetGroupIds?.length || 0) > 1
                ? '将选中分组创建父分组'
                : (sceneWidgetStore.currentWidgetsIds?.length || 0) > 1
                  ? '将选中组件创建分组'
                  : '创建空组件分组'
          "
          :disabled="Boolean(searchKeyword)"
          @click.stop="createWidgetGroup"
        >
          <img :src="createGroupIcon" alt="" />
        </button>
        <button
          v-else
          type="button"
          class="scene-edit-structure-create-group"
          :title="`创建${activeSceneObjectLabel}分组`"
          disabled
          @click.stop="createModelGroup"
        >
          <img :src="createGroupIcon" alt="" />
        </button>
      </div>

      <div v-if="activeStructureCategory !== 'widget' && copyableSelection.length" class="px-3 pb-2">
        <el-button size="small" plain :disabled="Boolean(editorSceneOperation)" @click="copySelectedSceneObjects">
          复制所选节点（{{ copyableSelection.length }}）
        </el-button>
        <el-button v-if="selectedSceneObjectIds.size > 1" size="small" type="danger" plain :disabled="Boolean(editorSceneOperation)" @click="deleteSelectedSceneObjects">
          删除所选节点（{{ selectedSceneObjectIds.size }}）
        </el-button>
      </div>

      <div v-if="activeStructureCategory !== 'widget' && hierarchySelection.length" class="px-3 pb-2 flex gap-2 items-center">
        <el-select
          aria-label="父节点"
          :empty-values="[null, undefined]"
          :model-value="selectedHierarchyParent"
          :placeholder="hierarchySelection.length > 1 ? '为所选节点更换父级' : '选择父节点'"
          :disabled="Boolean(editorSceneOperation)"
          @change="(value: string) => editSelectedHierarchy(value || undefined)"
        >
          <el-option label="场景根节点" value="" />
          <el-option v-for="node in hierarchyParents" :key="node.id" :label="node.name" :value="node.id" />
        </el-select>
        <template v-if="selectedHierarchyNode">
          <button type="button" title="在同级中上移" aria-label="在同级中上移" :disabled="Boolean(editorSceneOperation)" @click="editSelectedHierarchy(selectedHierarchyNode.parentInstanceId, -1)">↑</button>
          <button type="button" title="在同级中下移" aria-label="在同级中下移" :disabled="Boolean(editorSceneOperation)" @click="editSelectedHierarchy(selectedHierarchyNode.parentInstanceId, 1)">↓</button>
        </template>
      </div>

      <el-scrollbar class="scene-edit-structure-panel-scroll">
        <div
          class="scene-edit-structure-panel__body px-3 pb-3"
          @click="clearSelectionFromBlank"
          @contextmenu.prevent="hideContextMenu"
        >
          <!-- 模型与三维组件共用同一套图层列表，只有数据源按当前分类切换。 -->
          <div
            v-if="activeStructureCategory !== 'widget'"
            class="scene-edit-structure-group scene-edit-structure-group--scene-objects"
            title="选择节点以编辑属性，按住 Ctrl 或 Command 多选"
          >
            <draggable
              item-key="id"
              class="scene-edit-structure-root-list"
              :model-value="activeSceneObjectRootItems"
              :disabled="Boolean(searchKeyword)"
              :group="modelLayerDragGroup"
              :move="canMoveModel"
              ghost-class="scene-edit-structure-ghost"
              @change="handleRootModelDragChange"
            >
              <template #item="{ element: item }">
                <div
                  data-structure-item="true"
                  :class="['scene-edit-structure-item', { 'is-active': item.isActive }]"
                  @click.stop="selectItem(item, $event)"
                  @dblclick.stop="focusItem(item)"
                >
                  <div class="scene-edit-structure-item__name">
                    {{ item.name }}
                    <small v-if="getHierarchyParentName(item.id)" class="opacity-70"> · {{ getHierarchyParentName(item.id) }}</small>
                  </div>
                  <div class="flex gap-2 scene-edit-structure-actions">
                    <button
                      type="button"
                      class="scene-edit-structure-action-button"
                      :title="
                        item.raw.visible
                          ? `隐藏${activeSceneObjectLabel}`
                          : `显示${activeSceneObjectLabel}`
                      "
                      @click.stop="updateMeshVisible(item.raw)"
                    >
                      <el-icon :size="14"><View v-if="item.raw.visible" /><Hide v-else /></el-icon>
                    </button>
                    <button
                      type="button"
                      class="scene-edit-structure-action-button"
                      :title="
                        isModelLocked(item)
                          ? `解锁${activeSceneObjectLabel}`
                          : `锁定${activeSceneObjectLabel}`
                      "
                      @click.stop="updateMeshPickup(item.raw)"
                    >
                      <el-icon :size="14"
                        ><Lock v-if="isModelLocked(item)" /><Unlock v-else
                      /></el-icon>
                    </button>
                    <button
                      type="button"
                      class="scene-edit-structure-action-button is-danger"
                      :disabled="isModelLocked(item)"
                      :title="
                        isModelLocked(item) ? '锁定状态不可删除' : `删除${activeSceneObjectLabel}及其子节点`
                      "
                      @click.stop="deleteMesh(item.raw)"
                    >
                      <el-icon :size="14"><Delete /></el-icon>
                    </button>
                  </div>
                </div>
              </template>
            </draggable>

            <draggable
              item-key="id"
              class="scene-edit-structure-group-list"
              :model-value="activeVisibleSceneObjectGroups"
              :disabled="Boolean(searchKeyword)"
              :move="canMoveModelLayer"
              handle=".scene-edit-structure-item--group"
              ghost-class="scene-edit-structure-ghost"
              @change="handleModelLayerDragChange"
            >
              <template #item="{ element }">
                <div class="scene-edit-structure-layer-row">
                  <div>
                    <div
                      class="scene-edit-structure-item scene-edit-structure-item--group"
                      :class="{ 'is-active': selectedModelGroupId === element.id }"
                      data-structure-item="true"
                      @click.stop="selectModelGroup(element.id)"
                    >
                      <div class="scene-edit-structure-item__main">
                        <button
                          type="button"
                          class="scene-edit-structure-expand"
                          :class="{
                            'is-expanded': isGroupExpanded(element.id) || Boolean(searchKeyword),
                          }"
                          aria-label="切换分组展开状态"
                          @click.stop="toggleGroupExpanded(element.id)"
                        >
                          <span class="scene-edit-collapse-icon" aria-hidden="true" />
                        </button>
                        <span class="scene-edit-structure-item__name">{{ element.name }}</span>
                        <span class="scene-edit-structure-group-count">{{
                          element.items.length
                        }}</span>
                      </div>
                      <div class="flex gap-2 scene-edit-structure-actions">
                        <button
                          type="button"
                          class="scene-edit-structure-action-button"
                          :title="element.visible ? '隐藏分组' : '显示分组'"
                          @click.stop="toggleModelLayerVisible(element)"
                        >
                          <el-icon :size="14"
                            ><View v-if="element.visible" /><Hide v-else
                          /></el-icon>
                        </button>
                        <button
                          type="button"
                          class="scene-edit-structure-action-button"
                          :title="element.locked ? '解锁分组' : '锁定分组'"
                          @click.stop="toggleModelLayerLocked(element)"
                        >
                          <el-icon :size="14"
                            ><Lock v-if="element.locked" /><Unlock v-else
                          /></el-icon>
                        </button>
                        <button
                          type="button"
                          class="scene-edit-structure-action-button is-danger"
                          :disabled="isActiveSceneObjectGroupDeleteDisabled(element)"
                          :title="
                            isActiveSceneObjectGroupDeleteDisabled(element)
                              ? `组内存在锁定${activeSceneObjectLabel}，不可删除`
                              : '删除分组'
                          "
                          @click.stop="deleteModelGroup(element)"
                        >
                          <el-icon :size="14"><Delete /></el-icon>
                        </button>
                      </div>
                    </div>

                    <draggable
                      v-if="isGroupExpanded(element.id) || Boolean(searchKeyword)"
                      item-key="id"
                      :model-value="element.items"
                      :disabled="Boolean(searchKeyword) || element.locked"
                      :group="modelLayerDragGroup"
                      :move="canMoveModel"
                      ghost-class="scene-edit-structure-ghost"
                      class="scene-edit-structure-group-node__child"
                      @change="handleModelGroupDragChange(element.id, $event)"
                    >
                      <template #item="{ element: item }">
                        <div
                          data-structure-item="true"
                          :class="['scene-edit-structure-item', { 'is-active': item.isActive }]"
                          @click.stop="selectItem(item, $event)"
                          @dblclick.stop="focusItem(item)"
                        >
                          <div class="scene-edit-structure-item__name">
                            {{ item.name }}
                    <small v-if="getHierarchyParentName(item.id)" class="opacity-70"> · {{ getHierarchyParentName(item.id) }}</small>
                          </div>
                          <div class="flex gap-2 scene-edit-structure-actions">
                            <button
                              type="button"
                              class="scene-edit-structure-action-button"
                              :title="
                                item.raw.visible
                                  ? `隐藏${activeSceneObjectLabel}`
                                  : `显示${activeSceneObjectLabel}`
                              "
                              @click.stop="updateMeshVisible(item.raw)"
                            >
                              <el-icon :size="14"
                                ><View v-if="item.raw.visible" /><Hide v-else
                              /></el-icon>
                            </button>
                            <button
                              type="button"
                              class="scene-edit-structure-action-button"
                              :disabled="element.locked"
                              :title="
                                element.locked
                                  ? '请先解锁所属分组'
                                  : isModelLocked(item)
                                    ? `解锁${activeSceneObjectLabel}`
                                    : `锁定${activeSceneObjectLabel}`
                              "
                              @click.stop="updateMeshPickup(item.raw)"
                            >
                              <el-icon :size="14"
                                ><Lock v-if="element.locked || isModelLocked(item)" /><Unlock
                                  v-else
                              /></el-icon>
                            </button>
                            <button
                              type="button"
                              class="scene-edit-structure-action-button is-danger"
                              :disabled="element.locked || isModelLocked(item)"
                              :title="
                                element.locked || isModelLocked(item)
                                  ? '锁定状态不可删除'
                                  : `删除${activeSceneObjectLabel}及其子节点`
                              "
                              @click.stop="deleteMesh(item.raw)"
                            >
                              <el-icon :size="14"><Delete /></el-icon>
                            </button>
                          </div>
                        </div>
                      </template>
                    </draggable>

                    <div
                      v-if="
                        (isGroupExpanded(element.id) || Boolean(searchKeyword)) &&
                        element.items.length === 0
                      "
                      class="scene-edit-structure-empty scene-edit-structure-empty--group"
                    >
                      可将{{ activeSceneObjectLabel }}拖入此分组
                    </div>
                  </div>
                </div>
              </template>
            </draggable>
            <!-- 三维组件（包含体积热力场）统一来自 SceneStore.objects，避免同一对象被重复渲染。 -->
            <div
              v-if="
                activeSceneObjectRootItems.length === 0 &&
                activeVisibleSceneObjectGroups.length === 0
              "
              class="scene-edit-structure-empty"
            >
              暂无内容
            </div>
          </div>

          <div v-else class="scene-edit-structure-group">
            <template v-if="searchKeyword">
              <div v-if="filteredWidgetLayerNodes.length === 0" class="scene-edit-structure-empty">
                暂无内容
              </div>
              <template v-else>
                <template v-for="node in filteredWidgetLayerNodes" :key="node.id">
                  <WidgetGroupItem
                    v-if="node.type === 'group'"
                    :group-node="node"
                    :expanded="true"
                    :selected-group-id="sceneWidgetStore.currentWidgetGroupId || undefined"
                    :selected-group-ids="sceneWidgetStore.currentWidgetGroupIds || []"
                    :selected-widget-ids="selectedStructureWidgetIds"
                    :selected-child-id="sceneWidgetStore.currentWidgetChildSelection?.childId || ''"
                    :widget-map="widgetEntryMap"
                    :children-map="widgetChildrenMap"
                    :group-map="widgetGroupMap"
                    :expanded-group-ids="expandedGroupIds"
                    :group-delete-disabled-ids="widgetGroupDeleteDisabledIds"
                    :drag-disabled="true"
                    :group-visible="sceneWidgetStore.getGroupVisible(node.id)"
                    :group-locked="sceneWidgetStore.isWidgetGroupLocked(node.id)"
                    :delete-disabled="isWidgetGroupDeleteDisabled(node)"
                    :drop-target-widget-id="widgetHierarchyDropTargetId"
                    :drop-target-group-id="widgetGroupDropTargetId"
                    :sort-gap-target="widgetSortGapTarget"
                    :widget-move-guard="canMoveWidget"
                    @toggle-expand="toggleGroupExpanded"
                    @select-group="selectGroup"
                    @select-widget="selectWidgetFromNode"
                    @select-widget-child="selectWidgetChildFromNode"
                    @toggle-widget-child-visible="toggleWidgetChildVisible"
                    @toggle-widget-child-lock="toggleWidgetChildLocked"
                    @toggle-widget-visible="updateWidgetVisible"
                    @toggle-widget-lock="toggleWidgetLocked"
                    @delete-widget="deleteWidget"
                    @open-menu="openContextMenu"
                    @toggle-group-visible="toggleGroupVisible"
                    @toggle-group-lock="toggleWidgetGroupLocked"
                    @delete-group="deleteWidgetGroup"
                    @widget-drag-start="handleWidgetDragStart"
                    @widget-drag-end="handleWidgetDragEnd"
                    @move-widgets-under-parent="moveDraggedWidgetsUnderParent"
                  />
                  <WidgetLeafItem
                    v-else
                    :widget-node="node"
                    :widget-entry="widgetEntryMap.get(node.id) || null"
                    :selected-widget-ids="selectedStructureWidgetIds"
                    :selected-child-id="sceneWidgetStore.currentWidgetChildSelection?.childId || ''"
                    :locked="sceneWidgetStore.isWidgetLocked(node.id)"
                    :widget-map="widgetEntryMap"
                    :children-map="widgetChildrenMap"
                    :drag-disabled="true"
                    :drop-target-widget-id="widgetHierarchyDropTargetId"
                    :sort-gap-target="widgetSortGapTarget"
                    @select-widget="selectWidgetFromNode"
                    @select-widget-child="selectWidgetChildFromNode"
                    @toggle-widget-child-visible="toggleWidgetChildVisible"
                    @toggle-widget-child-lock="toggleWidgetChildLocked"
                    @toggle-visible="updateWidgetVisible"
                    @toggle-lock="toggleWidgetLocked"
                    @delete-widget="deleteWidget"
                    @open-menu="openContextMenu"
                    @widget-drag-start="handleWidgetDragStart"
                    @widget-drag-end="handleWidgetDragEnd"
                    @move-widgets-under-parent="moveDraggedWidgetsUnderParent"
                  />
                </template>
              </template>
            </template>

            <draggable
              v-else
              item-key="id"
              :model-value="visibleWidgetLayerTree"
              :group="widgetLayerDragGroup"
              :move="canMoveWidget"
              :set-data="setWidgetDragData"
              ghost-class="scene-edit-structure-ghost"
              @start="handleWidgetSortableStart"
              @end="handleWidgetDragEnd"
              @change="handleWidgetRootDragChange"
            >
              <template #item="{ element }">
                <div
                  class="scene-edit-structure-layer-row"
                  :class="{
                    'is-widget-sort-gap-before':
                      (element.type === 'widget' &&
                        widgetSortGapTarget?.relatedWidgetId === element.id &&
                        widgetSortGapTarget?.placement === 'before') ||
                      (widgetGroupSortGapTarget?.relatedId === element.id &&
                        widgetGroupSortGapTarget?.placement === 'before'),
                    'is-widget-sort-gap-after':
                      (element.type === 'widget' &&
                        widgetSortGapTarget?.relatedWidgetId === element.id &&
                        widgetSortGapTarget?.placement === 'after') ||
                      (widgetGroupSortGapTarget?.relatedId === element.id &&
                        widgetGroupSortGapTarget?.placement === 'after'),
                  }"
                  :data-widget-id="element.type === 'widget' ? element.id : undefined"
                  :data-structure-layer-id="element.id"
                >
                  <WidgetGroupItem
                    v-if="element.type === 'group'"
                    :group-node="element"
                    :expanded="isGroupExpanded(element.id)"
                    :selected-group-id="sceneWidgetStore.currentWidgetGroupId || undefined"
                    :selected-group-ids="sceneWidgetStore.currentWidgetGroupIds || []"
                    :selected-widget-ids="selectedStructureWidgetIds"
                    :selected-child-id="sceneWidgetStore.currentWidgetChildSelection?.childId || ''"
                    :widget-map="widgetEntryMap"
                    :children-map="widgetChildrenMap"
                    :group-map="widgetGroupMap"
                    :expanded-group-ids="expandedGroupIds"
                    :group-delete-disabled-ids="widgetGroupDeleteDisabledIds"
                    :drag-disabled="false"
                    :group-visible="sceneWidgetStore.getGroupVisible(element.id)"
                    :group-locked="sceneWidgetStore.isWidgetGroupLocked(element.id)"
                    :delete-disabled="isWidgetGroupDeleteDisabled(element)"
                    :drop-target-widget-id="widgetHierarchyDropTargetId"
                    :drop-target-group-id="widgetGroupDropTargetId"
                    :sort-gap-target="widgetSortGapTarget"
                    :widget-move-guard="canMoveWidget"
                    @toggle-expand="toggleGroupExpanded"
                    @select-group="selectGroup"
                    @select-widget="selectWidgetFromNode"
                    @select-widget-child="selectWidgetChildFromNode"
                    @toggle-widget-child-visible="toggleWidgetChildVisible"
                    @toggle-widget-child-lock="toggleWidgetChildLocked"
                    @toggle-widget-visible="updateWidgetVisible"
                    @toggle-widget-lock="toggleWidgetLocked"
                    @delete-widget="deleteWidget"
                    @open-menu="openContextMenu"
                    @toggle-group-visible="toggleGroupVisible"
                    @toggle-group-lock="toggleWidgetGroupLocked"
                    @delete-group="deleteWidgetGroup"
                    @move-widget="moveWidgetToGroup"
                    @widget-drag-start="handleWidgetDragStart"
                    @widget-drag-end="handleWidgetDragEnd"
                    @move-widgets-under-parent="moveDraggedWidgetsUnderParent"
                  />
                  <WidgetLeafItem
                    v-else
                    :widget-node="element"
                    :widget-entry="widgetEntryMap.get(element.id) || null"
                    :selected-widget-ids="selectedStructureWidgetIds"
                    :selected-child-id="sceneWidgetStore.currentWidgetChildSelection?.childId || ''"
                    :locked="sceneWidgetStore.isWidgetLocked(element.id)"
                    :widget-map="widgetEntryMap"
                    :children-map="widgetChildrenMap"
                    :drag-disabled="false"
                    :drop-target-widget-id="widgetHierarchyDropTargetId"
                    :sort-gap-target="widgetSortGapTarget"
                    @select-widget="selectWidgetFromNode"
                    @select-widget-child="selectWidgetChildFromNode"
                    @toggle-widget-child-visible="toggleWidgetChildVisible"
                    @toggle-widget-child-lock="toggleWidgetChildLocked"
                    @toggle-visible="updateWidgetVisible"
                    @toggle-lock="toggleWidgetLocked"
                    @delete-widget="deleteWidget"
                    @open-menu="openContextMenu"
                    @widget-drag-start="handleWidgetDragStart"
                    @widget-drag-end="handleWidgetDragEnd"
                    @move-widgets-under-parent="moveDraggedWidgetsUnderParent"
                  />
                </div>
              </template>
            </draggable>

            <div
              v-if="!searchKeyword && sceneWidgetStore.widgetLayerTree.length === 0"
              class="scene-edit-structure-empty"
            >
              暂无内容
            </div>
          </div>
        </div>
      </el-scrollbar>
    </div>
  </div>
  <teleport to="body">
    <div
      v-if="contextMenu.visible"
      ref="contextMenuRef"
      class="scene-edit-structure-menu"
      :style="{ top: `${contextMenu.y}px`, left: `${contextMenu.x}px` }"
      @pointerdown.stop
    >
      <button
        v-if="contextMenu.canCreateGroup"
        type="button"
        class="scene-edit-structure-menu__item"
        @pointerdown.stop
        @mousedown.stop
        @click.stop="handleCreateGroup"
      >
        <span class="scene-edit-structure-menu__icon">
          <!-- 创建分组菜单的左侧图标改为本地 SVG，确保和用户提供的素材保持一致。 -->
          <img
            class="scene-edit-structure-menu__icon-image"
            :src="createGroupIcon"
            alt="创建分组"
          />
        </span>
        <span class="scene-edit-structure-menu__label">创建分组</span>
      </button>
    </div>
  </teleport>
</template>

<script setup lang="ts">
import { useStructurePanel } from './useStructurePanel'

defineOptions({ name: 'StructurePanel' })

const {
  Search,
  Delete,
  Hide,
  View,
  Lock,
  Unlock,
  draggable,
  WidgetGroupItem,
  WidgetLeafItem,
  createGroupIcon,
  sceneWidgetStore,
  searchValue,
  activeStructureCategory,
  contextMenuRef,
  contextMenu,
  modelLayerDragGroup,
  widgetLayerDragGroup,
  searchKeyword,
  expandedGroupIds,
  rootModelItems,
  visibleModelGroups,
  activeSceneObjectLabel,
  activeSceneObjectRootItems,
  activeVisibleSceneObjectGroups,
  isActiveSceneObjectGroupDeleteDisabled,
  widgetEntryMap,
  widgetGroupMap,
  widgetGroupDeleteDisabledIds,
  selectedStructureWidgetIds,
  visibleWidgetLayerTree,
  widgetChildrenMap,
  widgetHierarchyDropTargetId,
  widgetGroupDropTargetId,
  widgetGroupSortGapTarget,
  widgetSortGapTarget,
  filteredWidgetLayerNodes,
  structureCategoryItems,
  selectStructureCategory,
  isGroupExpanded,
  toggleGroupExpanded,
  hideContextMenu,
  clearSelectionFromBlank,
  selectItem,
  focusItem,
  selectedHierarchyNode,
  selectedHierarchyParent,
  hierarchySelection,
  hierarchyParents,
  getHierarchyParentName,
  editSelectedHierarchy,
  selectWidgetFromNode,
  selectWidgetChildFromNode,
  selectGroup,
  openContextMenu,
  handleCreateGroup,
  createWidgetGroup,
  toggleGroupVisible,
  toggleWidgetLocked,
  toggleWidgetChildVisible,
  toggleWidgetChildLocked,
  toggleWidgetGroupLocked,
  deleteWidgetGroup,
  moveWidgetToGroup,
  handleWidgetDragStart,
  handleWidgetSortableStart,
  handleWidgetDragEnd,
  setWidgetDragData,
  moveDraggedWidgetsUnderParent,
  handleWidgetRootDragChange,
  canMoveWidget,
  isWidgetGroupDeleteDisabled,
  createModelGroup,
  selectedModelGroupId,
  selectModelGroup,
  handleRootModelDragChange,
  handleModelGroupDragChange,
  handleModelLayerDragChange,
  canMoveModel,
  canMoveModelLayer,
  updateMeshVisible,
  toggleModelLayerVisible,
  toggleModelLayerLocked,
  deleteModelGroup,
  isModelLocked,
  updateMeshPickup,
  deleteMesh,
  selectedSceneObjectIds,
  deleteSelectedSceneObjects,
  copyableSelection,
  copySelectedSceneObjects,
  editorSceneOperation,
  deleteWidget,
  updateWidgetVisible,
} = useStructurePanel()
</script>
<style src="./index.scss" lang="scss"></style>
