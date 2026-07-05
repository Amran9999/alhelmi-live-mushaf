# Start AlHelmi Live Mushaf (dev)
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
Write-Host "AlHelmi Live Mushaf — http://localhost:3090" -ForegroundColor Cyan
Write-Host "  Guru:    http://localhost:3090/?room=demo&role=teacher"
Write-Host "  Pelajar: http://localhost:3090/?room=demo&role=student"
Write-Host ""

npm run dev
