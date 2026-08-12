$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Source = Join-Path $ScriptDir 'psd-image-text-rebuild'
$Target = Join-Path $env:USERPROFILE '.codex\skills\psd-image-text-rebuild'
New-Item -ItemType Directory -Force -Path (Split-Path $Target) | Out-Null
if (Test-Path $Target) { Remove-Item $Target -Recurse -Force }
Copy-Item $Source $Target -Recurse -Force
Write-Host "Skill installed to $Target"
