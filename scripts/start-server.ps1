# Start the SPA web server in background (non-blocking)
# Usage: pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/start-server.ps1
# This script exits immediately after starting the server.

$projectRoot = Split-Path $PSScriptRoot -Parent
$distPath = Join-Path $projectRoot "dist\web\server.js"
$logFile = Join-Path $projectRoot "spa-server.log"

# Kill any existing node processes on port 3000
$existing = Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique
foreach ($procId in $existing) {
    Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Milliseconds 500

# Start server completely detached - use cmd /c start to break out of process tree
Start-Process -FilePath "cmd" -ArgumentList "/c node $distPath > $logFile 2>&1" -WindowStyle Hidden
Write-Host "Server starting at http://localhost:3000"
