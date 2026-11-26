// Chart indicators: Gamma levels, GEX 1-10, Key levels, Options ladder, GEX heatmap.
// Options data comes from the frozen levels.json. Market profile and prior highs/lows come from Binance candles.
(function () {
  const $ = (id) => document.getElementById(id);
  const C = { up: "#26a69a", down: "#ef5350", amber: "#f5b942", text: "#8b949e", key: "#9b7bd6", iv: "#4fc3f7", peak: "#ff7ac6", white: "#e6e8ea" };
  const lsGet = (k, f) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : f; } catch (e) { return f; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

  const DEF = {
    gamma: { on: true, expiry: "front", iv: true },
    gex10: { on: false, front: 10, next: 5, all: false },
    key: { on: true, n: 8, far: 3, merge: 0.10, minSrc: 1, dealer: true, profile: true, prior: true, em: true },
    ladder: { on: false },
    heat: { on: false, intensity: 0.6, expiry: "front" }
  };
  const NAMES = { gamma: "Gamma levels", gex10: "GEX 1-10", key: "Key levels", ladder: "Options ladder", heat: "GEX heatmap" };
  const ORDER = ["gamma", "gex10", "key", "ladder", "heat"];
  const SCHEMA = {
    gamma: { fields: [
      { k: "expiry", l: "Expiries", t: "select", o: [["front", "Front expiry"], ["all", "All expiries (30 days)"]] },
      { k: "iv", l: "IV walls (vega)", t: "check" }],
      note: "Peak GEX and IV walls. Dealer sign is OI-based (calls positive, puts negative)." },
    gex10: { fields: [
      { k: "front", l: "Front levels shown", t: "num", min: 0, max: 10, step: 1 },
      { k: "next", l: "Next expiry levels shown", t: "num", min: 0, max: 10, step: 1 },
      { k: "all", l: "Use all expiries instead", t: "check" }],
      note: "Top strikes by absolute net GEX. Green is positive, red is negative." },
    key: { fields: [
      { k: "n", l: "Levels shown", t: "num", min: 1, max: 20, step: 1 },
      { k: "far", l: "How far from price (%)", t: "num", min: 0.2, max: 10, step: 0.1 },
      { k: "merge", l: "Merge levels within (%)", t: "num", min: 0.01, max: 1, step: 0.01 },
      { k: "minSrc", l: "Sources a level needs", t: "num", min: 1, max: 4, step: 1 },
      { k: "dealer", l: "Dealer positioning", t: "check" },
      { k: "profile", l: "Market profile", t: "check" },
      { k: "prior", l: "Prior day, week, month and Monday open", t: "check" },
      { k: "em", l: "Expected move", t: "check" }],
      note: "Tags: CW call wall, PW put wall, FLIP, PEAK, IV+ IV-, POC, VAH, VAL, LVN, nPOC, EM+ EM-, PDH PDL, PWH PWL, PMH PML, MON." },
    ladder: { fields: [], note: "Strike, total GEX and the change since the previous analysis (three times a day). Rows line up with the price axis." },
    heat: { fields: [
      { k: "intensity", l: "Intensity (0 to 1)", t: "num", min: 0.1, max: 1, step: 0.1 },
      { k: "expiry", l: "Expiries", t: "select", o: [["front", "Front expiry"], ["all", "All expiries (30 days)"]] }],
      note: "Soft bands show where gamma concentrates. Red is negative, green is positive." }
  };

  const saved = lsGet("xl_ind", {});
  const cfg = {};
  ORDER.forEach((id) => { cfg[id] = Object.assign({}, DEF[id], saved[id] || {}); });
  const save = () => lsSet("xl_ind", cfg);

  let L = null, price = null, keyList = [], mkt = [], spacing = 10.84, lastExtra = "";
  const fmtAbs = (a) => (a >= 1e6 ? (a / 1e6).toFixed(2) + "M" : a >= 1e3 ? Math.round(a / 1e3) + "K" : String(Math.round(a)));
  const fmtG = (v) => (v < 0 ? "-" : "+") + fmtAbs(Math.abs(v));
  const fp = (n) => Number(n).toFixed(2);
  const hasGex = () => !!(L && Array.isArray(L.gex_strikes) && L.gex_strikes.length);

  // ---------- market profile and prior levels (from Binance candles) ----------
  async function klv(iv, limit) {
    for (const u of ["https://fapi.binance.com/fapi/v1/klines?symbol=XAUUSDT", "https://api.binance.com/api/v3/klines?symbol=PAXGUSDT"]) {
      try {
        const r = await fetch(u + "&interval=" + iv + "&limit=" + limit);
        if (!r.ok) continue;
        const a = await r.json();
        if (Array.isArray(a) && a.length) return a.map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
      } catch (e) { /* next */ }
    }
    return null;
  }
  function profileOf(cs, bin) {
    let lo = Infinity, hi = -Infinity;
    for (const c of cs) { lo = Math.min(lo, c.l); hi = Math.max(hi, c.h); }
    const nb = Math.ceil((hi - lo) / bin) + 1, vol = new Array(nb).fill(0);
    for (const c of cs) {
      const i0 = Math.floor((c.l - lo) / bin), i1 = Math.floor((c.h - lo) / bin), sh = (c.v || 0) / (i1 - i0 + 1);
      for (let i = i0; i <= i1; i++) vol[i] += sh;
    }
    let poc = 0; vol.forEach((v, i) => { if (v > vol[poc]) poc = i; });
    const total = vol.reduce((a, b) => a + b, 0);
    let a = poc, b = poc, acc = vol[poc];
    while (acc < 0.7 * total) {
      const upv = b + 1 < nb ? vol[b + 1] : -1, dn = a - 1 >= 0 ? vol[a - 1] : -1;
      if (upv < 0 && dn < 0) break;
      if (upv >= dn) { b++; acc += upv; } else { a--; acc += dn; }
    }
    return { lo, vol, poc, a, b, pocP: lo + (poc + 0.5) * bin, val: lo + a * bin, vah: lo + (b + 1) * bin };
  }
  function computeMarket(c15, d1, w1, m1, ref) {
    const out = [], bin = Math.max(0.5, ref * 0.0004);
    if (c15 && c15.length > 50) {
      const p = profileOf(c15, bin);
      out.push({ price: p.pocP, tag: "POC", src: "profile" }, { price: p.vah, tag: "VAH", src: "profile" }, { price: p.val, tag: "VAL", src: "profile" });
      const lv = [];
      for (let i = p.a + 1; i < p.b; i++) {
        if (p.vol[i] < p.vol[i - 1] && p.vol[i] <= p.vol[i + 1] && p.vol[i] < 0.5 * p.vol[p.poc]) lv.push(p.lo + (i + 0.5) * bin);
      }
      lv.sort((x, y) => Math.abs(x - ref) - Math.abs(y - ref));
      lv.slice(0, 2).forEach((v) => out.push({ price: v, tag: "LVN", src: "profile" }));
      const days = {};
      c15.forEach((c) => { const d = Math.floor(c.t / 864e5); (days[d] = days[d] || []).push(c); });
      const keys = Object.keys(days).map(Number).sort((a, b) => a - b), today = keys[keys.length - 1];
      let best = null;
      for (const d of keys) {
        if (d === today) continue;
        const pd = profileOf(days[d], bin).pocP;
        const later = c15.filter((c) => Math.floor(c.t / 864e5) > d);
        if (!later.some((c) => c.l <= pd && c.h >= pd) && (best === null || Math.abs(pd - ref) < Math.abs(best - ref))) best = pd;
      }
      if (best !== null) out.push({ price: best, tag: "nPOC", src: "profile" });
    }
    const hl = (arr, a, b) => { if (arr && arr.length > 2) { const c = arr[arr.length - 2]; out.push({ price: c.h, tag: a, src: "prior" }, { price: c.l, tag: b, src: "prior" }); } };
    hl(d1, "PDH", "PDL"); hl(w1, "PWH", "PWL"); hl(m1, "PMH", "PML");
    if (d1) for (let i = d1.length - 1; i >= 0; i--) if (new Date(d1[i].t).getUTCDay() === 1) { out.push({ price: d1[i].o, tag: "MON", src: "prior" }); break; }
    return out;
  }
  async function refreshMarket() {
    try {
      const [c15, d1, w1, m1] = await Promise.all([klv("15m", 480), klv("1d", 40), klv("1w", 4), klv("1M", 3)]);
      mkt = computeMarket(c15, d1, w1, m1, price || (L && L.xauusd_spot_at_analysis) || 3500);
      computeKey(); window.XChart.redraw();
    } catch (e) { /* keep old */ }
  }

  // ---------- key levels ----------
  function computeKey() {
    const k = cfg.key, ref = price || (L && L.xauusd_spot_at_analysis);
    if (!ref) { keyList = []; return; }
    let c = [];
    if (L && k.dealer) {
      const e = cfg.gamma.expiry, add = (p, t, w) => { if (p) c.push({ price: p, tag: t, src: "dealer", w: Math.abs(w || 1) }); };
      if (L.call_wall) add(L.call_wall.price, "CW", L.call_wall.gex);
      if (L.put_wall) add(L.put_wall.price, "PW", L.put_wall.gex);
      add(L.gamma_flip, "FLIP", 1);
      if (L.peak_gex && L.peak_gex[e]) add(L.peak_gex[e].price, "PEAK", L.peak_gex[e].value);
      if (L.iv_wall_above && L.iv_wall_above[e]) add(L.iv_wall_above[e].price, "IV+", 1);
      if (L.iv_wall_below && L.iv_wall_below[e]) add(L.iv_wall_below[e].price, "IV-", 1);
    }
    if (L && k.em && L.expected_move_1sd && L.xauusd_spot_at_analysis) {
      c.push({ price: L.xauusd_spot_at_analysis + L.expected_move_1sd, tag: "EM+", src: "em", w: 0 });
      c.push({ price: L.xauusd_spot_at_analysis - L.expected_move_1sd, tag: "EM-", src: "em", w: 0 });
    }
    mkt.forEach((m) => { if ((m.src === "profile" && k.profile) || (m.src === "prior" && k.prior)) c.push({ price: m.price, tag: m.tag, src: m.src, w: 0 }); });
    c = c.filter((o) => Math.abs(o.price - ref) / ref * 100 <= k.far).sort((a, b) => a.price - b.price);
    const groups = [];
    for (const o of c) {
      const g = groups[groups.length - 1];
      if (g && (o.price - g.last) / o.price * 100 <= k.merge) { g.items.push(o); g.last = o.price; }
      else groups.push({ items: [o], last: o.price });
    }
    let out = groups.map((g) => {
      const dealer = g.items.find((o) => o.src === "dealer"), tags = [];
      g.items.forEach((o) => { if (!tags.includes(o.tag)) tags.push(o.tag); });
      return { price: dealer ? dealer.price : g.items.reduce((a, o) => a + o.price, 0) / g.items.length, tags,
               srcs: new Set(g.items.map((o) => o.src)).size, w: g.items.reduce((a, o) => a + o.w, 0) };
    }).filter((o) => o.srcs >= k.minSrc);
    out.sort((a, b) => b.srcs - a.srcs || b.w - a.w || Math.abs(a.price - ref) - Math.abs(b.price - ref));
    keyList = out.slice(0, k.n).map((o, i) => Object.assign(o, { rank: i + 1 }));
    pushExtras();
  }
  function pushExtras() {
    if (!window.XAlerts || !XAlerts.setExtra) return;
    const ex = keyList.slice(0, 4).map((o) => ({ id: "K" + o.rank, label: "Key " + o.rank + " " + o.tags.join(" "), price: o.price, kind: "key" }));
    if (L) {
      const e = cfg.gamma.expiry;
      if (L.peak_gex && L.peak_gex[e]) ex.push({ id: "peak", label: "Peak GEX", price: L.peak_gex[e].price, kind: "key" });
      if (L.iv_wall_above && L.iv_wall_above[e]) ex.push({ id: "ivUp", label: "IV wall above", price: L.iv_wall_above[e].price, kind: "key" });
      if (L.iv_wall_below && L.iv_wall_below[e]) ex.push({ id: "ivDn", label: "IV wall below", price: L.iv_wall_below[e].price, kind: "key" });
    }
    const sig = JSON.stringify(ex);
    if (sig !== lastExtra) { lastExtra = sig; XAlerts.setExtra(ex); }
  }

  // ---------- layers ----------
  const pxUnit = (cx) => cx.plotH / (cx.hi - cx.lo);
  const gammaLayer = {
    enabled: () => cfg.gamma.on,
    lines() {
      if (!L) return [];
      const e = cfg.gamma.expiry, out = [], pk = L.peak_gex && L.peak_gex[e];
      if (pk) out.push({ price: pk.price, label: "Peak GEX " + fmtG(pk.value), color: C.peak, dash: true, tag: true });
      if (cfg.gamma.iv) {
        const a = L.iv_wall_above && L.iv_wall_above[e], b = L.iv_wall_below && L.iv_wall_below[e];
        if (a) out.push({ price: a.price, label: "IV wall above", color: C.iv, dash: true, tag: true });
        if (b) out.push({ price: b.price, label: "IV wall below", color: C.iv, dash: true, tag: true });
      }
      return out;
    }
  };
  const gex10Layer = {
    enabled: () => cfg.gex10.on,
    lines() {
      if (!L) return [];
      const g = cfg.gex10, out = [];
      const add = (arr, name, n, dash) => (arr || []).slice(0, n).forEach((o) =>
        out.push({ price: o.price, label: name + " #" + o.rank + " " + (o.net_gex < 0 ? "-" : "+") + "$" + fmtAbs(Math.abs(o.net_gex)),
                   color: o.net_gex < 0 ? C.down : C.up, dash }));
      if (g.all) add(L.top_all, "ALL", g.front, false);
      else { add(L.top_front, "FRONT", g.front, false); add(L.top_next, "NEXT", g.next, true); }
      return out;
    }
  };
  const keyLayer = {
    enabled: () => cfg.key.on,
    lines: () => keyList.map((o) => ({ price: o.price, label: o.rank + " " + o.tags.join(" "), color: C.key, dash: true, tag: o.rank <= 3 })),
    draw(cx, ph) {
      if (ph !== "back") return;
      const c = cx.ctx;
      for (const o of keyList) {
        if (o.price < cx.lo || o.price > cx.hi) continue;
        const y0 = cx.y(o.price * 1.0007), y1 = cx.y(o.price * 0.9993);
        c.fillStyle = "rgba(155,123,214," + (o.rank <= 3 ? 0.22 : 0.12) + ")";
        c.fillRect(cx.pr - 70, y0, 70, Math.max(2, y1 - y0));
      }
    }
  };
  const heatLayer = {
    enabled: () => cfg.heat.on && hasGex(),
    draw(cx, ph) {
      if (ph !== "back") return;
      const key = cfg.heat.expiry === "front" ? "front_gex" : "net_gex", c = cx.ctx;
      const arr = L.gex_strikes.filter((s) => s[key] != null && s.strike >= cx.lo - spacing && s.strike <= cx.hi + spacing);
      if (!arr.length) return;
      const mx = Math.max(...arr.map((s) => Math.abs(s[key]))) || 1, bh = Math.max(6, spacing * pxUnit(cx));
      for (const s of arr) {
        const v = s[key], yy = cx.y(s.strike), a = cfg.heat.intensity * 0.6 * Math.abs(v) / mx;
        const rgb = v < 0 ? "239,83,80" : "38,166,154";
        const g = c.createLinearGradient(0, yy - bh, 0, yy + bh);
        g.addColorStop(0, "rgba(" + rgb + ",0)"); g.addColorStop(0.5, "rgba(" + rgb + "," + a.toFixed(3) + ")"); g.addColorStop(1, "rgba(" + rgb + ",0)");
        c.fillStyle = g; c.fillRect(cx.padL, yy - bh, cx.plotW, bh * 2);
      }
      c.font = "10px system-ui, sans-serif"; c.textAlign = "left"; c.textBaseline = "middle"; c.fillStyle = "rgba(139,148,158,0.9)";
      arr.slice().sort((a, b) => Math.abs(b[key]) - Math.abs(a[key])).slice(0, 5).forEach((s) => c.fillText(fp(s.strike) + " " + fmtG(s[key]), cx.padL + 4, cx.y(s.strike)));
    }
  };
  const ladderLayer = {
    enabled: () => cfg.ladder.on && hasGex(),
    panelWidth: (W) => (W < 520 ? 150 : 200),
    draw(cx, ph) {
      if (ph !== "panel") return;
      const c = cx.ctx, x0 = cx.panelX0, w = cx.panelX1 - x0, rows = L.gex_strikes;
      c.beginPath(); c.rect(x0, cx.padT, w, cx.plotH); c.clip();
      c.fillStyle = "#10151c"; c.fillRect(x0, cx.padT, w, cx.plotH);
      const rh = spacing * pxUnit(cx), mx = Math.max(...rows.map((s) => Math.abs(s.net_gex))) || 1;
      let near = null, flipRow = null;
      rows.forEach((s) => {
        if (!near || Math.abs(s.strike - cx.ref) < Math.abs(near.strike - cx.ref)) near = s;
        if (L.gamma_flip && (!flipRow || Math.abs(s.strike - L.gamma_flip) < Math.abs(flipRow.strike - L.gamma_flip))) flipRow = s;
      });
      c.font = "10px system-ui, sans-serif"; c.textBaseline = "middle";
      for (const s of rows) {
        if (s.strike < cx.lo - spacing || s.strike > cx.hi + spacing) continue;
        const yy = cx.y(s.strike), a = 0.15 + 0.6 * Math.abs(s.net_gex) / mx;
        c.fillStyle = (s.net_gex < 0 ? "rgba(239,83,80," : "rgba(38,166,154,") + a.toFixed(2) + ")";
        c.fillRect(x0 + 1, yy - rh / 2 + 1, w - 2, Math.max(2, rh - 2));
        if (s === near) { c.strokeStyle = C.white; c.lineWidth = 1; c.strokeRect(x0 + 1.5, yy - rh / 2 + 1.5, w - 3, Math.max(2, rh - 3)); }
        if (rh >= 12) {
          c.fillStyle = C.white; c.textAlign = "left"; c.fillText(fp(s.strike), x0 + 5, yy);
          c.textAlign = "right"; c.fillText(fmtG(s.net_gex), x0 + w * 0.7, yy);
          if (s.change_1d != null) { c.fillStyle = s.change_1d < 0 ? "#ff9b98" : "#7fe0d5"; c.fillText(fmtG(s.change_1d), x0 + w - 4, yy); }
          else { c.fillStyle = C.text; c.fillText("--", x0 + w - 4, yy); }
        }
        if (s === flipRow) { c.fillStyle = C.amber; c.fillRect(x0 + 1, yy - 6, 26, 12); c.fillStyle = "#0e1116"; c.textAlign = "left"; c.fillText("FLIP", x0 + 3, yy); }
      }
      c.fillStyle = "rgba(16,21,28,0.95)"; c.fillRect(x0, cx.padT, w, 14);
      c.fillStyle = C.text; c.textAlign = "left"; c.fillText("Strike", x0 + 5, cx.padT + 7);
      c.textAlign = "right"; c.fillText("Total", x0 + w * 0.7, cx.padT + 7); c.fillText("Chg", x0 + w - 4, cx.padT + 7);
    }
  };

  // ---------- panel and settings dialogs ----------
  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  let open = false;
  function onChange() { computeKey(); window.XChart.redraw(); buildPanel(); }
  function buildPanel() {
    const p = $("indPanel"); if (!p) return;
    p.innerHTML = "";
    const head = el("button", "ind-head", "Indicators " + (open ? "\u25BE" : "\u25B8"));
    head.type = "button"; head.addEventListener("click", () => { open = !open; buildPanel(); });
    p.appendChild(head);
    if (!open) return;
    ORDER.forEach((id) => {
      const row = el("div", "ind-row"), name = el("span", "ind-name", NAMES[id]);
      const tg = el("button", "ind-tog" + (cfg[id].on ? " on" : ""), cfg[id].on ? "On" : "Off"); tg.type = "button";
      tg.addEventListener("click", () => { cfg[id].on = !cfg[id].on; save(); onChange(); });
      const gr = el("button", "ind-set", "Set"); gr.type = "button";
      gr.addEventListener("click", () => openDialog(id));
      row.append(name, tg, gr); p.appendChild(row);
    });
    if (L && !hasGex()) p.appendChild(el("div", "ind-note", "No GEX data yet, run the workflow."));
    p.appendChild(el("div", "ind-note", "Delayed GLD options data converted to XAUUSD. Levels are estimates."));
  }
  function openDialog(id) {
    const sc = SCHEMA[id], snap = JSON.stringify(cfg[id]), dlg = $("indDialog");
    dlg.hidden = false; dlg.innerHTML = "";
    const box = el("div", "dlg-box"), fields = el("div", "dlg-fields");
    box.appendChild(el("div", "dlg-title", NAMES[id]));
    const set = (k, v) => { cfg[id][k] = v; save(); onChange(); };
    const render = () => {
      fields.innerHTML = "";
      sc.fields.forEach((f) => {
        const lab = el("label", "dlg-f", f.l); let inp;
        if (f.t === "check") { inp = el("input"); inp.type = "checkbox"; inp.checked = !!cfg[id][f.k]; inp.addEventListener("change", () => set(f.k, inp.checked)); }
        else if (f.t === "select") {
          inp = el("select"); f.o.forEach(([v, t]) => { const o = el("option", null, t); o.value = v; inp.appendChild(o); });
          inp.value = cfg[id][f.k]; inp.addEventListener("change", () => set(f.k, inp.value));
        } else {
          inp = el("input"); inp.type = "number"; inp.min = f.min; inp.max = f.max; inp.step = f.step; inp.value = cfg[id][f.k]; inp.setAttribute("inputmode", "decimal");
          inp.addEventListener("change", () => { const v = parseFloat(inp.value); if (!isNaN(v) && v >= f.min && v <= f.max) set(f.k, v); inp.value = cfg[id][f.k]; });
        }
        lab.appendChild(inp); fields.appendChild(lab);
      });
    };
    render();
    box.appendChild(fields);
    if (sc.note) box.appendChild(el("div", "ind-note", sc.note));
    const btns = el("div", "dlg-btns");
    const mk = (t, fn, cls) => { const b = el("button", cls || "", t); b.type = "button"; b.addEventListener("click", fn); btns.appendChild(b); };
    mk("Defaults", () => { cfg[id] = Object.assign({}, DEF[id], { on: cfg[id].on }); save(); render(); onChange(); });
    mk("Revert", () => { cfg[id] = JSON.parse(snap); save(); render(); onChange(); });
    mk("Done", () => { dlg.hidden = true; }, "primary");
    box.appendChild(btns); dlg.appendChild(box);
  }

  // ---------- public API ----------
  window.XInd = {
    setLevels(data) {
      L = data;
      const ks = (L.gex_strikes || []).map((s) => s.strike).sort((a, b) => a - b), d = [];
      for (let i = 1; i < ks.length; i++) d.push(ks[i] - ks[i - 1]);
      if (d.length) { d.sort((a, b) => a - b); spacing = d[Math.floor(d.length / 2)] || spacing; }
      computeKey(); buildPanel(); window.XChart.redraw();
      if (!mkt.length) refreshMarket();
    },
    setPrice(p) {
      const moved = !price || Math.abs(p - price) / price > 0.0005;
      price = p;
      if (moved) { computeKey(); window.XChart.redraw(); }
    }
  };

  [heatLayer, keyLayer, gex10Layer, gammaLayer, ladderLayer].forEach((l) => window.XChart.addLayer(l));
  buildPanel();
  setInterval(refreshMarket, 15 * 60000);
})();
