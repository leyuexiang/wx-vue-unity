import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import https from 'node:https'
import tls from 'node:tls'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from '@playwright/test'

// 所有接口均为真实服务；公钥固定仅用于此内网自签证书，禁止全局忽略HTTPS错误。
const release = '/home/wx-editor-web148/releases/iot-web-20261111'
const certificateHost = process.env.IOT_WEB_CERTIFICATE_HOST || '192.168.10.148'
const certificatePath = process.env.IOT_WEB_CERTIFICATE_PATH || `${release}/server.crt`
const certificateName = process.env.IOT_WEB_CERTIFICATE_NAME || '192.168.10.148'
const cert = execFileSync('ssh', ['-o', 'BatchMode=yes', certificateHost, `cat ${certificatePath}`], { encoding: 'utf8' })
const identities = JSON.parse(execFileSync('ssh', ['-o', 'BatchMode=yes', '192.168.10.148',
  'cat /opt/wx/editor-test148/test-identities.json'], { encoding: 'utf8' }))
const pin = createHash('sha256').update(new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' })).digest('base64')
const phase = process.env.IOT_WEB_PHASE || 'isolation'
const base = process.env.IOT_WEB_ORIGIN || 'https://127.0.0.1:49882/dts'
const origin = new URL(base).origin
const output = 'docs/evidence/iot-web-20261111'
await mkdir(output, { recursive: true })
const checks = [], errors = []
let step = '', passed = false, page, token
const marker = `web-${phase}-${Date.now().toString(36)}`
let connectorId
const bindingIds = new Set()
const browser = await chromium.launch({ headless: true, args: [`--ignore-certificate-errors-spki-list=${pin}`] })
const contexts = []
function get(path) {
  return new Promise((resolve, reject) => {
    https.get(origin + path, { ca: cert, checkServerIdentity: (_host, peer) => tls.checkServerIdentity(certificateName, peer) }, res => {
      const chunks = []
      res.on('data', data => chunks.push(data))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }))
    }).on('error', reject)
  })
}
async function check(name, action) { step = name; await action(); checks.push({ name, passed: true }) }
async function login(role) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  contexts.push(context)
  const target = await context.newPage()
  target.on('pageerror', error => errors.push(error.name))
  await target.goto(base + '/iotManage/connectors')
  await target.getByText('租户端', { exact: true }).click()
  const identity = identities.find(x => x.role === role)
  await target.locator('#standalone-account').fill(identity.username)
  await target.locator('#standalone-password').fill(identity.password)
  const loginResponse = target.waitForResponse(r => r.url().includes('/system/auth/login') && r.request().method() === 'POST')
  await target.getByRole('button', { name: '登录租户端', exact: true }).click()
  const result = await (await loginResponse).json()
  assert.equal(result.code, 200)
  return { target, token: result.data.accessToken }
}
const drawer = () => page.locator('.iot-drawer:visible')
const field = label => drawer().locator('.el-form-item').filter({ has: page.locator('label').filter({ hasText: new RegExp(`^${label}$`) }) }).getByRole('textbox')
const row = text => page.getByRole('row').filter({ hasText: text })
async function response(path, method, action) {
  const pending = page.waitForResponse(r => r.url().includes(path) && r.request().method() === method)
  await action()
  return (await pending).json()
}
async function api(path, method = 'GET', body) {
  const result = await page.evaluate(async ({ path, method, body, token }) => {
    const res = await fetch('/dts-api/admin-api' + path, { method, headers: {
      Authorization: 'Bearer ' + token, 'tenant-id': '2', 'Content-Type': 'application/json',
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return res.json()
  }, { path, method, body, token })
  assert.equal(result.code, 200)
  return result.data
}
async function close(discard = false) {
  await drawer().getByRole('button', { name: '关闭', exact: true }).click()
  if (discard) await page.getByRole('button', { name: '放弃修改', exact: true }).click()
  await drawer().waitFor({ state: 'hidden' })
}
async function edit(text, kind) {
  // 等待真实详情回填和加载遮罩结束，避免自动化fill绕过遮罩而被迟到回填覆盖。
  await response(`/iot/${kind}/get`, 'GET', () => row(text).getByRole('button', { name: '编辑', exact: true }).click())
  await page.locator('.iot-drawer .el-loading-mask:visible').waitFor({ state: 'hidden' })
}
async function removeThroughUi(text, kind) {
  await row(text).getByRole('button', { name: /^更多操作/ }).click()
  await page.getByRole('menuitem', { name: '删除', exact: true }).click()
  const result = await response(`/iot/${kind}/delete`, 'DELETE', () => page.getByRole('button', { name: '确定', exact: true }).click())
  assert.equal(result.code, 200)
}
try {
  await check('证书及静态深链接校验', async () => {
    const index = await get('/dts/'), deep = await get('/dts/iotManage/connectors')
    assert.equal(index.status, 200); assert.equal(deep.body, index.body)
    assert.match(index.headers['cache-control'], /no-store/)
    const script = index.body.match(/<script[^>]*type="module"[^>]*src="([^"]+)"/)[1]
    const asset = await get(script)
    assert.equal(asset.status, 200); assert.match(asset.headers['content-type'], /javascript/)
    assert.match(asset.headers['cache-control'], /immutable/)
    assert.equal((await get('/dts/assets/does-not-exist.js')).status, 404)
    assert.equal((await get('/dts-api/admin-api/iot/telemetry/mock')).status, 404)
    if (process.env.IOT_WEB_EXPECT_LEGACY !== '0') assert.equal((await get('/threeWeb/')).status, 200)
    else assert.equal(new URL((await get('/')).headers.location, origin).pathname, '/dts/')
  })
  await check('真实登录与三个同级分类', async () => {
    const auth = await login('tenant_admin'); page = auth.target; token = auth.token
    await page.getByRole('menuitem', { name: '连接器管理', exact: true }).waitFor()
    assert.deepEqual(await page.locator('.manage-header__menu > .manage-header__category').allTextContents(), ['资源管理', '场景管理', '物联网管理'])
    assert.equal(await page.getByRole('menuitem').count(), 6)
  })
  await check('网页新增连接器并回读默认停用', async () => {
    await page.getByRole('button', { name: '新增连接器', exact: true }).click()
    await field('连接器编号').fill(marker); await field('名称').fill(marker)
    await drawer().locator('.el-select').click()
    await page.locator('.el-select-dropdown:visible').getByText('MOCK', { exact: true }).click()
    await field('协议配置（JSON）').fill('{}')
    const result = await response('/iot/connector/create', 'POST', () => drawer().getByRole('button', { name: '保存', exact: true }).click())
    assert.equal(result.code, 200); connectorId = String(result.data)
    await row(marker).getByText('停用', { exact: true }).waitFor()
  })
  await check('网页编辑及未保存取消', async () => {
    await edit(marker, 'connector')
    await field('名称').fill(marker + '-edited')
    assert.equal((await response('/iot/connector/update', 'PUT', () => drawer().getByRole('button', { name: '保存', exact: true }).click())).code, 200)
    await row(marker + '-edited').waitFor()
    await edit(marker, 'connector')
    await field('名称').fill(marker + '-not-saved'); await close(true)
    assert.equal((await api('/iot/connector/get?id=' + connectorId)).name, marker + '-edited')
  })
  await check('真实并发冲突保留表单并允许核对后恢复保存', async () => {
    await edit(marker, 'connector')
    await field('名称').fill(marker + '-draft')
    const current = await api('/iot/connector/get?id=' + connectorId)
    await api('/iot/connector/update', 'PUT', { ...current, name: marker + '-concurrent' })
    const result = await response('/iot/connector/update', 'PUT', () => drawer().getByRole('button', { name: '保存', exact: true }).click())
    assert.equal(result.code, 1009001011)
    await page.locator('.iot-conflict').waitFor(); assert.equal(await field('名称').inputValue(), marker + '-draft')
    assert.equal(await drawer().getByRole('button', { name: '保存', exact: true }).isDisabled(), true)
    await page.screenshot({ path: `${output}/conflict-${phase}.png`, fullPage: true })
    await page.getByRole('button', { name: '读取最新配置', exact: true }).click()
    await response('/iot/connector/get', 'GET', () => page.getByRole('button', { name: '确定', exact: true }).click())
    await page.locator('.iot-drawer .el-loading-mask:visible').waitFor({ state: 'hidden' })
    await field('名称').fill(marker + '-recovered')
    assert.equal((await response('/iot/connector/update', 'PUT', () => drawer().getByRole('button', { name: '保存', exact: true }).click())).code, 200)
    await row(marker + '-recovered').waitFor()
  })
  await check('更多菜单启停沿用真实确认及状态刷新', async () => {
    for (const action of ['启用', '停用']) {
      await row(marker).getByRole('button', { name: /^更多操作/ }).click()
      await page.getByRole('menuitem', { name: action, exact: true }).click()
      const path = action === '启用' ? 'enable' : 'disable'
      assert.equal((await response('/iot/connector/' + path, 'POST', () => page.getByRole('button', { name: '确定', exact: true }).click())).code, 200)
      await row(marker).getByText(action, { exact: true }).waitFor()
    }
    await page.screenshot({ path: `${output}/connectors-${phase}.png`, fullPage: true })
  })
  await check('网页创建绑定并保存完整十进制映射', async () => {
    await page.getByRole('menuitem', { name: '设备绑定', exact: true }).click()
    await page.getByRole('button', { name: '新增绑定', exact: true }).click()
    await field('连接器编号').fill(marker); await field('外部设备编号').fill(marker + '-device')
    await field('映射版本').fill('v1')
    const mapping = '{"points":{"temperature":{"valueType":"NUMBER","scale":0.1000000000000000001}}}'
    await field('点位映射（JSON）').fill(mapping)
    const result = await response('/iot/device-binding/create', 'POST', () => drawer().getByRole('button', { name: '保存', exact: true }).click())
    assert.equal(result.code, 200); const id = String(result.data); bindingIds.add(id)
    await row(marker + '-device').waitFor()
    assert.equal((await api('/iot/device-binding/get?id=' + id)).pointMappingJson, mapping)
    await edit(marker + '-device', 'device-binding')
    await field('映射版本').fill('v2')
    assert.equal((await response('/iot/device-binding/update', 'PUT', () => drawer().getByRole('button', { name: '保存', exact: true }).click())).code, 200)
    assert.equal((await api('/iot/device-binding/get?id=' + id)).mappingRevision, 'v2')
    await page.screenshot({ path: `${output}/bindings-${phase}.png`, fullPage: true })
  })
  await check('浏览器翻页请求真实数据库第二页', async () => {
    for (let i = 0; i < 10; i++) {
      const id = await api('/iot/device-binding/create', 'POST', { connectorId: marker, externalDeviceId: marker + '-page-' + i, mappingRevision: 'v1', pointMappingJson: '{}', enabled: true })
      bindingIds.add(String(id))
    }
    await page.locator('#iot-connector-filter').fill(marker)
    await response('/iot/device-binding/page', 'GET', () => page.getByRole('button', { name: '查询', exact: true }).click())
    const result = await response('/iot/device-binding/page', 'GET', () => page.locator('.el-pagination .btn-next').click())
    assert.equal(result.code, 200); assert.equal(result.data.total, 11); assert.equal(result.data.list.length, 1)
    for (const id of [...bindingIds].slice(1)) { await api('/iot/device-binding/delete?id=' + id, 'DELETE'); bindingIds.delete(id) }
    await response('/iot/device-binding/page', 'GET', () => page.getByRole('button', { name: '查询', exact: true }).click())
  })
  await check('网页删除绑定和连接器，样本从列表移除', async () => {
    await removeThroughUi(marker + '-device', 'device-binding'); bindingIds.clear()
    await page.getByRole('menuitem', { name: '连接器管理', exact: true }).click()
    await row(marker).waitFor(); await removeThroughUi(marker, 'connector'); connectorId = undefined
    await row(marker).waitFor({ state: 'hidden' })
  })
  await check('接收记录与既有资源场景入口读取', async () => {
    for (const [name, path] of [['接收记录', '/iot/message-inbox/page'], ['模型管理', '/dim3d/model/page'], ['图片管理', '/dim3d/icon/page'], ['场景列表', '/dim3d/scene/page']]) {
      assert.equal((await response(path, 'GET', () => page.getByRole('menuitem', { name, exact: true }).click())).code, 200)
    }
  })
  await check('深链接刷新后身份恢复，查看者仍不能进入IoT页面', async () => {
    await page.goto(base + '/iotManage/connectors'); await page.getByRole('button', { name: '新增连接器', exact: true }).waitFor()
    const viewer = await login('viewer')
    await viewer.target.waitForURL('**/management/access')
    assert.equal(await viewer.target.locator('.iot-content').count(), 0)
  })
  assert.deepEqual(errors, []); passed = true
} catch (error) {
  checks.push({ name: step, passed: false, errorType: error.name,
    ...(step.includes('登录') ? {} : { detail: String(error.message).slice(0, 400) }) })
  if (page) await page.screenshot({ path: `${output}/failure-${phase}.png`, fullPage: true }).catch(() => {})
} finally {
  try {
    if (page && token) {
      for (const id of bindingIds) await api('/iot/device-binding/delete?id=' + id, 'DELETE')
      if (connectorId) await api('/iot/connector/delete?id=' + connectorId, 'DELETE')
      assert.equal((await api('/iot/connector/page?pageNo=1&pageSize=10&connectorId=' + marker)).total, 0)
      assert.equal((await api('/iot/device-binding/page?pageNo=1&pageSize=10&connectorId=' + marker)).total, 0)
    }
  } catch { passed = false; checks.push({ name: '本次样本清理核对', passed: false }) }
  await writeFile(`${output}/${phase}-browser.json`, JSON.stringify({ passed, phase, marker, checks, pageErrors: errors,
    apiMocked: false, deployedStaticFiles: true, certificatePinned: true, scope: '真实静态包、标准登录及12525服务；并发客户端只修改本次标记样本' }, null, 2) + '\n')
  for (const context of contexts) await context.close()
  await browser.close()
}
console.log(JSON.stringify({ passed, phase, checks: checks.length, lastStep: step }))
if (!passed) process.exitCode = 1
