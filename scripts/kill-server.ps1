# Kill any node processes running the SPA server
# Usage: pwsh scripts/kill-server.ps1

$port = 3000
$processIds = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique

if ($processIds) {
    foreach ($procId in $processIds) {
        Write-Host "Killing process $procId on port $port..."
        Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 1
    Write-Host "Done. All processes on port $port killed."
} else {
    Write-Host "No processes found on port $port."
}
