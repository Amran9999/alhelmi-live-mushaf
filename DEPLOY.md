# Deploy ke VPS (`quran.alhelmi.com`)

Dokumen operasi utama: [DEPLOY-VPS.md](./DEPLOY-VPS.md). Fail ini ialah rujukan ringkas.

## Penting dulu

Production semasa berjalan di VPS `/opt/mushaf` sebagai service `alhelmi-mushaf`. Tunnel PC hanya untuk pembangunan sementara dan tidak boleh mengambil alih hostname production.

Jadi ada 2 senario:

| Senario | Apa buat |
|---------|----------|
| **A. Dev lokal** | Jalankan mushaf di PC pada port 3090; jangan arahkan hostname production ke PC |
| **B. Production VPS** | Upload kod dengan skrip di bawah + Nginx/proxy ke port 3090 |

---

## A — Dev lokal

```powershell
cd D:\mushaf
npm.cmd run dev
```

Uji: `http://localhost:3090/health`

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
MUSHAF_MEDIA_URL_TTL_SEC=1800
```

```bash
mkdir -p /opt/backups
tar -czf "/opt/backups/mushaf-notes-$(date +%Y%m%d%H%M%S).tgz" uploads/notes data/student-notes
systemctl restart alhelmi-mushaf
curl http://127.0.0.1:3090/health
```

Pastikan Nginx / DNS `quran.alhelmi.com` tunjuk ke VPS port 3090 (bukan tunnel PC).

---

## Semak deploy berjaya

```text
https://quran.alhelmi.com/health
```

Harus ada `"ui":"classroom-dual-panel"`.

Semak juga:
- direct `/uploads/...` memulangkan `404`;
- screenshot guru menerima ACK simpanan;
- nota pelajar menggunakan URL `/media/{token}` dan masih boleh dimuat turun.
