# Deploy VPS dari GitHub (disyorkan)

Kod sudah di: https://github.com/Amran9999/alhelmi-live-mushaf

Agent Cursor **tidak boleh SSH** (Permission denied). Jalankan arahan di bawah **dalam terminal anda**.

---

## 1) SSH masuk VPS

```powershell
ssh -p 20203 -o MACs=hmac-sha2-256 root@124.217.249.167
```

---

## 2) Clone atau update repo

**Jika folder belum wujud:**

```bash
mkdir -p /opt
cd /opt
git clone https://github.com/Amran9999/alhelmi-live-mushaf.git mushaf
cd mushaf
```

**Jika sudah ada (update):**

```bash
cd /opt/mushaf   # atau path sebenar anda
git fetch origin
git checkout main
git pull origin main
```

---

## 3) Fail `.env` di VPS

```bash
cd /opt/mushaf
nano .env
```

Isi:

```env
PORT=3090
NODE_ENV=production
MUSHAF_JWT_SECRET=secret-sebenar-dari-portal
```

Simpan: `Ctrl+O` Enter, keluar: `Ctrl+X`

---

## 4) Install & jalankan

```bash
cd /opt/mushaf
npm install --omit=dev
```

Dengan PM2:

```bash
pm2 describe mushaf >/dev/null 2>&1 && pm2 restart mushaf --update-env || pm2 start server.js --name mushaf
pm2 save
pm2 status
```

Tanpa PM2:

```bash
pkill -f 'node server.js' || true
nohup node server.js >/var/log/mushaf.log 2>&1 &
```

---

## 5) Uji

```bash
curl -s http://127.0.0.1:3090/health
```

Mesti ada: `"ui":"classroom-dual-panel"`

Public: https://quran.alhelmi.com/health

---

## Nota tunnel

Jika `quran.alhelmi.com` masih Cloudflare Tunnel ke **PC anda**, sama ada:

- matikan tunnel lokal dan arahkan DNS/Nginx ke VPS `:3090`, **atau**
- biarkan tunnel + jalankan `npm.cmd run dev` di PC (bukan VPS)

---

## Alternatif dari Windows (scp skrip lama)

```powershell
cd D:\mushaf
powershell -ExecutionPolicy Bypass -File .\Deploy-To-Vps.ps1
```

Lebih baik guna **git pull** di VPS seperti di atas.
