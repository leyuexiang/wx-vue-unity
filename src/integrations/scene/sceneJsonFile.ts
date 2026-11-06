import { getCurrentManagementCapabilities } from '@/auth/capabilities'
import type { SceneDefinition, ViewportHost } from '@/scene-platform'
import { CURRENT_SCENE_SCHEMA_VERSION } from '@/scene-platform/core/sceneDefinition'
import { validateVegetationSystemDefinition } from '@/scene-platform/core/vegetation'
import { getDim3dSceneInfo } from '@/servers/manual/dim3d/api/scene'
import {
  isScenePackageRecord,
  isSupportedScenePackageType,
  parseSceneFourPackagePayload,
  type SceneFourPackageDocuments,
  type SerializedSceneFourPackage,
} from './sceneFourPackage'
import { assembleSceneDefinitionFromRuntimeFragments } from './sceneRuntimeFragmentAssembler'
import type { LoadEditorSceneDefinitionOptions } from './editorSceneLoadAdapter'
import { beginEditorSceneOperation } from './editorSceneOperationGate'
import { retainOriginalScenePackages } from './twoDPackagePreservation'

const PACKAGE_FIELDS = ['sceneJson', 'threeDJson', 'twoDJson', 'dependenciesJson'] as const

/** 只接收正式四包文件；扩展名及浏览器提供的媒体类型不能代替内容校验。 */
export interface ValidatedSceneJsonFile {
  payload: SerializedSceneFourPackage
  documents: SceneFourPackageDocuments
}

/** 检查数组及条目关键字段，防止宽松组装器把损坏的正文静默过滤为空场景。 */
const assertArray = (
  record: Record<string, unknown>,
  key: string,
  fields: readonly string[] = [],
) => {
  const values = record[key]
  if (!Array.isArray(values)) throw new Error(`场景文件的 ${key} 必须为数组`)
  if (!fields.length) return
  for (const value of values) {
    if (
      !isScenePackageRecord(value) ||
      fields.some((field) => {
        const item = value[field]
        return field === 'contentJson'
          ? !isScenePackageRecord(item)
          : typeof item !== 'string' || !item.trim()
      })
    ) {
      throw new Error(`场景文件的 ${key} 条目结构不完整`)
    }
  }
}

/**
 * 校验文件外壳、四包职责结构和领域语义，整个过程不修改宿主、不请求资源。
 * 返回白名单字段，保证导出不会夹带详情响应的权限、编辑锁或发布凭证。
 */
export const validateSceneJsonFile = (value: unknown): ValidatedSceneJsonFile => {
  if (!isScenePackageRecord(value)) throw new Error('请选择有效的场景文件')
  const version = value.schemaVersion
  if (version !== CURRENT_SCENE_SCHEMA_VERSION) throw new Error('场景文件协议版本不受支持')
  for (const field of PACKAGE_FIELDS) {
    if (typeof value[field] !== 'string' || !value[field].trim()) {
      throw new Error(`场景文件缺少完整的 ${field}`)
    }
  }
  const payload: SerializedSceneFourPackage = {
    schemaVersion: version,
    sceneJson: value.sceneJson as string,
    threeDJson: value.threeDJson as string,
    twoDJson: value.twoDJson as string,
    dependenciesJson: value.dependenciesJson as string,
  }
  const documents = parseSceneFourPackagePayload(payload)
  const { scene, threeD, twoD, dependencies } = documents
  if (!isSupportedScenePackageType(scene.sceneType)) throw new Error('场景文件缺少有效的场景类型')
  if (scene.schemaVersion !== version) throw new Error('场景文件内外协议版本不一致')
  if (
    typeof scene.name !== 'string' ||
    !isScenePackageRecord(scene.domainSlots) ||
    !isScenePackageRecord(scene.metadata) ||
    !isScenePackageRecord(scene.requestGlobalConfig) ||
    !isScenePackageRecord(threeD.baseConfig) ||
    !isScenePackageRecord(threeD.streaming) ||
    !isScenePackageRecord(twoD.canvas)
  ) {
    throw new Error('场景文件基础配置不完整')
  }
  assertArray(threeD as unknown as Record<string, unknown>, 'objects', [
    'instanceId',
    'targetType',
    'contentJson',
  ])
  assertArray(threeD as unknown as Record<string, unknown>, 'components', [
    'instanceId',
    'targetType',
    'contentJson',
  ])
  assertArray(threeD as unknown as Record<string, unknown>, 'layers', ['layerKey', 'layerType'])
  assertArray(twoD as unknown as Record<string, unknown>, 'components', [
    'instanceId',
    'componentType',
    'contentJson',
  ])
  assertArray(twoD as unknown as Record<string, unknown>, 'layerTree')
  assertArray(scene as unknown as Record<string, unknown>, 'publicRequests')
  assertArray(scene as unknown as Record<string, unknown>, 'sceneActions')
  assertArray(threeD as unknown as Record<string, unknown>, 'cameraPaths')
  for (const field of ['resources', 'dataBindings', 'behaviors', 'deviceBindings']) {
    assertArray(dependencies as unknown as Record<string, unknown>, field)
  }
  /**
   * 四包中的植被地址被保存器主动剥离，不能交给要求完整地址的运行态解析器。
   * 在原始植被正文上复用领域校验，只允许缺少临时地址；其他场景域仍执行原严格组装校验。
   * 校验投影不含植被，返回与下载的 payload/documents 始终保留完整原文，不删字段、不补假地址。
   */
  const { vegetation, ...threeDForValidation } = threeD
  if (vegetation !== undefined) {
    const validation = validateVegetationSystemDefinition(vegetation, scene.sceneType, {
      requireAssetUrls: false,
    })
    if (validation.issues.length) throw new Error(`植被配置无效：${validation.issues.join(' ')}`)
  }
  assembleSceneDefinitionFromRuntimeFragments({
    manifest: {
      contentJson: {
        schemaVersion: version,
        scene,
        threeD: threeDForValidation,
        twoD,
        dependencies,
      },
    },
    options: { sceneId: 'scene-file-validation' },
  })
  return { payload, documents }
}

