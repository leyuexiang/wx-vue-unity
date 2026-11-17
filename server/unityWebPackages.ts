import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** 配置保存播放器文件夹相对位置，例如 unity-web/player，开发和发布共用同一份结构。 */
export interface WebPackageConfig {
  active: 'stable' | 'development'
  packages: { stable: string; development: string }
}
export class WebPackageError extends Error {
  status: number
  constructor(message: string, status = 400) { super(message); this.status = status }
}
export interface WebPackageDeployment {
  playerRoot: string
  artRoot: string
  descriptor: Buffer
  descriptorSha256: string
  build: Record<string, string>
}

/** 不接受磁盘绝对位置、网址、父目录和转义字符，避免把项目外文件暴露为静态资源。 */
function normalizePackagePath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 240) throw new WebPackageError('资源包位置格式无效')
  const normalized = value.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '')
  if (!normalized) return ''
  if (normalized.split('/').some(part => !part || part === '.' || part === '..') || /[:%?#\x00-\x1f]/.test(normalized)) {
    throw new WebPackageError('请选择当前项目公共资源目录内的文件夹')
  }
  return normalized
}

/** 文件系统真实路径再检查一次，目录联接也不能绕过公共目录边界。 */
export function assertPackageFile(root: string, file: string): void {
  const relative = path.relative(realpathSync(root), realpathSync(file))
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new WebPackageError('资源包必须位于当前项目公共资源目录内')
  }
}

/** 仅扫描一次构建目录，描述文件很小；大体积数据和程序始终由网关流式发送。 */
export function inspectWebPackage(assetRoot: string, relative: string): WebPackageDeployment {
  if (!relative) throw new WebPackageError('请先选择播放器文件夹')
  const playerRoot = path.resolve(assetRoot, relative)
  const root = path.dirname(playerRoot)
  try {
    // 先检查交付根目录，目录联接指向项目外且尚缺 player 时也能准确拒绝。
    assertPackageFile(assetRoot, root)
    assertPackageFile(assetRoot, playerRoot)
    if (path.basename(playerRoot).toLowerCase() !== 'player') {
      throw new WebPackageError('请选择包含 Build 目录的 player 文件夹')
    }
    // 播放器与配套美术资源共用上一级交付目录，选择播放器后自动关联，保证版本一致。
    const buildRoot = path.join(playerRoot, 'Build')
    assertPackageFile(assetRoot, buildRoot)
    const names = readdirSync(buildRoot)
    const fields = [
      ['loaderUrl', ['.loader.js']], ['dataUrl', ['.data.br', '.data']],
      ['frameworkUrl', ['.framework.js.br', '.framework.js']], ['codeUrl', ['.wasm.br', '.wasm']],
    ] as const
    const build: Record<string, string> = {}
    for (const [field, suffixes] of fields) {
      const name = suffixes.map(suffix => names.find(name => name.endsWith(suffix))).find(Boolean)
      if (!name) throw new WebPackageError(`资源包缺少播放器文件：${field}`)
      const file = path.join(buildRoot, name)
      assertPackageFile(assetRoot, file)
      const fileStat = statSync(file)
      if (!fileStat.isFile() || fileStat.size === 0) throw new WebPackageError('播放器文件为空或无效')
      build[field] = `Build/${encodeURIComponent(name)}`
    }
    const descriptorFile = path.join(root, 'ArtStartupRelease.json')
    assertPackageFile(assetRoot, descriptorFile)
    // 启动描述和清单必须是有效对象，避免选中空文件后到场景启动时才报错。
    const readJson = (file: string): Buffer => {
      assertPackageFile(assetRoot, file)
      if (statSync(file).size > 8 * 1024 * 1024) throw new WebPackageError('启动描述或资源清单过大')
      const bytes = readFileSync(file)
      const json: unknown = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''))
      if (!json || typeof json !== 'object' || Array.isArray(json)) throw new WebPackageError('启动描述或资源清单格式无效')
      return bytes
    }
    const descriptor = readJson(descriptorFile)
    const artBase = path.join(root, 'art')
    const artRoot = existsSync(path.join(artBase, 'ArtReleaseManifest.json')) ? artBase : path.join(artBase, '9tyf')
    readJson(path.join(artRoot, 'ArtReleaseManifest.json'))
    return { playerRoot, artRoot, descriptor, build,
      descriptorSha256: `sha256:${createHash('sha256').update(descriptor).digest('hex')}` }
  } catch (error) {
    if (error instanceof WebPackageError) throw error
    throw new WebPackageError('资源包不完整：请确认播放器、启动描述和美术资源清单均已放入该目录')
  }
}

