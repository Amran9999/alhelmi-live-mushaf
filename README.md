# AlHelmi Live Mushaf

Bilik kelas talaqqi: mushaf Madinah sync real-time, anotasi guru, kongsi foto panduan dan arkib nota peribadi. Dalam portal AlHelmi, FIFO datang daripada Moodle dan kamera/mikrofon datang daripada Jitsi.

| | |
|---|---|
| **Production** | https://quran.alhelmi.com |
| **Versi production** | `0.4.1` (3 Ogos 2026) · deploy `secure-notes-refresh-202608031941` |
| **Portal** | https://app.alhelmi.com (JWT masuk bilik) · dashboard tag `done-stay-202608050102` (FIFO/rakaman di App; lihat `D:\App\CHANGELOG.md`) |
| **Repo** | https://github.com/Amran9999/alhelmi-live-mushaf |
| **Port** | `3090` |
| **VPS path** | `/opt/mushaf` |

Lihat juga: [changelog.md](./changelog.md) · [DEPLOY-VPS.md](./DEPLOY-VPS.md) · [DEPLOY.md](./DEPLOY.md)

---

## Ciri utama

- **Dual-panel guru** — kawalan kiri + mushaf/foto di skrin utama
- **Sync halaman** — Mod Sync on/off; pelajar ikut halaman/highlight/zoom guru
- **Giliran FIFO standalone** — senarai tunggu + slot “Sedang Baca”; dalam portal, Moodle `turn_queue` ialah SSOT dan panel FIFO Mushaf disembunyikan
- **Kawalan paparan** — suis **Mushaf ↔ Foto**; muat naik JPG/PNG atau screenshot nota
- **Anotasi** — pen merah/hijau, pemadam, clear lukisan/highlight (guru sahaja; sync ke pelajar)
- **Nota foto** — sehingga 10 foto sesi; pelajar boleh muat turun; arkib 3 sesi Moodle terakhir
- **Nota peribadi** — imej arkib dihantar melalui URL bertandatangan sementara; path `/uploads` ditutup dalam production
- **WebRTC** — kamera/mikrofon guru ↔ pelajar (PiP boleh digeret dalam mod standalone)
- **Auth JWT** — bilik production hanya melalui token portal (`MUSHAF_JWT_SECRET`)

---

## Keperluan

- Node.js **≥ 18**
- Fail `.env` (salin dari `.env.example`)

```env
PORT=3090
NODE_ENV=development
MUSHAF_JWT_SECRET=
# Pilihan: tempoh URL media bertandatangan, 60–3600 saat (default 1800)
MUSHAF_MEDIA_URL_TTL_SEC=1800
```

Dalam **production**, `MUSHAF_JWT_SECRET` mesti sama dengan portal `app.alhelmi.com`.

---

## Jalankan (dev)

```powershell
cd D:\mushaf
npm install
.\Start-Mushaf.ps1
# atau: npm run dev
```

| Peranan | URL (lokal) |
|---------|-------------|
| Guru (dual-panel) | http://localhost:3090/?room=kelas-a |
| Pelajar | http://localhost:3090/student?room=kelas-a |
| Mushaf sahaja | http://localhost:3090/mushaf?room=kelas-a&role=teacher&local=1 |

Tanpa JWT + `NODE_ENV` bukan production → ujian tempatan dengan `?role=teacher` / `?role=student`.

Health check: `GET /health`

---

## Production

| URL | Peranan |
|-----|---------|
| `https://quran.alhelmi.com/?room=KELAS&token=JWT` | Guru |
| `https://quran.alhelmi.com/student?room=KELAS&token=JWT` | Pelajar |
| `?role=student` + token | Redirect → `/student` |

Guru biasanya buka bilik canonical `/dashboard/sesi-belajar/{courseId}` dari portal. Token JWT dijana oleh dashboard (`/api/live/mushaf-token`) dan URL embed membawa `queue_owner=portal`.

Dalam mod portal:
- Moodle `turn_queue` mengawal Seterusnya, Tamatkan, defer dan baca semula.
- Mushaf memaparkan halaman/foto dan mencerminkan `activeReader`.
- Jitsi kekal satu-satunya laluan kamera/mikrofon bilik.

### Deploy ringkas ke VPS

```powershell
cd D:\mushaf
powershell -ExecutionPolicy Bypass -File .\Deploy-To-Vps.ps1
```

Atau `git pull` di `/opt/mushaf` + restart process (PM2 / `node server.js`). Butiran: [DEPLOY-VPS.md](./DEPLOY-VPS.md).

**Amaran:** deploy mushaf/dashboard **jangan** recreate container Moodle — boleh pecahkan login portal (`upgraderunning` / mount plugin).

---

## Struktur ringkas

```
server.js              # Express + Socket.io + bilik
jwt.js                 # Pengesahan JWT
student-notes.js       # Arkib nota foto (3 sesi)
public/
  classroom.html|js    # UI guru
  student.html|js      # UI pelajar
  app.js               # Mushaf iframe + anotasi hook
  annotation-layer.js  # Canvas pen/eraser
  media-av.js          # WebRTC
data/navigation.json   # Navigasi surah/juz/halaman
```

---

## Stack

- Express + Socket.io
- SVG mushaf Madinah (proxy islamic.app / open-quran-view)
- WebRTC peer untuk kamera/mic
- JWT HS256 (claims bilik, peranan, `session_id` Moodle)

---

## Kawalan paparan (guru)

1. **Pilih / muat naik foto panduan** (JPG/PNG) atau **Screenshot nota mushaf**
2. Tekan suis **Foto** → skrin pelajar bertukar ke foto (real-time)
3. Tekan **Mushaf** → kembali ke halaman Quran
4. Galeri: pilih / buang foto (maks 10 sesi)

Suis pantas juga ada di header skrin utama.

---

## Screenshot nota & penyimpanan

- Screenshot dibuat oleh **guru** daripada SVG mushaf + anotasi; pelajar menerima arkib untuk lightbox/muat turun.
- Fail live: `/opt/mushaf/uploads/{room}-{timestamp}.jpg`.
- Arkib pelajar: `/opt/mushaf/uploads/notes/{userId}/{sessionId}/...jpg`.
- Index metadata: `/opt/mushaf/data/student-notes/{userId}.json`.
- Production tidak mendedahkan `/uploads`; browser menerima URL `/media/{token}` bertandatangan HMAC.
- URL media tamat selepas 30 minit dan diperbaharui automatik setiap 20 minit.
- Retention: maksimum 10 foto setiap sesi dan 3 sesi Moodle terkini.
- Butang **Muat turun** menyimpan salinan ke folder Downloads peranti mengikut tetapan pelayar.

Sebelum deploy atau migrasi server, backup kedua-dua folder `uploads/notes` dan `data/student-notes`.

---

## Lesen & penanda

Kod swasta AlHelmi. Sejarah versi dalam [changelog.md](./changelog.md).
