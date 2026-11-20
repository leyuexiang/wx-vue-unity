# 证书绑定实际局域网地址。证书私钥留在当前用户目录，输出的 .cer 仅包含公开证书。
#Requires -Version 7.0
param(
    [Parameter(Mandatory)] [ipaddress] $Address,
    [ValidateRange(1, 65535)] [int] $Port = 8443
)

$ErrorActionPreference = 'Stop'
$ip = $Address.ToString()
if ($Address.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork -or
    [ipaddress]::IsLoopback($Address) -or
    -not (Get-NetIPAddress -AddressFamily IPv4 -IPAddress $ip -ErrorAction SilentlyContinue)) {
    throw '请指定本机网卡当前的局域网 IPv4 地址。'
}

$project = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$certificateDirectory = Join-Path $env:LOCALAPPDATA "wx-vue-unity\lan-webgpu\$ip"
$publicDirectory = Join-Path $project '.tmp\unity-web-lan'
New-Item -ItemType Directory -Path $certificateDirectory, $publicDirectory -Force | Out-Null
$publicCertificate = Join-Path $publicDirectory "网页渲染-$ip.cer"
$certPem = Join-Path $certificateDirectory 'server-cert.pem'
$keyPem = Join-Path $certificateDirectory 'server-key.pem'

# 重启时复用同一张证书。局域网地址变化或证书临近到期时，生成证书后向客户端重新分发。
$certificate = if (Test-Path -LiteralPath $publicCertificate) { Get-PfxCertificate -FilePath $publicCertificate }
if ($certificate) {
    $certificate = Get-Item -LiteralPath "Cert:\CurrentUser\My\$($certificate.Thumbprint)" -ErrorAction SilentlyContinue
}
if (-not $certificate -or -not $certificate.HasPrivateKey -or $certificate.NotAfter -lt (Get-Date).AddDays(1)) {
    $certificate = New-SelfSignedCertificate -Type SSLServerAuthentication -Subject "CN=$ip" `
        -TextExtension "2.5.29.17={text}IPAddress=$ip" -CertStoreLocation 'Cert:\CurrentUser\My' `
        -KeyAlgorithm RSA -KeyLength 2048 -KeyExportPolicy Exportable -HashAlgorithm SHA256 `
        -NotAfter (Get-Date).AddDays(180)
    Export-Certificate -Cert $certificate -FilePath $publicCertificate -Force | Out-Null
}

$privateKey = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($certificate)
try { [System.IO.File]::WriteAllText($keyPem, $privateKey.ExportPkcs8PrivateKeyPem()) }
finally { $privateKey.Dispose() }
[System.IO.File]::WriteAllText($certPem, $certificate.ExportCertificatePem())

Write-Output "客户端公开证书：$publicCertificate"
Write-Output "证书指纹：$($certificate.Thumbprint)"
& node (Join-Path $PSScriptRoot 'serveUnityWebLan.mjs') "https://${ip}:$Port" $keyPem $certPem
exit $LASTEXITCODE
