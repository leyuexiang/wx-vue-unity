# UI-01 管理端首批视觉调整

执行日期：2026-11-10～11。此记录对应本地源码和隔离验证，未部署线上。

共享管理主题采用柔和中灰绿正文、白字青绿侧栏及深绿主按钮；筛选改为响应式网格，统一32像素控件与操作按钮。IoT行内保留详情/编辑，启停和删除归入更多菜单，沿用权限、确认和在途互斥；暗色表格及标签使用管理主题。资源管理、场景管理、物联网管理目录保持NAV-02约定，水印与侧栏尺寸沿用原设计。

## 验证

| 检查 | 结果及范围 |
| --- | --- |
| `pnpm vitest run src/auth/__tests__ src/servers/manual/iot/__tests__ src/views/iotManage/__tests__` | 11组77项通过 |
| `pnpm type-check` | 通过 |
| `pnpm build` | 通过，最终构建38.54秒；仍有既有大体积产物提示 |
| `IOT_BROWSER_UI_REVIEW=1`运行`scripts/iotManagementBrowserSmoke.mjs` | [23项通过](browser-checks.json)，含授权导航、筛选、冲突、确认取消、键盘更多菜单及亮暗主题 |
| `scripts/twoDFrontendBrowserSmoke.mjs` | [二维回归通过](two-d-regression.json)，107个组件注册，覆盖保存重开、拖动撤销重做、数据绑定、分组显隐及预览；路由/页面/控制台错误为空 |

浏览器入口为本机`http://127.0.0.1:5187/dts/`；物联网脚本设置`IOT_BROWSER_OUTPUT_DIR=docs/evidence/ui01-20261110`，二维脚本设置同入口和报告路径。两者使用隔离模拟接口，操作真实Vue页面和处理器，不代表认证服务、实际数据库、网关或消息系统验收。

布局核对1280、1440、1920及960宽度；960仅用于窄内容区检查，未代替真实200%缩放。主按钮文字对比约5.25:1、柔和说明约4.80:1；侧栏按用户要求保留品牌底色白字，约3.05:1，不宣称完整无障碍达标。JSON精度、可信身份及运行状态语义保持原实现。

## 页面截图

- [浅色1440](connectors-light-1440.png)、[浅色1280](connectors-light-1280.png)、[浅色1920](connectors-light-1920.png)。
- [暗色1440](connectors-dark-1440.png)、[暗色详情](drawer-dark-1440.png)。
- [场景四字段1440](scenes-light-1440.png)。截图均为隔离样本数据。

下一项为实际后台菜单、角色和租户套餐核对，再准备IoT服务与网关部署及真实管理闭环。完整上行、Broker/Kafka成功路径、第二批抽屉/空态和全移动端检查分别推进。
