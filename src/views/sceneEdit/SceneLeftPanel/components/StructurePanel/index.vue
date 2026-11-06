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
          title="创建空业务分组"
          aria-label="创建空业务分组"
          :disabled="!canCreateBusinessGroup"
          @click.stop="createBusinessGroup"
        >
          <img :src="createGroupIcon" alt="" />
        </button>
        <div v-if="hierarchyDrag" class="scene-edit-structure-root-drop"
          :class="{ 'is-drop-active': hierarchyDrop?.key === 'root' && !hierarchyDrop.error }"
          @dragover="previewHierarchyDrop($event, { kind: 'root' })" @dragleave="clearHierarchyDrop"
          @drop="commitHierarchyDrop($event, { kind: 'root' })">
          {{ hierarchyDrop?.error || '拖到此处移回场景根节点，保留原图层' }}
        </div>
      </div>

      <div v-if="activeStructureCategory !== 'widget' && (copyableSelection.length || hierarchyRenameTarget)" class="px-3 pb-2">
        <el-button v-if="hierarchyRenameTarget" size="small" plain
          :disabled="!canEditHierarchyRows || hierarchyRenameTarget.locked" @click="renameHierarchySelection">
          重命名节点
        </el-button>
        <el-button v-if="copyableSelection.length" size="small" plain :disabled="Boolean(editorSceneOperation)" @click="copySelectedSceneObjects">
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

      <el-scrollbar ref="structureScrollbar" class="scene-edit-structure-panel-scroll" @scroll="syncHierarchyScroll">
        <div
          class="scene-edit-structure-panel__body px-3 pb-3"
          :class="{ 'has-hierarchy-window': sceneHierarchyRows !== null }"
          @click="clearSelectionFromBlank"
          @contextmenu.prevent="hideContextMenu"
        >
          <!-- 业务层级使用一个滚动窗口，图层标题和节点共用行坐标。 -->
          <div v-if="sceneHierarchyRows" class="scene-edit-structure-group scene-edit-structure-group--scene-objects"
            title="选择节点以编辑属性，按住 Ctrl 或 Command 多选"
            @dragover="overHierarchyWindow" @dragleave="leaveHierarchyWindow" @dragend="finishHierarchyDrag">
            <div v-if="!sceneHierarchyRows.length" class="scene-edit-structure-empty">
              {{ hierarchySearchKeyword ? '当前分类没有匹配结果' : '暂无内容' }}
            </div>
            <div v-else class="scene-edit-structure-window" :style="{ height: `${hierarchyWindow.height}px` }">
                <div v-for="{ row, index } in windowedHierarchyRows" :key="row.key" class="scene-edit-structure-window-row"
                  :class="getHierarchyDropClass(row.key)"
                  :style="{ height: `${HIERARCHY_ROW_HEIGHT}px`, top: `${index * HIERARCHY_ROW_HEIGHT}px` }">
                  <div v-if="row.kind === 'layer'" data-structure-item="true"
                    :data-scene-layer-id="row.group.id"
                    class="scene-edit-structure-item scene-edit-structure-item--group"
                    :class="{ 'is-active': selectedModelGroupId === row.group.id }"
                    @click.stop="selectModelGroup(row.group.id)">
                    <div class="scene-edit-structure-item__main">
                      <button type="button" class="scene-edit-structure-expand"
                        :class="{ 'is-expanded': isSceneLayerExpanded(row.group.id) || Boolean(hierarchySearchKeyword) }"
                        :aria-expanded="isSceneLayerExpanded(row.group.id) || Boolean(hierarchySearchKeyword)"
                        :disabled="Boolean(hierarchySearchKeyword)"
                        aria-label="切换图层展开状态" @click.stop="toggleSceneLayerExpanded(row.group.id)">
                        <span class="scene-edit-collapse-icon" aria-hidden="true" />
                      </button>
                      <span class="scene-edit-structure-item__name" :class="{ 'is-search-hit': row.searchHit }">{{ row.group.name }}</span>
                      <span class="scene-edit-structure-group-count">{{ row.group.displayCount }}</span>
                    </div>
                    <div class="flex gap-2 scene-edit-structure-actions">
                      <button type="button" class="scene-edit-structure-action-button" :title="row.group.visible ? '隐藏分组' : '显示分组'"
                        :disabled="!canEditHierarchyRows"
                        @click.stop="toggleModelLayerVisible(row.group)">
                        <el-icon :size="14"><View v-if="row.group.visible" /><Hide v-else /></el-icon>
                      </button>
                      <button type="button" class="scene-edit-structure-action-button" :title="row.group.locked ? '解锁分组' : '锁定分组'"
                        :disabled="!canEditHierarchyRows"
                        @click.stop="toggleModelLayerLocked(row.group)">
                        <el-icon :size="14"><Lock v-if="row.group.locked" /><Unlock v-else /></el-icon>
                      </button>
                      <button type="button" class="scene-edit-structure-action-button is-danger"
                        :disabled="!canEditHierarchyRows || isActiveSceneObjectGroupDeleteDisabled(row.group)"
                        :title="isActiveSceneObjectGroupDeleteDisabled(row.group) ? '组内存在锁定节点，不可删除' : '删除分组'"
                        @click.stop="deleteModelGroup(row.group)">
                        <el-icon :size="14"><Delete /></el-icon>
                      </button>
                    </div>
                  </div>
                  <div v-else data-structure-item="true" class="scene-edit-structure-item" :data-scene-object-id="row.item.id"
                    :class="{ 'is-active': row.item.isActive }" @click.stop="selectItem(row.item, $event)"
                    :draggable="row.actions.canDrag && canEditHierarchyRows && !searchKeyword && !hierarchySearchKeyword"
                    @dragstart.stop="startHierarchyDrag($event, row.item.id)"
                    @dragover.stop="previewHierarchyDrop($event, hierarchyNodeDropTarget($event, row.item.id))"
                    @drop.stop="commitHierarchyDrop($event, hierarchyNodeDropTarget($event, row.item.id))"
                    @dblclick.stop="focusItem(row.item)">
                    <div class="scene-edit-structure-item__main"
                      :style="{ paddingInlineStart: `min(${((row.item.depth ?? 0) + row.layerDepth) * 14}px, 35%)` }">
                      <button v-if="row.item.expandable" type="button" class="scene-edit-structure-expand"
                        :class="{ 'is-expanded': row.item.expanded }" :aria-expanded="row.item.expanded"
                        :aria-label="`${row.item.expanded ? '折叠' : '展开'}${row.item.name}`"
                        :disabled="Boolean(hierarchySearchKeyword)" @click.stop="toggleSceneNodeExpanded(row.item.id)"
                        @dblclick.stop>
                        <span class="scene-edit-collapse-icon" aria-hidden="true" />
                      </button>
                      <span v-else class="scene-edit-structure-expand-spacer" aria-hidden="true" />
                      <span class="scene-edit-structure-item__name" :class="{ 'is-search-hit': row.searchHit }">{{ row.item.name }}</span>
                    </div>
                    <div class="flex gap-2 scene-edit-structure-actions" @dblclick.stop>
                      <button type="button" class="scene-edit-structure-action-button"
                        :disabled="Boolean(editorSceneOperation) || row.actions.visibilityDisabled"
                        :title="row.actions.inheritedHidden ? '父级或图层已隐藏，切换节点自身显隐' : row.item.raw.visible ? '隐藏节点' : '显示节点'"
                        @click.stop="updateMeshVisible(row.item.raw)">
                        <el-icon :size="14"><View v-if="row.item.raw.visible" /><Hide v-else /></el-icon>
                      </button>
                      <button type="button" class="scene-edit-structure-action-button"
                        :disabled="Boolean(editorSceneOperation) || row.actions.lockDisabled"
                        :title="row.actions.inheritedLocked ? '节点受父级或所属图层锁定' : row.actions.locked ? '解锁节点' : '锁定节点'"
                        @click.stop="updateMeshPickup(row.item.raw)">
                        <el-icon :size="14"><Lock v-if="row.actions.locked" /><Unlock v-else /></el-icon>
                      </button>
                      <button type="button" class="scene-edit-structure-action-button is-danger"
                        :disabled="Boolean(editorSceneOperation) || row.actions.locked"
                        :title="row.actions.locked ? '锁定状态不可删除' : '删除节点及其子节点'"
                        @click.stop="deleteMesh(row.item.raw)">
                        <el-icon :size="14"><Delete /></el-icon>
                      </button>
                    </div>
                  </div>
                </div>
            </div>
          </div>

          <!-- 无业务层级的场景沿用原图层列表及拖拽。 -->
          <div
            v-else-if="activeStructureCategory !== 'widget'"
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
                  <div class="scene-edit-structure-item__main">
                    <span class="scene-edit-structure-item__name">{{ item.name }}</span>
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
                            'is-expanded': isSceneLayerExpanded(element.id) || Boolean(searchKeyword),
                          }"
                          aria-label="切换分组展开状态"
                          @click.stop="toggleSceneLayerExpanded(element.id)"
                        >
                          <span class="scene-edit-collapse-icon" aria-hidden="true" />
                        </button>
                        <span class="scene-edit-structure-item__name">{{ element.name }}</span>
                        <span class="scene-edit-structure-group-count">{{ element.items.length }}</span>
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
                      v-if="isSceneLayerExpanded(element.id) || Boolean(searchKeyword)"
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
                          <div class="scene-edit-structure-item__main">
                            <span class="scene-edit-structure-item__name">{{ item.name }}</span>
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
                        (isSceneLayerExpanded(element.id) || Boolean(searchKeyword)) &&
                        element.items.length === 0
                      "
                      class="scene-edit-structure-empty scene-edit-structure-empty--group"
                    >
                      {{ element.displayCount !== undefined ? '此图层暂无可见根节点' : `可将${activeSceneObjectLabel}拖入此分组` }}
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
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useResizeObserver } from '@vueuse/core'
import type { ScrollbarInstance } from 'element-plus'
import { getHierarchyRowScrollTop, getHierarchyWindow, HIERARCHY_ROW_HEIGHT } from './sceneHierarchyWindow'
import { getSceneHierarchyDropPlacement, SCENE_HIERARCHY_DRAG_TYPE, type SceneHierarchyDropTarget } from './sceneHierarchyDrag'
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
  hierarchySearchKeyword,
  expandedGroupIds,
  rootModelItems,
  visibleModelGroups,
  activeSceneObjectLabel,
  activeSceneObjectRootItems,
  sceneHierarchyRows,
  hierarchyRenameTarget,
  renameHierarchySelection,
  canEditHierarchyRows,
  selectedHierarchyObjectId,
  revealSceneHierarchyObject,
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
  isSceneLayerExpanded,
  toggleSceneLayerExpanded,
  toggleSceneNodeExpanded,
  toggleGroupExpanded,
  hideContextMenu,
  clearSelectionFromBlank,
  selectItem,
  focusItem,
  selectedHierarchyNode,
  selectedHierarchyParent,
  hierarchySelection,
  hierarchyParents,
  editSelectedHierarchy,
  getHierarchyDragSource,
  getHierarchyDropError,
  dropHierarchyNodes,
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
  canCreateBusinessGroup,
  createBusinessGroup,
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
  getHierarchyNodeActions,
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

