# Start mushaf server detached and health-check
$ErrorActionPreference = 'SilentlyContinue'

$existing = Get-NetTCPConnection -LocalPort 3090 -State Listen -ErrorAction SilentlyContinue
if ($existing) {
    Write-Output "ALREADY_LISTENING pid=$($existing.OwningProcess)"
} else {
    Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory 'D:\mushaf' -WindowStyle Hidden
    Write-Output "STARTED node server.js"
}

Start-Sleep -Seconds 4

$ok = $false
foreach ($path in @('/healthz','/health','/')) {
    try {
        $resp = Invoke-WebRequest -Uri ("http://127.0.0.1:3090" + $path) -UseBasicParsing -TimeoutSec 5
        Write-Output ("OK " + $path + " -> " + $resp.StatusCode)
        $ok = $true
        break
    } catch {
        Write-Output ("FAIL " + $path + " -> " + $_.Exception.Message)
    }
}

if (-not $ok) { Write-Output "SERVER_NOT_RESPONDING" }
