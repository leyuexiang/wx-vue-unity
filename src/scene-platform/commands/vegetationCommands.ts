import {
  createVegetationSystemDefinition,
  deriveVegetationRuleSeed,
  validateVegetationSystemDefinition,
} from '../core/vegetation'
import type {
  SceneDefinition,
  VegetationLayerDefinition,
  VegetationPlantingRule,
  VegetationSpeciesDefinition,
  VegetationSystemDefinition,
} from '../core/types'
import type { SceneStore } from '../store/sceneStore'
import type { SceneCommand } from './types'

/** 首个资源市场物种进入空场景时创建的草稿图层编号。 */
export const DEFAULT_VEGETATION_DRAFT_LAYER_ID = 'vegetation-layer-main'

/** 植被命令拒绝非法快照时抛出的结构化错误，界面可以直接展示第一条问题。 */
export class VegetationCommandValidationError extends Error {
  readonly issues: readonly string[]

  constructor(issues: readonly string[]) {
    super(`植被配置未通过校验：${issues.join('；')}`)
    this.name = 'VegetationCommandValidationError'
    this.issues = [...issues]
  }
}

/**
 * 根据场景编号创建稳定的植被规则草稿。
 *
 * 种子只由场景编号派生，不读取时间或随机数；同一场景首次拖入资源时得到相同规则身份。此函数只
 * 创建空领域配置，不推断海拔、不加载模型，也不会生成任何单株植被。
 */
export function createDefaultVegetationAuthoringDefinition(
  sceneId: SceneDefinition['id'],
): VegetationSystemDefinition {
  return createVegetationSystemDefinition({
    seed: deriveVegetationRuleSeed(0, sceneId, 0),
    ruleSetId: `vegetation-rules:${sceneId}`,
    ruleSetVersion: '1',
    enabled: true,
  })
}

type VegetationMutation = (
  current: VegetationSystemDefinition | undefined,
  scene: SceneDefinition,
) => VegetationSystemDefinition | undefined

interface VegetationMutationCommand extends SceneCommand {
  readonly mergeKey?: string
  getNextVegetation: () => VegetationSystemDefinition | undefined
}

function isVegetationMutationCommand(command: SceneCommand): command is VegetationMutationCommand {
  return typeof (command as Partial<VegetationMutationCommand>).getNextVegetation === 'function'
}

/**
 * 创建共享的植被快照命令。
 *
 * 命令首次执行时基于 Store 当前值计算一次结果，重做直接复用该结果，保证撤销重做不受之后的场景
 * 状态影响。物种与规则命令采用数组结构共享，只复制被修改项；完整定义命令只在创建时深拷贝一次
 * 外部输入，避免调用方后续修改引用污染历史。
 */
function createVegetationMutationCommand(
  name: string,
  mutate: VegetationMutation,
  mergeKey?: string,
): SceneCommand {
  let initialized = false
  let previousVegetation: VegetationSystemDefinition | undefined
  let nextVegetation: VegetationSystemDefinition | undefined

  const command: VegetationMutationCommand = {
    name,
    mergeKey,
    mergeSession: mergeKey,
    getNextVegetation: () => nextVegetation,
    execute: (store) => {
      if (!initialized) {
        previousVegetation = store.getVegetation()
        nextVegetation = mutate(previousVegetation, store.getScene())
        if (nextVegetation !== undefined) {
          const result = validateVegetationSystemDefinition(nextVegetation, store.getScene().type)
          if (result.issues.length > 0) throw new VegetationCommandValidationError(result.issues)
        }
        initialized = true
      }
      store.updateVegetation(nextVegetation)
    },
    undo: (store) => {
      store.updateVegetation(previousVegetation)
    },
    mergeWith: (nextCommand) => {
      if (!mergeKey || !isVegetationMutationCommand(nextCommand)) return false
      if (nextCommand.mergeKey !== mergeKey) return false
      nextVegetation = nextCommand.getNextVegetation()
      return true
    },
  }

  return command
}

function requireVegetation(
  current: VegetationSystemDefinition | undefined,
): VegetationSystemDefinition {
  if (!current) {
    throw new Error('当前场景尚未创建植被系统。')
  }
  return current
}

/** 用完整定义替换当前植被系统，适合高程来源、质量档位和发布引用等场景级修改。 */
export function createUpdateVegetationSystemCommand(
  vegetation: VegetationSystemDefinition | undefined,
  mergeKey?: string,
): SceneCommand {
  const snapshot = vegetation === undefined ? undefined : structuredClone(vegetation)
  return createVegetationMutationCommand('UpdateVegetationSystem', () => snapshot, mergeKey)
}