const structureScrollbar = ref<ScrollbarInstance>()
const hierarchyScrollTop = ref(0)
const hierarchyViewportHeight = ref(0)
const syncHierarchyScroll = () => {
  const wrap = structureScrollbar.value?.wrapRef
  hierarchyScrollTop.value = wrap?.scrollTop ?? 0
  hierarchyViewportHeight.value = wrap?.clientHeight ?? 0
}
useResizeObserver(() => structureScrollbar.value?.wrapRef, syncHierarchyScroll)
const hierarchyWindow = computed(() => getHierarchyWindow(
  sceneHierarchyRows.value?.length ?? 0, hierarchyScrollTop.value, hierarchyViewportHeight.value,
))
const hierarchyDrag = ref<ReturnType<typeof getHierarchyDragSource>>()
const hierarchyDrop = ref<{ key: string; placement?: 'before' | 'inside' | 'after'; error?: string }>()
const draggedHierarchyIndex = computed(() => {
  const id = hierarchyDrag.value?.id
  return id ? sceneHierarchyRows.value?.findIndex((row) => row.key === `node:${id}`) ?? -1 : -1
})
const windowedHierarchyRows = computed(() => {
  const rows = sceneHierarchyRows.value
  if (!rows) return []
  const { start, end } = hierarchyWindow.value
  const window = rows.slice(start, end).map((row, offset) => ({ row, index: start + offset }))
  // 滚出窗口的源行仍保持同一个 DOM 元素，直到浏览器结束这次拖动。
  const source = draggedHierarchyIndex.value
  if (source >= 0 && source < start) window.unshift({ row: rows[source]!, index: source })
  if (source >= end) window.push({ row: rows[source]!, index: source })
  return window.map(({ row, index }) => ({
    index,
    row: row.kind === 'node' ? { ...row, actions: getHierarchyNodeActions(row.item) } : row,
  }))
})

