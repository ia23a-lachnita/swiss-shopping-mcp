# Start the SPA web server in background
# Usage: pwsh scripts/start-server.ps1

$projectRoot = Split-Path $PSScriptRoot -Parent
$distPath = Join-Path $projectRoot "dist\web\server.js"

# Kill any existing node processes on port 3000
$existing = Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique
foreach ($pid in $existing) {
    Write-Host "Killing existing process $pid on port 3000..."
    Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 1

# Start server in background
Write-Host "Starting SPA server..."
$process = Start-Process -NoNewWindow -FilePath "node" -ArgumentList $distPath -PassThru
Start-Sleep -Seconds 3

# Verify it's running
try {
    $response = Invoke-WebRequest -Uri "http://localhost:3000" -TimeoutSec 5 -UseBasicParsing
    Write-Host "Server running at http://localhost:3000 (PID: $($process.Id))"
} catch {
    Write-Host "Server may not have started. Check manually."
}
