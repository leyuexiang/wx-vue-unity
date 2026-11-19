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
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })
it('鉴权创建、独立PUT和入队严格按顺序执行，PUT不携带业务令牌', async () => {
  mocks.request.mockResolvedValueOnce(ok(state('RECEIVING')))
    .mockResolvedValueOnce(ok({ uploadUrl: 'https://storage.invalid/source?sig=fake', method: 'PUT', sourceSize: '3', sourceSha256: body.source.sha256 }))
    .mockResolvedValueOnce(ok(state('QUEUED')))
  const put = vi.fn().mockResolvedValue(new Response(null, { status: 200 })); vi.stubGlobal('fetch', put)
  const { receiveModelImport } = await import('../modelImport')
  const result = await receiveModelImport(body, new File(['abc'], 'model.zip'), new AbortController().signal, vi.fn())
  expect(result.importStatus).toBe('QUEUED'); expect(result.resourceId).toBe('9007199254740993')
  expect(mocks.request.mock.calls.map(call => call[0])).toEqual([expect.stringMatching(/model-imports$/), expect.stringMatching(/source-target$/), expect.stringMatching(/submit$/)])
  expect(mocks.request.mock.calls[0]?.[0]).toMatch(/\/api\/dim3d\/model-imports$/)
  expect(mocks.request.mock.calls[0]?.[1]).toMatchObject({ data: body, passAuth: true, headers: { 'tenant-id': '2' } })
  expect(mocks.request.mock.calls[0]?.[1].skipPlatformPath).toBeFalsy()
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

it('发布完整目录时保留封面字符串编号和整数分价格', async () => {
  const { publishModelImport } = await import('../modelImport')
  const directory = { modelName: '完整模型', category: 'sample', modelDesc: '',
    coverImageId: '9007199254740993', isPaid: 'PAID' as const, price: 1299 }
  mocks.request.mockResolvedValueOnce(ok(state('PUBLISHING')))
  await publishModelImport(id, '9007199254740993', directory, new AbortController().signal)
  expect(mocks.request.mock.calls[0]?.[1].data).toEqual(directory)
})


/** 上传时的兼容参数和点击保存时的最终归属应分别传给对应接口。 */
it('上传等待转换，保存提交最终归属并校验空回执', async () => {
  const { uploadModel, saveUploadedModel } = await import('../modelImport')
  mocks.request.mockResolvedValueOnce(ok(state('PUBLISHING')))
  const signal = new AbortController().signal
  const file = new File(['abc'], '模型.zip')
  const uploaded = await uploadModel(file, 'MINE', signal, vi.fn())
  expect(uploaded).toEqual({ modelFileId: state('PUBLISHING').resourceId })
  expect(mocks.request.mock.calls[0]?.[0]).toMatch(/\/api\/dim3d\/resource\/uploadConvert$/)
  const uploadOptions = mocks.request.mock.calls[0]?.[1]
  expect(uploadOptions.data.get('file')).toBe(file)
  expect(uploadOptions.data.get('resourceBelong')).toBe('MINE')
  expect(uploadOptions.headers['Content-Type']).toBeUndefined()
  expect(uploadOptions.skipPlatformPath).toBe(false)
  mocks.request.mockResolvedValueOnce({ code: 200, data: null })
  const directory = { modelName: '模型', category: 'sample', resourceBelong: 'SYSTEM' as const, isPaid: 'FREE' as const }
  await expect(saveUploadedModel(uploaded, directory, signal)).resolves.toBeUndefined()
  expect(mocks.request.mock.calls[1]?.[0]).toMatch(/\/api\/dim3d\/model\/add$/)
  expect(mocks.request.mock.calls[1]?.[1].skipPlatformPath).toBe(false)
  expect(mocks.request.mock.calls[1]?.[1].data).toEqual({
    ...directory, modelFileId: uploaded.modelFileId,
  })
  // 旧版本的异步任务回执无法证明目录事务已完成。
  mocks.request.mockResolvedValueOnce(ok(state('PUBLISHING')))
  await expect(saveUploadedModel(uploaded, directory, signal)).rejects.toThrow('回执无效')
})


it('转换自动轮询到文件就绪，关闭时释放等待', async () => {
  const { uploadModel } = await import('../modelImport')
  vi.useFakeTimers()
  mocks.request.mockResolvedValueOnce(ok(state('QUEUED'))).mockResolvedValueOnce(ok(state('PUBLISHING')))
  const controller = new AbortController()
  const pending = uploadModel(new File(['abc'], '模型.zip'), 'SYSTEM', controller.signal, vi.fn())
  await vi.advanceTimersByTimeAsync(1500)
  const uploaded = await pending
  expect(uploaded).toEqual({ modelFileId: state('PUBLISHING').resourceId })
  mocks.request.mockResolvedValueOnce(ok(state('QUEUED')))
  const cancelled = uploadModel(new File(['abc'], '模型.zip'), 'MINE', controller.signal, vi.fn())
  const rejection = expect(cancelled).rejects.toBeDefined()
  await vi.advanceTimersByTimeAsync(0)
  controller.abort()
  await rejection
  expect(vi.getTimerCount()).toBe(0)
})

/** 受管替换带原操作确认，历史目录上传后改绑新文件；两者都提交同一目录表单。 */
it('替换通过目录编辑保存并保留错误原文供原操作重试', async () => {
  const { saveUploadedModel } = await import('../modelImport')
  const signal = new AbortController().signal
  const modelFileId = state('PUBLISHING').resourceId
  const uploaded = { modelFileId, replacementOperationId: id }
  const form = { modelName: '模型', category: 'sample', resourceBelong: 'MINE' as const, isPaid: 'PAID' as const, price: 125 }
  mocks.request.mockResolvedValueOnce({ code: 503, msg: '使用相同参数重试', data: null })
  await expect(saveUploadedModel(uploaded, form, signal, '91'))
    .rejects.toThrow('使用相同参数重试')
  mocks.request.mockResolvedValueOnce({ code: 200, data: null })
  await saveUploadedModel(uploaded, form, signal, '91')
  expect(mocks.request.mock.calls[1]?.[0]).toMatch(/model\/edit\/91$/)
  expect(mocks.request.mock.calls[1]?.[1]).toMatchObject({
    method: 'PUT', params: { operationId: id }, data: { ...form, modelFileId },
  })
  mocks.request.mockResolvedValueOnce({ code: 200, data: null })
  await saveUploadedModel({ modelFileId }, form, signal, '92')
  expect(mocks.request.mock.calls[2]?.[1].params).toBeUndefined()
})

/** 同步回执只能使用模型文件编号，历史相对路径不会进入目录保存表单。 */
it('兼容同步转换回执并拒绝非模型文件', async () => {
  const { uploadModel } = await import('../modelImport')
  const signal = new AbortController().signal
  const file = new File(['abc'], '模型.zip')
  const modelFileId = '9007199254740993'
  mocks.request.mockResolvedValueOnce(ok({ id: modelFileId, resourceType: 'MODEL', resourceRelativePath: 'models/test.glb' }))
  await expect(uploadModel(file, 'MINE', signal, vi.fn())).resolves.toEqual({ modelFileId })
  expect(mocks.request).toHaveBeenCalledTimes(1)

  mocks.request.mockResolvedValueOnce(ok({ id: modelFileId, resourceType: 'IMAGE' }))
  await expect(uploadModel(file, 'MINE', signal, vi.fn())).rejects.toThrow('有效文件编号')
})

it('处理失败和状态改绑不会显示上传成功', async () => {
  const { uploadModel } = await import('../modelImport')
  mocks.request.mockResolvedValueOnce(ok({ ...state('FAILED'), errorMessage: '模型缺少贴图' }))
  await expect(uploadModel(new File(['abc'], '模型.zip'), 'MINE', new AbortController().signal, vi.fn())).rejects.toThrow('缺少贴图')
})