const clearHierarchyDrop = () => { hierarchyDrop.value = undefined }
let dragScrollFrame = 0
let dragScrollSpeed = 0
const stopHierarchyDragScroll = () => {
  dragScrollSpeed = 0
  if (dragScrollFrame) cancelAnimationFrame(dragScrollFrame)
  dragScrollFrame = 0
}
const scrollHierarchyDragFrame = () => {
  dragScrollFrame = 0
  const wrap = structureScrollbar.value?.wrapRef
  if (!wrap || !hierarchyDrag.value || !dragScrollSpeed) return
  const previous = wrap.scrollTop
  wrap.scrollTop += dragScrollSpeed
  if (wrap.scrollTop !== previous) dragScrollFrame = requestAnimationFrame(scrollHierarchyDragFrame)
}
const updateHierarchyDragScroll = (clientY: number) => {
  const rect = structureScrollbar.value?.wrapRef?.getBoundingClientRect()
  if (!rect || clientY < rect.top || clientY > rect.bottom) {
    stopHierarchyDragScroll()
    return
  }
  // 靠近窗口边缘时逐帧滚动，使一次拖动可以跨越未渲染的列表区域。
  const edge = Math.min(32, rect.height / 3)
  dragScrollSpeed = clientY < rect.top + edge ? -10 : clientY > rect.bottom - edge ? 10 : 0
  if (dragScrollSpeed && !dragScrollFrame) dragScrollFrame = requestAnimationFrame(scrollHierarchyDragFrame)
}
const finishHierarchyDrag = () => {
  stopHierarchyDragScroll()
  hierarchyDrag.value = undefined
  clearHierarchyDrop()
}
const startHierarchyDrag = (event: DragEvent, id: string) => {
  const source = getHierarchyDragSource(id)
  if (!source || !event.dataTransfer) {
    event.preventDefault()
    return
  }
  event.dataTransfer.setData(SCENE_HIERARCHY_DRAG_TYPE, id)
  event.dataTransfer.effectAllowed = 'move'
  hierarchyDrag.value = source
}
const hierarchyNodeDropTarget = (event: DragEvent, id: string): SceneHierarchyDropTarget => ({
  kind: 'node',
  id,
  placement: getSceneHierarchyDropPlacement(event.clientY, (event.currentTarget as HTMLElement).getBoundingClientRect()),
})
const previewHierarchyDrop = (event: DragEvent, target: SceneHierarchyDropTarget) => {
  const source = hierarchyDrag.value
  if (!source || !event.dataTransfer) return
  if (target.kind === 'root') stopHierarchyDragScroll()
  else updateHierarchyDragScroll(event.clientY)
  const key = target.kind === 'root' ? 'root' : `node:${target.id}`
  const placement = target.kind === 'node' ? target.placement : undefined
  if (hierarchyDrop.value?.key !== key || hierarchyDrop.value.placement !== placement) {
    hierarchyDrop.value = { key, placement, error: getHierarchyDropError(source, target) }
  }
  // 浏览器只接受已声明的落点，实际提交仍按最新草稿复核。
  event.preventDefault()
  event.dataTransfer.dropEffect = hierarchyDrop.value?.error ? 'none' : 'move'
}
const overHierarchyWindow = (event: DragEvent) => {
  clearHierarchyDrop()
  if (hierarchyDrag.value) updateHierarchyDragScroll(event.clientY)
}
const leaveHierarchyWindow = (event: DragEvent) => {
  if (event.relatedTarget instanceof Node && (event.currentTarget as HTMLElement).contains(event.relatedTarget)) return
  stopHierarchyDragScroll()
  clearHierarchyDrop()
}
const commitHierarchyDrop = (event: DragEvent, target: SceneHierarchyDropTarget) => {
  const source = hierarchyDrag.value
  if (!source) return
  event.preventDefault()
  finishHierarchyDrag()
  void dropHierarchyNodes(source, target)
}
const getHierarchyDropClass = (key: string) => {
  const drop = hierarchyDrop.value
  if (!drop || drop.key !== key || drop.error) return undefined
  return `is-drop-${drop.placement}`
}
watch([activeStructureCategory, searchKeyword, canEditHierarchyRows], finishHierarchyDrag)
watch(draggedHierarchyIndex, (index) => { if (index < 0) finishHierarchyDrag() })
onBeforeUnmount(finishHierarchyDrag)

