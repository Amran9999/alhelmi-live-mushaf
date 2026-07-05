# AlHelmi Live Mushaf

Mushaf interaktif untuk kelas AlHelmi — sync guru/pelajar, zoom +/-, hide hafazan.

Spesifikasi penuh: [docs/ALHELMI-LIVE-MUSHAF.md](../docs/ALHELMI-LIVE-MUSHAF.md)

## Ciri (v0.3)

- **Paparan SVG mushaf Medina** — halaman penuh seperti cetakan (bukan font QCF web)
- **2 mod:** Bacaan & Hafazan — 604 halaman Uthmani
- **Highlight ayat** — guru klik ayat pada halaman (sync pelajar)
- **Zoom** `−` / `+` (70%–180%)
- **Sync zoom** opsyenal guru → pelajar
- **Navigasi guru:** tab **Surah** (cari + senarai), **Juzuk** (1–30), **Halaman** (1–604) — lompat ke mula surah/juzuk/halaman
- **Highlight** klik perkataan (guru)
- **WebSocket** bilik mengikut `?room=`

## Jalankan (dev)

```bash
cd D:\mushaf
npm install   # pertama kali
npm run dev
```

**Lokasi projek:** `D:\mushaf` (Windows) · `/mnt/d/mushaf` (WSL)

| Peranan | URL |
|---------|-----|
| Guru | http://localhost:3090/?room=demo&role=teacher |
| Pelajar | http://localhost:3090/?room=demo&role=student |

## Embed Moodle (Label)

```html
<iframe
  src="https://quran.alhelmi.com/?room=KELAS-ID&role=student"
  width="100%"
  height="90vh"
  style="border:none; min-height:600px;"
  title="Mushaf Kelas">
</iframe>
```

## Production

Deploy pada Server 1 (`app`) bersama Moodle. Proxy Nginx ke port `3090` atau Docker.

**Dev + Cloudflare Tunnel (sekarang):**

```powershell
# Terminal 1 — mushaf
D:\mushaf\Start-Mushaf.ps1
# atau: scripts\Start-MushafDev.ps1 (background)

# Kemas kini tunnel + DNS (sekali / selepas reboot)
cd C:\Users\amran\projects\alhelmi-platform\scripts
.\sync-tunnel-config.ps1 -RegisterDns
cloudflared tunnel run alhelmi-learn
```

| URL public | Peranan |
|------------|---------|
| https://quran.alhelmi.com/?room=KELAS-ID&role=teacher | Guru |
| https://quran.alhelmi.com/?room=KELAS-ID&role=student | Pelajar |

`room` mesti **sama** untuk guru dan pelajar (contoh shortname kursus Moodle).

```bash
PORT=3090 npm start
```

Health check: `GET /health`

## Stack

- [open-quran-view](https://github.com/adelpro/open-quran-view) — mushaf Uthmani
- Express + Socket.io — sync bilik
