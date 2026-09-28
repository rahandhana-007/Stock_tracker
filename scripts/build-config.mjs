// Dijalankan oleh Netlify saat build: menulis web/config.js dari environment variable.
// Variabel: SUPABASE_URL, SUPABASE_ANON_KEY (wajib), DEFAULT_YEAR, COMPANY, TITLE, LOGIN_DOMAIN, PASSWORD_RESET, ADMIN_USERS (opsional; ADMIN_USERS dipisah koma).
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = join(root, "web", "config.js");
const env = process.env;

if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
  const current = existsSync(target) ? readFileSync(target, "utf8") : "";
  if (/YOUR-PROJECT|YOUR_ANON_KEY/.test(current) || !current) {
    console.error("\n[build-config] SUPABASE_URL / SUPABASE_ANON_KEY belum diset di environment variable Netlify "
      + "(Site configuration → Environment variables). Aplikasi akan menampilkan halaman 'Konfigurasi belum lengkap'.\n");
  } else {
    console.log("[build-config] Env kosong; memakai web/config.js yang sudah ada.");
  }
  process.exit(0);
}

const cfg = {
  SUPABASE_URL: env.SUPABASE_URL.replace(/\/+$/, ""),
  SUPABASE_ANON_KEY: env.SUPABASE_ANON_KEY,
  DEFAULT_YEAR: Number(env.DEFAULT_YEAR) || new Date().getFullYear(),
  LOGIN_DOMAIN: (env.LOGIN_DOMAIN || "forecast.local").replace(/^@/, ""),
  PASSWORD_RESET: /^(1|true|yes)$/i.test(env.PASSWORD_RESET || ""),
  ADMIN_USERS: (env.ADMIN_USERS || "anggit").split(",").map((u) => u.trim()).filter(Boolean),
  COMPANY: env.COMPANY || "PT BRIDGESTONE SUMATRA RUBBER ESTATE",
  TITLE: env.TITLE || "INVENTORY MANAGEMENT SYSTEM – STOCK ITEMS",
};
writeFileSync(target, `// Dihasilkan otomatis saat build (${new Date().toISOString()}) — jangan diedit manual.\nwindow.FC_CONFIG = ${JSON.stringify(cfg, null, 2)};\n`);
console.log(`[build-config] web/config.js ditulis untuk ${cfg.SUPABASE_URL}`);