const scrollToHierarchyRow = (key: string) => {
  const index = sceneHierarchyRows.value?.findIndex((row) => row.key === key) ?? -1
  if (index < 0) return
  syncHierarchyScroll()
  const top = getHierarchyRowScrollTop(index, hierarchyScrollTop.value, hierarchyViewportHeight.value)
  if (top === hierarchyScrollTop.value) return
  structureScrollbar.value?.setScrollTop(top)
  syncHierarchyScroll()
}

// 祖先行仅供上下文展示，定位当前分类中第一个直接命中的图层或实例。
const firstHierarchySearchHit = computed(() =>
  hierarchySearchKeyword.value ? sceneHierarchyRows.value?.find((row) => row.searchHit)?.key : undefined,
)
watch([hierarchySearchKeyword, firstHierarchySearchHit], ([keyword, hit]) => {
  if (keyword && hit) scrollToHierarchyRow(hit)
}, { flush: 'post' })

// 只有选中目标改变或树形列表首次可用时才定位。滚动和手动折叠不反向修改选择。
watch(selectedHierarchyObjectId, async (id, _, onCleanup) => {
  if (!id || !sceneHierarchyRows.value) return
  let current = true
  onCleanup(() => { current = false })
  revealSceneHierarchyObject(id)
  await nextTick()
  if (!current) return
  scrollToHierarchyRow(`node:${id}`)
}, { flush: 'post', immediate: true })
</script>
<style src="./index.scss" lang="scss"></style>
