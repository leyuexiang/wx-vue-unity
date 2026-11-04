import { fileURLToPath, URL } from 'node:url'
import { existsSync, readdirSync } from 'node:fs'
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
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  const componentDirectory = path.resolve('node_modules/element-plus/es/components')
  // 懒加载页面会逐步发现组件样式，预先列举真实入口可避免首访反复预构建及整页重载。
  const componentStyles = readdirSync(componentDirectory, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(path.join(componentDirectory, entry.name, 'style/css.mjs')))
    .map(entry => `element-plus/es/components/${entry.name}/style/css`)
  return {
  base: env.VITE_BASE_URL || '/',
  plugins: [vue(), vueJsx(), tailwindcss(), boundedImportMetaFilter(),
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
      // 同源部署时业务与独立鉴权均走 /api；配置为空时由部署网关负责转发。
      ...(env.VITE_DIM3D_SERVER_URL ? { '/api': { target: env.VITE_DIM3D_SERVER_URL, changeOrigin: true } } : {}),
      ...(env.VITE_DATA_MIDDLEWARE_URL && env.VITE_DATA_MIDDLEWARE_PREFIX ? {
        [env.VITE_DATA_MIDDLEWARE_PREFIX]: { target: env.VITE_DATA_MIDDLEWARE_URL, changeOrigin: true,
          rewrite: (requestPath: string) => requestPath.slice(env.VITE_DATA_MIDDLEWARE_PREFIX.length) || '/' },
      } : {}),
    },
  },
  preview: {
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
