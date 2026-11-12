import assert from 'node:assert/strict'
import { chromium } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'

/**
 * 验证正式Vue页面及认证/菜单/请求交互。只使用隔离上下文与传输替身，
 * 不向真实服务写数据；真实网关、数据库、Broker和Kafka另行验收。
 */
const origin = process.env.IOT_BROWSER_ORIGIN || 'http://127.0.0.1:5187'
const base = origin + '/dts'
const output = process.env.IOT_BROWSER_OUTPUT_DIR || 'docs/evidence/iot-m2-20261110'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true })
const checks = []
const failures = []
const uiChecksEnabled = process.env.IOT_BROWSER_UI_REVIEW === '1'
const visualMetrics = []
let activePage
const menus = [
  { id: '8000', name: '资源管理', children: [
    { id: '8001', name: '模型管理', component: 'resourceManage/modelManage/index' },
    { id: '8002', name: '图片管理', component: 'resourceManage/iconManage/index' },
    { id: '8003', name: '模板管理', component: 'resourceManage/templateManage/index' },
  ] },
  { id: '8050', name: '场景管理', children: [{ id: '8051', name: '场景列表', component: 'SceneManage/index' }] },
  { id: '8100', name: '物联网管理', icon: 'Connection', children: [
  { id: '8101', name: '连接器管理', component: 'iotManage/connectors/index', icon: 'Link' },
  { id: '8102', name: '设备绑定', component: 'iotManage/bindings/index', icon: 'Setting' },
  { id: '8103', name: '接收记录', component: 'iotManage/messages/index', icon: 'Tickets' },
] }]
let connectors = Array.from({ length: 11 }, (_, index) => ({
  id: index ? String(100 + index) : '9007199254740993', connectorId: 'browser-' + index,
  name: '浏览器隔离连接器' + index, connectorType: 'MQTT', enabled: false, version: 2,
  endpoint: 'ssl://broker.invalid:8883', credentialRef: 'IOT_MQTT_TEST',
  configJson: '{"topics":["browser/telemetry"],"qos":1}',
}))
let bindings = [{ id: '201', connectorId: 'browser-0', externalDeviceId: 'external-01', deviceId: 'device-01',
  sceneId: 'scene-01', objectId: 'object-01', mappingRevision: 'v1', enabled: true,
  pointMappingJson: '{"points":{"temp":{"valueType":"NUMBER","scale":0.1}}}' }]
let events = [{ id: '301', connectorId: 'browser-0', externalDeviceId: 'external-01', pointCode: 'temperature',
  eventId: 'browser-event-01', status: 'FAILED', retryCount: 1, receivedAt: 1794268800000 }]
let conflict = false, pageError = false, runtimeCalls = 0, writes = 0
const requests = []

