param(
  [string]$AllowedRoots = "",
  [string]$AccessMode = "",
  [int]$Port = 0,
  [string]$HostName = "",
  [string]$CodexRuntimeRoot = "",
  [string]$FallbackNodeBin = "",
  [string]$ConfigPath = ""
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot

function Get-ConfigProperty {
  param(
    $Object,
    [string]$Name
  )

  if ($null -eq $Object) {
    return $null
  }

  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) {
    return $null
  }

  return $property.Value
}

function Convert-ConfigValue {
  param($Value)

  if ($null -eq $Value) {
    return $null
  }

  if ($Value -is [bool]) {
    if ($Value) { return "1" }
    return "0"
  }

  if ($Value -is [System.Array]) {
    return (($Value | ForEach-Object { [string]$_ }) -join ",")
  }

  return [string]$Value
}

function Set-EnvDefault {
  param(
    [string]$Name,
    $Value
  )

  $converted = Convert-ConfigValue $Value
  if ($null -eq $converted -or $converted -eq "") {
    return
  }

  $existing = [Environment]::GetEnvironmentVariable($Name, "Process")
  if ($null -eq $existing -or $existing -eq "") {
    [Environment]::SetEnvironmentVariable($Name, $converted, "Process")
  }
}

function Get-Setting {
  param(
    $ConfigValue,
    [string]$EnvName,
    $Fallback = ""
  )

  $existing = [Environment]::GetEnvironmentVariable($EnvName, "Process")
  if ($null -ne $existing -and $existing -ne "") {
    return $existing
  }

  $converted = Convert-ConfigValue $ConfigValue
  if ($null -ne $converted -and $converted -ne "") {
    return $converted
  }

  return $Fallback
}

if (-not $ConfigPath) {
  $ConfigPath = Join-Path $projectRoot "config.json"
}

$config = $null
if (Test-Path -LiteralPath $ConfigPath) {
  try {
    $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
  } catch {
    throw "Failed to parse config file: $ConfigPath. $($_.Exception.Message)"
  }
}

$mcpConfig = Get-ConfigProperty $config "mcp"
$runtimeConfig = Get-ConfigProperty $config "runtime"
$proxyConfig = Get-ConfigProperty $config "proxy"
$webConfig = Get-ConfigProperty $config "web"
$sqliteConfig = Get-ConfigProperty $config "sqlite"
$environmentConfig = Get-ConfigProperty $config "environment"

if ($environmentConfig) {
  foreach ($property in $environmentConfig.PSObject.Properties) {
    Set-EnvDefault -Name $property.Name -Value $property.Value
  }
}

if (-not $AllowedRoots) {
  $AllowedRoots = Get-Setting -ConfigValue (Get-ConfigProperty $mcpConfig "allowedRoots") -EnvName "CTM_ALLOWED_ROOTS" -Fallback $projectRoot
}

if (-not $AccessMode) {
  $AccessMode = Get-Setting -ConfigValue (Get-ConfigProperty $mcpConfig "accessMode") -EnvName "CTM_ACCESS_MODE" -Fallback "review"
}

if ($Port -le 0) {
  $portSetting = Get-Setting -ConfigValue (Get-ConfigProperty $mcpConfig "port") -EnvName "PORT" -Fallback "3333"
  $Port = [int]$portSetting
}

if (-not $HostName) {
  $HostName = Get-Setting -ConfigValue (Get-ConfigProperty $mcpConfig "host") -EnvName "HOST" -Fallback "127.0.0.1"
}

if (-not $CodexRuntimeRoot) {
  $CodexRuntimeRoot = Get-Setting -ConfigValue (Get-ConfigProperty $runtimeConfig "codexRuntimeRoot") -EnvName "CTM_CODEX_RUNTIME_ROOT" -Fallback ""
}

if (-not $CodexRuntimeRoot -and $env:LOCALAPPDATA) {
  $CodexRuntimeRoot = Join-Path $env:LOCALAPPDATA "OpenAI\Codex\runtimes\cua_node"
}

if (-not $FallbackNodeBin) {
  $FallbackNodeBin = Get-Setting -ConfigValue (Get-ConfigProperty $runtimeConfig "fallbackNodeBin") -EnvName "OPENCLAW_NODE_BIN" -Fallback ""
}

Set-EnvDefault -Name "CTM_NPM_CACHE" -Value (Get-ConfigProperty $runtimeConfig "npmCache")

