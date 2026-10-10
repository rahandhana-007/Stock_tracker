/* =====================================================================
   Master Forecast Consumption Plan – frontend (Netlify static + Supabase)
   Data access lives in js/data.js, calculations in js/calc.js,
   Excel parsing/writing in js/sap.js + js/master.js.
   ===================================================================== */
(() => {
  "use strict";

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
  const FIELDS = ["forecast", "actual", "incoming"];             // editable rows, in order
  const ROW_LABEL = { forecast: "Forecast", actual: "Actual Consumption", incoming: "Incoming", end: "End Stock" };
  const STATUS_LABEL = { ok: "Normal", below_min: "Di bawah Min", over_max: "Di atas Max", zero: "Stok nol / minus", none: "Belum ada data" };

  const state = {
    meta: null,
    year: null,
    items: [],
    byId: new Map(),
    filters: { q: "", category: "", user: "", status: "" },
    view: "grid",
    today: new Date(),
  };

  // ------------------------------------------------------------------ utils
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const nf = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
  const nf1 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
  const fmt = (v) => (v === null || v === undefined || Number.isNaN(v)) ? "–" : nf.format(v);
  const fmtIn = (v) => (v === null || v === undefined) ? "" : String(+(+v).toFixed(4));   // raw string for editing
  const fmtDisp = (raw) => (raw === "" || raw === null || raw === undefined) ? "" : nf.format(+raw); // formatted when idle
  const pct = (v) => (v === null || v === undefined) ? "–" : (v * 100).toFixed(1) + "%";
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function parseNum(str) {
    const s = String(str ?? "").trim().replace(/\s/g, "");
    if (s === "") return null;
    const n = Number(s.replace(/,/g, ""));
    if (!Number.isFinite(n)) throw new Error("Bukan angka: " + str);
    return n;
  }

  let toastTimer;
  function toast(msg, kind = "") {
    const el = $("#toast");
    el.textContent = msg;
    el.className = "toast show " + kind;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.className = "toast"), 2600);
  }

  const data = () => window.FC.data;

  function confirmDlg(title, text, okLabel = "Ya, hapus") {
    return new Promise((resolve) => {
      const dlg = $("#confirmDialog");
      $("#confirmTitle").textContent = title;
      $("#confirmText").textContent = text;
      $("#confirmOk").textContent = okLabel;
      const onClose = () => { dlg.removeEventListener("close", onClose); resolve(dlg.returnValue === "ok"); };
      dlg.addEventListener("close", onClose);
      dlg.returnValue = "";
      $("#confirmOk").type = "button";
      $("#confirmOk").onclick = (e) => { e.preventDefault(); dlg.close("ok"); };
      dlg.showModal();
    });
  }

  // Form submission is blocked inside sandboxed iframes (preview panels without allow-forms),
  // so every dialog button is bound directly and never relies on the submit event.
  function bindForm(sel, handler) {
    const form = $(sel);
    const run = async (e) => {
      if (e && e.preventDefault) e.preventDefault();
      if (form.reportValidity && !form.reportValidity()) return;
      await handler({ preventDefault() {}, target: form, currentTarget: form });
    };
    form.addEventListener("submit", run);
    form.querySelectorAll('button[type="submit"], button[data-submit]').forEach((btn) => { btn.type = "button"; btn.addEventListener("click", run); });
    form.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.isComposing) return;
      if (e.target.matches("textarea, button, input[type=file], input[type=checkbox], input[type=radio]")) return;
      e.preventDefault(); run();
    });
    return run;
  }
  const IN_FRAME = window.self !== window.top;
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename; a.rel = "noopener";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    if (IN_FRAME) setTimeout(() => toast("Jika unduhan tidak muncul, buka aplikasi di tab browser baru (panel pratinjau membatasi unduhan)."), 800);
  }

  // ------------------------------------------------------------------ meta / load
  async function loadMeta() {
    state.meta = await data().meta(state.items.length ? state.items : null);
    state.today = new Date(state.meta.today + "T00:00:00");
    const prevUntil = state.sapUntil ? state.sapUntil.iso : null;
    state.sapUntil = sapUntilFor(state.year);
    if ((state.sapUntil ? state.sapUntil.iso : null) !== prevUntil) {
      // bulan parsial: tampil di grid, ikut End Stock, tapi dikecualikan dari variance/akurasi
      FC.calc.options.partialMonth = state.sapUntil && state.sapUntil.partial ? state.sapUntil.month : null;
      state.items.forEach((it) => FC.calc.computeItem(it));
      if (state.items.length) renderGrid();
    }
    if (state.year === null) {
      const saved = +localStorage.getItem("fc.year");
      state.year = state.meta.years.includes(saved) ? saved : state.meta.default_year;
    }
    $("#appTitle").textContent = titleCase(state.meta.title);
    $("#appCompany").textContent = state.meta.company;
    $("#loginTitle").textContent = titleCase(state.meta.title);
    $("#loginCompany").textContent = state.meta.company;
    localStorage.setItem("fc.title", state.meta.title);
    localStorage.setItem("fc.company", state.meta.company);
    document.title = `${titleCase(state.meta.title)} – FY ${state.year}`;

    const ys = $("#yearSelect");
    const years = new Set(state.meta.years);
    years.add(state.year);
    ys.innerHTML = [...years].sort().map((y) => `<option value="${y}" ${y === state.year ? "selected" : ""}>${y}</option>`).join("")
      + `<option value="__new">+ Tahun baru…</option>`;

    fillSelect($("#fCategory"), state.meta.categories, "Semua kategori");
    fillSelect($("#fUser"), state.meta.users, "Semua user");
    $("#dlCategory").innerHTML = state.meta.categories.map((c) => `<option value="${esc(c)}">`).join("");
    $("#dlUser").innerHTML = state.meta.users.map((c) => `<option value="${esc(c)}">`).join("");
    $("#dlUom").innerHTML = state.meta.uoms.map((c) => `<option value="${esc(c)}">`).join("");
  }

  function titleCase(s) {
    return String(s || "").toLowerCase().replace(/(^|\s|[–-])(\p{L})/gu, (m, p, c) => p + c.toUpperCase()).replace(/\bpt\b/gi, "PT");
  }

  function fillSelect(sel, values, placeholder) {
    const cur = sel.value;
    sel.innerHTML = `<option value="">${placeholder}</option>` + values.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join("");
    if (values.includes(cur)) sel.value = cur;
  }

  async function loadItems() {
    state.items = await data().items(state.year);
    state.byId = new Map(state.items.map((it) => [it.id, it]));
    renderGrid();
  }

  /** Load items first (meta derives categories/users from them), then meta. */
  async function reload() {
    if (state.year === null) {
      const saved = +localStorage.getItem("fc.year");
      state.year = saved || Number(window.FC_CONFIG && window.FC_CONFIG.DEFAULT_YEAR) || new Date().getFullYear();
    }
    await loadItems();
    await loadMeta();
    if (state.view === "dash") renderDashboard();
  }

  // ------------------------------------------------------------------ filtering
  function matches(it) {
    const f = state.filters;
    if (f.category && it.category !== f.category) return false;
    if (f.user && it.user_dept !== f.user) return false;
    if (f.status) {
      const s = it.calc.status;
      if (f.status === "alert" && !["below_min", "over_max", "zero"].includes(s)) return false;
      else if (f.status === "no_forecast" && it.calc.has_forecast) return false;
      else if (!["alert", "no_forecast"].includes(f.status) && s !== f.status) return false;
    }
    if (f.q) {
      const q = f.q.toLowerCase();
      if (!(`${it.code} ${it.description} ${it.category} ${it.user_dept} ${it.uom}`.toLowerCase().includes(q))) return false;
    }
    return true;
  }

  // ------------------------------------------------------------------ grid rendering
  function currentMonthIdx() {
    return state.today.getFullYear() === state.year ? state.today.getMonth() + 1 : 0;
  }

  /** {month, day, iso, partial} bila ada catatan batas data SAP untuk tahun tsb (settings.sap_until_<year>). */
  function sapUntilFor(year) {
    const iso = state.meta && state.meta.settings ? state.meta.settings[`sap_until_${year}`] : null;
    if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
    const [y, m, d] = iso.split("-").map(Number);
    if (y !== year) return null;
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return { month: m, day: d, iso, partial: d < lastDay };
  }
  /** Label "s/d Agu" atau "s/d 4 Sep" untuk bulan data terakhir suatu item. */
  function uptoLabel(lastDataMonth) {
    if (!lastDataMonth) return "";
    const u = state.sapUntil;
    if (u && u.partial && u.month === lastDataMonth) return `s/d ${u.day} ${MONTHS[lastDataMonth - 1]}`;
    return `s/d ${MONTHS[lastDataMonth - 1]}`;
  }

  function renderGrid() {
    const table = $("#grid");
    $$("tbody", table).forEach((tb) => tb.remove());
    const cur = currentMonthIdx();
    const u = state.sapUntil;
    $$("thead th.c-m", table).forEach((th) => {
      const m = +th.dataset.m;
      th.classList.toggle("cur", m === cur);
      const partial = !!(u && u.partial && u.month === m);
      th.classList.toggle("partial", partial);
      th.innerHTML = partial ? `${MONTHS[m - 1]}<small class="partial-tag" title="Data SAP baru sampai ${u.day} ${MONTHS[m - 1]} ${state.year} (bulan belum tutup)">s/d ${u.day}</small>` : MONTHS[m - 1];
    });

    const visible = state.items.filter(matches);
    const frag = document.createDocumentFragment();
    for (const it of visible) frag.appendChild(buildItemBlock(it, cur));
    table.appendChild(frag);

    $("#emptyState").hidden = visible.length > 0;
    const alerts = visible.filter((it) => ["below_min", "zero"].includes(it.calc.status)).length;
    const over = visible.filter((it) => it.calc.status === "over_max").length;
    $("#countInfo").textContent = `${visible.length} / ${state.items.length} item` + (alerts ? ` · ${alerts} di bawah min` : "") + (over ? ` · ${over} di atas max` : "");
    const f = state.filters;
    $("#btnClearFilter").hidden = !(f.q || f.category || f.user || f.status);
  }

  function buildItemBlock(it, cur) {
    const tb = document.createElement("tbody");
    tb.className = "item";
    tb.dataset.id = it.id;
    tb.dataset.status = it.calc.status;

    const monthCells = (field) => MONTHS.map((_, i) => {
      const m = i + 1;
      const v = it.months[i][field];
      return `<td class="c-m ${m === cur ? "cur" : ""}"><input class="cell" type="text" inputmode="decimal" autocomplete="off"
        data-id="${it.id}" data-f="${field}" data-m="${m}" value="${fmtDisp(fmtIn(v))}" data-raw="${fmtIn(v)}" placeholder="·" title="${ROW_LABEL[field]} ${MONTHS[i]}"></td>`;
    }).join("");

    const endCells = MONTHS.map((_, i) => `<td class="c-m end ${i + 1 === cur ? "cur" : ""}" data-m="${i + 1}"></td>`).join("");

    tb.innerHTML = `
      <tr class="r-forecast">
        <td class="c-item" rowspan="4">${itemInfoHTML(it)}</td>
        <td class="c-label">${ROW_LABEL.forecast}</td>${monthCells("forecast")}
        <td class="c-total t-forecast" title="Total forecast setahun (FY)"></td>
        <td class="c-kpi" rowspan="4"></td>
      </tr>
      <tr class="r-actual"><td class="c-label clickable" data-tx="out" data-id="${it.id}" title="Lihat histori barang keluar (SAP)">${ROW_LABEL.actual}</td>${monthCells("actual")}<td class="c-total t-actual" title="Total actual (YTD)"></td></tr>
      <tr class="r-incoming"><td class="c-label clickable" data-tx="in" data-id="${it.id}" title="Lihat histori barang masuk (SAP)">${ROW_LABEL.incoming}</td>${monthCells("incoming")}<td class="c-total t-incoming" title="Total incoming"></td></tr>
      <tr class="r-end"><td class="c-label">${ROW_LABEL.end}</td>${endCells}<td class="c-total t-end" title="End Stock Desember"></td></tr>`;
    updateComputed(tb, it);
    return tb;
  }

  function itemInfoHTML(it) {
    const lt = it.lead_time_days === null || it.lead_time_days === undefined ? "–" : `${it.lead_time_days} hr`;
    return `
      <div class="item-head"><span class="code">${esc(it.code)}</span>${it.category ? `<span class="badge cat">${esc(it.category)}</span>` : ""}</div>
      <div class="desc" title="${esc(it.description)}">${esc(it.description)}</div>
      <div class="meta">
        <span>UOM <b>${esc(it.uom || "–")}</b></span>
        <span>Min <b>${fmt(it.min_stock)}</b></span>
        <span>Max <b>${fmt(it.max_stock)}</b></span>
        <span>LT <b>${lt}</b></span>
        <span>User <b>${esc(it.user_dept || "–")}</b></span>
      </div>
      <div class="opening">Stok awal Jan
        <input class="opening-input" type="text" inputmode="decimal" data-id="${it.id}" value="${fmtDisp(fmtIn(it.opening_stock))}" data-raw="${fmtIn(it.opening_stock)}" title="Stok awal 1 Januari ${state.year}">
        <span>${esc(it.uom || "")}</span>
      </div>
      <div class="item-actions">
        <button class="link" data-act="edit" data-id="${it.id}">Edit</button>
        <button class="link danger" data-act="delete" data-id="${it.id}">Hapus</button>
        <button class="link hist" data-act="history" data-id="${it.id}" title="Buka riwayat transaksi dan detail pemakaian" aria-label="Buka histori item ${esc(it.code)}"><svg viewBox="0 0 20 20" width="12" height="12" aria-hidden="true"><path d="M3 9a7 7 0 1 1 1.8 5M3 4v5h5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 5.5V10l3 1.8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg><span>Histori</span></button>
      </div>
      <div class="stock-alert" role="alert" hidden>
        <svg viewBox="0 0 20 20" width="13" height="13" aria-hidden="true"><path d="M10 2.5l8 14H2l8-14z" fill="currentColor"/><path d="M10 8v4.2M10 14.3v.2" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/></svg>
        <span>Stok Di Bawah Batas Minimal</span>
      </div>`;
  }

  /** Alert in the item column when the current End Stock is below the item's Min stock. */
  function updateStockAlert(tb, it) {
    const c = it.calc, el = $(".stock-alert", tb);
    if (!el) return;
    const below = c.status !== "none" && c.current_stock !== null && c.current_stock < Number(it.min_stock || 0);
    el.hidden = !below;
    if (below) el.title = `End Stock ${fmt(c.current_stock)} ${it.uom || ""} < Min ${fmt(it.min_stock)} ${it.uom || ""} (${uptoLabel(c.last_data_month || 1)})`;
  }

  /** Update computed cells (end stock, totals, KPI) of one item block without touching inputs. */
  function updateComputed(tb, it) {
    const c = it.calc;
    tb.dataset.status = c.status;
    $$("td.end", tb).forEach((td, i) => {
      const ms = c.month_status[i];
      td.textContent = fmt(c.end_stock[i]);
      td.className = `c-m end ${td.classList.contains("cur") ? "cur" : ""} ${ms.status} ${ms.future ? "future" : ""}`;
      td.title = ms.future ? "Belum ada data bulan ini – stok dibawa dari bulan sebelumnya" : "";
    });
    $(".t-forecast", tb).textContent = fmt(c.fy_forecast);
    $(".t-actual", tb).textContent = fmt(c.ytd_actual);
    $(".t-incoming", tb).textContent = fmt(c.total_incoming);
    $(".t-end", tb).textContent = fmt(c.end_stock[11]);
    $(".c-kpi", tb).innerHTML = kpiHTML(it);
    updateStockAlert(tb, it);
  }

  function kpiHTML(it) {
    const c = it.calc;
    const uom = it.uom || "";
    const accCls = c.accuracy === null ? "" : c.accuracy >= 0.8 ? "" : c.accuracy >= 0.5 ? "mid" : "low";
    const varCls = c.variance === null ? "" : c.variance > 0 ? "neg" : "";
    const upto = c.last_data_month ? `<small class="muted">(${uptoLabel(c.last_data_month)})</small>` : "";
    return `
      <div class="status-badge ${c.status}" title="${STATUS_LABEL[c.status]}">${STATUS_LABEL[c.status]}</div>
      <dl class="kpi-list">
        <dt>Stok saat ini</dt><dd>${fmt(c.current_stock)} ${upto}</dd>
        <dt title="Rata-rata forecast per bulan">Avg/bln</dt><dd>${fmt(c.avg_forecast)}</dd>
        <dt>Peak</dt><dd>${c.peak_month ? `${MONTHS[c.peak_month - 1]} · ${fmt(c.peak_qty)}` : "–"}</dd>
        <dt title="Forecast pada ${c.months_compared} bulan yang sudah punya forecast & actual${c.partial_month ? ` (${MONTHS[c.partial_month - 1]} parsial tidak dihitung)` : ""}">Fcst YTD${c.partial_month ? `<small class="muted"> s/d ${MONTHS[c.partial_month - 2] || "–"}</small>` : ""}</dt><dd>${fmt(c.ytd_forecast)}</dd>
        <dt title="Actual − Forecast (${c.months_compared} bulan dibandingkan${c.partial_month ? `, ${MONTHS[c.partial_month - 1]} parsial tidak dihitung` : ""})">Var YTD</dt><dd class="${varCls}">${c.variance === null ? "–" : `${c.variance > 0 ? "+" : ""}${fmt(c.variance)} <small>(${pct(c.variance_pct)})</small>`}</dd>
        <dt>Akurasi</dt><dd>${c.accuracy === null ? "–" : `<span class="acc-bar ${accCls}"><i style="width:${Math.round(c.accuracy * 100)}%"></i></span>${pct(c.accuracy)}`}</dd>
        ${c.months_cover !== null ? `<dt>Cover</dt><dd>${nf1.format(c.months_cover)} bln</dd>` : ""}
        ${c.suggested_order > 0 ? `<dt>Saran order</dt><dd class="order">${fmt(c.suggested_order)} ${esc(uom)}</dd>` : ""}
      </dl>`;
  }

  // ------------------------------------------------------------------ cell editing
  function inputKey(el) { return `${el.dataset.id}|${el.dataset.f}|${el.dataset.m}`; }

  /** Refresh the visible text of an input from its raw value (formatted when not focused). */
  function refreshInput(input) {
    input.value = document.activeElement === input ? input.dataset.raw : fmtDisp(input.dataset.raw);
  }

  async function commitCell(input) {
    let value;
    try { value = parseNum(input.value); } catch (e) {
      toast(e.message, "err"); input.classList.add("error"); refreshInput(input); return;
    }
    const raw = fmtIn(value);
    input.classList.remove("error");
    if (raw === input.dataset.raw) return;
    const prevRaw = input.dataset.raw;
    input.dataset.raw = raw;            // optimistic – focusout will show the formatted value
    input.classList.add("saving");
    const id = +input.dataset.id, field = input.dataset.f, month = +input.dataset.m;
    try {
      const it = await data().setCell(id, state.byId.get(id).code, state.year, month, field, value);
      applyItem(it);
      input.classList.remove("saving");
      input.classList.add("saved");
      setTimeout(() => input.classList.remove("saved"), 800);
    } catch (e) {
      input.dataset.raw = prevRaw;
      refreshInput(input);
      input.classList.remove("saving");
      input.classList.add("error");
      toast("Gagal menyimpan: " + e.message, "err");
    }
  }

  async function commitOpening(input) {
    let value;
    try { value = parseNum(input.value) ?? 0; } catch (e) { toast(e.message, "err"); refreshInput(input); return; }
    const raw = fmtIn(value);
    if (raw === input.dataset.raw) { refreshInput(input); return; }
    const prevRaw = input.dataset.raw;
    input.dataset.raw = raw;
    try {
      const it = await data().setOpening(+input.dataset.id, state.year, value);
      applyItem(it);
      toast("Stok awal disimpan", "ok");
    } catch (e) { input.dataset.raw = prevRaw; refreshInput(input); toast("Gagal: " + e.message, "err"); }
  }

  /** Merge server item into state and refresh computed cells of its block. */
  function applyItem(it) {
    state.byId.set(it.id, it);
    const idx = state.items.findIndex((x) => x.id === it.id);
    if (idx >= 0) state.items[idx] = it; else state.items.push(it);
    const tb = $(`tbody.item[data-id="${it.id}"]`);
    if (tb) updateComputed(tb, it);
  }

  /** Sync input values of a block from state (after paste / bulk update). */
  function syncInputs(tb, it) {
    $$("input.cell", tb).forEach((inp) => {
      inp.dataset.raw = fmtIn(it.months[+inp.dataset.m - 1][inp.dataset.f]);
      inp.classList.remove("error");
      refreshInput(inp);
    });
  }

  function focusCell(id, field, month) {
    const el = $(`input.cell[data-id="${id}"][data-f="${field}"][data-m="${month}"]`);
    if (el) { el.focus(); el.select(); }
    return !!el;
  }

  function moveVertical(input, dir) {
    const id = +input.dataset.id, m = +input.dataset.m;
    let fi = FIELDS.indexOf(input.dataset.f) + dir;
    let tb = input.closest("tbody.item");
    if (fi < 0) { tb = tb.previousElementSibling; fi = FIELDS.length - 1; }
    if (fi >= FIELDS.length) { tb = tb.nextElementSibling; fi = 0; }
    if (!tb || !tb.classList.contains("item")) return;
    focusCell(+tb.dataset.id, FIELDS[fi], m) || focusCell(id, input.dataset.f, m);
  }

  function moveHorizontal(input, dir) {
    const m = +input.dataset.m + dir;
    if (m < 1 || m > 12) return false;
    return focusCell(+input.dataset.id, input.dataset.f, m);
  }

  async function handlePaste(input, text) {
    const rows = text.replace(/\r/g, "").split("\n").filter((r, i, arr) => !(i === arr.length - 1 && r === ""));
    const grid = rows.map((r) => r.split("\t"));
    if (grid.length === 1 && grid[0].length === 1) return false; // plain single value → default paste
    const id = +input.dataset.id, startM = +input.dataset.m;
    let fi = FIELDS.indexOf(input.dataset.f);
    const tb = input.closest("tbody.item");
    try {
      let it = null;
      for (const cells of grid) {
        if (fi >= FIELDS.length) break;
        const values = cells.slice(0, 13 - startM).map((s) => parseNum(s));
        it = await data().setRow(id, state.byId.get(id).code, state.year, FIELDS[fi], startM, values);
        fi++;
      }
      if (it) { applyItem(it); syncInputs(tb, it); }
      toast(`Tempel ${grid.length} baris × ${grid[0].length} kolom berhasil`, "ok");
    } catch (e) { toast("Tempel gagal: " + e.message, "err"); }
    return true;
  }

  function bindGridEvents() {
    const wrap = $("#gridWrap");

    wrap.addEventListener("change", (e) => {
      const t = e.target;
      if (t.classList.contains("cell")) commitCell(t);
      else if (t.classList.contains("opening-input")) commitOpening(t);
    });

    const isEditable = (el) => el.classList.contains("cell") || el.classList.contains("opening-input");
    wrap.addEventListener("focusin", (e) => { if (isEditable(e.target)) { e.target.value = e.target.dataset.raw; e.target.select(); } });
    wrap.addEventListener("focusout", (e) => { if (isEditable(e.target)) e.target.value = fmtDisp(e.target.dataset.raw); });

    wrap.addEventListener("keydown", (e) => {
      const t = e.target;
      if (!t.classList.contains("cell")) return;
      if (e.key === "Enter" || e.key === "ArrowDown") { e.preventDefault(); t.blur(); moveVertical(t, 1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); t.blur(); moveVertical(t, -1); }
      else if (e.key === "Escape") { t.value = t.dataset.raw; t.classList.remove("error"); t.blur(); }
      else if (e.key === "ArrowLeft" && t.selectionStart === 0 && t.selectionEnd === 0) { if (moveHorizontal(t, -1)) e.preventDefault(); }
      else if (e.key === "ArrowRight" && t.selectionStart === t.value.length && t.selectionEnd === t.value.length) { if (moveHorizontal(t, 1)) e.preventDefault(); }
    });

    wrap.addEventListener("paste", (e) => {
      const t = e.target;
      if (!t.classList.contains("cell")) return;
      const text = (e.clipboardData || window.clipboardData).getData("text");
      if (/[\t\n]/.test(text.trim())) { e.preventDefault(); handlePaste(t, text); }
    });

    wrap.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-act]");
      if (!btn) return;
      const it = state.byId.get(+btn.dataset.id);
      if (!it) return;
      if (btn.dataset.act === "edit") openItemDialog(it);
      if (btn.dataset.act === "delete") deleteItem(it);
      if (btn.dataset.act === "history") openTxDialog(it, { role: "" });
    });
    wrap.addEventListener("click", (e) => {
      const td = e.target.closest("td.c-label[data-tx]");
      if (!td) return;
      const it = state.byId.get(+td.dataset.id);
      if (it) openTxDialog(it, { role: td.dataset.tx });
    });
  }

  // ------------------------------------------------------------------ item dialog
  function openItemDialog(it = null) {
    const dlg = $("#itemDialog"), form = $("#itemForm");
    form.reset();
    $("#itemFormError").hidden = true;
    $("#itemDialogTitle").textContent = it ? `Edit Item ${it.code}` : "Item Baru";
    $("#btnDeleteItem").hidden = !it;
    $("#openingYearLbl").textContent = `(FY ${state.year})`;
    form.dataset.id = it ? it.id : "";
    if (it) {
      for (const k of ["code", "category", "description", "uom", "user_dept", "min_stock", "max_stock", "lead_time_days", "opening_stock"]) {
        form.elements[k].value = it[k] ?? "";
      }
    }
    dlg.showModal();
    setTimeout(() => form.elements[it ? "description" : "code"].focus(), 30);
  }

  async function submitItemForm(e) {
    e.preventDefault();
    const form = $("#itemForm");
    const fd = new FormData(form);
    const body = {
      code: fd.get("code").trim(), category: fd.get("category").trim(), description: fd.get("description").trim(),
      uom: fd.get("uom").trim(), user_dept: fd.get("user_dept").trim(),
      min_stock: +fd.get("min_stock") || 0, max_stock: +fd.get("max_stock") || 0,
      lead_time_days: fd.get("lead_time_days") === "" ? null : +fd.get("lead_time_days"),
      opening_stock: fd.get("opening_stock") === "" ? 0 : +fd.get("opening_stock"),
    };
    if (body.max_stock && body.min_stock > body.max_stock) { showFormError("#itemFormError", "Min Stock tidak boleh lebih besar dari Max Stock"); return; }
    const id = form.dataset.id;
    $("#btnSaveItem").disabled = true;
    try {
      const it = id ? await data().updateItem(+id, body, state.year) : await data().createItem(body, state.year);
      $("#itemDialog").close();
      await loadItems();
      await loadMeta();
      toast(id ? `Item ${it.code} diperbarui` : `Item ${it.code} ditambahkan`, "ok");
      const tb = $(`tbody.item[data-id="${it.id}"]`);
      if (tb) tb.scrollIntoView({ block: "center", behavior: "smooth" });
    } catch (err) { showFormError("#itemFormError", err.message); }
    finally { $("#btnSaveItem").disabled = false; }
  }

  function showFormError(sel, msg) { const el = $(sel); el.textContent = msg; el.hidden = false; }

  async function deleteItem(it) {
    const ok = await confirmDlg("Hapus item?", `Item ${it.code} – ${it.description} beserta seluruh data bulanannya (semua tahun) akan dihapus permanen.`);
    if (!ok) return;
    try {
      await data().deleteItem(it.id);
      $("#itemDialog").open && $("#itemDialog").close();
      state.items = state.items.filter((x) => x.id !== it.id);
      state.byId.delete(it.id);
      renderGrid();
      toast(`Item ${it.code} dihapus`, "ok");
    } catch (e) { toast("Gagal menghapus: " + e.message, "err"); }
  }

  // ------------------------------------------------------------------ bulk create of NEW item master records
  const newItemsState = { rows: [], busy: false };
  const NEW_ITEM_HEADERS = ["Kode Item", "Kategori", "Deskripsi Item", "UOM", "User / Dept", "Min Stock", "Max Stock", "Lead Time (hari)", "Stok Awal Januari"];
  async function downloadNewItemsTemplate() {
    try {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("Item Baru");
      ws.addRow(NEW_ITEM_HEADERS);
      ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
      ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFC8102E" } };
      ws.columns = [18, 24, 42, 15, 20, 16, 16, 20, 23].map(width => ({ width }));
      ws.getColumn(1).numFmt = "@"; // preserve leading zeroes in item codes
      ws.views = [{ state: "frozen", ySplit: 1 }];
      const note = wb.addWorksheet("Petunjuk");
      ["FORMAT IMPORT ITEM BARU", "Isi data mulai baris 2 pada sheet Item Baru. Jangan ubah judul kolom.",
        "Wajib: Kode Item dan Deskripsi Item. Kode Item harus unik dan belum terdaftar.",
        "Opsional: Kategori, UOM, User / Dept, Min Stock, Max Stock, Lead Time (hari), Stok Awal Januari.",
        "Kolom angka kosong dianggap 0 (Lead Time kosong berarti tidak diisi). Gunakan angka tanpa pemisah ribuan.",
        "Stok Awal Januari mengikuti FY yang dipilih di aplikasi saat import. Forecast/Actual/Incoming tidak diubah."]
        .forEach(line => note.addRow([line]));
      note.getColumn(1).width = 115;
      downloadBlob(new Blob([await wb.xlsx.writeBuffer()], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "Template_Import_Item_Baru.xlsx");
    } catch (err) { toast("Template gagal: " + err.message, "err"); }
  }
  function openNewItemsDialog() {
    $("#newItemsForm").reset();
    newItemsState.rows = [];
    $("#newItemsError").hidden = true;
    $("#newItemsPreview").textContent = `Pilih file untuk FY ${state.year}.`;
    $("#btnSaveNewItems").disabled = true;
    $("#newItemsDialog").showModal();
  }
  function newItemNumber(value, label, row, integer = false) {
    if (value === null || value === undefined || value === "") return integer ? null : 0;
    const n = typeof value === "number" ? value : Number(String(value).trim());
    if (!Number.isFinite(n) || (integer && !Number.isInteger(n)) || (label !== "Stok Awal Januari" && n < 0)) throw new Error(`Baris ${row}: ${label} harus angka ${integer ? "bulat " : ""}${label === "Stok Awal Januari" ? "" : "non-negatif"}.`);
    return n;
  }
  async function inspectNewItems(file) {
    newItemsState.rows = [];
    $("#btnSaveNewItems").disabled = true;
    $("#newItemsError").hidden = true;
    if (!file) return;
    $("#newItemsPreview").textContent = "Memeriksa file…";
    try {
      if (!/\.xlsx$/i.test(file.name)) throw new Error("Gunakan file .xlsx sesuai template Item Baru.");
      const wb = await FC.master.readWorkbook(file);
      if (!wb.SheetNames.includes("Item Baru")) throw new Error("Sheet 'Item Baru' tidak ditemukan. Unduh template yang tersedia.");
      const rows = FC.master.sheetRows(wb, "Item Baru");
      if (!NEW_ITEM_HEADERS.every((h, i) => String((rows[0] || [])[i] ?? "").trim() === h)) throw new Error("Judul kolom tidak sesuai template Item Baru. Jangan ubah header baris 1.");
      const existing = new Set(state.items.map(it => String(it.code).trim().toLowerCase()));
      const seen = new Set();
      let skipped = 0;
      const errors = [];
      const candidates = [];
      rows.slice(1).forEach((r, i) => {
        if (!r || r.every(v => v === null || v === undefined || String(v).trim() === "")) return;
        const row = i + 2, text = j => String(r[j] ?? "").trim();
        const code = text(0), description = text(2);
        if (!code || !description) { errors.push(`Baris ${row}: Kode Item dan Deskripsi Item wajib diisi.`); return; }
        const key = code.toLowerCase();
        if (seen.has(key)) { errors.push(`Baris ${row}: kode ${code} duplikat dalam file.`); return; }
        seen.add(key);
        if (existing.has(key)) { skipped++; return; }
        try {
          if (code.length > 40 || description.length > 300 || text(1).length > 80 || text(3).length > 20 || text(4).length > 80) throw new Error(`Baris ${row}: panjang teks melebihi batas kolom.`);
          const body = { code, category: text(1), description, uom: text(3), user_dept: text(4),
            min_stock: newItemNumber(r[5], "Min Stock", row), max_stock: newItemNumber(r[6], "Max Stock", row),
            lead_time_days: newItemNumber(r[7], "Lead Time (hari)", row, true), opening_stock: newItemNumber(r[8], "Stok Awal Januari", row) };
          if (body.max_stock && body.min_stock > body.max_stock) throw new Error(`Baris ${row}: Min Stock melebihi Max Stock.`);
          candidates.push(body);
        } catch (e) { errors.push(e.message); }
      });
      if (errors.length) throw new Error(errors.slice(0, 5).join(" ") + (errors.length > 5 ? ` (+${errors.length - 5} kesalahan lain)` : ""));
      newItemsState.rows = candidates;
      $("#newItemsPreview").textContent = `${candidates.length} item baru siap ditambahkan · ${skipped} kode sudah ada (dilewati) · FY ${state.year}. Data lama tidak ditimpa.`;
      $("#btnSaveNewItems").disabled = !candidates.length;
    } catch (err) { $("#newItemsPreview").textContent = "File belum siap diimport."; showFormError("#newItemsError", err.message); }
  }
  async function submitNewItems(e) {
    e.preventDefault();
    if (newItemsState.busy || !newItemsState.rows.length) return;
    const year = state.year, rows = newItemsState.rows;
    if (!await confirmDlg("Import Item Baru", `Tambahkan ${rows.length} item baru ke FY ${year}? Item lama tidak ditimpa.`, "Ya, import")) return;
    newItemsState.busy = true;
    const btn = $("#btnSaveNewItems"); btn.disabled = true;
    let added = 0;
    try {
      for (const row of rows) {
        try { await data().createItem(row, year); added++; }
        catch (e) { throw new Error(`Gagal pada kode ${row.code}: ${e.message}. ${added} item sebelumnya sudah tersimpan.`); }
        $("#newItemsPreview").textContent = `Menyimpan ${added}/${rows.length} item…`;
      }
      $("#newItemsDialog").close();
      await loadItems(); await loadMeta();
      toast(`${added} item baru berhasil ditambahkan`, "ok");
    } catch (err) {
      if (added) { await loadItems(); await loadMeta(); }
      showFormError("#newItemsError", err.message);
      $("#newItemsPreview").textContent = `${added}/${rows.length} item tersimpan. Periksa data lalu pilih ulang file bila ingin mencoba lagi.`;
      newItemsState.rows = [];
      $("#newItemsForm").elements.file.value = "";
    } finally { newItemsState.busy = false; btn.disabled = !newItemsState.rows.length; }
  }

  // ------------------------------------------------------------------ import / export / rollover / settings
  // ---- import wizard: analyse first, then apply with confirmed options ----
  const importState = { preview: null, file: null, parsed: null };

  function openImportDialog() {
    const form = $("#importForm");
    form.reset();
    importState.preview = null; importState.file = null;
    $("#importPreview").hidden = true; $("#importPreview").innerHTML = "";
    $("#importAnalyzing").hidden = true;
    $("#importError").hidden = true;
    $("#importNote").textContent = "Langkah 1: pilih file — format dianalisis otomatis. Langkah 2: periksa ringkasan & opsi. Langkah 3: tekan Import.";
    $("#btnDoImport").disabled = false;
    $("#importDialog").showModal();
    form.elements.file.focus();
  }

  function wireImportDropZone() {
    const dlg = $("#importDialog"), zone = $("#importDrop"), input = $("#importForm").elements.file;
    const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
    ["dragenter", "dragover"].forEach((ev) => dlg.addEventListener(ev, (e) => { stop(e); zone.classList.add("over"); }));
    ["dragleave", "drop"].forEach((ev) => dlg.addEventListener(ev, (e) => { stop(e); zone.classList.remove("over"); }));
    dlg.addEventListener("drop", (e) => {
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      if (!/\.(xlsx|xlsm|xls)$/i.test(f.name)) { showFormError("#importError", "File harus berformat Excel (.xlsx / .xls)."); return; }
      try { input.files = e.dataTransfer.files; } catch (_) { /* ignore */ }
      analyzeImportFile(f);
    });
    zone.addEventListener("click", (e) => { if (e.target === zone || e.target.classList.contains("dz-text")) input.click(); });
  }

  async function analyzeImportFile(file) {
    importState.preview = null; importState.file = file; importState.busy = false;
    $("#importError").hidden = true;
    $("#importPreview").hidden = true;
    if (!file) return;
    importState.busy = true;
    $("#importAnalyzing").hidden = false;
    $("#importDrop").querySelector(".dz-file").textContent = "· " + file.name;
    try {
      if (!/\.(xlsx|xlsm|xls)$/i.test(file.name)) throw new Error("File harus berformat Excel (.xlsx / .xls).");
      await new Promise((r) => setTimeout(r, 30));                       // let the spinner paint
      const wb = await FC.master.readWorkbook(file);
      const det = FC.master.detect(wb);
      let pv;
      if (det.format === "sap") {
        importState.parsed = FC.sap.parsePostingList(det.rows);
        pv = FC.sap.summarize(importState.parsed, state.items);
      } else if (det.format === "master") {
        importState.parsed = FC.master.parseRows(det.rows);
        if (!importState.parsed.length) throw new Error("Tidak ada item yang terbaca dari file");
        pv = FC.master.summarize(importState.parsed, state.items);
      } else {
        throw new Error("Format tidak dikenali. Gunakan template Master RumpUp-Forecast atau ekspor SAP Inventory Posting List.");
      }
      pv.sheet = det.sheet; pv.filename = file.name;
      importState.preview = pv;
      $("#importPreview").innerHTML = pv.format === "sap" ? sapPreviewHTML(pv) : masterPreviewHTML(pv);
      $("#importPreview").hidden = false;
      wirePreviewOptions(pv);
      $("#importNote").textContent = pv.format === "sap" ? "Forecast tidak diubah. Actual & Incoming pada bulan yang dipilih akan ditimpa dengan data SAP." : "";
    } catch (e) { showFormError("#importError", e.message); }
    finally { $("#importAnalyzing").hidden = true; importState.busy = false; }
  }

  const stat = (v, l) => `<div class="pv-stat"><div class="v">${v}</div><div class="l">${l}</div></div>`;
  const fmtDate = (iso) => iso ? new Date(iso + "T00:00:00").toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" }) : "–";

  function masterPreviewHTML(pv) {
    return `
      <div class="pv-head"><span class="chip big">Format: Master RumpUp-Forecast</span><span class="muted small">sheet “${esc(pv.sheet)}”</span></div>
      <div class="pv-stats">${stat(pv.items_total, "item di file")}${stat(pv.matched, "sudah ada di master")}${stat(pv.new_all, "item baru")}${stat(pv.with_forecast, "punya forecast")}${stat(pv.with_actual, "punya actual")}</div>
      <div class="pv-section"><h4>Opsi</h4>
        <div class="pv-grid">
          <label>Tahun fiskal tujuan<input name="year" type="number" min="2000" max="2100" value="${state.year}" required></label>
          <label>Mode
            <select name="mode"><option value="upsert">Upsert — tambah item baru & timpa data item yang kodenya sama</option><option value="replace">Replace — hapus semua data bulanan tahun tsb, lalu isi dari file</option></select>
          </label>
        </div>
        <p class="muted small" style="padding:0;margin:8px 0 0">Bulan yang punya data di file: ${pv.months_with_data.map((m) => MONTHS[m - 1]).join(", ") || "–"}. Kategori: ${pv.categories.map((c) => `${esc(c.name)} (${c.items})`).join(", ")}.</p>
      </div>`;
  }

  function sapPreviewHTML(pv) {
    const monthOpt = (sel, disabledAfter) => MONTHS.map((m, i) => {
      const n = i + 1, partial = n > pv.last_complete_month && pv.months_with_data.includes(n);
      const label = m + (partial ? " (parsial)" : "") + (!pv.months_with_data.includes(n) ? " (tanpa data)" : "");
      return `<option value="${n}" ${n === sel ? "selected" : ""}>${label}</option>`;
    }).join("");
    const years = Object.keys(pv.years);
    const yearWarn = years.length > 1 ? `<div class="pv-warn">File berisi transaksi lebih dari satu tahun (${years.join(", ")}). Hanya transaksi tahun yang dipilih yang dipakai.</div>` : "";
    const balWarn = pv.balance_mismatch ? `<div class="pv-warn">${pv.balance_mismatch} item saldo awal + terima − keluar ≠ saldo akhir — periksa file.</div>` : "";
    const unknown = pv.doc_types.filter((d) => d.role === "auto");
    const unkWarn = unknown.length ? `<div class="pv-warn">Jenis dokumen tidak dikenal: ${unknown.map((d) => d.type).join(", ")} — Rec dianggap Incoming, Iss dianggap Actual.</div>` : "";
    const toDefault = pv.months_with_data.length ? Math.max(...pv.months_with_data) : (pv.last_complete_month || 1);
    const partialMonth = pv.date_max && toDefault > (pv.last_complete_month || 0) ? toDefault : null;
    return `
      <div class="pv-head"><span class="chip big">Format: SAP Inventory Posting List</span>
        <span class="chip">Periode ${fmtDate(pv.date_min)} – ${fmtDate(pv.date_max)}</span><span class="chip">Tahun ${pv.year}</span>
        <span class="muted small">${pv.balance_mismatch === 0 ? "✔ saldo konsisten untuk semua item" : ""}</span></div>
      <div class="pv-stats">${stat(nf.format(pv.items_total), "item di file")}${stat(nf.format(pv.tx_total), "transaksi")}${stat(pv.matched, "cocok dengan master")}${stat(pv.items_moving, "item bergerak")}${stat(pv.new_moving, "baru & bergerak")}${stat(pv.items_stock_only, "diam, ada stok")}</div>
      ${yearWarn}${balWarn}${unkWarn}
      <div class="pv-section"><h4>Opsi import</h4>
        <div class="pv-grid">
          <label>Tahun fiskal tujuan<input name="year" type="number" min="2000" max="2100" value="${pv.year}" required></label>
          <label>Isi data dari bulan<select name="from_month">${monthOpt(1)}</select></label>
          <label>sampai bulan<select name="to_month">${monthOpt(toDefault)}</select></label>
        </div>
        <label class="radio" style="margin-top:10px"><input type="checkbox" name="set_opening" checked> <span>Set <b>stok awal Januari</b> dari saldo awal SAP (hanya jika mulai dari Jan)</span></label>
        <div class="pv-info">${partialMonth
          ? `Data SAP tersedia s/d <b>${fmtDate(pv.date_max)}</b> — bulan <b>${MONTHS[partialMonth - 1]}</b> masih parsial dan ikut diimport (histori transaksi lengkap s/d tanggal itu). Angka ${MONTHS[partialMonth - 1]} akan bertambah otomatis saat file SAP berikutnya diimport.`
          : `Bulan terakhir yang lengkap: <b>${pv.last_complete_month ? MONTHS[pv.last_complete_month - 1] : "–"}</b>.`}</div>
      </div>
      <div class="pv-section"><h4>Cakupan item</h4>
        <label class="radio"><input type="radio" name="scope" value="existing" checked> <span><b>Hanya item yang sudah ada di master</b> (${pv.matched} item)</span></label>
        <label class="radio"><input type="radio" name="scope" value="moving"> <span>+ buat item baru yang <b>punya transaksi</b> (${pv.new_moving} item)</span></label>
        <label class="radio"><input type="radio" name="scope" value="all"> <span>+ buat <b>semua</b> item dari file (${pv.new_all} item baru)</span></label>
        <div id="pvCats" class="pv-cats" hidden>
          <span class="muted small" style="width:100%">Kategori item baru yang dibuat (nama kategori mengikuti master / akun G/L):</span>
          ${pv.categories.map((c) => `<label><input type="checkbox" name="cat" value="${esc(c.prefix)}" checked> ${esc(c.prefix)}xxx · ${esc(c.name)} <span class="muted">(${c.new_moving} bergerak / ${c.new_all} baru)</span></label>`).join("")}
        </div>
      </div>
      <div class="pv-section"><h4>Pemetaan jenis dokumen</h4>
        <table class="tbl compact"><thead><tr><th>Dok</th><th>Arti</th><th class="num">Baris</th><th class="num">Σ Rec</th><th class="num">Σ Iss</th><th>Dipakai sebagai</th></tr></thead><tbody>
          ${pv.doc_types.map((d) => `<tr><td><b>${esc(d.type)}</b></td><td>${esc(d.label)}</td><td class="num">${nf.format(d.rows)}</td><td class="num">${fmt(d.rec)}</td><td class="num">${fmt(d.iss)}</td><td class="role-${d.role}">${esc(d.role_label)}</td></tr>`).join("")}
        </tbody></table>
      </div>`;
  }

  function wirePreviewOptions(pv) {
    const form = $("#importForm");
    if (pv.format !== "sap") return;
    const cats = $("#pvCats");
    $$("input[name=scope]", form).forEach((r) => r.addEventListener("change", () => { cats.hidden = form.elements.scope.value === "existing"; }));
    const from = form.elements.from_month, to = form.elements.to_month, op = form.elements.set_opening;
    const sync = () => {
      if (+from.value > +to.value) to.value = from.value;
      op.disabled = +from.value !== 1;
      if (op.disabled) op.checked = false; else if (!op.dataset.touched) op.checked = true;
    };
    from.addEventListener("change", sync); to.addEventListener("change", () => { if (+to.value < +from.value) from.value = to.value; sync(); });
    op.addEventListener("change", () => (op.dataset.touched = "1"));
  }

  /** Progress bar di dialog import: merayap ke 95% selama minMs, lalu 100% saat selesai (min. tampil minMs). */
  function startImportProgress(minMs = 5000) {
    const panel = $("#importProgress"), bar = $("#importBar"), pct = $("#importPct"), stage = $("#importStage"), pb = $("#importDialog .ip-bar");
    const t0 = performance.now();
    let cur = 0, done = false, raf = 0;
    const setPct = (v) => { cur = Math.max(cur, Math.min(100, v)); bar.style.width = cur + "%"; pct.textContent = Math.round(cur) + "%"; pb.setAttribute("aria-valuenow", String(Math.round(cur))); };
    stage.textContent = "Menyiapkan data…";
    panel.hidden = false; setPct(0);
    const tick = () => {
      const el = performance.now() - t0;
      setPct(done ? 100 : Math.min(95, 95 * (1 - Math.exp(-el / (minMs * 0.4)))));   // cepat di awal, melambat mendekati 95%
      if (cur < 100) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    return {
      stage: (txt) => { stage.textContent = txt || "\u00a0"; },
      async finish() {
        const remaining = minMs - (performance.now() - t0);
        if (remaining > 0) await sleep(remaining);          // tampil minimal 5 detik
        done = true; stage.textContent = "Selesai!";
        await sleep(450);
        cancelAnimationFrame(raf); panel.hidden = true;
      },
      cancel() { cancelAnimationFrame(raf); panel.hidden = true; },
    };
  }

  async function submitImport(e) {
    e.preventDefault();
    const form = $("#importForm");
    const file = importState.file || form.elements.file.files[0];
    const pv = importState.preview;
    if (importState.busy) { toast("File masih dianalisis, tunggu sebentar…"); return; }
    if (!file) { showFormError("#importError", "Pilih file Excel (.xlsx) terlebih dahulu — klik kotak file atau seret file ke jendela ini."); form.elements.file.focus(); form.elements.file.click(); return; }
    if (!pv) { analyzeImportFile(file); return; }
    const year = +form.elements.year.value;
    const options = { year };
    let confirmText;
    if (pv.format === "master") {
      options.mode = form.elements.mode.value;
      if (options.mode === "replace") confirmText = `Semua data bulanan FY ${year} akan dihapus lalu diganti dengan isi file (${pv.items_total} item). Lanjutkan?`;
    } else {
      options.from_month = +form.elements.from_month.value;
      options.to_month = +form.elements.to_month.value;
      options.scope = form.elements.scope.value;
      options.set_opening = form.elements.set_opening.checked;
      options.categories = options.scope === "existing" ? null : $$("input[name=cat]:checked", form).map((c) => c.value);
      const nNew = options.scope === "existing" ? 0 : options.scope === "moving" ? pv.new_moving : pv.new_all;
      confirmText = `Actual & Incoming ${MONTHS[options.from_month - 1]}–${MONTHS[options.to_month - 1]} FY ${year} untuk ${pv.matched} item master akan ditimpa dengan data SAP` +
        (options.set_opening ? ", stok awal Januari diperbarui" : "") + (nNew ? `, dan ±${nNew} item baru akan dibuat` : "") + ". Lanjutkan?";
    }
    if (confirmText) { const ok = await confirmDlg("Konfirmasi import", confirmText, "Ya, import"); if (!ok) return; }
    $("#btnDoImport").disabled = true;
    $("#importError").hidden = true;
    const prog = startImportProgress(5000);
    try {
      let res;
      if (pv.format === "sap") {
        const { payload, stats } = FC.sap.buildPayload(importState.parsed, options, state.items);
        prog.stage(`Menyimpan Actual & Incoming ${payload.items.length} item…`);
        const r = await data().applyChanges(payload);
        res = { ...stats, created: r.created, updated: r.updated, format: "sap", year };
        // simpan batas tanggal data SAP untuk tahun ini (dipakai penanda "s/d 4 Sep" di grid)
        try {
          const lastDay = new Date(Date.UTC(year, options.to_month, 0)).getUTCDate();
          const endSel = `${year}-${String(options.to_month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
          const until = pv.date_max && pv.date_max < endSel ? pv.date_max : endSel;
          await data().setSetting(`sap_until_${year}`, until);
        } catch (_) { /* opsional */ }
        // histori transaksi (breakdown per tanggal) — tabel "transactions"
        try {
          const tx = FC.sap.buildTransactions(importState.parsed, options, payload);
          prog.stage(`Menyimpan histori transaksi (${fmt(tx.rows.length)} baris)…`);
          const t = await data().importTransactions(tx, (done, total) => prog.stage(`Menyimpan histori transaksi ${fmt(done)}/${fmt(total)}…`));
          res.transactions = t.inserted;
        } catch (e) {
          res.transactions_error = e.message;
        }
      } else {
        const payload = FC.master.buildPayload(importState.parsed, options);
        prog.stage(`Menyimpan ${payload.items.length} item…`);
        const r = await data().applyChanges(payload);
        res = { created: r.created, updated: r.updated, total: pv.items_total, format: "master", year };
      }
      data().logImport({ format: res.format, filename: file.name, options, result: res });
      prog.stage("Memuat ulang tabel…");
      state.year = year;
      localStorage.setItem("fc.year", year);
      await loadItems();
      await loadMeta();
      await prog.finish();
      $("#importDialog").close();
      if (res.format === "sap") {
        toast(`Import SAP selesai: ${res.updated || 0} item diperbarui, ${res.created || 0} item baru, ${MONTHS[res.from_month - 1]}–${MONTHS[res.to_month - 1]} FY ${res.year}` + (res.opening_set ? `, ${res.opening_set} stok awal` : "") + (res.transactions ? `, ${fmt(res.transactions)} transaksi histori` : ""), "ok");
        if (res.transactions_error) setTimeout(() => toast("Histori transaksi tidak tersimpan: " + res.transactions_error + " — jalankan supabase/002_transactions.sql di Supabase.", "err"), 2500);
      } else {
        toast(`Import selesai: ${res.created} item baru, ${res.updated} diperbarui (FY ${res.year})`, "ok");
      }
    } catch (err) { prog.cancel(); showFormError("#importError", err.message); }
    finally { $("#btnDoImport").disabled = false; }
  }

  // ------------------------------------------------------------------ PR detail import (not a stock movement)
  let prImportRows = [], prBusy = false;
  function openPRImport() {
    $("#prImportForm").reset(); prImportRows=[];
    $("#prImportSummary").textContent="Pilih file untuk memeriksa data.";
    $("#prImportError").hidden=true; $("#btnSubmitPR").disabled=true;
    $("#prImportDialog").showModal();
  }
  async function inspectPR(file) {
    prImportRows=[]; $("#btnSubmitPR").disabled=true; $("#prImportError").hidden=true;
    if(!file) return;
    $("#prImportSummary").textContent="Memeriksa file PR…";
    try {
      if(!/\.xlsx$/i.test(file.name)) throw new Error("Gunakan file .xlsx (ekspor file .xls ke .xlsx terlebih dahulu).");
      const wb=await FC.master.readWorkbook(file);
      const result=FC.pr.parse(FC.master.sheetRows(wb,wb.SheetNames[0]),state.items);
      prImportRows=result.rows.filter(r=>r.year===state.year);
      if(!prImportRows.length) throw new Error(`Tidak ada baris PR untuk item yang terdaftar pada FY ${state.year}.`);
      $("#prImportSummary").textContent=`${fmt(prImportRows.length)} baris PR cocok dengan kode item web app · ${fmt(result.unmatched)} baris kode di luar master (dilewati) · ${result.invalid} baris tidak valid. FY ${state.year}. Item lama dan angka stok tidak diubah.`;
      $("#btnSubmitPR").disabled=false;
    } catch(e) { $("#prImportSummary").textContent="File belum siap diimport."; showFormError("#prImportError",e.message); }
  }
  async function submitPR(e) {
    e.preventDefault(); if(prBusy||!prImportRows.length) return;
    if(!await confirmDlg("Import Detail PR",`Simpan ${fmt(prImportRows.length)} baris detail PR? Import ulang file yang sama akan memperbarui barisnya, bukan menggandakan. Stok tidak berubah.`,"Ya, import")) return;
    prBusy=true; $("#btnSubmitPR").disabled=true;
    try {
      await data().importPR(prImportRows,(done,total)=>$("#prImportSummary").textContent=`Menyimpan detail PR ${fmt(done)}/${fmt(total)}…`);
      $("#prImportDialog").close(); toast(`${fmt(prImportRows.length)} baris detail PR tersimpan`,"ok");
    } catch(e) { showFormError("#prImportError",e.message+" Jika tabel belum ada, jalankan supabase/003_pr_details.sql di SQL Editor."); }
    finally { prBusy=false; $("#btnSubmitPR").disabled=!prImportRows.length; }
  }

  // ------------------------------------------------------------------ histori transaksi SAP
  const txState = { item: null, rows: [], pr: [], prError: "", role: "", month: 0, view: "sap", selectedPR: 0 };
  const ROLE_OF = (r) => (r.role === "actual" ? "out" : r.role === "incoming" || r.role === "return" ? "in" : r.role === "ignore" ? "ignore" : (r.rec_qty > 0 ? "in" : r.iss_qty > 0 ? "out" : "ignore"));
  const DOC_DESC = { SO: "Goods Issue", PD: "Goods Receipt PO", SI: "Stock In", PR: "Goods Return", IM: "Inventory Transfer", PU: "A/P Invoice", MR: "Revaluasi" };
  const fmtTxDate = (iso) => { const [y, m, d] = String(iso).split("-"); return `${d}/${m}/${y}`; };

  async function openTxDialog(it, { role = "", month = 0 } = {}) {
    txState.item = it; txState.role = role; txState.month = month; txState.rows = []; txState.pr=[]; txState.prError=""; txState.view="sap"; txState.selectedPR=0;
    $("#txTitle").textContent = `${it.code} · ${it.description}`;
    $("#txSub").textContent = `Histori keluar/masuk dari SAP · FY ${state.year} · UoM ${it.uom || "–"} · stok awal ${fmt(it.opening_stock)}`;
    $("#txMonth").value = String(month); $("#txRole").value = role;
    $("#txBody").innerHTML = `<div class="loading">Memuat…</div>`; $("#txCount").textContent = "";
    $("#txDialog").showModal();
    try {
      txState.rows = await data().transactions(it.id, state.year);
      try { txState.pr = await data().prDetails(it.id,state.year); if (txState.pr.length) txState.view="pr"; }
      catch(e) { txState.prError = /pr_details|schema cache|does not exist/i.test(e.message) ? "Tabel detail PR belum dipasang (jalankan 003_pr_details.sql)." : e.message; }
      renderTx();
    } catch (e) {
      const missing = /transactions|schema cache|does not exist/i.test(e.message);
      $("#txBody").innerHTML = `<div class="tx-empty">${missing ? "Tabel histori belum ada di database.<br>Jalankan <code>supabase/002_transactions.sql</code> di Supabase SQL Editor, lalu import ulang file SAP." : esc(e.message)}</div>`;
    }
  }

  function txFiltered() {
    return txState.rows.filter((r) => (!txState.month || r.month === txState.month) && (!txState.role || ROLE_OF(r) === txState.role));
  }

  function renderPRView() {
    const it=txState.item;
    const so=txState.rows.filter(r=>r.doc_type==="SO" && (!txState.month || r.month===txState.month));
    const visible=[];
    for (const r of so) {
      const ref=String(r.doc_no||"").match(/\d+/)?.[0];
      const details=txState.pr.filter(p=>p.sap_ref && p.sap_ref===ref);
      if(details.length) visible.push({r,ref,details});
    }
    const allRefs=new Set(txState.rows.filter(r=>r.doc_type==="SO").map(r=>String(r.doc_no||"").match(/\d+/)?.[0]));
    const pending=txState.pr.filter(p=>!p.sap_ref || !allRefs.has(p.sap_ref));
    if(txState.selectedPR>=visible.length)txState.selectedPR=0;
    const summary=(name,value)=>`<div class="prv-stat"><small>${name}</small><strong>${value}</strong></div>`;
    return `<div class="prv-wrap">
      <div class="prv-banner"><b>Detail pendamping transaksi SO</b> · PR memberikan konteks pemakaian; kuantitasnya tidak dijumlah ulang ke Actual atau End Stock.</div>
      <div class="prv-stats">${summary("SO dengan detail PR",fmt(visible.length)+" transaksi")}${summary("Baris PR item ini",fmt(txState.pr.length)+" baris")}${summary("Sumber Actual & saldo","Posting SAP")}</div>
      <div class="prv-heading"><div><h3>Transaksi keluar${txState.month ? " · "+MONTHS[txState.month-1]+" "+state.year : " · FY "+state.year}</h3><small>Klik Lihat detail PR untuk melihat cost center, activity, dan peminta.</small></div></div>
      ${visible.length?`<div class="prv-scroll"><table class="prv-table"><thead><tr><th>Tgl posting SAP</th><th>Referensi SO</th><th>Keluar</th><th>Status PR</th><th>Rincian</th></tr></thead><tbody>${visible.map(({r,ref,details},i)=>`<tr class="${i===txState.selectedPR?"selected":""}"><td>${fmtTxDate(r.posting_date)}</td><td class="prv-mono">SO ${esc(ref)}</td><td class="prv-qty">−${fmt(Number(r.iss_qty))} ${esc(it.uom||r.uom||"")}</td><td><span class="prv-badge">${details.length===1 && Math.abs(Number(details[0].sap_qty??details[0].quantity)-Number(r.iss_qty))<.001?"Kuantitas cocok":"Periksa kuantitas"}</span></td><td><button type="button" class="btn small prv-open" data-pr-index="${i}">Lihat detail PR →</button></td></tr>`).join("")}</tbody></table></div>`:`<div class="prv-empty">Belum ada SO dengan detail PR yang cocok${txState.month?" di bulan ini":""}. Cek tanggal cakupan Inventory Posting List dan nomor referensinya.</div>`}
      ${pending.length?`<details class="prv-pending"><summary>${pending.length} baris PR belum terhubung ke SO · tidak dihitung sebagai Actual</summary><div class="prv-pending-list">${pending.slice(0,100).map(p=>`<p>${esc(p.slip_no)} / ${esc(p.line_no)} · ${esc(p.cost_center)} · ${fmt(Number(p.quantity))} ${esc(p.uom)} · ${esc(p.sap_ref||"tanpa referensi SAP")}</p>`).join("")}${pending.length>100?`<p>Menampilkan 100 dari ${pending.length} baris.</p>`:""}</div></details>`:""}
      <p class="prv-footnote">Tanggal PR berasal dari format campuran dalam file sumber; periode pergerakan dan saldo selalu mengikuti tanggal posting SAP.</p>
    </div>`;
  }

  function openPRDetail(index) {
    const so=txState.rows.filter(r=>r.doc_type==="SO" && (!txState.month || r.month===txState.month));
    const visible=so.map(r=>({r,ref:String(r.doc_no||"").match(/\d+/)?.[0]})).map(x=>({...x,details:txState.pr.filter(p=>p.sap_ref && p.sap_ref===x.ref)})).filter(x=>x.details.length);
    const chosen=visible[index]; if(!chosen)return;
    const it=txState.item;
    const field=(name,value)=>`<div><small>${name}</small><b>${esc(value==null||value===""?"–":value)}</b></div>`;
    $("#prDetailTitle").textContent=`Detail pemakaian · SO ${chosen.ref}`;
    $("#prDetailSubtitle").textContent=`${it.code} · ${it.description} · posting SAP ${fmtTxDate(chosen.r.posting_date)}`;
    $("#prDetailContent").innerHTML=`<div class="prv-banner"><b>Detail pendamping transaksi SO.</b> PR tidak dijumlah ulang ke Actual atau End Stock.</div>
      <div class="prv-stats"><div class="prv-stat"><small>Keluar menurut SAP</small><strong>${fmt(Number(chosen.r.iss_qty))} ${esc(it.uom||chosen.r.uom||"")}</strong></div><div class="prv-stat"><small>Detail slip PR</small><strong>${chosen.details.length} baris</strong></div><div class="prv-stat"><small>Sumber saldo stok</small><strong>Posting SAP</strong></div></div>
      <section class="prv-panel"><div class="prv-panel-head"><div><h3>Rincian slip pengeluaran</h3><p>Referensi SAP SO ${esc(chosen.ref)} · ${chosen.details.length} baris dari laporan PR</p></div><span class="prv-badge">${Math.abs(chosen.details.reduce((n,p)=>n+Number(p.sap_qty??p.quantity??0),0)-Number(chosen.r.iss_qty))<.001?"Kuantitas cocok":"Periksa kuantitas"}</span></div>
      ${chosen.details.map(p=>`<div class="prv-entry"><div class="prv-entry-title"><b>Slip ${esc(p.slip_no)} / baris ${esc(p.line_no)}</b><span>${fmt(Number(p.sap_qty??p.quantity))} ${esc(p.uom||it.uom||"")}</span></div><div class="prv-fields">${field("Tanggal slip PR",p.pr_date)}${field("Order cost center",p.order_cost_center)}${field("Cost center",p.cost_center)}${field("Activity code",p.activity_code)}${field("Account code",p.account_code)}${field("Requestor",p.requestor)}${field("Nilai PR (informasi)",p.amount==null?"–":"Rp"+fmt(Number(p.amount)))}${field("Nilai outstanding (bukan qty)",p.outstanding_amount==null?"–":"Rp"+fmt(Number(p.outstanding_amount)))}</div></div>`).join("")}</section>
      <p class="prv-footnote">Tanggal PR berasal dari format campuran file sumber; periode pergerakan dan saldo selalu mengikuti tanggal posting SAP.</p>`;
    $("#prDetailDialog").showModal();
  }

  function renderTx() {
    const it = txState.item, rows = txFiltered();
    const body = $("#txBody");
    if (!txState.rows.length) {
      body.innerHTML = `<div class="tx-empty">Belum ada histori SAP FY ${state.year}. Import file <b>SAP Inventory Posting List</b> untuk mencocokkan detail PR dengan SO.</div>${txState.pr.length ? `<div class="pr-pending"><b>${txState.pr.length} baris detail PR tersedia</b><p>Belum dapat dihubungkan karena histori SO belum ada. Tidak dihitung sebagai Actual.</p></div>` : ""}${txState.prError ? `<div class="pr-warning">${esc(txState.prError)}</div>` : ""}`;
      $("#txCount").textContent = ""; return;
    }
    const tabs=txState.pr.length ? `<div class="prv-tabs"><button type="button" data-tx-view="pr" class="${txState.view==="pr"?"active":""}">Detail dari Budget System</button><button type="button" data-tx-view="sap" class="${txState.view==="sap"?"active":""}">Jurnal SAP</button></div>` : "";
    if (txState.view==="pr" && txState.pr.length) { body.innerHTML=tabs+renderPRView(); $("#txCount").textContent=`${txState.pr.length} baris PR · ${txState.rows.length} transaksi SAP`; return; }
    if (!rows.length) { body.innerHTML = tabs+`<div class="tx-empty">Tidak ada transaksi yang cocok dengan filter.</div>`; $("#txCount").textContent = `0 dari ${txState.rows.length} transaksi`; return; }
    let sumIn = 0, sumOut = 0, sumIgn = 0;
    const byMonth = new Map();
    for (const r of rows) { (byMonth.get(r.month) || byMonth.set(r.month, []).get(r.month)).push(r); }
    const trs = [];
    for (const [m, list] of [...byMonth.entries()].sort((a, b) => a[0] - b[0])) {
      let mIn = 0, mOut = 0;
      trs.push(`<tr class="month-head"><td colspan="8">${MONTHS[m - 1]} ${state.year} · ${list.length} transaksi</td></tr>`);
      for (const r of list) {
        const kind = ROLE_OF(r);
        const inQ = kind === "in" ? (r.role === "return" ? -r.iss_qty : r.rec_qty) : 0;
        const outQ = kind === "out" ? r.iss_qty : 0;
        if (kind === "in") { mIn += inQ; sumIn += inQ; } else if (kind === "out") { mOut += outQ; sumOut += outQ; } else sumIgn += 1;
        const pill = kind === "in" ? (r.role === "return" ? `<span class="tx-pill ret">retur</span>` : `<span class="tx-pill in">masuk</span>`) : kind === "out" ? `<span class="tx-pill out">keluar</span>` : `<span class="tx-pill">diabaikan</span>`;
        trs.push(`<tr class="${kind === "ignore" ? "ignored" : ""}">
          <td>${fmtTxDate(r.posting_date)}</td>
          <td>${esc(r.doc_no || r.doc_type)}</td>
          <td>${esc(DOC_DESC[r.doc_type] || r.doc_type || "–")}${pill}</td>
          <td>${esc(r.whse || "–")}</td>
          <td class="acct" title="${esc(r.acct_name || "")}">${esc(r.acct_name || "–")}</td>
          <td class="num in">${r.rec_qty ? fmt(r.rec_qty) : ""}</td>
          <td class="num out">${r.iss_qty ? fmt(r.iss_qty) : ""}</td>
          <td class="num">${r.balance === null || r.balance === undefined ? "–" : fmt(Number(r.balance))}</td>
        </tr>`);
      }
      trs.push(`<tr class="month-sum"><td colspan="5">Subtotal ${MONTHS[m - 1]}</td><td class="num in">${mIn ? fmt(mIn) : ""}</td><td class="num out">${mOut ? fmt(mOut) : ""}</td><td></td></tr>`);
    }
    const last = rows[rows.length - 1];
    body.innerHTML = `${tabs}
      <div class="tx-summary">
        <span>Masuk (Incoming): <b>${fmt(sumIn)} ${esc(it.uom || "")}</b></span>
        <span>Keluar (Actual): <b>${fmt(sumOut)} ${esc(it.uom || "")}</b></span>
        <span>Selisih: <b>${fmt(sumIn - sumOut)}</b></span>
        ${sumIgn ? `<span class="muted">${sumIgn} baris diabaikan (transfer/invoice/revaluasi)</span>` : ""}
        <span class="muted">Saldo SAP terakhir: <b>${last.balance === null ? "–" : fmt(Number(last.balance))}</b> (${fmtTxDate(last.posting_date)})</span>
      </div>
      <table class="tx-table">
        <colgroup><col class="c-date"><col class="c-doc"><col class="c-kind"><col class="c-whse"><col class="c-acct"><col class="c-num"><col class="c-num"><col class="c-num"></colgroup>
        <thead><tr><th>Tanggal</th><th>Dokumen</th><th>Jenis</th><th>Gudang</th><th>Akun / Partner</th><th class="num">Masuk</th><th class="num">Keluar</th><th class="num" title="Saldo menurut SAP setelah transaksi">Saldo SAP</th></tr></thead>
        <tbody>${trs.join("")}</tbody>
      </table>
      ${txState.prError ? `<div class="pr-warning">${esc(txState.prError)}</div>` : ""}
      ${(() => { const refs=new Set(txState.rows.filter(r=>r.doc_type==="SO").map(r=>String(r.doc_no||"").match(/\d+/)?.[0])); const pending=txState.pr.filter(p=>!p.sap_ref || !refs.has(p.sap_ref)); return pending.length ? `<div class="pr-pending"><b>Detail PR belum terhubung ke SO (${pending.length} baris)</b><p>Referensi belum ada di Inventory Posting List yang diimport. Tidak dihitung sebagai Actual.</p><div class="pr-pending-list">${pending.slice(0,100).map(p=>`<div>${esc(p.slip_no)} / ${esc(p.line_no)} · ${esc(p.cost_center)} · ${fmt(Number(p.quantity))} ${esc(p.uom)} · ${esc(p.sap_ref||"tanpa referensi SAP")}</div>`).join("")}${pending.length>100?`<small>Menampilkan 100 baris pertama dari ${pending.length}.</small>`:""}</div></div>` : ""; })()}`;
    $("#txCount").textContent = `${rows.length} dari ${txState.rows.length} transaksi`;
  }

  async function exportTx() {
    const it = txState.item, rows = txFiltered();
    if (!rows.length) { toast("Tidak ada transaksi untuk diunduh"); return; }
    try {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("Histori " + it.code);
      ws.addRow([`${it.code} – ${it.description}`]); ws.addRow([`Histori transaksi SAP FY ${state.year}` + (txState.month ? ` · ${MONTHS[txState.month - 1]}` : "")]); ws.addRow([]);
      ws.addRow(["Tanggal", "Dokumen", "Jenis", "Peran", "Gudang", "Akun / Partner", "Masuk", "Keluar", "Saldo SAP", "UoM"]).font = { bold: true };
      for (const r of rows) ws.addRow([fmtTxDate(r.posting_date), r.doc_no || r.doc_type, DOC_DESC[r.doc_type] || r.doc_type, ROLE_OF(r) === "in" ? "Masuk" : ROLE_OF(r) === "out" ? "Keluar" : "Diabaikan", r.whse, r.acct_name, r.rec_qty || null, r.iss_qty || null, r.balance === null ? null : Number(r.balance), r.uom]);
      ws.columns.forEach((c, i) => { c.width = [12, 14, 20, 10, 8, 36, 10, 10, 12, 8][i]; });
      ws.getRow(1).font = { bold: true, size: 12 };
      downloadBlob(new Blob([await wb.xlsx.writeBuffer()], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `Histori_${it.code}_FY${state.year}.xlsx`);
    } catch (e) { toast("Gagal: " + e.message, "err"); }
  }

  function openRolloverDialog() {
    const form = $("#rolloverForm");
    form.reset();
    form.elements.from_year.value = state.year;
    form.elements.to_year.value = state.year + 1;
    $("#rolloverError").hidden = true;
    $("#rolloverDialog").showModal();
    form.elements.to_year.focus();
  }

  async function submitRollover(e) {
    e.preventDefault();
    const form = $("#rolloverForm");
    const body = { from_year: +form.elements.from_year.value, to_year: +form.elements.to_year.value, copy_forecast: form.elements.copy_forecast.checked };
    const ok = await confirmDlg("Jalankan rollover?", `Stok awal FY ${body.to_year} semua item akan ditimpa dengan End Stock Desember FY ${body.from_year}.`, "Ya, jalankan");
    if (!ok) return;
    try {
      const res = await data().rollover(body.from_year, body.to_year, body.copy_forecast);
      $("#rolloverDialog").close();
      state.year = res.to_year;
      localStorage.setItem("fc.year", state.year);
      await loadItems();
      await loadMeta();
      toast(`Rollover ${res.items} item ke FY ${res.to_year} selesai`, "ok");
    } catch (err) { showFormError("#rolloverError", err.message); }
  }

  function openSettingsDialog() {
    const form = $("#settingsForm");
    form.elements.company.value = state.meta.company;
    form.elements.title.value = state.meta.title;
    $("#settingsDialog").showModal();
    form.elements.company.focus();
  }

  async function submitSettings(e) {
    e.preventDefault();
    const form = $("#settingsForm");
    try {
      await data().saveSettings({ company: form.elements.company.value, title: form.elements.title.value });
      $("#settingsDialog").close();
      await loadMeta();
      toast("Pengaturan disimpan", "ok");
    } catch (err) { toast(err.message, "err"); }
  }

  // ------------------------------------------------------------------ dashboard
  // On-demand analysis of consumption by Budget System cost center/requestor.
  const behaviorState={report:null,kind:"all",name:""};
  const fmtAnalysisDate=iso=>iso?new Date(iso+"T12:00:00Z").toLocaleDateString("id-ID",{day:"numeric",month:"short",year:"numeric",timeZone:"UTC"}):"–";
  function renderBehavior(){
    const d=behaviorState.report,el=$("#behaviorContent");if(!d||!el)return;
    const source=behaviorState.kind==="center"?d.byCenter:behaviorState.kind==="requestor"?d.byRequestor:[];
    const selected=new Set();
    if(behaviorState.name){
      const map=behaviorState.kind==="center"?"cost_center":"requestor";
      for(const p of d.linkedRows||[])if(String(p[map]||"Tidak disebutkan").trim()===behaviorState.name)selected.add(Number(p.item_id));
    }
    const items=d.results.filter(x=>!behaviorState.name||selected.has(Number(x.id)));
    const urg=items.filter(x=>["empty","below","order"].includes(x.urgency));
    const spikes=items.filter(x=>x.trend!==null&&x.trend>.2).sort((a,b)=>b.trend-a.trend);
    const status={empty:"Stok habis / minus",below:"Di bawah Min",order:"Waktu order tercapai",watch:"Mendekati Min",normal:"Pantau"};
    const badge=x=>`<span class="bh-status ${x.urgency}">${status[x.urgency]}</span>`;
    const line=x=>`<tr><td><button class="bd-item" type="button" data-bh-item="${x.id}">${esc(x.code)}</button><small class="bh-desc">${esc(x.description)}</small></td><td>${badge(x)}</td><td class="num">${x.stock===null?"–":fmt(x.stock)} ${esc(x.uom||"")}</td><td class="num">${x.avg===null?"–":fmt(x.avg)} ${esc(x.uom||"")}/bln</td><td>${x.zeroDate?fmtAnalysisDate(x.zeroDate):"–"}</td><td>${x.orderDate?fmtAnalysisDate(x.orderDate):x.low?"Segera · stok ≤ Min":"–"}</td><td class="num">${x.qty===null||!x.qty?"–":fmt(x.qty)+" "+esc(x.uom||"")}</td><td>${esc(x.evidence)}</td></tr>`;
    el.innerHTML=`<div class="bh-intro">Perkiraan berbasis <b>Actual SAP pada bulan lengkap</b> dan stok pada snapshot SAP. “Pengguna” berarti <b>cost center / requestor dalam Budget System</b>, bukan riwayat klik/login aplikasi. Tanggal habis dan restok adalah estimasi, bukan jadwal pasti.</div>
      <div class="bh-metrics"><div><small>Snapshot SAP</small><b>${fmtAnalysisDate(d.anchor)}</b></div><div><small>Item perlu tindakan</small><b>${fmt(urg.length)}</b></div><div><small>Tren naik &gt;20%</small><b>${fmt(spikes.length)}</b></div><div><small>Baris PR terhubung SO</small><b>${fmt(d.linked)} / ${fmt(d.totalPR)}</b></div></div>
      <div class="bh-panels"><section><h3>Pemakai terbanyak · Cost Center</h3><p>Jumlah slip terkait SO, bukan volume lintas UOM</p>${d.byCenter.slice(0,6).map(g=>`<button class="bh-rank" type="button" data-bh-group="center" data-bh-name="${esc(g.name)}"><b>${esc(g.name)}</b><span>${fmt(g.slips)} slip · ${fmt(g.items)} item</span></button>`).join("")||'<p class="muted small">Import detail PR untuk melihat pemakai.</p>'}</section><section><h3>Requestor paling aktif</h3><p>Gunakan sebagai konteks pemakaian, bukan penilaian individu</p>${d.byRequestor.slice(0,6).map(g=>`<button class="bh-rank" type="button" data-bh-group="requestor" data-bh-name="${esc(g.name)}"><b>${esc(g.name)}</b><span>${fmt(g.slips)} slip · ${fmt(g.items)} item</span></button>`).join("")||'<p class="muted small">Data requestor belum tersedia.</p>'}</section></div>
      <div class="bh-filter"><label>Fokus pemakai <select id="behaviorGroup"><option value="all" ${behaviorState.kind==="all"?"selected":""}>Semua item</option><option value="center" ${behaviorState.kind==="center"?"selected":""}>Cost Center</option><option value="requestor" ${behaviorState.kind==="requestor"?"selected":""}>Requestor</option></select></label>${source.length?`<label>Nama <select id="behaviorName"><option value="">Semua ${behaviorState.kind==="center"?"Cost Center":"Requestor"}</option>${source.map(g=>`<option value="${esc(g.name)}" ${behaviorState.name===g.name?"selected":""}>${esc(g.name)}</option>`).join("")}</select></label>`:""}<span class="muted small">${fmt(items.length)} item${behaviorState.name?" · hanya item yang pernah dipakai oleh pilihan ini":""}</span></div>
      <div class="bh-section"><h3>Prioritas restok <span class="muted small">${urg.length} item perlu tindak lanjut</span></h3>${urg.length?`<div class="bh-table-scroll"><table class="tbl bh-table"><thead><tr><th>Item</th><th>Status</th><th class="num">Stok</th><th class="num">Rerata Actual</th><th>Estimasi habis</th><th>Estimasi order</th><th class="num">Saran ke target</th><th>Keandalan</th></tr></thead><tbody>${urg.slice(0,60).map(line).join("")}</tbody></table></div>`:'<p class="muted small">Tidak ada item yang mencapai batas order menurut data yang tersedia.</p>'}</div>
      <div class="bh-section"><h3>Perubahan pola penggunaan <span class="muted small">3 bulan lengkap terakhir dibanding 3 bulan sebelumnya</span></h3>${spikes.length?`<div class="bh-table-scroll"><table class="tbl bh-table"><thead><tr><th>Item</th><th class="num">Rerata sebelumnya</th><th class="num">Rerata terkini</th><th class="num">Perubahan</th><th>Pemakai utama (baris PR)</th></tr></thead><tbody>${spikes.slice(0,30).map(x=>`<tr><td><button class="bd-item" type="button" data-bh-item="${x.id}">${esc(x.code)}</button> ${esc(x.description)}</td><td class="num">${fmt(x.priorAvg)} ${esc(x.uom||"")}</td><td class="num">${fmt(x.avg)} ${esc(x.uom||"")}</td><td class="num bh-up">+${(x.trend*100).toFixed(0)}%</td><td>${esc(x.users[0]?.[0]||"Belum ada PR terhubung")}</td></tr>`).join("")}</tbody></table></div>`:'<p class="muted small">Belum ada kenaikan signifikan yang bisa dihitung dari bulan lengkap.</p>'}</div>
      <details class="bh-all"><summary>Lihat estimasi seluruh item master (${fmt(d.results.length)})</summary><p class="muted small bh-all-note">Tabel ini menampilkan semua item yang dimuat pada FY ${state.year}, termasuk yang belum memiliki data Actual atau stok. Filter pemakai di atas hanya berlaku untuk daftar prioritas dan perubahan pola.</p><div class="bh-table-scroll"><table class="tbl bh-table"><thead><tr><th>Item</th><th>Status</th><th class="num">Stok</th><th class="num">Rerata Actual</th><th>Estimasi habis</th><th>Estimasi order</th><th class="num">Saran ke target</th><th>Keandalan</th></tr></thead><tbody>${d.results.map(line).join("")}</tbody></table></div></details>
      <div class="bh-method"><b>Cara hitung:</b> rerata pemakaian = Actual SAP dari maksimum 3 bulan lengkap terakhir ÷ jumlah bulannya; estimasi habis = stok ÷ (rerata/30,44 hari); tanggal order = perkiraan saat stok mencapai Min dikurangi lead time. Saran qty = target Max (atau Min bila Max kosong) − stok. Incoming mendatang, variasi harian, dan pesanan yang belum diterima <b>tidak</b> diproyeksikan. Bila lead time / Actual / stok tidak tersedia, tanggal tidak ditampilkan. Snapshot SAP lama tidak mencerminkan stok hari ini.</div>`;
  }
  async function openBehaviorAnalysis(){
    const year=state.year,dlg=$("#behaviorDialog");
    $("#behaviorSubtitle").textContent=`FY ${year} · analisa on-demand dari SAP + Budget System`;
    $("#behaviorContent").innerHTML='<div class="loading">Memindai pola penggunaan dan kebutuhan restok…</div>';
    behaviorState.report=null;behaviorState.kind="all";behaviorState.name="";dlg.showModal();
    try{
      let pr=[],so=[];let prError="";
      try{const res=await data().prDashboard(year);pr=res.pr;so=res.so;}catch(e){prError=e.message;}
      if(!dlg.open||state.year!==year)return;
      const report=FC.behavior.analyze(state.items,pr,so,state.sapUntil?.iso||null,state.sapUntil?.partial?state.sapUntil.month:null);
      report.linkedRows=pr.filter(p=>p.sap_ref&&new Set(so.filter(x=>Number(x.item_id)===Number(p.item_id)).map(x=>String(x.doc_no||"").match(/\d+/)?.[0])).has(p.sap_ref));
      behaviorState.report=report;renderBehavior();
      if(prError){$("#behaviorContent").insertAdjacentHTML("afterbegin",`<div class="bh-error">Detail Budget System tidak dapat dimuat (${esc(prError)}). Analisa stok tetap tampil; kecocokan pemakai belum tersedia.</div>`);}
    }catch(e){if(dlg.open)$("#behaviorContent").innerHTML=`<div class="bh-error">Analisa gagal: ${esc(e.message)}</div>`;}
  }
  // Budget System dashboard: amounts are PR values, never stock values.
  const budgetView = { dataset: null, mode: "center", filter: "" };
  const money = v => "Rp" + nf.format(Math.round(Number(v)||0));
  const bdModes = { center:"Cost Center", activity:"Activity Code", item:"Item paling banyak diminta", requestor:"Requestor", unlinked:"PR belum terhubung", risk:"Item di bawah minimum" };
  function budgetRowsFor(mode,filter) {
    const d=budgetView.dataset;if(!d)return [];
    if(mode==="unlinked")return d.unlinked;
    if(mode==="risk")return d.rows.filter(r=>d.risk.some(x=>x.id===r.item_id));
    const field={center:"cost_center",activity:"activity_code",requestor:"requestor",item:"item_id"}[mode];
    return d.rows.filter(r=>!filter||String(field==="item_id"?r.item_id:(r[field]||"Tidak disebutkan"))===String(filter));
  }
  function renderBudgetDetail() {
    const d=budgetView.dataset, box=$("#budgetDetail");if(!box||!d)return;
    const mode=budgetView.mode,filter=budgetView.filter;
    const rows=budgetRowsFor(mode,filter);
    const options=mode==="center"?d.byCenter.map(x=>[x.name,x.name]):mode==="activity"?d.byActivity.map(x=>[x.name,x.name]):mode==="requestor"?d.byRequestor.map(x=>[x.name,x.name]):mode==="item"?d.byItem.map(x=>[x.id,`${x.code} · ${x.description}`]):[];
    box.innerHTML=`<div class="bd-detail-head"><div><h3>Telusuri: ${bdModes[mode]}</h3><span class="muted small">${fmt(rows.length)} baris PR · ${money(rows.reduce((v,r)=>v+r.amount_num,0))} nilai Budget System</span></div><div class="bd-controls"><select id="bdMode" aria-label="Jenis rincian">${Object.entries(bdModes).map(([k,v])=>`<option value="${k}" ${k===mode?"selected":""}>${v}</option>`).join("")}</select>${options.length?`<select id="bdFilter" aria-label="Filter rincian"><option value="">Semua ${bdModes[mode]}</option>${options.map(([v,n])=>`<option value="${esc(v)}" ${String(v)===String(filter)?"selected":""}>${esc(n)}</option>`).join("")}</select>`:""}</div></div>
      <div class="bd-table-scroll"><table class="tbl bd-table"><thead><tr><th>Item</th><th>Slip</th><th>Cost center</th><th>Activity</th><th>Requestor</th><th class="num">Qty PR</th><th class="num">Nilai PR</th><th>SAP</th></tr></thead><tbody>${rows.slice(0,150).map(r=>`<tr><td><button type="button" class="bd-item" data-bd-item="${r.item_id}">${esc(r.code)}</button></td><td>${esc(r.slip_no)} / ${esc(r.line_no??"–")}</td><td>${esc(r.cost_center||"–")}</td><td>${esc(r.activity_code||"–")}</td><td>${esc(r.requestor||"–")}</td><td class="num">${fmt(r.qty_num)} ${esc(r.uom||"")}</td><td class="num">${money(r.amount_num)}</td><td>${r.linked?`<span class="bd-ok">SO ${esc(r.sap_ref)}</span>`:`<span class="bd-warn">Belum terhubung${r.sap_ref?` · ${esc(r.sap_ref)}`:""}</span>`}</td></tr>`).join("")||`<tr><td colspan="8" class="muted">Tidak ada data pada pilihan ini.</td></tr>`}</tbody></table></div>${rows.length>150?`<p class="muted small">Menampilkan 150 dari ${fmt(rows.length)} baris. Gunakan filter untuk mempersempit.</p>`:""}`;
  }
  function budgetGroupTable(groups,mode){return `<div class="bd-list">${groups.slice(0,8).map((g,i)=>`<button type="button" class="bd-rank" data-bd-mode="${mode}" data-bd-filter="${esc(g.name)}"><span class="bd-rank-n">${i+1}</span><span class="bd-rank-label"><b>${esc(g.name)}</b><small>${fmt(g.slips)} slip · ${fmt(g.items)} item</small></span><strong>${money(g.amount)}</strong></button>`).join("")||'<p class="muted small">Belum ada data.</p>'}</div>`}
  function renderBudgetSection(d){
    const root=$("#budgetSection");if(!root)return;
    const max=Math.max(1,...d.byMonth.map(x=>x.slips));
    root.innerHTML=`<div class="bd-head"><div><span class="bd-eyebrow">BUDGET SYSTEM · FY ${state.year}</span><h2>Pemakaian & rekonsiliasi PR</h2><p>Detail permintaan berdasarkan laporan Goods Issued Status. Nilai PR bukan nilai persediaan SAP; kuantitas PR tidak dijumlah ulang ke Actual.</p></div><span class="bd-tag">${fmt(d.rows.length)} baris · ${fmt(d.byItem.length)} item master</span></div>
      <div class="bd-kpis">
      <button type="button" class="bd-kpi" data-bd-mode="center"><small>Nilai menurut Budget System</small><strong>${money(d.totalAmount)}</strong><span>Seluruh baris PR pada item master</span></button>
      <button type="button" class="bd-kpi" data-bd-mode="item"><small>Item dengan permintaan PR</small><strong>${fmt(d.byItem.length)}</strong><span>${fmt(d.rows.length)} baris dari ${fmt(new Set(d.rows.map(x=>x.slip_no)).size)} slip</span></button>
      <button type="button" class="bd-kpi bd-attention" data-bd-mode="unlinked"><small>PR belum terhubung ke SO</small><strong>${fmt(d.unlinked.length)}</strong><span>Perlu rekonsiliasi · bukan Actual baru</span></button>
      <button type="button" class="bd-kpi bd-attention" data-bd-mode="risk"><small>Item di bawah minimum / nol</small><strong>${fmt(d.risk.length)}</strong><span>Memiliki pemakaian PR</span></button></div>
      <div class="bd-grid">
        <section class="bd-card"><h3>Pemakaian per Cost Center</h3><p>Ranking nilai PR · klik untuk rincian item & slip</p>${budgetGroupTable(d.byCenter,"center")}</section>
        <section class="bd-card"><h3>Pemakaian per Activity Code</h3><p>Ranking nilai PR · kuantitas hanya dibandingkan per item</p>${budgetGroupTable(d.byActivity,"activity")}</section>
        <section class="bd-card"><h3>Item paling banyak diminta</h3><p>Peringkat berdasarkan jumlah slip, bukan total kuantitas lintas UOM</p><div class="bd-list">${d.byItem.slice(0,8).map((x,i)=>`<button type="button" class="bd-rank" data-bd-mode="item" data-bd-filter="${x.id}"><span class="bd-rank-n">${i+1}</span><span class="bd-rank-label"><b>${esc(x.code)} · ${esc(x.description)}</b><small>${fmt(x.lines)} baris · ${fmt(x.centers)} cost center</small></span><strong>${fmt(x.slips)} slip</strong></button>`).join("")}</div></section>
        <section class="bd-card"><h3>Sebaran Requestor</h3><p>Frekuensi slip dan nilai PR menurut peminta</p>${budgetGroupTable(d.byRequestor,"requestor")}</section>
        <section class="bd-card bd-wide"><h3>Tren slip per bulan <span class="muted small">berdasarkan tanggal posting SO di SAP · hanya baris PR terhubung</span></h3><div class="bd-chart">${d.byMonth.map(x=>`<div class="bd-bar-col"><b>${x.slips||""}</b><div class="bd-bar-track"><i style="height:${x.slips?Math.max(4,x.slips/max*100):0}%" title="${MONTHS[x.month-1]}: ${fmt(x.slips)} slip · ${money(x.amount)} nilai PR"></i></div><small>${MONTHS[x.month-1]}</small></div>`).join("")}</div></section>
        <section class="bd-card bd-wide"><h3>Cost Center pemakai item yang stoknya di bawah minimum</h3><p>Status stok tetap bersumber dari SAP. Klik item untuk membuka histori dan detail Budget System.</p><div class="bd-table-scroll"><table class="tbl bd-table"><thead><tr><th>Item</th><th>Status</th><th>Cost center pemakai</th><th class="num">Slip PR</th><th class="num">Nilai PR</th></tr></thead><tbody>${d.risk.map(x=>`<tr><td><button class="bd-item" type="button" data-bd-item="${x.id}">${esc(x.code)} · ${esc(x.description)}</button></td><td><span class="chip ${esc(x.status)}">${esc(STATUS_LABEL[x.status]||x.status)}</span></td><td>${esc(x.center_names.join(", "))}</td><td class="num">${fmt(x.slips)}</td><td class="num">${money(x.amount)}</td></tr>`).join("")||'<tr><td colspan="5" class="muted">Tidak ada item PR dengan stok di bawah minimum.</td></tr>'}</tbody></table></div></section>
      </div><section class="bd-card bd-detail" id="budgetDetail"></section><p class="bd-source">Sumber: PR Outstanding List / Goods Issued Status untuk kode item master FY ${state.year}. Pencocokan SO menggunakan kode item + nomor referensi SAP. Tanggal PR pada file sumber bercampur format; tren menggunakan tanggal posting SAP. Outstanding adalah nilai uang, bukan sisa kuantitas.</p>`;
    budgetView.dataset=d;renderBudgetDetail();
  }
  async function loadBudgetDashboard(year){
    const root=$("#budgetSection");if(!root)return;
    try{
      const result=await data().prDashboard(year);
      if(state.year!==year||state.view!=="dash")return;
      if(!result.pr.length){root.innerHTML=`<div class="bd-empty"><h2>Budget System belum memiliki data FY ${year}</h2><p>Jalankan migrasi <code>supabase/003_pr_details.sql</code>, lalu import file PR melalui tombol <b>Import Detail PR</b>.</p></div>`;return;}
      renderBudgetSection(FC.budgetDash.build(result.pr,result.so,state.items));
    }catch(e){if(state.year===year&&state.view==="dash")root.innerHTML=`<div class="bd-empty"><h2>Detail Budget System belum tersedia</h2><p>${esc(e.message)}. Pastikan migrasi <code>003_pr_details.sql</code> sudah dijalankan dan histori SAP tersedia.</p></div>`;}
  }
  async function renderDashboard() {
    const root = $("#dash");
    root.innerHTML = `<div class="loading">Memuat dashboard…</div>`;
    let d;
    try { d = FC.calc.buildDashboard(state.items, state.year); } catch (e) { root.innerHTML = `<div class="loading">Gagal memuat: ${esc(e.message)}</div>`; return; }
    const k = d.kpi;
    const accTxt = k.avg_accuracy === null ? "–" : pct(k.avg_accuracy);
    root.innerHTML = `
      <div class="dash-head"><h2>Dashboard FY ${d.year}</h2><span class="muted small">Status stok memakai End Stock bulan terakhir yang sudah ada data · Akurasi dihitung YTD (hanya bulan yang sudah ada actual${state.sapUntil && state.sapUntil.partial ? `; ${MONTHS[state.sapUntil.month - 1]} parsial s/d tgl ${state.sapUntil.day} tidak dihitung` : ""})</span><button type="button" class="btn primary bh-launch" id="btnBehaviorAnalysis">◉ &nbsp;Analisa User Behavior</button></div>
      <div class="kpis">
        ${kpiCard("Total item", k.total_items, `${k.with_forecast} ada forecast · ${k.with_actual} ada actual`, "", "")}
        ${kpiCard("Di bawah Min", k.below_min, "perlu order", k.below_min ? "red" : "green", "below_min")}
        ${kpiCard("Stok nol / minus", k.zero_stock, "habis", k.zero_stock ? "red" : "green", "zero")}
        ${kpiCard("Di atas Max", k.over_max, "overstock", k.over_max ? "amber" : "green", "over_max")}
        ${kpiCard("Normal", k.ok, "dalam rentang Min–Max", "green", "ok")}
        ${kpiCard("Akurasi rata-rata", accTxt, `${k.accuracy_ge80} dari ${k.accuracy_rated} item ≥ 80%`, k.avg_accuracy === null ? "" : k.avg_accuracy >= 0.8 ? "green" : k.avg_accuracy >= 0.5 ? "amber" : "red", "")}
      </div>
      <div class="dash-grid">
        <div class="card"><h3>Akurasi forecast per bulan <span class="muted">rata-rata semua item yang punya actual</span></h3>${accuracyChart(d.monthly)}</div>
        <div class="card"><h3>Item bermasalah per bulan <span class="muted">berdasarkan End Stock vs Min/Max</span></h3>${statusChart(d.monthly)}</div>
        <div class="card"><h3>Per kategori</h3>${groupTable(d.by_category, "Kategori")}</div>
        <div class="card"><h3>Per user / departemen</h3>${groupTable(d.by_user, "User")}</div>
        <div class="card wide"><h3>Perlu order <span class="muted">${d.need_order.length} item dengan stok di bawah Min</span></h3>${needOrderTable(d.need_order)}</div>
        ${d.over_max.length ? `<div class="card wide"><h3>Overstock <span class="muted">${d.over_max.length} item di atas Max</span></h3>${overMaxTable(d.over_max)}</div>` : ""}
        <div class="card wide"><h3>Akurasi terendah <span class="muted">10 item · hanya bulan yang punya forecast & actual yang dibandingkan</span></h3>${lowAccTable(d.low_accuracy)}</div>
        <div class="card wide"><h3>Heatmap End Stock per bulan <span class="muted">${d.heatmap.length} item dengan data stok</span></h3>${heatmap(d.heatmap)}</div>
      </div><div id="budgetSection" class="budget-section"><div class="loading">Memuat detail Budget System…</div></div>`;
    loadBudgetDashboard(state.year);
    $("#btnBehaviorAnalysis").addEventListener("click",openBehaviorAnalysis);

    $$(".kpi-card.clickable", root).forEach((el) => el.addEventListener("click", () => {
      state.filters.status = el.dataset.status; $("#fStatus").value = el.dataset.status; switchView("grid"); renderGrid();
    }));
    $$("a.code[data-id]", root).forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); jumpToItem(+a.dataset.id); }));
  }

  function jumpToItem(id) {
    state.filters = { q: "", category: "", user: "", status: "" };
    $("#search").value = ""; $("#fCategory").value = ""; $("#fUser").value = ""; $("#fStatus").value = "";
    switchView("grid"); renderGrid();
    const tb = $(`tbody.item[data-id="${id}"]`);
    if (tb) { tb.scrollIntoView({ block: "center" }); tb.style.outline = "3px solid #2563eb"; setTimeout(() => (tb.style.outline = ""), 1600); }
  }

  const kpiCard = (lbl, val, sub, cls, status) =>
    `<div class="kpi-card ${cls} ${status ? "clickable" : ""}" ${status ? `data-status="${status}" title="Klik untuk memfilter tabel"` : ""}><div class="lbl">${lbl}</div><div class="val">${val}</div><div class="sub">${sub}</div></div>`;

  const codeLink = (b) => `<a href="#" class="code" data-id="${b.id}">${esc(b.code)}</a>`;

  function groupTable(rows, label) {
    return `<table class="tbl"><thead><tr><th>${label}</th><th class="num">Item</th><th class="num">Ada forecast</th><th class="num">Ada actual</th><th class="num">&lt; Min</th><th class="num">&gt; Max</th><th class="num">Akurasi</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td><b>${esc(r.name)}</b></td><td class="num">${r.items}</td><td class="num">${r.with_forecast}</td><td class="num">${r.with_actual}</td>
        <td class="num" style="${r.below_min + r.zero ? "color:var(--red);font-weight:700" : ""}">${r.below_min + r.zero}</td><td class="num" style="${r.over_max ? "color:var(--amber);font-weight:700" : ""}">${r.over_max}</td><td class="num">${pct(r.avg_accuracy)}</td></tr>`).join("")}
    </tbody></table>`;
  }

  function needOrderTable(rows) {
    if (!rows.length) return `<p class="muted small">Tidak ada item di bawah Min. 👍</p>`;
    return `<table class="tbl"><thead><tr><th>Kode</th><th>Deskripsi</th><th>UOM</th><th class="num">Stok</th><th class="num">Min</th><th class="num">Max</th><th class="num">Saran order</th><th class="num">Cover</th><th class="num">Lead time</th><th>User</th><th>Status</th></tr></thead><tbody>
      ${rows.map((b) => `<tr><td>${codeLink(b)}</td><td class="desc-cell" title="${esc(b.description)}">${esc(b.description)}</td><td>${esc(b.uom)}</td>
        <td class="num" style="color:var(--red);font-weight:700">${fmt(b.current_stock)}</td><td class="num">${fmt(b.min_stock)}</td><td class="num">${fmt(b.max_stock)}</td>
        <td class="num"><b>${fmt(b.suggested_order)}</b></td><td class="num">${b.months_cover === null ? "–" : nf1.format(b.months_cover) + " bln"}</td>
        <td class="num">${b.lead_time_days ?? "–"}${b.lead_time_days !== null ? " hr" : ""}</td><td>${esc(b.user_dept || "–")}</td><td><span class="chip ${b.status}">${STATUS_LABEL[b.status]}</span></td></tr>`).join("")}
    </tbody></table>`;
  }

  function overMaxTable(rows) {
    return `<table class="tbl"><thead><tr><th>Kode</th><th>Deskripsi</th><th>UOM</th><th class="num">Stok</th><th class="num">Max</th><th class="num">Kelebihan</th><th class="num">Cover</th><th>User</th></tr></thead><tbody>
      ${rows.map((b) => `<tr><td>${codeLink(b)}</td><td class="desc-cell">${esc(b.description)}</td><td>${esc(b.uom)}</td><td class="num" style="color:var(--amber);font-weight:700">${fmt(b.current_stock)}</td><td class="num">${fmt(b.max_stock)}</td>
        <td class="num">${fmt(b.current_stock - b.max_stock)}</td><td class="num">${b.months_cover === null ? "–" : nf1.format(b.months_cover) + " bln"}</td><td>${esc(b.user_dept || "–")}</td></tr>`).join("")}
    </tbody></table>`;
  }

  function lowAccTable(rows) {
    if (!rows.length) return `<p class="muted small">Belum ada item dengan data actual dan forecast untuk dinilai.</p>`;
    return `<table class="tbl"><thead><tr><th>Kode</th><th>Deskripsi</th><th class="num">Bulan dibandingkan</th><th class="num">Forecast</th><th class="num">Actual</th><th class="num">Variance</th><th class="num">Var %</th><th class="num">Akurasi</th></tr></thead><tbody>
      ${rows.map((b) => `<tr><td>${codeLink(b)}</td><td class="desc-cell">${esc(b.description)}</td><td class="num">${b.months_compared}</td><td class="num">${fmt(b.ytd_forecast)}</td><td class="num">${fmt(b.ytd_actual_cmp)}</td>
        <td class="num" style="color:${b.variance > 0 ? "var(--red)" : "var(--ink-2)"}">${b.variance > 0 ? "+" : ""}${fmt(b.variance)}</td><td class="num">${pct(b.variance_pct)}</td>
        <td class="num"><span class="acc-bar ${b.accuracy >= 0.8 ? "" : b.accuracy >= 0.5 ? "mid" : "low"}"><i style="width:${Math.round(b.accuracy * 100)}%"></i></span>${pct(b.accuracy)}</td></tr>`).join("")}
    </tbody></table>`;
  }

  function heatmap(rows) {
    if (!rows.length) return `<p class="muted small">Belum ada data stok.</p>`;
    return `<div style="overflow:auto"><table class="heat"><thead><tr><th style="text-align:left">Item</th>${MONTHS.map((m) => `<th>${m}</th>`).join("")}</tr></thead><tbody>
      ${rows.map((r) => `<tr><td class="lbl"><b>${esc(r.code)}</b> <span class="muted">${esc(r.description)}</span></td>
        ${r.cells.map((c, i) => `<td class="h ${c.status} ${c.future ? "future" : ""}" title="${MONTHS[i]}: ${fmt(r.end_stock[i])} ${esc(r.uom)} – ${STATUS_LABEL[c.status]}${c.future ? " (belum ada data)" : ""}">${fmt(r.end_stock[i])}</td>`).join("")}</tr>`).join("")}
    </tbody></table></div>
    <div class="heat-legend"><span><i style="background:#bbf7d0"></i>Normal</span><span><i style="background:#fecaca"></i>Di bawah Min</span><span><i style="background:#f87171"></i>Nol / minus</span><span><i style="background:#fde68a"></i>Di atas Max</span><span><i style="background:#f3f4f6;opacity:.6"></i>Transparan = bulan belum ada data</span></div>`;
  }

  // simple SVG charts -----------------------------------------------------
  function accuracyChart(monthly) {
    const W = 560, H = 210, P = { l: 40, r: 10, t: 34, b: 26 };
    const cw = (W - P.l - P.r) / 12;
    const y = (v) => P.t + (1 - v) * (H - P.t - P.b);
    let s = `<svg class="chart" viewBox="0 0 ${W} ${H}">`;
    for (const g of [0, .25, .5, .75, 1]) s += `<line x1="${P.l}" x2="${W - P.r}" y1="${y(g)}" y2="${y(g)}" stroke="#e5e7eb"/><text x="${P.l - 6}" y="${y(g) + 4}" font-size="10" text-anchor="end" fill="#6b7280">${g * 100}%</text>`;
    s += `<line x1="${P.l}" x2="${W - P.r}" y1="${y(.8)}" y2="${y(.8)}" stroke="#059669" stroke-dasharray="4 3"/><text x="${W - P.r}" y="${y(.8) - 4}" font-size="10" text-anchor="end" fill="#059669">target 80%</text>`;
    monthly.forEach((m, i) => {
      const x = P.l + i * cw;
      if (m.avg_accuracy !== null) {
        const v = m.avg_accuracy, col = v >= .8 ? "#059669" : v >= .5 ? "#d97706" : "#dc2626";
        s += `<rect x="${x + cw * .2}" y="${y(v)}" width="${cw * .6}" height="${y(0) - y(v)}" rx="3" fill="${col}"><title>${m.label}: ${pct(v)} (${m.items_with_actual} item)</title></rect>`;
        s += `<text x="${x + cw / 2}" y="${y(v) - 4}" font-size="10" text-anchor="middle" fill="#374151">${Math.round(v * 100)}</text>`;
      }
      s += `<text x="${x + cw / 2}" y="${H - 8}" font-size="11" text-anchor="middle" fill="#4b5563">${m.label}</text>`;
    });
    return s + `</svg>`;
  }

  function statusChart(monthly) {
    const W = 560, H = 210, P = { l: 34, r: 10, t: 34, b: 26 };
    const cw = (W - P.l - P.r) / 12;
    const max = Math.max(1, ...monthly.map((m) => m.below_min + m.zero + m.over_max));
    const y = (v) => P.t + (1 - v / max) * (H - P.t - P.b);
    let s = `<svg class="chart" viewBox="0 0 ${W} ${H}">`;
    const step = max <= 5 ? 1 : Math.ceil(max / 5);
    for (let g = 0; g <= max; g += step) s += `<line x1="${P.l}" x2="${W - P.r}" y1="${y(g)}" y2="${y(g)}" stroke="#e5e7eb"/><text x="${P.l - 6}" y="${y(g) + 4}" font-size="10" text-anchor="end" fill="#6b7280">${g}</text>`;
    monthly.forEach((m, i) => {
      const x = P.l + i * cw + cw * .2, w = cw * .6;
      let base = 0;
      for (const [key, col, lbl] of [["zero", "#b91c1c", "Nol/minus"], ["below_min", "#f87171", "Di bawah Min"], ["over_max", "#fbbf24", "Di atas Max"]]) {
        const v = m[key];
        if (!v) continue;
        s += `<rect x="${x}" y="${y(base + v)}" width="${w}" height="${y(base) - y(base + v)}" fill="${col}"><title>${m.label} – ${lbl}: ${v} item</title></rect>`;
        base += v;
      }
      if (base) s += `<text x="${x + w / 2}" y="${y(base) - 4}" font-size="10" text-anchor="middle" fill="#374151">${base}</text>`;
      s += `<text x="${x + w / 2}" y="${H - 8}" font-size="11" text-anchor="middle" fill="#4b5563">${m.label}</text>`;
    });
    s += `<g font-size="10" fill="#4b5563"><rect x="${W - 250}" y="2" width="9" height="9" fill="#b91c1c"/><text x="${W - 238}" y="10">Nol/minus</text><rect x="${W - 176}" y="2" width="9" height="9" fill="#f87171"/><text x="${W - 164}" y="10">Di bawah Min</text><rect x="${W - 88}" y="2" width="9" height="9" fill="#fbbf24"/><text x="${W - 76}" y="10">Di atas Max</text></g>`;
    return s + `</svg>`;
  }

  // ------------------------------------------------------------------ views / wiring
  function switchView(view) {
    state.view = view;
    $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === view));
    $("#viewGrid").hidden = view !== "grid";
    $("#viewDash").hidden = view !== "dash";
    if (view === "dash") renderDashboard();
  }

  async function changeYear(y) {
    state.year = y;
    localStorage.setItem("fc.year", y);
    await reload();
  }

  // ------------------------------------------------------------------ export / template (client-side ExcelJS)
  async function exportExcel() {
    toast("Menyusun file Excel…");
    try {
      const blob = await FC.master.exportWorkbook(state.items, state.year, state.meta.company, state.meta.title);
      downloadBlob(blob, `Master_Forecast_FY${state.year}.xlsx`);
    } catch (e) { toast("Export gagal: " + e.message, "err"); }
  }
  async function downloadTemplate() {
    try { downloadBlob(await FC.master.templateWorkbook(), "Template_Forecast.xlsx"); }
    catch (e) { toast("Gagal: " + e.message, "err"); }
  }

  // ------------------------------------------------------------------ import history / password
  async function openHistory() {
    const body = $("#historyBody");
    body.innerHTML = `<div class="loading">Memuat…</div>`;
    $("#historyDialog").showModal();
    try {
      const rows = await data().importLogs(30);
      if (!rows.length) { body.innerHTML = `<p class="muted small">Belum ada import.</p>`; return; }
      const when = (iso) => new Date(iso).toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" });
      const summary = (r) => {
        const o = r.options || {}, x = r.result || {};
        if (r.format === "sap") return `Actual/Incoming ${MONTHS[(o.from_month || 1) - 1]}–${MONTHS[(o.to_month || 12) - 1]} FY ${o.year} · cakupan ${o.scope || "existing"} · ${x.updated || 0} diperbarui, ${x.created || 0} baru` + (x.opening_set ? `, ${x.opening_set} stok awal` : "");
        return `Master FY ${o.year} · mode ${o.mode || "upsert"} · ${x.created || 0} baru, ${x.updated || 0} diperbarui`;
      };
      body.innerHTML = `<table class="tbl compact hist-table"><thead><tr><th>Waktu</th><th>User</th><th>Format</th><th>File</th><th>Ringkasan</th></tr></thead><tbody>
        ${rows.map((r) => `<tr><td>${when(r.created_at)}</td><td>${esc(displayUser(r.user_email) || "–")}</td><td>${r.format === "sap" ? "SAP Posting List" : "Master"}</td><td>${esc(r.filename || "–")}</td><td>${esc(summary(r))}</td></tr>`).join("")}
      </tbody></table>`;
    } catch (e) { body.innerHTML = `<p class="form-error">${esc(e.message)}</p>`; }
  }

  async function submitPassword() {
    const form = $("#passwordForm");
    const p1 = form.elements.password.value, p2 = form.elements.password2.value;
    if (p1 !== p2) { showFormError("#passwordError", "Password tidak sama"); return; }
    try {
      await data().auth.updatePassword(p1);
      $("#passwordDialog").close();
      toast("Password diperbarui", "ok");
    } catch (e) { showFormError("#passwordError", e.message); }
  }

  // ------------------------------------------------------------------ auth / login screen
  function showLogin(show) {
    $("#loginScreen").hidden = !show;
    document.body.classList.toggle("locked", show);
    if (show) { $("#loginError").hidden = true; setTimeout(() => $("#loginForm").elements.email.focus(), 30); }
  }

  // Login memakai username: Supabase Auth butuh identitas berbentuk email, jadi
  // "budi" dipetakan ke "budi@<LOGIN_DOMAIN>" (domain internal, tidak perlu mailbox nyata).
  const loginDomain = () => ((window.FC_CONFIG && window.FC_CONFIG.LOGIN_DOMAIN) || "forecast.local").replace(/^@/, "").toLowerCase();
  function toLoginEmail(v) {
    v = (v || "").trim().toLowerCase();
    return v.includes("@") ? v : `${v}@${loginDomain()}`;
  }
  function displayUser(email) {
    if (!email) return "";
    const suffix = "@" + loginDomain();
    return email.toLowerCase().endsWith(suffix) ? email.slice(0, -suffix.length) : email;
  }

  async function submitLogin() {
    const form = $("#loginForm");
    const username = form.elements.email.value.trim();
    if (!username) { showFormError("#loginError", "Isi username terlebih dahulu"); return; }
    if (!username.includes("@") && !/^[a-z0-9._-]+$/i.test(username)) { showFormError("#loginError", "Username hanya boleh huruf, angka, titik, garis bawah, atau strip"); return; }
    $("#btnLogin").disabled = true;
    $("#loginError").hidden = true;
    try {
      const res = await data().auth.signIn(toLoginEmail(username), form.elements.password.value);
      form.elements.password.value = "";
      await onSignedIn(res.session || (await data().auth.session()));
    } catch (e) { showFormError("#loginError", e.message); }
    finally { $("#btnLogin").disabled = false; }
  }

  /** Admin users (menu ⋯: rollover, template, pengaturan, riwayat import). Configurable via FC_CONFIG.ADMIN_USERS. */
  function isAdmin(email) {
    const admins = ((window.FC_CONFIG && window.FC_CONFIG.ADMIN_USERS) || ["anggit"]).map((u) => String(u).trim().toLowerCase()).filter(Boolean);
    const name = displayUser(email).toLowerCase();
    return admins.includes(name) || admins.includes((email || "").toLowerCase());
  }

  function applyUserUI(session) {
    const email = session && session.user ? session.user.email : "";
    const name = displayUser(email);
    $("#topUser").textContent = name.toUpperCase();
    $("#btnUser").hidden = !name;
    $("#btnUser").title = email ? `Login sebagai ${email}` : "Akun";
    const admin = !!email && isAdmin(email);
    $("#btnMore").hidden = !admin;                 // menu ⋯ hanya untuk admin
    if (!admin) $("#moreMenu").hidden = true;
    document.body.classList.toggle("is-admin", admin);
  }

  async function onSignedIn(session) {
    applyUserUI(session);
    showLogin(false);
    try { await reload(); } catch (e) { toast("Gagal memuat data: " + e.message, "err"); }
  }

  async function logout() {
    await data().auth.signOut();
    applyUserUI(null);
    state.items = []; state.byId = new Map(); state.meta = null;
    $$("#grid tbody").forEach((tb) => tb.remove());
    showLogin(true);
  }

  function wire() {
    bindGridEvents();
    $$(".tab").forEach((t) => t.addEventListener("click", () => switchView(t.dataset.view)));

    $("#yearSelect").addEventListener("change", async (e) => {
      if (e.target.value === "__new") {
        e.target.value = state.year;
        const form = $("#yearForm");
        form.elements.year.value = state.year + 1;
        $("#yearDialog").showModal();
        form.elements.year.focus(); form.elements.year.select();
      } else await changeYear(+e.target.value);
    });
    bindForm("#yearForm", async () => {
      const n = parseInt($("#yearForm").elements.year.value, 10);
      if (!n || n < 2000 || n > 2100) return;
      $("#yearDialog").close();
      await changeYear(n);
    });

    let searchTimer;
    $("#search").addEventListener("input", (e) => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { state.filters.q = e.target.value.trim(); renderGrid(); }, 120); });
    $("#fCategory").addEventListener("change", (e) => { state.filters.category = e.target.value; renderGrid(); });
    $("#fUser").addEventListener("change", (e) => { state.filters.user = e.target.value; renderGrid(); });
    $("#fStatus").addEventListener("change", (e) => { state.filters.status = e.target.value; renderGrid(); });
    $("#btnClearFilter").addEventListener("click", () => {
      state.filters = { q: "", category: "", user: "", status: "" };
      $("#search").value = ""; $("#fCategory").value = ""; $("#fUser").value = ""; $("#fStatus").value = "";
      renderGrid();
    });

    $("#btnAdd").addEventListener("click", () => openItemDialog());
    $("#btnImportItems").addEventListener("click", openNewItemsDialog);
    $("#btnNewItemsTemplate").addEventListener("click", downloadNewItemsTemplate);
    $("#newItemsForm").elements.file.addEventListener("change", e => inspectNewItems(e.target.files[0]));
    bindForm("#newItemsForm", submitNewItems);
    bindForm("#itemForm", submitItemForm);
    $("#btnDeleteItem").addEventListener("click", () => { const it = state.byId.get(+$("#itemForm").dataset.id); if (it) deleteItem(it); });

    $("#btnImport").addEventListener("click", openImportDialog);
    $("#btnImportPR").addEventListener("click", openPRImport);
    $("#prImportForm").elements.file.addEventListener("change", e=>inspectPR(e.target.files[0]));
    bindForm("#prImportForm", submitPR);
    bindForm("#importForm", submitImport);
    $("#importForm").elements.file.addEventListener("change", (e) => analyzeImportFile(e.target.files[0]));
    wireImportDropZone();
    $("#btnExport").addEventListener("click", exportExcel);
    bindForm("#rolloverForm", submitRollover);
    bindForm("#settingsForm", submitSettings);
    bindForm("#passwordForm", submitPassword);
    $("#txMonth").addEventListener("change", (e) => { txState.month = +e.target.value; renderTx(); });
    $("#txRole").addEventListener("change", (e) => { txState.role = e.target.value; renderTx(); });
    $("#behaviorContent").addEventListener("click",e=>{
      const item=e.target.closest("[data-bh-item]");if(item){const it=state.byId.get(+item.dataset.bhItem);if(it){$("#behaviorDialog").close();openTxDialog(it);}return;}
      const group=e.target.closest("[data-bh-group]");if(group){behaviorState.kind=group.dataset.bhGroup;behaviorState.name=group.dataset.bhName;renderBehavior();$("#behaviorContent").querySelector(".bh-filter")?.scrollIntoView({block:"nearest"});}
    });
    $("#behaviorContent").addEventListener("change",e=>{
      if(e.target.id==="behaviorGroup"){behaviorState.kind=e.target.value;behaviorState.name="";renderBehavior();}
      if(e.target.id==="behaviorName"){behaviorState.name=e.target.value;renderBehavior();}
    });
    $("#dash").addEventListener("click",e=>{
      const item=e.target.closest("[data-bd-item]");if(item){const it=state.byId.get(+item.dataset.bdItem);if(it)openTxDialog(it);return;}
      const rank=e.target.closest("[data-bd-mode]");if(rank){budgetView.mode=rank.dataset.bdMode;budgetView.filter=rank.dataset.bdFilter||"";renderBudgetDetail();$("#budgetDetail")?.scrollIntoView({behavior:"smooth",block:"nearest"});}
    });
    $("#dash").addEventListener("change",e=>{
      if(e.target.id==="bdMode"){budgetView.mode=e.target.value;budgetView.filter="";renderBudgetDetail();}
      if(e.target.id==="bdFilter"){budgetView.filter=e.target.value;renderBudgetDetail();}
    });
    $("#btnTxExport").addEventListener("click", exportTx);
    $("#txBody").addEventListener("click",e=>{
      const tab=e.target.closest("[data-tx-view]");
      if(tab){txState.view=tab.dataset.txView;renderTx();$("#txBody").scrollTop=0;return;}
      const btn=e.target.closest("[data-pr-index]");
      if(btn){txState.selectedPR=+btn.dataset.prIndex;openPRDetail(txState.selectedPR);}
    });
    bindForm("#loginForm", submitLogin);
    if (window.FC_CONFIG && window.FC_CONFIG.PASSWORD_RESET) {
      $("#btnForgot").hidden = false;
      $("#loginNote").textContent = "Akun dibuat oleh admin.";
    }
    $("#btnForgot").addEventListener("click", async () => {
      const email = toLoginEmail($("#loginForm").elements.email.value);
      if (!email.split("@")[0]) { showFormError("#loginError", "Isi username/email terlebih dahulu, lalu klik 'Lupa password?'"); return; }
      try { await data().auth.resetPassword(email); toast("Link reset password dikirim ke " + email, "ok"); }
      catch (e) { showFormError("#loginError", e.message); }
    });

    const menu = $("#moreMenu"), userMenu = $("#userMenu");
    $("#btnMore").addEventListener("click", (e) => {
      e.stopPropagation(); userMenu.hidden = true;
      if ($("#btnMore").hidden) return;
      menu.hidden = !menu.hidden;
    });
    $("#btnUser").addEventListener("click", (e) => { e.stopPropagation(); menu.hidden = true; userMenu.hidden = !userMenu.hidden; });
    document.addEventListener("click", () => { menu.hidden = true; userMenu.hidden = true; });
    const onMenuAct = (e) => {
      const b = e.target.closest("button[data-act]");
      if (!b) return;
      menu.hidden = true; userMenu.hidden = true;
      const act = b.dataset.act;
      if (["rollover", "template", "settings", "history"].includes(act) && !document.body.classList.contains("is-admin")) { toast("Menu ini hanya untuk admin", "err"); return; }
      if (act === "rollover") openRolloverDialog();
      if (act === "template") downloadTemplate();
      if (act === "settings") openSettingsDialog();
      if (act === "history") openHistory();
      if (act === "password") { $("#passwordForm").reset(); $("#passwordError").hidden = true; $("#passwordDialog").showModal(); }
      if (act === "logout") logout();
    };
    menu.addEventListener("click", onMenuAct);
    userMenu.addEventListener("click", onMenuAct);

    $$("dialog [data-close]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));
    $$("dialog").forEach((d) => d.addEventListener("click", (e) => { if (e.target === d) d.close(); }));

    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "/") { e.preventDefault(); $("#search").focus(); }
    });
  }

  async function init() {
    wire();
    const cfg = window.FC_CONFIG || {};
    // Judul & perusahaan di form login: pakai nilai terakhir dari Pengaturan (disimpan di browser
    // setelah login), kalau belum ada pakai config.js.
    const bootTitle = localStorage.getItem("fc.title") || cfg.TITLE || "Inventory Management System – Stock Items";
    const bootCompany = localStorage.getItem("fc.company") ?? (cfg.COMPANY || "");
    $("#loginTitle").textContent = titleCase(bootTitle);
    $("#loginCompany").textContent = bootCompany;
    $("#appTitle").textContent = titleCase(bootTitle);
    $("#appCompany").textContent = bootCompany;
    document.title = titleCase(bootTitle);
    if (!data().configured()) {
      $("#loginForm").hidden = true; $("#setupNotice").hidden = false; showLogin(true);
      return;
    }
    try {
      const session = await data().auth.session();
      if (session) await onSignedIn(session); else showLogin(true);
      data().auth.onChange((event, sess) => {
        if (event === "SIGNED_OUT") { applyUserUI(null); showLogin(true); }
        else if (event === "PASSWORD_RECOVERY") { showLogin(false); $("#passwordForm").reset(); $("#passwordDialog").showModal(); }
        else if (event === "SIGNED_IN" && sess && $("#loginScreen").hidden === false && !$("#btnLogin").disabled) onSignedIn(sess);
      });
    } catch (e) {
      showLogin(true);
      showFormError("#loginError", e.message);
    }
  }

  init();
})();
