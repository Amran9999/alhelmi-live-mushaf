# Start AlHelmi Live Mushaf / Kelas Talaqqi (dev)
# Usage: .\Start-Mushaf.ps1

$ErrorActionPreference = "Stop"
$Root = "D:\mushaf"

if (-not (Test-Path "$Root\package.json")) {
    Write-Host "[FAIL] D:\mushaf\package.json tidak dijumpai" -ForegroundColor Red
    exit 1
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "[FAIL] Node.js tidak dijumpai. Pasang dari nodejs.org" -ForegroundColor Red
    exit 1
}

Set-Location $Root
Write-Host ""
Write-Host "AlHelmi Kelas Talaqqi — http://localhost:3090" -ForegroundColor Cyan
Write-Host "  Guru:    http://localhost:3090/?room=kelas-a"
Write-Host "  Pelajar: http://localhost:3090/student?room=kelas-a"
Write-Host "  Mushaf:  http://localhost:3090/mushaf?room=kelas-a&role=teacher&local=1"
Write-Host ""
Write-Host "Public (tunnel): https://quran.alhelmi.com/?room=KELAS-ID" -ForegroundColor DarkGray
Write-Host ""

npm run dev
