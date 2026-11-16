import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { loadFixedScenePublication } from '../fixedScenePublication'
import { assembleSceneDefinitionFromRuntimeFragments } from '../sceneRuntimeFragmentAssembler'

const transport = vi.hoisted(() => vi.fn())
vi.mock('@/request', () => ({ default: transport }))

const publicationId = 'PUB-400'
const ticket = 't'.repeat(43)
const snapshot = { code: 200, data: { publicationId, sceneId: '8', revisionNo: 4,
  sceneJson: '{}', threeDJson: '{}', twoDJson: '{}', dependenciesJson: '{}' } }
const model = { resourceKey: 'model-fixed-v2', resourceId: '99', revision: '2',
  contentHash: 'a'.repeat(64), manifestSha256: 'b'.repeat(64), contentFormat: 'model.gltf.v1',
  platform: 'WebGL', appCompatibility: '1.0.0', manifestPath: 'manifest.json' }

beforeEach(() => {
  transport.mockReset()
  vi.stubEnv('VITE_UNITY_PUBLICATION_API_ORIGIN', 'https://publication.invalid')
  vi.stubEnv('VITE_UNITY_RESOURCE_DOWNLOAD_ORIGINS', 'https://files.invalid')
})

afterEach(() => vi.unstubAllEnvs())

it('从同一票据装配快照和资源键，支持同一资产的不同固定修订', async () => {
  const updated = { ...model, resourceKey: 'model-fixed-v3', revision: '3' }
  transport.mockResolvedValueOnce(snapshot).mockResolvedValueOnce({ code: 200, data: { publicationId, resources: [model, updated] } })
  const release = await loadFixedScenePublication(publicationId, ticket)
  expect(release.revisionNo).toBe(4)
  expect(release.resources.catalog['model-fixed-v2']?.revision).toBe('2')
  expect(release.resources.catalog['model-fixed-v3']?.revision).toBe('3')
  for (const [url, options] of transport.mock.calls) {
    expect(url).toMatch(/^https:\/\/publication\.invalid\/admin-api\/dim3d\/scene\/publication\/preview/)
    expect(options).toMatchObject({ method: 'POST', headers: { 'X-Scene-Ticket': ticket }, anonymousPublicPreview: true })
    expect(url).not.toContain(ticket)
  }
})

it.each([{ publicationId: 'PUB-500', resources: [model] }, { publicationId, resources: [model, model] }])(
  '拒绝不匹配的发布和重复资源键', async (resourceData) => {
    transport.mockResolvedValueOnce(snapshot).mockResolvedValueOnce({ code: 200, data: resourceData })
    await expect(loadFixedScenePublication(publicationId, ticket)).rejects.toThrow()
  },
)

it('用正式适配器字段还原发布快照的设备点位及显隐映射', () => {
  const mapping = { kind: 'object', targetPath: 'visible', sourceField: 'value', valueType: 'boolean' }
  const config = { adapterId: 'iot-state', config: { deviceId: 'car', pointCode: 'visible' } }
  const content = {
    sceneJson: { sceneType: 'local3d', name: '发布车模型' },
    threeDJson: { objects: [{ instanceId: 'car-1', targetType: 'model', name: '车', visible: true,
      resourceRefKeys: ['model-fixed-v2'], transform: { kind: 'local', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } }] },
    twoDJson: {},
    dependenciesJson: {
      resources: [{ resourceKey: 'model-fixed-v2', assetId: '99', kind: 'unity-model' }],
      dataBindings: [{ bindingKey: 'request-1', owner: { domain: 'threeD', ownerType: 'instance', instanceId: 'car-1' },
        source: { type: 'adapter', requestConfig: config }, mappingConfig: { bindings: [mapping] }, enabled: true }],
    },
  }
  const scene = assembleSceneDefinitionFromRuntimeFragments({
    manifest: { publicationId, contentJson: JSON.stringify(content) }, options: { sceneId: '8' },
  })
  expect(scene.objects[0]?.metadata?.dataConfig).toMatchObject({
    requests: [{ enabled: true, request: { type: 'adapter', config }, bindings: [mapping] }],
  })
})
