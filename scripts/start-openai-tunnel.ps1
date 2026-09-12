param(
  [string]$Profile = "codex_MCP",
  [string]$HealthAddr = "127.0.0.1:8081"
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$root = Join-Path $projectRoot "tunnel\openai"
$pendingRoot = Join-Path $root "pending-update"
$pendingClient = Join-Path $pendingRoot "tunnel-client.exe"
$client = if (Test-Path -LiteralPath $pendingClient) { $pendingClient } else { Join-Path $root "tunnel-client.exe" }
$profileDir = Join-Path $root "profiles"
$keyFile = Join-Path $root "control-plane-api-key.txt"

if (-not (Test-Path -LiteralPath $client)) {
  throw "OpenAI tunnel-client is missing. Run init-windows.cmd and choose OpenAI."
}
if ($client -eq $pendingClient) {
  Write-Host "Using staged OpenAI tunnel-client update: $pendingClient"
}
if (-not (Test-Path -LiteralPath (Join-Path $profileDir "$Profile.yaml"))) {
  throw "OpenAI tunnel profile is missing. Run init-windows.cmd and choose OpenAI."
}

if (-not $env:CONTROL_PLANE_API_KEY -and (Test-Path -LiteralPath $keyFile)) {
  $env:CONTROL_PLANE_API_KEY = (Get-Content -LiteralPath $keyFile -Raw).Trim()
}
if (-not $env:CONTROL_PLANE_API_KEY) {
  $secure = Read-Host "CONTROL_PLANE_API_KEY for this session" -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    $env:CONTROL_PLANE_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}
if (-not $env:CONTROL_PLANE_API_KEY) { throw "CONTROL_PLANE_API_KEY is empty." }

$configPath = Join-Path $projectRoot "config.json"
if (Test-Path -LiteralPath $configPath) {
  try {
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    if ($config.proxy.url) {
      $env:HTTP_PROXY = [string]$config.proxy.url
      $env:HTTPS_PROXY = [string]$config.proxy.url
      $env:http_proxy = [string]$config.proxy.url
      $env:https_proxy = [string]$config.proxy.url
    }
  } catch {
    Write-Warning "Could not read proxy settings from config.json: $($_.Exception.Message)"
  }
}
$env:NO_PROXY = "127.0.0.1,localhost,::1"
$env:no_proxy = $env:NO_PROXY

Write-Host "Running tunnel-client doctor..."
& $client doctor --profile $Profile --profile-dir $profileDir --explain --health.listen-addr $HealthAddr
if ($LASTEXITCODE -ne 0) {
  Write-Warning "tunnel-client doctor reported warnings/errors; continuing so the runtime can show the exact failure."
}
Write-Host "Starting OpenAI Secure MCP Tunnel..."
& $client run --profile $Profile --profile-dir $profileDir --health.listen-addr $HealthAddr
exit $LASTEXITCODE
