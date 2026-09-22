param(
  [string]$Name = "",
  [string]$Token = "",
  [string]$ReportUrl = "",
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

function Resolve-Nssm {
  $cmd = Get-Command "nssm" -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $fallback = Join-Path "C:\servermonitor\nssm" "nssm.exe"
  if (Test-Path $fallback) { return $fallback }
  return $null
}

function Read-AgentConfig($Dir) {
  $file = Join-Path $Dir "servermonitor-agent.json"
  if (-not (Test-Path $file)) { return $null }
  try { return (Get-Content $file -Raw | ConvertFrom-Json) } catch { return $null }
}

function Get-ServiceEnvValue($NssmExe, $Service, $Key) {
  if (-not $NssmExe) { return $null }
  try {
    $raw = & $NssmExe get $Service AppEnvironmentExtra 2>$null
    if ($null -eq $raw) { return $null }
    $text = ($raw -join "`n")
    $match = [regex]::Match($text, "(?m)^$Key=(.*)$")
    if ($match.Success) { return $match.Groups[1].Value.Trim() }
  } catch {}
  return $null
}

$Git = Require-Command "git"
$Node = Require-Command "node"
$Npm = Require-Command "npm"

$NodeMajor = [int](& $Node -p "Number(process.versions.node.split('.')[0])")
if ($NodeMajor -lt 18) {
  throw "Node.js 18+ is required, current: $(& $Node -v)"
}

$Nssm = Resolve-Nssm
$ServiceExists = $false
if ($Nssm) {
  try {
    & $Nssm status $ServiceName 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { $ServiceExists = $true }
  } catch {
    $ServiceExists = $false
  }
}

$ExistingInstall = Test-Path (Join-Path $InstallDir "agent.mjs")
$UpdateMode = ($ServiceExists -or $ExistingInstall)
$TokenCameFromServiceEnv = $false

if ($UpdateMode) {
  Write-Host "[servermonitor-agent] existing installation detected: $InstallDir"
  $config = Read-AgentConfig $InstallDir
  if ($config) {
    if (-not $Name -and $config.name) { $Name = [string]$config.name }
    if (-not $ReportUrl -and $config.reportUrl) { $ReportUrl = [string]$config.reportUrl }
    if (-not $Token -and $config.token) { $Token = [string]$config.token }
    if ($config.interval) { $Interval = [int]$config.interval }
    if ($config.slowInterval) { $SlowInterval = [int]$config.slowInterval }
    if ($config.timeout) { $Timeout = [int]$config.timeout }
  }
  if (-not $Name) { $Name = Get-ServiceEnvValue $Nssm $ServiceName "SM_NAME" }
  if (-not $ReportUrl) { $ReportUrl = Get-ServiceEnvValue $Nssm $ServiceName "SM_REPORT_URL" }
  if (-not $Token) {
    $Token = Get-ServiceEnvValue $Nssm $ServiceName "SM_TOKEN"
    if ($Token) { $TokenCameFromServiceEnv = $true }
  }
  if (-not $Token) {
    throw "existing installation detected but SM_TOKEN could not be read; refusing to generate a new token. Re-run with -Token <token> if you really want to replace it."
  }
}

if (-not $Name -or -not $ReportUrl) {
  Write-Host @"
usage:
  powershell -ExecutionPolicy Bypass -File install-agent-windows.ps1 -Name <name> [-Token <token>] -ReportUrl <url>
  Existing installations are detected and updated automatically (the old token is kept).
"@
  throw "-Name and -ReportUrl are required for a new installation"
}

if (-not $Token) {
  [byte[]]$Bytes = New-Object byte[] 16
  [Security.Cryptography.RandomNumberGenerator]::Fill($Bytes)
  $Token = "sm_" + ([BitConverter]::ToString($Bytes) -replace "-", "").ToLower()
}

$Temp = Join-Path $env:TEMP ("servermonitor-" + [guid]::NewGuid().ToString("N"))
$Staging = Join-Path (Split-Path $InstallDir) (".servermonitor-staging-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
$Backup = Join-Path (Split-Path $InstallDir) (".servermonitor-backup-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
$ConfigPath = Join-Path $InstallDir "servermonitor-agent.json"
$Switched = $false
$ServiceConfigured = $false

New-Item -ItemType Directory -Path $Temp -Force | Out-Null

try {
  Write-Host "[servermonitor-agent] cloning $RepoUrl#$Branch"
  & $Git clone --depth 1 --branch $Branch $RepoUrl (Join-Path $Temp "servermonitor")
  if ($LASTEXITCODE -ne 0) { throw "git clone failed with exit code $LASTEXITCODE" }

  Write-Host "[servermonitor-agent] staging new agent in $Staging"
  New-Item -ItemType Directory -Path $Staging -Force | Out-Null
  Copy-Item -Recurse -Force (Join-Path $Temp "servermonitor\agent\*") $Staging

  Push-Location $Staging
  try {
    & $Npm install --omit=dev
    if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
    & $Node --check agent.mjs
    if ($LASTEXITCODE -ne 0) { throw "node --check agent.mjs failed" }
    & $Node -e "import('systeminformation').then(() => {}, (err) => { console.error(err.message); process.exit(1) })"
    if ($LASTEXITCODE -ne 0) { throw "systeminformation is missing after npm install" }
  } finally {
    Pop-Location
  }

  # token 只写进 agent 目录下的配置文件（ACL 收紧），不再放进服务环境变量
  & $Node -e 'const fs=require("fs");const [file,name,token,url,interval,slow,timeout]=process.argv.slice(1);fs.writeFileSync(file,JSON.stringify({name,token,reportUrl:url,interval:Number(interval),slowInterval:Number(slow),timeout:Number(timeout)},null,2))' `
    (Join-Path $Staging "servermonitor-agent.json") $Name $Token $ReportUrl $Interval $SlowInterval $Timeout
  if ($LASTEXITCODE -ne 0) { throw "failed to write servermonitor-agent.json" }

  try {
    & icacls (Join-Path $Staging "servermonitor-agent.json") /inheritance:r /grant:r "SYSTEM:R" "Administrators:F" | Out-Null
  } catch {
    Write-Warning "[servermonitor-agent] could not restrict the config file ACL: $_"
  }

  if ($ServiceExists) {
    & $Nssm stop $ServiceName 2>$null | Out-Null
    Start-Sleep -Seconds 1
  }

  if (Test-Path $InstallDir) { Move-Item -Path $InstallDir -Destination $Backup -Force }
  Move-Item -Path $Staging -Destination $InstallDir -Force
  $Switched = $true

  if ($ServiceExists) {
    & $Nssm set $ServiceName Application $Node | Out-Null
    & $Nssm set $ServiceName AppParameters "`"$InstallDir\agent.mjs`" run" | Out-Null
  } else {
    & $Nssm install $ServiceName $Node (Join-Path $InstallDir "agent.mjs") run
    if ($LASTEXITCODE -ne 0) { throw "nssm install failed with exit code $LASTEXITCODE" }
  }
  $ServiceConfigured = $true

  & $Nssm set $ServiceName AppDirectory $InstallDir | Out-Null
  & $Nssm set $ServiceName AppEnvironmentExtra `
    "SM_NAME=$Name" `
    "SM_REPORT_URL=$ReportUrl" `
    "SM_INTERVAL=$Interval" `
    "SM_SLOW_INTERVAL=$SlowInterval" `
    "SM_TIMEOUT=$Timeout" | Out-Null
  & $Nssm set $ServiceName Start SERVICE_AUTO_START | Out-Null
  & $Nssm set $ServiceName AppStdout "C:\servermonitor\agent.log" | Out-Null
  & $Nssm set $ServiceName AppStderr "C:\servermonitor\agent.err.log" | Out-Null
  & $Nssm start $ServiceName
  if ($LASTEXITCODE -ne 0) { throw "nssm start failed with exit code $LASTEXITCODE" }

  Start-Sleep -Seconds 2
  $status = (& $Nssm status $ServiceName 2>$null | Out-String).Trim()
  if ($status -notmatch "RUNNING") { throw "service did not report RUNNING (status: $status)" }

  if (Test-Path $Backup) { Remove-Item -Recurse -Force $Backup }

  Write-Host "[servermonitor-agent] $(if ($UpdateMode) { "updated" } else { "installed" }) to $InstallDir"
  Write-Host "[servermonitor-agent] service: $ServiceName"
  Write-Host "[servermonitor-agent] status: nssm status $ServiceName"
  Write-Host "[servermonitor-agent] config: $ConfigPath (token stored here, ACL restricted)"
  Write-Host "[servermonitor-agent] logs: C:\servermonitor\agent.log and C:\servermonitor\agent.err.log"
  Write-Host "[servermonitor-agent] token: $Token"
  Write-Host "[servermonitor-agent] wait one upload log, then bind in Yunzai private chat: #服务器状态绑定 $Token"
} catch {
  Write-Warning "[servermonitor-agent] update failed, restoring previous installation"
  if (-not $Switched -and (Test-Path $Staging)) {
    Remove-Item -Recurse -Force $Staging -ErrorAction SilentlyContinue
  }
  if ($Switched) {
    if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir -ErrorAction SilentlyContinue }
    if (Test-Path $Backup) { Move-Item -Path $Backup -Destination $InstallDir -Force }
  }
  if ($Nssm -and $ServiceConfigured) {
    if ($ServiceExists) {
      & $Nssm set $ServiceName Application $Node 2>$null | Out-Null
      & $Nssm set $ServiceName AppParameters "`"$InstallDir\agent.mjs`" run" 2>$null | Out-Null
      & $Nssm set $ServiceName AppDirectory $InstallDir 2>$null | Out-Null
      if ($TokenCameFromServiceEnv) {
        & $Nssm set $ServiceName AppEnvironmentExtra `
          "SM_NAME=$Name" `
          "SM_TOKEN=$Token" `
          "SM_REPORT_URL=$ReportUrl" `
          "SM_INTERVAL=$Interval" `
          "SM_SLOW_INTERVAL=$SlowInterval" `
          "SM_TIMEOUT=$Timeout" 2>$null | Out-Null
      } else {
        & $Nssm set $ServiceName AppEnvironmentExtra `
          "SM_NAME=$Name" `
          "SM_REPORT_URL=$ReportUrl" `
          "SM_INTERVAL=$Interval" `
          "SM_SLOW_INTERVAL=$SlowInterval" `
          "SM_TIMEOUT=$Timeout" 2>$null | Out-Null
      }
      & $Nssm start $ServiceName 2>$null | Out-Null
    } elseif ($Nssm) {
      & $Nssm stop $ServiceName 2>$null | Out-Null
      & $Nssm remove $ServiceName confirm 2>$null | Out-Null
    }
  }
  throw
} finally {
  if (Test-Path $Temp) { Remove-Item -Recurse -Force $Temp -ErrorAction SilentlyContinue }
}
