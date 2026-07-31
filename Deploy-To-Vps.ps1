# Deploy AlHelmi Mushaf/Kelas ke VPS
# Usage (PowerShell):
#   powershell -ExecutionPolicy Bypass -File .\Deploy-To-Vps.ps1
#   powershell -ExecutionPolicy Bypass -File .\Deploy-To-Vps.ps1 -RemoteDir /opt/mushaf

param(
  [string]$HostName = "124.217.249.167",
  [int]$Port = 20203,
  [string]$User = "root",
  [string]$RemoteDir = "/opt/mushaf",
  [string]$SshMacs = "hmac-sha2-256"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

$sshTarget = "${User}@${HostName}"
$sshOpts = @(
  "-p", "$Port",
  "-o", "MACs=$SshMacs",
  "-o", "StrictHostKeyChecking=accept-new"
)

Write-Host ""
Write-Host "Deploy D:\mushaf → ${sshTarget}:${RemoteDir}" -ForegroundColor Cyan
Write-Host "  (fail .env TIDAK dihantar — cipta di VPS sendiri)" -ForegroundColor DarkGray
Write-Host ""

# Pastikan folder remote wujud
& ssh @sshOpts $sshTarget "mkdir -p '$RemoteDir/public' '$RemoteDir/data' /tmp/mushaf-upload/public /tmp/mushaf-upload/data"

# Muat naik fail app (bukan node_modules, bukan .env)
$files = @(
  "server.js",
  "jwt.js",
  "student-notes.js",
  "package.json",
  "package-lock.json"
)
foreach ($f in $files) {
  if (-not (Test-Path (Join-Path $Root $f))) {
    Write-Host "[SKIP] $f tiada" -ForegroundColor Yellow
    continue
  }
  Write-Host "scp $f"
  & scp @("-P", "$Port", "-o", "MACs=$SshMacs") (Join-Path $Root $f) "${sshTarget}:/tmp/mushaf-upload/$f"
}

$publicFiles = @(
  "classroom.html", "classroom.css", "classroom.js",
  "student.html", "student.js", "media-av.js",
  "index.html", "styles.css", "app.js", "annotation-layer.js"
)
foreach ($f in $publicFiles) {
  $p = Join-Path $Root "public\$f"
  if (-not (Test-Path $p)) { Write-Host "[SKIP] public/$f" -ForegroundColor Yellow; continue }
  Write-Host "scp public/$f"
  & scp @("-P", "$Port", "-o", "MACs=$SshMacs") $p "${sshTarget}:/tmp/mushaf-upload/public/$f"
}

if (Test-Path (Join-Path $Root "data\navigation.json")) {
  Write-Host "scp data/navigation.json"
  & scp @("-P", "$Port", "-o", "MACs=$SshMacs") `
    (Join-Path $Root "data\navigation.json") `
    "${sshTarget}:/tmp/mushaf-upload/data/navigation.json"
}

Write-Host ""
Write-Host "Pasang di VPS + restart..." -ForegroundColor Cyan

$remoteScript = @"
set -e
REMOTE='$RemoteDir'
mkdir -p "`$REMOTE/public" "`$REMOTE/data"
cp -a /tmp/mushaf-upload/server.js /tmp/mushaf-upload/jwt.js /tmp/mushaf-upload/package.json "`$REMOTE/" 2>/dev/null || true
[ -f /tmp/mushaf-upload/package-lock.json ] && cp -a /tmp/mushaf-upload/package-lock.json "`$REMOTE/"
cp -a /tmp/mushaf-upload/public/. "`$REMOTE/public/"
[ -d /tmp/mushaf-upload/data ] && cp -a /tmp/mushaf-upload/data/. "`$REMOTE/data/" || true
cd "`$REMOTE"
if [ ! -f .env ]; then
  cat > .env <<'ENV'
PORT=3090
NODE_ENV=production
MUSHAF_JWT_SECRET=
ENV
  echo "CREATED .env — ISI MUSHAF_JWT_SECRET dengan nano .env"
fi
npm install --omit=dev
if command -v pm2 >/dev/null 2>&1; then
  pm2 describe mushaf >/dev/null 2>&1 && pm2 restart mushaf --update-env || pm2 start server.js --name mushaf
  pm2 save || true
  pm2 status mushaf || true
elif command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files | grep -q mushaf; then
  systemctl restart mushaf || systemctl restart alhelmi-mushaf || true
else
  echo "Tiada pm2/systemd — jalan manual: cd `$REMOTE && node server.js"
  pkill -f 'node server.js' 2>/dev/null || true
  nohup node server.js >/var/log/mushaf.log 2>&1 &
  sleep 1
  curl -s http://127.0.0.1:3090/health || true
fi
curl -s http://127.0.0.1:3090/health || echo 'health check gagal — pastikan port 3090 & .env'
ls -la "`$REMOTE/public" | head
"@

$remoteScript | & ssh @sshOpts $sshTarget "bash -s"

Write-Host ""
Write-Host "Selesai." -ForegroundColor Green
Write-Host "1) SSH: ssh -p $Port -o MACs=$SshMacs $sshTarget"
Write-Host "2) nano $RemoteDir/.env  → isi MUSHAF_JWT_SECRET"
Write-Host "3) pm2 restart mushaf   (atau restart process Node)"
Write-Host "4) Uji: https://quran.alhelmi.com/health"
Write-Host ""
Write-Host "NOTA: Jika DNS masih tunnel ke PC anda, pastikan Nginx/VPS" -ForegroundColor Yellow
Write-Host "      yang layan quran.alhelmi.com — atau matikan tunnel lokal." -ForegroundColor Yellow
