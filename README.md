# Master Forecast Consumption Plan — versi Netlify + Supabase

Port dari aplikasi FastAPI + SQLite (`/forecast-app`) menjadi **situs statis di Netlify** dengan
**Supabase (Postgres + Auth)** sebagai backend. Fitur sama persis: tabel forecast 4 baris × 12 bulan
per item dengan End Stock otomatis, edit sel & tempel 12 angka, CRUD item, stok awal, filter, KPI,
alert, dashboard, import (Master RumpUp‑Forecast **dan** SAP B1 Inventory Posting List), export
Excel, template, rollover tahun, pengaturan judul — ditambah **login** dan **riwayat import**.

```
forecast-netlify/
├─ netlify.toml              # publish = web, build = node scripts/build-config.mjs
├─ package.json              # npm test / npm run build
├─ scripts/build-config.mjs  # tulis web/config.js dari environment variable Netlify
├─ supabase/
│  ├─ schema.sql             # tabel, RLS, fungsi apply_changes / rollover_year / list_years
│  └─ seed.sql               # 57 item + data FY2026 dari database SQLite lama
├─ web/                      # ← yang dipublikasikan Netlify (murni statis)
│  ├─ index.html, styles.css, config.js
│  ├─ js/calc.js             # perhitungan End Stock, KPI, status, dashboard (port calc.py)
│  ├─ js/sap.js              # parser SAP Inventory Posting List (port sap_io.py)
│  ├─ js/master.js           # parser template Master + export/template Excel (port excel_io.py)
│  ├─ js/data.js             # akses Supabase (auth, query, RPC)
│  ├─ js/app.js              # UI (sama dengan versi lama, tanpa fetch ke /api)
│  └─ vendor/                # supabase-js, SheetJS (baca xlsx), ExcelJS (tulis xlsx)
└─ tests/
   ├─ unit.test.mjs          # cek silang kalkulasi & parser vs hasil Python
   ├─ local-server.mjs       # server uji lokal (PostgREST + auth tiruan)
   └─ e2e_ui.py              # uji UI Playwright (login → edit → import → export → logout)
```

---

## 1. Siapkan Supabase (± 10 menit)

1. Buat proyek di <https://supabase.com/dashboard> (region Singapore paling dekat). Simpan **Database password**.
2. **SQL Editor → New query** → tempel isi `supabase/schema.sql` → **Run**.
   Lalu query baru → tempel `supabase/seed.sql` → **Run** (data 57 item FY2026 ikut masuk).
   Kedua skrip aman dijalankan ulang.
3. **Authentication → Sign In / Providers → Email**: provider Email harus **Enabled**
   (ini mesin login username+password — tidak ada email yang benar‑benar dikirim), lalu:
   * **Confirm email → OFF**
   * **Allow new users to sign up → OFF** (wajib: hanya akun buatan admin yang bisa masuk)
4. **Authentication → Users → Add user → Create new user** untuk setiap pemakai.
   Login memakai **username tanpa email**: aplikasi mengubah username `budi` menjadi identitas
   `budi@forecast.local` (domain internal, tidak perlu mailbox). Jadi isi kolom *Email* di
   dashboard dengan `<username>@forecast.local`, mis. `budi@forecast.local`, dan tentukan passwordnya.
   Domain bisa diganti lewat `LOGIN_DOMAIN`. User yang mengetik alamat lengkap (ada `@`) tetap bisa login.
5. *(Opsional, hanya jika user punya email asli + SMTP dikonfigurasi)* set `PASSWORD_RESET=true`
   untuk menampilkan tautan "Lupa password?", dan isi **Authentication → URL Configuration**
   (*Site URL* + *Redirect URL*) dengan alamat Netlify Anda. Tanpa itu, reset password dilakukan admin
   dari Dashboard → Users → ⋯ → *Reset password*.
6. Catat dari **Project Settings → API**: **Project URL** dan **anon public key**.

Keamanan: anon key memang publik, tetapi semua tabel memakai **Row Level Security** — hanya
sesi login (`authenticated`) yang boleh membaca/menulis, dan fungsi RPC dicabut dari `anon`.

## 2. Deploy ke Netlify

### Cara A — dari Git (disarankan, deploy ulang otomatis tiap push)
1. Push folder ini ke GitHub/GitLab/Bitbucket.
2. Netlify → **Add new site → Import an existing project** → pilih repo.
   Build command & publish dir sudah dibaca dari `netlify.toml`
   (`node scripts/build-config.mjs`, publish `web`).
3. **Site configuration → Environment variables**, tambahkan:

   | Variable | Nilai |
   |---|---|
   | `SUPABASE_URL` | Project URL, mis. `https://abcd1234.supabase.co` |
   | `SUPABASE_ANON_KEY` | anon public key |
   | `DEFAULT_YEAR` *(opsional)* | `2026` |
   | `COMPANY` *(opsional)* | `PT BRIDGESTONE SUMATRA RUBBER ESTATE` |
   | `TITLE` *(opsional)* | `MASTER FORECAST CONSUMPTION PLAN – STOCK ITEMS` |
   | `LOGIN_DOMAIN` *(opsional)* | `forecast.local` — domain internal di belakang username |
   | `PASSWORD_RESET` *(opsional)* | `false` — `true` hanya bila user punya email asli & SMTP aktif |
   | `ADMIN_USERS` *(opsional)* | `anggit` — username yang boleh membuka menu ⋯ (pisahkan dengan koma) |

