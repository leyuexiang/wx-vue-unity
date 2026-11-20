import { fork } from 'node:child_process'
import { once } from 'node:events'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, loadEnv, preview } from 'vite'

const root = fileURLToPath(new URL('../', import.meta.url))
process.chdir(root)
const [originArgument, keyPath, certPath] = process.argv.slice(2)
const origin = new URL(originArgument)
const https = { key: readFileSync(keyPath), cert: readFileSync(certPath) }
const env = loadEnv('development', root, 'VITE_')
const backend = new URL(env.VITE_DIM3D_SERVER_URL)
const base = env.VITE_BASE_URL || '/dts/'

// 浏览器从加密入口同源访问业务、对象存储和 Unity 资源。源站地址仅用于服务端转发。
Object.assign(process.env, {
  VITE_DIM3D_SERVER_URL: '',
  VITE_DIM3D_AMM_SERVER_URL: '',
  VITE_UNITY_RESOURCE_API_ORIGIN: origin.origin,
  VITE_UNITY_PUBLICATION_API_ORIGIN: origin.origin,
  VITE_UNITY_WEB_BOOTSTRAP_URL: './unity-runtime/bootstrap',
  VITE_GIS_SOURCE_URL: '/gis-source',
})

const proxies = {
  '^/(?:admin-api|api)(?:/|[?]|$)': { target: backend.origin, changeOrigin: true },
  '^/dimensions/ws(?:/|[?]|$)': { target: backend.origin, changeOrigin: true, ws: true },
}

// 固定子路径只允许转发到环境中配置的上游，路径匹配后保留其余路径和查询参数。
function mapPrefix(prefix, target, rewrite) {
  proxies[prefix] = { target, changeOrigin: true, rewrite }
}

if (env.VITE_DIM3D_AMM_SERVER_URL) mapPrefix('/amm/', env.VITE_DIM3D_AMM_SERVER_URL)
if (env.VITE_DATA_MIDDLEWARE_URL && env.VITE_DATA_MIDDLEWARE_PREFIX) {
  const prefix = env.VITE_DATA_MIDDLEWARE_PREFIX.replace(/\/$/, '')
  mapPrefix(`${prefix}/`, env.VITE_DATA_MIDDLEWARE_URL, url => url.slice(prefix.length))
}
const gis = new URL(env.VITE_GIS_SOURCE_URL || '/gis-source', backend)
mapPrefix('/gis-source/', gis.origin, url => gis.pathname.replace(/\/$/, '') + url.slice('/gis-source'.length))

// 加密页面使用同源的加密信令连接，服务器继续连接原来的信令服务。
if (env.VITE_UNITY_CLOUD_SIGNAL_URL) {
  const signal = new URL(env.VITE_UNITY_CLOUD_SIGNAL_URL)
  const prefix = '/unity-cloud-signal'
  process.env.VITE_UNITY_CLOUD_SIGNAL_URL = `wss://${origin.host}${prefix}${signal.search}`
  proxies[`^${prefix}(?:[?]|$)`] = {
    target: signal.origin, changeOrigin: true, ws: true,
    rewrite: url => signal.pathname + url.slice(prefix.length),
  }
}

/** 网关先绑定空闲的环回端口，网页服务随后开放。两者共用生命周期。 */
async function serve(output) {
  const gateway = fork(path.join(root, 'server', 'unityWebDevGateway.ts'), [], {
    execArgv: ['--experimental-strip-types'], windowsHide: true,
    env: {
      ...process.env,
      UNITY_WEB_DEV_BACKEND: backend.origin,
      UNITY_WEB_DEV_PORT: '0',
      UNITY_WEB_DEV_API_MODE: env.VITE_DIM3D_API_MODE === 'admin' ? 'admin' : 'reference',
      UNITY_WEB_DEV_PAGE_ORIGIN: origin.origin,
      UNITY_WEB_DEV_PUBLIC_ORIGIN: origin.origin,
    },
  })

  try {
    const [gatewayPort] = await once(gateway, 'message', { signal: AbortSignal.timeout(10000) })
    const gatewayTarget = `http://127.0.0.1:${gatewayPort}`
    const runtimePrefix = `${base}unity-runtime`
    // 配置和构建文件按应用根路径转发。启动接口返回的资源与业务会话地址位于站点根路径。
    const { httpServer } = await preview({
      configFile: false, base, build: { outDir: output },
      preview: {
        host: origin.hostname, port: Number(origin.port || 443), strictPort: true, https,
        headers: {
          'Cross-Origin-Opener-Policy': 'same-origin',
          'Cross-Origin-Embedder-Policy': 'credentialless',
        },
        proxy: {
          [`${runtimePrefix}/`]: { target: gatewayTarget, rewrite: url => url.slice(runtimePrefix.length) },
          '^/(?:art|session)/': gatewayTarget,
          '^/admin-api/dim3d/resources/[1-9]\\d{0,18}/(?:current|file)(?:[?]|$)': gatewayTarget,
          ...proxies,
        },
      },
    })
    const upgraded = new Set()
    httpServer.on('upgrade', (_request, socket) => {
      upgraded.add(socket)
      socket.once('close', () => upgraded.delete(socket))
    })
    const closed = once(httpServer, 'close')
    const stop = () => {
      httpServer.close()
      httpServer.closeAllConnections()
      // 升级后的长连接由网页服务单独管理，停止时一并关闭。
      for (const socket of upgraded) socket.destroy()
    }
    const gatewayExit = () => {
      console.error('局域网渲染网关提前退出')
      process.exitCode = 1
      stop()
    }
    gateway.once('exit', gatewayExit)
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    if (gateway.exitCode !== null || gateway.signalCode !== null) gatewayExit()
    else console.log(`局域网网页渲染入口：${origin.origin}${base}sceneManage`)
    await closed
    gateway.off('exit', gatewayExit)
  } finally {
    gateway.kill()
  }
}

// 每次启动从固定构建目录创建独立的站点目录，重建时无需覆盖仍在运行的网页文件。
const buildRoot = path.join(root, 'dist', 'web-unity-lan')
mkdirSync(buildRoot, { recursive: true })
const output = mkdtempSync(path.join(buildRoot, 'site-'))
try {
  // 保留对公共图片的构建期解析，只复制网页所需的静态文件。播放器由网关按版本直接读取。
  await build({ mode: 'development', logLevel: 'warn', build: {
    outDir: output, copyPublicDir: false, reportCompressedSize: false,
  } })
  for (const directory of ['config', 'images']) {
    cpSync(path.join(root, 'public', directory), path.join(output, directory), { recursive: true })
  }
  await serve(output)
} finally {
  rmSync(output, { recursive: true, force: true })
}
