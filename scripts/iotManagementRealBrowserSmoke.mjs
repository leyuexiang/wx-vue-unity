import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from '@playwright/test'

// 凭据只经受信SSH进入内存，真实登录及请求直达隧道网关，不拦截或伪造接口响应。
const identities = JSON.parse(execFileSync('ssh', ['-o', 'BatchMode=yes', '192.168.10.148',
  'cat /opt/wx/editor-test148/test-identities.json'], { encoding: 'utf8' }))
const output = 'docs/evidence/iot-management-20261111'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true })
const checks = []
const errors = []
const origin = process.env.IOT_REAL_BROWSER_ORIGIN || 'http://127.0.0.1:5188/dts'
let page
async function check(name, action) {
  await action()
  checks.push({ name, passed: true })
}
async function login(role) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(origin + '/iotManage/connectors')
  await page.getByText('租户端', { exact: true }).click()
  const identity = identities.find(x => x.role === role)
  await page.locator('#standalone-account').fill(identity.username)
  await page.locator('#standalone-password').fill(identity.password)
  await page.getByRole('button', { name: '登录租户端', exact: true }).click()
  return context
}
let passed = false
try {
  const adminContext = await login('tenant_admin')
  await check('真实租户登录后保持三个同级分类和授权六页面', async () => {
    await page.getByRole('menuitem', { name: '连接器管理', exact: true }).waitFor({ timeout: 45000 })
    assert.deepEqual(await page.locator('.manage-header__menu > .manage-header__category').allTextContents(),
      ['资源管理', '场景管理', '物联网管理'])
    assert.equal(await page.getByRole('menuitem').count(), 6)
    assert.equal(await page.getByRole('menuitem', { name: '模板管理', exact: true }).count(), 0)
  })
  for (const [route, name] of [['connectors', '连接器管理'], ['bindings', '设备绑定'], ['messages', '接收记录']]) {
    await check(name + '读取真实网关分页及空列表', async () => {
      const requestPath = route === 'connectors' ? '/iot/connector/page' : route === 'bindings' ? '/iot/device-binding/page' : '/iot/message-inbox/page'
      const response = page.waitForResponse(r => r.url().includes(requestPath) && r.request().method() === 'GET')
      await page.getByRole('menuitem', { name, exact: true }).click()
      // 已在当前页点击时复用路由，不触发重复加载，显式查询验证真实请求。
      if (route === 'connectors') await page.getByRole('button', { name: '查询', exact: true }).click()
      const body = await (await response).json()
      assert.equal(body.code, 200)
      assert.equal(body.data.total, 0)
      await page.getByText('暂无记录，可调整筛选条件', { exact: true }).waitFor()
      await page.screenshot({ path: `${output}/${route}-real.png`, fullPage: true })
    })
  }
  await adminContext.close()
  const viewerContext = await login('viewer')
  await check('原查看者无授权菜单时进入恢复页，不能挂载IoT业务', async () => {
    await page.waitForURL('**/management/access', { timeout: 45000 })
    assert.equal(await page.locator('.iot-content').count(), 0)
  })
  await viewerContext.close()
  assert.deepEqual(errors, [])
  passed = true
} finally {
  await writeFile(`${output}/browser-checks.json`, JSON.stringify({ passed, checks, pageErrors: errors,
    scope: '本地正式Vue通过SSH隧道真实登录、授权与12525网关分页；未发布前端静态包，无接口替身' }, null, 2) + '\n')
  await browser.close()
}
console.log(JSON.stringify({ passed, checks: checks.length }))