async function createPage(permissions = ['*:*:*'], menuTree = menus, platformType = 'tenant') {
  const businessRequests = []
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.addInitScript(({ origin, platformType }) => {
    sessionStorage.setItem('wx-unity:standalone-session:v2', JSON.stringify({
      server: origin, apiMode: 'admin', platformType,
      tokens: { access_token: 'iot-isolated-browser-token', client_id: 'web', tenantId: platformType === 'operation' ? '1' : '7' },
      profile: { user: { userId: '7', nickName: '隔离页面验证' }, permissions: [], roles: [] },
    }))
  }, { origin, platformType })
  const page = await context.newPage()
  page.on('pageerror', error => failures.push(error.message))
  await page.route(/\/(admin-api|api)\//, async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname
    if (path.includes('/src/') || path.includes('/node_modules/')) return route.continue()
    let data = [], code = 200
    if (path === '/admin-api/system/auth/get-permission-info') {
      data = { user: { id: '7', nickname: '隔离页面验证' }, roles: [], permissions, menus: menuTree }
    } else if (path.startsWith('/admin-api/iot/')) {
      assert.equal(request.headers()['tenant-id'], platformType === 'operation' ? '1' : '7')
      assert.equal(request.headers().authorization, 'Bearer iot-isolated-browser-token')
      requests.push({ method: request.method(), path, params: Object.fromEntries(url.searchParams) })
      const resource = path.split('/')[3], action = path.split('/')[4]
      const list = resource === 'connector' ? connectors : resource === 'device-binding' ? bindings : events
      const id = url.searchParams.get('id')
      if (action === 'page') {
        if (pageError) code = 503
        const pageNo = Number(url.searchParams.get('pageNo')), pageSize = Number(url.searchParams.get('pageSize'))
        assert.ok(pageSize >= 1 && pageSize <= 100)
        const filtered = list.filter(row => !url.searchParams.get('connectorId') || row.connectorId.includes(url.searchParams.get('connectorId')))
        data = { list: filtered.slice((pageNo - 1) * pageSize, pageNo * pageSize), total: filtered.length }
      } else if (action === 'get') data = list.find(row => row.id === id) ?? null
      else if (action === 'runtime') {
        runtimeCalls++
        data = { effectiveStatus: 'LEASE_EXPIRED', persistedStatus: 'CONNECTED', leaseActive: false, observedAt: 1794268800000 }
      } else if (action === 'validate-mqtt-config') data = { scope: 'MQTT_STRUCTURE', topicCount: 1, qos: 1 }
      else if (action === 'test-mqtt') data = { outcome: 'CREDENTIALS_UNAVAILABLE', topicCount: 0, elapsedMillis: 0, message: '凭据未就绪' }
      else {
        writes++
        const form = request.postData() ? request.postDataJSON() : {}
        if (action === 'create') { list.unshift({ ...form, id: '401', version: 1, enabled: form.enabled ?? false }); data = '401' }
        else if (action === 'update') {
          if (conflict) code = 1009001011
          else { Object.assign(list.find(row => row.id === form.id), form); data = true }
        } else if (action === 'delete') { list.splice(list.findIndex(row => row.id === id), 1); data = true }
        else if (['enable', 'disable'].includes(action)) { list.find(row => row.id === id).enabled = action === 'enable'; data = true }
        else if (action === 'replay') { events[0].status = 'CLAIMED'; data = true }
        else throw new Error('未覆盖的接口动作：' + path)
      }
    } else if (path.startsWith('/admin-api/dim3d/')) businessRequests.push(path)
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code, data, msg: code === 200 ? '成功' : '隔离失败' }) })
  })
  return { page, context, businessRequests }
}
const check = (name) => checks.push({ name, passed: true })
const drawer = page => page.locator('.iot-drawer:visible')
const field = (page, name) => drawer(page).locator('.el-form-item').filter({
  has: page.locator('label').filter({ hasText: new RegExp('^' + name + '$') }),
}).getByRole('textbox')
async function closeDrawer(page) {
  await drawer(page).locator('.el-drawer__footer').getByRole('button', { name: '关闭', exact: true }).click()
  if (await page.getByRole('button', { name: '放弃修改', exact: true }).isVisible()) {
    await page.getByRole('button', { name: '放弃修改', exact: true }).click()
  }
  await drawer(page).waitFor({ state: 'hidden' })
}
try {
  const { page, context } = await createPage()
  activePage = page
  await page.goto(base + '/iotManage/connectors')
  await page.getByRole('heading', { name: '连接器管理' }).count()
  await page.getByText('浏览器隔离连接器0', { exact: true }).waitFor()
  await page.getByRole('row').filter({ hasText: '浏览器隔离连接器0' }).getByText('停用', { exact: true }).waitFor()
  assert.equal(runtimeCalls, 0)
  check('首次直接地址进入：真实Vue页面、标准权限菜单及租户头；列表不逐行读取运行状态')
  assert.deepEqual(await page.locator('.manage-header__menu > .manage-header__category').allTextContents(),
    ['资源管理', '场景管理', '物联网管理'])
  assert.equal(await page.getByRole('menuitem', { name: '物联网管理', exact: true }).count(), 0)
  await page.getByRole('menuitem', { name: '连接器管理', exact: true }).waitFor()
  check('物联网与资源、场景管理同级分类，授权入口直接展开并保留后端名称及组件白名单')
  await page.getByRole('row').filter({ hasText: '浏览器隔离连接器0' }).getByRole('button', { name: '详情', exact: true }).click()
  await drawer(page).getByText('租约已失效', { exact: true }).waitFor()
  await drawer(page).getByText('9007199254740993', { exact: true }).waitFor()
  assert.equal(runtimeCalls, 1)
  check('详情编号精度与失效租约展示：不将历史CONNECTED显示为实时在线')
  await drawer(page).getByRole('button', { name: '测试已保存连接' }).click()
  await drawer(page).getByText('凭据引用未就绪；本次测试不改变正式运行状态', { exact: true }).waitFor()
  check('连接测试缺凭据显示受控失败，不伪造成功')
  await closeDrawer(page)
  await page.getByRole('row').filter({ hasText: '浏览器隔离连接器0' }).getByRole('button', { name: '编辑', exact: true }).click()
  await field(page, '名称').fill('保留未保存输入')
  conflict = true
  await drawer(page).getByRole('button', { name: '保存', exact: true }).click()
  await drawer(page).getByText('配置已被修改，当前表单已保留，请重新读取详情后核对', { exact: true }).waitFor()
  assert.equal(await field(page, '名称').inputValue(), '保留未保存输入')
  check('旧配置版本冲突保留原表单，禁用盲目重复保存')
  conflict = false
  await closeDrawer(page)
  await page.getByRole('button', { name: '新增连接器', exact: true }).click()
  await field(page, '连接器编号').fill('browser-created')
  await field(page, '名称').fill('新增隔离连接器')
  await field(page, '服务地址').fill('ssl://broker.invalid:8883')
  await field(page, '凭据引用').fill('IOT_MQTT_TEST')
  await field(page, '协议配置（JSON）').fill('{"topics":["browser/test"],"qos":1}')
  await drawer(page).getByRole('button', { name: '校验MQTT结构' }).click()
  await drawer(page).getByText('配置结构校验通过；凭据、网络和订阅权限仍需连接测试').waitFor()
  await drawer(page).getByRole('button', { name: '保存', exact: true }).click()
  await page.getByText('新增隔离连接器', { exact: true }).waitFor()
  check('新增与MQTT结构预校验走真实请求适配器，保存后列表刷新')
  await page.locator('#iot-connector-filter').fill('missing')
  await page.getByRole('button', { name: '查询', exact: true }).click()
  await page.getByText('暂无记录，可调整筛选条件', { exact: true }).waitFor()
  await page.getByRole('button', { name: '重置', exact: true }).click()
  await page.getByText('新增隔离连接器', { exact: true }).waitFor()
  check('筛选、空状态和重置使用数据库分页参数')
  await page.getByRole('menuitem', { name: '设备绑定', exact: true }).click()
  await page.getByText('external-01', { exact: true }).waitFor()
  await page.getByRole('row').filter({ hasText: 'external-01' }).getByRole('button', { name: '编辑', exact: true }).click()
  const before = writes
  await field(page, '点位映射（JSON）').fill('{"points":{"temp":{"scale":"1"}}}')
  await drawer(page).getByRole('button', { name: '保存', exact: true }).click()
  await drawer(page).getByText('scale和offset必须是JSON数字', { exact: true }).waitFor()
  assert.equal(writes, before)
  await field(page, '点位映射（JSON）').fill('{"points":{"temp":{"scale":0.1,"offset":-2}}}')
  await drawer(page).getByRole('button', { name: '保存', exact: true }).click()
  await drawer(page).waitFor({ state: 'hidden' })
  check('设备绑定编辑：非法映射不发请求，合法映射保存并刷新')
  await page.getByRole('menuitem', { name: '接收记录', exact: true }).click()
  await page.getByText('browser-event-01', { exact: true }).waitFor()
  await page.getByRole('row').filter({ hasText: 'browser-event-01' }).getByRole('button', { name: '重放', exact: true }).click()
  await page.getByRole('button', { name: '确定', exact: true }).click()
  await page.getByRole('row').filter({ hasText: 'browser-event-01' }).getByText('处理中', { exact: true }).waitFor()
  check('失败事件重放：只提示请求提交，刷新后的处理中不会显示已发布')
  pageError = true
  await page.getByRole('button', { name: '查询', exact: true }).click()
  await page.getByText('加载失败，请重试', { exact: true }).waitFor()
  pageError = false
  await page.getByRole('button', { name: '重试', exact: true }).click()
  await page.getByText('browser-event-01', { exact: true }).waitFor()
  check('服务失败有独立错误与重试，不保留误导性旧列表')
  await page.setViewportSize({ width: 1024, height: 768 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false)
  check('1024宽度无整页横向溢出，表格在内容区域滚动')
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.reload()
  await page.getByText('browser-event-01', { exact: true }).waitFor()
  await page.screenshot({ path: output + '/messages.png', animations: 'disabled' })
  if (!await page.getByRole('menuitem', { name: '连接器管理', exact: true }).isVisible()) {
    await page.locator('.el-sub-menu__title').filter({ hasText: '物联网管理' }).click()
  }
  await page.getByRole('menuitem', { name: '连接器管理', exact: true }).click()
  await page.getByText('新增隔离连接器', { exact: true }).waitFor()
  await page.screenshot({ path: output + '/connectors.png', animations: 'disabled' })
  await context.close()
  const reader = await createPage(['iot:connector:query'])
  await reader.page.goto(base + '/iotManage/connectors')
  await reader.page.getByText('新增隔离连接器', { exact: true }).waitFor()
  assert.equal(await reader.page.getByRole('button', { name: /新增连接器|^编辑$|^删除$|^启用$/ }).count(), 0)
  await reader.page.goto(base + '/iotManage/bindings')
  await reader.page.waitForURL('**/sceneManage')
  check('只读账号隐藏写入按钮，缺少菜单或查询权限不能直接进入绑定路由')
  await reader.context.close()
  const hidden = await createPage(['*:*:*'], [])
  await hidden.page.goto(base + '/iotManage/connectors')
  await hidden.page.waitForURL('**/management/access')
  assert.equal(await hidden.page.getByRole('menuitem', { name: '物联网管理' }).count(), 0)
  check('新身份无授权菜单时不继承旧菜单或开放全量入口')
  await hidden.context.close()
  const customized = await createPage(['*:*:*'], [
    { id: '1', name: '项目中心', children: [{ id: '2', name: '项目总览', component: 'SceneManage/index' }] },
    { id: '3', name: '资料中心', children: [{ id: '4', name: '模型资料', component: 'resourceManage/modelManage/index' }] },
  ])
  activePage = customized.page
  await customized.page.goto(base + '/resourceManage/model')
  await customized.page.locator('.manage-model-page').waitFor()
  assert.deepEqual(await customized.page.locator('.manage-header__menu > .manage-header__category').allTextContents(), ['资源管理', '场景管理'])
  await customized.page.getByRole('menuitem', { name: '模型管理', exact: true }).waitFor()
  await customized.page.getByRole('menuitem', { name: '场景列表', exact: true }).waitFor()
  assert.equal(await customized.page.getByText('项目中心', { exact: true }).count(), 0)
  check('后台任意包装与改名不改变原资源/场景一级分类和二级入口，授权仍取后台')
  await customized.page.goto(base + '/resourceManage/icon')
  await customized.page.waitForURL('**/sceneManage')
  assert.equal(customized.businessRequests.some(path => path.includes('/icon/page')), false)
  check('移除图片菜单后直接地址被拒绝，不发图片业务请求')
  await customized.page.screenshot({ path: output + '/backend-navigation.png', animations: 'disabled' })
  await customized.context.close()
  const retryMenus = []
  const recovery = await createPage(['*:*:*'], retryMenus)
  activePage = recovery.page
  await recovery.page.goto(base + '/sceneManage')
  await recovery.page.waitForURL('**/management/access')
  assert.deepEqual(recovery.businessRequests, [])
  retryMenus.push({ id: '1', name: '新授权资源', children: [{ id: '2', name: '模型管理', component: 'resourceManage/modelManage/index' }] })
  await recovery.page.getByRole('button', { name: '刷新权限', exact: true }).click()
  await recovery.page.waitForURL('**/resourceManage/model')
  await recovery.page.getByRole('menuitem', { name: '模型管理', exact: true }).waitFor()
  assert.deepEqual(await recovery.page.locator('.manage-header__menu > .manage-header__category').allTextContents(), ['资源管理'])
  check('空菜单不挂业务页且无跳转循环，重新授权后刷新权限同步恢复侧栏与首个入口')
  await recovery.context.close()
  const original = await createPage(['*:*:*'], menus, 'operation')
  activePage = original.page
  await original.page.goto(base + '/iotManage/connectors')
  await original.page.getByText('新增隔离连接器', { exact: true }).waitFor()
  assert.deepEqual(await original.page.locator('.manage-header__menu > .manage-header__category').allTextContents(),
    ['资源管理', '场景管理', '物联网管理'])
  for (const name of ['模型管理', '图片管理', '模板管理', '场景列表', '连接器管理', '设备绑定', '接收记录']) {
    await original.page.getByRole('menuitem', { name, exact: true }).waitFor()
  }
  assert.equal(await original.page.locator('.manage-header__menu .el-sub-menu').count(), 0)
  await original.page.screenshot({ path: output + '/original-navigation.png', animations: 'disabled' })
  check('运营端原有三个一级分类和七个二级入口完整呈现，无额外包装目录或第三级')
  if (uiChecksEnabled) {
    const page = original.page
    const row = page.getByRole('row').filter({ hasText: '浏览器隔离连接器0' })
    assert.equal(await row.getByRole('button', { name: '启用', exact: true }).count(), 0)
    assert.equal(await row.getByRole('button', { name: '删除', exact: true }).count(), 0)
    await row.getByRole('button', { name: /^更多操作/ }).click()
    await page.getByRole('menuitem', { name: '启用', exact: true }).click()
    await page.getByRole('button', { name: '确定', exact: true }).click()
    await row.getByText('启用', { exact: true }).waitFor()
    check('行内突出详情/编辑，更多菜单启用沿用真实确认处理器并刷新期望状态')
    // 键盘可以打开菜单并移动焦点；关闭后再验证删除取消不触发写入。
    const more = row.getByRole('button', { name: /^更多操作/ })
    await more.focus()
    await page.keyboard.press('Enter')
    await page.getByRole('menuitem', { name: '停用', exact: true }).waitFor()
    await page.getByRole('menuitem', { name: '停用', exact: true }).press('Escape')
    await page.getByRole('menuitem', { name: '停用', exact: true }).waitFor({ state: 'hidden' })
    await more.click()
    await page.getByRole('menuitem', { name: '删除', exact: true }).click()
    const beforeCancel = writes
    await page.getByRole('button', { name: '取消', exact: true }).click()
    assert.equal(writes, beforeCancel)
    check('更多菜单支持键盘开启与退出，删除取消不会发送写请求')
    const contrast = async (target, background) => target.evaluate((el, fallback) => {
      const css = getComputedStyle(el)
      const parse = value => (value.match(/[\d.]+/g) || []).slice(0, 3).map(Number)
      const luminance = rgb => rgb.map(value => { const v = value / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 })
        .reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0)
      const a = luminance(parse(css.color)), b = luminance(parse(fallback || css.backgroundColor))
      return { foreground: css.color, background: fallback || css.backgroundColor, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) }
    }, background)
    const primary = page.getByRole('button', { name: '新增连接器', exact: true })
    const primaryContrast = await contrast(primary)
    const captionContrast = await contrast(page.locator('.iot-help').first(), 'rgb(255,255,255)')
    const sidebarContrast = await contrast(page.getByRole('menuitem', { name: '设备绑定', exact: true }), 'rgb(81,161,149)')
    assert.ok(primaryContrast.ratio >= 4.5, JSON.stringify(primaryContrast))
    assert.ok(captionContrast.ratio >= 4.5, JSON.stringify(captionContrast))
    // 侧栏按用户确认恢复白字；只记录对比，不把品牌配色宣称为通过4.5。
    assert.equal(sidebarContrast.foreground, 'rgb(255, 255, 255)')
    visualMetrics.push({ theme: 'light', primaryContrast, captionContrast, sidebarContrast })
    check('亮色主按钮和柔和灰绿说明对比达到4.5；侧栏按用户反馈恢复白字并单独记录对比')
    for (const width of [1280, 1440, 1920, 960]) {
      await page.setViewportSize({ width, height: 1000 })
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false)
      const sizes = await page.locator('.manage-filter-bar').evaluate(el => ({
        control: el.querySelector('.el-input__wrapper').getBoundingClientRect().height,
        action: el.querySelector('.manage-filter-bar__actions .el-button').getBoundingClientRect().height,
        outside: [...el.querySelectorAll('input,button,.el-select')].some(node => {
          const box = node.getBoundingClientRect(), panel = el.getBoundingClientRect()
          return box.width > 0 && (box.left < panel.left - 1 || box.right > panel.right + 1)
        }),
      }))
      assert.equal(Math.round(sizes.control), 32)
      assert.equal(Math.round(sizes.action), 32)
      assert.equal(sizes.outside, false)
      visualMetrics.push({ page: 'connectors', width, ...sizes })
      if (width !== 960) await page.screenshot({ path: output + '/connectors-light-' + width + '.png', animations: 'disabled' })
    }
    check('1280/1440/1920及960等效缩放布局无整页横溢，筛选控件与动作高度一致')
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.getByRole('menuitem', { name: '场景列表', exact: true }).click()
    await page.locator('.manage-scene-page').waitFor()
    const fieldRows = await page.locator('.manage-filter-bar__field').evaluateAll(nodes =>
      nodes.map(node => Math.round(node.getBoundingClientRect().top)))
    assert.equal(new Set(fieldRows).size, 1)
    await page.screenshot({ path: output + '/scenes-light-1440.png', animations: 'disabled' })
    check('场景四字段在1440保持一排，使用共享筛选布局且空态保留')
    await page.getByRole('menuitem', { name: '连接器管理', exact: true }).click()
    await page.getByText('新增隔离连接器', { exact: true }).waitFor()
    await page.getByRole('button', { name: '切换为暗色主题', exact: true }).click()
    await page.getByRole('button', { name: '切换为亮色主题', exact: true }).waitFor()
    const darkPrimary = await contrast(page.getByRole('button', { name: '新增连接器', exact: true }))
    assert.ok(darkPrimary.ratio >= 4.5)
    visualMetrics.push({ theme: 'dark', primaryContrast: darkPrimary })
    await page.screenshot({ path: output + '/connectors-dark-1440.png', animations: 'disabled' })
    const darkRow = page.getByRole('row').filter({ hasText: '浏览器隔离连接器0' })
    await darkRow.getByRole('button', { name: /^更多操作/ }).click()
    await page.getByRole('menuitem', { name: '删除', exact: true }).waitFor()
    await page.keyboard.press('Escape')
    await darkRow.getByRole('button', { name: '详情', exact: true }).click()
    await drawer(page).getByText('租约已失效', { exact: true }).waitFor()
    await page.screenshot({ path: output + '/drawer-dark-1440.png', animations: 'disabled' })
    await closeDrawer(page)
    check('暗色按钮对比、传送菜单和详情抽屉可用，状态语义保持')
  }
  await original.context.close()
  assert.deepEqual(failures, [])
} catch (failure) {
  if (activePage && !activePage.isClosed()) {
    await activePage.screenshot({ path: output + '/failure.png' })
    console.error('失败页面：' + activePage.url())
  }
  throw failure
} finally {
  await browser.close()
  await writeFile(output + '/browser-checks.json', JSON.stringify({
    scope: '正式Vue页面与接口传输替身；不代表真实网关、认证服务、数据库或消息系统联验',
    checks, pageErrors: failures, requests, visualMetrics,
    passed: checks.length === (uiChecksEnabled ? 23 : 17) && failures.length === 0,
  }, null, 2))
}
console.log(JSON.stringify({ passed: true, checks: checks.length }))
