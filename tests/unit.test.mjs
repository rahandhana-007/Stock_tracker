// Node cross-check of the browser modules against reference output of the Python implementation.
// Run: node tests/unit.test.mjs  (needs: npm i xlsx@0.18.5 exceljs in tests/ or NODE_PATH)
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const NODE_PATH = process.env.VENDOR_NODE_MODULES || "/tmp/vend/node_modules";
globalThis.window = globalThis;
globalThis.XLSX = require(path.join(NODE_PATH, "xlsx"));
globalThis.ExcelJS = require(path.join(NODE_PATH, "exceljs"));
for (const f of ["calc.js", "sap.js", "master.js"]) new Function(fs.readFileSync(path.join(root, "web/js", f), "utf8"))();
const FC = globalThis.FC;
const ref = JSON.parse(fs.readFileSync(process.env.REF_JSON || "/home/user/.arena/ref.json", "utf8"));

let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.log("  FAIL:", msg); } };
const close = (a, b, eps = 1e-6) => (a === null || a === undefined) ? (b === null || b === undefined) : Math.abs(a - b) < eps;

// ---------- calc
console.log("calc.computeItem vs Python");
const items = ref.items_raw.map((it) => FC.calc.computeItem(JSON.parse(JSON.stringify(it))));
for (const it of items) {
  const p = ref.items_calc[it.code], c = it.calc;
  for (const k of ["fy_forecast", "avg_forecast", "peak_month", "peak_qty", "ytd_actual", "ytd_forecast", "ytd_actual_cmp", "months_compared", "total_incoming", "variance", "variance_pct", "accuracy", "last_data_month", "current_stock", "suggested_order", "months_cover"]) ok(close(c[k], p[k]), `${it.code} ${k}: js=${c[k]} py=${p[k]}`);
  ok(c.status === p.status, `${it.code} status ${c.status} vs ${p.status}`);
  ok(c.end_stock.every((v, i) => close(v, p.end_stock[i])), `${it.code} end_stock`);
  ok(c.month_status.every((v, i) => v.status === p.month_status[i].status && v.future === p.month_status[i].future), `${it.code} month_status`);
  ok(c.monthly_accuracy.every((v, i) => close(v, p.monthly_accuracy[i])), `${it.code} monthly_accuracy`);
}
const dash = FC.calc.buildDashboard(items, 2026), pd = ref.dashboard;
ok(Object.keys(pd.kpi).every((k) => close(dash.kpi[k], pd.kpi[k])), `kpi js=${JSON.stringify(dash.kpi)} py=${JSON.stringify(pd.kpi)}`);
ok(dash.need_order.map((b) => b.code).join() === pd.need_order.map((b) => b.code).join(), "need_order order");
ok(dash.low_accuracy.map((b) => b.code).join() === pd.low_accuracy.map((b) => b.code).join(), "low_accuracy order");
ok(dash.by_category.map((b) => b.name + b.items).join() === pd.by_category.map((b) => b.name + b.items).join(), "by_category");
ok(dash.monthly.every((m, i) => close(m.avg_accuracy, pd.monthly[i].avg_accuracy) && m.below_min === pd.monthly[i].below_min && m.zero === pd.monthly[i].zero && m.over_max === pd.monthly[i].over_max), "monthly");
ok(dash.heatmap.length === pd.heatmap.length, "heatmap length");

// ---------- master parse
console.log("master.parseRows vs Python parse_workbook");
const wbM = XLSX.read(fs.readFileSync("/home/user/forecast-app/data/seed_master.xlsx"), { type: "buffer", cellDates: true });
const detM = FC.master.detect(wbM);
ok(detM.format === "master" && detM.sheet === "Master RumpUp-Forecast", `detect master: ${detM.format} ${detM.sheet}`);
const parsedM = FC.master.parseRows(detM.rows);
ok(parsedM.length === ref.master_parsed.length, `master items ${parsedM.length} vs ${ref.master_parsed.length}`);
ref.master_parsed.forEach((p, i) => {
  const j = parsedM[i];
  for (const k of ["code", "category", "description", "uom", "user_dept"]) ok(j[k] === p[k], `master ${p.code} ${k}: ${JSON.stringify(j[k])} vs ${JSON.stringify(p[k])}`);
  for (const k of ["min_stock", "max_stock", "lead_time_days", "opening_stock"]) ok(close(j[k], p[k]), `master ${p.code} ${k}: ${j[k]} vs ${p[k]}`);
  ok(j.months.every((m, mi) => ["forecast", "actual", "incoming"].every((f) => close(m[f], p.months[mi][f]))), `master ${p.code} months`);
});
const sumM = FC.master.summarize(parsedM, ref.items_raw);
ok(sumM.items_total === 57 && sumM.matched === 57 && sumM.with_forecast === 16 && sumM.with_actual === 13, `master summary ${JSON.stringify(sumM)}`);