export interface UpsertVegetationSpeciesCommandOptions {
  /** 把物种同时加入指定图层；缺失时只更新物种目录。 */
  layerId?: string
  /** 空系统首次接入物种时创建一个无发布清单的草稿图层。 */
  createDraftLayer?: boolean
  /** 同一表单连续提交可传入稳定键，只保留一条撤销记录。 */
  mergeKey?: string
  /**
   * 本次物种修改是否会改变正式生成快照。
   *
   * 缩放、模型或启用状态等生成参数变化时由调用方显式开启；名称、冠幅等仅编辑展示字段不应让已
   * 发布结果无谓过期。版本推进与物种更新保存在同一条命令中，撤销重做不会出现参数和版本错位。
   */
  advanceRuleSetVersion?: boolean
}

/**
 * 推进不透明规则版本。
 *
 * 纯数字版本保持直观递增；历史版本可能是语义版本或业务字符串，此时追加稳定修订段。函数只在命令
 * 首次执行时运行一次，因此同一命令的撤销、重做会复用完全相同的版本值。
 */
function advanceVegetationRuleSetVersion(currentVersion: string): string {
  if (/^\d+$/.test(currentVersion)) {
    const numericVersion = Number(currentVersion)
    if (Number.isSafeInteger(numericVersion)) return String(numericVersion + 1)
  }
  const revisionMatch = /^(.*)@revision-(\d+)$/.exec(currentVersion)
  if (!revisionMatch) return `${currentVersion}@revision-1`
  const currentRevision = Number(revisionMatch[2])
  return Number.isSafeInteger(currentRevision)
    ? `${revisionMatch[1]}@revision-${currentRevision + 1}`
    : `${currentVersion}@revision-1`
}

/**
 * 新增或更新资源市场物种。
 *
 * 空场景可以在同一条命令内创建植被系统和草稿图层，因此撤销一次即可完整回到“未启用植被”的状态。
 * 同一资源使用稳定物种编号重复拖入时执行原位更新，不产生重复目录项。
 */
export function createUpsertVegetationSpeciesCommand(
  species: VegetationSpeciesDefinition,
  options: UpsertVegetationSpeciesCommandOptions = {},
): SceneCommand {
  const speciesSnapshot = structuredClone(species)
  return createVegetationMutationCommand(
    'UpsertVegetationSpecies',
    (current, scene) => {
      const definition = current ?? createDefaultVegetationAuthoringDefinition(scene.id)
      const existingIndex = definition.speciesCatalog.findIndex(
        (entry) => entry.id === speciesSnapshot.id,
      )
      const speciesCatalog = [...definition.speciesCatalog]
      if (existingIndex >= 0) speciesCatalog[existingIndex] = speciesSnapshot
      else speciesCatalog.push(speciesSnapshot)

      let layers = definition.layers
      if (options.layerId) {
        let matched = false
        layers = definition.layers.map((layer) => {
          if (layer.id !== options.layerId) return layer
          matched = true
          if (layer.locked) throw new Error('目标植被图层已锁定，不能添加物种。')
          if (layer.speciesIds.includes(speciesSnapshot.id)) return layer
          return { ...layer, speciesIds: [...layer.speciesIds, speciesSnapshot.id] }
        })
        if (!matched) throw new Error(`植被图层不存在：${options.layerId}`)
      } else if (options.createDraftLayer && definition.layers.length === 0) {
        /**
         * 草稿层故意不写 manifestAsset。Cesium 控制器会忽略它，直到发布服务回填真实三维瓦片清单。
         */
        layers = [
          {
            id: DEFAULT_VEGETATION_DRAFT_LAYER_ID,
            name: '默认植被层',
            visible: true,
            locked: false,
            kind: 'forest',
            speciesIds: [speciesSnapshot.id],
            priority: 0,
          },
        ]
      }

      return {
        ...definition,
        /**
         * 只有已有物种的正式生成参数改变时才推进版本。首次加入未被规则引用的目录项不会改变任何
         * 已生成实例；调用方也不会因编辑名称或冠幅被迫重新生成。
         */
        ruleSetVersion:
          options.advanceRuleSetVersion && existingIndex >= 0
            ? advanceVegetationRuleSetVersion(definition.ruleSetVersion)
            : definition.ruleSetVersion,
        speciesCatalog,
        layers,
      }
    },
    options.mergeKey,
  )
}

/**
 * 判断规则是否引用指定物种。
 *
 * 多海拔父规则的物种引用位于各分带内，另外两类规则仍位于根节点；按判别字段分派可以保持类型
 * 完整，并在找到首个引用后立即短路，避免删除物种时重复扫描无关分带。
 */
function doesVegetationRuleReferenceSpecies(
  rule: VegetationPlantingRule,
  speciesId: string,
): boolean {
  if (rule.kind === 'altitude-zonation') {
    return rule.zones.some((zone) => zone.speciesMix.some((entry) => entry.speciesId === speciesId))
  }
  return rule.speciesMix.some((entry) => entry.speciesId === speciesId)
}