/** 网关内单一配置源；原子替换保证保存失败不改变生效版本，修订号阻止多页面相互覆盖。 */
export function createWebPackageStore(projectRoot: string) {
  const assetRoot = existsSync(path.join(projectRoot, 'public')) ? path.join(projectRoot, 'public') : projectRoot
  const configFile = path.join(projectRoot, 'config/webgpu-packages.json')
  /** 兼容旧版交付根目录配置，读取或保存时统一转换为播放器这一层。 */
  const normalizePlayerPath = (value: unknown): string => {
    const relative = normalizePackagePath(value)
    if (!relative || path.posix.basename(relative).toLowerCase() === 'player') return relative
    return `${relative}/player`
  }
  const normalize = (value: unknown): WebPackageConfig => {
    const input = value as Partial<WebPackageConfig> | null
    if (!input || (input.active !== 'stable' && input.active !== 'development') || !input.packages) {
      throw new WebPackageError('资源包配置格式无效')
    }
    const packages = {
      stable: normalizePlayerPath(input.packages.stable),
      development: normalizePlayerPath(input.packages.development),
    }
    if (!packages[input.active]) throw new WebPackageError('当前使用的版本必须选择播放器文件夹')
    return { active: input.active, packages }
  }
  let config = normalize(existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8').replace(/^\uFEFF/, '')) :
    { active: 'stable', packages: { stable: 'unity-web/player', development: '' } })
  const revision = () => createHash('sha256').update(JSON.stringify(config)).digest('hex')
  const check = (value: unknown) => {
    const draft = normalize(value)
    return Object.fromEntries((['stable', 'development'] as const).map(key => {
      if (!draft.packages[key]) return [key, { ready: false, message: '尚未选择播放器文件夹' }]
      try { inspectWebPackage(assetRoot, draft.packages[key]); return [key, { ready: true, message: '资源包检查通过' }] }
      catch (error) { return [key, { ready: false, message: (error as Error).message }] }
    })) as Record<'stable' | 'development', { ready: boolean; message: string }>
  }
  return {
    assetRoot,
    /** 弹窗按层读取当前项目目录，只返回文件夹名称与相对路径，不递归扫描大体积包内容。 */
    directories(value: unknown) {
      const relative = normalizePackagePath(value)
      const directory = path.resolve(assetRoot, relative)
      try {
        assertPackageFile(assetRoot, directory)
        const entries = readdirSync(directory, { withFileTypes: true })
        const directories = entries
          .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
          .map(entry => ({ name: entry.name, path: path.posix.join(relative, entry.name) }))
          .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN', { numeric: true }))
        let selection = { ready: false, message: '请进入需要使用的 player 文件夹' }
        if (path.basename(directory).toLowerCase() === 'player') {
          try {
            inspectWebPackage(assetRoot, relative)
            selection = { ready: true, message: '播放器及配套资源检查通过' }
          } catch (error) {
            selection = { ready: false, message: (error as Error).message }
          }
        }
        return { path: relative, directories, selection }
      } catch (error) {
        if (error instanceof WebPackageError) throw error
        throw new WebPackageError('文件夹不存在或暂时无法访问，请返回公共资源目录重新选择')
      }
    },
    snapshot: () => ({ ...structuredClone(config), revision: revision(), checks: check(config) }),
    check,
    activeDeployment: () => inspectWebPackage(assetRoot, config.packages[config.active]),
    save(value: unknown, expectedRevision: unknown) {
      if (expectedRevision !== revision()) throw new WebPackageError('配置已被其他页面修改，请重新加载后再保存', 409)
      const draft = normalize(value)
      const checks = check(draft)
      if (!checks[draft.active].ready) throw new WebPackageError(checks[draft.active].message)
      mkdirSync(path.dirname(configFile), { recursive: true })
      const temporary = `${configFile}.${randomUUID()}.tmp`
      try {
        writeFileSync(temporary, JSON.stringify(draft, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' })
        renameSync(temporary, configFile)
      } finally { if (existsSync(temporary)) unlinkSync(temporary) }
      config = draft
      return { ...structuredClone(config), revision: revision(), checks }
    },
  }
}
