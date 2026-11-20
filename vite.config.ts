import { fileURLToPath, URL } from 'node:url'
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueJsx from '@vitejs/plugin-vue-jsx'
import tailwindcss from '@tailwindcss/vite'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'
import Icons from 'unplugin-icons/vite'
import IconsResolver from 'unplugin-icons/resolver'
import { createMediaMiddleware } from './server/mediaMiddleware'

/** 复用来源的大模块预筛选修复，避免代码编辑器的工作线程转换触发正则栈溢出。 */
const boundedImportMetaFilter = (): Plugin => ({
  name: 'bounded-import-meta-filter', apply: 'serve',
  configResolved(config) {
    for (const plugin of config.plugins) {
      if (!['vite:worker-import-meta-url', 'vite:asset-import-meta-url'].includes(plugin.name)) continue
      const transform = plugin.transform
      if (transform && typeof transform === 'object' && transform.filter) transform.filter.code = 'import.meta.url'
    }
  },
})

/** 只接入页面、二维组件和媒体构建能力；云渲染使用独立传输层，不安装浏览器三维插件。 */
export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), ['VITE_', 'UNITY_WEB_LAN_REDIRECT_ORIGIN'])
  const base = env.VITE_BASE_URL || '/dts/'
  const lanRedirect = command === 'serve' && env.UNITY_WEB_LAN_REDIRECT_ORIGIN
    ? new URL(env.UNITY_WEB_LAN_REDIRECT_ORIGIN) : undefined
  if (lanRedirect && (lanRedirect.protocol !== 'https:' || lanRedirect.pathname !== '/' ||
    lanRedirect.username || lanRedirect.password || lanRedirect.search || lanRedirect.hash)) {
    throw new Error('局域网跳转地址必须是加密站点根来源')
  }
  // 启动接口与页面使用同源相对路径，部署子目录变化时统一跟随基础路径。
  const unityRuntimePrefix = new URL('unity-runtime', new URL(env.VITE_BASE_URL || '/', 'http://localhost')).pathname
  const unityRuntimeProxy = {
    [unityRuntimePrefix]: {
      target: 'https://localhost:5191',
      // 本机资源网关使用项目自行生成的证书，代理连接限定在环回开发入口。
      secure: false,
      rewrite: (requestPath: string) => requestPath.slice(unityRuntimePrefix.length) || '/',
    },
  }
  const componentDirectory = path.resolve('node_modules/element-plus/es/components')
  // 懒加载页面会逐步发现组件样式，预先列举真实入口可避免首访反复预构建及整页重载。
  const componentStyles = readdirSync(componentDirectory, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(path.join(componentDirectory, entry.name, 'style/css.mjs')))
    .map(entry => `element-plus/es/components/${entry.name}/style/css`)
  return {
  // 未提供部署配置时也使用 /dts/，确保默认构建与开发入口、静态资源路径一致。
  base,
  plugins: [vue(), vueJsx(), tailwindcss(), boundedImportMetaFilter(),
    ...(lanRedirect ? [{ name: 'redirect-lan-page-to-https', configureServer(server) {
      // 已收藏的局域网网页入口直接跳到同一主机的加密站点。接口请求和本机地址继续由开发服务处理。
      const basePath = new URL(base, 'http://localhost').pathname
      const baseRoot = basePath.replace(/\/$/, '')
      server.middlewares.use((req, res, next) => {
        const requestUrl = req.url || '/'
        const pathname = requestUrl.split('?', 1)[0]
        const isPage = pathname === '/' || pathname === baseRoot || pathname.startsWith(basePath)
        if ((req.method === 'GET' || req.method === 'HEAD') && isPage &&
          req.headers.host?.split(':', 1)[0].toLowerCase() === lanRedirect.hostname &&
          req.headers.accept?.includes('text/html')) {
          const destination = pathname === '/' ? basePath + requestUrl.slice(1) : requestUrl
          res.writeHead(302, { Location: lanRedirect.origin + destination, 'Cache-Control': 'no-store' })
          res.end()
          return
        }
        next()
      })
    } } satisfies Plugin] : []),
    {
      name: 'package-unity-web-gateway',
      // 局域网入口复用源码目录里的网关和播放器，只构建对外提供的网页文件。
      apply: (config, { command }) => command === 'build' && config.build?.copyPublicDir !== false,
      writeBundle(output) {
        // 公共目录由构建工具原样复制；额外交付只依赖运行库内置模块的启动网关。
        const serverDirectory = path.resolve(output.dir || 'dist/web-unity', 'server')
        mkdirSync(serverDirectory, { recursive: true })
        // 配置存储模块随网关一起交付，生产环境不依赖源码目录。
        for (const file of ['unityWebDevGateway.ts', 'unityWebPackages.ts']) {
          copyFileSync(fileURLToPath(new URL(`./server/${file}`, import.meta.url)), path.join(serverDirectory, file))
        }
        const packageConfig = fileURLToPath(new URL('./config/webgpu-packages.json', import.meta.url))
        if (existsSync(packageConfig)) {
          const configDirectory = path.resolve(serverDirectory, '../config')
          mkdirSync(configDirectory, { recursive: true })
          copyFileSync(packageConfig, path.join(configDirectory, 'webgpu-packages.json'))
        }
      },
    },
    AutoImport({ imports: ['vue'], resolvers: [ElementPlusResolver()], dts: command === 'serve' ? 'src/auto-imports.d.ts' : false }),
    Components({ resolvers: [IconsResolver({ enabledCollections: ['ep'] }), ElementPlusResolver()], dts: command === 'serve' ? 'src/components.d.ts' : false }),
    Icons({ autoInstall: true }),
    ...(command === 'serve' ? [{ name: 'local-media-ingest', configureServer(server) {
      // 媒体管理配置仅供服务端读取，不进入浏览器环境变量。
      server.middlewares.use(createMediaMiddleware({ env: loadEnv(mode, process.cwd(), 'MEDIA_'), development: true }))
    } } satisfies Plugin] : []),
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  optimizeDeps: { include: ['element-plus', 'element-plus/es', 'lodash-es', ...componentStyles] },
  server: {
    host: '0.0.0.0',
    // 本机联调使用资源服务已允许的页面来源，端口可由部署环境显式指定。
    port: Number(env.VITE_DEV_SERVER_PORT || 5180),
    strictPort: true,
    headers: {
      'Cache-Control': 'no-store',
      'Cross-Origin-Opener-Policy': 'same-origin',
      // Unity GIS 的原生线程需要 SharedArrayBuffer；credentialless 也允许二维外部图片无凭据加载。
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
    // 保留来源业务请求契约，只有配置了目标地址才创建代理，避免空地址导致启动失败。
    proxy: {
      ...unityRuntimeProxy,
      // 同源部署时业务与独立鉴权均走 /api；配置为空时由部署网关负责转发。
      ...(env.VITE_DIM3D_SERVER_URL ? { '/api': { target: env.VITE_DIM3D_SERVER_URL, changeOrigin: true } } : {}),
      ...(env.VITE_DATA_MIDDLEWARE_URL && env.VITE_DATA_MIDDLEWARE_PREFIX ? {
        [env.VITE_DATA_MIDDLEWARE_PREFIX]: { target: env.VITE_DATA_MIDDLEWARE_URL, changeOrigin: true,
          rewrite: (requestPath: string) => requestPath.slice(env.VITE_DATA_MIDDLEWARE_PREFIX.length) || '/' },
      } : {}),
    },
  },
  preview: {
    // 本机检查发布产物时沿用同一个相对启动入口。
    proxy: unityRuntimeProxy,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
  },
  build: {
    outDir: 'dist/web-unity',
  },
  }
})
