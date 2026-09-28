/* =====================================================================
   Business calculations (port of calc.py) – runs in the browser.

   End Stock[m] = End Stock[m-1] + Incoming[m] - Actual[m]   (End Stock[0] = Opening Stock)
   Forecast-vs-actual is compared YTD on months that have BOTH figures.
   ===================================================================== */
(function () {
  "use strict";
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
  const num = (v) => (v === null || v === undefined || v === "" ? 0 : Number(v));
  const isNum = (v) => v !== null && v !== undefined && v !== "";
  const round4 = (v) => Math.round(v * 1e4) / 1e4;

  function stockStatus(stock, minStock, maxStock) {
    if (stock === null || stock === undefined) return "none";
    if (stock <= 0) return "zero";
    if (minStock && stock < minStock) return "below_min";
    if (maxStock && stock > maxStock) return "over_max";
    return "ok";
  }

  /** Attach `calc` to an item {opening_stock, min_stock, max_stock, months[12]{forecast,actual,incoming}}. */
  function computeItem(item) {
    const months = item.months;
    const opening = num(item.opening_stock);
    const minStock = num(item.min_stock);
    const maxStock = num(item.max_stock);

    const endStock = [];
    let prev = opening;
    for (const m of months) {
      prev = prev + num(m.incoming) - num(m.actual);
      endStock.push(round4(prev));
    }

    const fcFilled = [];
    months.forEach((m, i) => { if (isNum(m.forecast)) fcFilled.push([i, Number(m.forecast)]); });
    const fyForecast = fcFilled.reduce((s, [, v]) => s + v, 0);
    const avgForecast = fcFilled.length ? fyForecast / fcFilled.length : null;
    let peakMonth = null, peakQty = null;
    if (fcFilled.length) {
      let best = fcFilled[0];
      for (const t of fcFilled) if (t[1] > best[1]) best = t;   // first max wins (like Python max)
      peakMonth = best[0] + 1; peakQty = best[1];
    }

    const actualIdx = [], dataIdx = [];
    months.forEach((m, i) => {
      if (isNum(m.actual)) actualIdx.push(i);
      if (isNum(m.actual) || isNum(m.incoming)) dataIdx.push(i);
    });
    const lastDataMonth = dataIdx.length ? Math.max(...dataIdx) + 1 : null;

    const ytdActual = actualIdx.reduce((s, i) => s + num(months[i].actual), 0);
    const totalIncoming = months.reduce((s, m) => s + num(m.incoming), 0);

    const cmpIdx = actualIdx.filter((i) => isNum(months[i].forecast));
    const ytdForecast = cmpIdx.reduce((s, i) => s + num(months[i].forecast), 0);
    const ytdActualCmp = cmpIdx.reduce((s, i) => s + num(months[i].actual), 0);

    let variance = null, variancePct = null, accuracy = null;
    if (cmpIdx.length) {
      variance = ytdActualCmp - ytdForecast;
      if (ytdForecast) {
        variancePct = variance / ytdForecast;
        accuracy = Math.max(0, 1 - Math.abs(variance) / ytdForecast);
      }
    }

    const monthlyAccuracy = months.map((m) => {
      const f = m.forecast, a = m.actual;
      if (isNum(a) && f) return Math.max(0, 1 - Math.abs(Number(a) - Number(f)) / Number(f));
      return null;
    });

    const hasStockData = dataIdx.length > 0 || opening !== 0;
    const currentStock = hasStockData ? (lastDataMonth ? endStock[lastDataMonth - 1] : opening) : null;
    const status = stockStatus(currentStock, minStock, maxStock);
    let suggestedOrder = 0;
    if (status === "below_min" || status === "zero") {
      const target = maxStock ? maxStock : minStock;
      suggestedOrder = Math.max(0, target - currentStock);
    }
    const monthsCover = (avgForecast && currentStock && currentStock > 0) ? currentStock / avgForecast : null;

    const monthStatus = endStock.map((s, i) => ({
      status: hasStockData ? stockStatus(s, minStock, maxStock) : "none",
      future: lastDataMonth === null || i + 1 > lastDataMonth,
    }));

    item.calc = {
      end_stock: endStock,
      fy_forecast: fyForecast,
      avg_forecast: avgForecast,
      peak_month: peakMonth,
      peak_qty: peakQty,
      ytd_actual: ytdActual,
      ytd_forecast: ytdForecast,
      ytd_actual_cmp: ytdActualCmp,
      months_compared: cmpIdx.length,
      total_incoming: totalIncoming,
      variance, variance_pct: variancePct, accuracy,
      monthly_accuracy: monthlyAccuracy,
      last_data_month: lastDataMonth,
      current_stock: currentStock,
      status,
      suggested_order: suggestedOrder,
      months_cover: monthsCover,
      month_status: monthStatus,
      has_forecast: fcFilled.length > 0,
      has_actual: actualIdx.length > 0,
    };
    return item;
  }

  /** Aggregate KPIs for the dashboard (quantities are never summed across items). */
  function buildDashboard(items, year) {
    for (const it of items) if (!it.calc) computeItem(it);
    const avg = (vals) => { const v = vals.filter((x) => x !== null && x !== undefined); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };

    const group = (key) => {
      const buckets = new Map();
      for (const it of items) {
        const k = String(it[key] || "—").trim() || "—";
        if (!buckets.has(k)) buckets.set(k, { name: k, items: 0, with_forecast: 0, with_actual: 0, below_min: 0, over_max: 0, zero: 0, acc: [] });
        const b = buckets.get(k), c = it.calc;
        b.items += 1;
        b.with_forecast += c.has_forecast ? 1 : 0;
        b.with_actual += c.has_actual ? 1 : 0;
        b.below_min += c.status === "below_min" ? 1 : 0;
        b.over_max += c.status === "over_max" ? 1 : 0;
        b.zero += c.status === "zero" ? 1 : 0;
        b.acc.push(c.accuracy);
      }
      const out = [...buckets.values()].map((b) => { b.avg_accuracy = avg(b.acc); delete b.acc; return b; });
      out.sort((a, b) => (b.items - a.items) || a.name.localeCompare(b.name));
      return out;
    };

    const calcs = items.map((it) => it.calc);
    const kpi = {
      total_items: items.length,
      with_forecast: calcs.filter((c) => c.has_forecast).length,
      with_actual: calcs.filter((c) => c.has_actual).length,
      below_min: calcs.filter((c) => c.status === "below_min").length,
      over_max: calcs.filter((c) => c.status === "over_max").length,
      zero_stock: calcs.filter((c) => c.status === "zero").length,
      ok: calcs.filter((c) => c.status === "ok").length,
      avg_accuracy: avg(calcs.map((c) => c.accuracy)),
      accuracy_ge80: calcs.filter((c) => c.accuracy !== null && c.accuracy >= 0.8).length,
      accuracy_rated: calcs.filter((c) => c.accuracy !== null).length,
    };

    const monthly = [];
    for (let i = 0; i < 12; i++) {
      let below = 0, over = 0, zero = 0;
      for (const c of calcs) {
        const ms = c.month_status[i];
        if (ms.future) continue;
        below += ms.status === "below_min" ? 1 : 0;
        over += ms.status === "over_max" ? 1 : 0;
        zero += ms.status === "zero" ? 1 : 0;
      }
      monthly.push({
        month: i + 1, label: MONTHS[i],
        items_with_actual: items.filter((it) => isNum(it.months[i].actual)).length,
        avg_accuracy: avg(calcs.map((c) => c.monthly_accuracy[i])),
        below_min: below, over_max: over, zero,
      });
    }

    const brief = (it) => {
      const c = it.calc;
      return {
        id: it.id, code: it.code, description: it.description, uom: it.uom, category: it.category, user_dept: it.user_dept,
        min_stock: it.min_stock, max_stock: it.max_stock, lead_time_days: it.lead_time_days,
        current_stock: c.current_stock, status: c.status, suggested_order: c.suggested_order, months_cover: c.months_cover,
        accuracy: c.accuracy, variance: c.variance, variance_pct: c.variance_pct, ytd_actual: c.ytd_actual,
        ytd_forecast: c.ytd_forecast, ytd_actual_cmp: c.ytd_actual_cmp, months_compared: c.months_compared,
        fy_forecast: c.fy_forecast, avg_forecast: c.avg_forecast,
      };
    };

    const needOrder = items.filter((it) => it.calc.status === "below_min" || it.calc.status === "zero").map(brief);
    needOrder.sort((a, b) => ((a.months_cover ?? -1) - (b.months_cover ?? -1)) || String(a.code).localeCompare(String(b.code)));
    const rated = items.filter((it) => it.calc.accuracy !== null).map(brief);
    const lowAccuracy = rated.sort((a, b) => a.accuracy - b.accuracy).slice(0, 10);
    const overMax = items.filter((it) => it.calc.status === "over_max").map(brief);
    const heatmap = items.filter((it) => it.calc.has_actual || it.calc.last_data_month).map((it) => ({
      id: it.id, code: it.code, description: it.description, uom: it.uom, cells: it.calc.month_status, end_stock: it.calc.end_stock,
    }));

    return { year, kpi, by_category: group("category"), by_user: group("user_dept"), monthly, need_order: needOrder, over_max: overMax, low_accuracy: lowAccuracy, heatmap };
  }

  window.FC = window.FC || {};
  window.FC.calc = { MONTHS, computeItem, buildDashboard, stockStatus };
})();
