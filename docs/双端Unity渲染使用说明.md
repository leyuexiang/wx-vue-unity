# 双端 Unity 渲染使用说明

网页播放器和模型资源保存在当前前端项目公共资源目录内，默认稳定包为 `public/unity-web/`，其中包含 `player/`、`art/9tyf/` 和 `ArtStartupRelease.json`。稳定包和研发包的位置及生效版本通过管理页配置。编辑页中间挂载 Unity 画面，四周使用现有 Vue 面板，场景数据、保存和发布由网页处理。

GIS 和非 GIS 均加载 Unity 的完整 `StartScene`。GIS 直接使用其中已有的地理根、地表和影像；非 GIS 隐藏地理地表，使用本地坐标、底板及网格。网页加载的业务配置用于添加或编辑对象，不会切换到另一个 Unity Scene。两种模式分别保留相机视角；首次进入 GIS 会避免沿用只有数米高度的本地相机位置。

当前为联调临时使用 Cesium ion 的 Sentinel-2 影像（`CesiumIonRasterOverlay.ionAssetID=3954`），仍由 Unity 原生 GIS 渲染。原 Google 影像 `3830182` 曾返回 429，切换并未使用内网影像。Sentinel-2 的近景清晰度较低；以后更换资源需更新 StartScene 并重新发布播放器。

运行 `pnpm build` 后，网页交付文件复制到 `dist/web-unity/unity-web/`，启动网关交付到 `dist/web-unity/server/unityWebDevGateway.ts`。前端、播放器和网关可作为整个 `dist/web-unity` 目录部署，文件定位跟随所在项目目录。云端播放器沿用 Unity 工程的云渲染交付流程。

生产部署时，将应用子目录下的 `unity-runtime/` 请求去掉该前缀后转发到网关，配置接口和按版本隔离的播放器文件均走此入口。网关的 `/art/` 和 `/session/` 接口通过同一加密站点转发。设置服务端 `UNITY_WEB_DEV_BACKEND` 为业务后端根地址、`UNITY_WEB_DEV_PAGE_ORIGIN` 为前端来源、`UNITY_WEB_DEV_PUBLIC_ORIGIN` 为对外加密根来源后，在交付根目录执行 `node --experimental-strip-types server/unityWebDevGateway.ts`。这些服务地址由部署环境提供。

### 管理稳定版本和研发版本

运营端侧栏进入“系统管理 → 配置管理 → 网页渲染包”。默认稳定版本位置为 `unity-web/player`，研发版本暂未配置。

1. 将稳定包完整放入 `public/unity-web/`，研发包完整放入 `public/unity-web-development/`。每个目录分别包含 `player/Build/`、`art/` 和 `ArtStartupRelease.json`，两个包不要混用资源。
2. 点击对应版本的“选择文件夹”，在弹窗中进入 `unity-web/player` 或 `unity-web-development/player`，点击“选择此文件夹”。弹窗浏览网关所在项目的公共资源目录，并自动回填播放器这一层的相对路径。研发包未准备时可以留空，旧版保存的交付根目录会自动兼容转换到 `player` 层。
3. 点击“检查资源包”检查播放器、启动描述和美术资源发布清单。选择需要使用的版本，点击“保存并生效”；所选版本检查不通过时不会覆盖原配置。
4. 重新进入场景并选择网页渲染。新打开的场景使用保存后的版本，无需重启网关；已经打开的场景保持原来的包和美术资源，所以旧目录需要保留。退出场景后再切换，可查看另一版本。

配置保存到项目内的 `config/webgpu-packages.json`。执行 `pnpm build` 会交付该配置、两个资源包和网关模块；发布后路径相对于部署根目录，网关进程需要配置目录的写权限。线上后续更换包时，先上传到新的独立目录，再在配置页切换路径，避免覆盖正在使用的文件。重新部署时需保留线上修改后的配置文件，或将配置文件存放目录挂载为持久目录。

### 模型管理中的网页模型预览

