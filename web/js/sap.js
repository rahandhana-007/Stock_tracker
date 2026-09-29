/* =====================================================================
   SAP Business One "Inventory Posting List" parser (port of sap_io.py).
   Works on a 2-D array of cell values (SheetJS sheet_to_json header:1).

   Mapping rules:
     Actual consumption = Σ Iss. Qty of SO
     Incoming           = Σ Rec. Qty of PD + SI  −  Σ Iss. Qty of PR
     Ignored            = IM, PU, MR
     Unknown doc types  = Rec → Incoming, Iss → Actual
     Opening stock      = balance on the item header row
   ===================================================================== */
(function () {
  "use strict";

  const DOC_ROLE = { SO: "actual", PD: "incoming", SI: "incoming", PR: "return", IM: "ignore", PU: "ignore", MR: "ignore" };
  const DOC_LABEL = {
    SO: "Goods Issue – pemakaian", PD: "Goods Receipt PO – penerimaan", SI: "Stock-in / penyesuaian masuk",
    PR: "Goods Return – retur ke vendor", IM: "Inventory Transfer antar gudang", PU: "A/P Invoice (tanpa qty)", MR: "Revaluasi (tanpa qty)",
  };
  const ROLE_LABEL = {
    actual: "→ Actual Consumption", incoming: "→ Incoming", return: "→ Incoming (dikurangkan)", ignore: "diabaikan",
    auto: "tidak dikenal → Rec ke Incoming, Iss ke Actual",
  };
  const SUBTOTAL_ROWS = new Set(["daily subtotal", "monthly subtotal", "yearly subtotal", "subtotal", "total"]);
  const STATIC_CATEGORY = { 11: "Spare Parts", 12: "Packing Materials", 13: "Fuel", 14: "Lubricants", 15: "Chemical", 16: "Stationary", 17: "Other Materials" };

  class SapFormatError extends Error {}

  const norm = (v) => (v === null || v === undefined) ? "" : String(v).replace(/\s+/g, " ").trim().toLowerCase();
  const isEmpty = (v) => v === null || v === undefined || String(v).trim() === "";
  function num(v) {
    if (isEmpty(v)) return 0;
    if (typeof v === "number") return v;
    const n = Number(String(v).replace(/,/g, "").trim());
    return Number.isFinite(n) ? n : 0;
  }
  function codeStr(v) {
    if (typeof v === "number" && Number.isInteger(v)) return String(v);
    return String(v).trim();
  }
  function dateParts(v) {
    if (v instanceof Date) return null;
    const s = String(v).trim();
    if (!/^\d{1,4}[./-]\d{1,2}[./-]\d{1,4}$/.test(s)) return null;
    return s.split(/[./-]/).map((x) => parseInt(x, 10));
  }
  function makeDate(v, dayFirst) {
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : { y: v.getFullYear(), m: v.getMonth() + 1, d: v.getDate() };
    const p = dateParts(v);
    if (!p) return null;
    let [a, b, c] = p, y, m, d;
    if (a > 31) { y = a; m = b; d = c; } else if (dayFirst) { d = a; m = b; y = c; } else { m = a; d = b; y = c; }
    if (y < 100) y += 2000;
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCMonth() !== m - 1) return null;       // e.g. 31 Feb
    return { y, m, d };
  }
  const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cmpDate = (a, b) => (a.y - b.y) || (a.m - b.m) || (a.d - b.d);
  const isoDate = (o) => o ? `${o.y}-${String(o.m).padStart(2, "0")}-${String(o.d).padStart(2, "0")}` : null;

  function isSapHeader(row) {
    const vals = new Set((row || []).map(norm));
    return vals.has("posting date") && (vals.has("rec. qty") || vals.has("rec qty") || vals.has("iss. qty") || vals.has("balance"));
  }

  /** 'sap' | 'master' | 'unknown' from the first 30 rows. */
  function detectFormat(rows) {
    for (const row of rows.slice(0, 30)) {
      const vals = new Set((row || []).map(norm));
      if (vals.has("activity")) return "master";
      if (isSapHeader(row)) return "sap";
    }
    return "unknown";
  }

  function counterTop(counter) {
    let best = null, bestN = -1;
    for (const [k, n] of Object.entries(counter)) if (n > bestN) { best = k; bestN = n; }
    return best;
  }
  const inc = (obj, k, n = 1) => { obj[k] = (obj[k] || 0) + n; };

  // ---------------------------------------------------------------- parse
  function parsePostingList(rows) {
    let hdrIdx = null;
    const col = {};
    for (let i = 0; i < Math.min(rows.length, 40); i++) {
      const row = rows[i] || [];
      if (!isSapHeader(row)) continue;
      hdrIdx = i;
      row.forEach((v, c) => {
        const n = norm(v);
        if (n === "posting date") col.date = c;
        else if (n === "document") col.doc = c;
        else if (n === "whse" || n === "warehouse") col.whse = c;
        else if (n.startsWith("g/l acct/bp code") || n === "bp code") col.acct = c;
        else if (n.startsWith("g/l acct/bp name") || n === "bp name") col.name = c;
        else if (["rec. qty", "rec qty", "received qty", "in qty"].includes(n)) col.rec = c;
        else if (["iss. qty", "iss qty", "issued qty", "out qty"].includes(n)) col.iss = c;
        else if (n.includes("uom")) col.uom = c;
        else if (n.startsWith("price") && !n.includes("currency")) col.price = c;
        else if (n === "balance") col.bal = c;
      });
      break;
    }
    if (hdrIdx === null) throw new SapFormatError("Header 'Posting Date / Document / Rec. Qty / Iss. Qty / Balance' tidak ditemukan.");
    for (const k of ["date", "doc", "rec", "iss", "bal"]) if (col[k] === undefined) throw new SapFormatError(`Kolom '${k}' tidak ditemukan pada header laporan SAP.`);
    if (col.name === undefined) col.name = 5;
    const g = (row, key) => { const c = col[key]; return (c === undefined || c === null || c >= row.length) ? null : row[c]; };

    // day-first vs month-first
    let dayFirst = false, monthFirstEvidence = false;
    for (let i = hdrIdx + 1; i < rows.length; i++) {
      const p = dateParts(g(rows[i] || [], "date"));
      if (!p) continue;
      const [a, b] = p;
      if (a > 31) continue;
      if (a > 12) { dayFirst = true; break; }
      if (b > 12) monthFirstEvidence = true;
    }
    if (monthFirstEvidence) dayFirst = false;

    const items = {}, order = [], docTypes = {}, years = {};
    let cur = null, dmin = null, dmax = null, txTotal = 0, balanceMismatch = 0;
    const newItem = (code, name, opening) => ({ code, name: isEmpty(name) ? "" : String(name).trim(), opening, closing: null, closing_set: false, tx_count: 0, uom: {}, acct_names: {}, monthly: {}, types: {}, sum_rec: 0, sum_iss: 0, tx: [] });

    for (let i = hdrIdx + 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row) continue;
      const a = g(row, "date"), doc = g(row, "doc");
      const d = (a !== null && a !== undefined) ? makeDate(a, dayFirst) : null;

      if (!isEmpty(a) && d === null && isEmpty(doc)) {           // item header row
        const code = codeStr(a);
        if (!code) continue;
        cur = items[code];
        if (!cur) { cur = newItem(code, g(row, "name"), num(g(row, "bal"))); items[code] = cur; order.push(code); }
        continue;
      }

      if (d !== null) {
        const label = norm(doc);
        if (SUBTOTAL_ROWS.has(label) || label.endsWith("subtotal")) continue;
        if (!cur) continue;
        const dtype = isEmpty(doc) ? "?" : String(doc).trim().split(/\s+/)[0].toUpperCase();
        const rec = num(g(row, "rec")), iss = num(g(row, "iss"));
        const role = DOC_ROLE[dtype] || "auto";
        const dt = docTypes[dtype] || (docTypes[dtype] = { rows: 0, rec: 0, iss: 0 });
        dt.rows += 1; dt.rec += rec; dt.iss += iss;
        inc(years, d.y);
        if (!dmin || cmpDate(d, dmin) < 0) dmin = d;
        if (!dmax || cmpDate(d, dmax) > 0) dmax = d;
        txTotal += 1;
        cur.tx_count += 1;
        inc(cur.types, dtype);
        cur.sum_rec += rec; cur.sum_iss += iss;
        const u = g(row, "uom");
        if (!isEmpty(u)) inc(cur.uom, String(u).trim());
        if (dtype === "SO" && !isEmpty(g(row, "name"))) inc(cur.acct_names, String(g(row, "name")).trim());
        cur.tx.push({
          date: isoDate(d), y: d.y, m: d.m, seq: cur.tx.length + 1,
          type: dtype, doc: isEmpty(doc) ? "" : String(doc).trim(),
          whse: isEmpty(g(row, "whse")) ? "" : String(g(row, "whse")).trim(),
          acct: isEmpty(g(row, "name")) ? "" : String(g(row, "name")).trim(),
          rec, iss, uom: isEmpty(u) ? "" : String(u).trim(),
          balance: isEmpty(g(row, "bal")) ? null : num(g(row, "bal")), role,
        });
        const ym = cur.monthly[d.y] || (cur.monthly[d.y] = {});
        const m = ym[d.m] || (ym[d.m] = { actual: 0, incoming: 0, return: 0 });
        if (role === "actual") m.actual += iss;
        else if (role === "incoming") m.incoming += rec;
        else if (role === "return") m.return += iss;
        else if (role === "auto") { m.incoming += rec; m.actual += iss; }
        continue;
      }

      // closing / blank row: only the balance column may be filled
      if (cur && !cur.closing_set) {
        let othersEmpty = true;
        for (let c = 0; c < row.length; c++) if (c !== col.bal && !isEmpty(row[c])) { othersEmpty = false; break; }
        if (othersEmpty) { cur.closing = num(g(row, "bal")); cur.closing_set = true; }
      }
    }
    if (!order.length) throw new SapFormatError("Tidak ada blok item yang terbaca dari laporan.");

    for (const it of Object.values(items)) {
      if (it.closing_set && Math.abs(it.opening + it.sum_rec - it.sum_iss - it.closing) > 1e-6) balanceMismatch += 1;
    }
    let lastComplete = null;
    if (dmax) {
      if (dmax.d === daysInMonth(dmax.y, dmax.m)) lastComplete = [dmax.y, dmax.m];
      else if (dmax.m > 1) lastComplete = [dmax.y, dmax.m - 1];
      else lastComplete = [dmax.y - 1, 12];
    }
    return { items, order, doc_types: docTypes, years, date_min: dmin, date_max: dmax, last_complete: lastComplete, tx_total: txTotal, day_first: dayFirst, balance_mismatch: balanceMismatch };
  }

  // ---------------------------------------------------------------- categories per prefix
  /** masterItems: [{code, category}] from the app. Priority: app master > G/L account name > static map. */
  function deriveCategories(parsed, masterItems) {
    const appPref = {}, glPref = {};
    for (const it of masterItems || []) {
      if (!it.category) continue;
      const p = String(it.code).slice(0, 2);
      inc(appPref[p] || (appPref[p] = {}), it.category);
    }
    for (const it of Object.values(parsed.items)) {
      const p = it.code.slice(0, 2);
      for (const [name, n] of Object.entries(it.acct_names)) inc(glPref[p] || (glPref[p] = {}), name, n);
    }
    const out = {};
    for (const code of Object.keys(parsed.items)) {
      const p = code.slice(0, 2);
      if (out[p]) continue;
      if (appPref[p]) out[p] = counterTop(appPref[p]);
      else if (glPref[p]) {
        const raw = counterTop(glPref[p]);
        const tail = raw.split(" - ").pop().trim();
        out[p] = tail ? tail.toLowerCase().replace(/(^|\s)(\S)/g, (m0, s, c) => s + c.toUpperCase()) : (STATIC_CATEGORY[p] || "Lainnya");
      } else out[p] = STATIC_CATEGORY[p] || "Lainnya";
    }
    return out;
  }

  // ---------------------------------------------------------------- preview summary
  function summarize(parsed, masterItems) {
    const existing = new Set((masterItems || []).map((it) => String(it.code)));
    const cats = deriveCategories(parsed, masterItems);
    const perCat = {};
    let matched = 0, matchedMoving = 0, newMoving = 0, newAll = 0, stockOnly = 0;
    for (const [code, it] of Object.entries(parsed.items)) {
      const p = code.slice(0, 2);
      const b = perCat[p] || (perCat[p] = { prefix: p, name: cats[p], items: 0, moving: 0, matched: 0, new_moving: 0, new_all: 0 });
      b.items += 1;
      const moving = it.tx_count > 0;
      b.moving += moving ? 1 : 0;
      if (existing.has(code)) { matched += 1; b.matched += 1; matchedMoving += moving ? 1 : 0; }
      else { newAll += 1; b.new_all += 1; if (moving) { newMoving += 1; b.new_moving += 1; } }
      if (!moving && it.opening) stockOnly += 1;
    }
    const yearsSorted = Object.entries(parsed.years).sort((a, b) => b[1] - a[1]);
    const year = yearsSorted.length ? Number(yearsSorted[0][0]) : new Date().getFullYear();
    const monthsSet = new Set();
    for (const it of Object.values(parsed.items)) for (const m of Object.keys(it.monthly[year] || {})) monthsSet.add(Number(m));
    const lc = parsed.last_complete;
    const lastCompleteMonth = lc && lc[0] === year ? lc[1] : (lc && lc[0] > year ? 12 : 0);
    const docTypes = Object.entries(parsed.doc_types).sort((a, b) => b[1].rows - a[1].rows).map(([t, d]) => {
      const role = DOC_ROLE[t] || "auto";
      return { type: t, rows: d.rows, rec: d.rec, iss: d.iss, role, label: DOC_LABEL[t] || "Jenis dokumen tidak dikenal", role_label: ROLE_LABEL[role] };
    });
    return {
      format: "sap", year, years: Object.fromEntries(Object.entries(parsed.years)),
      date_min: isoDate(parsed.date_min), date_max: isoDate(parsed.date_max),
      last_complete_month: lastCompleteMonth, months_with_data: [...monthsSet].sort((a, b) => a - b),
      tx_total: parsed.tx_total, items_total: Object.keys(parsed.items).length,
      items_moving: Object.values(parsed.items).filter((it) => it.tx_count).length, items_stock_only: stockOnly,
      matched, matched_moving: matchedMoving, new_moving: newMoving, new_all: newAll,
      categories: Object.values(perCat).sort((a, b) => a.prefix.localeCompare(b.prefix)),
      doc_types: docTypes, balance_mismatch: parsed.balance_mismatch, day_first: parsed.day_first,
    };
  }

  // ---------------------------------------------------------------- build payload for apply_changes()
  /**
   * options: {year, from_month, to_month, scope: existing|moving|all, categories: [prefix]|null, set_opening}
   * masterItems: [{code, category, uom}] → returns {payload, stats}
   */
  function buildPayload(parsed, options, masterItems) {
    const { year, from_month: fromM = 1, to_month: toM = 12, scope = "existing", categories = null, set_opening: setOpening = true } = options;
    if (!(fromM >= 1 && fromM <= toM && toM <= 12)) throw new Error("Rentang bulan tidak valid");
    const cats = deriveCategories(parsed, masterItems);
    const existing = new Map((masterItems || []).map((it) => [String(it.code), it]));
    const allowed = categories && categories.length ? new Set(categories) : null;
    const st = { updated: 0, created: 0, skipped_not_in_master: 0, skipped_no_tx: 0, skipped_category: 0, opening_set: 0, cells: 0 };
    const items = [];
    for (const code of parsed.order) {
      const it = parsed.items[code];
      const prefix = code.slice(0, 2);
      const uom = Object.keys(it.uom).length ? counterTop(it.uom) : "";
      const entry = { code, cells: [] };
      if (existing.has(code)) {
        entry.create = false;
        if (uom) entry.fill_uom = uom;
        st.updated += 1;
      } else {
        if (scope === "existing") { st.skipped_not_in_master += 1; continue; }
        if (scope === "moving" && it.tx_count === 0) { st.skipped_no_tx += 1; continue; }
        if (allowed && !allowed.has(prefix)) { st.skipped_category += 1; continue; }
        entry.create = true;
        entry.fields = { category: cats[prefix] || "", description: it.name || code, uom };
        st.created += 1;
      }
      if (setOpening && fromM === 1) { entry.opening = it.opening; st.opening_set += 1; }
      const ym = it.monthly[year] || {};
      for (let m = fromM; m <= toM; m++) {
        const d = ym[m] || { actual: 0, incoming: 0, return: 0 };
        entry.cells.push({ month: m, actual: Math.round(d.actual * 1e6) / 1e6, incoming: Math.round((d.incoming - d.return) * 1e6) / 1e6 });
        st.cells += 2;
      }
      items.push(entry);
    }
    st.items_written = st.updated + st.created;
    st.from_month = fromM; st.to_month = toM; st.year = year;
    return { payload: { year, items }, stats: st };
  }

  /**
   * Transaction-level history for the items written by buildPayload (same options),
   * limited to year/from_month..to_month. Shape matches RPC import_transactions rows.
   */
  function buildTransactions(parsed, options, payload) {
    const { year, from_month: fromM = 1, to_month: toM = 12 } = options;
    const codes = new Set((payload && payload.items ? payload.items : []).map((e) => e.code));
    const rows = [];
    for (const code of codes) {
      const it = parsed.items[code];
      if (!it) continue;
      for (const t of it.tx) {
        if (t.y !== year || t.m < fromM || t.m > toM) continue;
        rows.push({ code, posting_date: t.date, seq: t.seq, doc_type: t.type, doc_no: t.doc, whse: t.whse, acct_name: t.acct, rec_qty: t.rec, iss_qty: t.iss, uom: t.uom, balance: t.balance, role: t.role });
      }
    }
    return { rows, codes: [...codes], year, from_month: fromM, to_month: toM };
  }

  window.FC = window.FC || {};
  window.FC.sap = { DOC_ROLE, DOC_LABEL, ROLE_LABEL, SapFormatError, detectFormat, isSapHeader, parsePostingList, deriveCategories, summarize, buildPayload, buildTransactions };
})();
