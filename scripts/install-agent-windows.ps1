param(
  [Parameter(Mandatory=$true)][string]$Name,
  [string]$Token = "",
  [Parameter(Mandatory=$true)][string]$ReportUrl,
  [string]$InstallDir = "C:\servermonitor\agent",
  [string]$ServiceName = "servermonitor-agent",
  [string]$RepoUrl = "https://github.com/qsbb/servermonitor.git",
  [string]$Branch = "main",
  [int]$Interval = 10,
  [int]$SlowInterval = 30,
  [int]$Timeout = 5000
)

$ErrorActionPreference = "Stop"

function Require-Command($Command) {
  $cmd = Get-Command $Command -ErrorAction SilentlyContinue
  if (-not $cmd) { throw "$Command is required" }
  return $cmd.Source
}

$Git = Require-Command "git"
$Node = Require-Command "node"
$Npm = Require-Command "npm"

$NodeMajor = & $Node -p "Number(process.versions.node.split('.')[0])"
if ([int]$NodeMajor -lt 18) {
  throw "Node.js 18+ is required, current: $(& $Node -v)"
}

if (-not $Token) {
  [byte[]]$Bytes = New-Object byte[] 16
  [Security.Cryptography.RandomNumberGenerator]::Fill($Bytes)
  $Token = "sm_" + ([BitConverter]::ToString($Bytes) -replace "-", "").ToLower()
}

$Temp = Join-Path $env:TEMP ("servermonitor-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $Temp | Out-Null

try {
  Write-Host "[servermonitor-agent] cloning $RepoUrl#$Branch"
  & $Git clone --depth 1 --branch $Branch $RepoUrl (Join-Path $Temp "servermonitor")

  if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
  New-Item -ItemType Directory -Path (Split-Path $InstallDir) -Force | Out-Null
  Copy-Item -Recurse -Force (Join-Path $Temp "servermonitor\agent") $InstallDir

  Push-Location $InstallDir
  & $Npm install --omit=dev
  Pop-Location

  $NssmCmd = Get-Command "nssm" -ErrorAction SilentlyContinue
  if ($NssmCmd) {
    $Nssm = $NssmCmd.Source
  } else {
    $NssmRoot = "C:\servermonitor\nssm"
    $Nssm = Join-Path $NssmRoot "nssm.exe"
    if (-not (Test-Path $Nssm)) {
      New-Item -ItemType Directory -Path $NssmRoot -Force | Out-Null
      $Zip = Join-Path $Temp "nssm.zip"
      Write-Host "[servermonitor-agent] downloading NSSM"
      Invoke-WebRequest -Uri "https://nssm.cc/release/nssm-2.24.zip" -OutFile $Zip
      Expand-Archive -Path $Zip -DestinationPath $Temp -Force
      $Arch = if ([Environment]::Is64BitOperatingSystem) { "win64" } else { "win32" }
      Copy-Item -Force (Join-Path $Temp "nssm-2.24\$Arch\nssm.exe") $Nssm
    }
  }

  & $Nssm stop $ServiceName 2>$null | Out-Null
  & $Nssm remove $ServiceName confirm 2>$null | Out-Null

  & $Nssm install $ServiceName $Node (Join-Path $InstallDir "agent.mjs")
  & $Nssm set $ServiceName AppDirectory $InstallDir
  & $Nssm set $ServiceName AppEnvironmentExtra `
    "SM_NAME=$Name" `
    "SM_TOKEN=$Token" `
    "SM_REPORT_URL=$ReportUrl" `
    "SM_INTERVAL=$Interval" `
    "SM_SLOW_INTERVAL=$SlowInterval" `
    "SM_TIMEOUT=$Timeout"
  & $Nssm set $ServiceName Start SERVICE_AUTO_START
  & $Nssm set $ServiceName AppStdout "C:\servermonitor\agent.log"
  & $Nssm set $ServiceName AppStderr "C:\servermonitor\agent.err.log"
  & $Nssm start $ServiceName

  Write-Host "[servermonitor-agent] installed to $InstallDir"
  Write-Host "[servermonitor-agent] service: $ServiceName"
  Write-Host "[servermonitor-agent] status: nssm status $ServiceName"
  Write-Host "[servermonitor-agent] logs: C:\servermonitor\agent.log and C:\servermonitor\agent.err.log"
  Write-Host "[servermonitor-agent] token: $Token"
  Write-Host "[servermonitor-agent] bind in Yunzai private chat: #服务器状态绑定 $Name $Token"
} finally {
  if (Test-Path $Temp) { Remove-Item -Recurse -Force $Temp }
}
