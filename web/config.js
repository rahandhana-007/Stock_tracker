// Konfigurasi aplikasi. Saat deploy di Netlify file ini ditulis ulang otomatis
// oleh scripts/build-config.mjs dari environment variable (SUPABASE_URL, SUPABASE_ANON_KEY, ...).
// Untuk uji lokal, isi langsung di sini.
window.FC_CONFIG = {
  SUPABASE_URL: "https://YOUR-PROJECT.supabase.co",
  SUPABASE_ANON_KEY: "YOUR_ANON_KEY",
  DEFAULT_YEAR: 2026,
  // Login memakai username: "budi" → akun Supabase "budi@forecast.local" (domain internal, tanpa mailbox).
  LOGIN_DOMAIN: "forecast.local",
  // true hanya jika user punya email asli + SMTP Supabase dikonfigurasi (menampilkan "Lupa password?").
  PASSWORD_RESET: false,
  COMPANY: "PT BRIDGESTONE SUMATRA RUBBER ESTATE",
  TITLE: "MASTER FORECAST CONSUMPTION PLAN – STOCK ITEMS",
};
