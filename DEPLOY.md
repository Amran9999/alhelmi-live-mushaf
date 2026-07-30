# Deploy ke VPS (`quran.alhelmi.com`)

## Penting dulu

Sekarang config tunnel biasa:

`quran.alhelmi.com` → `http://127.0.0.1:3090` **di PC anda**

Jadi ada 2 senario:

| Senario | Apa buat |
|---------|----------|
| **A. Tunnel lokal** (sekarang) | Jalankan mushaf di PC + `cloudflared tunnel run` — **bukan** upload VPS |
| **B. App di VPS** | Upload kod dengan skrip di bawah + Nginx/proxy ke port 3090 di VPS |

---

## A — “Deploy” via tunnel (PC)

```powershell
cd D:\mushaf
npm.cmd run dev
```

Terminal lain:

```powershell
cloudflared tunnel run alhelmi-learn
```

Uji: https://quran.alhelmi.com/health

---

## B — Deploy kod ke VPS

Agent Cursor **tidak ada password SSH** anda. Jalankan di PowerShell anda:

```powershell
cd D:\mushaf
powershell -ExecutionPolicy Bypass -File .\Deploy-To-Vps.ps1
```

Default remote: `/opt/mushaf`. Jika folder lain:

```powershell
powershell -ExecutionPolicy Bypass -File .\Deploy-To-Vps.ps1 -RemoteDir /var/www/mushaf
```

Selepas upload:

```bash
ssh -p 20203 -o MACs=hmac-sha2-256 root@124.217.249.167
cd /opt/mushaf
nano .env
```

Isi:

```env
PORT=3090
NODE_ENV=production
MUSHAF_JWT_SECRET=secret-sebenar-dari-portal
```

```bash
pm2 restart mushaf
# atau: node server.js
curl http://127.0.0.1:3090/health
```

Pastikan Nginx / DNS `quran.alhelmi.com` tunjuk ke VPS port 3090 (bukan tunnel PC).

---

## Semak deploy berjaya

```text
https://quran.alhelmi.com/health
```

Harus ada `"ui":"classroom-dual-panel"`.
