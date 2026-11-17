import { it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { setTimeout } from 'node:timers/promises'

// 两种实际交付布局使用相同网关，从无关工作目录启动以捕获依赖当前盘符或工作目录的回归。
for (const layout of ['public/unity-web', 'unity-web']) {
  it(`网关支持移动后的 ${layout} 布局`, { timeout: 15000 }, async (context) => {
    const temporaryRoot = fileURLToPath(new URL('../../.tmp/', import.meta.url))
    await mkdir(temporaryRoot, { recursive: true })
    const root = await mkdtemp(path.join(temporaryRoot, 'unity-deployment-'))
    let child: ReturnType<typeof spawn> | undefined
    let backend: ReturnType<typeof createServer> | undefined
    context.after(async () => {
      // 先结束占用目录和连接的进程，再删除临时文件，兼容窗口系统的目录占用规则。
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill()
        await once(child, 'exit')
      }
      if (backend) {
        backend.closeAllConnections()
        await new Promise<void>(resolve => backend!.close(() => resolve()))
      }
      await rm(root, { recursive: true, force: true })
    })
    const buildDirectory = path.join(root, layout, 'player/Build')
    await mkdir(buildDirectory, { recursive: true })
    await mkdir(path.join(root, layout, 'art/9tyf'), { recursive: true })
    await mkdir(path.join(root, 'server'))
    await mkdir(path.join(root, 'unrelated-working-directory'))
    await writeFile(path.join(root, layout, 'ArtStartupRelease.json'), '{}')
    await writeFile(path.join(root, layout, 'art/9tyf/ArtReleaseManifest.json'), '{}')
    for (const suffix of ['loader.js', 'framework.js', 'data', 'wasm']) {
      await writeFile(path.join(buildDirectory, `player.${suffix}`), 'fixture')
    }
    await copyFile(new URL('../unityWebDevGateway.ts', import.meta.url), path.join(root, 'server/unityWebDevGateway.ts'))
    await copyFile(new URL('../unityWebPackages.ts', import.meta.url), path.join(root, 'server/unityWebPackages.ts'))

    // 模拟本机身份后端，验证启动接口仍沿用正常登录校验流程。
    backend = createServer((_request, response) => {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ code: 200, data: { user: { id: '1' } } }))
    })
    backend.listen(0, '127.0.0.1')
    await once(backend, 'listening')
    const backendPort = (backend.address() as { port: number }).port
    const reservation = createServer()
    reservation.listen(0, '127.0.0.1')
    await once(reservation, 'listening')
    const port = (reservation.address() as { port: number }).port
    await new Promise<void>(resolve => reservation.close(() => resolve()))
    const env = { ...process.env, UNITY_WEB_DEV_PORT: String(port),
      UNITY_WEB_DEV_BACKEND: `http://127.0.0.1:${backendPort}`, UNITY_WEB_DEV_PUBLIC_ORIGIN: 'https://deployment.test',
      UNITY_WEB_DEV_API_MODE: 'admin' }
    // 清除开发终端中的路径覆盖，检查网关依靠自身相对位置定位交付目录。
    for (const key of ['UNITY_WEB_DEV_PLAYER_DIR', 'UNITY_WEB_DEV_ART_DIR', 'UNITY_WEB_DEV_DESCRIPTOR_FILE']) delete env[key]
    child = spawn(process.execPath, ['--experimental-strip-types', path.join(root, 'server/unityWebDevGateway.ts')], {
      cwd: path.join(root, 'unrelated-working-directory'), env, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let diagnostics = ''
    child.stderr.on('data', value => { diagnostics += String(value) })
    const address = `http://127.0.0.1:${port}`
    let ready = false
    for (let attempt = 0; attempt < 60 && !ready; attempt++) {
      ready = await fetch(`${address}/health`).then(response => response.ok).catch(() => false)
      if (!ready) await setTimeout(50)
    }
    assert.ok(ready, diagnostics)
    const headers = {
      Authorization: 'Bearer fixture', ClientId: 'fixture', 'X-Unity-Platform': 'operation', 'tenant-id': '1',
    }
    const response = await fetch(`${address}/bootstrap`, { headers })
    assert.equal(response.status, 200)
    const bootstrap = await response.json() as { build: Record<string, unknown> }
    // 相对地址包含版本快照；前端代理去掉应用根下的 unity-runtime 前缀后交给网关。
    assert.match(String(bootstrap.build.loaderUrl), /^\.\/unity-runtime\/packages\/[0-9a-f]{24}\/player\/Build\/player.loader.js$/)
    const playerUrl = String(bootstrap.build.loaderUrl).replace('./unity-runtime', '')
    assert.equal(bootstrap.build.codeUrl, String(bootstrap.build.loaderUrl).replace('player.loader.js', 'player.wasm'))
    assert.equal(bootstrap.build.streamingAssetsUrl, String(bootstrap.build.loaderUrl).replace('Build/player.loader.js', 'StreamingAssets'))
    assert.equal((await fetch(`${address}${playerUrl}`)).status, 200)

    // 配置接口必须校验身份和来源，不能因为播放器资源公开而顺带开放写配置能力。
    assert.equal((await fetch(`${address}/config/webgpu`)).status, 401)
    assert.equal((await fetch(`${address}/config/webgpu/directories`)).status, 401)
    assert.equal((await fetch(`${address}/config/webgpu`, { headers: { ...headers, 'X-Unity-Platform': 'tenant' } })).status, 403)
    assert.equal((await fetch(`${address}/config/webgpu`, { headers: { ...headers, Origin: 'https://untrusted.test' } })).status, 403)
    const initial = await (await fetch(`${address}/config/webgpu`, { headers })).json() as Record<string, unknown>
    // 从正常配置接口进入目录选择，再提交 player 层相对路径，验证整个选择和切换链路。
    const listed = await fetch(`${address}/config/webgpu/directories?path=unity-web%2Fplayer`, { headers })
    assert.equal(listed.status, 200)
    const directory = await listed.json() as { path: string; selection: { ready: boolean } }
    assert.equal(directory.path, 'unity-web/player')
    assert.equal(directory.selection.ready, true)
    assert.equal((await fetch(`${address}/config/webgpu/directories?path=..%2Fserver`, { headers })).status, 400)
    const configure = (method: string, body: unknown, suffix = '') => fetch(`${address}/config/webgpu${suffix}`, {
      method, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    assert.equal((await configure('PUT', { oversized: 'x'.repeat(9000) })).status, 413)
    assert.equal((await configure('PUT', null)).status, 400)
    const broken = { ...initial, active: 'development', packages: { stable: 'unity-web', development: 'missing-package' } }
    assert.equal((await configure('PUT', broken)).status, 400)
    assert.equal((await configure('PUT', { ...initial, packages: { stable: '../outside', development: '' } })).status, 400)
    const checked = await (await configure('POST', broken, '/check')).json() as { checks: { development: { ready: boolean } } }
    assert.equal(checked.checks.development.ready, false)

    // 在另一个完整目录准备研发包，验证切换实际改变播放器和美术资源，而旧场景地址仍可用。
    const developmentRoot = path.join(root, path.dirname(layout), 'unity-web-development')
    await mkdir(path.join(developmentRoot, 'player/Build'), { recursive: true })
    await mkdir(path.join(developmentRoot, 'art/9tyf'), { recursive: true })
    await writeFile(path.join(developmentRoot, 'ArtStartupRelease.json'), '{"version":"development"}')
    await writeFile(path.join(developmentRoot, 'art/9tyf/ArtReleaseManifest.json'), '{"version":"development"}')
    for (const suffix of ['loader.js', 'framework.js', 'data', 'wasm']) {
      await writeFile(path.join(developmentRoot, 'player/Build', `player.${suffix}`), 'development-fixture')
    }
    const next = { ...initial, active: 'development', packages: { stable: 'unity-web/player', development: 'unity-web-development/player' } }
    const saved = await configure('PUT', next)
    assert.equal(saved.status, 200)
    assert.equal((await configure('PUT', next)).status, 409, '过期修订号不能覆盖刚保存的配置')
    const changed = await (await fetch(`${address}/bootstrap`, { headers })).json() as {
      build: { loaderUrl: string }; art: { releaseBaseUrl: string; descriptorBase64: string }
    }
    assert.notEqual(changed.build.loaderUrl, bootstrap.build.loaderUrl)
    assert.match(Buffer.from(changed.art.descriptorBase64, 'base64').toString(), /development/)
    assert.equal(await (await fetch(`${address}${changed.build.loaderUrl.replace('./unity-runtime', '')}`)).text(), 'development-fixture')
    assert.equal(await (await fetch(`${address}${playerUrl}`)).text(), 'fixture', '旧会话继续读取原资源')
    const artPath = new URL(changed.art.releaseBaseUrl).pathname
    assert.match(await (await fetch(`${address}${artPath}ArtReleaseManifest.json`)).text(), /development/)
    assert.equal((await fetch(`${address}${artPath}../../server/unityWebDevGateway.ts`)).status, 404)
    const persisted = JSON.parse(await readFile(path.join(root, 'config/webgpu-packages.json'), 'utf8'))
    assert.equal(persisted.active, 'development')
  })
}
