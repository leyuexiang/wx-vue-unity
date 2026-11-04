param(
    # 别的电脑用自己的工程路径：-UnityProject E:\work\jtyf-dts-webgpu，或先设置环境变量 UNITY_PROJECT。
    [string]$UnityProject = $(if ($env:UNITY_PROJECT) { $env:UNITY_PROJECT } else { 'D:\UnityProject\jtyf-dts-webgpu' })
)

$frontendRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$unityRoot = (Resolve-Path -LiteralPath $UnityProject).Path
$releaseRoot = Join-Path $unityRoot 'webgpu\art'
$descriptor = Join-Path $unityRoot 'webgpu\ArtStartupRelease.json'
$player = Join-Path $unityRoot 'webgpu\player'
$certDir = Join-Path $frontendRoot '.tmp\unity-web-dev'
$key = Join-Path $certDir 'localhost-key.pem'
$cert = Join-Path $certDir 'localhost-cert.pem'

foreach ($item in @($releaseRoot, $descriptor, $player, $key, $cert)) {
    if (-not (Test-Path -LiteralPath $item)) { throw "Unity Web 本地配置缺少文件：$item" }
}

$env:UNITY_WEB_DEV_PLAYER_DIR = $player
$env:UNITY_WEB_DEV_ART_DIR = $releaseRoot
$env:UNITY_WEB_DEV_DESCRIPTOR_FILE = $descriptor
$env:UNITY_WEB_DEV_TLS_KEY = $key
$env:UNITY_WEB_DEV_TLS_CERT = $cert
# 本地页面与148身份服务保持同一套联调配置，避免登录身份被送往旧服务。
$env:UNITY_WEB_DEV_PAGE_ORIGIN = 'http://127.0.0.1:18065'
$env:UNITY_WEB_DEV_BACKEND = 'http://192.168.10.148:12522'
$env:UNITY_WEB_DEV_PROJECT_ID = '1'
$env:UNITY_WEB_DEV_PROJECT_NAME = '9tyf'

Push-Location $frontendRoot
try { node --experimental-strip-types server/unityWebDevGateway.ts }
finally { Pop-Location }