模型卡片的预览弹窗直接运行当前配置的网页播放器，使用本机图形硬件渲染。先启动网页和网页渲染网关，再进入“资源管理 → 模型管理”，点击模型缩略图即可预览。无需启动信令服务、云渲染启动器或编辑器播放模式。

预览支持左键拖拽旋转、滚轮缩放、右键平移，点击画面底部的复位按钮恢复完整入镜视角；背景跟随管理页亮暗主题。关闭弹窗会释放播放器，重新打开会创建新视口。首次打开需要下载播放器，等待时间取决于包大小和本机性能。

新导入的受管模型使用详情中的稳定资源编号，通过现有资源提供器完成当前发布查询、私有下载和摘要校验。只有明确不存在当前发布的历史模型才沿用原文件地址；权限或网络错误会显示失败与重试，不会切换到错误的旧存储地址。

本机联调在 `.env.development.local` 配置：

```dotenv
VITE_UNITY_WEB_BOOTSTRAP_URL=./unity-runtime/bootstrap
VITE_UNITY_RESOURCE_API_ORIGIN=https://localhost:5191
VITE_UNITY_RESOURCE_DOWNLOAD_ORIGINS=https://192.168.10.148:9444
```

本机网关仅代理资源的 `current` 和 `file` 只读接口，要求当前登录令牌和租户编号，文件仍使用后端签发地址直接下载。正式部署时，将资源接口根来源和下载白名单改为实际可信的加密站点，并在反向代理中开放对应只读资源路径。生产构建读取 `.env.production.local`，不会读取开发环境配置。替换播放器时，必须使用包含 `model.preview` 能力的最新构建，并同步整个播放器目录；旧播放器会提示需要更新。

## 0. 第一次接手

下面假设这台电脑只有两份源码：Unity 工程（还没打过包）和当前网页工程。把 `<Unity工程>` 换成自己的 Unity 根目录，也就是里面有 `Assets` 的那一层；把 `<网页工程>` 换成 `wx-vue-unity` 的根目录。

还要事先准备这些，它们不在这两个工程里：

- Unity `6000.6.7f1`，以工程里的 `ProjectSettings\ProjectVersion.txt` 为准。
- Node.js `22.12` 或更高，以及 pnpm。
- Chrome 或 Edge。
- 一个能登录业务服务器的账号。业务地址问现有环境的维护人，示例是 `http://192.168.10.200:30080`。
- 要看云渲染时，还要一个已经在跑的信令服务，以及 Launcher 工程 `jtyf-pixelstreamlauncher`。联调信令曾用 `ws://192.168.10.148:8923`。没有信令和 Launcher 时，只能做 WebGPU。

### 0.1 配置并启动网页

在 `<网页工程>` 中：

```powershell
copy .env.example .env.development.local
pnpm install
pnpm dev
```

编辑 `.env.development.local`，至少写成：

```text
VITE_DIM3D_SERVER_URL=<业务服务器地址>
VITE_UNITY_CLOUD_SIGNAL_URL=<信令地址，例如 ws://192.168.10.148:8923>
VITE_UNITY_CLOUD_APP_ID=1
VITE_UNITY_CLOUD_SCENE_KEY=<向信令维护人要；联调用过 web-unity-gm1>
VITE_UNITY_CLOUD_CLIENT_ID=
VITE_UNITY_WEB_BOOTSTRAP_URL=./unity-runtime/bootstrap
```

`VITE_UNITY_CLOUD_CLIENT_ID` 留空。改完环境文件后重新执行 `pnpm dev`。浏览器只打开 `http://localhost:5180`，不要用 `127.0.0.1` 或局域网 IP。用业务账号登录。

### 0.2 打两个播放器

用对应版本的 Unity 打开 `<Unity工程>`，等脚本编译完成、Console 没有红色错误。然后点：

1. `产品工具 / 双端打包 / 打包 WebGPU 播放器`
2. `产品工具 / 双端打包 / 打包云渲染播放器`