Set-EnvDefault -Name "CTM_DENY_GLOBS" -Value (Get-ConfigProperty $mcpConfig "denyGlobs")
Set-EnvDefault -Name "CTM_MAX_READ_BYTES" -Value (Get-ConfigProperty $mcpConfig "maxReadBytes")
Set-EnvDefault -Name "CTM_MAX_OUTPUT_BYTES" -Value (Get-ConfigProperty $mcpConfig "maxOutputBytes")

$proxyUrl = Get-ConfigProperty $proxyConfig "url"
if ($proxyUrl) {
  Set-EnvDefault -Name "PROXY_URL" -Value $proxyUrl
  Set-EnvDefault -Name "HTTP_PROXY" -Value $proxyUrl
  Set-EnvDefault -Name "HTTPS_PROXY" -Value $proxyUrl
}
Set-EnvDefault -Name "NO_PROXY" -Value (Get-ConfigProperty $proxyConfig "noProxy")
Set-EnvDefault -Name "NODE_USE_ENV_PROXY" -Value (Get-ConfigProperty $proxyConfig "nodeUseEnvProxy")

Set-EnvDefault -Name "CTM_WEB_TOOLS" -Value (Get-ConfigProperty $webConfig "enabled")
Set-EnvDefault -Name "CTM_SEARCH_PROVIDER" -Value (Get-ConfigProperty $webConfig "searchProvider")
Set-EnvDefault -Name "CTM_SEARXNG_URL" -Value (Get-ConfigProperty $webConfig "searxngUrl")
Set-EnvDefault -Name "CTM_WEB_MAX_BYTES" -Value (Get-ConfigProperty $webConfig "maxBytes")
Set-EnvDefault -Name "CTM_WEB_TIMEOUT_MS" -Value (Get-ConfigProperty $webConfig "timeoutMs")

Set-EnvDefault -Name "CTM_SQLITE_TOOLS" -Value (Get-ConfigProperty $sqliteConfig "enabled")
Set-EnvDefault -Name "CTM_SQLITE_ALLOWED_DBS" -Value (Get-ConfigProperty $sqliteConfig "allowedDbs")
Set-EnvDefault -Name "CTM_SQLITE_MAX_ROWS" -Value (Get-ConfigProperty $sqliteConfig "maxRows")

$nodeCandidates = @()

if ($CodexRuntimeRoot -and (Test-Path -LiteralPath $CodexRuntimeRoot)) {
  $nodeCandidates += Get-ChildItem -LiteralPath $CodexRuntimeRoot -Directory |
    Sort-Object LastWriteTime -Descending |
    ForEach-Object { Join-Path $_.FullName "bin\node.exe" }
}

if ($FallbackNodeBin) {
  $nodeCandidates += Join-Path $FallbackNodeBin "node.exe"
}

$pathNode = Get-Command node -ErrorAction SilentlyContinue
if ($pathNode) {
  $nodeCandidates += $pathNode.Source
}

$nodeExe = $nodeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $nodeExe) {
  throw "No usable node.exe found. Install Node.js or set runtime.fallbackNodeBin / OPENCLAW_NODE_BIN."
}

$serverJs = Join-Path $projectRoot "dist\server.js"
if (-not (Test-Path -LiteralPath $serverJs)) {
  throw "dist/server.js not found. Run: npm install ; npm run build"
}

$nodeBin = Split-Path -Parent $nodeExe
$env:Path = "$nodeBin;$env:Path"

if ($env:CTM_NPM_CACHE) {
  $env:NPM_CONFIG_CACHE = $env:CTM_NPM_CACHE
  $env:npm_config_cache = $env:CTM_NPM_CACHE
}

$env:CTM_ALLOWED_ROOTS = $AllowedRoots
$env:CTM_ACCESS_MODE = $AccessMode
$env:HOST = $HostName
$env:PORT = "$Port"

Write-Host "MCP server root: $projectRoot"
Write-Host "Config file: $(if ($config) { $ConfigPath } else { 'not found; using environment/defaults' })"
Write-Host "Node exe: $nodeExe"
Write-Host "Allowed roots: $AllowedRoots"
Write-Host "Access mode: $AccessMode"
Write-Host "Host: $HostName"
Write-Host "Port: $Port"
Write-Host "Auth: no authentication"
Write-Host ""

Set-Location -LiteralPath $projectRoot
& $nodeExe $serverJs
