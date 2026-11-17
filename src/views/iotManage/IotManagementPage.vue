<template>
  <div class="manage-page manage-theme manage-list-page iot-page">
    <ManagePageTopBar :title="title" :breadcrumb="'物联网管理/' + title">
      <template #actions>
        <el-button v-if="kind !== 'messages' && allowed('create')" type="primary" class="manage-toolbar-button manage-toolbar-button--primary" :disabled="busy" @click="openCreate">新增{{ kind === 'connectors' ? '连接器' : '绑定' }}</el-button>
      </template>
      <ManageFilterBar label="物联网筛选">
        <div class="manage-filter-bar__field">
          <label for="iot-connector-filter">连接器编号</label>
          <el-input id="iot-connector-filter" v-model="filters.connectorId" maxlength="64" clearable @keyup.enter="search" />
        </div>
        <div v-if="kind !== 'connectors'" class="manage-filter-bar__field">
          <label for="iot-device-filter">外部设备编号</label>
          <el-input id="iot-device-filter" v-model="filters.externalDeviceId" maxlength="128" clearable @keyup.enter="search" />
        </div>
        <div v-if="kind === 'connectors'" class="manage-filter-bar__field">
          <label for="iot-protocol-filter">协议类型</label>
          <el-select id="iot-protocol-filter" v-model="filters.connectorType" clearable placeholder="全部协议">
            <el-option v-for="type in ['MQTT', 'HTTPS', 'MOCK']" :key="type" :label="type" :value="type" />
          </el-select>
        </div>
        <div class="manage-filter-bar__field">
          <label for="iot-status-filter">{{ kind === 'messages' ? '处理状态' : '期望启用' }}</label>
          <el-select v-if="kind === 'messages'" id="iot-status-filter" v-model="filters.status" clearable placeholder="全部状态">
            <el-option v-for="status in messageStatuses" :key="status" :label="IOT_STATUS[status]" :value="status" />
          </el-select>
          <el-select v-else id="iot-status-filter" v-model="filters.enabled" clearable placeholder="全部">
            <el-option label="启用" value="true" /><el-option label="停用" value="false" />
          </el-select>
        </div>
        <template #actions>
          <el-button type="primary" class="iot-query-button" :loading="loading" @click="search">查询</el-button>
          <el-button class="iot-reset-button" :disabled="loading" @click="reset">重置</el-button>
        </template>
      </ManageFilterBar>
    </ManagePageTopBar>
    <section class="manage-resource-content-panel iot-content" aria-label="物联网记录">
      <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon>
        <el-button link @click="load">重试</el-button>
      </el-alert>
      <p class="iot-help">{{ hint }}</p>
      <el-table v-loading="loading" :data="rows" row-key="id" height="100%" :empty-text="error ? '加载失败，请重试' : '暂无记录，可调整筛选条件'" class="iot-table">
        <el-table-column prop="connectorId" label="连接器编号" min-width="170" show-overflow-tooltip />
        <template v-if="kind === 'connectors'">
          <el-table-column prop="name" label="名称" min-width="160" show-overflow-tooltip />
          <el-table-column prop="connectorType" label="协议" width="100" />
          <el-table-column label="期望启用" width="110">
            <template #default="{ row }"><el-tag :type="row.enabled ? 'success' : 'info'">{{ row.enabled ? '启用' : '停用' }}</el-tag></template>
          </el-table-column>
          <el-table-column prop="version" label="配置版本" width="100" />
        </template>
        <template v-else>
          <el-table-column prop="externalDeviceId" label="外部设备编号" min-width="170" show-overflow-tooltip />
          <template v-if="kind === 'bindings'">
            <el-table-column prop="deviceId" label="内部设备" min-width="150" show-overflow-tooltip />
            <el-table-column prop="sceneId" label="场景编号" min-width="150" show-overflow-tooltip />
            <el-table-column prop="mappingRevision" label="映射版本" width="120" />
            <el-table-column label="启用" width="90"><template #default="{ row }">{{ row.enabled ? '是' : '否' }}</template></el-table-column>
          </template>
          <template v-else>
            <el-table-column prop="eventId" label="事件编号" min-width="210" show-overflow-tooltip />
            <el-table-column prop="pointCode" label="点位编码" min-width="140" show-overflow-tooltip />
            <el-table-column label="状态" width="120"><template #default="{ row }"><el-tag :type="['FAILED', 'DEAD_LETTER'].includes(row.status) ? 'danger' : 'info'">{{ IOT_STATUS[row.status] ?? '状态未知' }}</el-tag></template></el-table-column>
            <el-table-column prop="retryCount" label="重试次数" width="100" />
            <el-table-column label="接收时间" width="180"><template #default="{ row }">{{ formatIotTime(row.receivedAt) }}</template></el-table-column>
          </template>
        </template>
        <IotActionColumn label="操作" :width="kind === 'messages' ? 160 : 200" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" :disabled="busy" @click="openDetail(row)">详情</el-button>
            <template v-if="kind !== 'messages'">
              <el-button v-if="allowed('update')" link type="primary" :disabled="busy" @click="openDetail(row, true)">编辑</el-button>
              <!-- 低频及危险操作收纳，继续调用原有权限、确认和在途互斥处理器。 -->
              <el-dropdown v-if="(kind === 'connectors' && allowed('update')) || allowed('delete')" trigger="click" :disabled="busy" placement="bottom-end" popper-class="manage-dropdown-popper manage-card-menu-popper iot-row-menu">
                <el-button link :disabled="busy" :aria-label="'更多操作：' + (row.name || row.externalDeviceId || row.connectorId)">更多<el-icon aria-hidden="true"><ArrowDown /></el-icon></el-button>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item v-if="kind === 'connectors' && allowed('update')" :disabled="busy" @click="toggle(row)">{{ row.enabled ? '停用' : '启用' }}</el-dropdown-item>
                    <el-dropdown-item v-if="allowed('delete')" :disabled="busy" :divided="kind === 'connectors' && allowed('update')" class="manage-card-menu-popper__danger" @click="remove(row)">删除</el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
            </template>
            <el-button v-else-if="allowed('replay') && ['FAILED', 'DEAD_LETTER'].includes(row.status ?? '')" link type="primary" :disabled="busy" @click="replay(row)">重放</el-button>
          </template>
        </IotActionColumn>
      </el-table>
      <ManagePaginationBar :total="total" :current-page="pageNo" :page-size="pageSize" @update:current-page="changePage" @update:page-size="changeSize" />
    </section>

    <el-drawer v-model="drawer" :title="drawerTitle" size="min(620px, 100vw)" append-to-body class="manage-dialog iot-drawer" :close-on-click-modal="false" :before-close="beforeClose">
      <div v-loading="detailLoading">
        <el-alert v-if="formError" :title="formError" type="error" :closable="false" show-icon />
        <div v-if="conflict" class="iot-conflict">
          <p>本次输入已保留。请先复制需要保留的内容，再读取最新配置进行核对。</p>
          <el-button :disabled="busy" @click="reloadDetail">读取最新配置</el-button>
        </div>
        <template v-if="mode === 'detail'">
          <el-descriptions :column="1" border>
            <el-descriptions-item v-for="field in detailFields" :key="field.key" :label="field.label">{{ displayField(field.key) }}</el-descriptions-item>
          </el-descriptions>
          <template v-if="kind === 'connectors' && selected?.id">
            <div class="iot-section-heading"><h3>运行观测</h3><el-button :loading="runtimeLoading" @click="refreshRuntime">刷新状态</el-button></div>
            <el-alert v-if="runtimeError" :title="runtimeError" type="warning" :closable="false" />
            <el-descriptions v-if="runtime" :column="1" border>
              <el-descriptions-item label="观测状态">{{ IOT_STATUS[runtime.effectiveStatus] ?? '状态未知' }}</el-descriptions-item>
              <el-descriptions-item label="数据库租约">{{ runtime.leaseActive ? '有效' : '无有效租约' }}</el-descriptions-item>
              <el-descriptions-item label="观测时间">{{ formatIotTime(runtime.observedAt) }}</el-descriptions-item>
              <el-descriptions-item label="租约截止">{{ formatIotTime(runtime.runtimeLeaseUntil) }}</el-descriptions-item>
            </el-descriptions>
            <p class="iot-help">配置启用和运行状态分别展示；租约不代表设备、消息系统或三维链路健康。</p>
            <el-button v-if="selected.connectorType === 'MQTT' && allowed('update')" :loading="testing" :disabled="busy && !testing" @click="testConnection">测试已保存连接</el-button>
            <el-alert v-if="testResult" :title="testResult" :type="testSucceeded ? 'success' : 'warning'" :closable="false" show-icon />
          </template>
          <template v-if="kind === 'messages'">
            <el-alert v-if="['FAILED', 'DEAD_LETTER'].includes(selected?.status ?? '')" title="消息投递失败；详细原因请由有权限的运维人员核查，不展示原始报文。" type="warning" :closable="false" />
            <p class="iot-help">重放提交成功只代表已发起，最终结果请刷新列表确认。</p>
          </template>
        </template>
        <el-form v-else label-position="top" class="iot-form" :disabled="saving || validating" @submit.prevent="save">
          <el-form-item label="连接器编号" required><el-input v-model="form.connectorId" maxlength="64" :disabled="!!form.id && kind === 'connectors'" /></el-form-item>
          <template v-if="kind === 'connectors'">
            <el-form-item label="名称" required><el-input v-model="form.name" maxlength="128" /></el-form-item>
            <el-form-item label="协议类型" required><el-select v-model="form.connectorType"><el-option v-for="type in ['MQTT', 'HTTPS', 'MOCK']" :key="type" :label="type" :value="type" /></el-select></el-form-item>
            <el-form-item label="服务地址"><el-input v-model="form.endpoint" maxlength="512" placeholder="MQTT使用ssl://主机:端口" /></el-form-item>
            <el-form-item label="凭据引用"><el-input v-model="form.credentialRef" maxlength="128" placeholder="填写已部署的凭据引用，禁止输入密码" /></el-form-item>
            <el-form-item label="协议配置（JSON）"><el-input v-model="form.configJson" type="textarea" :rows="7" maxlength="65536" placeholder='MQTT格式：{"topics":["确切主题"],"qos":1}' /></el-form-item>
            <p class="iot-help">保存后默认停用，启用请使用列表操作。结构校验不会连接服务；连接测试仅使用已保存配置。</p>
            <el-button v-if="form.connectorType === 'MQTT'" :loading="validating" :disabled="busy && !validating" @click="validateMqtt">校验MQTT结构</el-button>
            <el-alert v-if="validationResult" :title="validationResult" type="success" :closable="false" />
          </template>
          <template v-else>
            <el-form-item label="外部设备编号" required><el-input v-model="form.externalDeviceId" maxlength="128" /></el-form-item>
            <el-form-item label="内部设备编号"><el-input v-model="form.deviceId" maxlength="128" /></el-form-item>
            <el-form-item label="场景编号"><el-input v-model="form.sceneId" maxlength="128" /></el-form-item>
            <el-form-item label="对象编号"><el-input v-model="form.objectId" maxlength="128" /></el-form-item>
            <el-form-item label="映射版本" required><el-input v-model="form.mappingRevision" maxlength="64" /></el-form-item>
            <el-form-item label="点位映射（JSON）"><el-input v-model="form.pointMappingJson" type="textarea" :rows="9" maxlength="65536" placeholder='{"points":{"原点位":{"pointCode":"标准点位","valueType":"NUMBER","scale":1,"offset":0}}}' /></el-form-item>
            <el-form-item label="启用"><el-switch v-model="form.enabled" /></el-form-item>
            <p class="iot-help">换算规则为原值 × scale + offset。当前绑定采用最后保存生效，编辑期间请避免多人同时修改。</p>
          </template>
        </el-form>
      </div>
      <template #footer>
        <el-button :disabled="saving || acting || testing || validating" @click="closeDrawer">关闭</el-button>
        <el-button v-if="mode !== 'detail' && kind !== 'messages'" type="primary" :loading="saving" :disabled="detailLoading || conflict || (busy && !saving)" @click="save">保存</el-button>
      </template>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox, ElTableColumn } from 'element-plus'
