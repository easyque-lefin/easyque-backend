param([int]$Port = 5008)

# Find any process listening on the given port and kill it
$connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue

if (-not $connections) {
  Write-Host ("No process is listening on port {0}" -f $Port)
  exit 0
}

$pids = $connections | Select-Object -ExpandProperty OwningProcess -Unique

foreach ($p in $pids) {
  try {
    Stop-Process -Id $p -Force -ErrorAction Stop
    Write-Host ("Killed PID {0} that was holding port {1}" -f $p, $Port)
  }
  catch {
    Write-Host ("Could not kill PID {0}: {1}" -f $p, $_.Exception.Message)
  }
}
