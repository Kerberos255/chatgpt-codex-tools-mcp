param(
  [int]$IntervalSeconds = 300
)

$ErrorActionPreference = "Continue"
$projectRoot = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $projectRoot "logs"
$logPath = Join-Path $logDir "tailscale-watchdog.log"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$mutex = New-Object System.Threading.Mutex($false, "Local\ChatGPTCodexToolsMcpTailscaleWatchdog")
if (-not $mutex.WaitOne(0, $false)) {
  Write-Host "Tailscale MCP watchdog is already running."
  exit 0
}

function Write-WatchLog([string]$Message) {
  $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
  Write-Host $line
  Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
}

function Test-Url([string]$Url) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 3
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 300
  } catch {
    return $false
  }
}

function Wait-Url([string]$Url, [int]$Seconds = 30) {
  for ($i = 0; $i -lt $Seconds; $i++) {
    if (Test-Url $Url) { return $true }
    Start-Sleep -Seconds 1
  }
  return $false
}

function Start-ManagedScript([string]$Title, [string]$ScriptPath) {
  Write-WatchLog "Starting $Title"
  Start-Process -FilePath "powershell.exe" -ArgumentList @(
    "-NoExit", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $ScriptPath
  ) | Out-Null
}

function Find-TailscaleExe {
  if ($env:CTM_TAILSCALE_EXE -and (Test-Path -LiteralPath $env:CTM_TAILSCALE_EXE)) { return $env:CTM_TAILSCALE_EXE }
  $programFiles = if ($env:ProgramFiles) { $env:ProgramFiles } else { "C:\Program Files" }
  $installed = Join-Path $programFiles "Tailscale\tailscale.exe"
  if (Test-Path -LiteralPath $installed) { return $installed }
  $command = Get-Command tailscale.exe -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  return $null
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

$mcpUrl = "http://127.0.0.1:3333/healthz"
$gatewayUrl = "http://127.0.0.1:3334/healthz"
$mcpScript = Join-Path $PSScriptRoot "start-mcp.ps1"
$gatewayScript = Join-Path $PSScriptRoot "start-tailscale-oauth-gateway.ps1"
$funnelScript = Join-Path $PSScriptRoot "configure-tailscale-funnel.ps1"
$tailscale = Find-TailscaleExe

try {
  Write-WatchLog "Tailscale MCP watchdog started; interval=${IntervalSeconds}s"
  while ($true) {
    try {
      if (-not (Test-Url $mcpUrl)) {
        Start-ManagedScript "Codex MCP Server" $mcpScript
        if (-not (Wait-Url $mcpUrl)) { Write-WatchLog "MCP server did not recover within 30s" }
      }

      if (-not (Test-Url $gatewayUrl)) {
        Start-ManagedScript "Tailscale OAuth Gateway" $gatewayScript
        if (-not (Wait-Url $gatewayUrl)) { Write-WatchLog "OAuth gateway did not recover within 30s" }
      }

      if (-not $tailscale -or -not (Test-Path -LiteralPath $tailscale)) { $tailscale = Find-TailscaleExe }
      if ($tailscale -and (Test-Url $mcpUrl) -and (Test-Url $gatewayUrl)) {
        $funnelState = Get-Funnel443State $tailscale
        switch ($funnelState) {
          "expected" { }
          "missing" {
            Write-WatchLog "Funnel 443 mapping is missing; starting a foreground Funnel window for 443 -> 3334"
            Start-Process -FilePath "powershell.exe" -ArgumentList @(
              "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $funnelScript
            ) | Out-Null
          }
          "conflict" { Write-WatchLog "Funnel 443 is owned by another mapping; refusing to overwrite it" }
          default { Write-WatchLog "Could not inspect Funnel 443 state; leaving existing mappings untouched" }
        }
      }
    } catch {
      Write-WatchLog "Watch cycle error: $($_.Exception.Message)"
    }
    Start-Sleep -Seconds ([Math]::Max(30, $IntervalSeconds))
  }
} finally {
  $mutex.ReleaseMutex() | Out-Null
  $mutex.Dispose()
}