import { ArrowDown } from '@element-plus/icons-vue'
import { onBeforeRouteLeave } from 'vue-router'
import ManagePageTopBar from '@/views/manageShared/ManagePageTopBar.vue'
import ManageFilterBar from '@/views/manageShared/ManageFilterBar.vue'
import ManagePaginationBar from '@/views/manageShared/ManagePaginationBar.vue'
import { hasIotPermission } from '@/auth/iotNavigation'
import { IOT_RESOURCES, IOT_VERSION_CONFLICT, IotApiError, getIotPage, getIotDetail, saveIot, deleteIot,
  toggleIotConnector, getIotRuntime, validateIotMqtt, testIotMqtt, replayIot } from '@/servers/manual/iot/api'
import type { IotKind, IotRow, IotRuntime, IotPageQuery } from '@/servers/manual/iot/api'
import { validateIotForm, formatIotTime, IOT_STATUS } from './form'

// 在列组件上明确业务泛型，保证操作槽保留接口编号字段的类型，而非强制转换默认行。
const IotActionColumn = ElTableColumn<IotRow>

const props = defineProps<{ kind: IotKind }>()
const title = computed(() => ({ connectors: '连接器管理', bindings: '设备绑定', messages: '接收记录' })[props.kind])
const hint = computed(() => ({
  connectors: '统一管理连接配置。列表展示期望启用状态，实际运行情况请打开详情查看。',
  bindings: '将外部设备关联到内部设备、场景与对象，并维护点位映射。',
  messages: '查看接收与投递状态。失败记录可人工重放，最终结果以刷新后的状态为准。',
})[props.kind])
const allowed = (action: string) => hasIotPermission(`iot:${IOT_RESOURCES[props.kind]}:${action}`)
const filters = reactive({ connectorId: '', externalDeviceId: '', connectorType: '', enabled: '', status: '' })
let applied: Partial<IotPageQuery> = {}
const rows = ref<IotRow[]>([])
const pageNo = ref(1), pageSize = ref(10), total = ref(0), loading = ref(false), error = ref('')
const drawer = ref(false), mode = ref<'detail' | 'edit' | 'create'>('detail')
const selected = ref<IotRow>(), form = ref<Partial<IotRow>>({}), formError = ref(''), conflict = ref(false)
const detailLoading = ref(false), saving = ref(false), acting = ref(false), testing = ref(false), validating = ref(false)
const runtime = ref<IotRuntime>(), runtimeLoading = ref(false), runtimeError = ref('')
const testResult = ref(''), testSucceeded = ref(false), validationResult = ref('')
const busy = computed(() => saving.value || acting.value || testing.value || validating.value || detailLoading.value)
const drawerTitle = computed(() => `${mode.value === 'create' ? '新增' : mode.value === 'edit' ? '编辑' : '查看'}${title.value}`)
const messageStatuses = ['CLAIMED', 'PUBLISHED', 'FAILED', 'DEAD_LETTER', 'ARCHIVED']
let originalForm = ''
const dirty = computed(() => mode.value !== 'detail' && JSON.stringify(form.value) !== originalForm)
// 请求序号同时限制筛选乱序、抽屉快速切换与卸载后的回写；无需额外轮询器。
let listVersion = 0, detailVersion = 0, runtimeVersion = 0, alive = true
const message = (failure: unknown) => failure instanceof IotApiError ? failure.message :
  failure instanceof Error && /配置版本|格式|填写|JSON|scale|points|点位|映射|当前账号|编号|协议|MQTT|租户|身份已变化/.test(failure.message)
    ? failure.message : '请求未完成，请检查网络、权限和物联网服务后重试'

