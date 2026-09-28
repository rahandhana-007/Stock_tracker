// Konfigurasi aplikasi. Saat deploy di Netlify file ini ditulis ulang otomatis
// oleh scripts/build-config.mjs dari environment variable (SUPABASE_URL, SUPABASE_ANON_KEY, ...).
// Untuk uji lokal, isi langsung di sini.
window.FC_CONFIG = {
  SUPABASE_URL: "https://ymgufmavqnhupwoslgbw.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_pCZSGcla5e2ehiM2KA4K1Q_70_t9S-E",
  DEFAULT_YEAR: 2026,
  // Login memakai username: "budi" → akun Supabase "budi@forecast.local" (domain internal, tanpa mailbox).
  LOGIN_DOMAIN: "forecast.local",
  // true hanya jika user punya email asli + SMTP Supabase dikonfigurasi (menampilkan "Lupa password?").
  PASSWORD_RESET: false,
  // Username yang boleh membuka menu ⋯ (rollover, template, pengaturan, riwayat import).
  ADMIN_USERS: ["anggit"],
  COMPANY: "PT BRIDGESTONE SUMATRA RUBBER ESTATE",
  TITLE: "INVENTORY MANAGEMENT SYSTEM – STOCK ITEMS",
};
