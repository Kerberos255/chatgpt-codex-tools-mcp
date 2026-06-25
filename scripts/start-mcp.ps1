param(
  [string]$AllowedRoots = "",
  [string]$AccessMode = "review",
  [int]$Port = 3333,
  [string]$CodexRuntimeRoot = "",
  [string]$FallbackNodeBin = ""
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot

if (-not $AllowedRoots) {
  $AllowedRoots = if ($env:CTM_ALLOWED_ROOTS) { $env:CTM_ALLOWED_ROOTS } else { $projectRoot }
}

if (-not $CodexRuntimeRoot -and $env:LOCALAPPDATA) {
  $CodexRuntimeRoot = Join-Path $env:LOCALAPPDATA "OpenAI\Codex\runtimes\cua_node"
}

if (-not $FallbackNodeBin -and $env:OPENCLAW_NODE_BIN) {
  $FallbackNodeBin = $env:OPENCLAW_NODE_BIN
}

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
  throw "No usable node.exe found. Install Node.js or set -FallbackNodeBin / OPENCLAW_NODE_BIN."
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
$env:PORT = "$Port"

Write-Host "MCP server root: $projectRoot"
Write-Host "Node exe: $nodeExe"
Write-Host "Allowed roots: $AllowedRoots"
Write-Host "Access mode: $AccessMode"
Write-Host "Port: $Port"
Write-Host "Auth: no authentication"
Write-Host ""

Set-Location -LiteralPath $projectRoot
& $nodeExe $serverJs