/** 读取一个本功能导出的场景文件，兼容文本开头的字符编码标记。 */
export const parseSceneJsonFile = (text: string): ValidatedSceneJsonFile => {
  let value: unknown
  try {
    value = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    throw new Error('场景文件内容不是有效的 JSON，请检查文件是否损坏')
  }
  return validateSceneJsonFile(value)
}

/** 当前修订只请求一次；不走会额外解析资源地址的编辑器仓库，保留服务器原始四包。 */
export const loadSceneJsonForDownload = async (
  sceneId: string,
): Promise<SerializedSceneFourPackage> => {
  if (!getCurrentManagementCapabilities().scene.canDownloadJson)
    throw new Error('当前平台不支持下载场景文件')
  if (!/^[1-9]\d*$/.test(sceneId)) throw new Error('当前场景缺少有效编号')
  const response = await getDim3dSceneInfo(sceneId)
  if (response.code !== 200 || !response.data)
    throw new Error(response.msg || '获取场景完整数据失败')
  const revision = response.data.currentRevision
  if (!revision) throw new Error('当前场景没有可下载的已保存修订，请先保存场景')
  // 早期接口未投影顶层版本时只读取包内的真实版本，禁止把未知版本默认为当前版本。
  let version = revision.schemaVersion
  if (version === undefined && typeof revision.sceneJson === 'string') {
    try {
      version = JSON.parse(revision.sceneJson).schemaVersion
    } catch {
      /* 由统一校验返回正文错误。 */
    }
  }
  const { payload, documents } = validateSceneJsonFile({ ...revision, schemaVersion: version })
  if (documents.scene.sceneType !== response.data.sceneType)
    throw new Error('场景详情与修订的场景类型不一致')
  return payload
}

/** 文件名按本地时间生成，去除跨操作系统非法字符和控制字符。 */
export const createSceneJsonFileName = (name: string, now = new Date()) => {
  const safeName =
    name
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
      .replace(/[. ]+$/g, '')
      .slice(0, 100) || '未命名场景'
  const pad = (part: number) => String(part).padStart(2, '0')
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const timestamp = `${date}-${time}`
  return `${safeName}-${timestamp}.json`
}

/** 管理页的已保存修订下载继续受管理能力约束。 */
export const downloadSceneJsonFile = (payload: SerializedSceneFourPackage, name: string) => {
  if (!getCurrentManagementCapabilities().scene.canDownloadJson)
    throw new Error('当前平台不支持下载场景文件')
  downloadRetainedEditorDraft(payload, name)
}

/** 失锁恢复只下载本页已持有的草稿。下一轮任务再释放临时地址。 */
export const downloadRetainedEditorDraft = (payload: SerializedSceneFourPackage, name: string) => {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' }),
  )
  const anchor = document.createElement('a')
  try {
    anchor.href = url
    anchor.download = createSceneJsonFileName(name)
    anchor.click()
  } finally {
    anchor.remove()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }
}

