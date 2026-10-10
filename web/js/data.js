/* =====================================================================
   Data layer: Supabase (Postgres + Auth) via supabase-js.
   Mirrors the shapes the old FastAPI endpoints returned so the UI code
   (app.js) stays almost unchanged.
   ===================================================================== */
(function () {
  "use strict";
  const cfg = window.FC_CONFIG || {};
  const calc = () => window.FC.calc;
  let sb = null;

  function configured() {
    return !!(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && !/YOUR-PROJECT|YOUR_ANON_KEY/i.test(cfg.SUPABASE_URL + cfg.SUPABASE_ANON_KEY));
  }
  function client() {
    if (!sb) {
      if (!configured()) throw new Error("Supabase belum dikonfigurasi. Isi SUPABASE_URL dan SUPABASE_ANON_KEY di web/config.js (atau environment Netlify).");
      sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
    }
    return sb;
  }

  /** Translate Supabase / PostgREST errors into friendly Indonesian messages. */
  function friendly(err, ctx) {
    if (!err) return new Error("Terjadi kesalahan");
    const msg = err.message || String(err);
    if (err.code === "23505" || /duplicate key/i.test(msg)) return new Error(ctx && ctx.code ? `Kode item '${ctx.code}' sudah ada` : "Data duplikat: kode item sudah dipakai");
    if (err.code === "42501" || /row-level security|permission denied/i.test(msg)) return new Error("Tidak punya izin — silakan login ulang");
    if (/JWT expired|invalid claim|not authenticated/i.test(msg)) return new Error("Sesi berakhir — silakan login ulang");
    if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return new Error("Tidak bisa terhubung ke Supabase — periksa koneksi internet / URL proyek");
    if (/Invalid login credentials/i.test(msg)) return new Error("Email atau password salah");
    if (/Email not confirmed/i.test(msg)) return new Error("Email belum dikonfirmasi — konfirmasi lewat dashboard Supabase");
    return new Error(msg);
  }
  const unwrap = (res, ctx) => { if (res.error) throw friendly(res.error, ctx); return res.data; };

  // ---------------------------------------------------------------- auth
  const auth = {
    async session() { const { data } = await client().auth.getSession(); return data.session; },
    async signIn(email, password) { return unwrap(await client().auth.signInWithPassword({ email, password })); },
    async signOut() { await client().auth.signOut(); },
    onChange(cb) { return client().auth.onAuthStateChange((event, session) => cb(event, session)); },
    async resetPassword(email) { return unwrap(await client().auth.resetPasswordForEmail(email, { redirectTo: window.location.origin + window.location.pathname })); },
    async updatePassword(password) { return unwrap(await client().auth.updateUser({ password })); },
  };

  // ---------------------------------------------------------------- read
  /** All rows of a query, following PostgREST's max-rows limit in pages of 1000. */
  async function fetchAll(build) {
    const out = [];
    for (let from = 0; ; from += 1000) {
      const data = unwrap(await build().range(from, from + 999));
      out.push(...data);
      if (data.length < 1000) break;
    }
    return out;
  }

  const emptyMonths = () => Array.from({ length: 12 }, () => ({ forecast: null, actual: null, incoming: null }));
  const numOrNull = (v) => (v === null || v === undefined) ? null : Number(v);

  function shapeItem(row, year) {
    const it = {
      id: row.id, code: row.code, category: row.category, description: row.description, uom: row.uom,
      min_stock: Number(row.min_stock), max_stock: Number(row.max_stock), lead_time_days: row.lead_time_days,
      user_dept: row.user_dept, created_at: row.created_at, updated_at: row.updated_at,
      opening_stock: 0, months: emptyMonths(),
    };
    for (const y of row.item_years || []) if (y.year === year) it.opening_stock = Number(y.opening_stock);
    for (const m of row.monthly || []) if (m.year === year && m.month >= 1 && m.month <= 12) {
      it.months[m.month - 1] = { forecast: numOrNull(m.forecast), actual: numOrNull(m.actual), incoming: numOrNull(m.incoming) };
    }
    return calc().computeItem(it);
  }
  const SELECT = "*, item_years(year, opening_stock), monthly(year, month, forecast, actual, incoming)";
  const sortItems = (arr) => arr.sort((a, b) => a.category.localeCompare(b.category, undefined, { sensitivity: "base" }) || a.code.localeCompare(b.code, undefined, { sensitivity: "base", numeric: true }));

  async function items(year) {
    const rows = await fetchAll(() => client().from("items").select(SELECT).eq("item_years.year", year).eq("monthly.year", year).order("category").order("code"));
    return sortItems(rows.map((r) => shapeItem(r, year)));
  }
  async function item(id, year) {
    const row = unwrap(await client().from("items").select(SELECT).eq("id", id).eq("item_years.year", year).eq("monthly.year", year).maybeSingle());
    if (!row) throw new Error("Item tidak ditemukan");
    return shapeItem(row, year);
  }

  async function meta(currentItems) {
    const [yearsRes, settingsRes] = await Promise.all([client().rpc("list_years"), client().from("settings").select("key, value")]);
    const years = new Set((unwrap(yearsRes) || []).map(Number));
    const settings = Object.fromEntries((unwrap(settingsRes) || []).map((r) => [r.key, r.value]));
    const today = new Date();
    const defaultYear = Number(cfg.DEFAULT_YEAR) || today.getFullYear();
    years.add(defaultYear); years.add(today.getFullYear());
    const list = currentItems || (await fetchAll(() => client().from("items").select("category, user_dept, uom")));
    const distinct = (key) => [...new Set(list.map((r) => r[key]).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    return {
      company: settings.company ?? cfg.COMPANY ?? "", title: settings.title ?? cfg.TITLE ?? "Master Forecast Consumption Plan",
      settings,
      default_year: defaultYear, years: [...years].sort((a, b) => a - b),
      categories: distinct("category"), users: distinct("user_dept"), uoms: distinct("uom"),
      today: `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`,
    };
  }

  // ---------------------------------------------------------------- write
  const itemFields = (b) => ({
    code: b.code, category: b.category ?? "", description: b.description, uom: b.uom ?? "",
    min_stock: b.min_stock ?? 0, max_stock: b.max_stock ?? 0, lead_time_days: b.lead_time_days ?? null, user_dept: b.user_dept ?? "",
  });

  async function createItem(body, year) {
    const row = unwrap(await client().from("items").insert(itemFields(body)).select("id").single(), { code: body.code });
    unwrap(await client().from("item_years").upsert({ item_id: row.id, year, opening_stock: body.opening_stock || 0 }, { onConflict: "item_id,year" }));
    return item(row.id, year);
  }
  async function updateItem(id, body, year) {
    unwrap(await client().from("items").update(itemFields(body)).eq("id", id), { code: body.code });
    if (body.opening_stock !== null && body.opening_stock !== undefined) {
      unwrap(await client().from("item_years").upsert({ item_id: id, year, opening_stock: body.opening_stock }, { onConflict: "item_id,year" }));
    }
    return item(id, year);
  }
  async function deleteItem(id) {
    unwrap(await client().from("items").delete().eq("id", id));
    return { ok: true };
  }

  async function applyChanges(payload) {
    return unwrap(await client().rpc("apply_changes", { p: payload }));
  }
  async function setCell(id, code, year, month, field, value) {
    await applyChanges({ year, items: [{ code, create: false, cells: [{ month, [field]: value }] }] });
    return item(id, year);
  }
  async function setRow(id, code, year, field, startMonth, values) {
    const cells = [];
    values.forEach((v, i) => { const m = startMonth + i; if (m <= 12) cells.push({ month: m, [field]: v }); });
    await applyChanges({ year, items: [{ code, create: false, cells }] });
    return item(id, year);
  }
  async function setOpening(id, year, value) {
    unwrap(await client().from("item_years").upsert({ item_id: id, year, opening_stock: value }, { onConflict: "item_id,year" }));
    return item(id, year);
  }
  async function rollover(fromYear, toYear, copyForecast) {
    return unwrap(await client().rpc("rollover_year", { p_from: fromYear, p_to: toYear, p_copy_forecast: !!copyForecast }));
  }
  async function saveSettings({ company, title }) {
    const rows = [];
    if (company !== undefined) rows.push({ key: "company", value: company.trim() });
    if (title !== undefined) rows.push({ key: "title", value: title.trim() });
    if (rows.length) unwrap(await client().from("settings").upsert(rows, { onConflict: "key" }));
    return { ok: true };
  }
  async function setSetting(key, value) {
    unwrap(await client().from("settings").upsert({ key, value: value === null || value === undefined ? null : String(value) }, { onConflict: "key" }));
  }
  async function logImport(entry) {
    try {
      const s = await auth.session();
      await client().from("import_logs").insert({ user_email: s && s.user ? s.user.email : null, ...entry });
    } catch (_) { /* audit log is best-effort */ }
  }
  /** SAP transaction history of one item for a fiscal year (ordered by date, then report order). */
  async function transactions(itemId, year) {
    return fetchAll(() => client().from("transactions").select("id, posting_date, month, seq, doc_type, doc_no, whse, acct_name, rec_qty, iss_qty, uom, balance, role")
      .eq("item_id", itemId).eq("year", year).order("posting_date").order("seq"));
  }
  /** Replace + insert SAP transactions in chunks (first chunk deletes the month range for all codes). */
  async function importTransactions({ rows, codes, year, from_month, to_month }, onProgress) {
    const CHUNK = 1500;
    let inserted = 0, deleted = 0;
    if (!rows.length) {
      const r = unwrap(await client().rpc("import_transactions", { p: { year, from_month, to_month, replace: true, codes, rows: [] } }));
      return { inserted: 0, deleted: r.deleted || 0 };
    }
    for (let i = 0; i < rows.length; i += CHUNK) {
      const p = { year, from_month, to_month, replace: i === 0, codes: i === 0 ? codes : [], rows: rows.slice(i, i + CHUNK) };
      const r = unwrap(await client().rpc("import_transactions", { p }));
      inserted += r.inserted || 0; deleted += r.deleted || 0;
      if (onProgress) onProgress(Math.min(rows.length, i + CHUNK), rows.length);
    }
    return { inserted, deleted };
  }
  async function prDashboard(year) {
    const [pr, so] = await Promise.all([
      fetchAll(() => client().from("pr_details").select("item_id,source_row,slip_no,line_no,pr_date,cost_center,order_cost_center,activity_code,requestor,quantity,uom,amount,outstanding_amount,sap_ref,sap_qty").eq("year",year).order("source_row")),
      fetchAll(() => client().from("transactions").select("item_id,doc_no,iss_qty,posting_date").eq("year",year).eq("doc_type","SO").order("id"))
    ]);
    return {pr,so};
  }
  async function prDetails(itemId, year) {
    return fetchAll(() => client().from("pr_details").select("*").eq("item_id",itemId).eq("year",year).order("source_row"));
  }
  async function importPR(rows, onProgress) {
    for (let i=0;i<rows.length;i+=500) {
      unwrap(await client().from("pr_details").upsert(rows.slice(i,i+500),{onConflict:"source_key,source_row"}));
      if(onProgress) onProgress(Math.min(i+500,rows.length),rows.length);
    }
    return rows.length;
  }
  async function importLogs(limit = 20) {
    return unwrap(await client().from("import_logs").select("*").order("created_at", { ascending: false }).limit(limit));
  }

  window.FC = window.FC || {};
  window.FC.data = { configured, client, auth, meta, items, item, createItem, updateItem, deleteItem, applyChanges, setCell, setRow, setOpening, rollover, saveSettings, setSetting, logImport, importLogs, transactions, importTransactions, prDetails, importPR, prDashboard };
})();