// ---------- sap parse
console.log("sap.parsePostingList vs Python");
const t0 = Date.now();
const wbS = XLSX.read(fs.readFileSync("/home/user/file2.xlsx"), { type: "buffer", cellDates: true });
const detS = FC.master.detect(wbS);
ok(detS.format === "sap", `detect sap: ${detS.format}`);
const parsedS = FC.sap.parsePostingList(detS.rows);
console.log(`  parsed in ${Date.now() - t0} ms`);
const sumS = FC.sap.summarize(parsedS, ref.items_raw), ps = ref.sap_summary;
for (const k of ["year", "date_min", "date_max", "last_complete_month", "tx_total", "items_total", "items_moving", "items_stock_only", "matched", "matched_moving", "new_moving", "new_all", "balance_mismatch", "day_first"]) ok(JSON.stringify(sumS[k]) === JSON.stringify(ps[k]), `sap ${k}: ${JSON.stringify(sumS[k])} vs ${JSON.stringify(ps[k])}`);
ok(JSON.stringify(sumS.months_with_data) === JSON.stringify(ps.months_with_data), "sap months_with_data");
ok(JSON.stringify(sumS.categories) === JSON.stringify(ps.categories), `sap categories\n   js=${JSON.stringify(sumS.categories)}\n   py=${JSON.stringify(ps.categories)}`);
ok(JSON.stringify(sumS.doc_types.map((d) => [d.type, d.rows, Math.round(d.rec), Math.round(d.iss), d.role])) === JSON.stringify(ps.doc_types.map((d) => [d.type, d.rows, Math.round(d.rec), Math.round(d.iss), d.role])), "sap doc_types");
const m8 = parsedS.items["15008"].monthly[2026];
ok(m8[1].actual === 750 && m8[1].incoming === 750 && m8[8].incoming === 2250 && parsedS.items["15008"].opening === 1250, `15008 monthly ${JSON.stringify(m8)}`);
ok(parsedS.items["15017"].opening === 75 && parsedS.items["15017"].monthly[2026][7].actual === 50, "15017");
ok(JSON.stringify(FC.sap.deriveCategories(parsedS, ref.items_raw)) === JSON.stringify(ref.sap_cats), `sap cats ${JSON.stringify(FC.sap.deriveCategories(parsedS, ref.items_raw))}`);
const { payload, stats } = FC.sap.buildPayload(parsedS, { year: 2026, from_month: 1, to_month: 8, scope: "existing", set_opening: true }, ref.items_raw);
ok(stats.updated === 54 && stats.created === 0 && stats.opening_set === 54 && stats.cells === 864 && stats.skipped_not_in_master === 1521, `payload stats ${JSON.stringify(stats)}`);
const e8 = payload.items.find((i) => i.code === "15008");
ok(e8.opening === 1250 && e8.cells.length === 8 && e8.cells[0].actual === 750 && e8.cells[7].incoming === 2250 && e8.fill_uom === "Kgs", `payload 15008 ${JSON.stringify(e8).slice(0, 200)}`);
const p2 = FC.sap.buildPayload(parsedS, { year: 2026, from_month: 1, to_month: 8, scope: "moving", categories: ["12", "15"], set_opening: true }, ref.items_raw).stats;
ok(p2.created === 0 && p2.skipped_category === 420 && p2.skipped_no_tx === 1101, `payload moving stats ${JSON.stringify(p2)}`);
const p3 = FC.sap.buildPayload(parsedS, { year: 2026, from_month: 1, to_month: 8, scope: "moving", categories: null, set_opening: true }, ref.items_raw).stats;
ok(p3.created === 420, `payload moving all cats ${JSON.stringify(p3)}`);

// ---------- export
console.log("master.exportWorkbook");
const blob = await FC.master.exportWorkbook(items, 2026, ref.settings.company, ref.settings.title);
fs.writeFileSync("/tmp/export_js.xlsx", Buffer.from(await blob.arrayBuffer()));
console.log(`  export written: ${blob.size} bytes`);
const tpl = await FC.master.templateWorkbook();
fs.writeFileSync("/tmp/template_js.xlsx", Buffer.from(await tpl.arrayBuffer()));

console.log(fails ? `\n${fails} FAILURES` : "\nALL OK");
process.exit(fails ? 1 : 0);
