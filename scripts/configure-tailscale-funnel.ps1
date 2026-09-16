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
  if ($env:CTM_FALLBACK_NODE_BIN) { $candidates += Join-Path $env:CTM_FALLBACK_NODE_BIN "node.exe" }
  $pathNode = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($pathNode) { $candidates += $pathNode.Source }
  return $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
}

function Get-Funnel443State([string]$TailscaleExe) {
  try {
    $raw = & $TailscaleExe funnel status --json 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $raw) { return "unknown" }
    $status = $raw | ConvertFrom-Json
    $property = $status.TCP.PSObject.Properties["443"]
    if (-not $property) { return "missing" }
    $route = $property.Value
    if ([string]$route.TCPForward -eq "127.0.0.1:3334" -and [string]$route.TerminateTLS) { return "expected" }
    return "conflict"
  } catch {
    return "unknown"
  }
}

$tailscale = Find-TailscaleExe
if (-not $tailscale) { throw "Tailscale is not installed. Run init-windows.cmd and choose Tailscale." }
$node = Find-NodeExe
if (-not $node) { throw "Node.js was not found." }
$status = (& $node (Join-Path $projectRoot "scripts\check-tailscale.mjs") | ConvertFrom-Json)
if (-not $status.running) { throw "Tailscale is not connected." }

$mutex = New-Object System.Threading.Mutex($false, "Local\ChatGPTCodexToolsMcpTailscaleFunnel")
$hasMutex = $false
try {
  $hasMutex = $mutex.WaitOne(0, $false)
  if (-not $hasMutex) {
    Write-Host "Tailscale MCP Funnel foreground session is already running."
    exit 0
  }

  $funnelState = Get-Funnel443State $tailscale
  switch ($funnelState) {
    "expected" {
      Write-Host "Switching existing Funnel 443 mapping from persistent background mode to foreground mode..."
      & $tailscale funnel --tls-terminated-tcp=443 off
      if ($LASTEXITCODE -ne 0) { throw "Failed to stop the existing Tailscale Funnel 443 mapping." }
    }
    "missing" { }
    "conflict" { throw "HTTPS 443 is already used by another Tailscale Funnel mapping; refusing to overwrite it." }
    default { throw "Could not inspect the current Tailscale Funnel 443 state; refusing to change it." }
  }

  Write-Host "Starting Tailscale MCP Funnel in foreground: HTTPS 443 -> OAuth gateway 3334 -> MCP 3333"
  Write-Host "Keep this window open. Closing it or pressing Ctrl+C stops the Funnel."
  & $tailscale funnel --yes --tls-terminated-tcp=443 tcp://127.0.0.1:3334
  if ($LASTEXITCODE -ne 0) { throw "Tailscale Funnel foreground session exited with code $LASTEXITCODE." }
} finally {
  if ($hasMutex) { $mutex.ReleaseMutex() | Out-Null }
  $mutex.Dispose()
}
