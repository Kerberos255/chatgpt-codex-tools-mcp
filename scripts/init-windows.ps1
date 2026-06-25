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

$startTunnel = @"
@echo off
setlocal EnableExtensions
cd /d "%~dp0"
set "PROFILE=$profileEscaped"
set "HEALTH_ADDR=$healthEscaped"
set "TUNNEL_CLIENT=$tunnelEscaped"
set "PROXY_URL=$proxyEscaped"

if not "%PROXY_URL%"=="" (
  set "HTTP_PROXY=%PROXY_URL%"
  set "HTTPS_PROXY=%PROXY_URL%"
  set "http_proxy=%PROXY_URL%"
  set "https_proxy=%PROXY_URL%"
  set "ALL_PROXY=%PROXY_URL%"
  set "all_proxy=%PROXY_URL%"
)
set "NO_PROXY=127.0.0.1,localhost,::1"
set "no_proxy=127.0.0.1,localhost,::1"

if "%CONTROL_PLANE_API_KEY%"=="" (
  echo Set CONTROL_PLANE_API_KEY in this terminal before running the tunnel.
  echo Example: set "CONTROL_PLANE_API_KEY=sk-..."
  pause
  exit /b 1
)

if not exist "%TUNNEL_CLIENT%" (
  echo tunnel-client.exe not found: %TUNNEL_CLIENT%
  pause
  exit /b 1
)

"%TUNNEL_CLIENT%" doctor --profile "%PROFILE%" --explain --health.listen-addr "%HEALTH_ADDR%"
if errorlevel 1 (
  echo.
  echo doctor reported warnings/errors. In No Authentication mode, OAuth metadata warnings may be expected.
  echo Continuing to run tunnel-client...
  echo.
)
"%TUNNEL_CLIENT%" run --profile "%PROFILE%" --health.listen-addr "%HEALTH_ADDR%"
pause
"@
Set-Content -LiteralPath (Join-Path $projectRoot "start-tunnel.local.cmd") -Value $startTunnel -Encoding ASCII

Write-Host "Created start-mcp.local.cmd"
Write-Host "Created start-tunnel.local.cmd"

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
