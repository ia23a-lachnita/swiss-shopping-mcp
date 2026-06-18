# Kill any node processes running the SPA server
# Usage: pwsh scripts/kill-server.ps1

$port = 3000
$pids = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique

if ($pids) {
    foreach ($pid in $pids) {
        Write-Host "Killing process $pid on port $port..."
        Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
    }
    Write-Host "Done. All processes on port $port killed."
} else {
    Write-Host "No processes found on port $port."
}
