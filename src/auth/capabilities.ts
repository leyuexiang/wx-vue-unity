import type { PlatformType } from './authTypes'
import { authContext } from './authContext'

/**
 * 资源卡片允许进入的菜单动作。
 *
 * 组件和动作处理器都消费同一组字面量，避免出现“界面隐藏了按钮，但事件处理器仍能
 * 调用旧接口”的分裂状态。后续增加资源动作时必须先扩展这里，再补充平台映射。
 */
export type ResourceCardMenuAction = 'toggleStatus' | 'delete'

/** 场景卡片允许进入的菜单动作。授权动作保留在模型中，租户端映射会明确移除它。 */
export type SceneCardMenuAction = 'copy' | 'authorize' | 'downloadJson' | 'delete'

/** 场景发布访问模式的后端枚举；值只允许来自已确认的接口契约。 */
export type ScenePublishAccessMode = 'PERSONAL' | 'PUBLIC_ENCRYPT' | 'ENTERPRISE' | 'PUBLIC_SHARE'

/** 发布弹窗消费的只读访问模式选项，统一保存提交编码和最终显示文案。 */
export interface ScenePublishAccessModeOption {
  readonly value: ScenePublishAccessMode
  readonly label: string
}

/** 资源卡片的只读能力快照；按钮、菜单和命令处理器必须使用同一份结果。 */
export interface ResourceCardCapabilities {
  readonly canEdit: boolean
  readonly canOpenMore: boolean
  readonly canToggleStatus: boolean
  readonly canDelete: boolean
  readonly menuActions: readonly ResourceCardMenuAction[]
}

/** 场景卡片的只读能力快照；租户端不会因为旧权限数组而重新出现授权入口。 */
export interface SceneCardCapabilities {
  readonly canCopy: boolean
  readonly canDelete: boolean
  readonly canAuthorize: boolean
  /** 场景文件仅供运维端下载，处理器和服务层也必须检查此能力。 */
  readonly canDownloadJson: boolean
  readonly menuActions: readonly SceneCardMenuAction[]
  readonly publish: {
    readonly accessModes: readonly ScenePublishAccessModeOption[]
  }
}

/** 管理页面当前需要的能力快照；不暴露 iframe 消息或具体认证提供者。 */
export interface ManagementCapabilities {
  /** 系统配置会影响整个部署，只向运营端展示和开放配置页面。 */
  readonly systemConfig: { readonly canAccess: boolean }
  readonly resource: ResourceCardCapabilities
  readonly scene: SceneCardCapabilities
  readonly template: {
    /** 租户端既不展示模板管理入口，也不能通过地址栏直接进入模板管理页面。 */
    readonly canAccess: boolean
  }
  readonly editor: {
    readonly saveAsTemplate: boolean
    /** 上传场景文件会整体覆盖编辑内容，仅向运维端开放。 */
    readonly importSceneJson: boolean
  }
}

/** 生成能力快照所需的最小认证输入，便于独立模式和单元测试注入。 */
export interface CapabilityInput {
  readonly platformType: PlatformType
  readonly permissions?: readonly string[]
}

/**
 * 后端资源归属枚举的前端只读输入。
 * 缺失归属时按“不可操作”处理，禁止通过名称、卡片标题或请求地址猜测资源范围。
 */
export type ResourceBelong = 'SYSTEM' | 'MINE'

const EMPTY_RESOURCE_MENU_ACTIONS: readonly ResourceCardMenuAction[] = Object.freeze([])

const TENANT_SYSTEM_RESOURCE_CAPABILITIES: ResourceCardCapabilities = Object.freeze({
  canEdit: false,
  canOpenMore: false,
  canToggleStatus: false,
  canDelete: false,
  menuActions: EMPTY_RESOURCE_MENU_ACTIONS,
})

/** 运营端资源卡片的完整能力集合；租户我的资源使用独立的受限菜单集合。 */
const FULL_RESOURCE_CAPABILITIES: ResourceCardCapabilities = Object.freeze({
  canEdit: true,
  canOpenMore: true,
  canToggleStatus: true,
  canDelete: true,
  menuActions: Object.freeze(['toggleStatus', 'delete'] as const),
})

/** 租户端我的资源允许编辑和删除，但不提供对租户无意义的上下线操作。 */
const TENANT_MINE_RESOURCE_CAPABILITIES: ResourceCardCapabilities = Object.freeze({
  canEdit: true,
  canOpenMore: true,
  canToggleStatus: false,
  canDelete: true,
  menuActions: Object.freeze(['delete'] as const),
})

const OPERATION_SCENE_CAPABILITIES: SceneCardCapabilities = Object.freeze({
  canCopy: true,
  canDelete: true,
  canAuthorize: true,
  canDownloadJson: true,
  menuActions: Object.freeze(['copy', 'authorize', 'downloadJson', 'delete'] as const),
  publish: Object.freeze({
    accessModes: Object.freeze([
      Object.freeze({ value: 'PUBLIC_SHARE', label: '公开访问' }),
      Object.freeze({ value: 'PUBLIC_ENCRYPT', label: '公开加密访问' }),
    ] as const),
  }),
})

/** 租户端发布模式固定保留产品确认的四项及顺序。 */
const TENANT_SCENE_PUBLISH_ACCESS_MODES: readonly ScenePublishAccessModeOption[] = Object.freeze([
  Object.freeze({ value: 'PERSONAL', label: '仅个人可见' }),
  Object.freeze({ value: 'PUBLIC_ENCRYPT', label: '公开加密访问' }),
  Object.freeze({ value: 'ENTERPRISE', label: '仅企业内部可见' }),
  Object.freeze({ value: 'PUBLIC_SHARE', label: '公开访问' }),
])