/**
 * 删除未被规则使用的物种，并同步清理图层引用。
 *
 * 若草稿图层因此变空且没有发布清单，则一并移除空层；已发布图层或规则引用会被明确拒绝，避免删除
 * 物种后留下无法重建或无法回滚的发布配置。
 */
export function createRemoveVegetationSpeciesCommand(speciesId: string): SceneCommand {
  return createVegetationMutationCommand('RemoveVegetationSpecies', (current) => {
    const definition = requireVegetation(current)
    if (!definition.speciesCatalog.some((species) => species.id === speciesId)) {
      throw new Error(`植被物种不存在：${speciesId}`)
    }
    if (definition.rules.some((rule) => doesVegetationRuleReferenceSpecies(rule, speciesId))) {
      throw new Error('该物种仍被种植规则使用，请先删除或修改关联规则。')
    }

    const layers: VegetationLayerDefinition[] = []
    for (const layer of definition.layers) {
      if (!layer.speciesIds.includes(speciesId)) {
        layers.push(layer)
        continue
      }
      const nextSpeciesIds = layer.speciesIds.filter((id) => id !== speciesId)
      if (nextSpeciesIds.length > 0) {
        layers.push({ ...layer, speciesIds: nextSpeciesIds })
        continue
      }
      if (layer.manifestAsset) {
        throw new Error('该物种属于已发布植被图层，不能直接删除。')
      }
    }

    return {
      ...definition,
      layers,
      speciesCatalog: definition.speciesCatalog.filter((species) => species.id !== speciesId),
    }
  })
}

/** 新增或更新植被图层；规则引用检查由统一领域校验一次完成。 */
export function createUpsertVegetationLayerCommand(
  layer: VegetationLayerDefinition,
  mergeKey?: string,
): SceneCommand {
  const layerSnapshot = structuredClone(layer)
  return createVegetationMutationCommand(
    'UpsertVegetationLayer',
    (current) => {
      const definition = requireVegetation(current)
      const existingIndex = definition.layers.findIndex((entry) => entry.id === layerSnapshot.id)
      const layers = [...definition.layers]
      if (existingIndex >= 0) layers[existingIndex] = layerSnapshot
      else layers.push(layerSnapshot)
      return { ...definition, layers }
    },
    mergeKey,
  )
}

/** 删除没有规则引用的图层；发布图层删除后的资源释放由后续运行时发布命令负责。 */
export function createRemoveVegetationLayerCommand(layerId: string): SceneCommand {
  return createVegetationMutationCommand('RemoveVegetationLayer', (current) => {
    const definition = requireVegetation(current)
    if (!definition.layers.some((layer) => layer.id === layerId)) {
      throw new Error(`植被图层不存在：${layerId}`)
    }
    if (definition.rules.some((rule) => rule.layerId === layerId)) {
      throw new Error('该植被图层仍被种植规则使用，请先删除或迁移关联规则。')
    }
    return { ...definition, layers: definition.layers.filter((layer) => layer.id !== layerId) }
  })
}

/**
 * 新增或更新三类种植规则。
 *
 * 判别联合会保留多海拔分带、行道树和圈选规则各自的完整字段；命令不访问 Cesium Viewer，也不
 * 采样地形。无效图层、物种、坐标、高程依赖或密度会在写入 Store 前由领域校验拒绝。规则新增或
 * 修改会同步推进规则版本，确保正式生成和动态地块缓存不会复用旧密度、株距或几何产物。
 */
export function createUpsertVegetationRuleCommand(
  rule: VegetationPlantingRule,
  mergeKey?: string,
): SceneCommand {
  const ruleSnapshot = structuredClone(rule)
  return createVegetationMutationCommand(
    'UpsertVegetationRule',
    (current) => {
      const definition = requireVegetation(current)
      const existingIndex = definition.rules.findIndex((entry) => entry.id === ruleSnapshot.id)
      const rules = [...definition.rules]
      if (existingIndex >= 0) rules[existingIndex] = ruleSnapshot
      else rules.push(ruleSnapshot)
      return {
        ...definition,
        ruleSetVersion: advanceVegetationRuleSetVersion(definition.ruleSetVersion),
        rules,
      }
    },
    mergeKey,
  )
}

/** 删除指定种植规则并推进规则版本；不存在时显式报错，避免生成缓存继续命中旧规则。 */
export function createRemoveVegetationRuleCommand(ruleId: string): SceneCommand {
  return createVegetationMutationCommand('RemoveVegetationRule', (current) => {
    const definition = requireVegetation(current)
    if (!definition.rules.some((rule) => rule.id === ruleId)) {
      throw new Error(`植被规则不存在：${ruleId}`)
    }
    return {
      ...definition,
      ruleSetVersion: advanceVegetationRuleSetVersion(definition.ruleSetVersion),
      rules: definition.rules.filter((rule) => rule.id !== ruleId),
    }
  })
}
