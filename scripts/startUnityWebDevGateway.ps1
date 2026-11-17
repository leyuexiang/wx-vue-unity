param(
    # 资源包位置由管理页保存，启动器不再接受固定资源目录。
)

$ErrorActionPreference = 'Stop'
# 证书导出需要第七版命令行运行库；证书初始化会记录本机已验证的运行库位置。
if ($PSVersionTable.PSVersion.Major -lt 7) {
    $powerShell = Get-Command pwsh -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source
    $runtimeMarker = Join-Path $PSScriptRoot '..\.tmp\unity-web-dev\powershell-path.txt'
    if (-not $powerShell -and (Test-Path -LiteralPath $runtimeMarker)) {
        $candidate = [System.IO.File]::ReadAllText($runtimeMarker).Trim()
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $powerShell = $candidate }
    }
    if (-not $powerShell) { throw '请安装 PowerShell 7 后重新启动网页渲染网关。' }
    & $powerShell -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath
    exit $LASTEXITCODE
}

$frontendRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
# 资源包由项目配置选择，启动器只负责证书和服务环境，不再锁定某个版本。

# 证书脚本运行在独立进程，其退出不会终止网关启动器。
& (Join-Path $PSHOME 'pwsh.exe') -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'createUnityWebDevCertificate.ps1')
if ($LASTEXITCODE -ne 0) { throw '本机网页渲染证书初始化失败。' }
$certDir = Join-Path $frontendRoot '.tmp\unity-web-dev'
$key = Join-Path $certDir 'localhost-key.pem'
$cert = Join-Path $certDir 'localhost-cert.pem'

foreach ($item in @($key, $cert)) {
    if (-not (Test-Path -LiteralPath $item)) { throw "Unity Web 本地配置缺少文件：$item" }
}

$env:UNITY_WEB_DEV_TLS_KEY = $key
$env:UNITY_WEB_DEV_TLS_CERT = $cert
# 本地页面与148身份服务保持同一套联调配置，避免登录身份被送往旧服务。
$env:UNITY_WEB_DEV_PAGE_ORIGIN = 'http://localhost:18065'
# 与前端的本机启动配置保持同一个端口，避免继承其它终端的临时端口。
$env:UNITY_WEB_DEV_PORT = '5191'
$env:UNITY_WEB_DEV_BACKEND = 'http://192.168.10.148:12522'
$env:UNITY_WEB_DEV_PROJECT_ID = '1'
$env:UNITY_WEB_DEV_PROJECT_NAME = '9tyf'
# 本机入口由本网关终止加密连接，清除终端继承的远端反向代理配置。
Remove-Item Env:\UNITY_WEB_DEV_PUBLIC_ORIGIN -ErrorAction SilentlyContinue

Push-Location $frontendRoot
try { node --experimental-strip-types server/unityWebDevGateway.ts }
finally { Pop-Location }
