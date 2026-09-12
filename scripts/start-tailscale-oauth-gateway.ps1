$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot

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
  if ($env:OPENCLAW_NODE_BIN) { $candidates += Join-Path $env:OPENCLAW_NODE_BIN "node.exe" }
  $pathNode = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($pathNode) { $candidates += $pathNode.Source }
  return $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
}

$node = Find-NodeExe
if (-not $node) { throw "Node.js was not found." }
Set-Location -LiteralPath $projectRoot
& $node (Join-Path $projectRoot "scripts\start-tailscale-oauth-gateway.mjs")
exit $LASTEXITCODE