async function load() {
  const version = ++listVersion
  error.value = ''
  loading.value = true
  try {
    const page = await getIotPage(props.kind, { ...applied, pageNo: pageNo.value, pageSize: pageSize.value })
    if (!alive || version !== listVersion) return
    rows.value = page.list; total.value = page.total
    if (!rows.value.length && total.value > 0 && pageNo.value > Math.ceil(total.value / pageSize.value)) {
      pageNo.value = Math.max(1, Math.ceil(total.value / pageSize.value))
      void load()
    }
  } catch (failure) {
    if (alive && version === listVersion) { rows.value = []; total.value = 0; error.value = message(failure) }
  } finally { if (alive && version === listVersion) loading.value = false }
}
function search() {
  applied = {
    ...(filters.connectorId.trim() ? { connectorId: filters.connectorId.trim() } : {}),
    ...(props.kind === 'connectors' && filters.connectorType ? { connectorType: filters.connectorType } : {}),
    ...(props.kind !== 'connectors' && filters.externalDeviceId.trim() ? { externalDeviceId: filters.externalDeviceId.trim() } : {}),
    ...(props.kind === 'messages' ? (filters.status ? { status: filters.status } : {}) :
      (filters.enabled ? { enabled: filters.enabled === 'true' } : {})),
  }
  pageNo.value = 1; void load()
}
function reset() { Object.assign(filters, { connectorId: '', externalDeviceId: '', connectorType: '', enabled: '', status: '' }); search() }
function changePage(value: number) { pageNo.value = value; void load() }
function changeSize(value: number) { pageSize.value = value; pageNo.value = 1; void load() }
function clearDetailState() {
  formError.value = ''; conflict.value = false; runtime.value = undefined; runtimeError.value = ''
  testResult.value = ''; validationResult.value = ''; ++runtimeVersion; runtimeLoading.value = false
}
function openCreate() {
  if (busy.value || !allowed('create') || props.kind === 'messages') return
  ++detailVersion; clearDetailState(); selected.value = undefined
  form.value = { connectorId: '', ...(props.kind === 'connectors'
    ? { name: '', connectorType: 'MQTT', endpoint: '', credentialRef: '', configJson: '' }
    : { externalDeviceId: '', mappingRevision: '', pointMappingJson: '', enabled: true }) }
  mode.value = 'create'; drawer.value = true
  originalForm = JSON.stringify(form.value)
}
async function openDetail(row: IotRow, edit = false) {
  if (busy.value || !allowed(edit ? 'update' : 'query')) return
  const version = ++detailVersion
  clearDetailState(); selected.value = undefined; form.value = {}
  mode.value = edit ? 'edit' : 'detail'; drawer.value = true; detailLoading.value = true
  try {
    const detail = props.kind === 'messages' ? row : await getIotDetail(props.kind, row.id)
    if (!alive || version !== detailVersion || !drawer.value) return
    selected.value = detail; form.value = { ...detail }
    originalForm = JSON.stringify(form.value)
    if (props.kind === 'connectors' && !edit) void refreshRuntime()
  } catch (failure) { if (alive && version === detailVersion) formError.value = message(failure) }
  finally { if (alive && version === detailVersion) detailLoading.value = false }
}
async function reloadDetail() {
  if (!selected.value || busy.value) return
  try { await ElMessageBox.confirm('读取最新配置将替换当前输入，是否继续？', '重新读取配置', { type: 'warning' }) }
  catch { return }
  await openDetail(selected.value, true)
}
async function refreshRuntime() {
  if (!selected.value?.id || props.kind !== 'connectors') return
  const version = ++runtimeVersion
  const id = selected.value.id
  runtimeLoading.value = true; runtimeError.value = ''; runtime.value = undefined
  try {
    const value = await getIotRuntime(id)
    if (alive && version === runtimeVersion && selected.value?.id === id && drawer.value) runtime.value = value
  } catch { if (alive && version === runtimeVersion) runtimeError.value = '无法读取运行观测，当前状态不能确认，请重试' }
  finally { if (alive && version === runtimeVersion) runtimeLoading.value = false }
}
async function save() {
  if (busy.value || conflict.value || mode.value === 'detail' || props.kind === 'messages' || !allowed(form.value.id ? 'update' : 'create')) return
  formError.value = validateIotForm(props.kind, form.value)
  if (formError.value) return
  saving.value = true
  try {
    await saveIot(props.kind, form.value)
    if (!alive) return
    ElMessage.success('保存成功'); drawer.value = false; ++detailVersion; void load()
  } catch (failure) {
    if (alive) { formError.value = message(failure); conflict.value = failure instanceof IotApiError && failure.code === IOT_VERSION_CONFLICT }
  } finally { saving.value = false }
}
async function validateMqtt() {
  if (busy.value || props.kind !== 'connectors' || !allowed(form.value.id ? 'update' : 'create')) return
  formError.value = validateIotForm('connectors', form.value)
  if (formError.value) return
  validating.value = true; validationResult.value = ''
  try { await validateIotMqtt(form.value); if (alive) validationResult.value = '配置结构校验通过；凭据、网络和订阅权限仍需连接测试' }
  catch (failure) { if (alive) formError.value = message(failure) }
  finally { validating.value = false }
}
async function testConnection() {
  if (busy.value || !selected.value?.id || !allowed('update')) return
  testing.value = true; testResult.value = ''
  try {
    const result = await testIotMqtt(selected.value.id)
    if (!alive) return
    testSucceeded.value = result.outcome === 'SUCCEEDED'
    const outcomes: Record<string, string> = { SUCCEEDED: '连接与订阅测试通过', CREDENTIALS_UNAVAILABLE: '凭据引用未就绪',
      UNSUPPORTED_PROTOCOL: '该协议不支持连接测试', CONFIG_INVALID: '配置无效', CONNECT_FAILED: '连接失败',
      SUBSCRIBE_FAILED: '订阅失败，请核对主题授权', TIMEOUT: '连接测试超时' }
    testResult.value = (outcomes[result.outcome] ?? '连接测试未通过') + '；本次测试不改变正式运行状态'
  } catch (failure) { if (alive) { testSucceeded.value = false; testResult.value = message(failure) } }
  finally { testing.value = false }
}
async function remove(row: IotRow) {
  if (busy.value || props.kind === 'messages' || !allowed('delete')) return
  // 确认弹窗也计入在途操作，避免连续点击打开多个写入流程。
  acting.value = true
  try { await ElMessageBox.confirm('确定删除该记录？删除后将从管理列表移除。', '删除确认', { type: 'warning', customClass: 'manage-message-box' }) } catch { acting.value = false; return }
  try { await deleteIot(props.kind, row.id); if (alive) { ElMessage.success('删除成功'); void load() } }
  catch (failure) { if (alive) error.value = message(failure) }
  finally { acting.value = false }
}
async function toggle(row: IotRow) {
  if (busy.value || props.kind !== 'connectors' || !allowed('update')) return
  acting.value = true
  try { await ElMessageBox.confirm(row.enabled ? '确认停用该连接器？' : '确认启用已保存的配置？实际运行以详情观测为准。', '启停确认', { type: 'warning', customClass: 'manage-message-box' }) } catch { acting.value = false; return }
  try { await toggleIotConnector(row.id, !row.enabled); if (alive) { ElMessage.success('期望状态已更新'); void load() } }
  catch (failure) { if (alive) error.value = message(failure) }
  finally { acting.value = false }
}
async function replay(row: IotRow) {
  if (busy.value || !allowed('replay') || !['FAILED', 'DEAD_LETTER'].includes(row.status ?? '') || !row.eventId) return
  acting.value = true
  try { await ElMessageBox.confirm('确认重放该事件？提交后请刷新记录核对最终投递状态。', '重放确认', { type: 'warning', customClass: 'manage-message-box' }) } catch { acting.value = false; return }
  try { await replayIot(row.eventId); if (alive) { ElMessage.success('重放请求已提交，请刷新确认结果'); void load() } }
  catch (failure) { if (alive) error.value = message(failure) }
  finally { acting.value = false }
}
async function allowLeave(): Promise<boolean> {
  if (saving.value || acting.value || testing.value || validating.value) return false
  if (!drawer.value || !dirty.value || detailLoading.value) return true
  try {
    await ElMessageBox.confirm('关闭后将放弃当前未保存输入，是否继续？', '未保存修改', {
      type: 'warning', customClass: 'manage-message-box', confirmButtonText: '放弃修改', cancelButtonText: '继续编辑',
      closeOnClickModal: false,
    })
    return true
  } catch { return false }
}
// 详情慢请求允许关闭，序号作废后不回写；抽屉关闭和路由离开使用相同的草稿保护。
async function closeDrawer() { if (await allowLeave()) { drawer.value = false; detailLoading.value = false; ++detailVersion; ++runtimeVersion } }
async function beforeClose(done: () => void) { if (await allowLeave()) { detailLoading.value = false; ++detailVersion; ++runtimeVersion; done() } }
onBeforeRouteLeave(allowLeave)
const detailFields = computed(() => [
  { key: 'id', label: '记录编号' }, { key: 'connectorId', label: '连接器编号' },
  ...(props.kind === 'connectors'
    ? [{ key: 'name', label: '名称' }, { key: 'connectorType', label: '协议' }, { key: 'enabled', label: '期望启用' },
      { key: 'version', label: '配置版本' }, { key: 'endpoint', label: '服务地址' }, { key: 'credentialRef', label: '凭据引用' }, { key: 'configJson', label: '协议配置' }]
    : props.kind === 'bindings'
      ? [{ key: 'externalDeviceId', label: '外部设备' }, { key: 'deviceId', label: '内部设备' }, { key: 'sceneId', label: '场景编号' },
        { key: 'objectId', label: '对象编号' }, { key: 'mappingRevision', label: '映射版本' }, { key: 'enabled', label: '启用' }, { key: 'pointMappingJson', label: '点位映射' }]
      : [{ key: 'eventId', label: '事件编号' }, { key: 'externalDeviceId', label: '外部设备' }, { key: 'pointCode', label: '点位编码' },
        { key: 'status', label: '状态' }, { key: 'retryCount', label: '重试次数' }, { key: 'receivedAt', label: '接收时间' }]),
  { key: 'createTime', label: '创建时间' }, { key: 'updateTime', label: '更新时间' },
])
function displayField(key: string) {
  const value = selected.value?.[key as keyof IotRow]
  if (['createTime', 'updateTime', 'receivedAt'].includes(key)) return formatIotTime(value as string | number | undefined)
  if (key === 'enabled') return value ? '启用' : '停用'
  if (key === 'status') return IOT_STATUS[String(value)] ?? '状态未知'
  return value === undefined || value === null || value === '' ? '—' : String(value)
}
watch(() => form.value, () => { validationResult.value = '' }, { deep: true })
onMounted(() => void load())
onBeforeUnmount(() => { alive = false; ++listVersion; ++detailVersion; ++runtimeVersion })
</script>

