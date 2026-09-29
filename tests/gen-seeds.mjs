// Regenerasi supabase/seed.sql + seed_transactions.sql dari:
//   - /home/user/forecast-app/data/forecast.db (item master, forecast, stok awal)   [python3 + sqlite3 dipanggil di bawah]
//   - /home/user/file2.xlsx (SAP Inventory Posting List) → Actual/Incoming Jan..TO_MONTH + histori transaksi
// Pakai: VENDOR_NODE_MODULES=/tmp/vend/node_modules TO_MONTH=9 node tests/gen-seeds.mjs
import fs from "node:fs";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire((process.env.VENDOR_NODE_MODULES || "/tmp/vend/node_modules") + "/");
const XLSX = require("xlsx");
const YEAR = 2026, TO = Number(process.env.TO_MONTH || 9);
const SAP_FILE = process.env.SAP_FILE || "/home/user/file2.xlsx";
const ctx = { window: {}, console, XLSX, setTimeout }; ctx.self = ctx.window; vm.createContext(ctx);
for (const f of ["calc", "sap", "master"]) vm.runInContext(fs.readFileSync(`web/js/${f}.js`, "utf8"), ctx, { filename: f + ".js" });
const FC = ctx.window.FC; ctx.FC = FC;

// --- master data from SQLite via python (no sqlite3 binding needed in node)
const py = `
import json, sqlite3
c = sqlite3.connect('/home/user/forecast-app/data/forecast.db'); c.row_factory = sqlite3.Row
print(json.dumps({
 'items': [dict(r) for r in c.execute("select code, category, description, uom, min_stock, max_stock, lead_time_days, user_dept from items order by id")],
 'iy': [dict(r) for r in c.execute("select i.code, y.year, y.opening_stock from item_years y join items i on i.id=y.item_id order by i.code, y.year")],
 'monthly': [dict(r) for r in c.execute("select i.code, m.year, m.month, m.forecast, m.actual, m.incoming from monthly m join items i on i.id=m.item_id order by i.code, m.year, m.month")]}))`;
const db = JSON.parse(execFileSync("python3", ["-c", py], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));

// --- SAP
const wb = XLSX.read(fs.readFileSync(SAP_FILE), { type: "buffer" });
const det = FC.master.detect(wb);
const parsed = FC.sap.parsePostingList(det.rows);
const master = db.items.map((i) => ({ code: i.code }));
const opts = { year: YEAR, from_month: 1, to_month: TO, scope: "existing", set_opening: true };
const { payload } = FC.sap.buildPayload(parsed, opts, master);
const sap = Object.fromEntries(payload.items.map((e) => [e.code, e]));
const tx = FC.sap.buildTransactions(parsed, opts, payload);
const dmax = parsed.date_max ? `${parsed.date_max.y}-${String(parsed.date_max.m).padStart(2, "0")}-${String(parsed.date_max.d).padStart(2, "0")}` : null;
const lastDay = new Date(Date.UTC(YEAR, TO, 0)).getUTCDate();
const endSel = `${YEAR}-${String(TO).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
const until = dmax && dmax < endSel ? dmax : endSel;

const q = (v) => v === null || v === undefined ? "NULL" : "'" + String(v).replace(/'/g, "''") + "'";
const n = (v) => v === null || v === undefined ? "NULL" : String(v);
const m2 = (m) => String(m).padStart(2, "0");

// --- seed.sql
const rows = [];
for (const r of db.monthly) {
  let { forecast: f, actual: a, incoming: inc } = r;
  const e = sap[r.code];
  if (e && r.year === YEAR) { const cell = e.cells.find((x) => x.month === r.month); if (cell) { a = cell.actual; inc = cell.incoming; } }
  if (f === null && a === null && inc === null) continue;
  rows.push(`  ((select id from public.items where code=${q(r.code)}), ${r.year}, ${r.month}, ${n(f)}, ${n(a)}, ${n(inc)})`);
}
const openings = new Map(db.iy.map((r) => [`${r.code}|${r.year}`, r.opening_stock]));
for (const e of payload.items) if (e.opening !== undefined) openings.set(`${e.code}|${YEAR}`, e.opening);
const seed = [
  `-- Data awal: ${db.items.length} item master (Master RumpUp-Forecast) + Actual/Incoming dari SAP Posting List Jan–${["Jan","Feb","Mar","Apr","Mei","Jun","Jul","Agu","Sep","Okt","Nov","Des"][TO - 1]} ${YEAR}` + (until < endSel ? ` (bulan terakhir parsial s/d ${until}).` : "."),
  "-- Jalankan SETELAH schema.sql. Aman dijalankan ulang (baris yang sudah ada dilewati).", "begin;", "",
  "insert into public.items(code, category, description, uom, min_stock, max_stock, lead_time_days, user_dept) values",
  db.items.map((r) => `  (${q(r.code)}, ${q(r.category)}, ${q(r.description)}, ${q(r.uom)}, ${n(r.min_stock)}, ${n(r.max_stock)}, ${n(r.lead_time_days)}, ${q(r.user_dept)})`).join(",\n") + "\non conflict (code) do nothing;\n",
  "insert into public.item_years(item_id, year, opening_stock) values",
  [...openings.entries()].map(([k, v]) => { const [code, y] = k.split("|"); return `  ((select id from public.items where code=${q(code)}), ${y}, ${n(v)})`; }).join(",\n") + "\non conflict (item_id, year) do nothing;\n",
  "insert into public.monthly(item_id, year, month, forecast, actual, incoming) values",
  rows.join(",\n") + "\non conflict (item_id, year, month) do nothing;\n",
  `insert into public.settings(key, value) values ('sap_until_${YEAR}', '${until}') on conflict (key) do nothing;\n`,
  "commit;", ""].join("\n");
fs.writeFileSync("supabase/seed.sql", seed);

// --- seed_transactions.sql
const codes = [...new Set(tx.rows.map((r) => r.code))];
const txSql = [
  `-- Histori transaksi SAP ${YEAR} bulan 1–${TO} untuk item master (dari SAP Inventory Posting List, data s/d ${until}).`,
  "-- Jalankan SETELAH schema.sql (atau 002_transactions.sql) dan seed.sql. Mengganti histori item-item ini pada rentang bulan tsb.", "begin;",
  `delete from public.transactions t using public.items i where t.item_id = i.id and t.year = ${YEAR} and t.month between 1 and ${TO} and i.code in (${codes.map((c) => `'${c}'`).join(",")});`,
  "insert into public.transactions(item_id, posting_date, seq, doc_type, doc_no, whse, acct_name, rec_qty, iss_qty, uom, balance, role) values",
  tx.rows.map((r) => `  ((select id from public.items where code=${q(r.code)}), ${q(r.posting_date)}, ${r.seq}, ${q(r.doc_type)}, ${q(r.doc_no)}, ${q(r.whse)}, ${q(r.acct_name)}, ${n(r.rec_qty)}, ${n(r.iss_qty)}, ${q(r.uom)}, ${n(r.balance)}, ${q(r.role)})`).join(",\n") + ";",
  `insert into public.settings(key, value) values ('sap_until_${YEAR}', '${until}') on conflict (key) do update set value = excluded.value;`,
  "commit;", ""].join("\n");
fs.writeFileSync("supabase/seed_transactions.sql", txSql);
const sepMoving = payload.items.filter((e) => e.cells.some((c) => c.month === TO && (c.actual || c.incoming))).length;
console.log(`seed.sql: ${rows.length} monthly rows | seed_transactions.sql: ${tx.rows.length} tx rows, ${codes.length} items | sap_until=${until} | items with movement in month ${TO}: ${sepMoving}`);
