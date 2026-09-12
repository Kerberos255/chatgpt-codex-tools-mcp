param(
  [Parameter(Mandatory = $true)]
  [string]$Tag,
  [string]$OutputDir = "release-dist"
)

$ErrorActionPreference = "Stop"

if ($Tag -notmatch '^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') {
  throw "Tag must use semantic version format, for example v0.4.8."
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$package = Get-Content -LiteralPath (Join-Path $projectRoot "package.json") -Raw | ConvertFrom-Json
$expectedTag = "v$($package.version)"
if ($Tag -ne "v0.0.0-ci" -and $Tag -ne $expectedTag) {
  throw "Tag $Tag does not match package version $($package.version)."
}

if (-not [System.IO.Path]::IsPathRooted($OutputDir)) {
  $OutputDir = Join-Path $projectRoot $OutputDir
}

Push-Location $projectRoot
try {
  npm run build
  if ($LASTEXITCODE -ne 0) {
    throw "npm run build failed."
  }

  Remove-Item -LiteralPath $OutputDir -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

  $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("ctm-release-" + [guid]::NewGuid().ToString("N"))
  $packageName = "chatgpt-codex-tools-mcp-$Tag"
  $stage = Join-Path $tempRoot $packageName
  New-Item -ItemType Directory -Force -Path $stage | Out-Null

  $items = @(
    "dist",
    "src",
    "scripts",
    "test",
    "CHANGELOG.md",
    "config.example.json",
    "env.example",
    "init-windows.cmd",
    "LICENSE",
    "package-lock.json",
    "package.json",
    "README.md",
    "README.zh.md",
    "SECURITY.md",
    "tsconfig.json"
  )

  foreach ($item in $items) {
    $source = Join-Path $projectRoot $item
    if (!(Test-Path -LiteralPath $source)) {
      throw "Release input is missing: $item"
    }
    Copy-Item -LiteralPath $source -Destination $stage -Recurse -Force
  }

  if (Test-Path -LiteralPath (Join-Path $stage "config.json")) {
    throw "Local config.json must not be included in a release package."
  }

  $zipPath = Join-Path $OutputDir "$packageName.zip"
  Compress-Archive -LiteralPath $stage -DestinationPath $zipPath -CompressionLevel Optimal

  $checksumPath = Join-Path $OutputDir "SHA256SUMS.txt"
  Get-ChildItem -LiteralPath $OutputDir -File |
    Where-Object { $_.Name -ne "SHA256SUMS.txt" } |
    Sort-Object Name |
    ForEach-Object {
      $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant()
      "$hash  $($_.Name)"
    } | Set-Content -LiteralPath $checksumPath -Encoding ASCII

  foreach ($asset in @($zipPath, $checksumPath)) {
    if (!(Test-Path -LiteralPath $asset) -or (Get-Item -LiteralPath $asset).Length -le 0) {
      throw "Missing or empty release asset: $asset"
    }
  }

  Write-Host "Release assets built in: $OutputDir"
  Get-ChildItem -LiteralPath $OutputDir | Format-Table Name, Length
  Get-Content -LiteralPath $checksumPath
} finally {
  if ($tempRoot) {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
  Pop-Location
}
