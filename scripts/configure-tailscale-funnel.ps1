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

function Invoke-TailscaleBestEffort {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$Arguments,
    [switch]$Quiet
  )

  $previousErrorActionPreference = $ErrorActionPreference
  $nativePreferenceVariable = Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue
  $previousNativePreference = if ($nativePreferenceVariable) { $PSNativeCommandUseErrorActionPreference } else { $null }
  try {
    $ErrorActionPreference = "Continue"
    if ($nativePreferenceVariable) { $PSNativeCommandUseErrorActionPreference = $false }
    if ($Quiet) {
      & $tailscale @Arguments 2>$null | Out-Null
    } else {
      & $tailscale @Arguments
    }
    if (-not $Quiet -and $LASTEXITCODE -ne 0) {
      Write-Warning "Tailscale command failed with exit ${LASTEXITCODE}: tailscale $($Arguments -join ' ')"
    }
  } catch {
    if (-not $Quiet) { Write-Warning "Tailscale command failed: $($_.Exception.Message)" }
  } finally {
    if ($nativePreferenceVariable) { $PSNativeCommandUseErrorActionPreference = $previousNativePreference }
    $ErrorActionPreference = $previousErrorActionPreference
  }
}

$tailscale = Find-TailscaleExe
if (-not $tailscale) { throw "Tailscale is not installed. Run init-windows.cmd and choose Tailscale." }
$node = Find-NodeExe
if (-not $node) { throw "Node.js was not found." }
$status = (& $node (Join-Path $projectRoot "scripts\check-tailscale.mjs") | ConvertFrom-Json)
if (-not $status.running) { throw "Tailscale is not connected." }

& $tailscale funnel --bg --yes --tls-terminated-tcp=443 tcp://127.0.0.1:3334
if ($LASTEXITCODE -ne 0) { throw "Failed to configure Tailscale Funnel on HTTPS 443." }
Write-Host "Tailscale MCP Funnel is ready: HTTPS 443 -> OAuth gateway 3334 -> MCP 3333"

# Status is informational. A display/query failure must not turn a successful 443 setup into a startup failure.
Invoke-TailscaleBestEffort -Arguments @("funnel", "status")
