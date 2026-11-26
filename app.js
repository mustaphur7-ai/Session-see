const $ = (id) => document.getElementById(id);
let L = null, spot = null;

const fmt = (n) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const kenya = (iso) => new Date(iso).toLocaleString("en-GB", {
  timeZone: "Africa/Nairobi", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false
}) + " EAT";

async function loadLevels() {
  try {
    const r = await fetch("levels.json?t=" + Date.now());
    L = await r.json();
    $("analyzed").textContent = (SESSION_NAMES[L.session] ? SESSION_NAMES[L.session] + ", " : "") + kenya(L.analyzed_at);
    $("ratio").textContent = L.gld_ratio;
    const age = (Date.now() - new Date(L.analyzed_at_utc)) / 36e5;
    const b = $("banner");
    if (L.sample) { b.hidden = false; b.textContent = "Sample data. Run the workflow once to load real levels."; }
    else if (age > staleLimit()) { b.hidden = false; b.textContent = "Stale data: the last analysis was " + Math.round(age) + " hours ago."; }
    else b.hidden = true;
    if (window.XChart) XChart.setLevels(L);
    if (window.XAlerts) XAlerts.setLevels(L);
    if (window.XInd) XInd.setLevels(L);
    render();
  } catch (e) {
    $("banner").hidden = false;
    $("banner").textContent = "Could not load levels.json.";
  }
}

// Three analyses a day, Monday to Friday, in UTC: 00:30 (03:30 EAT Asian), 09:00 (12:00 EAT London), 14:33 (17:33 EAT New York).
const SLOTS = [
  { h: 0, m: 30, name: "Asia", eat: "03:30" },
  { h: 9, m: 0, name: "London", eat: "12:00" },
  { h: 14, m: 33, name: "New York", eat: "17:33" }
];
const SESSION_NAMES = { asia: "Asia", london: "London", newyork: "New York" };

function nextRun() {
  const n = new Date(), now = n.getTime();
  const base = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate(), 0, 0, 0);
  for (let i = 0; i < 8; i++) {
    const day = base + i * 864e5, wd = new Date(day).getUTCDay();
    if (wd < 1 || wd > 5) continue;
    for (const s of SLOTS) {
      const t = day + (s.h * 60 + s.m) * 6e4;
      if (t > now) return { t, slot: s };
    }
  }
  return { t: now, slot: SLOTS[0] };
}

// Tuesday to Friday the data should be under 14 hours old (longest gap is 10 hours). Weekend and Monday allow 62 hours.
function staleLimit() {
  const wd = new Date().getUTCDay();
  return wd >= 2 && wd <= 5 ? 14 : 62;
}

function tick() {
  const nx = nextRun();
  $("nextLabel").textContent = "Next: " + nx.slot.name + " " + nx.slot.eat + " EAT";
  let s = Math.max(0, Math.floor((nx.t - Date.now()) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  $("countdown").textContent = h + "h " + String(m).padStart(2, "0") + "m " + String(s % 60).padStart(2, "0") + "s";
}

function render() {
  if (!L) return;
  const rows = {};
  const add = (label, cls, o) => {
    const key = o.price.toFixed(2);
    const r = rows[key] || (rows[key] = { price: o.price, cls, labels: [], oi: o.open_interest });
    r.labels.push(label);
  };
  add("Call wall", "res", L.call_wall);
  add("Put wall", "sup", L.put_wall);
  add("Gamma flip", "flip", { price: L.gamma_flip });
  L.resistances.forEach((o, i) => add("R" + (i + 1), "res", o));
  L.supports.forEach((o, i) => add("S" + (i + 1), "sup", o));
  const list = Object.values(rows).sort((a, b) => b.price - a.price);

  let html = "", placed = spot == null;
  const nowRow = () => '<div class="row now"><span class="name">Price now</span><span class="val">' + fmt(spot) + "</span></div>";
  for (const r of list) {
    if (!placed && r.price < spot) { html += nowRow(); placed = true; }
    const d = spot == null ? null : r.price - spot;
    const dist = d == null ? "" : (d >= 0 ? "+" : "") + fmt(d) + " (" + (d >= 0 ? "+" : "") + ((d / spot) * 100).toFixed(2) + "%)";
    const oi = r.oi ? "Open interest " + r.oi.toLocaleString("en-US") : "";
    html += '<div class="row ' + r.cls + '"><span class="name">' + r.labels.join(" + ") + '</span><span class="val">' + fmt(r.price) +
      '</span><span class="sub">' + oi + '</span><span class="dist">' + dist + "</span></div>";
  }
  if (!placed) html += nowRow();
  $("ladder").innerHTML = html;
}

async function pollSpot() {
  const sources = [
    ["https://fapi.binance.com/fapi/v1/ticker/price?symbol=XAUUSDT", "Binance XAUUSDT"],
    ["https://api.binance.com/api/v3/ticker/price?symbol=PAXGUSDT", "Binance PAXGUSDT"]
  ];
  for (const [url, name] of sources) {
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      spot = parseFloat((await r.json()).price);
      $("price").textContent = fmt(spot);
      if (window.XChart) XChart.setPrice(spot);
      if (window.XAlerts) XAlerts.setPrice(spot);
      if (window.XInd) XInd.setPrice(spot);
      $("dot").className = "dot ok";
      $("priceMeta").textContent = name + " " + new Date().toLocaleTimeString("en-GB", { timeZone: "Africa/Nairobi" });
      render();
      return;
    } catch (e) { /* try next source */ }
  }
  $("dot").className = "dot err";
  $("priceMeta").textContent = "Price feed unavailable, retrying";
}

loadLevels(); pollSpot(); tick();
setInterval(pollSpot, 5000);
setInterval(tick, 1000);
setInterval(loadLevels, 600000);

// ---------- tabs ----------
function showTab(name) {
  const chart = name === "chart";
  $("paneMain").hidden = chart;
  $("paneChart").hidden = !chart;
  $("tabMain").classList.toggle("on", !chart);
  $("tabChart").classList.toggle("on", chart);
  document.body.classList.toggle("chart-tab", chart);
  try { history.replaceState(null, "", chart ? "#chart" : location.pathname + location.search); } catch (e) {}
  window.scrollTo(0, 0);
  setTimeout(() => window.dispatchEvent(new Event("resize")), 30);
}
$("tabMain").addEventListener("click", () => showTab("main"));
$("tabChart").addEventListener("click", () => showTab("chart"));
if (location.hash === "#chart") showTab("chart");
