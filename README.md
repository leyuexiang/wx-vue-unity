# Web Unity

从 `jtyf-web-three` 迁入管理页面、编辑器及二维体系，三维由 Unity 云渲染或 Unity WebGPU 承载。

## 当前边界

- 来源页面、二维组件、事件、数据、命令历史、保存与预览已迁入。
- 编辑场景可选择 Unity 云渲染或 Unity WebGPU；两端共用场景状态及 `editor.v1` 协议，支持普通三维与 GIS 草稿。
- GIS 接入包含 WGS84 坐标、影像、地形、3D Tiles 和地理变换回传。能力范围、播放器更新和验证说明见 [GIS 双端渲染接入](docs/GIS双端渲染接入.md)。
- 未选择 Unity 的二维宿主仍可独立运行；其他三维专项功能以实际接入能力为准。
- GIS 与普通三维都由 Unity 播放器渲染，前端不加载 CesiumJS 或 Three.js；Cesium for Unity 位于 Unity 工程内。

## 开发

要求：Node.js 22.12 或以上，pnpm 10.34.6。首次配置可参考 `.env.example`，复制为 `.env.development.local` 后填写业务地址、登录应用编号和嵌入模式；不要覆盖已有有效配置。

```powershell
pnpm install
pnpm dev
```

使用示例配置时访问 `http://localhost:18065/dts/`（端口由 `VITE_DEV_SERVER_PORT` 配置），首页进入场景管理。独立模式登录表单支持运营端与租户端直接切换，认证成功后展示所选平台的内容，刷新保持该平台；登录、用户资料与退出共用 `VITE_DIM3D_SERVER_URL`；当前默认复用参考项目服务器。真实登录、场景与资源列表依赖业务后端；二维阶段无需启动 Unity。生产配置使用 `.env.production.local`，产物在 `dist/web-unity`，服务器须将 `/dts/` 映射到前端产物，并为 `/dts/sceneManage` 等页面提供路由回退；旧 `/threeWeb/` 地址需在部署时同步切换。

```powershell
pnpm type-check
pnpm test
pnpm media:test
pnpm audit:frontend
pnpm build
```

隔离浏览器验收使用已安装的 Edge，启动开发服务器后执行以下命令。脚本模拟业务接口，测试凭据仅存在于隔离会话，不写真实后端。

```powershell
$env:TWOD_SMOKE_FULL='1'
$env:TWOD_SMOKE_REPORT='docs/migration/09-二维浏览器验收结果.json'
pnpm test:browser:2d
```

默认测试地址为 `http://127.0.0.1:5180/dts`，其他访问路径通过 `TWOD_SMOKE_BASE_URL` 配置。第一阶段交付范围、验证边界和人工验收步骤见 [二维迁移交付与验收说明](docs/migration/10-第一阶段二维迁移交付与验收说明.md)。

二维视频的服务端配置见 `server/media.env.example`。开发中间件只用于本地接入；生产媒体服务需要单独设置服务端环境变量、业务鉴权和代理，不能与 Unity 云渲染通道混用。

实施资料：

- 后端从零开发交接：[接口文档入口](docs/api/README.md)，包含当前二维接口、完整场景数据结构及后续三维和 Unity 云渲染接口。
- 当前迁移执行计划：[二维完整迁移与 Unity 渲染替换分阶段合并计划](docs/migration/07-二维完整迁移与Unity渲染替换分阶段合并计划.md)。先完成前端与完整二维迁移，经用户验收后再替换三维底层；迁移顺序以此文档为准。
- 全链路总体计划：`docs/migration/01-Unity云渲染全链路改造总体里程碑计划.md`
- 前端专项实施规划：`docs/migration/02-Unity云渲染独立前端迁移实施规划.md`
- 当前迁移状态：`docs/migration/03-Unity云渲染迁移状态.md`
- 测试服务器 SSH/发布授权：`docs/migration/04-测试服务器SSH登录与发布授权.md`
- 测试信令部署与 Launcher 联调：`docs/migration/05-测试信令部署与Launcher联调记录.md`
- Unity 编辑器直连端到端联调：`docs/migration/06-Unity编辑器直连端到端联调记录.md`

独立鉴权协议、现有接口证据与后续环境切换步骤见 [独立登录鉴权设计与环境切换](docs/api/05-独立登录鉴权设计与环境切换.md)。旧独立管理鉴权接口已停用，不作为新后端开发依据。

IoT三个正式管理页已纳入当前工程，资源/场景/IoT统一消费后端授权菜单树，规则见[管理导航统一设计](docs/design/02_管理导航统一设计.md)、[IoT界面设计](docs/design/01_IoT管理界面设计.md)及[验证记录](docs/evidence/nav01-20261110/README.md)。发布前先配置目标环境菜单、角色与套餐；旧[独立原型](docs/design/prototypes/iot-management.html)仅为历史交互参考，不能当真实接口验收。

管理端视觉优化的现状评估、配色计算及优先级见[视觉评估](docs/design/03_管理端视觉优化评估.md)，目录以NAV-02恢复的三个一级业务分类为准；该评估尚未改动运行样式。
