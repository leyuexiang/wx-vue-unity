import assert from 'node:assert/strict'
import { chromium } from '@playwright/test'
import { writeFile } from 'node:fs/promises'

/**
 * 在独立浏览器上下文验证迁移后的真实页面，不向真实接口写入测试场景。
 * 假鉴权仅存在于隔离浏览器和模拟接口中；生产页面仍使用来源鉴权与编辑锁协议。
 */
const baseUrl = (process.env.TWOD_SMOKE_BASE_URL || 'http://127.0.0.1:5180/dts').replace(/\/$/, '')
const startedAt = Date.now()
const sceneId = '100001'
let revision = 1
let dataRequestCount = 0
let saved = {
  sceneJson: JSON.stringify({ schemaVersion: 1, name: '二维迁移验收', sceneType: 'local3d', domainSlots: { twoD: 'present', threeD: 'present' }, metadata: {}, requestGlobalConfig: {}, publicRequests: [], sceneActions: [] }),
  threeDJson: JSON.stringify({ baseConfig: { coordinateSystem: { kind: 'local', unit: 'meter', upAxis: 'Y', gridEnabled: true } }, objects: [], components: [], layers: [], streaming: { groups: [], chunks: [] }, cameraPaths: [], unknownThreeDExtension: { retained: true } }),
  twoDJson: JSON.stringify({ canvas: { width: 1920, height: 1080 }, components: [], layerTree: [] }),
  dependenciesJson: JSON.stringify({ resources: [], dataBindings: [], behaviors: [], deviceBindings: [] }),
}
const originalThreeD = saved.threeDJson
const browser = await chromium.launch({ headless: true, channel: process.env.TWOD_SMOKE_BROWSER || 'msedge' })
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } })
const page = await context.newPage()
const errors = []
const connections = []
const failedModules = []
const consoleErrors = []
// 异步接口断言集中交给主流程报告，避免路由回调拒绝后绕过浏览器释放。
const routeErrors = []
page.on('pageerror', error => errors.push(error.message))
page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 600)) })
// 只排除开发服务器自身的热更新连接，不能因业务信令也带 token 参数就漏报。
page.on('websocket', socket => {
  const url = new URL(socket.url())
  const base = new URL(baseUrl)
  const isDevHotReload = url.host === base.host && url.pathname === `${base.pathname.replace(/\/$/, '')}/` && url.searchParams.has('token')
  if (!isDevHotReload) connections.push(socket.url())
})
page.on('response', response => { if (response.status() >= 400 && response.url().includes('/src/')) failedModules.push(response.url()) })
await context.addInitScript(() => {
  // 管理入口统一后，隔离身份同时携带后台菜单合同，不能凭通配权限生成静态入口。
  const context = { accessToken: 'isolated-two-d-test', clientId: 'two-d-browser-test', permissions: ['*:*:*'], roles: ['admin'], platformType: 'operation', menus: [
    { id: '1', name: '资源管理', children: [
      { id: '2', name: '模型管理', component: 'resourceManage/modelManage/index', children: [] },
      { id: '3', name: '图片管理', component: 'resourceManage/iconManage/index', children: [] },
      { id: '4', name: '模板管理', component: 'resourceManage/templateManage/index', children: [] },
    ] },
    { id: '5', name: '场景管理', children: [{ id: '6', name: '场景列表', component: 'SceneManage/index', children: [] }] },
  ] }
  // 同时覆盖来源独立登录和嵌入页签两种启动模式，所有接口均由本脚本拦截。
  sessionStorage.setItem('accessToken', JSON.stringify({ value: context.accessToken }))
  sessionStorage.setItem('xr-center-refresh-auth:twoD-smoke', JSON.stringify({ createdAt: Date.now(), context }))
})
await page.route(/\/(api|admin-api)\//, async route => {
  const request = route.request()
  const pathname = new URL(request.url()).pathname
  // 开发模块的目录也包含 api，必须先排除源码和依赖资源，避免把模块请求伪造成接口 JSON。
  if (pathname.includes('/src/') || pathname.includes('/node_modules/')) return route.continue()
  try {
  let body = { code: 200, data: [], total: 0, rows: [] }
  if (pathname.includes('/system/auth/get-permission-info')) body = { code: 0, data: { user: { nickname: '二维验证' }, roles: ['admin'], permissions: ['*:*:*'] } }
  else if (pathname.includes('/signaling/get-address')) body = { code: 0, data: {} }
  else if (pathname.includes('/two-d-validation')) { dataRequestCount++; body.data = [{ value: '远程绑定结果' }] }
  if (pathname.includes('/scene/info/')) body.data = { sceneId, name: '二维迁移验收', sceneType: 'local3d', currentRevision: { ...saved, revisionNo: revision } }
  else if (pathname.endsWith('/scenePreview/resolve')) body.data = { resultCode: 'OK', accessMode: 'PERSONAL', publicationId: '900001', ticket: 'isolated-preview-ticket' }
  else if (pathname.includes('/scenePreview/published/')) {
    // 个人受限预览沿用来源宿主鉴权，同时必须携带解析得到的发布票据。
    assert.equal(request.headers().authorization, 'Bearer isolated-two-d-test')
    assert.equal(new URL(request.url()).searchParams.get('ticket'), 'isolated-preview-ticket')
    if (pathname.endsWith('/sceneBasic')) body.data = { sceneJson: saved.sceneJson }
    else if (pathname.endsWith('/threeD')) body.data = { threeDJson: saved.threeDJson }
    else if (pathname.endsWith('/twoD')) body.data = { twoDJson: saved.twoDJson }
    else if (pathname.endsWith('/dependenciesByinstances')) {
      const dependencies = JSON.parse(saved.dependenciesJson)
      body.data = { items: request.postDataJSON().map(id => Object.fromEntries([
        ['instanceId', id], ...['resources', 'dataBindings', 'behaviors', 'deviceBindings'].map(key => [key,
          dependencies[key].filter(item => item.owner?.instanceId === id || item.owners?.some(owner => owner.instanceId === id)).map(item => JSON.stringify(item)),
        ]),
      ])) }
    }
  }
  else if (pathname.includes('/scene/lock/') || pathname.includes('/scene/heartbeat/')) body.data = { sceneId, locked: false, lockToken: 'isolated-test-lock', baseRevisionNo: revision }
  else if (pathname.endsWith('/scene/saveAll')) {
    const value = request.postDataJSON()
    assert.equal(value.sceneId, sceneId)
    assert.equal(value.lockToken, 'isolated-test-lock')
    assert.equal(value.threeDJson, originalThreeD)
    saved = value
    body.data = { sceneId, conflict: false, revisionNo: ++revision, requestId: value.requestId }
  }
  await route.fulfill({ json: body })
  } catch (error) {
    routeErrors.push(`${pathname}: ${error.message}`)
    await route.fulfill({ status: 500, json: { code: 500, msg: '隔离验收接口断言失败' } })
  }
})

