# 双端 Unity 渲染使用说明

网页工程不包含 Unity 播放器。它只在编辑页中间那块区域挂上 Unity 的画面，四周仍是现在的 Vue 面板。场景数据、保存和发布还是网页自己的。

GIS 和非 GIS 均加载 Unity 的完整 `StartScene`。GIS 直接使用其中已有的地理根、地表和影像；非 GIS 隐藏地理地表，使用本地坐标、底板及网格。网页加载的业务配置用于添加或编辑对象，不会切换到另一个 Unity Scene。两种模式分别保留相机视角；首次进入 GIS 会避免沿用只有数米高度的本地相机位置。

当前为联调临时使用 Cesium ion 的 Sentinel-2 影像（`CesiumIonRasterOverlay.ionAssetID=3954`），仍由 Unity 原生 GIS 渲染。原 Google 影像 `3830182` 曾返回 429，切换并未使用内网影像。Sentinel-2 的近景清晰度较低；以后更换资源需更新 StartScene 并重新发布播放器。

正式产物放在 Unity 工程里、和 `Assets` 同级的 `webgpu`、`cloud` 两个目录。网页不保存这个目录，进场景时也不会在磁盘上搜索 Unity 工程。

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
VITE_UNITY_WEB_BOOTSTRAP_URL=https://localhost:5191/bootstrap
```

`VITE_UNITY_CLOUD_CLIENT_ID` 留空。改完环境文件后重新执行 `pnpm dev`。浏览器只打开 `http://localhost:5180`，不要用 `127.0.0.1` 或局域网 IP。用业务账号登录。

### 0.2 打两个播放器

用对应版本的 Unity 打开 `<Unity工程>`，等脚本编译完成、Console 没有红色错误。然后点：

1. `产品工具 / 双端打包 / 打包 WebGPU 播放器`
2. `产品工具 / 双端打包 / 打包云渲染播放器`

GIS 由 Unity 工程中的 Cesium for Unity 渲染，网页不安装 CesiumJS。WebGPU GIS 需要原生线程，WebGPU 打包菜单会启用它。当前 Unity 6000.6.7f1 工具链还需要重编随 Cesium 嵌入包提供的 SQLite，步骤见 Unity 工程 `Tools/Cesium/README.md`；升级工具链或重新导入 Cesium 后应重新验证。

两条都会花较长时间，并切换 Unity 的当前平台。完成后应有：

```text
<Unity工程>\webgpu\player\Build\
<Unity工程>\cloud\player\CloudRender.exe
<Unity工程>\cloud\CloudRenderLaunch.exe
```

编辑器正开着这个工程时，不要再运行命令行打包。编辑器关掉之后，才可以在 `<Unity工程>` 里执行 `Tools\DualRender\package.ps1 -Target webgpu` 或 `-Target cloud`。

### 0.3 放入模型资源

播放器包里没有场景用的模型。两个端还要各有一份资源发布，而且不能互换：

```text
<Unity工程>\webgpu\art\
<Unity工程>\webgpu\ArtStartupRelease.json
<Unity工程>\cloud\art\
<Unity工程>\cloud\ArtStartupRelease.json
```

已有发布目录时，整份拷进对应的 `art`，并把其中的 `ArtStartupRelease.json` 放到 `player` 的上一级。还没有发布时，在 Unity 里打开 `产品工具 / 资源热更工作台`，Web 平台发布到 `webgpu\art`，Windows 平台发布到 `cloud\art`。Web 单个资源包不要超过 32 MiB。缺这两个目录时，网关起不来，云渲染启动器也会在拉起播放器前退出。

### 0.4 启动 WebGPU 并进入场景

和云渲染一样，只改一次路径，以后双击启动。文件在网页工程里：

```text
<网页工程>\scripts\启动WebGPU网关.bat
```

1. 右键这个 bat，选「编辑」。把开头的 `set UNITY_PROJECT=` 改成自己的 Unity 根目录，也就是里面有 `Assets` 的那一层。保存。
2. 回到资源管理器，双击 `启动WebGPU网关.bat`。窗口留着。它会先检查本机证书，再启动网关。出现 `Unity Web local gateway listening on https://localhost:5191` 后不要关。关掉窗口等于 WebGPU 入口断开。
3. 浏览器打开 `http://localhost:5180/dts/sceneManage`。未登录时按页面提示登录。对普通三维或 GIS 场景点「进入」，在「选择渲染方式」里点「Unity WebGPU」。
4. 编辑页中间先显示加载百分比，再到「Unity 场景已就绪」。包来自 `UNITY_PROJECT` 下面的 `webgpu\player`。

「Unity WebGPU」是灰色时，检查 `.env.development.local` 里的 `VITE_UNITY_WEB_BOOTSTRAP_URL` 是否为 `https://localhost:5191/bootstrap`，保存后重新运行 `pnpm dev`。按钮写着浏览器不支持时，换 Chrome 或 Edge，地址必须是 `localhost`。

线程版播放器需要主网页提供 `Cross-Origin-Opener-Policy: same-origin` 和 `Cross-Origin-Embedder-Policy: credentialless`（或 `require-corp`），并使用 HTTPS 或受信任的 localhost。Vite 开发与预览服务已提供这些头；生产环境须在网页服务器上配置，不能只加在播放器资源服务器。部署配置的 `build.threadsRequired` 应设为 `true`。修改响应头后完整刷新页面，浏览器中 `crossOriginIsolated` 应为 `true`。

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

别人的电脑工程不在 `D:\` 时，不能把盘符写进播放器或启动器。打包工具只认「当前 Unity 工程根目录」，两个端都输出到和 `Assets` 同级的目录：

```text
<工程根>/webgpu/player
<工程根>/webgpu/art
<工程根>/webgpu/ArtStartupRelease.json
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

模型资源仍用 `AssetBundelTools` 发布。WebGPU 发布到 `webgpu\art`，云渲染发布到 `cloud\art`，两边各放自己的 `ArtStartupRelease.json`。Web 单个资源包不要超过 32 MiB。Windows 资源包不能拿来当 Web 资源包。网页自己的 `pnpm build` 只打网站。

另一台电脑启动网页网关时，编辑 `<网页工程>\scripts\启动WebGPU网关.bat` 开头的 `UNITY_PROJECT`，然后双击。不要沿用别人机器上的盘符。网关读取的仍是该工程下的 `webgpu\player` 和 `webgpu\art`。

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

`.env.development.local` 里要有云渲染信令、appId、sceneKey，以及 Web 的 `VITE_UNITY_WEB_BOOTSTRAP_URL=https://localhost:5191/bootstrap`。改完要重启 `pnpm dev`。

### 4.1 看 WebGPU

Unity 编辑器不用开，也不用按 Play。确认 `webgpu\player` 和 `webgpu\art` 已经在 Unity 工程里。编辑 `<网页工程>\scripts\启动WebGPU网关.bat` 里的 `UNITY_PROJECT`，双击后窗口留着。看到监听 `https://localhost:5191` 后，在场景列表点「进入」，选「Unity WebGPU」。网页会下载 wasm，状态走到「Unity 场景已就绪」后就是当前 Web 包。

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