GIS 由 Unity 工程中的 Cesium for Unity 渲染，网页不安装 CesiumJS。WebGPU GIS 需要原生线程，WebGPU 打包菜单会启用它。当前 Unity 6000.6.7f1 工具链还需要重编随 Cesium 嵌入包提供的 SQLite，步骤见 Unity 工程 `Tools/Cesium/README.md`；升级工具链或重新导入 Cesium 后应重新验证。

两条都会花较长时间，并切换 Unity 的当前平台。完成后应有：

```text
<网页工程>\public\unity-web\player\Build\
<Unity工程>\cloud\player\CloudRender.exe
<Unity工程>\cloud\CloudRenderLaunch.exe
```

编辑器正开着这个工程时，不要再运行命令行打包。编辑器关掉之后，才可以在 `<Unity工程>` 里执行 `Tools\DualRender\package.ps1 -Target webgpu` 或 `-Target cloud`。

### 0.3 放入模型资源

播放器包里没有场景用的模型。两个端还要各有一份资源发布，而且不能互换：

```text
<网页工程>\public\unity-web\art\9tyf\
<网页工程>\public\unity-web\ArtStartupRelease.json
<Unity工程>\cloud\art\
<Unity工程>\cloud\ArtStartupRelease.json
```

已有完整发布时，将网页平台资源复制到前端 `public/unity-web/art/9tyf/`，将对应的启动描述保存为 `public/unity-web/ArtStartupRelease.json`。资源通过 Unity 的「产品工具 / 资源热更工作台」构建，网页单包上限为 32 MiB。云端资源继续按其启动器目录交付。

### 0.4 启动 WebGPU 并进入场景

和云渲染一样，只改一次路径，以后双击启动。文件在网页工程里：

```text
<网页工程>\scripts\启动WebGPU网关.bat
```

1. 确认 `public/unity-web/` 已放入完整交付文件。启动入口默认使用此项目相对路径。
2. 回到资源管理器，双击 `启动WebGPU网关.bat`。窗口留着。它会先检查本机证书，再启动网关。出现 `Unity Web local gateway listening on https://localhost:5191` 后不要关。关掉窗口等于 WebGPU 入口断开。
3. 浏览器打开 `http://localhost:18065/threeWeb/sceneManage`。未登录时按页面提示登录。对普通三维或 GIS 场景点「进入」，在「选择渲染方式」里点「Unity WebGPU」。
4. 编辑页中间先显示加载百分比，再到「Unity 场景已就绪」。播放器读取当前前端项目的 `public/unity-web/player/`。

「Unity WebGPU」是灰色时，检查 `.env.development.local` 里的 `VITE_UNITY_WEB_BOOTSTRAP_URL` 是否为 `./unity-runtime/bootstrap`，保存后重新运行 `pnpm dev`。按钮写着浏览器不支持时，使用支持网页图形接口的浏览器和安全页面来源。

线程版播放器需要主网页提供 `Cross-Origin-Opener-Policy: same-origin` 和 `Cross-Origin-Embedder-Policy: credentialless`（或 `require-corp`），并使用 HTTPS 或受信任的 localhost。Vite 开发与预览服务已提供这些头；生产环境须在网页服务器上配置，不能只加在播放器资源服务器。部署配置的 `build.threadsRequired` 应设为 `true`。修改响应头后完整刷新页面，浏览器中 `crossOriginIsolated` 应为 `true`。

#### 在局域网访问网页渲染

在运行前端和存放播放器的 Windows 电脑上，用 PowerShell 7 在项目根目录执行以下命令。将示例地址换成实际网卡地址，启动后保留窗口。

```powershell
.\scripts\startUnityWebLan.ps1 -Address 192.168.10.247
```

脚本读取 `.env.development.local` 中的业务地址和应用根路径，构建独立的局域网页面，并通过同一加密地址转发业务和渲染请求。控制台会显示场景列表地址和公开证书位置。网页构建产物位于 `dist/web-unity-lan/`，原有开发命令可同时使用。

