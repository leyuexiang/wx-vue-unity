import { it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createWebPackageStore, WebPackageError } from '../unityWebPackages.ts'

/** 使用微型包验证持久化和目录边界，避免复制真实的一吉字节资源。 */
function fixture(context: { after: (callback: () => void) => void }) {
  const temporary = fileURLToPath(new URL('../../.tmp/', import.meta.url))
  mkdirSync(temporary, { recursive: true })
  const root = mkdtempSync(path.join(temporary, 'web-package-test-'))
  context.after(() => rmSync(root, { recursive: true, force: true }))
  for (const channel of ['unity-web', 'unity-web-development']) {
    const directory = path.join(root, 'public', channel)
    mkdirSync(path.join(directory, 'player/Build'), { recursive: true })
    mkdirSync(path.join(directory, 'art/9tyf'), { recursive: true })
    writeFileSync(path.join(directory, 'ArtStartupRelease.json'), '{}')
    writeFileSync(path.join(directory, 'art/9tyf/ArtReleaseManifest.json'), '{}')
    for (const suffix of ['loader.js', 'framework.js', 'data', 'wasm']) writeFileSync(path.join(directory, 'player/Build', `fixture.${suffix}`), channel)
  }
  return { root, store: createWebPackageStore(root) }
}

it('默认稳定包可用，研发包允许暂时留空', context => {
  const { store } = fixture(context)
  const snapshot = store.snapshot()
  assert.equal(snapshot.active, 'stable')
  assert.equal(snapshot.packages.stable, 'unity-web/player')
  assert.equal(snapshot.checks.stable.ready, true)
  assert.equal(snapshot.checks.development.ready, false)
})

it('配置重建后仍保留生效版本，位置按相对路径保存', context => {
  const { root, store } = fixture(context)
  const snapshot = store.snapshot()
  store.save({ ...snapshot, active: 'development', packages: { stable: './unity-web/', development: 'unity-web-development' } }, snapshot.revision)
  assert.equal(createWebPackageStore(root).snapshot().active, 'development')
  const contents = readFileSync(path.join(root, 'config/webgpu-packages.json'), 'utf8')
  assert.equal(JSON.parse(contents).packages.stable, 'unity-web/player')
  assert.ok(!contents.includes(root))
})

it('拒绝绝对位置、父目录、网址和编码绕过', context => {
  const { store } = fixture(context)
  const snapshot = store.snapshot()
  for (const location of ['D:/outside', '/outside', '../outside', 'unity-web/../../outside', 'https://site/package', '%2e%2e/outside', '\\\\server\\share']) {
    assert.throws(() => store.save({ ...snapshot, packages: { stable: location, development: '' } }, snapshot.revision), WebPackageError)
  }
  assert.equal(store.snapshot().revision, snapshot.revision)
})

it('无效生效包不覆盖原配置，过期修订号拒绝保存', context => {
  const { store } = fixture(context)
  const snapshot = store.snapshot()
  assert.throws(() => store.save({ ...snapshot, active: 'development' }, snapshot.revision), WebPackageError)
  store.save({ ...snapshot, packages: { ...snapshot.packages, development: 'unity-web-development' } }, snapshot.revision)
  assert.throws(() => store.save(snapshot, snapshot.revision), (error: unknown) => error instanceof WebPackageError && error.status === 409)
})

it('目录联接不能把项目外的播放器文件暴露给浏览器', context => {
  const { root, store } = fixture(context)
  // 窗口系统使用目录联接，无需额外符号链接权限；其他系统使用目录符号链接。
  symlinkSync(path.join(root, 'public/unity-web'), path.join(root, 'public/linked'), process.platform === 'win32' ? 'junction' : 'dir')
  const snapshot = store.snapshot()
  assert.equal(store.check({ ...snapshot, packages: { stable: 'linked', development: '' } }).stable.ready, true)
  mkdirSync(path.join(root, 'outside'))
  symlinkSync(path.join(root, 'outside'), path.join(root, 'public/escaped'), process.platform === 'win32' ? 'junction' : 'dir')
  const checks = store.check({ ...snapshot, packages: { stable: 'escaped', development: '' } })
  assert.equal(checks.stable.ready, false)
  assert.match(checks.stable.message, /公共资源目录/)
})

it('旧版交付根目录配置读取后转换到 player 层，配套美术资源保持可用', context => {
  const { root } = fixture(context)
  mkdirSync(path.join(root, 'config'))
  writeFileSync(path.join(root, 'config/webgpu-packages.json'), JSON.stringify({
    active: 'stable', packages: { stable: 'unity-web', development: 'unity-web-development' },
  }))
  const store = createWebPackageStore(root)
  assert.equal(store.snapshot().packages.stable, 'unity-web/player')
  assert.equal(store.snapshot().packages.development, 'unity-web-development/player')
  assert.equal(store.activeDeployment().playerRoot, path.join(root, 'public/unity-web/player'))
  assert.equal(store.snapshot().checks.stable.ready, true)
})

it('文件夹弹窗按层浏览，只有完整 player 目录允许选择，拒绝越界访问', context => {
  const { store } = fixture(context)
  const root = store.directories('')
  assert.deepEqual(root.directories.map(directory => directory.name), ['unity-web', 'unity-web-development'])
  assert.equal(root.selection.ready, false)
  assert.equal(store.directories('unity-web').selection.ready, false)
  const player = store.directories('unity-web/player')
  assert.equal(player.selection.ready, true)
  assert.deepEqual(player.directories, [{ name: 'Build', path: 'unity-web/player/Build' }])
  assert.equal(store.directories('unity-web/player/Build').selection.ready, false)
  assert.throws(() => store.directories('../server'), WebPackageError)
  assert.throws(() => store.directories('D:/outside'), WebPackageError)
  assert.throws(() => store.directories('does-not-exist'), WebPackageError)
})
