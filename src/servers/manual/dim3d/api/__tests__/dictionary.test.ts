import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { request } = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('@/request.ts', () => ({ default: request }))
vi.mock('../auth', () => ({
  getDim3dHeaders: () => ({ Authorization: 'Bearer test-token', ClientId: 'test-client' }),
}))

type DictionaryApi = typeof import('../dictionary')
// 经业务适配器的真实导出验证全部入口，模板字典沿用产品已定义的两个类型。
const categories = [
  { type: 'dim3d_model_category', read: (api: DictionaryApi) => api.getDim3dModelCategoryDictionary() },
  { type: 'dim3d_icon_category', read: (api: DictionaryApi) => api.getDim3dIconCategoryDictionary() },
  { type: 'dim3d_scene_category', read: (api: DictionaryApi) => api.getDim3dSceneCategoryDictionary() },
  { type: 'dim3d_template_industry', read: (api: DictionaryApi) => api.getDim3dTemplateCategoryDictionary('dim3d_template_industry') },
  { type: 'dim3d_template_exhibition', read: (api: DictionaryApi) => api.getDim3dTemplateCategoryDictionary('dim3d_template_exhibition') },
  { type: 'dim3d_access_mode', read: (api: DictionaryApi) => api.getDim3dAccessModeDictionary() },
]

afterEach(() => vi.unstubAllEnvs())

describe.each(['admin', 'reference'])('%s 模式按类型读取字典', (mode) => {
  beforeEach(() => {
    vi.resetModules()
    request.mockReset()
    vi.stubEnv('VITE_DIM3D_API_MODE', mode)
    vi.stubEnv('VITE_DIM3D_SERVER_URL', 'https://dictionary.invalid/')
  })

  it.each(categories)('$type 使用正式路径并保留编码、排序和字符串编号', async ({ type, read }) => {
    const api = await import('../dictionary')
    const data = [
      { dictCode: '9007199254740993', dictLabel: '第一项', dictValue: 'Legacy-Code', dictType: type },
      { dictCode: '9007199254740994', dictLabel: '第二项', dictValue: 'SECOND', dictType: type },
    ]
    request.mockResolvedValue({ code: 200, data })
    expect((await read(api)).data).toEqual(data)
    expect(request).toHaveBeenCalledExactlyOnceWith(
      `https://dictionary.invalid/${mode === 'admin' ? 'admin-api' : 'api'}/system/dict/data/type/${type}`,
      expect.objectContaining({ method: 'GET', passAuth: true, skipPlatformPath: true,
        headers: { Authorization: 'Bearer test-token', ClientId: 'test-client' } }),
    )
  })

  it('将后端成功码零归一为页面成功码，保留合法空数组', async () => {
    const api = await import('../dictionary')
    request.mockResolvedValue({ code: 0, msg: '成功', data: [] })
    await expect(api.getDim3dSceneCategoryDictionary()).resolves.toEqual({ code: 200, msg: '成功', data: [] })
  })

  it.each([401, 403, 500])('业务错误 %i 保留原提示并拒绝读取', async (code) => {
    const api = await import('../dictionary')
    request.mockResolvedValue({ code, msg: '分类读取失败', data: null })
    await expect(api.getDim3dModelCategoryDictionary()).rejects.toMatchObject({ code, message: '分类读取失败' })
  })

  it.each([null, undefined, {}])('成功响应 data=%s 格式异常时拒绝读取', async (data) => {
    const api = await import('../dictionary')
    request.mockResolvedValue({ code: 200, data })
    await expect(api.getDim3dIconCategoryDictionary()).rejects.toThrow('字典接口返回格式异常')
  })

  it('并行字典读取各自保留请求选项和响应', async () => {
    const api = await import('../dictionary')
    request.mockResolvedValue({ code: 200, data: [] })
    await Promise.all([
      api.getDim3dModelCategoryDictionary({ suppressNotFoundNotification: true }),
      api.getDim3dSceneCategoryDictionary({ timeout: 1500 }),
    ])
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls[0]![1]).toMatchObject({ suppressNotFoundNotification: true })
    expect(request.mock.calls[1]![1]).toMatchObject({ timeout: 1500 })
  })

  it('保留旧无类型模板调用的接口签名与请求选项', async () => {
    const api = await import('../dictionary')
    request.mockResolvedValue({ code: 200, data: [] })
    await api.getDim3dTemplateCategoryDictionary({ timeout: 1200 })
    expect(request.mock.calls[0]![0]).toContain('/system/dict/data/type/dim3d_template_category')
    expect(request.mock.calls[0]![1]).toMatchObject({ timeout: 1200 })
  })
})
