"""Daily XAUUSD levels from the GLD options chain (open interest, Greeks, volatility).

Runs three times a day, Monday to Friday: 03:30 (Asian), 12:00 (London) and 17:33 (New York) Kenya time.
Options-derived values stay frozen until the next run.
"""
import json, math, os, sys, time, urllib.request
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
import yfinance as yf

RATE = 0.04
MAX_DAYS = 30
MIN_GAP = 0.0015
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "levels.json")
PREV = os.path.join(HERE, "data_prev.json")


def retry(fn, tries=3, wait=5):
    last = None
    for i in range(tries):
        try:
            return fn()
        except Exception as e:
            last = e
            print(f"attempt {i + 1} failed: {e}", file=sys.stderr)
            time.sleep(wait)
    raise last


def http_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)


def xau_spot():
    for url in ("https://fapi.binance.com/fapi/v1/ticker/price?symbol=XAUUSDT",
                "https://data-api.binance.vision/api/v3/ticker/price?symbol=PAXGUSDT"):
        try:
            return float(http_json(url)["price"]), url.split("symbol=")[1]
        except Exception as e:
            print(f"spot source failed: {e}", file=sys.stderr)
    return float(yf.Ticker("GC=F").history(period="5d")["Close"].iloc[-1]), "GC=F"


def gold_at(ts_ms):
    """Gold price at the moment GLD last traded (5-minute Binance candle that starts at ts_ms)."""
    for url in ("https://fapi.binance.com/fapi/v1/klines?symbol=XAUUSDT&interval=5m&limit=1&startTime=%d" % ts_ms,
                "https://data-api.binance.vision/api/v3/klines?symbol=PAXGUSDT&interval=5m&limit=1&startTime=%d" % ts_ms):
        try:
            rows = http_json(url)
            if rows and abs(rows[0][0] - ts_ms) < 6 * 60 * 1000:
                return float(rows[0][4])
        except Exception as e:
            print(f"gold-at-GLD-close source failed: {e}", file=sys.stderr)
    return None


def load_chain():
    t = yf.Ticker("GLD")
    try:  # last regular-session 5-minute bar, so the ratio can use gold at the same moment
        h = t.history(period="5d", interval="5m")
        gld = float(h["Close"].iloc[-1])
        gld_ts = int(h.index[-1].timestamp() * 1000)
    except Exception as e:
        print(f"intraday GLD failed, using daily close: {e}", file=sys.stderr)
        gld = float(t.history(period="5d")["Close"].iloc[-1])
        gld_ts = None
    today = datetime.now(timezone.utc).date()
    opts = []
    for exp in t.options:
        days = (datetime.strptime(exp, "%Y-%m-%d").date() - today).days
        if days < 0 or days > MAX_DAYS:
            continue
        T = max(days, 0.5) / 365
        ch = t.option_chain(exp)
        for kind, df in (("C", ch.calls), ("P", ch.puts)):
            for r in df.itertuples():
                oi, iv, bid, ask = r.openInterest, r.impliedVolatility, r.bid, r.ask
                if oi > 0 and iv > 0.01 and bid > 0 and ask > 0:  # NaN fails these checks
                    opts.append(dict(k=float(r.strike), kind=kind, oi=float(oi), iv=float(iv), T=T, days=days, exp=exp))
    if not opts:
        raise RuntimeError("no usable options rows")
    return gld, opts, gld_ts


def npdf(x): return math.exp(-0.5 * x * x) / math.sqrt(2 * math.pi)
def ncdf(x): return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def greeks(S, K, T, iv, kind):
    sq = iv * math.sqrt(T)
    d1 = (math.log(S / K) + (RATE + 0.5 * iv * iv) * T) / sq
    delta = ncdf(d1) if kind == "C" else ncdf(d1) - 1
    gamma = npdf(d1) / (S * sq)
    vega = S * npdf(d1) * math.sqrt(T) / 100
    return delta, gamma, vega


def session_for(now):
    """Name the session from the UTC run time (cron can start a little late)."""
    m = now.hour * 60 + now.minute
    if m < 8 * 60:
        return "asia", "Asian session"
    if m < 13 * 60 + 30:
        return "london", "London session"
    return "newyork", "New York session"


