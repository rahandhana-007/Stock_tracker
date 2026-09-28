/* =====================================================================
   Excel I/O for the "Master RumpUp-Forecast" layout (port of excel_io.py)
   + workbook reading / format detection helpers.
   Reading uses SheetJS (window.XLSX), writing uses ExcelJS (window.ExcelJS).
   ===================================================================== */
(function () {
  "use strict";
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
  const MONTH_ALIASES = {
    jan: 1, januari: 1, january: 1, feb: 2, februari: 2, february: 2, mar: 3, maret: 3, march: 3, apr: 4, april: 4,
    may: 5, mei: 5, jun: 6, juni: 6, june: 6, jul: 7, juli: 7, july: 7, aug: 8, agu: 8, agustus: 8, august: 8, ags: 8,
    sep: 9, sept: 9, september: 9, oct: 10, okt: 10, oktober: 10, october: 10, nov: 11, november: 11, dec: 12, des: 12, desember: 12, december: 12,
  };
  const ROW_ALIASES = {
    forecast: "forecast", "act consume": "actual", actual: "actual", "actual consumption": "actual", "act. consume": "actual",
    "actual consume": "actual", "konsumsi aktual": "actual", incoming: "incoming", in: "incoming", penerimaan: "incoming",
    "end stock": "end_stock", "ending stock": "end_stock", "stock akhir": "end_stock", "stok akhir": "end_stock",
  };

  const norm = (v) => (v === null || v === undefined) ? "" : String(v).replace(/\s+/g, " ").trim().toLowerCase();
  function toNum(v) {
    if (v === null || v === undefined || v === "") return null;
    if (typeof v === "number") return v;
    const s = String(v).trim();
    if (s.startsWith("#")) return null;
    const n = Number(s.replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  function codeStr(v) {
    if (v === null || v === undefined) return "";
    if (typeof v === "number" && Number.isInteger(v)) return String(v);
    return String(v).trim();
  }
  const str = (v) => (v === null || v === undefined) ? "" : String(v).trim();

  // ---------------------------------------------------------------- workbook reading
  async function readWorkbook(file) {
    const buf = await file.arrayBuffer();
    return XLSX.read(buf, { type: "array", cellDates: true, dense: false });
  }
  function sheetRows(wb, name) {
    const ws = wb.Sheets[name];
    if (!ws) return [];
    return XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true, blankrows: true });
  }
  /** Pick the sheet to import: prefers a sheet whose name contains 'forecast'. Returns {format, sheet, rows}. */
  function detect(wb, preferred) {
    const names = wb.SheetNames;
    const cands = [];
    if (preferred && names.includes(preferred)) cands.push(preferred);
    for (const n of names) if (/forecast/i.test(n) && !/dashboard/i.test(n) && !cands.includes(n)) cands.push(n);
    for (const n of names) if (!cands.includes(n)) cands.push(n);
    for (const n of cands) {
      const rows = sheetRows(wb, n);
      const fmt = FC.sap.detectFormat(rows);
      if (fmt !== "unknown") return { format: fmt, sheet: n, rows };
    }
    return { format: "unknown", sheet: null, rows: [] };
  }

  // ---------------------------------------------------------------- parse master layout
  function parseRows(rows) {
    const maxRow = rows.length;
    const maxCol = rows.reduce((m, r) => Math.max(m, (r || []).length), 0);
    const cell = (r, c) => { const row = rows[r - 1]; return row && c - 1 < row.length ? row[c - 1] : null; };

    let headerRow = null;
    const col = {};
    for (let r = 1; r <= Math.min(maxRow, 30); r++) {
      const vals = {};
      for (let c = 1; c <= maxCol; c++) vals[c] = norm(cell(r, c));
      if (!Object.values(vals).some((v) => v === "activity")) continue;
      headerRow = r;
      for (const [cs, v] of Object.entries(vals)) {
        const c = Number(cs);
        if (!v) continue;
        if (v === "category") col.category = c;
        else if (["symbol", "item code", "code", "kode"].includes(v)) col.code = c;
        else if (v.startsWith("item desc") || v === "description") col.description = c;
        else if (v === "uom") col.uom = c;
        else if (v.startsWith("min")) col.min = c;
        else if (v.startsWith("max")) col.max = c;
        else if (v.startsWith("est lead") || v.startsWith("lead time")) col.lead = c;
        else if (v.startsWith("opening")) col.opening = c;
        else if (v === "activity") col.activity = c;
        else if (v === "user") col.user = c;
      }
      break;
    }
    if (headerRow === null || !col.activity) throw new Error("Header 'Activity' tidak ditemukan. Pastikan format sesuai template Master RumpUp-Forecast.");

    let monthCols = {};
    for (const r of [headerRow, headerRow + 1]) {
      const found = {};
      for (let c = col.activity + 1; c <= maxCol; c++) {
        const key = norm(cell(r, c)).replace(/\./g, "");
        if (MONTH_ALIASES[key] && !found[MONTH_ALIASES[key]]) found[MONTH_ALIASES[key]] = c;
      }
      if (Object.keys(found).length >= 12) { monthCols = found; break; }
    }
    if (Object.keys(monthCols).length < 12) throw new Error("Kolom bulan Jan–Des tidak ditemukan di bawah/di samping header.");

    const items = [];
    let current = null;
    for (let r = headerRow + 1; r <= maxRow; r++) {
      const activity = ROW_ALIASES[norm(cell(r, col.activity))];
      if (!activity) continue;
      if (activity === "forecast") {
        const code = col.code ? codeStr(cell(r, col.code)) : "";
        const desc = col.description ? str(cell(r, col.description)) : "";
        if (!code && !desc) { current = null; continue; }
        const lead = col.lead ? toNum(cell(r, col.lead)) : null;
        current = {
          code: code || desc.slice(0, 30),
          category: col.category ? str(cell(r, col.category)) : "",
          description: desc,
          uom: col.uom ? str(cell(r, col.uom)) : "",
          min_stock: col.min ? (toNum(cell(r, col.min)) || 0) : 0,
          max_stock: col.max ? (toNum(cell(r, col.max)) || 0) : 0,
          lead_time_days: lead !== null ? Math.trunc(lead) : null,
          user_dept: col.user ? str(cell(r, col.user)) : "",
          opening_stock: col.opening ? toNum(cell(r, col.opening)) : null,
          months: Array.from({ length: 12 }, () => ({ forecast: null, actual: null, incoming: null })),
          _end_stock: Array(12).fill(null),
        };
        items.push(current);
      }
      if (!current) continue;
      for (const [m, c] of Object.entries(monthCols)) {
        const val = toNum(cell(r, c));
        if (activity === "end_stock") current._end_stock[m - 1] = val;
        else current.months[m - 1][activity] = val;
      }
    }
    for (const it of items) {
      if (it.opening_stock === null) {
        const endJan = it._end_stock[0];
        if (endJan !== null) { const jan = it.months[0]; it.opening_stock = endJan - (jan.incoming || 0) + (jan.actual || 0); }
        else it.opening_stock = 0;
      }
      delete it._end_stock;
    }
    return items;
  }

  function summarize(parsed, masterItems) {
    const existing = new Set((masterItems || []).map((it) => String(it.code)));
    const matched = parsed.filter((it) => existing.has(it.code)).length;
    const months = new Set();
    let wf = 0, wa = 0, wi = 0;
    for (const it of parsed) {
      let f = false, a = false, i = false;
      it.months.forEach((m, idx) => {
        if (m.forecast !== null) { f = true; months.add(idx + 1); }
        if (m.actual !== null) { a = true; months.add(idx + 1); }
        if (m.incoming !== null) { i = true; months.add(idx + 1); }
      });
      wf += f ? 1 : 0; wa += a ? 1 : 0; wi += i ? 1 : 0;
    }
    const cats = {};
    for (const it of parsed) { const k = it.category || "—"; cats[k] = (cats[k] || 0) + 1; }
    return {
      format: "master", items_total: parsed.length, matched, new_all: parsed.length - matched,
      with_forecast: wf, with_actual: wa, with_incoming: wi, months_with_data: [...months].sort((a, b) => a - b),
      categories: Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, items: n })),
    };
  }

  /** Payload for apply_changes(): upsert = update master fields + all 12 months; replace = wipe year first. */
  function buildPayload(parsed, { year, mode = "upsert" }) {
    const items = parsed.map((it) => ({
      code: it.code, create: true, update_fields: true,
      fields: { category: it.category, description: it.description, uom: it.uom, min_stock: it.min_stock, max_stock: it.max_stock, lead_time_days: it.lead_time_days, user_dept: it.user_dept },
      opening: it.opening_stock || 0,
      cells: it.months.map((m, i) => ({ month: i + 1, forecast: m.forecast, actual: m.actual, incoming: m.incoming })),
    }));
    return { year, replace_year: mode === "replace", items };
  }

  // ---------------------------------------------------------------- export (ExcelJS)
  const colLetter = (n) => { let s = ""; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };
  const fill = (hex) => ({ type: "pattern", pattern: "solid", fgColor: { argb: "FF" + hex } });
  const THIN = { style: "thin", color: { argb: "FFBFBFBF" } };
  const BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN };
  const F = { head: fill("1F3864"), sub: fill("2F5496"), forecast: fill("FFF2CC"), actual: fill("FFFFFF"), incoming: fill("DDEBF7"), end: fill("EDEDED"), info: fill("F7F7F7") };
  const CENTER = { horizontal: "center", vertical: "middle", wrapText: true };
  const LEFT = { horizontal: "left", vertical: "middle", wrapText: true };
  const NUM = "#,##0.##";
  const fx = (f) => ({ formula: f });
  const pad2 = (n) => String(n).padStart(2, "0");

  /** items: computed items (with .calc). Returns a Blob. */
  async function exportWorkbook(items, year, company, title) {
    const wb = new ExcelJS.Workbook();
    wb.creator = "Master Forecast Consumption Plan";
    const ws = wb.addWorksheet("Master RumpUp-Forecast");
    const headers = ["Category", "Symbol", "Item Description", "UOM", "Min Stock", "Max Stock", "Est Lead Time After PO (Days)", "Opening Stock", "Activity"];
    const tail = ["Total / YTD", "Avg/Month", "Peak Month", "Peak Qty", "YTD Forecast", "Variance Qty", "Variance %", "Accuracy %", "Current Stock", "Status", "User"];
    const nHead = headers.length, cAct = nHead, cM1 = nHead + 1, cM12 = nHead + 12, cTotal = cM12 + 1;
    const [cAvg, cPeakM, cPeakQ, cYtdF, cVar, cVarP, cAcc, cCur, cStatus, cUser] = Array.from({ length: 10 }, (_, i) => cTotal + 1 + i);
    const lastCol = cUser;
    const L = colLetter;
    const now = new Date();

    ws.getCell("A1").value = company; ws.getCell("A1").font = { bold: true, size: 14 };
    ws.getCell("A2").value = `${title} (FY ${year})`; ws.getCell("A2").font = { bold: true, size: 12 };
    ws.getCell("A3").value = `Exported ${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
    ws.getCell("A3").font = { italic: true, color: { argb: "FF808080" } };

    const hr = 5;
    headers.forEach((h, i) => { ws.getCell(hr, i + 1).value = h; });
    ws.getCell(hr, cM1).value = year;
    MONTHS.forEach((m, i) => { ws.getCell(hr + 1, cM1 + i).value = m; });
    tail.forEach((h, i) => { ws.getCell(hr, cTotal + i).value = h; });
    for (const r of [hr, hr + 1]) for (let c = 1; c <= lastCol; c++) {
      const cell = ws.getCell(r, c);
      cell.fill = r === hr ? F.head : F.sub; cell.font = { bold: true, color: { argb: "FFFFFFFF" } }; cell.alignment = CENTER; cell.border = BORDER;
    }
    headers.forEach((_, i) => ws.mergeCells(hr, i + 1, hr + 1, i + 1));
    ws.mergeCells(hr, cM1, hr, cM12);
    tail.forEach((_, i) => ws.mergeCells(hr, cTotal + i, hr + 1, cTotal + i));
    ws.getRow(hr).height = 30;

    let r = hr + 2;
    const STATUS_TXT = { ok: "OK", below_min: "BELOW MIN", over_max: "OVER MAX", zero: "ZERO", none: "-" };
    for (const it of items) {
      const c = it.calc;
      const rf = r, ra = r + 1, ri = r + 2, re = r + 3;
      const info = [it.category, it.code, it.description, it.uom, it.min_stock, it.max_stock, it.lead_time_days, it.opening_stock];
      info.forEach((v, idx) => {
        const ci = idx + 1;
        for (let rr = rf; rr <= re; rr++) { const cell = ws.getCell(rr, ci); cell.fill = F.info; cell.border = BORDER; }
        const top = ws.getCell(rf, ci);
        top.value = v === undefined ? null : v;
        top.alignment = (ci === 1 || ci === 3) ? LEFT : CENTER;
        if (ci === 2) top.font = { bold: true };
        ws.mergeCells(rf, ci, re, ci);
      });

      const labels = [["Forecast", F.forecast], ["Act Consume", F.actual], ["Incoming", F.incoming], ["End Stock", F.end]];
      labels.forEach(([lab, fl], k) => {
        const lc = ws.getCell(r + k, cAct);
        lc.value = lab; lc.font = { bold: true }; lc.fill = fl; lc.border = BORDER;
        for (let i = 0; i < 12; i++) {
          const ci = cM1 + i, mc = ws.getCell(r + k, ci);
          if (lab === "Forecast") mc.value = it.months[i].forecast;
          else if (lab === "Act Consume") mc.value = it.months[i].actual;
          else if (lab === "Incoming") mc.value = it.months[i].incoming;
          else {
            const prev = i === 0 ? `${L(8)}${rf}` : `${L(ci - 1)}${re}`;
            mc.value = fx(`(${prev}+${L(ci)}${ri})-${L(ci)}${ra}`);
          }
          mc.fill = fl; mc.border = BORDER; mc.numFmt = NUM;
        }
        const tot = ws.getCell(r + k, cTotal);
        tot.value = lab === "End Stock" ? fx(`${L(cM12)}${re}`) : fx(`SUM(${L(cM1)}${r + k}:${L(cM12)}${r + k})`);
        tot.font = { bold: true }; tot.fill = fl; tot.border = BORDER; tot.numFmt = NUM;
      });

      const rngF = `${L(cM1)}${rf}:${L(cM12)}${rf}`, rngA = `${L(cM1)}${ra}:${L(cM12)}${ra}`;
      for (let ci = cAvg; ci <= cUser; ci++) for (let rr = rf; rr <= re; rr++) { const cell = ws.getCell(rr, ci); cell.border = BORDER; cell.fill = F.info; }
      ws.getCell(rf, cAvg).value = fx(`IFERROR(AVERAGE(${rngF}),"")`);
      ws.getCell(rf, cPeakM).value = fx(`IFERROR(INDEX($${L(cM1)}$${hr + 1}:$${L(cM12)}$${hr + 1},1,MATCH(MAX(${rngF}),${rngF},0)),"")`);
      ws.getCell(rf, cPeakQ).value = fx(`IFERROR(MAX(${rngF}),"")`);
      ws.getCell(rf, cYtdF).value = fx(`SUMPRODUCT(--ISNUMBER(${rngA}),${rngF})`);
      const both = `SUMPRODUCT(--ISNUMBER(${rngF}),--ISNUMBER(${rngA}))`;
      ws.getCell(rf, cVar).value = fx(`IF(${both}=0,"",SUMPRODUCT(--ISNUMBER(${rngF}),${rngA})-${L(cYtdF)}${rf})`);
      ws.getCell(rf, cVarP).value = fx(`IFERROR(${L(cVar)}${rf}/${L(cYtdF)}${rf},"")`);
      ws.getCell(rf, cAcc).value = fx(`IFERROR(MAX(0,1-ABS(${L(cVar)}${rf})/${L(cYtdF)}${rf}),"")`);
      ws.getCell(rf, cCur).value = c.current_stock;
      ws.getCell(rf, cStatus).value = STATUS_TXT[c.status];
      ws.getCell(rf, cUser).value = it.user_dept;
      for (let ci = cAvg; ci <= cUser; ci++) ws.getCell(rf, ci).alignment = CENTER;
      for (const ci of [cAvg, cPeakQ, cYtdF, cVar, cCur]) ws.getCell(rf, ci).numFmt = NUM;
      ws.getCell(rf, cVarP).numFmt = "0.0%"; ws.getCell(rf, cAcc).numFmt = "0.0%";
      if (c.status === "below_min" || c.status === "zero") ws.getCell(rf, cStatus).font = { bold: true, color: { argb: "FFC00000" } };
      else if (c.status === "over_max") ws.getCell(rf, cStatus).font = { bold: true, color: { argb: "FFC65911" } };
      for (let ci = cAvg; ci <= cUser; ci++) ws.mergeCells(rf, ci, re, ci);
      r += 5;
    }

    const widths = { 1: 16, 2: 9, 3: 42, 4: 7, 5: 10, 6: 10, 7: 11, 8: 10, 9: 13 };
    for (const [ci, w] of Object.entries(widths)) ws.getColumn(Number(ci)).width = w;
    for (let ci = cM1; ci <= cM12; ci++) ws.getColumn(ci).width = 9;
    for (let ci = cTotal; ci <= lastCol; ci++) ws.getColumn(ci).width = 12;
    ws.views = [{ state: "frozen", xSplit: cM1 - 1, ySplit: hr + 1 }];
    ws.autoFilter = { from: { row: hr + 1, column: 1 }, to: { row: Math.max(hr + 2, r - 1), column: lastCol } };

    // ---- dashboard sheet
    const dash = FC.calc.buildDashboard(items, year);
    const ds = wb.addWorksheet("Summary_Dashboard");
    ds.getCell("A1").value = `FORECAST vs ACTUAL DASHBOARD – FY ${year}`; ds.getCell("A1").font = { bold: true, size: 13 };
    const k = dash.kpi;
    const rowsK = [["Total Items", k.total_items], ["Items with Forecast", k.with_forecast], ["Items with Actual", k.with_actual], ["Below Min", k.below_min], ["Over Max", k.over_max], ["Zero Stock", k.zero_stock], ["Avg Accuracy (YTD)", k.avg_accuracy]];
    rowsK.forEach(([a, b], i) => {
      const rr = 3 + i;
      ds.getCell(rr, 1).value = a; ds.getCell(rr, 1).font = { bold: true }; ds.getCell(rr, 2).value = b;
      if (a.startsWith("Avg Accuracy")) ds.getCell(rr, 2).numFmt = "0.0%";
    });
    let rr = 3 + rowsK.length + 1;
    ds.getCell(rr, 1).value = "Category"; ds.getCell(rr, 1).font = { bold: true };
    ["Items", "With Forecast", "With Actual", "Below Min", "Over Max", "Avg Accuracy"].forEach((h, j) => { ds.getCell(rr, j + 2).value = h; ds.getCell(rr, j + 2).font = { bold: true }; });
    for (const b of dash.by_category) {
      rr += 1;
      ds.getCell(rr, 1).value = b.name;
      ["items", "with_forecast", "with_actual", "below_min", "over_max", "avg_accuracy"].forEach((key, j) => { ds.getCell(rr, j + 2).value = b[key]; });
      ds.getCell(rr, 7).numFmt = "0.0%";
    }
    rr += 2;
    ds.getCell(rr, 1).value = "Need Order (below min)"; ds.getCell(rr, 1).font = { bold: true };
    rr += 1;
    ["Code", "Description", "UOM", "Current", "Min", "Max", "Suggested Order", "Lead Time", "User"].forEach((h, j) => { ds.getCell(rr, j + 1).value = h; ds.getCell(rr, j + 1).font = { bold: true }; });
    for (const b of dash.need_order) {
      rr += 1;
      ["code", "description", "uom", "current_stock", "min_stock", "max_stock", "suggested_order", "lead_time_days", "user_dept"].forEach((key, j) => { ds.getCell(rr, j + 1).value = b[key] === undefined ? null : b[key]; });
    }
    ds.getColumn(1).width = 22; ds.getColumn(2).width = 40;

    const buf = await wb.xlsx.writeBuffer();
    return new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  }

  async function templateWorkbook() {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Master RumpUp-Forecast");
    const headers = ["Category", "Symbol", "Item Description", "UOM", "Min Stock", "Max Stock", "Est Lead Time After PO (Days)", "Opening Stock", "Activity", ...MONTHS, "User"];
    ws.getRow(5).values = headers;
    ws.getRow(6).values = ["Chemical", "15001", "AMMONIA GAS NH-3", "Kgs", 3840, 5760, 3, 4260, "Forecast", ...Array(12).fill(3840), "FSD"];
    ws.getRow(7).values = [...Array(8).fill(null), "Act Consume"];
    ws.getRow(8).values = [...Array(8).fill(null), "Incoming"];
    ws.getRow(9).values = [...Array(8).fill(null), "End Stock"];
    ws.getRow(5).font = { bold: true };
    const buf = await wb.xlsx.writeBuffer();
    return new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  }

  window.FC = window.FC || {};
  window.FC.master = { MONTHS, readWorkbook, sheetRows, detect, parseRows, summarize, buildPayload, exportWorkbook, templateWorkbook };
})();
