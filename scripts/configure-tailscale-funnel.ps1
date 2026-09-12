$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot

function Find-TailscaleExe {
  if ($env:CTM_TAILSCALE_EXE -and (Test-Path -LiteralPath $env:CTM_TAILSCALE_EXE)) { return $env:CTM_TAILSCALE_EXE }
  $programFiles = if ($env:ProgramFiles) { $env:ProgramFiles } else { "C:\Program Files" }
  $installed = Join-Path $programFiles "Tailscale\tailscale.exe"
  if (Test-Path -LiteralPath $installed) { return $installed }
  $command = Get-Command tailscale.exe -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  return $null
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
  if ($env:OPENCLAW_NODE_BIN) { $candidates += Join-Path $env:OPENCLAW_NODE_BIN "node.exe" }
  $pathNode = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($pathNode) { $candidates += $pathNode.Source }
  return $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
}

$tailscale = Find-TailscaleExe
if (-not $tailscale) { throw "Tailscale is not installed. Run init-windows.cmd and choose Tailscale." }
$node = Find-NodeExe
if (-not $node) { throw "Node.js was not found." }
$status = (& $node (Join-Path $projectRoot "scripts\check-tailscale.mjs") | ConvertFrom-Json)
if (-not $status.running) { throw "Tailscale is not connected." }

# Remove only the retired experimental MCP route. Other Funnel routes, including OpenClaw on 8443, are left unchanged.
& $tailscale funnel --tls-terminated-tcp=10000 off 2>$null | Out-Null

& $tailscale funnel --bg --yes --tls-terminated-tcp=443 tcp://127.0.0.1:3334
if ($LASTEXITCODE -ne 0) { throw "Failed to configure Tailscale Funnel on HTTPS 443." }
Write-Host "Tailscale MCP Funnel is ready: HTTPS 443 -> OAuth gateway 3334 -> MCP 3333"
& $tailscale funnel status
