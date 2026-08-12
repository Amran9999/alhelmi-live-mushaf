# Changelog — AlHelmi Live Mushaf

Semua perubahan penting dicatat di sini. Format ringkas berdasarkan [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

Tiada perubahan belum deploy.

---

## Nota portal (5 Ogos 2026) — tiada bump versi mushaf

Perubahan bilik FIFO / rakaman pelajar / “selesai bacaan kekal dalam kelas” berada di **dashboard + Moodle** (`D:\App`, tag `done-stay-202608050102`). Mushaf kekal **0.4.1**; mod Bacaan/Hafazan + **Sembunyi mushaf** sedia ada digunakan untuk program Hafazan.

---

## [0.4.1] — 2026-08-03

### Ditambah
- Kawalan paparan guru lebih jelas: suis **Mushaf / Foto**, butang **Pilih / muat naik foto panduan**, dan suis pantas di header skrin utama
- Status paparan memberitahu bila pelajar sedang melihat foto (sync bilik)
- **Mute policy FIFO:** selepas Tamat / Panggil / Mute semua → hanya pembaca aktif boleh mic+cam (mushaf WebRTC); `postMessage` `fifo-active-changed` ke portal untuk mute Jitsi
- Bilik baru: FIFO **kosong** (tiada nama demo); pelajar masuk barisan hanya bila socket join; disconnect → keluar FIFO
- URL nota/foto bertandatangan HMAC dan tamat tempoh; `/uploads` tidak lagi boleh dicapai terus dalam production
- ACK `share_photo_result`: UI hanya lapor screenshot berjaya selepas server mengesahkan arkib pelajar
- URL bertandatangan nota dan foto live diperbaharui automatik setiap 20 minit untuk kelas panjang

### Diubah
- Slot FIFO “Sedang Baca”: papar **foto profil** Moodle (bukan webcam WebRTC); video live kekal di Jitsi
- Reset FIFO → kosongkan barisan (bukan restore demo)
- Label panel kiri: **Kawalan paparan** (dahulu Paparan skrin)
- Tekan **Foto** tanpa fail sedia → buka pemilih fail terus
- Pilih surah dari cadangan carian → terus pergi ke halaman
- Embed portal menggunakan `queue_owner=portal`: Moodle `turn_queue` ialah SSOT dan panel FIFO Mushaf disembunyikan
- Pelajar bukan pembaca aktif boleh kekal **Baca sendiri** walaupun Mod Sync tersedia; pembaca aktif tetap dikunci ikut guru

### Diperbaiki
- **Nota SS pelajar:** panel arkib default **runtuh** (chip “Nota N”); klik → lightbox, **tidak** ganti mushaf; hanya suis **Foto** guru yang ganti skrin
- **Tamat Giliran:** feedback bila token bukan teacher; auto-aktifkan waiting seterusnya (FIFO)
- Label slot aktif bila tiada stream WebRTC dalam portal (video utama = PiP Jitsi)
- Dock bawah (halaman / Pergi / zoom / Bacaan·Hafazan) tidak bergerak kerana `teacher_update` ditulis semula oleh meta foto galeri
- Shell `/student` dalam iframe portal: sembunyi PiP “Guru” mushaf (elak duplicate dengan Jitsi); **PiP “Anda”** kekal sebagai preview pelajar (keputusan produk 2 Ogos — 2 overlay: Anda + Kamera Jitsi)
- `.pip-self { display:flex }` override atribut `hidden` + `skipLocalMedia` bila embed → PiP “Anda” nampak tetapi kamera tak pernah diminta (hanya mic Jitsi); betulkan CSS `[hidden]` + `student.js` v15 sentiasa `startLocal`
- `.active-slot { display:grid }` override atribut `hidden` → kad “A / — / Sedang Baca” ghost bila FIFO 0/0; betulkan `.active-slot[hidden] { display:none !important }`
- **Portal student:** adopt JWT `userId` dari `joined` (status “Menunggu” kekal); `skipLocalMedia` supaya Jitsi pegang kamera; `postMessage` fifo-active ke portal; bump `student.js?v=16`
- Skrip deploy kini turut memasang `student-notes.js`

---

## [0.4.0] — 2026-08-01

### Ditambah
- Overlay anotasi mushaf untuk guru (pen merah/hijau, pemadam, clear lukisan, clear highlight ayat)
- **Teks anotasi:** butang **Aa** — klik pada mushaf → taip label (mad/gunnah/dll), sync real-time ke pelajar; ikut screenshot nota
- Sync lukisan real-time ke pelajar melalui Socket.io (`annotation_add`, `annotation_clear`, …)
- Kongsi foto JPG/PNG guru dengan suis paparan **Mushaf ↔ Foto** (sync skrin pelajar)
- Galeri sehingga **10** nota foto sesi; pelajar boleh muat turun
- Screenshot nota mushaf (SVG + anotasi) dihantar sebagai foto dikongsi
- Arkib nota pelajar: simpan fail mengikut sesi Moodle, kekalkan **3** sesi terakhir (auto-padam lama)
- Pratonton paparan pelajar untuk guru (label kamera: “Kamera anda” / “Slot guru”)
- PiP kamera guru/pelajar boleh digeret (mod standalone); disembunyikan bila embed portal

### Diubah
- Toolbar anotasi hanya di bar atas mushaf (bukan dock bawah)
- Toolbar anotasi disembunyikan pada paparan pelajar (`shell=student&annotate=0`)
- Butang screenshot nota lebih mudah dicari di panel guru

### Diperbaiki
- WebRTC guru boleh receive-only jika kebenaran kamera ditolak
- Label pratonton pelajar supaya guru tidak keliru “Anda” = pelajar sebenar

---

## [0.3.1] — 2026-07-30

### Ditambah
- Bilik kelas dual-panel talaqqi: panel kiri (FIFO, sync, kawalan) + paparan mushaf Madinah
- Giliran baca FIFO + slot “Sedang Baca” dengan kamera aktif
- Mod **Baca sendiri** / **Ikut guru**; kunci ikut guru semasa giliran aktif
- Live kamera/mikrofon (WebRTC) untuk guru dan pelajar
- Auth bilik melalui JWT bertandatangan (`MUSHAF_JWT_SECRET`); `?role=teacher` diabaikan tanpa token sah
- CSP lebih ketat + `Permissions-Policy`; `frame-ancestors` production tanpa localhost
- URL bilik tanpa JWT digate ke portal AlHelmi

### Diubah
- UI mushaf: toolbar padat gaya iPad + cache-bust headers
- Production: `quran.alhelmi.com` port **3090** — UI `/` = bilik kelas guru

---

## [0.3.0] — initial

### Ditambah
- AlHelmi Live Mushaf v0.3: mushaf Madinah sync halaman, highlight ayat, bilik Socket.io asas

---

## Nota operasi (VPS)

| Item | Nilai |
|------|--------|
| App path | `/opt/mushaf` |
| Port | `3090` |
| Public | `https://quran.alhelmi.com` |
| Auth | JWT dari portal `app.alhelmi.com` (rahsia sama `MUSHAF_JWT_SECRET`) |

Deploy fail statik/app: gunakan `Deploy-To-Vps.ps1` (atau `scp` dengan kunci `~/.ssh/alhelmi_deploy`, port SSH `20203`).

**Amaran:** jangan recreate container Moodle semasa deploy mushaf/dashboard — boleh tinggalkan kunci `upgraderunning` dan pecahkan login portal.