/**
 * 根据认证上下文计算管理能力。
 *
 * 运营端返回现有全量能力，保持原菜单和操作不变；租户端的资源卡片能力在消费卡片时
 * 再按资源归属收敛：我的资源保留编辑、删除能力但隐藏上下线，系统资源完全不可操作。
 * 这里不读取路由、域名或 iframe 消息。
 */
export function createManagementCapabilities(input: CapabilityInput): ManagementCapabilities {
  if (input.platformType === 'operation') {
    return Object.freeze({
      systemConfig: Object.freeze({ canAccess: true }),
      resource: FULL_RESOURCE_CAPABILITIES,
      scene: OPERATION_SCENE_CAPABILITIES,
      template: Object.freeze({ canAccess: true }),
      editor: Object.freeze({ saveAsTemplate: true, importSceneJson: true }),
    })
  }

  return Object.freeze({
    systemConfig: Object.freeze({ canAccess: false }),
    // 资源归属会在 resolveResourceCardCapabilities 中叠加，租户基础快照先关闭所有资源动作。
    resource: TENANT_SYSTEM_RESOURCE_CAPABILITIES,
    scene: Object.freeze({
      // 租户端场景卡片固定保留复制和删除；平台差异只移除运营端专属的授权动作。
      canCopy: true,
      canDelete: true,
      canAuthorize: false,
      canDownloadJson: false,
      menuActions: Object.freeze(['copy', 'delete'] as const),
      publish: Object.freeze({ accessModes: TENANT_SCENE_PUBLISH_ACCESS_MODES }),
    }),
    template: Object.freeze({ canAccess: false }),
    editor: Object.freeze({ saveAsTemplate: false, importSceneJson: false }),
  })
}

/**
 * 从当前内存认证上下文取得管理能力。
 *
 * 页面只依赖本函数返回的能力快照，不直接读取 iframe 消息。独立模式没有平台上下文时
 * 保留原有运营端行为；内嵌模式在业务路由挂载前已经完成认证，因此不会把未认证状态
 * 当成租户权限。租户平台只能由已校验的认证上下文明确提供，不能通过缺省值推断。
 */
export function getCurrentManagementCapabilities(): ManagementCapabilities {
  const context = authContext.get()
  return createManagementCapabilities({
    platformType: context?.platformType ?? 'operation',
    permissions: context?.permissions,
  })
}

/**
 * 将资源归属叠加到租户资源能力上。
 *
 * 系统资源永远返回不可操作快照；我的资源保留编辑、删除能力并隐藏上下线。
 * 运营端直接复用原有能力，不受资源归属限制影响。
 */
export function resolveResourceCardCapabilities(
  managementCapabilities: ManagementCapabilities,
  resourceBelong?: ResourceBelong,
): ResourceCardCapabilities {
  if (managementCapabilities.resource.canEdit) return managementCapabilities.resource
  if (resourceBelong === 'MINE') return TENANT_MINE_RESOURCE_CAPABILITIES
  return TENANT_SYSTEM_RESOURCE_CAPABILITIES
}

/** 判断资源菜单动作是否仍属于当前卡片能力，供事件处理器阻断绕过 UI 的调用。 */
export function canUseResourceCardAction(
  capabilities: ResourceCardCapabilities,
  action: ResourceCardMenuAction,
): boolean {
  return capabilities.menuActions.includes(action)
}

/** 判断场景菜单动作是否仍属于当前能力，授权动作不会因旧权限数组重新出现。 */
export function canUseSceneCardAction(
  capabilities: SceneCardCapabilities,
  action: SceneCardMenuAction,
): boolean {
  return capabilities.menuActions.includes(action)
}

/**
 * 将正式字典与当前平台能力求交集。
 *
 * 只接受能力模型已经允许、且字典确实返回的编码；未知字典项不会出现在下拉框中，
 * 也不会被伪造提交。返回顺序由能力模型固定，避免后端字典顺序变化导致产品顺序漂移。
 */
export function resolveScenePublishAccessModes(
  managementCapabilities: ManagementCapabilities,
  dictionaryOptions: readonly { readonly value: string }[],
): readonly ScenePublishAccessModeOption[] {
  // 字典值只做大小写归一化，不改变实际提交编码；这样不同网关的大小写差异不会让下拉框为空。
  const dictionaryValues = new Set(
    dictionaryOptions.map((option) => option.value.trim().toUpperCase()),
  )
  return managementCapabilities.scene.publish.accessModes.filter((option) =>
    dictionaryValues.has(option.value),
  )
}

/** 统一判断是否需要访问密码，发布页面不再依据显示文案猜测模式。 */
export function requiresScenePublishPassword(mode: string): boolean {
  return mode === 'PUBLIC_ENCRYPT'
}

/** 历史数据提示使用同一份能力模型文案；未知编码原样保留，便于联调排查。 */
export function getScenePublishAccessModeLabel(mode: string): string {
  return SCENE_PUBLISH_ACCESS_MODE_LABELS.get(mode) || mode
}

const SCENE_PUBLISH_ACCESS_MODE_LABELS = new Map<string, string>([
  ['PERSONAL', '仅个人可见'],
  ['PUBLIC_ENCRYPT', '公开加密访问'],
  ['ENTERPRISE', '仅企业内部可见'],
  ['PUBLIC_SHARE', '公开访问'],
])