如需让旧的局域网页面链接自动跳转，在 `.env.development.local` 设置 `UNITY_WEB_LAN_REDIRECT_ORIGIN=https://192.168.10.247:8443`，填写控制台显示的加密站点根地址。普通网页入口保留原来的页面路径和查询参数，并将同一主机的浏览器导航重定向到加密站点。

将 `.tmp/unity-web-lan/` 下本次地址对应的「网页渲染」证书通过可信渠道发给访问者。Windows 客户端可把它导入「当前用户 → 受信任的根证书颁发机构」，然后用支持网页图形接口的浏览器打开控制台显示的场景列表地址。若签名模型下载服务也使用内网证书，客户端需一并信任下载服务提供的证书。网卡地址变化或证书到期时，按启动输出分发新证书。

### 0.5 启动云渲染并进入场景

云渲染不用先双击 `CloudRender.exe`。要先开 Launcher，再在网页里点「Unity 云渲染」，Launcher 才会把播放器拉起来。

文件在 Launcher 工程里，不在 Unity 工程里：

```text
<Launcher工程>\scripts\启动Launcher-正式模式.bat
<Launcher工程>\scripts\springboot-websocket-client-1.0-SNAPSHOT.jar
```

本机 Launcher 工程是 `D:\UnityProject\UGit\jtyf-pixelstreamlauncher`。另一台电脑向拿到 Unity 工程的人要这份 Launcher。电脑上要能在命令行执行 `java -version`，并且是 Java 17。

1. 右键 `启动Launcher-正式模式.bat`，选「编辑」或「打开方式 / 记事本」。不要直接双击，否则还没改路径就会按旧机器启动。
2. 文件里只有一条 `java -jar`。改两个等号后面的值，其余不要动：

```text
--webserver.host=ws://192.168.10.148
--process.path.unity=D:\UnityProject\jtyf-dts-webgpu\cloud\CloudRenderLaunch.exe
```

`--webserver.host` 改成自己 `.env.development.local` 里的信令主机，保留 `ws://`，不要加端口，端口已经写在下一参数 `--webserver.port=8923`。`--process.path.unity` 改成自己机器上的 `<Unity工程>\cloud\CloudRenderLaunch.exe`。保存并关闭记事本。

3. 回到资源管理器，双击刚保存的 `启动Launcher-正式模式.bat`。黑色窗口要一直留着。窗口里出现 WebSocket 连接成功后，Launcher 已经在信令上登记。这时还不会出现 Unity 画面。
4. 浏览器回到 `http://localhost:5180/dts/sceneManage`。对非 GIS 场景点「进入」，在「选择渲染方式」里点「Unity 云渲染」。
5. 点下去之后，Launcher 才启动 `<Unity工程>\cloud\CloudRenderLaunch.exe`，再由它打开旁边的 `cloud\player\CloudRender.exe`。播放器窗口可以留在后台。网页编辑页中间的视频出现模型和地面后，这条链路就通了。

不要直接双击 `cloud\player\CloudRender.exe`，那样没有资源目录和信令参数。页面停在「等待 Launcher 启动 Unity」时，看黑色窗口是否还在、bat 里的 exe 路径在资源管理器里是否真的存在、信令是否还有空闲席位。要换调试模式时，先关掉这个黑窗口，再改运行同目录的 `启动Launcher-调试模式.bat`。

## 1. 网页里到底嵌了什么

场景列表点「进入」后选一种方式，编辑页地址带上 `renderMode`。中间画布按这个参数挂不同的东西。

| 选择 | 网页中间放什么 | Unity 跑在哪里 |
| --- | --- | --- |
| Unity WebGPU | 一块 `<canvas>`，浏览器把打好的 Web 包加载进去 | 当前浏览器里的 wasm |
| Unity 云渲染 | 一块 `<video>`，里面是远端播过来的画面 | Windows 播放器，或正在 Play 的 Unity 编辑器 |
| 现有编辑模式 | 原来的网页三维画布 | 不启动 Unity |

