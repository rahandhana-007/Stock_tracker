/* Goods Issued Status / PR detail: never enters inventory calculations. */
(function () {
  "use strict";
  const text = v => v == null ? "" : String(v).trim();
  const number = v => v == null || v === "" ? null : typeof v === "number" ? v : Number(String(v).replace(/,/g, ""));
  const date = v => v instanceof Date ? `${String(v.getDate()).padStart(2,"0")}/${String(v.getMonth()+1).padStart(2,"0")}/${v.getFullYear()}` : text(v);
  function parse(rows, items) {
    if (text(rows[8]?.[4]) !== "Goods Issued Slip No" || text(rows[9]?.[9]) !== "Symbol" || text(rows[9]?.[15]) !== "Outstanding") throw new Error("Bukan format Goods Issued Status / PR Outstanding List yang dikenali.");
    const year = Number((text(rows[3]?.[0]).match(/\b20\d{2}\b/) || [])[0]);
    if (!year) throw new Error("Tahun laporan PR tidak ditemukan.");
    const byCode = new Map(items.map(it => [text(it.code), it.id]));
    const result = []; let unmatched = 0, invalid = 0;
    for (let i = 10; i < rows.length; i++) {
      const r = rows[i] || [], code = text(r[9]);
      if (!code || !text(r[4])) continue;
      const line = number(r[5]), qty = number(r[12]);
      if (!Number.isFinite(line) || !Number.isFinite(qty)) { invalid++; continue; }
      const item_id = byCode.get(code);
      if (!item_id) { unmatched++; continue; }
      result.push({ item_id, source_key: `goods-issued-status-${year}`, source_row: i+1, year,
        slip_no:text(r[4]), line_no:line, pr_date:date(r[6]), order_cost_center:text(r[0]), cost_center:text(r[1]),
        account_code:text(r[2]), activity_code:text(r[3]), requestor:text(r[20]),
        description:text(r[10]), specification:text(r[11]), budget_no:text(r[7]), project_no:text(r[8]),
        quantity:qty, uom:text(r[13]), amount:number(r[14]), outstanding_amount:number(r[15]),
        sap_ref:text(r[16]), sap_date:date(r[17]), sap_qty:number(r[18]), sap_amount:number(r[19]) });
    }
    return {rows:result,unmatched,invalid};
  }
  window.FC = window.FC || {}; window.FC.pr = {parse};
})();