4. **Deploys → Trigger deploy**. Skrip build menulis `web/config.js` dari variabel di atas.

### Cara B — tanpa Git (Netlify Drop)
1. Edit `web/config.js`, isi `SUPABASE_URL` dan `SUPABASE_ANON_KEY`.
2. Buka <https://app.netlify.com/drop> dan seret **folder `web`** ke halaman itu. Selesai.

Buka alamat Netlify → halaman login → masuk dengan akun dari langkah 1.3.

---

### Hak akses di tampilan
* Nama user yang login tampil (huruf kapital) di kiri pilihan FY; klik untuk *Ganti password* / *Keluar*.
* Menu **⋯** (rollover tahun, template, pengaturan judul, riwayat import) hanya tampil untuk username
  di `ADMIN_USERS` (bawaan: `anggit`). Ini pembatasan di sisi tampilan; semua user login tetap
  boleh mengedit data lewat RLS. Bila perlu pembatasan di database (mis. hanya admin yang boleh
  rollover/hapus item), tambahkan policy RLS berbasis email — bisa ditambahkan belakangan.

## 3. Yang berubah dibanding versi FastAPI

| Bagian | Dulu (FastAPI + SQLite) | Sekarang (Netlify + Supabase) |
|---|---|---|
| Server | Python/uvicorn, 19 endpoint `/api/*` | Tidak ada server; browser bicara langsung ke Supabase (PostgREST) |
| Database | SQLite `data/forecast.db` | Postgres di Supabase, skema sama (`items`, `item_years`, `monthly`, `settings`) + `import_logs` |
| Login | tidak ada | Supabase Auth (username + password; username dipetakan ke `user@forecast.local`), RLS di semua tabel |
| Perhitungan End Stock/KPI/dashboard | `calc.py` di server | `js/calc.js` di browser (hasil identik, dicek unit test) |
| Import Excel (Master & SAP) | diproses server | dibaca & dianalisis di browser (SheetJS), lalu satu panggilan RPC `apply_changes` (transaksional) |
| Export / template Excel | openpyxl di server | ExcelJS di browser — layout, rumus, warna, freeze pane & filter sama |
| Edit sel / tempel baris / stok awal | endpoint PUT | RPC `apply_changes` / upsert `item_years` |
| Rollover tahun | endpoint POST | RPC `rollover_year` |
| Riwayat import | – | menu ⋯ → *Riwayat import* (tabel `import_logs`: siapa, kapan, file, hasil) |
| Dokumentasi API `/docs` | ada | tidak ada (tidak ada API sendiri) |

Perilaku yang dipertahankan: "kunci tidak dikirim = tidak diubah", `null` = kosongkan sel;
import SAP hanya menimpa Actual/Incoming bulan yang dipilih dan tidak menyentuh Forecast; item baru
dari SAP mengikuti aturan kategori yang sama; item master yang UoM‑nya kosong diisi dari SAP.

## 4. Menjalankan uji

```bash
# unit test kalkulasi & parser (butuh node_modules xlsx/exceljs untuk simulasi browser)
mkdir -p /tmp/vend && (cd /tmp/vend && npm i @supabase/supabase-js@2 xlsx@0.18.5 exceljs@4.4.0)
VENDOR_NODE_MODULES=/tmp/vend/node_modules REF_JSON=path/ke/ref.json node tests/unit.test.mjs

# uji UI lengkap tanpa akun Supabase: Postgres lokal + biner PostgREST + auth tiruan
psql -c "create role anon nologin; create role authenticated nologin; create role authenticator noinherit login password 'secret'; grant anon, authenticated to authenticator;"
createdb fc && psql -d fc -f supabase/schema.sql && psql -d fc -f supabase/seed.sql
POSTGREST_BIN=/path/postgrest DB_URI=postgres://authenticator:secret@localhost/fc node tests/local-server.mjs
# buka http://localhost:8080 → login: username demo / password demo1234 ; atau: python3 tests/e2e_ui.py
```

## 5. Catatan operasional

* **Free tier Supabase** menjeda proyek yang tidak diakses 7 hari; buka dashboard untuk mengaktifkan
  lagi, atau pakai paket Pro. Netlify free tier cukup (situs statis ~2 MB).
* Ganti password sendiri: menu ⋯ → *Ganti password*. Lupa password: admin reset dari Dashboard → Users.
* Menambah/menghapus pemakai: Supabase Dashboard → Authentication → Users (email = `username@forecast.local`).
* Backup: Supabase Dashboard → Database → Backups (harian di paket Pro), atau `pg_dump` dengan
  connection string dari Project Settings → Database.
* Memindahkan data terbaru dari aplikasi lama: `seed.sql` sudah memuat data SQLite terakhir. Bila
  nanti aplikasi lama masih dipakai, export Excel dari sana lalu import di aplikasi baru (format Master).
