import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('@/request', () => ({ default: mocks.request }))
vi.mock('../auth', () => ({ getDim3dHeaders: () => ({ Authorization: 'Bearer fake', ClientId: 'test', 'tenant-id': '2' }) }))
const id = '6063365a-210b-486b-8c2d-928b10e66a39'
const body = { operationId: id, operationType: 'CREATE' as const, resourceScope: 'TENANT_SHARED' as const,
  metadata: { resourceName: '模型', assetName: 'model' }, targetFormat: 'glb' as const, source: { size: '3', sha256: 'a'.repeat(64) } }
const state = (status: string) => ({ operationId: id, resourceId: '9007199254740993', importStatus: status,
  operationStatus: status === 'COMMITTED' ? status : 'UPLOADING', targetFormat: 'glb', committedRevision: status === 'COMMITTED' ? '1' : null })
const ok = (data: unknown) => ({ code: 200, data })
beforeEach(() => { vi.resetModules(); mocks.request.mockReset(); vi.stubEnv('VITE_DIM3D_API_MODE', 'admin') })
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })
it('鉴权创建、独立PUT和入队严格按顺序执行，PUT不携带业务令牌', async () => {
  mocks.request.mockResolvedValueOnce(ok(state('RECEIVING')))
    .mockResolvedValueOnce(ok({ uploadUrl: 'https://storage.invalid/source?sig=fake', method: 'PUT', sourceSize: '3', sourceSha256: body.source.sha256 }))
    .mockResolvedValueOnce(ok(state('QUEUED')))
  const put = vi.fn().mockResolvedValue(new Response(null, { status: 200 })); vi.stubGlobal('fetch', put)
  const { receiveModelImport } = await import('../modelImport')
  const result = await receiveModelImport(body, new File(['abc'], 'model.zip'), new AbortController().signal, vi.fn())
  expect(result.importStatus).toBe('QUEUED'); expect(result.resourceId).toBe('9007199254740993')
  expect(mocks.request.mock.calls.map(call => call[0])).toEqual([expect.stringMatching(/model-imports$/), expect.stringMatching(/source-target$/), expect.stringMatching(/submit$/)])
  expect(mocks.request.mock.calls[0]?.[1]).toMatchObject({ data: body, skipPlatformPath: true, passAuth: true, headers: { 'tenant-id': '2' } })
  expect(put.mock.calls[0]?.[1]).toMatchObject({ credentials: 'omit', method: 'PUT', redirect: 'error' })
  expect(put.mock.calls[0]?.[1].headers).toBeUndefined()
})
it('响应丢失后原操作已入队，不再次上传或提交', async () => {
  mocks.request.mockResolvedValue(ok(state('QUEUED'))); const put = vi.fn();vi.stubGlobal('fetch', put)
  const { receiveModelImport } = await import('../modelImport')
  await receiveModelImport(body, new File(['abc'], 'model.zip'), new AbortController().signal, vi.fn())
  expect(put).not.toHaveBeenCalled();expect(mocks.request).toHaveBeenCalledTimes(1)
})
it('拒绝业务失败、响应改绑以及伪成功', async () => {
  const { createModelImport, validateImportStatus } = await import('../modelImport')
  mocks.request.mockResolvedValue({ code: 403, msg: '无维护权限' })
  await expect(createModelImport(body, new AbortController().signal)).rejects.toThrow('无维护权限')
  expect(() => validateImportStatus({ ...state('COMMITTED'), operationStatus: 'UPLOADING' } as never, id)).toThrow()
  expect(() => validateImportStatus({ ...state('QUEUED'), resourceId: 9007199254740993 } as never, id)).toThrow()
  expect(() => validateImportStatus({ ...state('QUEUED'), operationId: 'other' } as never, id)).toThrow()
})
it('上传失败不入队，签名目标必须匹配本次输入且使用HTTPS', async () => {
  const { receiveModelImport } = await import('../modelImport')
  for (const url of ['http://storage.invalid/source', 'https://user:password@storage.invalid/source']) {
    mocks.request.mockReset().mockResolvedValueOnce(ok(state('RECEIVING'))).mockResolvedValueOnce(ok({ uploadUrl: url, method: 'PUT', sourceSize: '3', sourceSha256: body.source.sha256 }))
    await expect(receiveModelImport(body, new File(['abc'], 'model.zip'), new AbortController().signal, vi.fn())).rejects.toThrow('目标无效')
    expect(mocks.request).toHaveBeenCalledTimes(2)
  }
})
it('对象PUT失败不能提交；摘要不匹配不能向错误目标上传', async () => {
  const { receiveModelImport } = await import('../modelImport')
  const target = { uploadUrl: 'https://storage.invalid/source', method: 'PUT', sourceSize: '3', sourceSha256: body.source.sha256 }
  mocks.request.mockResolvedValueOnce(ok(state('RECEIVING'))).mockResolvedValueOnce(ok(target))
  const put = vi.fn().mockResolvedValue(new Response(null, { status: 500 })); vi.stubGlobal('fetch', put)
  await expect(receiveModelImport(body, new File(['abc'], 'model.zip'), new AbortController().signal, vi.fn())).rejects.toThrow('上传失败')
  expect(mocks.request).toHaveBeenCalledTimes(2)
  put.mockClear(); mocks.request.mockReset().mockResolvedValueOnce(ok(state('RECEIVING'))).mockResolvedValueOnce(ok({ ...target, sourceSha256: 'b'.repeat(64) }))
  await expect(receiveModelImport(body, new File(['abc'], 'model.zip'), new AbortController().signal, vi.fn())).rejects.toThrow('不一致')
  expect(put).not.toHaveBeenCalled()
})
it('编辑替换读取字符串修订，拒绝未受管资源，不自动改成新建', async () => {
  const { getModelResourceRevision, createModelImport } = await import('../modelImport')
  mocks.request.mockResolvedValueOnce(ok({ currentRevision: '2' }))
  await expect(getModelResourceRevision('9007199254740993', new AbortController().signal)).resolves.toBe('2')
  mocks.request.mockResolvedValueOnce(ok(state('RECEIVING')))
  await createModelImport({ operationId: id, operationType: 'REPLACE', resourceId: '9007199254740993', expectedRevision: '2', source: body.source, targetFormat: 'glb' }, new AbortController().signal)
  expect(mocks.request.mock.calls[1]?.[1].data).toMatchObject({ operationType: 'REPLACE', resourceId: '9007199254740993', expectedRevision: '2' })
  mocks.request.mockResolvedValueOnce(ok({ currentRevision: 2 }))
  await expect(getModelResourceRevision('101', new AbortController().signal)).rejects.toThrow('不能直接替换')
})

it('发布确认复用原操作并校验资源编号', async () => {
  const { publishModelImport } = await import('../modelImport')
  const directory = { modelName: '样本模型', category: 'sample' }
  const signal = new AbortController().signal
  mocks.request.mockResolvedValueOnce(ok(state('PUBLISHING')))
  await expect(publishModelImport(id, '9007199254740993', directory, signal)).resolves.toMatchObject({ importStatus: 'PUBLISHING' })
  expect(mocks.request.mock.calls[0]?.[0]).toMatch(/\/publish$/)
  expect(mocks.request.mock.calls[0]?.[1].data).toEqual(directory)
  mocks.request.mockResolvedValueOnce(ok({ ...state('PUBLISHING'), resourceId: '102' }))
  await expect(publishModelImport(id, '9007199254740993', directory, signal)).rejects.toThrow('不一致')
})
