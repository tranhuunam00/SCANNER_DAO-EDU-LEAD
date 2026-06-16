param(
  [string]$OutputDir = "dist",
  [string]$ApiBaseUrl = "",
  [string]$ScannerToken = "",
  [string]$SyncEndpoint = "",
  [switch]$AllowLocal
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $scriptDir
$manifestPath = Join-Path $root "manifest.json"
$envPath = Join-Path $root ".env"

function Read-DotEnv($path) {
  $values = @{}
  if (!(Test-Path -LiteralPath $path)) {
    return $values
  }

  foreach ($line in Get-Content -LiteralPath $path) {
    $trimmed = $line.Trim()
    if (!$trimmed -or $trimmed.StartsWith("#") -or !$trimmed.Contains("=")) {
      continue
    }

    $parts = $trimmed.Split("=", 2)
    $key = $parts[0].Trim()
    $value = $parts[1].Trim().Trim("'").Trim('"')
    if ($key) {
      $values[$key] = $value
    }
  }

  return $values
}

function Assert-ProductionUrl($url, $allowLocal) {
  if (!$url -or $url -match "your-production-domain\.com") {
    throw "Set DAO_EDU_SCANNER_API_BASE_URL in .env or pass -ApiBaseUrl before packaging."
  }

  $uri = [Uri]$url
  $localHosts = @("localhost", "127.0.0.1", "::1")
  if (!$allowLocal -and $localHosts -contains $uri.Host) {
    throw "API base URL points to local host. Pass -AllowLocal only for testing packages."
  }
}

function Assert-PathInside($path, $container, $label) {
  $fullPath = [System.IO.Path]::GetFullPath($path)
  $fullContainer = [System.IO.Path]::GetFullPath($container).TrimEnd("\", "/")
  $inside = $fullPath.Equals($fullContainer, [System.StringComparison]::OrdinalIgnoreCase) -or
    $fullPath.StartsWith(
      "$fullContainer$([System.IO.Path]::DirectorySeparatorChar)",
      [System.StringComparison]::OrdinalIgnoreCase
    )
  if (!$inside) {
    throw "$label must stay inside the extension workspace."
  }
}

$envValues = Read-DotEnv $envPath

if (!$ApiBaseUrl) {
  $ApiBaseUrl = $envValues["DAO_EDU_SCANNER_API_BASE_URL"]
}
if (!$ScannerToken) {
  $ScannerToken = $envValues["DAO_EDU_SCANNER_TOKEN"]
}
if (!$SyncEndpoint) {
  $SyncEndpoint = $envValues["DAO_EDU_SCANNER_SYNC_ENDPOINT"]
}
if (!$SyncEndpoint) {
  $SyncEndpoint = "/facebook-lead-scans"
}

Assert-ProductionUrl $ApiBaseUrl $AllowLocal

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$packageName = "dao-edu-lead-scanner-$($manifest.version)"
$outRoot = Join-Path $root $OutputDir
$staging = Join-Path $outRoot $packageName
$zipPath = Join-Path $outRoot "$packageName.zip"

Assert-PathInside $outRoot $root "OutputDir"
Assert-PathInside $staging $root "Staging path"
Assert-PathInside $zipPath $root "Zip path"

if (Test-Path -LiteralPath $staging) {
  Remove-Item -LiteralPath $staging -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $staging | Out-Null
New-Item -ItemType Directory -Force -Path $outRoot | Out-Null

$files = @(
  "manifest.json",
  "background.js",
  "batch-queue.js",
  "content.js",
  "lead-filter.js",
  "popup.css",
  "popup.html",
  "popup.js",
  "README.md"
)

foreach ($file in $files) {
  Copy-Item -LiteralPath (Join-Path $root $file) -Destination (Join-Path $staging $file)
}

$config = @"
window.DaoEduScannerConfig = {
  apiBaseUrl: "$($ApiBaseUrl.Replace('\', '\\').Replace('"', '\"'))",
  scannerToken: "$($ScannerToken.Replace('\', '\\').Replace('"', '\"'))",
  syncEndpoint: "$($SyncEndpoint.Replace('\', '\\').Replace('"', '\"'))",
};
"@

Set-Content -LiteralPath (Join-Path $staging "scanner-config.js") -Value $config -Encoding UTF8

if (Test-Path -LiteralPath $zipPath) {
  Remove-Item -LiteralPath $zipPath -Force
}
Compress-Archive -Path (Join-Path $staging "*") -DestinationPath $zipPath -Force

Write-Output "Packaged extension: $zipPath"
Write-Output "API base URL: $ApiBaseUrl"
Write-Output "Sync endpoint: $SyncEndpoint"
