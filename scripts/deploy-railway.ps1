param(
  [string]$Service = "",
  [string]$Environment = "",
  [string]$Project = ""
)

$ErrorActionPreference = "Stop"

if (-not $env:RAILWAY_TOKEN -and -not $env:RAILWAY_API_TOKEN) {
  throw "Set RAILWAY_TOKEN or RAILWAY_API_TOKEN before deploying."
}

$railwayCommand = Get-Command railway -ErrorAction SilentlyContinue
if ($railwayCommand) {
  $railwayPath = $railwayCommand.Source
} else {
  $railwayPath = Join-Path $PSScriptRoot "..\node_modules\.bin\railway.cmd"
  if (-not (Test-Path $railwayPath)) {
    Write-Host "Installing Railway CLI locally..."
    npm install --no-save @railway/cli
  }
}

$args = @("up", "--detach")
if ($Service) { $args += @("--service", $Service) }
if ($Environment) { $args += @("--environment", $Environment) }
if ($Project) { $args += @("--project", $Project) }

Write-Host "Deploying to Railway..."
& $railwayPath @args
