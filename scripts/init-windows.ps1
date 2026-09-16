param(
  [string]$AllowedRoots = "",
  [ValidateSet("OpenAI", "Tailscale", "Both")]
  [string]$Tunnel = "",
  [int]$Port = 3333,
  [string]$ProxyUrl = "",
  [string]$OpenAIProfile = "codex_MCP",
  [string]$OpenAITunnelId = "",
  [string]$TunnelClientPath = "",
  [string]$ControlPlaneApiKeyFile = "",
  [string]$HealthAddr = "127.0.0.1:8081",
  [switch]$SkipBuild,
  [switch]$ForceConfig
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Write-Step([string]$Text) {
  Write-Host ""
  Write-Host "==> $Text"
}

function Find-NodeExe {
  $candidates = @()
  if ($env:LOCALAPPDATA) {
    $runtimeRoot = Join-Path $env:LOCALAPPDATA "OpenAI\Codex\runtimes\cua_node"
    if (Test-Path -LiteralPath $runtimeRoot) {
      $candidates += Get-ChildItem -LiteralPath $runtimeRoot -Directory -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        ForEach-Object { Join-Path $_.FullName "bin\node.exe" }
    }
  }
  if ($env:CTM_FALLBACK_NODE_BIN) {
    $candidates += Join-Path $env:CTM_FALLBACK_NODE_BIN "node.exe"
  }
  $pathNode = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($pathNode) { $candidates += $pathNode.Source }
  return $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
}

function Find-TailscaleExe {
  if ($env:CTM_TAILSCALE_EXE -and (Test-Path -LiteralPath $env:CTM_TAILSCALE_EXE)) {
    return $env:CTM_TAILSCALE_EXE
  }
  $programFiles = if ($env:ProgramFiles) { $env:ProgramFiles } else { "C:\Program Files" }
  $installed = Join-Path $programFiles "Tailscale\tailscale.exe"
  if (Test-Path -LiteralPath $installed) { return $installed }
  $command = Get-Command tailscale.exe -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  return $null
}

function Test-Health([string]$Url) {
  try {
    $response = Invoke-RestMethod -Uri $Url -TimeoutSec 2
    return [bool]$response.ok
  } catch {
    return $false
  }
}

function Copy-OpenAITunnelBundle([string]$ClientSource, [string]$Destination) {
  Copy-Item -LiteralPath $ClientSource -Destination $Destination -Force
  $sourceDir = Split-Path -Parent $ClientSource
  $destinationDir = Split-Path -Parent $Destination
  foreach ($companionName in @("cloudflared.exe", "cloudflared-manifest.json")) {
    $companionSource = Join-Path $sourceDir $companionName
    if (Test-Path -LiteralPath $companionSource) {
      Copy-Item -LiteralPath $companionSource -Destination (Join-Path $destinationDir $companionName) -Force
    }
  }
}

function Download-OpenAITunnelClient([string]$Destination) {
  Write-Step "Download OpenAI tunnel-client"
  $headers = @{ "User-Agent" = "chatgpt-codex-tools-mcp-init"; "Accept" = "application/vnd.github+json" }
  $release = Invoke-RestMethod -Uri "https://api.github.com/repos/openai/tunnel-client/releases/latest" -Headers $headers
  $platform = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "windows-arm64" } else { "windows-amd64" }
  $asset = $release.assets | Where-Object {
    $_.name -eq "$platform.zip" -or $_.name -match "^tunnel-client-v.+-$([regex]::Escape($platform))\.zip$"
  } | Select-Object -First 1
  $checksums = $release.assets | Where-Object { $_.name -eq "SHA256SUMS.txt" } | Select-Object -First 1
  if (-not $asset -or -not $checksums) {
    throw "Latest openai/tunnel-client release does not contain $platform.zip and SHA256SUMS.txt."
  }

  $temp = Join-Path ([System.IO.Path]::GetTempPath()) ("ctm-openai-tunnel-" + [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Force -Path $temp | Out-Null
  try {
    $zipPath = Join-Path $temp $asset.name
    $sumPath = Join-Path $temp "SHA256SUMS.txt"
    Invoke-WebRequest -UseBasicParsing -Uri $asset.browser_download_url -OutFile $zipPath -Headers $headers
    Invoke-WebRequest -UseBasicParsing -Uri $checksums.browser_download_url -OutFile $sumPath -Headers $headers
    $escapedName = [regex]::Escape($asset.name)
    $sumLine = Get-Content -LiteralPath $sumPath | Where-Object { $_ -match "\s+\*?$escapedName$" } | Select-Object -First 1
    if (-not $sumLine) { throw "No checksum found for $($asset.name)." }
    $expected = ($sumLine.Trim() -split "\s+")[0].ToLowerInvariant()
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $zipPath).Hash.ToLowerInvariant()
    if ($actual -ne $expected) { throw "OpenAI tunnel-client SHA256 mismatch." }

    $extract = Join-Path $temp "extract"
    Expand-Archive -LiteralPath $zipPath -DestinationPath $extract -Force
    $exe = Get-ChildItem -LiteralPath $extract -Recurse -File -Filter "tunnel-client.exe" | Select-Object -First 1
    if (-not $exe) { throw "tunnel-client.exe was not found in the downloaded archive." }
    Copy-OpenAITunnelBundle -ClientSource $exe.FullName -Destination $Destination
  } finally {
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Ensure-OpenAITunnel {
  Write-Step "Configure OpenAI Secure MCP Tunnel"
  $root = Join-Path $projectRoot "tunnel\openai"
  $profileDir = Join-Path $root "profiles"
  New-Item -ItemType Directory -Force -Path $profileDir | Out-Null
  $client = Join-Path $root "tunnel-client.exe"

  if (-not (Test-Path -LiteralPath $client)) {
    $source = $null
    foreach ($candidate in @($TunnelClientPath, $env:TUNNEL_CLIENT)) {
      if ($candidate -and (Test-Path -LiteralPath $candidate)) { $source = $candidate; break }
    }
    if (-not $source) {
      $command = Get-Command tunnel-client.exe -ErrorAction SilentlyContinue
      if ($command) { $source = $command.Source }
    }
    if ($source) {
      Copy-OpenAITunnelBundle -ClientSource $source -Destination $client
      Write-Host "Copied existing tunnel-client bundle to $client"
    } else {
      Download-OpenAITunnelClient -Destination $client
      Write-Host "Downloaded and verified tunnel-client: $client"
    }
  } else {
    Write-Host "Found tunnel-client: $client"
  }

  & $client --version | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "tunnel-client.exe did not start successfully." }

  $profilePath = Join-Path $profileDir "$OpenAIProfile.yaml"
  if (-not (Test-Path -LiteralPath $profilePath)) {
    $legacy = & $client profiles list 2>$null
    if ($LASTEXITCODE -eq 0) {
      $legacyLine = $legacy | Where-Object { $_ -match "^$([regex]::Escape($OpenAIProfile))\t" } | Select-Object -First 1
      if ($legacyLine) {
        $legacyPath = ($legacyLine -split "`t", 2)[1].Trim()
        if (Test-Path -LiteralPath $legacyPath) {
          Copy-Item -LiteralPath $legacyPath -Destination $profilePath -Force
          Write-Host "Migrated existing OpenAI tunnel profile to $profilePath"
        }
      }
    }
  }

  if (-not (Test-Path -LiteralPath $profilePath)) {
    if (-not $OpenAITunnelId) {
      $OpenAITunnelId = Read-Host "OpenAI Tunnel ID (for example tunnel_xxx)"
    }
    if (-not $OpenAITunnelId) { throw "OpenAI Tunnel ID is required." }
    & $client init --profile $OpenAIProfile --profile-dir $profileDir --tunnel-id $OpenAITunnelId --mcp-server-url "http://127.0.0.1:$Port/mcp" --health-listen-addr $HealthAddr
    if ($LASTEXITCODE -ne 0) { throw "Failed to initialize the OpenAI tunnel profile." }
  } else {
    Write-Host "Found OpenAI tunnel profile: $profilePath"
  }

  if ($ControlPlaneApiKeyFile) {
    if (-not (Test-Path -LiteralPath $ControlPlaneApiKeyFile)) { throw "CONTROL_PLANE_API_KEY file not found: $ControlPlaneApiKeyFile" }
    Copy-Item -LiteralPath $ControlPlaneApiKeyFile -Destination (Join-Path $root "control-plane-api-key.txt") -Force
    Write-Host "Copied the local runtime API key into tunnel\openai (Git ignored)."
  }

  $launcher = @"
@echo off
setlocal EnableExtensions
cd /d "%~dp0"
if errorlevel 1 exit /b 1

curl.exe -fsS "http://127.0.0.1:$Port/healthz" >nul 2>nul
if errorlevel 1 (
  start "Codex MCP Server" powershell.exe -NoExit -NoProfile -ExecutionPolicy Bypass -File ".\scripts\start-mcp.ps1"
  for /l %%I in (1,1,30) do (
    curl.exe -fsS "http://127.0.0.1:$Port/healthz" >nul 2>nul && goto mcp_ready
    timeout /t 1 /nobreak >nul
  )
  echo MCP server did not become ready.
  exit /b 1
)

:mcp_ready
start "OpenAI MCP Tunnel Watchdog" powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\watch-openai-tunnel.ps1"
curl.exe -fsS "http://$HealthAddr/readyz" >nul 2>nul
if not errorlevel 1 (
  echo OpenAI MCP Tunnel is already ready.
  exit /b 0
)
start "OpenAI MCP Tunnel" powershell.exe -NoExit -NoProfile -ExecutionPolicy Bypass -File ".\scripts\start-openai-tunnel.ps1"
exit /b 0
"@
  Set-Content -LiteralPath (Join-Path $projectRoot "start-openai-mcp.cmd") -Value $launcher -Encoding ASCII
  Write-Host "Created start-openai-mcp.cmd"
}

function Ensure-TailscaleTunnel {
  Write-Step "Configure Tailscale Funnel"
  $root = Join-Path $projectRoot "tunnel\tailscale"
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  $tailscale = Find-TailscaleExe
  if (-not $tailscale) {
    Write-Host "Tailscale is not installed. Downloading the latest stable Windows installer..."
    $page = Invoke-WebRequest -UseBasicParsing -Uri "https://pkgs.tailscale.com/stable/"
    $matches = [regex]::Matches($page.Content, 'tailscale-setup-(\d+\.\d+\.\d+)\.exe')
    $versions = @($matches | ForEach-Object { [version]$_.Groups[1].Value } | Sort-Object -Descending -Unique)
    if ($versions.Count -eq 0) { throw "Could not determine the latest stable Tailscale Windows installer." }
    $version = $versions[0].ToString()
    $installerName = "tailscale-setup-$version.exe"
    $installer = Join-Path $root $installerName
    Invoke-WebRequest -UseBasicParsing -Uri "https://pkgs.tailscale.com/stable/$installerName" -OutFile $installer
    Write-Host "Downloaded Tailscale installer: $installer"
    Start-Process -FilePath $installer -Wait
    $tailscale = Find-TailscaleExe
    if (-not $tailscale) { throw "Tailscale installation did not produce tailscale.exe." }
  }
  Write-Host "Found Tailscale: $tailscale"

  $node = Find-NodeExe
  if (-not $node) { throw "Node.js was not found; it is required for Tailscale status checks and the OAuth gateway." }
  $status = (& $node (Join-Path $projectRoot "scripts\check-tailscale.mjs") | ConvertFrom-Json)
  if (-not $status.running) {
    Write-Host "Tailscale is not connected. Starting login flow..."
    & $tailscale up
    if ($LASTEXITCODE -ne 0) { throw "tailscale up failed." }
    $status = (& $node (Join-Path $projectRoot "scripts\check-tailscale.mjs") | ConvertFrom-Json)
  }
  if (-not $status.running) { throw "Tailscale is still not connected." }

  & $node (Join-Path $projectRoot "scripts\init-tailscale-oauth.mjs")
  if ($LASTEXITCODE -ne 0) { throw "Failed to initialize the Tailscale OAuth owner password." }

  $launcher = @"
@echo off
setlocal EnableExtensions
cd /d "%~dp0"
if errorlevel 1 exit /b 1

curl.exe -fsS "http://127.0.0.1:$Port/healthz" >nul 2>nul
if errorlevel 1 (
  start "Codex MCP Server" powershell.exe -NoExit -NoProfile -ExecutionPolicy Bypass -File ".\scripts\start-mcp.ps1"
  for /l %%I in (1,1,30) do (
    curl.exe -fsS "http://127.0.0.1:$Port/healthz" >nul 2>nul && goto mcp_ready
    timeout /t 1 /nobreak >nul
  )
  echo MCP server did not become ready.
  exit /b 1
)

:mcp_ready
curl.exe -fsS "http://127.0.0.1:3334/healthz" >nul 2>nul
if errorlevel 1 (
  start "Tailscale OAuth Gateway" powershell.exe -NoExit -NoProfile -ExecutionPolicy Bypass -File ".\scripts\start-tailscale-oauth-gateway.ps1"
  for /l %%I in (1,1,30) do (
    curl.exe -fsS "http://127.0.0.1:3334/healthz" >nul 2>nul && goto gateway_ready
    timeout /t 1 /nobreak >nul
  )
  echo Tailscale OAuth Gateway did not become ready.
  exit /b 1
)
:gateway_ready
start "Tailscale Funnel" powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\configure-tailscale-funnel.ps1"
start "Tailscale MCP Watchdog" powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\watch-tailscale-mcp.ps1"
exit /b 0

"@
  Set-Content -LiteralPath (Join-Path $projectRoot "start-tailscale-mcp.cmd") -Value $launcher -Encoding ASCII
  Write-Host "Created start-tailscale-mcp.cmd"
  Write-Host "Owner Password file: tunnel\tailscale\owner-password.txt"
}

Write-Step "Configure allowed workspace roots"
$configPath = Join-Path $projectRoot "config.json"
if (-not $AllowedRoots -and (Test-Path -LiteralPath $configPath)) {
  try {
    $existingConfig = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    if ($existingConfig.mcp.allowedRoots) {
      $AllowedRoots = @($existingConfig.mcp.allowedRoots) -join ","
      Write-Host "Using allowed roots from existing config.json: $AllowedRoots"
    }
  } catch {
    Write-Warning "Existing config.json could not be parsed; allowed roots will be requested."
  }
}
if (-not $AllowedRoots) {
  $AllowedRoots = Read-Host "Allowed roots, comma-separated, for example D:\Projects"
}
if (-not $AllowedRoots) { throw "Allowed roots cannot be empty." }

if (-not $Tunnel) {
  Write-Host "1. OpenAI Secure MCP Tunnel"
  Write-Host "2. Tailscale Funnel"
  Write-Host "3. Both"
  $choice = Read-Host "Choose tunnel type [1/2/3]"
  switch ($choice) {
    "1" { $Tunnel = "OpenAI" }
    "2" { $Tunnel = "Tailscale" }
    "3" { $Tunnel = "Both" }
    default { throw "Invalid tunnel selection." }
  }
}

Write-Step "Install dependencies and build"
if (-not $SkipBuild) {
  npm install
  if ($LASTEXITCODE -ne 0) { throw "npm install failed." }
  npm run build
  if ($LASTEXITCODE -ne 0) { throw "npm run build failed." }
} else {
  Write-Host "Skipped npm install/build."
}

$allowedRootList = $AllowedRoots -split "," | ForEach-Object { $_.Trim() } | Where-Object { $_ }
$configObject = [ordered]@{
  mcp = [ordered]@{
    host = "127.0.0.1"
    port = $Port
    allowedRoots = @($allowedRootList)
    accessMode = "review"
    maxReadBytes = 200000
    maxOutputBytes = 200000
    maxSessions = 128
  }
  runtime = [ordered]@{}
  proxy = [ordered]@{
    noProxy = "127.0.0.1,localhost,::1"
  }
  web = [ordered]@{
    enabled = $false
    searchProvider = "none"
    searxngUrl = ""
    maxBytes = 200000
    timeoutMs = 15000
  }
  sqlite = [ordered]@{
    enabled = $false
    allowedDbs = @()
    maxRows = 100
  }
  environment = [ordered]@{}
}
if ($ProxyUrl) {
  $configObject.proxy["url"] = $ProxyUrl
  $configObject.proxy["nodeUseEnvProxy"] = $true
}
if ((Test-Path -LiteralPath $configPath) -and -not $ForceConfig) {
  Write-Host "Existing config.json kept unchanged. Use -ForceConfig only when you intentionally want to replace it."
} else {
  $configObject | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $configPath -Encoding UTF8
  Write-Host "Created config.json"
}

if ($Tunnel -eq "OpenAI" -or $Tunnel -eq "Both") { Ensure-OpenAITunnel }
if ($Tunnel -eq "Tailscale" -or $Tunnel -eq "Both") { Ensure-TailscaleTunnel }

Write-Step "Done"
Write-Host "Configured tunnel mode: $Tunnel"
Write-Host "Use the generated one-click launcher(s) in the project root."
