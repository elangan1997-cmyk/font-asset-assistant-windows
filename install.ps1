$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ExtensionId = 'com.liz.fontassetassistant.cep'
$Target = Join-Path $env:APPDATA 'Adobe\CEP\extensions\com.liz.fontassetassistant.cep'
$Source = Join-Path $ScriptDir 'extension'

if (-not (Test-Path (Join-Path $Source 'CSXS\manifest.xml'))) { throw '安装包不完整：缺少 CEP 清单。' }
if (-not (Test-Path (Join-Path $Source 'scripts\ocr.ps1'))) { throw '安装包不完整：缺少 Windows OCR 脚本。' }

New-Item -ItemType Directory -Force -Path (Split-Path $Target) | Out-Null
if (Test-Path $Target) {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  Rename-Item $Target ($ExtensionId + '.backup-' + $stamp)
}
Copy-Item $Source $Target -Recurse -Force

for ($version = 9; $version -le 20; $version++) {
  $key = "HKCU:\Software\Adobe\CSXS.$version"
  New-Item -Path $key -Force | Out-Null
  New-ItemProperty -Path $key -Name PlayerDebugMode -PropertyType String -Value '1' -Force | Out-Null
}

Write-Host "安装完成：$Target"
Write-Host '请重启 Photoshop，然后从“窗口 -> 扩展功能（旧版）”打开“字体与素材助手”。'
