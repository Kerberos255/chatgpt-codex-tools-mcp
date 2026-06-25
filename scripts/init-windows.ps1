param(
  [string]$AllowedRoots = "",
  [string]$Profile = "codex_MCP",
  [int]$Port = 3333,
  [string]$TunnelId = "",
  [string]$TunnelClientPath = "",
  [string]$ProxyUrl = "",
  [string]$HealthAddr = "127.0.0.1:8081",
  [switch]$SkipBuild,
  [switch]$InitTunnelProfile,
  [switch]$OpenTunnelDownloadPages
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

function Write-Step([string]$Text) {
  Write-Host ""
  Write-Host "==> $Text"
}

function Quote-CmdValue([string]$Value) {
  return $Value.Replace('^', '^^').Replace('&', '^&').Replace('|', '^|').Replace('<', '^<').Replace('>', '^>')
}

function Quote-PsValue([string]$Value) {
  return "'" + $Value.Replace("'", "''") + "'"
}

Write-Step "Configure allowed workspace roots"
if (-not $AllowedRoots) {
  $AllowedRoots = Read-Host "Allowed roots, comma-separated, for example D:\Projects"
}
if (-not $AllowedRoots) {
  throw "Allowed roots cannot be empty."
}

Write-Step "Install and build Node project"
if (-not $SkipBuild) {
  npm install
  npm run build
} else {
  Write-Host "Skipped npm install/build."
}

Write-Step "Locate tunnel-client"
$defaultTunnelClient = Join-Path $projectRoot "tools\tunnel-client\tunnel-client.exe"
if (-not $TunnelClientPath) {
  if ($env:TUNNEL_CLIENT) {
    $TunnelClientPath = $env:TUNNEL_CLIENT
  } elseif (Test-Path -LiteralPath $defaultTunnelClient) {
    $TunnelClientPath = $defaultTunnelClient
  }
}

if (-not $TunnelClientPath -or -not (Test-Path -LiteralPath $TunnelClientPath)) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $defaultTunnelClient) | Out-Null
  Write-Host "tunnel-client.exe was not found."
  Write-Host "Recommended local path: $defaultTunnelClient"
  Write-Host "Download it from OpenAI Platform tunnel settings or the latest openai/tunnel-client release, then rerun this script with:"
  Write-Host "  -TunnelClientPath `"$defaultTunnelClient`""
  if ($OpenTunnelDownloadPages) {
    Start-Process "https://platform.openai.com/settings/organization/tunnels"
    Start-Process "https://github.com/openai/tunnel-client/releases/latest"
  }
} else {
  Write-Host "Found tunnel-client: $TunnelClientPath"
}

Write-Step "Write local start scripts"
$allowedEscaped = Quote-CmdValue $AllowedRoots
$profileEscaped = Quote-CmdValue $Profile
$tunnelEscaped = Quote-CmdValue $TunnelClientPath
$proxyEscaped = Quote-CmdValue $ProxyUrl
$healthEscaped = Quote-CmdValue $HealthAddr

$profilePs = Quote-PsValue $Profile
$tunnelPs = Quote-PsValue $TunnelClientPath
$proxyPs = Quote-PsValue $ProxyUrl
$healthPs = Quote-PsValue $HealthAddr

$startMcp = @"
@echo off
setlocal EnableExtensions
cd /d "%~dp0"
set "CTM_ALLOWED_ROOTS=$allowedEscaped"
set "CTM_ACCESS_MODE=review"
set "PORT=$Port"
powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\start-mcp.ps1"
pause
"@
Set-Content -LiteralPath (Join-Path $projectRoot "start-mcp.local.cmd") -Value $startMcp -Encoding ASCII

$startTunnelCmd = @"
@echo off
setlocal EnableExtensions
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File ".\start-tunnel.local.ps1"
pause
"@
Set-Content -LiteralPath (Join-Path $projectRoot "start-tunnel.local.cmd") -Value $startTunnelCmd -Encoding ASCII

$startTunnelPs1 = @"
`$ErrorActionPreference = "Stop"
Set-Location -LiteralPath `$PSScriptRoot

`$Profile = $profilePs
`$HealthAddr = $healthPs
`$TunnelClient = $tunnelPs
`$ProxyUrl = $proxyPs

if (`$ProxyUrl) {
  `$env:HTTP_PROXY = `$ProxyUrl
  `$env:HTTPS_PROXY = `$ProxyUrl
  `$env:http_proxy = `$ProxyUrl
  `$env:https_proxy = `$ProxyUrl
  `$env:ALL_PROXY = `$ProxyUrl
  `$env:all_proxy = `$ProxyUrl
}
`$env:NO_PROXY = "127.0.0.1,localhost,::1"
`$env:no_proxy = "127.0.0.1,localhost,::1"

if (-not `$env:CONTROL_PLANE_API_KEY) {
  `$secureKey = Read-Host "Paste CONTROL_PLANE_API_KEY for this session" -AsSecureString
  `$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR(`$secureKey)
  try {
    `$env:CONTROL_PLANE_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR(`$bstr)
  } finally {
    if (`$bstr -ne [IntPtr]::Zero) {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR(`$bstr)
    }
  }
}

if (-not `$env:CONTROL_PLANE_API_KEY) {
  throw "CONTROL_PLANE_API_KEY is empty."
}

if (-not (Test-Path -LiteralPath `$TunnelClient)) {
  throw "tunnel-client.exe not found: `$TunnelClient"
}

& `$TunnelClient doctor --profile `$Profile --explain --health.listen-addr `$HealthAddr
if (`$LASTEXITCODE -ne 0) {
  Write-Host ""
  Write-Host "doctor reported warnings/errors. In No Authentication mode, OAuth metadata warnings may be expected."
  Write-Host "Continuing to run tunnel-client..."
  Write-Host ""
}

& `$TunnelClient run --profile `$Profile --health.listen-addr `$HealthAddr
"@
Set-Content -LiteralPath (Join-Path $projectRoot "start-tunnel.local.ps1") -Value $startTunnelPs1 -Encoding UTF8

Write-Host "Created start-mcp.local.cmd"
Write-Host "Created start-tunnel.local.cmd"
Write-Host "Created start-tunnel.local.ps1"

if ($InitTunnelProfile) {
  Write-Step "Initialize tunnel profile"
  if (-not $TunnelClientPath -or -not (Test-Path -LiteralPath $TunnelClientPath)) {
    throw "Cannot initialize profile because tunnel-client.exe was not found."
  }
  if (-not $TunnelId) {
    $TunnelId = Read-Host "Tunnel id, for example tunnel_xxx"
  }
  if (-not $TunnelId) {
    throw "Tunnel id cannot be empty when -InitTunnelProfile is used."
  }

  & $TunnelClientPath init --sample sample_mcp_stdio_local --profile $Profile --tunnel-id $TunnelId --mcp-server-url "http://127.0.0.1:$Port/mcp"
  & $TunnelClientPath doctor --profile $Profile --explain --health.listen-addr $HealthAddr
}

Write-Step "Done"
Write-Host "Next steps:"
Write-Host "1. Run start-mcp.local.cmd"
Write-Host "2. In another terminal, set CONTROL_PLANE_API_KEY for this session"
Write-Host "3. Run start-tunnel.local.cmd"
Write-Host "4. In ChatGPT connector settings, choose Tunnel and No Authentication"
