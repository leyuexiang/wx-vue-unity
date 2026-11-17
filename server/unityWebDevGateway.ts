import { createServer as createHttpsServer } from 'node:https'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { createReadStream, readFileSync, statSync } from 'node:fs'
import { randomUUID, createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { assertPackageFile, createWebPackageStore, WebPackageError, type WebPackageDeployment } from './unityWebPackages.ts'

// Local integration only. The browser's login token is checked against the existing
// profile API; the Unity player receives a short-lived opaque proxy URL, not the token.
const host = '127.0.0.1'
const port = Number(process.env.UNITY_WEB_DEV_PORT || 5191)
const pageOrigin = process.env.UNITY_WEB_DEV_PAGE_ORIGIN || 'http://localhost:5180'
// 后端必须显式指定，防止联调时把当前会话令牌转发到另一套测试环境。
const backend = new URL(required('UNITY_WEB_DEV_BACKEND'))
// 默认使用本项目管理 API，旧参考部署可显式配置 reference。
const adminApi = process.env.UNITY_WEB_DEV_API_MODE !== 'reference'
// 源码目录与发布目录共用同一入口；所有默认文件位置均相对于服务文件所在项目解析。
// 构建工具会把公共资源和本网关一起放入发布目录，部署后无需保留开发机器的目录结构。
const projectRoot = fileURLToPath(new URL('../', import.meta.url))
// 配置页和启动接口共享持久化配置；不再由进程启动时的三个磁盘绝对路径锁死版本。
const packages = createWebPackageStore(projectRoot)
const deployments = new Map<string, WebPackageDeployment>()
// 远程测试入口经反向代理访问；对外地址与环回监听地址独立配置。
const publicOrigin = process.env.UNITY_WEB_DEV_PUBLIC_ORIGIN
const origin = publicOrigin ? new URL(publicOrigin).origin : `https://localhost:${port}`
if (publicOrigin && (origin !== publicOrigin || !origin.startsWith('https://'))) {
  throw new Error('UNITY_WEB_DEV_PUBLIC_ORIGIN 必须是 HTTPS 根来源')
}
const sessions = new Map<string, { token: string; clientId: string; tenantId?: string; expiresAt: number; deploymentId: string }>()
let nextSessionPrune = 0

/** 每个会话绑定创建时的部署快照，切换版本不会混用旧播放器和新美术资源。 */
function pruneSessions(): void {
  // 大场景会连续下载许多资源，清理每半分钟最多执行一次，避免每次文件请求都遍历会话。
  if (Date.now() < nextSessionPrune) return
  nextSessionPrune = Date.now() + 30000
  for (const [key, value] of sessions) if (value.expiresAt <= Date.now()) sessions.delete(key)
  const retained = new Set([...sessions.values()].map(session => session.deploymentId))
  for (const key of deployments.keys()) if (!retained.has(key)) deployments.delete(key)
}

/** 正文监听在成功、超限、超时和断开时统一释放，错误响应前继续排空请求而不销毁连接。 */
function readConfigBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    const cleanup = () => {
      clearTimeout(timer)
      req.off('data', onData).off('end', onEnd).off('aborted', onAborted).off('error', onAborted)
    }
    const fail = (error: WebPackageError) => { cleanup(); req.resume(); reject(error) }
    const onAborted = () => fail(new WebPackageError('配置请求已中断'))
    const onData = (chunk: Buffer) => {
      size += chunk.length
      if (size > 8192) { fail(new WebPackageError('配置内容过大', 413)); return }
      chunks.push(Buffer.from(chunk))
    }
    const onEnd = () => {
      cleanup()
      try {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
        resolve(value as Record<string, unknown>)
      } catch { reject(new WebPackageError('配置内容格式无效')) }
    }
    const timer = setTimeout(() => fail(new WebPackageError('配置请求读取超时', 408)), 5000)
    req.on('data', onData).once('end', onEnd).once('aborted', onAborted).once('error', onAborted)
  })
}

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing ${name}`)
  return value
}

function reply(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(value))
}

function cors(req: IncomingMessage, res: ServerResponse): boolean {
  const requestOrigin = req.headers.origin
  if (requestOrigin && requestOrigin !== pageOrigin) { reply(res, 403, { error: 'Origin denied' }); return false }
  res.setHeader('Access-Control-Allow-Origin', pageOrigin)
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, ClientId, X-Unity-Platform, Content-Type, tenant-id')
  res.setHeader('Vary', 'Origin')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return false }
  return true
}

function contentType(file: string): string {
  const plain = file.endsWith('.br') ? file.slice(0, -3) : file
  if (plain.endsWith('.js')) return 'application/javascript'
  if (plain.endsWith('.wasm')) return 'application/wasm'
  if (plain.endsWith('.json')) return 'application/json'
  if (plain.endsWith('.html')) return 'text/html; charset=utf-8'
  return 'application/octet-stream'
}

function serveFile(root: string, relative: string, res: ServerResponse): void {
  if (relative.includes('\\') || relative.includes('\0')) { reply(res, 400, { error: 'Bad path' }); return }
  const file = path.resolve(root, relative)
  let size: number
  // 每次请求只读取一次文件状态；更新资源目录时文件可能恰好被移走，统一返回缺失而不抛出进程异常。
  try {
    if (!file.startsWith(root + path.sep)) throw new Error()
    assertPackageFile(packages.assetRoot, file)
    const fileStat = statSync(file)
    if (!fileStat.isFile()) throw new Error()
    size = fileStat.size
  }
  catch { reply(res, 404, { error: 'Not found' }); return }
  res.writeHead(200, {
    'Content-Type': contentType(file), 'Content-Length': size,
    ...(file.endsWith('.br') ? { 'Content-Encoding': 'br' } : {}),
    'Cache-Control': 'no-store',
  })
  // 读取期间文件发生变更或客户端断开时释放流，防止未处理的文件错误和无效磁盘读取。
  const stream = createReadStream(file)
  stream.on('error', () => res.destroy())
  res.once('close', () => stream.destroy())
  stream.pipe(res)
}

async function profile(token: string, clientId: string, platform: string, tenantId?: string): Promise<string> {
  const endpoint = adminApi ? '/admin-api/system/auth/get-permission-info' :
    platform === 'tenant' ? '/api/tenant/profile/getInfo' : '/api/system/user/getInfo'
  const response = await fetch(new URL(endpoint, backend), {
    headers: { Authorization: token, ClientId: clientId, ...(tenantId ? { 'tenant-id': tenantId } : {}) }, signal: AbortSignal.timeout(10000),
  })
  const body = await response.json() as { code?: number; data?: { user?: { userId?: string | number; id?: string | number } } }
  const userId = adminApi ? body?.data?.user?.id : body?.data?.user?.userId
  if (!response.ok || body.code !== 200 || (typeof userId !== 'string' && typeof userId !== 'number') || !String(userId).trim()) {
    throw new Error('Profile rejected')
  }
  return String(userId)
}

async function bootstrap(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const token = req.headers.authorization
  const clientId = req.headers.clientid
  const platform = req.headers['x-unity-platform']
  const tenantId = req.headers['tenant-id']
  if (typeof token !== 'string' || !/^Bearer\s+\S+$/i.test(token) || typeof clientId !== 'string' || !clientId.trim() ||
      (platform !== 'operation' && platform !== 'tenant')) { reply(res, 401, { error: 'Login required' }); return }
  if (adminApi && (typeof tenantId !== 'string' || !/^[1-9]\d{0,18}$/.test(tenantId))) {
    reply(res, 401, { error: 'Tenant required' }); return
  }
  let userId: string
  try { userId = await profile(token, clientId, platform, typeof tenantId === 'string' ? tenantId : undefined) }
  catch { reply(res, 401, { error: 'Login expired or profile unavailable' }); return }
  const deployment = packages.activeDeployment()
  const { descriptor, descriptorSha256 } = deployment
  pruneSessions()
  // 来源目录和构建文件共同参与快照编号；相同版本的并发场景复用同一快照。
  const deploymentId = createHash('sha256').update(deployment.playerRoot).update(descriptorSha256)
    .update(JSON.stringify(deployment.build)).digest('hex').slice(0, 24)
  deployments.set(deploymentId, deployment)
  const playerBaseUrl = `./unity-runtime/packages/${deploymentId}/player/`
  const build = Object.fromEntries(Object.entries(deployment.build).map(([key, file]) => [key, `${playerBaseUrl}${file}`]))
  build.streamingAssetsUrl = `${playerBaseUrl}StreamingAssets`
  const session = randomUUID()
  sessions.set(session, { token, clientId, ...(typeof tenantId === 'string' ? { tenantId } : {}), expiresAt: Date.now() + 60 * 60 * 1000, deploymentId })
  reply(res, 200, {
    build: { ...build, threadsRequired: true },
    art: { projectId: process.env.UNITY_WEB_DEV_PROJECT_ID || '1', descriptorBase64: descriptor.toString('base64'),
      descriptorSha256, releaseBaseUrl: `${origin}/art/${deploymentId}/`, allowedOrigins: [origin] },
    business: { projectName: process.env.UNITY_WEB_DEV_PROJECT_NAME || '9tyf',
      apiBaseUrl: `${origin}/session/${session}`, userId, allowedApiOrigins: [origin] },
  })
}

/** 沿用业务后端身份校验，系统配置只对运营端开放，不能匿名读写服务器目录。 */
async function configurePackages(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  const token = req.headers.authorization
  const clientId = req.headers.clientid
  const tenantId = req.headers['tenant-id']
  if (!token || !/^Bearer\s+\S+$/i.test(token) || typeof clientId !== 'string' || !clientId.trim() ||
      (adminApi && (typeof tenantId !== 'string' || !/^[1-9]\d{0,18}$/.test(tenantId)))) {
    reply(res, 401, { error: '请先登录后管理配置' }); return
  }
  if (req.headers['x-unity-platform'] !== 'operation') { reply(res, 403, { error: '仅运营端可以管理系统配置' }); return }
  try { await profile(token, clientId, 'operation', typeof tenantId === 'string' ? tenantId : undefined) }
  catch { reply(res, 401, { error: '登录已失效或身份服务不可用' }); return }
  try {
    if (req.method === 'GET' && pathname === '/config/webgpu') { reply(res, 200, packages.snapshot()); return }
    // 文件夹选择与配置读写共用运营端身份校验，查询范围限定为项目公共资源目录。
    if (req.method === 'GET' && pathname === '/config/webgpu/directories') {
      const directory = new URL(req.url || '/', origin).searchParams.get('path') || ''
      reply(res, 200, packages.directories(directory))
      return
    }
    if (!((req.method === 'PUT' && pathname === '/config/webgpu') || (req.method === 'POST' && pathname === '/config/webgpu/check'))) {
      reply(res, 405, { error: '不支持的配置操作' }); return
    }
    if (!req.headers['content-type']?.startsWith('application/json')) throw new WebPackageError('配置请求需使用结构化数据格式', 415)
    const input = await readConfigBody(req)
    reply(res, 200, req.method === 'PUT' ? packages.save(input, input.revision) : { checks: packages.check(input) })
  } catch (error) {
    reply(res, error instanceof WebPackageError ? error.status : 500,
      { error: error instanceof WebPackageError ? error.message : '配置保存失败，请检查配置目录写入权限' })
  }
}

function proxyBusiness(req: IncomingMessage, res: ServerResponse, pathname: string, search: string): void {
  const match = /^\/session\/([0-9a-f-]{36})(\/.*)$/.exec(pathname)
  const session = match && sessions.get(match[1])
  if (!match || !session || session.expiresAt <= Date.now()) { reply(res, 401, { error: 'Session expired' }); return }
  // 共享验收入口仅开放Unity启动所需的只读业务域；页面保存通过独立的管理接口完成。
  if (publicOrigin && (req.method !== 'GET' || !/^\/(?:dim3d|dimensions)\/[\w/-]+$/.test(match[2]))) {
    reply(res, 404, { error: 'Not found' }); return
  }
  const target = new URL(`/${adminApi ? 'admin-api' : 'api'}${match[2]}`, backend)
  target.search = search
  const upstream = httpRequest(target, {
    method: req.method, headers: {
      ...req.headers, host: target.host, authorization: session.token, clientid: session.clientId,
      ...(session.tenantId ? { 'tenant-id': session.tenantId } : {}),
    }, timeout: 30000,
  }, response => {
    res.writeHead(response.statusCode || 502, response.headers)
    response.pipe(res)
  })
  upstream.on('error', () => { if (!res.headersSent) reply(res, 502, { error: 'Business API unavailable' }); else res.end() })
  req.pipe(upstream)
}

const handleRequest = (req: IncomingMessage, res: ServerResponse) => {
  if (!cors(req, res)) return
  const url = new URL(req.url || '/', origin)
  let pathname: string
  try { pathname = decodeURIComponent(url.pathname) }
  catch { reply(res, 400, { error: 'Bad path' }); return }
  if (req.method === 'GET' && pathname === '/health') { reply(res, 200, { status: 'ready' }); return }
  if (pathname === '/config/webgpu' || pathname === '/config/webgpu/check' || pathname === '/config/webgpu/directories') {
    void configurePackages(req, res, pathname).catch(() => { if (!res.headersSent) reply(res, 500, { error: '配置服务暂时不可用' }) })
    return
  }
  if (req.method === 'GET' && pathname === '/bootstrap') {
    void bootstrap(req, res).catch(() => reply(res, 503, { error: 'Unity Web deployment unavailable' }))
    return
  }
  if (req.method === 'GET' && pathname.startsWith('/packages/')) {
    pruneSessions()
    const match = /^\/packages\/([0-9a-f]{24})\/player\/(.+)$/.exec(pathname)
    const deployment = match && deployments.get(match[1])
    if (!match || !deployment) { reply(res, 404, { error: '资源包会话不存在或已过期' }); return }
    const relative = match[2]
    if (/^StreamingAssets\/(?:Config|Windows)(?:\/|$)/i.test(relative)) {
      reply(res, 404, { error: 'Not found' }); return
    }
    serveFile(deployment.playerRoot, relative, res); return
  }
  if (req.method === 'GET' && pathname.startsWith('/art/')) {
    pruneSessions()
    const match = /^\/art\/([0-9a-f]{24})\/(.+)$/.exec(pathname)
    const deployment = match && deployments.get(match[1])
    if (!match || !deployment) { reply(res, 404, { error: '资源包会话不存在或已过期' }); return }
    if (/^(?:ArtReleaseManifest|ArtPackManifest|ArtResourceCatalog)\.json$/.test(match[2])) {
      res.once('finish', () => console.log(`Unity art metadata ${pathname} ${res.statusCode}`))
    }
    serveFile(deployment.artRoot, match[2], res); return
  }
  if (pathname.startsWith('/session/')) { proxyBusiness(req, res, pathname, url.search); return }
  reply(res, 404, { error: 'Not found' })
}
// 部署时由外层网关终止TLS，内部服务只监听环回地址，无需读取服务器私钥。
const server = publicOrigin ? createHttpServer(handleRequest) : createHttpsServer({
  key: readFileSync(required('UNITY_WEB_DEV_TLS_KEY')), cert: readFileSync(required('UNITY_WEB_DEV_TLS_CERT')),
}, handleRequest)
server.listen(port, host, () => console.log(`Unity Web local gateway listening on ${origin}`))
process.on('SIGINT', () => server.close())
process.on('SIGTERM', () => server.close())
