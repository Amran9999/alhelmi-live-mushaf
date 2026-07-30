# AlHelmi Live Mushaf — Kelas Talaqqi

Dual-panel guru + mushaf Madinah sync + FIFO + kamera/mikrofon.

## Jalankan (dev)

```powershell
cd D:\mushaf
npm install
.\Start-Mushaf.ps1
# atau: npm run dev
```

| Peranan | URL |
|---------|-----|
| **Guru** (dual-panel) | http://localhost:3090/?room=kelas-a |
| **Pelajar** | http://localhost:3090/student?room=kelas-a |
| Mushaf sahaja | http://localhost:3090/mushaf?room=kelas-a&role=teacher&local=1 |

## Production (`quran.alhelmi.com`)

Port **3090** — tunnel/Nginx kekal sama. UI `/` kini bilik kelas (bukan mushaf penuh sahaja).

| URL public | Peranan |
|------------|---------|
| https://quran.alhelmi.com/?room=KELAS&token=JWT | Guru |
| https://quran.alhelmi.com/student?room=KELAS&token=JWT | Pelajar |
| https://quran.alhelmi.com/?room=KELAS&role=student&token=JWT | Redirect → /student |

**Auth:** `MUSHAF_JWT_SECRET` dalam `.env` (sama dengan portal `app.alhelmi.com`).  
Tanpa JWT + `NODE_ENV` bukan production → ujian tempatan dengan `?role=`.

```powershell
# Terminal 1 — app
.\Start-Mushaf.ps1

# Terminal 2 — tunnel (jika guna Cloudflare)
cloudflared tunnel run alhelmi-learn
```

Health: `GET /health`

## Ciri

- Panel kiri: Mod Sync, FIFO, matikan mic pelajar
- Panel kanan: mushaf + dock navigasi + PiP kamera (boleh seret/saiz)
- Pelajar: mushaf sync + video guru + kamera sendiri
- WebSocket sync halaman / highlight / zoom

## Stack

- Express + Socket.io
- SVG mushaf Medina (proxy islamic.app)
- WebRTC peer (guru ↔ pelajar) untuk kamera/mic
