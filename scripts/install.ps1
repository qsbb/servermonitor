$ErrorActionPreference = "Stop"

$Node = Get-Command node -ErrorAction SilentlyContinue
if (-not $Node) {
  throw "Node.js 18+ is required"
}

$Temp = Join-Path $env:TEMP ("servermonitor-installer-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $Temp | Out-Null
$Installer = Join-Path $Temp "install.mjs"

try {
  Invoke-WebRequest -Uri "https://raw.githubusercontent.com/qsbb/servermonitor/main/scripts/install.mjs" -OutFile $Installer
  node $Installer @args
} finally {
  if (Test-Path $Temp) { Remove-Item -Recurse -Force $Temp }
}
