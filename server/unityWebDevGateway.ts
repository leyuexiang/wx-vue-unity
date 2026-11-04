import { createServer as createHttpsServer } from 'node:https'
import { request as httpRequest } from 'node:http'
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { randomUUID, createHash } from 'node:crypto'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

// Local integration only. The browser's login token is checked against the existing
// profile API; the Unity player receives a short-lived opaque proxy URL, not the token.
const host = '127.0.0.1'
const port = Number(process.env.UNITY_WEB_DEV_PORT || 5191)
const pageOrigin = process.env.UNITY_WEB_DEV_PAGE_ORIGIN || 'http://localhost:5180'
const backend = new URL(process.env.UNITY_WEB_DEV_BACKEND || 'http://192.168.10.148:12522')
// 默认与148本项目管理API一致，旧参考部署可显式配置reference。
const adminApi = process.env.UNITY_WEB_DEV_API_MODE !== 'reference'
const playerRoot = path.resolve(required('UNITY_WEB_DEV_PLAYER_DIR'))
const artRoot = path.resolve(required('UNITY_WEB_DEV_ART_DIR'))
const descriptor = readFileSync(required('UNITY_WEB_DEV_DESCRIPTOR_FILE'))
const descriptorSha256 = `sha256:${createHash('sha256').update(descriptor).digest('hex')}`
const tls = { key: readFileSync(required('UNITY_WEB_DEV_TLS_KEY')), cert: readFileSync(required('UNITY_WEB_DEV_TLS_CERT')) }
const origin = `https://localhost:${port}`
const sessions = new Map<string, { token: string; clientId: string; tenantId?: string; expiresAt: number }>()

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
  if (!file.startsWith(root + path.sep) || !existsSync(file) || !statSync(file).isFile()) {
    reply(res, 404, { error: 'Not found' }); return
  }
  const size = statSync(file).size
  res.writeHead(200, {
    'Content-Type': contentType(file), 'Content-Length': size,
    ...(file.endsWith('.br') ? { 'Content-Encoding': 'br' } : {}),
    'Cache-Control': 'no-store',
  })
  createReadStream(file).pipe(res)
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
  const files = [
    ['loaderUrl', ['.loader.js']], ['dataUrl', ['.data.br', '.data']],
    ['frameworkUrl', ['.framework.js.br', '.framework.js']], ['codeUrl', ['.wasm.br', '.wasm']],
  ] as const
  const names = readdirSync(path.join(playerRoot, 'Build'))
  const build: Record<string, string> = {}
  for (const [key, suffixes] of files) {
    const name = suffixes.map(suffix => names.find(value => value.endsWith(suffix))).find(Boolean)
    if (!name) { reply(res, 503, { error: `Unity build file missing: ${key}` }); return }
    build[key] = `${origin}/unity-web/Build/${encodeURIComponent(name)}`
  }
  build.streamingAssetsUrl = `${origin}/unity-web/StreamingAssets`
  for (const [key, value] of sessions) if (value.expiresAt <= Date.now()) sessions.delete(key)
  const session = randomUUID()
  sessions.set(session, { token, clientId, ...(typeof tenantId === 'string' ? { tenantId } : {}), expiresAt: Date.now() + 60 * 60 * 1000 })
  reply(res, 200, {
    build: { ...build, threadsRequired: true },
    art: { projectId: process.env.UNITY_WEB_DEV_PROJECT_ID || '1', descriptorBase64: descriptor.toString('base64'),
      descriptorSha256, releaseBaseUrl: `${origin}/art/`, allowedOrigins: [origin] },
    business: { projectName: process.env.UNITY_WEB_DEV_PROJECT_NAME || '9tyf',
      apiBaseUrl: `${origin}/session/${session}`, userId, allowedApiOrigins: [origin] },
  })
}

function proxyBusiness(req: IncomingMessage, res: ServerResponse, pathname: string, search: string): void {
  const match = /^\/session\/([0-9a-f-]{36})(\/.*)$/.exec(pathname)
  const session = match && sessions.get(match[1])
  if (!match || !session || session.expiresAt <= Date.now()) { reply(res, 401, { error: 'Session expired' }); return }
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

const server = createHttpsServer(tls, (req, res) => {
  if (!cors(req, res)) return
  const url = new URL(req.url || '/', origin)
  let pathname: string
  try { pathname = decodeURIComponent(url.pathname) }
  catch { reply(res, 400, { error: 'Bad path' }); return }
  if (req.method === 'GET' && pathname === '/health') { reply(res, 200, { status: 'ready' }); return }
  if (req.method === 'GET' && pathname === '/bootstrap') {
    void bootstrap(req, res).catch(() => reply(res, 503, { error: 'Unity Web deployment unavailable' }))
    return
  }
  if (req.method === 'GET' && pathname.startsWith('/unity-web/')) {
    const relative = pathname.slice('/unity-web/'.length)
    if (/^StreamingAssets\/(?:Config|Windows)(?:\/|$)/i.test(relative)) {
      reply(res, 404, { error: 'Not found' }); return
    }
    serveFile(playerRoot, relative, res); return
  }
  if (req.method === 'GET' && pathname.startsWith('/art/')) {
    if (/^\/art\/(?:ArtReleaseManifest|ArtPackManifest|ArtResourceCatalog)\.json$/.test(pathname)) {
      res.once('finish', () => console.log(`Unity art metadata ${pathname} ${res.statusCode}`))
    }
    serveFile(artRoot, pathname.slice('/art/'.length), res); return
  }
  if (pathname.startsWith('/session/')) { proxyBusiness(req, res, pathname, url.search); return }
  reply(res, 404, { error: 'Not found' })
})
server.listen(port, host, () => console.log(`Unity Web local gateway listening on ${origin}`))
process.on('SIGINT', () => server.close())
process.on('SIGTERM', () => server.close())
