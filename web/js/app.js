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
    if (state.year === null) {
      const saved = +localStorage.getItem("fc.year");
      state.year = state.meta.years.includes(saved) ? saved : state.meta.default_year;
    }
    $("#appTitle").textContent = titleCase(state.meta.title);
    $("#appCompany").textContent = state.meta.company;
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

  function renderGrid() {
    const table = $("#grid");
    $$("tbody", table).forEach((tb) => tb.remove());
    const cur = currentMonthIdx();
    $$("thead th.c-m", table).forEach((th) => th.classList.toggle("cur", +th.dataset.m === cur));

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
      <tr class="r-actual"><td class="c-label">${ROW_LABEL.actual}</td>${monthCells("actual")}<td class="c-total t-actual" title="Total actual (YTD)"></td></tr>
      <tr class="r-incoming"><td class="c-label">${ROW_LABEL.incoming}</td>${monthCells("incoming")}<td class="c-total t-incoming" title="Total incoming"></td></tr>
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
      </div>`;
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
  }

  function kpiHTML(it) {
    const c = it.calc;
    const uom = it.uom || "";
    const accCls = c.accuracy === null ? "" : c.accuracy >= 0.8 ? "" : c.accuracy >= 0.5 ? "mid" : "low";
    const varCls = c.variance === null ? "" : c.variance > 0 ? "neg" : "";
    const upto = c.last_data_month ? `<small class="muted">(s/d ${MONTHS[c.last_data_month - 1]})</small>` : "";
    return `
      <div class="status-badge ${c.status}" title="${STATUS_LABEL[c.status]}">${STATUS_LABEL[c.status]}</div>
      <dl class="kpi-list">
        <dt>Stok saat ini</dt><dd>${fmt(c.current_stock)} ${upto}</dd>
        <dt title="Rata-rata forecast per bulan">Avg/bln</dt><dd>${fmt(c.avg_forecast)}</dd>
        <dt>Peak</dt><dd>${c.peak_month ? `${MONTHS[c.peak_month - 1]} · ${fmt(c.peak_qty)}` : "–"}</dd>
        <dt title="Forecast pada ${c.months_compared} bulan yang sudah punya forecast & actual">Fcst YTD</dt><dd>${fmt(c.ytd_forecast)}</dd>
        <dt title="Actual − Forecast (${c.months_compared} bulan dibandingkan)">Var YTD</dt><dd class="${varCls}">${c.variance === null ? "–" : `${c.variance > 0 ? "+" : ""}${fmt(c.variance)} <small>(${pct(c.variance_pct)})</small>`}</dd>
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
    const toDefault = pv.last_complete_month || Math.max(1, ...pv.months_with_data);
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
        <div class="pv-info">Bulan terakhir yang lengkap: <b>${pv.last_complete_month ? MONTHS[pv.last_complete_month - 1] : "–"}</b>. Bulan “parsial” berarti data SAP belum sampai akhir bulan — sebaiknya jangan diimpor dulu.</div>
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
    try {
      let res;
      if (pv.format === "sap") {
        const { payload, stats } = FC.sap.buildPayload(importState.parsed, options, state.items);
        const r = await data().applyChanges(payload);
        res = { ...stats, created: r.created, updated: r.updated, format: "sap", year };
      } else {
        const payload = FC.master.buildPayload(importState.parsed, options);
        const r = await data().applyChanges(payload);
        res = { created: r.created, updated: r.updated, total: pv.items_total, format: "master", year };
      }
      data().logImport({ format: res.format, filename: file.name, options, result: res });
      $("#importDialog").close();
      state.year = year;
      localStorage.setItem("fc.year", year);
      await loadItems();
      await loadMeta();
      if (res.format === "sap") {
        toast(`Import SAP selesai: ${res.updated || 0} item diperbarui, ${res.created || 0} item baru, ${MONTHS[res.from_month - 1]}–${MONTHS[res.to_month - 1]} FY ${res.year}` + (res.opening_set ? `, ${res.opening_set} stok awal` : ""), "ok");
      } else {
        toast(`Import selesai: ${res.created} item baru, ${res.updated} diperbarui (FY ${res.year})`, "ok");
      }
    } catch (err) { showFormError("#importError", err.message); }
    finally { $("#btnDoImport").disabled = false; }
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
  async function renderDashboard() {
    const root = $("#dash");
    root.innerHTML = `<div class="loading">Memuat dashboard…</div>`;
    let d;
    try { d = FC.calc.buildDashboard(state.items, state.year); } catch (e) { root.innerHTML = `<div class="loading">Gagal memuat: ${esc(e.message)}</div>`; return; }
    const k = d.kpi;
    const accTxt = k.avg_accuracy === null ? "–" : pct(k.avg_accuracy);
    root.innerHTML = `
      <div class="dash-head"><h2>Dashboard FY ${d.year}</h2><span class="muted small">Status stok memakai End Stock bulan terakhir yang sudah ada data · Akurasi dihitung YTD (hanya bulan yang sudah ada actual)</span></div>
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
      </div>`;

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

  async function onSignedIn(session) {
    $("#userEmail").textContent = session && session.user ? displayUser(session.user.email) : "";
    showLogin(false);
    try { await reload(); } catch (e) { toast("Gagal memuat data: " + e.message, "err"); }
  }

  async function logout() {
    await data().auth.signOut();
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
    bindForm("#itemForm", submitItemForm);
    $("#btnDeleteItem").addEventListener("click", () => { const it = state.byId.get(+$("#itemForm").dataset.id); if (it) deleteItem(it); });

    $("#btnImport").addEventListener("click", openImportDialog);
    bindForm("#importForm", submitImport);
    $("#importForm").elements.file.addEventListener("change", (e) => analyzeImportFile(e.target.files[0]));
    wireImportDropZone();
    $("#btnExport").addEventListener("click", exportExcel);
    bindForm("#rolloverForm", submitRollover);
    bindForm("#settingsForm", submitSettings);
    bindForm("#passwordForm", submitPassword);
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

    const menu = $("#moreMenu");
    $("#btnMore").addEventListener("click", (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; });
    document.addEventListener("click", () => (menu.hidden = true));
    menu.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-act]");
      if (!b) return;
      menu.hidden = true;
      if (b.dataset.act === "rollover") openRolloverDialog();
      if (b.dataset.act === "template") downloadTemplate();
      if (b.dataset.act === "settings") openSettingsDialog();
      if (b.dataset.act === "history") openHistory();
      if (b.dataset.act === "password") { $("#passwordForm").reset(); $("#passwordError").hidden = true; $("#passwordDialog").showModal(); }
      if (b.dataset.act === "logout") logout();
    });

    $$("dialog [data-close]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));
    $$("dialog").forEach((d) => d.addEventListener("click", (e) => { if (e.target === d) d.close(); }));

    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "/") { e.preventDefault(); $("#search").focus(); }
    });
  }

  async function init() {
    wire();
    const cfg = window.FC_CONFIG || {};
    $("#loginTitle").textContent = titleCase(cfg.TITLE || "Master Forecast Consumption Plan");
    $("#loginCompany").textContent = cfg.COMPANY || "";
    $("#appTitle").textContent = titleCase(cfg.TITLE || "Master Forecast Consumption Plan");
    $("#appCompany").textContent = cfg.COMPANY || "";
    if (!data().configured()) {
      $("#loginForm").hidden = true; $("#setupNotice").hidden = false; showLogin(true);
      return;
    }
    try {
      const session = await data().auth.session();
      if (session) await onSignedIn(session); else showLogin(true);
      data().auth.onChange((event, sess) => {
        if (event === "SIGNED_OUT") showLogin(true);
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