WebGPU 的加载在 `WebUnityTransport`：向 `VITE_UNITY_WEB_BOOTSTRAP_URL` 要构建文件地址，再调用 Unity 的 `createUnityInstance`。命令通过 `SendMessage` 送进这块 canvas。

云渲染的加载在 `LegacyUnityTransport`：网页连信令，和渲染端建立 WebRTC。视频进 `<video>`，鼠标键盘和场景命令走数据通道。

两边进 Unity 之后的命令相同，都是 `editor.v1`：加载普通三维或 GIS 草稿、选中、移动旋转缩放。GIS 需要使用新增 GIS 能力的播放器，数据源范围与配置见 [GIS 双端渲染接入](GIS双端渲染接入.md)。

改 Vue 页面不用打 Unity。改 Unity 的 C#、场景或播放器逻辑，要按下面第 3 节让对应那一端重新跑到新代码。

## 2. 打包工具

Unity 构建工具生成播放器后，将网页播放器和匹配资源更新到当前前端项目的以下目录，再执行前端构建。云渲染使用其原有交付目录。

```text
<网页工程>/public/unity-web/player
<网页工程>/public/unity-web/art/9tyf
<网页工程>/public/unity-web/ArtStartupRelease.json
<工程根>/cloud/player/CloudRender.exe
<工程根>/cloud/art
<工程根>/cloud/ArtStartupRelease.json
<工程根>/cloud/CloudRenderLaunch.exe
```

Unity 编辑器已经打开工程时，用菜单：

- `产品工具 / 双端打包 / 打包 WebGPU 播放器`
- `产品工具 / 双端打包 / 打包云渲染播放器`

编辑器没开时，在任意电脑的工程里执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\Tools\DualRender\package.ps1 -Target webgpu
powershell -ExecutionPolicy Bypass -File .\Tools\DualRender\package.ps1 -Target cloud
```

脚本根据 `ProjectSettings\ProjectVersion.txt` 找 Unity。找不到时用 `-UnityEditor` 指向本机的 `Unity.exe`，或设置环境变量 `UNITY_EDITOR`。工程正被编辑器打开时，命令行打包会停下来，改用上面的菜单。

云渲染菜单打完播放器后，会顺带生成 `cloud\CloudRenderLaunch.exe`。这个启动器不再写死盘符：它和 `player`、`art`、`ArtStartupRelease.json` 放在一起，启动时按自己的位置找播放器和资源，并当场计算描述文件的 SHA-256。把整个 `cloud` 目录拷到另一台机器，只要内部这几项目录还在，就能拉起。

只重新生成启动器、不重打播放器：

```powershell
powershell -ExecutionPolicy Bypass -File .\Tools\DualRender\package.ps1 -Target launcher
```

模型资源通过现有 Unity 发布工具构建，网页交付更新到前端 `public/unity-web/art/9tyf/` 并同步启动描述。网页单个资源包上限为 32 MiB。前端执行 `pnpm build` 时会一同交付网页、播放器、资源和启动网关。

另一台电脑启动网页网关时，保留当前项目的 `public/unity-web/` 交付目录，双击 `scripts/启动WebGPU网关.bat`。默认相对路径由脚本定位到当前项目根目录。

## 3. 改了 Unity 代码，要不要打包

要看你改的是哪一端，以及你准备用编辑器还是用打好的包。

**WebGPU 必须重新打 Web 包。** 浏览器跑的是上次 Build 出来的 wasm，不会读编辑器里刚改的脚本。编辑器里按 Play，只在 Game 窗口里跑，网页上的 canvas 不会跟着变。打完 Web 包、放到网关正在读的目录后，刷新网页即可。网关每次请求都直接读磁盘，不用为了换包重启网关。

**平时选「云渲染」看到的是打好的 exe。** Launcher 拉起 `cloud\CloudRenderLaunch.exe`，再由它启动同目录里的 `player\CloudRender.exe`。C# 改动要用打包工具重新打云渲染播放器，下次进场景才会是新代码。启动器不用因为换了一台电脑而改路径。

**云渲染也可以改用编辑器 Play，不走这个自动启动。** 需要先把 Launcher 换成调试模式，让它收到 `StartProcess` 时不要拉 exe。然后在编辑器里 Play，由编辑器自己连信令。脚本改完，等编译结束，重新 Play，网页里就是新代码。步骤在第 4.3 节。当前 Launcher 若仍是正式模式，每次选云渲染都会继续启动 exe。

只改了模型、没改播放器代码时，重打对应平台的资源包即可，不用重打 Web 包或 exe。

## 4. 每个端怎么启动

先做一次，两边共用：

1. 在 `D:\UnityProject\wx-vue-unity` 执行 `pnpm dev`。
2. 浏览器打开 `http://localhost:5180`。WebGPU 不要用 `127.0.0.1` 或局域网 IP。
3. 登录。

