import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createSceneDefinition } from '@/scene-platform'
import { serializeSceneDefinitionToFourPackages } from '@/integrations/scene/sceneFourPackage'
import { assembleSceneDefinitionFromRuntimeFragments } from '@/integrations/scene/sceneRuntimeFragmentAssembler'
import { saveEditorSceneToDim3d } from '@/integrations/scene/editorDim3dSceneSaveService'
import type { Dim3dSceneSaveAllBody } from '@/servers/manual/dim3d/api/sceneRuntime'
import { projectSceneForUnity } from '../runtime/projectSceneForUnity'
import fixture from './fixtures/instanceDefinition.json'

const scene = () => createSceneDefinition({
  id: '101', name: '实例配置往返', type: 'local3d',
  coordinateSystem: { kind: 'local', unit: 'meter', upAxis: 'Y', gridEnabled: true },
  objects: ['42', '43'].map((id, order) => {
    const definition = structuredClone(fixture)
    definition.identity.instanceId = id
    definition.pages.base.properties[0]!.value = id === '42' ? 80 : 95
    return { id, name: `模型${id}`, type: 'model' as const, order, visible: true, locked: false,
      transform: { kind: 'local' as const, position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: 1 },
      asset: { id: fixture.resource.resourceId, kind: 'glb' as const, url: '/memory-model.glb' },
      metadata: { instanceDefinition: definition } }
  }),
})

describe('实例配置随正式四包及Unity投影往返', () => {
  it('本地节点父级和顺序随四包往返并投影到Unity', () => {
    const original = scene()
    original.objects[0]!.parentInstanceId = '43'
    const packages = serializeSceneDefinitionToFourPackages(original)
    const restored = assembleSceneDefinitionFromRuntimeFragments({ manifest: {
      fragmentType: 'manifest', fragmentKey: '101', contentJson: JSON.stringify(packages),
    }, options: { sceneId: '101', sceneType: 'local3d', resolvedAssetUrls: { [fixture.resource.resourceId]: '/memory-model.glb' } } })
    expect(projectSceneForUnity(restored).objects.find((object) => object.instanceId === '42'))
      .toMatchObject({ parentInstanceId: '43', siblingOrder: 0 })
  })

  it('通过现有saveAll适配保存并恢复两个模型，保留未知配置且不改原草稿', async () => {
    const original = scene()
    const before = JSON.stringify(original)
    let body: Dim3dSceneSaveAllBody | undefined
    await saveEditorSceneToDim3d(original, { sceneId: '101', lockToken: 'fixture-only', baseRevisionNo: 7 }, {
      createRequestId: () => 'core01-fixture',
      // 仅替代传输，实际四包转换及成功回执判断均调用生产代码；不访问真实服务器。
      saveAll: async (value) => { body = value; return { code: 200, data: { sceneId: '101', conflict: false, revisionNo: 8 } } },
    })
    expect(body?.baseRevisionNo).toBe(7)
    const restored = assembleSceneDefinitionFromRuntimeFragments({ manifest: {
      fragmentType: 'manifest', fragmentKey: '101', contentJson: JSON.stringify(body),
    }, options: { sceneId: '101', sceneType: 'local3d', resolvedAssetUrls: { [fixture.resource.resourceId]: '/memory-model.glb' } } })
    const projected = projectSceneForUnity(restored)
    expect(projected.objects).toHaveLength(2)
    const definitions = projected.objects.map((object) => object.properties.instanceDefinition as typeof fixture)
    expect(definitions.map((d) => d.pages.base.properties[0]!.value)).toEqual([80, 95])
    expect(definitions.map((d) => d.pages.base.name)).toEqual(['模型42', '模型43'])
    expect(definitions[0]?.vendorExtension).toEqual(fixture.vendorExtension)
    expect(definitions[0]?.pages.data.bindings).toEqual(fixture.pages.data.bindings)
    expect(JSON.stringify(original)).toBe(before)
    // 可选输出正式前端产物，交给当前Unity Editor读入；不包含模拟锁令牌或回执。
    const output = process.env.CORE_CONFIG_OUTPUT
    if (output) {
      mkdirSync(dirname(output), { recursive: true })
      writeFileSync(output, JSON.stringify({ sceneId: projected.id, sceneType: projected.type,
        revisionNo: projected.revisionNo, objects: projected.objects, resources: projected.resources }, null, 2), 'utf8')
    }
  })

  it('对象改名后保存和渲染使用同一名称投影', () => {
    const original = scene(); original.objects[0]!.name = '改名后的模型'
    const saved = JSON.parse(serializeSceneDefinitionToFourPackages(original).threeDJson)
    expect(saved.objects[0].contentJson.metadata.instanceDefinition.pages.base.name).toBe('改名后的模型')
    expect((projectSceneForUnity(original).objects[0]!.properties.instanceDefinition as typeof fixture).pages.base.name).toBe('改名后的模型')
  })

  it.each(['sceneId', 'instanceId'] as const)('错配%s在保存和渲染入口均拒绝', (field) => {
    const original = scene()
    const definition = original.objects[0]!.metadata!.instanceDefinition as typeof fixture
    definition.identity[field] = 'other'
    expect(() => serializeSceneDefinitionToFourPackages(original)).toThrow('身份不一致')
    expect(() => projectSceneForUnity(original)).toThrow('身份不一致')
  })

  it('资源身份错配及未来配置版本不静默保存', () => {
    const original = scene()
    const definition = original.objects[0]!.metadata!.instanceDefinition as typeof fixture
    definition.resource.resourceId = '2115735432249536514'
    expect(() => serializeSceneDefinitionToFourPackages(original)).toThrow('资源身份不一致')
    definition.resource.resourceId = fixture.resource.resourceId
    definition.schemaVersion = 'future'
    expect(() => projectSceneForUnity(original)).toThrow('版本不受支持')
  })

  it('运行测量不能写入绑定定义', () => {
    const original = scene()
    const definition = original.objects[0]!.metadata!.instanceDefinition as typeof fixture
    Object.assign(definition.pages.data.bindings[0]!.fields[0]!, { value: 99 })
    expect(() => serializeSceneDefinitionToFourPackages(original)).toThrow('不能保存实时测量值')
  })

  it('没有新版配置的旧模型保持原保存与投影入口', () => {
    const original = scene()
    delete original.objects[0]!.metadata!.instanceDefinition
    expect(projectSceneForUnity(original).objects[0]!.properties).not.toHaveProperty('instanceDefinition')
    expect(() => serializeSceneDefinitionToFourPackages(original)).not.toThrow()
  })
})
