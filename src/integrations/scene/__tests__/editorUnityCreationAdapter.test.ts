import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'
import { DRAG_MODEL_ENUM, MODEL_ENUM } from '@/enums'
import { createSceneDefinition, createViewportHost, createUpdateObjectTransformCommand, type ViewportHost } from '@/scene-platform'
import type { SceneDefinition as UnityScene } from '@/scene-core'
import type { FileModel } from '@/types/threeScene'
import { UnityEditorSceneRuntime } from '@/unity-runtime/runtime/UnityEditorSceneRuntime'
import { createMoveSceneNodeCommand } from '@/scene-platform/commands/moveSceneNodeCommand'
import { assembleSceneDefinitionFromRuntimeFragments } from '../sceneRuntimeFragmentAssembler'
import { serializeSceneDefinitionToFourPackages } from '../sceneFourPackage'
import { createEditorUnityObject } from '../editorUnityCreationAdapter'
import { preserveUneditedThreeDDomain, releaseOriginalScenePackages, retainOriginalScenePackages } from '../twoDPackagePreservation'
import { saveEditorSceneToDim3d } from '../editorDim3dSceneSaveService'
import { saveEditorSceneDefinition } from '../editorSceneSaveAdapter'
import { setActiveSceneViewportHost, clearActiveSceneViewportHost } from '../editorScenePlatformHost'

/** 只替换播放器边界，实际执行对象映射、命令历史、桥接、双端投影和保存序列化。 */
const hosts: ViewportHost[] = []
const sceneId = '2089645792212000769'
afterEach(() => {
  clearActiveSceneViewportHost()
  hosts.splice(0).forEach((host) => host.dispose())
  releaseOriginalScenePackages(sceneId)
})
const setup = async (type: 'local3d' | 'gis' = 'local3d', mode: 'cloud' | 'webgpu' = 'webgpu') => {
  const scene = createSceneDefinition({ id: sceneId, name: '拖拽场景', type,
    coordinateSystem: type === 'gis'
      ? { kind: 'wgs84', defaultLongitude: 110, defaultLatitude: 19, defaultHeight: 5, terrainEnabled: false }
      : { kind: 'local', unit: 'meter', upAxis: 'Y', gridEnabled: true } })
  let host: ViewportHost
  const onWarnings = vi.fn()
  const runtime = new UnityEditorSceneRuntime(type, { mode, getHost: () => host, onStatus: vi.fn(), onWarnings })
  const unity = { loadScene: vi.fn(async (_draft: UnityScene) => {}), updateObject: vi.fn(async () => {}),
    setSelection: vi.fn(), disconnect: vi.fn(async () => {}) }
  Object.assign(runtime, { unity })
  vi.spyOn(runtime, 'mount').mockResolvedValue(undefined)
  host = createViewportHost({ container: {} as HTMLElement, scene, runtimeFactory: () => runtime })
  // 与正式仓储加载保持一致，验证新增模型能穿过保存服务的原三维包保护。
  retainOriginalScenePackages(scene.id, serializeSceneDefinitionToFourPackages(scene))
  hosts.push(host)
  await host.mount()
  unity.loadScene.mockClear()
  const model: FileModel = reactive({ name: '资源模型', modelType: DRAG_MODEL_ENUM.CustomModel, icon: '',
    filePath: 'https://assets.test/model.glb', fileType: MODEL_ENUM.GLB,
    resourceAsset: { id: 'published-model', url: 'https://assets.test/model.glb', version: 'v1' } })
  const create = (item = model, isActive = () => true) => createEditorUnityObject(item,
    { clientX: 250, clientY: 180 }, { host, isActive })
  return { host, runtime, unity, model, create, onWarnings }
}

describe('画布模型拖拽入口', () => {
  it('将三维资源交给正式创建链路，不再被二维阶段的占位提示拦截', () => {
    // 入口契约防止后续迁移再次留下硬编码返回；运行时行为由下方的集成用例覆盖。
    const canvas = readFileSync(new URL('../../../views/sceneEdit/SceneCenter/SceneCanvas/index.vue', import.meta.url), 'utf8')
    expect(canvas.includes('三维资源将在二维验收后接入 Unity')).toBe(false)
    expect(canvas).toContain('await createEditorUnityObject(')
  })
})