`.env.development.local` 里填写当前环境的云渲染配置，以及网页入口 `VITE_UNITY_WEB_BOOTSTRAP_URL=./unity-runtime/bootstrap`。改完要重启 `pnpm dev`。

### 4.1 看 WebGPU

确认当前前端项目的 `public/unity-web/` 已有播放器、网页资源和启动描述，双击 `scripts/启动WebGPU网关.bat`，保持网关运行。在场景列表点「进入」，选「Unity WebGPU」，状态走到「Unity 场景已就绪」后即可操作。

### 4.2 看打包好的 Windows 云渲染

选「Unity 云渲染」之后 exe 会自己出现。网页没有去启动它，顺序是：

1. 网页连上信令，登记一次观看请求。
2. 信令向已经在线的 Launcher 发 `StartProcess`。
3. Launcher 处于正式模式时，拉起 `cloud\CloudRenderLaunch.exe`。这个小程序再带上 Windows 资源描述，启动 `cloud\player\CloudRender.exe`。
4. 播放器连回信令，和网页建立 WebRTC，画面进到中间的视频里。离开页面后，信令会再发 `StopProcess`，Launcher 关掉这个进程。

进场景之前要先就绪的是信令和 Launcher，不是 exe：

1. 信令在线。联调记录里的地址是 `ws://192.168.10.148:8923`，以环境文件里的 `VITE_UNITY_CLOUD_SIGNAL_URL` 为准。
2. Launcher 已连上这台信令，并且有空闲席位。模式在启动 Launcher 时选定，运行中不能改。正式模式用 `D:\UnityProject\UGit\jtyf-pixelstreamlauncher\scripts\启动Launcher-正式模式.bat`，点「云渲染」时会拉起 exe。调试模式用同目录的 `启动Launcher-调试模式.bat`，只登记、不拉 exe，留给第 4.3 节。切换时先关掉当前那个 Java 窗口，再双击另一个 bat。
3. 环境文件里的 `VITE_UNITY_CLOUD_CLIENT_ID` 留空。网页自己生成连接编号，由 Launcher 分配播放器。

Launcher 没开、席位已满，或它指向的 exe 路径不对时，页面会停在「等待 Launcher 启动 Unity」。此时不会出现播放器窗口。

### 4.3 不打包，用编辑器看云渲染

这条只影响云渲染。WebGPU 仍然要看第 4.1 节的 Web 包。

1. 信令在线，和网页环境文件里的地址一致。
2. 关掉当前 Launcher 窗口，改运行 `启动Launcher-调试模式.bat`。它收到 `StartProcess` 时不拉 exe。若仍用正式模式，网页会连到 `cloud\player\CloudRender.exe`，而不是编辑器。
3. 打开 `Assets/Scenes/StartScene.unity`。在带「用户ID」的组件上，把 `testUser` 设成和网页 `VITE_UNITY_CLOUD_CLIENT_ID` 完全相同的字符串。联调时用过 `web-unity-editor`。
4. 网页环境文件写上同一个 `VITE_UNITY_CLOUD_CLIENT_ID`，然后重启 `pnpm dev`。
5. Unity 里按 Play。编辑器会用 `testUser` 作为连接编号去连信令。
6. 浏览器进非 GIS 场景，选「Unity 云渲染」。

