import type { LegacyScenePanelStateProvider } from './editorSceneSettingsAdapter'
import type { SceneDefinition } from '@/scene-platform'
import type { SceneSaveEdits } from '@/scene-platform/core/sceneSaveEdits'
import type { WidgetSceneFragment } from './widgetRuntime/widgetSceneFragment'
import { captureEditorSceneDefinitionSnapshot } from './editorSceneSaveAdapter'
import { getActiveSceneViewportHost } from './editorScenePlatformHost'
import {
  createSceneFourPackageDocuments,
  parseSceneFourPackagePayload,
  serializeSceneFourPackageDocuments,
} from './sceneFourPackage'
import {
  saveDim3dSceneSnapshotAsTemplate,
  type Dim3dSceneSnapshotTemplateBody,
  type Dim3dSceneSnapshotTemplateResponse,
  type Dim3dSceneTemplateSaveScope,
  type Dim3dSceneTemplateVo,
} from '@/servers/manual/dim3d/api/scene'
import { DIM3D_TEMPLATE_TYPE, type Dim3dTemplateType } from '@/servers/manual/dim3d/api/template'
import { filterSceneFourPackageDocumentsForTemplate } from './templateFourPackageFilter'
import type { EditorSceneGlobalStateSnapshot } from './editorSceneGlobalStateAdapter'
import { preserveUneditedThreeDDomain } from './twoDPackagePreservation'

/** 弹窗可编辑且被新另存接口真实接收的模板元数据。 */
export interface EditorDim3dSceneTemplateForm {
  name: string
  templateType: Dim3dTemplateType
  /** 模板类型专属字典编码；后端另存接口要求该字段必填。 */
  category: string
  saveScope: Dim3dSceneTemplateSaveScope
  sceneDesc?: string
  coverAssetId?: string
}

export interface SaveEditorSceneAsTemplateOptions {
  /** 测试或显式调用可注入场景；生产路径默认读取当前活动 SceneStore。 */
  scene?: SceneDefinition | null
  /** 复用场景面板纯快照，保证相机、天气等尚未保存的修改也进入模板。 */
  sceneApi?: LegacyScenePanelStateProvider | null
  /** 测试可注入二维片段；生产路径按需读取当前二维部件仓储。 */
  widgetSceneFragment?: WidgetSceneFragment | null
  /** 测试可固定场景级请求状态；生产路径在点击提交时读取当前请求仓库。 */
  sceneGlobalState?: EditorSceneGlobalStateSnapshot | null
  /** 定向测试使用的请求替身；生产路径固定调用真实快照另存接口。 */
  saveTemplate?: (
    body: Dim3dSceneSnapshotTemplateBody,
  ) => Promise<Dim3dSceneSnapshotTemplateResponse>
}

const TEMPLATE_SCOPE_SET: ReadonlySet<Dim3dSceneTemplateSaveScope> = new Set([
  'twoD',
  'threeD',
  'all',
])
/** 固定模板类型的运行时白名单，防止调用方绕过表单后把未知字符串发送给后端。 */
const TEMPLATE_TYPE_SET: ReadonlySet<Dim3dTemplateType> = new Set(
  Object.values(DIM3D_TEMPLATE_TYPE),
)

/** 只保留非空可选字符串，避免向后端发送无意义空值并覆盖其身份默认逻辑。 */
const normalizeOptionalText = (value: string | undefined) => {
  const normalized = value?.trim()
  return normalized || undefined
}

/** 模板分类是后端必填字段，单独归一化后再校验，避免空格字符串绕过必填校验。 */
const normalizeRequiredCategory = (value: string | undefined) => value?.trim() || ''

/**
 * 将弹窗字段与同一时刻的四包快照组装成真实接口请求体。
 * ownerType 未出现在当前弹窗中，按契约省略并由后端依据登录身份判定。
 */
