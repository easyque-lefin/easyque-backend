param([int]$Port=5008)

# Find any process listening on the port and kill it
$listen = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listen) {
  $pids = $listen | Select-Object -ExpandProperty OwningProcess | Sort-Object -Unique
  foreach ($pid in $pids) {
    try {
      Stop-Process -Id $pid -Force -ErrorAction Stop
      Write-Host "Killed PID $pid that was holding port $Port"
    } catch {
      Write-Host "Could not kill PID $pid: $($_.Exception.Message)"
    }
  }
} else {
  Write-Host "No process is listening on port $Port"
}