<style scoped lang="scss">
/* 表格本身定义同名变量，直接作用于根节点，避免暗色回退成组件默认白色分隔线。 */
.iot-table { flex: 1; min-height: 180px; --el-table-bg-color: var(--manage-color-panel); --el-table-tr-bg-color: transparent; --el-table-header-bg-color: var(--manage-color-panel-deep); --el-table-row-hover-bg-color: var(--manage-color-panel-alt); --el-table-text-color: var(--manage-color-text-primary); --el-table-header-text-color: var(--manage-color-text-secondary); --el-table-border-color: var(--manage-color-line); }
.iot-help { color: var(--manage-color-text-secondary); font-size: 13px; line-height: 1.7; margin: 0; }
.iot-section-heading { display: flex; justify-content: space-between; align-items: center; margin: 24px 0 12px; }
.iot-section-heading h3 { margin: 0; font-size: 16px; }
.iot-conflict { padding: 12px 0; line-height: 1.6; }
.iot-form { margin-top: 16px; }
.iot-form .el-select { width: 100%; }
.iot-page :deep(.manage-filter-bar__field) { min-width: 160px; }
.iot-content :deep(.manage-pagination-bar) { flex-shrink: 0; }
.iot-page :deep(.iot-table .el-button.is-link) { min-width: 0; height: auto; padding: 4px; color: var(--manage-color-action); background: transparent; border: 0; box-shadow: none; border-radius: 3px; }
.iot-page :deep(.iot-table .el-button.is-link.el-button--danger) { color: #d65b5b; }
.iot-page :deep(.iot-table .el-button.is-link + .el-button.is-link) { margin-left: 6px; }
.iot-page :deep(.iot-table .el-dropdown) { margin-left: 6px; }
.iot-page :deep(.iot-table .el-button.is-link .el-icon) { margin-left: 4px; font-size: 12px; }
html[data-manage-theme='dark'] .iot-page :deep(.el-tag--info) { --el-tag-text-color: #c2cfcb; --el-tag-bg-color: #293b48; --el-tag-border-color: #41515e; }
html[data-manage-theme='dark'] .iot-page :deep(.el-tag--success) { --el-tag-text-color: #9bd9b1; --el-tag-bg-color: #203e35; --el-tag-border-color: #38624f; }
html[data-manage-theme='dark'] .iot-page :deep(.el-tag--danger) { --el-tag-text-color: #ffb3ba; --el-tag-bg-color: #4a2e38; --el-tag-border-color: #6d4550; }
</style>
<style lang="scss">
/* 抽屉传送到body，显式复用管理主题；长编号和映射只在抽屉内换行。 */
.iot-drawer { background: var(--manage-color-panel); color: var(--manage-color-text-primary); max-width: 100vw; }
.iot-drawer .el-drawer__header { color: var(--manage-color-text-primary); margin-bottom: 16px; }
.iot-drawer .el-descriptions { --el-descriptions-table-border: 1px solid var(--manage-color-line); }
.iot-drawer .el-descriptions__cell { overflow-wrap: anywhere; white-space: pre-wrap; background: var(--manage-color-panel); color: var(--manage-color-text-primary); }
.iot-drawer .el-descriptions__label { width: 118px; background: var(--manage-color-panel-deep) !important; color: var(--manage-color-text-secondary) !important; }
.iot-drawer .el-alert { margin-bottom: 12px; }
</style>