export interface ImportEditorSceneJsonOptions {
  host: ViewportHost
  /** 确认前已经完成无副作用的文件校验和类型检查。 */
  confirm: () => Promise<boolean>
  /** 页面卸载、失锁、宿主切换后必须返回 false，迟到任务不得替换场景。 */
  isActive: () => boolean
  /** 卸载时中止等待并释放操作门禁，迟到的资源请求结果会被丢弃。 */
  signal?: AbortSignal
  /** 替换前停止旧轮询；结束时由页面重建唯一控制器。 */
  beforeReplace?: () => void
  afterReplace?: () => void
  /** 复用正常打开场景的缺失资源提示；仍允许恢复可见部分，保存前继续执行原校验。 */
  onAssetWarning?: (message: string) => void
  applyWidgetFragment?: LoadEditorSceneDefinitionOptions['applyWidgetFragment']
}

/**
 * 上传只覆盖内存，绝不调用保存接口。保留当前身份、名称及编辑锁的后端修订基线。
 * 资源恢复复用正常打开路径；所有异步步骤结束后重新核对能力与会话，再触发真正的替换。
 */
export const importEditorSceneJsonFile = async (
  file: Pick<File, 'name' | 'text'>,
  options: ImportEditorSceneJsonOptions,
): Promise<SceneDefinition | null> => {
  const assertActive = () => {
    if (!getCurrentManagementCapabilities().editor.importSceneJson)
      throw new Error('当前平台不支持上传场景文件')
    if (options.signal?.aborted || !options.isActive())
      throw new Error('当前编辑会话已不可用，请重新进入场景')
  }
  assertActive()
  const release = beginEditorSceneOperation('importJson')
  // 监听器只服务本次导入，finally 必须移除；取消不会取消底层接口，但不会再消费其结果。
  let rejectCancelled: (reason: Error) => void = () => undefined
  const cancelled = new Promise<never>((_resolve, reject) => {
    rejectCancelled = reject
  })
  const onAbort = () => rejectCancelled(new Error('场景导入已取消'))
  options.signal?.addEventListener('abort', onAbort, { once: true })
  const waitActive = <T>(task: Promise<T>) => Promise.race([task, cancelled])
  let replacing = false
  try {
    if (!/\.json$/i.test(file.name)) throw new Error('请选择 .json 格式的场景文件')
    const { payload, documents } = parseSceneJsonFile(await waitActive(file.text()))
    assertActive()
    const current = options.host.getStore().getScene()
    if (documents.scene.sceneType !== current.type)
      throw new Error('上传文件的场景类型与当前场景不一致，无法覆盖')
    if (!(await waitActive(options.confirm()))) return null
    assertActive()
    // 下载和纯文件校验不应加载编辑器恢复模块；只有确认导入后才加载这些业务适配器。
    const [repository, template, loader, platform] = await waitActive(
      Promise.all([
        import('./dim3dSceneRepository'),
        import('./editorDim3dTemplateApplyService'),
        import('./editorSceneLoadAdapter'),
        import('./editorScenePlatformHost'),
      ]),
    )
    assertActive()
    const restored = await waitActive(
      repository.parseFourPackageRevision(
        { sceneId: current.id, name: current.name, sceneType: current.type },
        payload,
        { copyVegetation: true },
      ),
    )
    if (!restored) throw new Error('场景文件没有可恢复的完整内容')
    const candidate = template.createEditorSceneFromTemplate(restored, current, 'all')
    // 模板复用函数负责区块归属；管理名称始终由目标场景保持，避免标题和保存内容不一致。
    candidate.name = current.name
    const result = await waitActive(
      loader.loadEditorSceneDefinition(current.id, { repository: { load: async () => candidate } }),
    )
    assertActive()
    if (options.host.getStore().getScene().id !== current.id)
      throw new Error('当前场景已切换，请重新上传')
    replacing = true
    options.beforeReplace?.()
    await waitActive(
      loader.loadEditorSceneDefinitionIntoHost(current.id, {
        host: options.host,
        preloadedResult: result,
        isActive: () => !options.signal?.aborted && options.isActive(),
        applyWidgetFragment: options.applyWidgetFragment,
      }),
    )
    if (options.signal?.aborted || !options.isActive()) return null
    // 文件替换成功后以用户确认导入的原始四包作为新保全基线，避免下次保存恢复被覆盖的三维内容。
    retainOriginalScenePackages(current.id, {
      sceneJson: payload.sceneJson, threeDJson: payload.threeDJson,
      twoDJson: payload.twoDJson, dependenciesJson: payload.dependenciesJson,
    })
    platform.refreshActiveSceneViewportHost(options.host)
    if (result.assetValidation) options.onAssetWarning?.(result.assetValidation.message)
    return result.scene
  } finally {
    options.signal?.removeEventListener('abort', onAbort)
    try {
      if (replacing && options.isActive()) options.afterReplace?.()
    } finally {
      release()
    }
  }
}