const createTemplateRequestBody = (
  scene: SceneDefinition,
  form: EditorDim3dSceneTemplateForm,
  deletedObjectIds?: ReadonlySet<string>,
  editedHierarchyIds?: ReadonlySet<string>,
  saveEdits?: SceneSaveEdits,
): Dim3dSceneSnapshotTemplateBody => {
  const name = form.name.trim()
  if (!name) throw new Error('请输入模板名称')
  if (!TEMPLATE_TYPE_SET.has(form.templateType)) throw new Error('请选择有效的模板类型')
  const category = normalizeRequiredCategory(form.category)
  if (!category) throw new Error('请选择模板分类')
  if (!TEMPLATE_SCOPE_SET.has(form.saveScope)) throw new Error('请选择有效的模板保存范围')

  const sceneDesc = normalizeOptionalText(form.sceneDesc)
  const coverAssetId = normalizeOptionalText(form.coverAssetId)
  // 另存模板也必须先保全未编辑的三维域，再仅对模板副本执行既有跨域裁剪。
  const sourcePackages = parseSceneFourPackagePayload(preserveUneditedThreeDDomain(
    scene.id,
    serializeSceneFourPackageDocuments(createSceneFourPackageDocuments(scene)),
    undefined,
    editedHierarchyIds,
    deletedObjectIds,
    saveEdits,
  ))
  /**
   * saveScope 不能只作为元数据交给后端：前端先生成模板工作副本并完成域、依赖和引用裁剪，
   * 避免仅二维／仅三维模板在请求链路中继续携带完整场景数据。
   */
  const templatePackages = filterSceneFourPackageDocumentsForTemplate(
    sourcePackages,
    form.saveScope,
  )
  const serialized = serializeSceneFourPackageDocuments(templatePackages)
  return {
    name,
    templateType: form.templateType,
    category,
    saveScope: form.saveScope,
    schemaVersion: scene.schemaVersion,
    ...serialized,
    ...(sceneDesc ? { sceneDesc } : {}),
    ...(coverAssetId ? { coverAssetId } : {}),
  }
}

/**
 * 严格校验业务成功响应，防止 HTTP 成功但后端未创建模板时产生虚假成功提示。
 * 返回范围必须与请求一致，且 sceneKind 必须明确为 TEMPLATE。
 */
const assertTemplateSaveSucceeded = (
  response: Dim3dSceneSnapshotTemplateResponse,
  saveScope: Dim3dSceneTemplateSaveScope,
): Dim3dSceneTemplateVo & { sceneId: string; sceneKind: 'TEMPLATE' } => {
  if (response.code !== 200) {
    throw new Error(response.msg?.trim() || `另存为模板失败，业务码：${String(response.code)}`)
  }
  const sceneId = response.data?.sceneId?.trim()
  if (!sceneId) throw new Error('另存为模板接口未返回模板场景编号')
  if (response.data?.sceneKind !== 'TEMPLATE') {
    throw new Error('另存为模板接口返回的场景类型不是模板')
  }
  if (response.data.saveScope !== saveScope) {
    throw new Error('另存为模板接口返回的保存范围与提交范围不一致')
  }
  return response.data as Dim3dSceneTemplateVo & { sceneId: string; sceneKind: 'TEMPLATE' }
}

/**
 * 将当前未保存的编辑器状态直接另存为模板。
 * 整个流程只采集一次权威快照并发出一次请求，不会先调用 saveAll 覆盖实例场景草稿。
 */
export const saveActiveEditorSceneAsTemplate = async (
  form: EditorDim3dSceneTemplateForm,
  options: SaveEditorSceneAsTemplateOptions = {},
) => {
  const host = options.scene === undefined ? getActiveSceneViewportHost() : null
  const deletedObjectIds = host ? new Set(host.getStore().getDeletedObjectIds()) : undefined
  const editedHierarchyIds = host ? new Set(host.getStore().getHierarchyEditedIds()) : undefined
  const saveEdits = host?.getStore().captureSaveEdits()
  const scene = await captureEditorSceneDefinitionSnapshot({
    scene: options.scene,
    sceneApi: options.sceneApi,
    ...(Object.prototype.hasOwnProperty.call(options, 'widgetSceneFragment')
      ? { widgetSceneFragment: options.widgetSceneFragment }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(options, 'sceneGlobalState')
      ? { sceneGlobalState: options.sceneGlobalState }
      : {}),
  })
  const body = createTemplateRequestBody(scene, form, deletedObjectIds, editedHierarchyIds, saveEdits)
  const response = await (options.saveTemplate ?? saveDim3dSceneSnapshotAsTemplate)(body)
  return assertTemplateSaveSucceeded(response, form.saveScope)
}