def main():
    gld, opts, gld_ts = retry(load_chain)
    xau, src = retry(xau_spot)
    # Ratio uses gold at the moment GLD last traded, so overnight gold moves do not shift the levels.
    gold_then = gold_at(gld_ts) if gld_ts else None
    ratio = (gold_then or xau) / gld
    ratio_basis = "gold at GLD close" if gold_then else "gold spot now"

    strikes = {}
    for o in opts:
        dl, g, v = greeks(gld, o["k"], o["T"], o["iv"], o["kind"])
        s = strikes.setdefault(o["k"], dict(call_oi=0, put_oi=0, call_gex=0, put_gex=0, call_delta=0,
                                            put_delta=0, call_vega=0, put_vega=0, ivs=[]))
        gex = g * o["oi"] * 100 * gld * gld * 0.01
        s["ivs"].append(o["iv"])
        if o["kind"] == "C":
            s["call_oi"] += o["oi"]; s["call_gex"] += gex
            s["call_delta"] += dl * o["oi"] * 100; s["call_vega"] += v * o["oi"] * 100
        else:
            s["put_oi"] += o["oi"]; s["put_gex"] -= gex
            s["put_delta"] += dl * o["oi"] * 100; s["put_vega"] += v * o["oi"] * 100

    # ATM implied volatility and expected daily move
    near = min(o["days"] for o in opts)
    pool = [o for o in opts if o["days"] == near]
    atm_k = min((o["k"] for o in pool), key=lambda k: abs(k - gld))
    atm_ivs = [o["iv"] for o in pool if o["k"] == atm_k]
    atm_iv = sum(atm_ivs) / len(atm_ivs)
    em = xau * atm_iv * math.sqrt(1 / 252)

    # Walls
    up = [k for k in strikes if k > gld] or list(strikes)
    dn = [k for k in strikes if k < gld] or list(strikes)
    ck = max(up, key=lambda k: strikes[k]["call_gex"])
    pk = max(dn, key=lambda k: abs(strikes[k]["put_gex"]))
    call_wall = dict(price=round(ck * ratio, 2), open_interest=int(strikes[ck]["call_oi"]), gex=round(strikes[ck]["call_gex"]))
    put_wall = dict(price=round(pk * ratio, 2), open_interest=int(strikes[pk]["put_oi"]), gex=round(strikes[pk]["put_gex"]))

    # Gamma flip: zero crossing of total GEX over a +/-5% spot grid
    def total(P):
        t = 0.0
        for o in opts:
            _, g, _ = greeks(P, o["k"], o["T"], o["iv"], o["kind"])
            x = g * o["oi"] * 100 * P * P * 0.01
            t += x if o["kind"] == "C" else -x
        return t
    grid = [gld * (0.95 + 0.0025 * i) for i in range(41)]
    vals = [total(p) for p in grid]
    cross = []
    for i in range(40):
        a, b = vals[i], vals[i + 1]
        if a == 0:
            cross.append(grid[i])
        elif a * b < 0:
            cross.append(grid[i] + (grid[i + 1] - grid[i]) * (-a / (b - a)))
    flip_g = min(cross, key=lambda p: abs(p - gld)) if cross else grid[min(range(41), key=lambda i: abs(vals[i]))]
    gamma_flip = round(flip_g * ratio, 2)
    anchors = [call_wall["price"], put_wall["price"], gamma_flip]

    def pick(side):
        sign = 1 if side == "R" else -1
        pre = "call" if side == "R" else "put"
        c = []
        for k, s in strikes.items():
            p = k * ratio
            if not (xau < p <= xau * 1.04 if side == "R" else xau * 0.96 <= p < xau):
                continue
            c.append(dict(price=p, oi=s[pre + "_oi"], gex=abs(s[pre + "_gex"]), dl=abs(s[pre + "_delta"]),
                          vg=s[pre + "_vega"], iv=sum(s["ivs"]) / len(s["ivs"])))
        for n in (1, 2):
            c.append(dict(price=xau + sign * n * em, oi=0, gex=0, dl=0, vg=0, iv=atm_iv))
        mx = lambda key: max(x[key] for x in c) or 1
        mo, mg, md, mv = mx("oi"), mx("gex"), mx("dl"), mx("vg")
        ms = max(abs(x["iv"] - atm_iv) / atm_iv for x in c) or 1
        for x in c:
            skew = abs(x["iv"] - atm_iv) / atm_iv / ms
            emc = max(0, 1 - min(abs(x["price"] - (xau + sign * n * em)) for n in (1, 2)) / em)
            prox = max(0, 1 - min(abs(x["price"] - a) for a in anchors) / (2 * em))
            x["score"] = 100 * (0.35 * x["oi"] / mo + 0.25 * x["gex"] / mg
                                + 0.15 * (0.5 * x["dl"] / md + 0.5 * x["vg"] / mv)
                                + 0.15 * (0.5 * skew + 0.5 * emc) + 0.10 * prox)
        chosen = []
        for x in sorted(c, key=lambda x: -x["score"]):
            if all(abs(x["price"] - y["price"]) / x["price"] >= MIN_GAP for y in chosen):
                chosen.append(x)
            if len(chosen) == 3:
                break
        chosen.sort(key=lambda x: abs(x["price"] - xau))
        return [dict(price=round(x["price"], 2), score=round(x["score"], 1),
                     open_interest=int(x["oi"]), gex=round(x["gex"])) for x in chosen]

    # ---- per-expiry GEX and vega (front expiry, next expiry, all) for the indicators ----
    days_set = sorted({o["days"] for o in opts})
    front_days = days_set[0]
    next_days = days_set[1] if len(days_set) > 1 else None
    net = {"all": {}, "front": {}, "next": {}}
    vegax = {"all": {}, "front": {}}
    for o in opts:
        dl, g, v = greeks(gld, o["k"], o["T"], o["iv"], o["kind"])
        signed = g * o["oi"] * 100 * gld * gld * 0.01 * (1 if o["kind"] == "C" else -1)
        grp = "front" if o["days"] == front_days else ("next" if o["days"] == next_days else None)
        net["all"][o["k"]] = net["all"].get(o["k"], 0) + signed
        vegax["all"][o["k"]] = vegax["all"].get(o["k"], 0) + v * o["oi"] * 100
        if grp:
            net[grp][o["k"]] = net[grp].get(o["k"], 0) + signed
        if grp == "front":
            vegax["front"][o["k"]] = vegax["front"].get(o["k"], 0) + v * o["oi"] * 100

    def pt(d, k):
        return None if k is None else dict(price=round(k * ratio, 2), value=round(d[k]))
    def peak_k(d):
        return max(d, key=lambda k: abs(d[k])) if d else None
    def wall_k(d, above):
        ks = [k for k in d if (k > gld if above else k < gld)]
        return max(ks, key=lambda k: d[k]) if ks else None
    def top(d, n):
        return [dict(rank=i + 1, price=round(k * ratio, 2), net_gex=round(d[k]))
                for i, k in enumerate(sorted(d, key=lambda k: -abs(d[k]))[:n])]

    exp_of = lambda days: next((o["exp"] for o in opts if o["days"] == days), None)
    try:
        with open(PREV) as f:
            prev = json.load(f)
    except Exception:
        prev = {}
    now_ts = time.time()
    # compare with the previous run; a re-run within 20 minutes keeps the older comparison
    recent = (now_ts - prev.get("ts", 0)) < 20 * 60
    base = prev.get("prev_net_all", {}) if recent else prev.get("net_all", {})
    snap_now = {"%.2f" % k: round(v) for k, v in net["all"].items()}
    gex_strikes = []
    for k in sorted(strikes):
        if abs(k - gld) / gld > 0.08:
            continue
        key = "%.2f" % k
        s = strikes[k]
        gex_strikes.append(dict(
            strike=round(k * ratio, 2), net_gex=round(net["all"].get(k, 0)),
            front_gex=round(net["front"].get(k, 0)), next_gex=round(net["next"].get(k, 0)),
            call_oi=int(s["call_oi"]), put_oi=int(s["put_oi"]),
            vega_exposure=round(vegax["all"].get(k, 0)),
            change_1d=(round(net["all"].get(k, 0) - base[key]) if key in base else None)))
    extra = dict(
        front_expiry=exp_of(front_days), next_expiry=exp_of(next_days) if next_days is not None else None,
        gex_strikes=gex_strikes,
        peak_gex=dict(front=pt(net["front"], peak_k(net["front"])), all=pt(net["all"], peak_k(net["all"]))),
        iv_wall_above=dict(front=pt(vegax["front"], wall_k(vegax["front"], True)), all=pt(vegax["all"], wall_k(vegax["all"], True))),
        iv_wall_below=dict(front=pt(vegax["front"], wall_k(vegax["front"], False)), all=pt(vegax["all"], wall_k(vegax["all"], False))),
        top_front=top(net["front"], 10), top_next=top(net["next"], 5), top_all=top(net["all"], 10),
        sources=["GLD options chain via yfinance (delayed)", "OI-based dealer sign"])

    top = sorted(strikes.items(), key=lambda kv: -abs(kv[1]["call_gex"] + kv[1]["put_gex"]))[:10]
    now = datetime.now(timezone.utc)
    sess, sess_label = session_for(now)
    out = dict(
        sample=False, session=sess, session_label=sess_label,
        analyzed_at=now.astimezone(ZoneInfo("Africa/Nairobi")).isoformat(timespec="seconds"),
        analyzed_at_utc=now.isoformat(timespec="seconds"),
        spot_source=src, ratio_basis=ratio_basis, gld_ratio=round(ratio, 4), gld_spot=round(gld, 2),
        xauusd_spot_at_analysis=round(xau, 2), atm_iv=round(atm_iv, 4), expected_move_1sd=round(em, 2),
        call_wall=call_wall, put_wall=put_wall, gamma_flip=gamma_flip,
        resistances=pick("R"), supports=pick("S"),
        top_gex_strikes=[dict(price=round(k * ratio, 2), net_gex=round(s["call_gex"] + s["put_gex"]),
                              call_oi=int(s["call_oi"]), put_oi=int(s["put_oi"])) for k, s in top],
    )
    out.update(extra)
    tmp = OUT + ".tmp"
    with open(tmp, "w") as f:
        json.dump(out, f, indent=2)
    os.replace(tmp, OUT)  # only reached on success, so old levels survive a failed run
    tmp2 = PREV + ".tmp"
    with open(tmp2, "w") as f:
        json.dump(dict(ts=now_ts, net_all=snap_now, prev_net_all=base), f)
    os.replace(tmp2, PREV)
    print("levels written", out["analyzed_at"])


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"analysis failed, keeping previous levels: {e}", file=sys.stderr)
        sys.exit(1)