describe('模型拖拽到双端运行时', () => {
  it.each([
    ['local3d', 'cloud'], ['local3d', 'webgpu'], ['gis', 'cloud'], ['gis', 'webgpu'],
  ] as const)('在%s场景通过%s创建、保存、撤销和重做同一模型', async (type, mode) => {
    const { host, unity, create } = await setup(type, mode)
    const id = await create()
    expect(id).toBeTruthy()
    const object = host.getStore().getObject(id!)!
    expect(object.asset).toMatchObject({ id: 'published-model', version: 'v1' })
    expect(host.getStore().getSelectedObjectId()).toBe(id)
    expect(unity.setSelection).toHaveBeenLastCalledWith(id)
    const draft = unity.loadScene.mock.calls[0]![0]
    expect(draft.resources).toEqual([{ resourceKey: 'published-model', assetId: 'published-model', kind: 'glb' }])
    expect(draft.objects[0]!.transform).toMatchObject({
      space: type === 'gis' ? 'wgs84' : 'local', position: type === 'gis' ? [110, 19, 5] : [0, 0, 0], scale: [1, 1, 1],
    })
    const packages = preserveUneditedThreeDDomain(sceneId, serializeSceneDefinitionToFourPackages(host.getStore().getScene()))
    expect(JSON.parse(packages.threeDJson).objects.map((item: { instanceId: string }) => item.instanceId)).toEqual([id])
    expect(JSON.parse(packages.dependenciesJson).resources[0]).toMatchObject({ assetId: 'published-model', owners: [{ domain: 'threeD', instanceId: id }] })
    expect(host.getCommandBus().getUndoSize()).toBe(1)
    host.getCommandBus().undo()
    await host.getBridge().flush()
    expect(host.getStore().getObject(id!)).toBeNull()
    const undone = preserveUneditedThreeDDomain(sceneId, serializeSceneDefinitionToFourPackages(host.getStore().getScene()))
    expect(JSON.parse(undone.threeDJson).objects).toEqual([])
    expect(JSON.parse(undone.dependenciesJson).resources).toEqual([])
    expect(unity.loadScene).toHaveBeenLastCalledWith(expect.objectContaining({ objects: [], resources: [] }))
    host.getCommandBus().redo()
    await host.getBridge().flush()
    expect(host.getStore().getObject(id!)).toMatchObject({ id, asset: object.asset })
    expect(unity.loadScene).toHaveBeenLastCalledWith(expect.objectContaining({ objects: [expect.objectContaining({ instanceId: id })] }))
  })

  it('同一资源重复拖入生成不同实例，但只登记一份资源', async () => {
    const { host, unity, create, model } = await setup()
    const first = await create({ ...model, modelType: DRAG_MODEL_ENUM.Model })
    const second = await create()
    expect(first).not.toBe(second)
    expect(host.getStore().getObjects()).toHaveLength(2)
    const latest = unity.loadScene.mock.calls.at(-1)![0]
    expect(latest.resources).toHaveLength(1)
    expect(latest.objects).toHaveLength(2)
  })

  it('正式保存服务提交的四包包含刚拖入的模型和依赖', async () => {
    const { host, create } = await setup()
    const id = await create()
    const saveAll = vi.fn(async () => ({ code: 200, data: { sceneId, conflict: false } }))
    await saveEditorSceneToDim3d(host.getStore().getScene(), { sceneId, lockToken: 'test-lock' }, {
      saveAll, createRequestId: () => 'drag-save',
    })
    const body = saveAll.mock.calls[0] as unknown as [Record<string, string>]
    expect(JSON.parse(body[0].threeDJson!).objects.map((item: { instanceId: string }) => item.instanceId)).toEqual([id])
    expect(JSON.parse(body[0].dependenciesJson!).resources[0].assetId).toBe('published-model')
  })

  it('已保存模型在 Unity 会话重新编辑后，正式保存入口提交当前变换', async () => {
    const { host, create } = await setup()
    const id = (await create())!
    retainOriginalScenePackages(sceneId, serializeSceneDefinitionToFourPackages(host.getStore().getScene()))
    const transform = { kind: 'local' as const, position: [2, 0.5, 3] as [number, number, number],
      rotation: [0, 0.5, 0] as [number, number, number], scale: [1.5, 2, 1.25] as [number, number, number] }
    host.getCommandBus().execute(createUpdateObjectTransformCommand(id, transform))
    setActiveSceneViewportHost(host)
    const saveAll = vi.fn(async () => ({ code: 200, data: { sceneId, conflict: false } }))
    await saveEditorSceneDefinition({
      widgetSceneFragment: null, sceneGlobalState: null,
      saveContext: { sceneId, lockToken: 'test-lock' },
      dim3dSaveOptions: { saveAll, createRequestId: () => 'reopened-transform' },
    })
    const body = saveAll.mock.calls[0] as unknown as [Record<string, string>]
    expect(JSON.parse(body[0].threeDJson!).objects[0]).toMatchObject({ instanceId: id, transform })
  })

  it('现有节点换父级、同级重排和撤销后可经正式保存入口重开', async () => {
    const { host, unity, create } = await setup()
    const parent = (await create())!
    const first = (await create())!
    const second = (await create())!
    const store = host.getStore()
    const commands = host.getCommandBus()
    const original = serializeSceneDefinitionToFourPackages(store.getScene())
    const raw = JSON.parse(original.threeDJson)
    raw.objects.find((node: { instanceId: string }) => node.instanceId === first).vendorField = { keep: true }
    retainOriginalScenePackages(sceneId, { ...original, threeDJson: JSON.stringify(raw) })
    const initial = store.getObject(first)!.transform
    if (initial.kind !== 'local') throw new Error('需要本地坐标')
    commands.execute(createUpdateObjectTransformCommand(parent, {
      kind: 'local', position: [4, 0, 0], rotation: [0, 0, Math.PI / 2], scale: 2,
    }))
    commands.execute(createMoveSceneNodeCommand(store, first, parent)!)
    commands.execute(createMoveSceneNodeCommand(store, second, parent)!)
    await host.getBridge().flush()
    const calls = unity.loadScene.mock.calls.length
    commands.execute(createMoveSceneNodeCommand(store, second, parent, 0)!)
    await host.getBridge().flush()
    expect(unity.loadScene.mock.calls).toHaveLength(calls + 1)
    expect(commands.undo()).toBe(true)
    expect(store.getObject(first)?.order).toBe(0)
    expect(commands.redo()).toBe(true)
    expect(store.getObject(first)?.order).toBe(1)
    expect(() => createMoveSceneNodeCommand(store, parent, first)).toThrow('后代')
    const local = store.getObject(first)!.transform
    if (local.kind !== 'local') throw new Error('需要本地坐标')
    expect(4 - 2 * local.position[1]).toBeCloseTo(initial.position[0])
    expect(2 * local.position[0]).toBeCloseTo(initial.position[1])
    expect(local.rotation[2]).toBeCloseTo(initial.rotation[2] - Math.PI / 2)
    setActiveSceneViewportHost(host)
    const saveAll = vi.fn(async () => ({ code: 200, data: { sceneId, conflict: false } }))
    await saveEditorSceneDefinition({
      widgetSceneFragment: null, sceneGlobalState: null,
      saveContext: { sceneId, lockToken: 'test-lock' },
      dim3dSaveOptions: { saveAll, createRequestId: () => 'reopened-hierarchy' },
    })
    const [saved] = saveAll.mock.calls[0] as unknown as [Record<string, string>]
    expect(JSON.parse(saved.threeDJson!).objects.find((node: { instanceId: string }) => node.instanceId === first))
      .toMatchObject({ parentInstanceId: parent, sortNo: 1, vendorField: { keep: true } })
    const restored = assembleSceneDefinitionFromRuntimeFragments({ manifest: {
      fragmentType: 'manifest', fragmentKey: sceneId, contentJson: JSON.stringify(saved),
    }, options: { sceneId, sceneType: 'local3d', resolvedAssetUrls: { 'published-model': '/model.glb' } } })
    expect(restored.objects.find((node) => node.id === first)).toMatchObject({ parentInstanceId: parent, order: 1, transform: JSON.parse(JSON.stringify(local)) })
    expect(restored.objects.find((node) => node.id === second)).toMatchObject({ parentInstanceId: parent, order: 0 })
    // 再以已保存的父子快照为基线，验证移到根时确实清除旧父级字段。
    retainOriginalScenePackages(sceneId, {
      sceneJson: saved.sceneJson!, threeDJson: saved.threeDJson!,
      twoDJson: saved.twoDJson!, dependenciesJson: saved.dependenciesJson!,
    })
    commands.execute(createMoveSceneNodeCommand(store, first, undefined)!)
    await host.getBridge().flush()
    await saveEditorSceneDefinition({
      widgetSceneFragment: null, sceneGlobalState: null,
      saveContext: { sceneId, lockToken: 'test-lock' },
      dim3dSaveOptions: { saveAll, createRequestId: () => 'reopened-root' },
    })
    const [detached] = saveAll.mock.calls[1] as unknown as [Record<string, string>]
    const detachedNode = JSON.parse(detached.threeDJson!).objects.find((node: { instanceId: string }) => node.instanceId === first)
    expect(detachedNode).not.toHaveProperty('parentInstanceId')
    expect(detachedNode.vendorField).toEqual({ keep: true })

  })

  it('换父级拒绝剪切、不可逆变换和锁定祖先', async () => {
    const { host, create } = await setup()
    const parent = (await create())!
    const child = (await create())!
    const store = host.getStore()
    const original = store.getObject(parent)!
    const transform = { kind: 'local' as const, position: [0, 0, 0] as [number, number, number],
      rotation: [0, 0, Math.PI / 4] as [number, number, number], scale: [2, 1, 1] as [number, number, number] }
    store.upsertObject({ ...original, transform })
    expect(() => createMoveSceneNodeCommand(store, child, parent)).toThrow('剪切')
    store.upsertObject({ ...original, transform: { ...transform, scale: [0, 1, 1] } })
    expect(() => createMoveSceneNodeCommand(store, child, parent)).toThrow('无法求逆')
    store.upsertObject({ ...original, locked: true })
    expect(() => createMoveSceneNodeCommand(store, child, parent)).toThrow('锁定')
    expect(store.getObject(child)?.parentInstanceId).toBeUndefined()
  })

  it('加载失败移除本次对象和历史，恢复原选择，且后续拖拽仍能成功', async () => {
    const { host, unity, create } = await setup()
    const first = await create()
    unity.loadScene.mockRejectedValueOnce(new Error('资源包完整性校验失败'))
    await expect(create()).rejects.toThrow('资源包完整性校验失败')
    expect(host.getStore().getObjects().map((object) => object.id)).toEqual([first])
    expect(host.getStore().getSelectedObjectId()).toBe(first)
    expect(host.getCommandBus().getUndoSize()).toBe(1)
    expect(host.getCommandBus().getRedoSize()).toBe(0)
    expect(unity.loadScene).toHaveBeenLastCalledWith(expect.objectContaining({ objects: [expect.objectContaining({ instanceId: first })] }))
    expect(await create()).toBeTruthy()
    expect(host.getStore().getObjects()).toHaveLength(2)
  })

  it('缺少资源身份或不支持的几何体在写入状态前拒绝创建', async () => {
    const { host, unity, model, create } = await setup()
    await expect(create({ ...model, resourceAsset: undefined })).rejects.toThrow('稳定资源编号')
    await expect(createEditorUnityObject({ name: '圆环', type: 'TorusGeometry', modelType: DRAG_MODEL_ENUM.Geometry, icon: '' },
      { clientX: 0, clientY: 0 }, { host, isActive: () => true })).rejects.toThrow('暂不支持几何体')
    expect(host.getStore().getObjects()).toEqual([])
    expect(host.getCommandBus().getUndoSize()).toBe(0)
    expect(unity.loadScene).not.toHaveBeenCalled()
  })

  it('拖入未发布模型时沿用现有缺失提示，保留可保存配置', async () => {
    const { host, unity, create, onWarnings } = await setup()
    unity.loadScene.mockRejectedValueOnce(new Error('当前美术版本不存在资源键: model/published-model'))
    const id = await create()
    expect(host.getStore().getObject(id!)).not.toBeNull()
    expect(unity.setSelection).toHaveBeenLastCalledWith(null)
    expect(onWarnings).toHaveBeenLastCalledWith([expect.stringContaining('资源 published-model')])
    expect(unity.loadScene).toHaveBeenLastCalledWith(expect.objectContaining({ objects: [], resources: [] }))
  })

  it('页面卸载后不重新选中或写入已销毁宿主', async () => {
    const { host, unity, create } = await setup()
    let finish!: () => void
    let active = true
    unity.loadScene.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
    const pending = create(undefined, () => active)
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    active = false
    host.dispose()
    unity.setSelection.mockClear()
    finish()
    expect(await pending).toBeNull()
    expect(unity.setSelection).not.toHaveBeenCalled()
    expect(host.getCommandBus().getUndoSize()).toBe(0)
  })
})
