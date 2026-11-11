import type { Dim3dSceneDetailResponse } from '@/servers/manual/dim3d/api/scene'
import type { Dim3dVegetationPublicationResponse } from '@/servers/manual/dim3d/api/vegetation'
import { normalizeVegetationSystemDefinition, validateVegetationSystemDefinition } from '@/scene-platform/core/vegetation'

/** 发布前只比较植被稳定身份，避免把地址、统计量等运行时字段当成版本依据。 */
export interface SavedVegetationPublicationIdentity {
  version: string
  ruleVersion: string
  sourceHash: string
}

/** 四包中的三维正文按 JSON 对象读取；类型守卫集中在此处，避免发布入口散落断言。 */
type JsonRecord = Record<string, unknown>

const isJsonRecord = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const requireIdentityString = (value: unknown, fieldName: string): string => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`场景保存的植被发布引用缺少有效的${fieldName}。`)
  }
  return value.trim()
}

/**
 * 从场景详情的当前编辑四包中读取植被稳定身份。
 *
 * 没有植被字段表示普通场景，可以沿用原发布流程。编辑器首次接入资源市场物种时会先保存一份
 * 空的植被编制草稿（通常包含 `rules: []`），这份草稿还没有生成任何植被，也不应该阻止整场发布。
 * 只有存在启用的种植规则时，缺少正式发布引用才表示场景确实需要先完成植被生成。禁用系统或没有
 * 启用规则时没有正式引用不参与场景发布版本校验，但若保留正式引用仍继续校验其一致性。
 */
export function readSavedVegetationPublicationIdentity(
  response: Dim3dSceneDetailResponse,
): SavedVegetationPublicationIdentity | null {
  if (response.code !== 200) {
    throw new Error(response.msg?.trim() || '读取场景当前版本失败，无法校验植被版本。')
  }

  const threeDJson = response.data?.currentRevision?.threeDJson
  if (threeDJson === undefined || threeDJson === null || threeDJson === '') return null
  if (typeof threeDJson !== 'string') {
    throw new Error('场景当前三维包格式异常，无法校验植被版本。')
  }

  let threeD: unknown
  try {
    threeD = JSON.parse(threeDJson) as unknown
  } catch {
    throw new Error('场景当前三维包不是合法 JSON，无法校验植被版本。')
  }
  if (!isJsonRecord(threeD)) {
    throw new Error('场景当前三维包不是对象，无法校验植被版本。')
  }

  const vegetation = threeD.vegetation
  if (vegetation === undefined || vegetation === null) return null
  if (!isJsonRecord(vegetation)) {
    throw new Error('场景保存的植被配置格式异常，无法校验植被版本。')
  }

  const publication = vegetation.publication
  if (isJsonRecord(vegetation.streaming) && vegetation.streaming.renderMode === 'instanced') {
    const native = normalizeVegetationSystemDefinition(vegetation)
    const result = validateVegetationSystemDefinition(native, 'gis', { requireAssetUrls: false })
    if (result.issues.length) throw new Error(`原生植被配置无效：${result.issues[0]}`)
    return null
  }
  if (publication === undefined || publication === null) {
    // 空植被草稿只表示用户打开过/编辑过植被入口，并没有可发布的生成结果。
    // 与编辑器生成按钮的门禁保持一致：只有启用规则才需要正式植被版本。
    const rules = vegetation.rules
    const hasEnabledRule = Array.isArray(rules)
      ? rules.some((rule) => isJsonRecord(rule) && rule.enabled === true)
      : false
    if (vegetation.enabled !== true || !hasEnabledRule) return null
    throw new Error('当前场景已保存植被配置但没有正式版本，请先生成并发布植被后再发布场景。')
  }
  if (!isJsonRecord(publication)) {
    throw new Error('场景保存的植被发布引用格式异常，无法校验植被版本。')
  }

  const ruleVersion = requireIdentityString(publication.ruleVersion, '规则版本')
  if (vegetation.enabled === true && typeof vegetation.ruleSetVersion === 'string' && vegetation.ruleSetVersion !== ruleVersion) {
    throw new Error('已保存的植被规则有更新，请重新生成并发布植被后再发布场景。')
  }
  return {
    version: requireIdentityString(publication.version, 'version'),
    // ruleVersion 是前端版本校验的必要组成；旧引用缺失时必须明确提示重新保存。
    ruleVersion,
    sourceHash: requireIdentityString(publication.sourceHash, 'sourceHash'),
  }
}

/**
 * 对比场景保存的植被引用和服务端当前稳定版本。
 *
 * 场景整场发布不冻结植被；本函数只在发布请求发出前做一次最新读取和严格一致性检查，
 * 任何差异都阻止发布并让用户先在编辑器同步、重新生成或重新发布植被。
 */
export function assertVegetationPublicationMatches(
  sceneId: string,
  saved: SavedVegetationPublicationIdentity | null,
  current: Dim3dVegetationPublicationResponse,
): void {
  if (!saved) return

  const normalizedSceneId = sceneId.trim()
  if (current.sceneId !== normalizedSceneId) {
    throw new Error('服务端当前植被版本所属场景与待发布场景不一致，已阻止发布。')
  }

  const differences: string[] = []
  if (saved.version !== current.publicationVersion) differences.push('植被发布版本')
  if (saved.ruleVersion !== current.ruleVersion) differences.push('植被规则版本')
  if (saved.sourceHash !== current.sourceHash) differences.push('植被源内容摘要')
  if (differences.length > 0) {
    throw new Error(`${differences.join('、')}与服务端当前版本不一致，请先同步植被版本后再发布场景。`)
  }
}
