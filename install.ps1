$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
node (Join-Path $Root "scripts\install.mjs") @args