调试模式只让启动服务保持在线并跳过拉起播放器，不会把网页动态生成的连接编号传给编辑器。
网页与编辑器必须使用相同的固定编号。编辑器控制台除了“WS connected”，还应出现发送
`rendererConnect` 的记录，其中 `ClientID`、`RendererPlatformID`、`ProjectID` 分别对应
`testUser`、启动服务登记的物理网卡和当前项目。只有套接字连接成功而没有此注册报文时，
信令不会把网页配对到编辑器。信令断线重连后也会重新发送相同身份的注册报文。
切回正式播放器模式前，清空 `VITE_UNITY_CLOUD_CLIENT_ID` 并重启网页开发服务，避免多个页面共用编辑器编号。

网页上的视频就是当前 Game 窗口。停掉 Play 再 Play，才能看到新编译的脚本。同一连接编号不要开着旧 exe。

## 5. 对照

| 你改了什么 | WebGPU 页面 | 云渲染页面 |
| --- | --- | --- |
| 只改了 Vue | 保存后刷新网页 | 保存后刷新网页 |
| 改了 Unity C# | 重新 Build Web，再刷新网页 | 重新打 exe，下次选云渲染时 Launcher 会启动新包；或先改调试模式再用编辑器 Play |
| 只改了模型资源 | 重打 Web 资源包 | 重打 Windows 资源包 |
| 编辑器里只按 Play | 网页不变 | 调试模式 Launcher 配好后，网页能看到 |

## 6. 云渲染流畅度与诊断

云端 `RenderStreamingCtrl` 上的 `CloudStreamingProfile` 会在信令启动前选择编码器。检测到硬件 H.264 时使用 1920×1080、60 FPS、2～12 Mbps；没有硬件 H.264 时使用 VP8、1280×720、30 FPS、2～5 Mbps，并输出降级警告。当前 Unity WebRTC 包中的 AV1/Internal 是软件编码，避免恢复成原来的 2560×1440 AV1 配置。

启动日志应包含 `[CloudStreaming] 1920x1080@60 codec=video/H264 implementation=NvCodec`。帧率设置是目标上限，实际帧率还取决于场景负载、网络和浏览器。此策略只作用于云端推流对象；Web 构建会移除该对象。

前端将高频鼠标移动合并为每 8 ms 最多一条，保留最新位置和累计相对位移；输入发送缓冲达到 4 KiB 时暂缓移动。按键、点击、滚轮和释放事件仍可靠有序发送，避免卡键。切换焦点、断线时清除待发移动。

连接后每秒采样一次 WebRTC 统计。在网页开发者工具 Console 执行：

```js
JSON.parse(document.querySelector('.unity-cloud-video')?.dataset.cloudStats || 'null')
```

`fps` 是区间接收解码帧率，`rttMs` 是 ICE 网络往返时间，`jitterBufferMs` 是区间平均视频缓冲时间，`decodeMs` 是区间平均解码时间；它们不能直接相加当作操作到画面的完整延迟。`packetsLost`、`framesDropped` 为累计计数，`inputBufferedBytes` 为输入通道待发送字节数。首个样本或浏览器没有提供的指标返回 `null`。离开云端视口后停止采样。

2026-10-29 已使用本机 RTX 4060 和正式 Launcher 验证普通三维 → GIS → 普通三维切换：三个阶段均为 H.264、1920×1080，阶段末接收帧率约 60 FPS，累计丢包和丢帧均为 0。该结果来自本机浏览器与播放器，不能代表公网环境或大型业务场景的性能。
