import { afterEach, describe, expect, it } from 'vitest'
import { preserveUneditedThreeDDomain, releaseOriginalScenePackages, retainOriginalScenePackages } from '../twoDPackagePreservation'
import type { SceneFourPackagePayload } from '../sceneFourPackage'

const sceneId = 'migration-preservation'
const payload = (dependencies: object): SceneFourPackagePayload => ({
  sceneJson: JSON.stringify({ name: '原场景', customSceneExtension: { keep: true } }),
  threeDJson: '{ "objects": [{"instanceId":"三维模型","unknownFutureField":true}], "customRenderer": {"version":9} }',
  twoDJson: JSON.stringify({ canvas: { width: 1920, height: 1080 }, components: [], layerTree: [], customTwoDExtension: true }),
  dependenciesJson: JSON.stringify(dependencies),
})
afterEach(() => releaseOriginalScenePackages(sceneId))

describe('二维编辑的三维无损保存保护', () => {
  it('Unity 已接管的实例变换能保存重开，同时保留原始实例和未知扩展', () => {
    const before = payload({ resources: [{ resourceKey: 'grass', owners: [{ domain: 'threeD', instanceId: '三维模型' }] }] })
    before.threeDJson = JSON.stringify({ objects: [
      { instanceId: '三维模型', unknownFutureField: true, transform: { kind: 'local', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
      { instanceId: '未接管模型', unknownFutureField: true },
    ], customRenderer: { version: 9 } })
    retainOriginalScenePackages(sceneId, before)
    const transform = { kind: 'local', position: [2, 0.5, 3], rotation: [0, 0.5, 0], scale: [1.5, 2, 1.25] }
    const generated = { ...before, threeDJson: JSON.stringify({ objects: [
      { instanceId: '三维模型', transform }, { instanceId: '未接管模型', transform },
    ] }) }
    const saved = preserveUneditedThreeDDomain(sceneId, generated, new Set(['三维模型']))
    expect(JSON.parse(saved.threeDJson)).toEqual({ objects: [
      { instanceId: '三维模型', unknownFutureField: true, transform },
      { instanceId: '未接管模型', unknownFutureField: true },
    ], customRenderer: { version: 9 } })
    expect(JSON.parse(saved.dependenciesJson).resources).toEqual(JSON.parse(before.dependenciesJson).resources)
    expect(preserveUneditedThreeDDomain(sceneId, generated).threeDJson).toBe(before.threeDJson)
  })

  it('三维原文和未知扩展字段不受二维修改影响', () => {
    const before = payload({ futureDependency: { keep: true }, behaviors: [{ owner: { domain: 'threeD', instanceId: '三维模型' }, privateData: 42 }] })
    retainOriginalScenePackages(sceneId, before)
    const generated = { ...payload({ behaviors: [{ owner: { domain: 'twoD', instanceId: '二维按钮' }, click: true }] }),
      threeDJson: '{}', sceneJson: '{"name":"修改名称"}', twoDJson: '{"components":[{"instanceId":"二维按钮"}]}' }
    const result = preserveUneditedThreeDDomain(sceneId, generated)
    expect(result.threeDJson).toBe(before.threeDJson)
    expect(JSON.parse(result.sceneJson)).toEqual({ name: '修改名称', customSceneExtension: { keep: true } })
    expect(JSON.parse(result.twoDJson).customTwoDExtension).toBe(true)
    expect(JSON.parse(result.dependenciesJson).behaviors).toHaveLength(2)
    expect(JSON.parse(result.dependenciesJson).futureDependency).toEqual({ keep: true })
  })

  it('删除二维资源引用时保留共享资源的三维拥有者', () => {
    const owner3d = { domain: 'threeD', ownerType: 'instance', instanceId: '三维模型' }
    const owner2d = { domain: 'twoD', ownerType: 'instance', instanceId: '已删除部件' }
    retainOriginalScenePackages(sceneId, payload({ resources: [{ resourceKey: '共享图片', assetId: '图片编号', owners: [owner3d, owner2d] }] }))
    const result = preserveUneditedThreeDDomain(sceneId, payload({ resources: [] }))
    expect(JSON.parse(result.dependenciesJson).resources).toEqual([{ resourceKey: '共享图片', assetId: '图片编号', owners: [owner3d] }])
  })

  it('当前二维拥有者和原有三维拥有者合并到同一资源', () => {
    const owner3d = { domain: 'threeD', instanceId: '三维模型' }
    const owner2d = { domain: 'twoD', instanceId: '新图片' }
    retainOriginalScenePackages(sceneId, payload({ resources: [{ resourceKey: '共享图片', assetId: '编号', unknown: 1, owners: [owner3d] }] }))
    const result = preserveUneditedThreeDDomain(sceneId, payload({ resources: [{ resourceKey: '共享图片', assetId: '编号', owners: [owner2d] }] }))
    expect(JSON.parse(result.dependenciesJson).resources).toEqual([{ resourceKey: '共享图片', assetId: '编号', unknown: 1, owners: [owner3d, owner2d] }])
  })

  it('没有原始混合场景时不保留上一张场景的数据，损坏数据禁止进入编辑', () => {
    const generated = payload({ resources: [] })
    expect(preserveUneditedThreeDDomain(sceneId, generated)).toBe(generated)
    expect(() => retainOriginalScenePackages(sceneId, { ...generated, threeDJson: '[' })).toThrow()
  })

  it('追加新模型、几何体和共享依赖，同时原样保留旧三维目标与未知配置', () => {
    const oldOwner = { domain: 'threeD', instanceId: '三维模型' }
    const newOwner = { domain: 'threeD', instanceId: '新增模型' }
    const twoDOwner = { domain: 'twoD', instanceId: '二维图片' }
    const before = payload({ resources: [{ resourceKey: '共享资源', assetId: '编号', unknown: true, owners: [oldOwner] }] })
    retainOriginalScenePackages(sceneId, before)
    const generated = { ...payload({
      resources: [{ resourceKey: '共享资源', assetId: '编号', owners: [oldOwner, newOwner, twoDOwner] }],
      behaviors: [{ owner: newOwner, eventType: 'click' }],
    }), threeDJson: JSON.stringify({ objects: [
      { instanceId: '三维模型', unknownFutureField: false },
      { instanceId: '新增模型', layerKey: '新图层', transform: { position: [1, 2, 3] } },
    ], components: [{ instanceId: '新增几何体' }], layers: [{ layerKey: '新图层', name: '分组' }], customRenderer: {} }) }
    const saved = preserveUneditedThreeDDomain(sceneId, generated)
    const threeD = JSON.parse(saved.threeDJson)
    expect(threeD.objects).toEqual([
      { instanceId: '三维模型', unknownFutureField: true },
      { instanceId: '新增模型', layerKey: '新图层', transform: { position: [1, 2, 3] } },
    ])
    expect(threeD.components).toEqual([{ instanceId: '新增几何体' }])
    expect(threeD.layers).toEqual([{ layerKey: '新图层', name: '分组' }])
    expect(threeD.customRenderer).toEqual({ version: 9 })
    expect(JSON.parse(saved.dependenciesJson).resources).toEqual([
      { resourceKey: '共享资源', assetId: '编号', unknown: true, owners: [oldOwner, newOwner, twoDOwner] },
    ])
    expect(JSON.parse(saved.dependenciesJson).behaviors).toEqual([{ owner: newOwner, eventType: 'click' }])
    // 所有新增实例撤销后恢复原三维原文，且不会把已撤销实例的依赖带回下次保存。
    const undone = preserveUneditedThreeDDomain(sceneId, payload({ resources: [] }))
    expect(undone.threeDJson).toBe(before.threeDJson)
    expect(JSON.parse(undone.dependenciesJson).resources[0].owners).toEqual([oldOwner])
  })
})
