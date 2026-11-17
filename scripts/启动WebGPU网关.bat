@echo off
chcp 65001 > nul
cd /d %~dp0

rem 资源包由管理页选择；启动脚本统一准备证书并选择第七版命令行运行库。
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0startUnityWebDevGateway.ps1"
echo 网关已退出
pause
