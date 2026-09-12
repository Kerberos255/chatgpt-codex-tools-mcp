param(
  [int]$IntervalSeconds = 60,
  [int]$DeadFailureThreshold = 3
)

$ErrorActionPreference = "Continue"
$projectRoot = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $projectRoot "logs"
$logPath = Join-Path $logDir "openai-tunnel-watchdog.log"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$mutex = New-Object System.Threading.Mutex($false, "Local\ChatGPTCodexToolsMcpOpenAITunnelWatchdog")
if (-not $mutex.WaitOne(0, $false)) {
  Write-Host "OpenAI MCP Tunnel watchdog is already running."
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

function Stop-ManagedTunnelClients([string]$RootPath) {
  $expectedRoot = [System.IO.Path]::GetFullPath($RootPath).TrimEnd("\") + "\"
  $matches = @(
    Get-Process -Name "tunnel-client" -ErrorAction SilentlyContinue | Where-Object {
      try { [System.IO.Path]::GetFullPath($_.Path).StartsWith($expectedRoot, [System.StringComparison]::OrdinalIgnoreCase) } catch { $false }
    }
  )
  foreach ($process in $matches) {
    Write-WatchLog "Stopping unhealthy tunnel-client pid=$($process.Id)"
    Stop-Process -Id $process.Id -ErrorAction SilentlyContinue
    try { Wait-Process -Id $process.Id -Timeout 5 -ErrorAction Stop } catch {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
  }
}

$mcpUrl = "http://127.0.0.1:3333/healthz"
$healthUrl = "http://127.0.0.1:8081/healthz"
$readyUrl = "http://127.0.0.1:8081/readyz"
$mcpScript = Join-Path $PSScriptRoot "start-mcp.ps1"
$tunnelScript = Join-Path $PSScriptRoot "start-openai-tunnel.ps1"
$clientRoot = Join-Path $projectRoot "tunnel\openai"
$deadFailures = 0

try {
  Write-WatchLog "OpenAI MCP Tunnel watchdog started; interval=${IntervalSeconds}s; dead threshold=$DeadFailureThreshold"
  while ($true) {
    try {
      if (-not (Test-Url $mcpUrl)) {
        Start-ManagedScript "Codex MCP Server" $mcpScript
        if (-not (Wait-Url $mcpUrl)) { Write-WatchLog "MCP server did not recover within 30s" }
      }

      $healthOk = Test-Url $healthUrl
      $readyOk = Test-Url $readyUrl
      if ($healthOk) {
        $deadFailures = 0
        if (-not $readyOk) {
          Write-WatchLog "Tunnel is live but not ready; leaving the process untouched so transient control-plane issues can recover"
        }
      } else {
        $deadFailures++
        Write-WatchLog "Tunnel health check failed ($deadFailures/$DeadFailureThreshold)"
        if ($deadFailures -ge [Math]::Max(1, $DeadFailureThreshold)) {
          Stop-ManagedTunnelClients $clientRoot
          Start-Sleep -Seconds 2
          Start-ManagedScript "OpenAI MCP Tunnel" $tunnelScript
          if (Wait-Url $healthUrl 45) {
            Write-WatchLog "Tunnel process recovered"
            $deadFailures = 0
          } else {
            Write-WatchLog "Tunnel did not recover within 45s; will retry on a later cycle"
          }
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