try {
  await page.goto(`${baseUrl}/sceneEdit?id=${sceneId}&authHandoff=twoD-smoke&clientKey=twoD-smoke`)
  console.log('编辑器入口已打开，等待二维宿主')
  await page.locator('#scene-render').waitFor({ timeout: 60000 })
  await page.waitForFunction(async base => {
    const module = await import(`${base}/src/integrations/scene/editorScenePlatformHost.ts`)
    return Boolean(module.getActiveSceneViewportHost())
  }, baseUrl)
  // 核对四类有效注册组件的本体与配置面板均可解析，不仅检查目录数量。
  const registry = await page.evaluate(async base => {
    const { packages, loadWidget, loadConfigPanel, loadConfig } = await import(`${base}/src/packages/index.ts`)
    const results = []
    for (const group of packages) {
      for (const info of group.children) {
        const modules = await Promise.all([loadConfig(info.packageName, info.keyName), loadWidget(info.packageName, info.keyName), loadConfigPanel(info.packageName, info.keyName)])
        results.push({ group: group.key, key: info.keyName, loaded: modules.every(module => Boolean(module?.default)) })
      }
    }
    return results
  }, baseUrl)
  assert.deepEqual(registry.filter(item => !item.loaded), [])
  assert.equal(registry.length, 107)
  console.log('107 个有效组件及配置面板加载完成')
  let renderedCount = 0
  if (process.env.TWOD_SMOKE_FULL === '1') {
    renderedCount = await page.evaluate(async base => {
      const { packages } = await import(`${base}/src/packages/index.ts`)
      const { useSceneWidgetStore } = await import(`${base}/src/stores/sceneEditStore.ts`)
      const { getActiveSceneViewportHost } = await import(`${base}/src/integrations/scene/editorScenePlatformHost.ts`)
      const { nextTick } = await import(`${base}/node_modules/.vite/deps/vue.js`)
      const { readWidgetSceneFragment } = await import(`${base}/src/integrations/scene/widgetRuntime/widgetSceneFragment.ts`)
      const { mergeEditorWidgetSceneFragmentSnapshot, resolveEditorWidgetSceneFragment } = await import(`${base}/src/integrations/scene/editorSceneWidgetSnapshotAdapter.ts`)
      const { serializeSceneDefinitionToFourPackages } = await import(`${base}/src/integrations/scene/sceneFourPackage.ts`)
      const { assembleSceneDefinitionFromRuntimeFragments } = await import(`${base}/src/integrations/scene/sceneRuntimeFragmentAssembler.ts`)
      const store = useSceneWidgetStore()
      let count = 0
      for (const group of packages) {
        for (const info of group.children) {
          const id = await store.createWidget(info, { clientX: 800, clientY: 400 })
          if (!id) throw new Error(`组件创建失败：${info.keyName}`)
          await nextTick()
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
          const element = document.querySelector(`[data-widget-id="${id}"]`)
          if (!element?.children.length) throw new Error(`组件没有真实节点：${info.keyName}`)
          // 逐项经过正式四包序列化、组装和组件恢复，确认图表函数默认值不会阻断保存。
          const host = getActiveSceneViewportHost()
          const snapshot = mergeEditorWidgetSceneFragmentSnapshot(host.getStore().getScene(), readWidgetSceneFragment())
          const payload = serializeSceneDefinitionToFourPackages(snapshot)
          const restored = assembleSceneDefinitionFromRuntimeFragments({ manifest: { fragmentType: 'manifest', fragmentKey: snapshot.id, contentJson: JSON.stringify(payload) }, options: { sceneId: snapshot.id } })
          const fragment = resolveEditorWidgetSceneFragment(restored)
          if (fragment.widgets[0]?.id !== id || fragment.widgets[0]?.component.info.keyName !== info.keyName) throw new Error(`组件保存往返失败：${info.keyName}`)
          await store.loadSavedWidgets(fragment.widgets, fragment.widgetLayerTree)
          await nextTick()
          await new Promise(resolve => requestAnimationFrame(resolve))
          if (!document.querySelector(`[data-widget-layer-item][data-widget-id="${id}"]`)?.children.length) throw new Error(`组件恢复后未绘制：${info.keyName}`)
          store.deleteWidgets([id])
          await nextTick()
          getActiveSceneViewportHost().getCommandBus().clear()
          count++
        }
      }
      return count
    }, baseUrl)
    assert.equal(renderedCount, registry.length)
    console.log('107 个组件逐项创建、绘制、四包恢复和卸载完成')
  }

  // 使用真实调度器核对静态映射、面板原位修改和远程响应，避免仅验证配置文件能加载。
  const dataTarget = await page.evaluate(async base => {
    const { useSceneWidgetStore } = await import(`${base}/src/stores/sceneEditStore.ts`)
    const { VTextCommonInfo } = await import(`${base}/src/packages/components/Widget/TextCommon/config.ts`)
    const { createEmptyDataConfig } = await import(`${base}/src/types/data-config.ts`)
    const store = useSceneWidgetStore()
    const id = await store.createWidget(VTextCommonInfo, { clientX: 900, clientY: 450 })
    const config = createEmptyDataConfig([{ value: '静态绑定结果' }])
    config.bindings = [{ kind: 'widget', targetPath: 'value', sourceField: 'value', valueType: 'string' }]
    store.getWidgetById(id).component.dataConfig = config
    return id
  }, baseUrl)
  const dataNode = page.locator(`#scene [data-widget-id="${dataTarget}"]`)
  await dataNode.getByText('静态绑定结果', { exact: true }).waitFor()
  await page.evaluate(async ({ base, id }) => {
    const { useSceneWidgetStore } = await import(`${base}/src/stores/sceneEditStore.ts`)
    useSceneWidgetStore().getWidgetById(id).component.dataConfig.requests[0].request.config.data[0].value = '静态配置已修改'
  }, { base: baseUrl, id: dataTarget })
  await dataNode.getByText('静态配置已修改', { exact: true }).waitFor()
  await page.evaluate(async ({ base, id }) => {
    const { useSceneWidgetStore } = await import(`${base}/src/stores/sceneEditStore.ts`)
    useSceneWidgetStore().getWidgetById(id).component.dataConfig.requests[0].request = { type: 'ajax', config: {
      requestHttpType: 'GET', requestInterval: 0, requestIntervalUnit: 'second', requestOriginUrl: '', requestUrl: '/api/two-d-validation',
      requestContentType: 'default', requestParamsBodyType: 'none', useAuth: false,
      requestParams: { Params: {}, Header: {}, Body: { json: '', xml: '', 'form-data': {}, 'x-www-form-urlencoded': {} } }, requestSQLContent: { sql: '' },
    } }
  }, { base: baseUrl, id: dataTarget })
  await dataNode.getByText('远程绑定结果', { exact: true }).waitFor()
  assert.equal(dataRequestCount, 1)
  await page.evaluate(async ({ base, id }) => {
    const { useSceneWidgetStore } = await import(`${base}/src/stores/sceneEditStore.ts`)
    useSceneWidgetStore().deleteWidgets([id])
  }, { base: baseUrl, id: dataTarget })
  console.log('静态映射、配置修改和远程数据回填通过')

  const eventTargets = await page.evaluate(async base => {
    const { useSceneWidgetStore } = await import(`${base}/src/stores/sceneEditStore.ts`)
    const { VTextCommonInfo } = await import(`${base}/src/packages/components/Widget/TextCommon/config.ts`)
    const { VButtonInfo } = await import(`${base}/src/packages/components/Control/VButton/config.ts`)
    const store = useSceneWidgetStore()
    const textId = await store.createWidget(VTextCommonInfo, { clientX: 800, clientY: 450 })
    const buttonId = await store.createWidget(VButtonInfo, { clientX: 800, clientY: 600 })
    store.getWidgetById(buttonId).component.interactiveEvent = [{ id: 'browser-click', eventName: '隐藏文字', eventType: 'click', isOpen: true,
      conditionGroupList: [{ conditionBlokList: [{ conditionList: [], actionList: [{ actionType: 'widgetVisibility', actionTargetWidgetIds: [textId], widgetVisibility: false }] }] }] }]
    return { textId, buttonId }
  }, baseUrl)
  const groupId = await page.evaluate(async ({ base, ids }) => {
    const { useSceneWidgetStore } = await import(`${base}/src/stores/sceneEditStore.ts`)
    const store = useSceneWidgetStore()
    const group = store.createWidgetGroup(ids)
    if (!group || store.getGroupWidgetIds(group).length !== 2) throw new Error('二维分组创建失败')
    store.setGroupVisible(group, false)
    return group
  }, { base: baseUrl, ids: Object.values(eventTargets) })
  await page.locator(`#scene [data-widget-layer-item][data-widget-id="${eventTargets.textId}"]`).waitFor({ state: 'hidden' })
  await page.evaluate(async ({ base, group }) => {
    const { useSceneWidgetStore } = await import(`${base}/src/stores/sceneEditStore.ts`)
    const { getActiveSceneViewportHost } = await import(`${base}/src/integrations/scene/editorScenePlatformHost.ts`)
    getActiveSceneViewportHost().getCommandBus().undo()
    useSceneWidgetStore().ungroupWidgetGroup(group)
  }, { base: baseUrl, group: groupId })
  await page.locator(`#scene [data-widget-layer-item][data-widget-id="${eventTargets.textId}"]`).waitFor({ state: 'visible' })
  console.log('真实分组、显隐撤销和解组通过')
  await page.getByRole('button', { name: '预览', exact: true }).click()
  await page.locator(`#preview [data-widget-id="${eventTargets.buttonId}"] .widget-button`).click()
  await page.locator(`#preview [data-widget-id="${eventTargets.textId}"]`).waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: '关闭预览', exact: true }).click()
  await page.locator(`#scene [data-widget-id="${eventTargets.textId}"]`).waitFor({ state: 'visible' })
  await page.evaluate(async ({ base, ids }) => {
    const { useSceneWidgetStore } = await import(`${base}/src/stores/sceneEditStore.ts`)
    const { getActiveSceneViewportHost } = await import(`${base}/src/integrations/scene/editorScenePlatformHost.ts`)
    useSceneWidgetStore().deleteWidgets(ids)
    getActiveSceneViewportHost().getCommandBus().clear()
  }, { base: baseUrl, ids: Object.values(eventTargets) })
  console.log('真实按钮事件执行与退出预览回滚通过')

  // 使用真实资源拖拽入口创建首个文字，验证卡片事件、舞台坐标与命令登记贯通。
  await page.getByRole('tab', { name: '组件/部件' }).first().click()
  const textCard = page.locator('[draggable="true"]').filter({ hasText: /^文字$/ }).first()
  await textCard.waitFor()
  await textCard.dragTo(page.locator('#scene-render'), { targetPosition: { x: 500, y: 350 } })
  await page.locator('[data-widget-layer-item]').first().waitFor()
  const initialCount = await page.locator('[data-widget-layer-item]').count()
  assert.equal(initialCount, 1)
  await page.keyboard.press('Control+z')
  await page.waitForFunction(() => !document.querySelector('[data-widget-layer-item]'))
  await page.keyboard.press('Control+y')
  await page.locator('[data-widget-layer-item]').first().waitFor()

  await page.getByRole('button', { name: '保存', exact: true }).click()
  await page.getByText('场景保存成功', { exact: true }).waitFor()
  assert.equal(JSON.parse(saved.twoDJson).components.length, 1)
  await page.reload()
  await page.locator('[data-widget-layer-item]').first().waitFor({ timeout: 60000 })
  await page.getByRole('button', { name: '预览', exact: true }).click()
  await page.locator('#preview [data-widget-layer-item]').first().waitFor()
  await page.getByRole('button', { name: '关闭预览', exact: true }).click()
  await page.locator('#scene [data-widget-layer-item]').first().waitFor()
  await page.locator('#scene [data-widget-layer-item]').first().click()
  if (process.env.TWOD_SMOKE_SCREENSHOT) await page.screenshot({ path: process.env.TWOD_SMOKE_SCREENSHOT })
  // 独立发布页必须从发布快照读取二维包，不能回退到编辑接口。
  await page.goto(`${baseUrl}/scenePreview?sceneId=${sceneId}&authHandoff=twoD-smoke`)
  await page.locator('.scene-preview-stage [data-widget-layer-item]').first().waitFor({ timeout: 60000 })
  // 管理路由均真实挂载，沿用来源空列表响应，不向实际业务接口写入记录。
  const managementRoutes = [
    ['/sceneManage', '.manage-scene-page'],
    ['/resourceManage/model', '.manage-model-page'],
    ['/resourceManage/icon', '.manage-icon-page'],
    ['/resourceManage/template', '.manage-template-page'],
    ['/plantingManage', '.planting-dashboard'],
    ['/isolated-missing-route', '.el-empty'],
  ]
  for (const [path, selector] of managementRoutes) {
    await page.goto(`${baseUrl}${path}?authHandoff=twoD-smoke&clientKey=twoD-smoke`)
    await page.locator(selector).first().waitFor({ timeout: 30000 })
  }
  assert.deepEqual(routeErrors, [])
  assert.deepEqual(failedModules, [])
  assert.deepEqual(errors, [])
  assert.deepEqual(consoleErrors, [])
  assert.equal(connections.length, 0)
  const report = { passed: true, testedAt: new Date().toISOString(), durationMs: Date.now() - startedAt, backend: '隔离模拟接口', viewport: { width: 1920, height: 1080 }, registryCount: registry.length, registry, groups: Object.fromEntries(['Control', 'Chart', 'Decorate', 'Widget'].map(group => [group, registry.filter(item => item.group === group).length])),
    renderedCount, staticDataBinding: true, reactiveDataConfig: true, remoteDataBinding: true, dataRequestCount, groupingVisibilityUndo: true, realButtonEvent: true, previewStateRollback: true, dragUndoRedo: true, saveReload: true, previewRoundTrip: true, publishedPreview: true, managementRoutes: managementRoutes.map(([path]) => path), threeDUnchanged: true, routeErrors, errors, consoleErrors, failedModules, unityConnections: connections }
  if (process.env.TWOD_SMOKE_REPORT) await writeFile(process.env.TWOD_SMOKE_REPORT, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify(report))
} catch (error) {
  console.error(JSON.stringify({ url: page.url(), routeErrors, errors, consoleErrors, failedModules, text: (await page.locator('body').innerText()).slice(0, 1800) }))
  throw error
} finally { await context.close(); await browser.close() }
