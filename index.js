// Node 18+
// Run: `node index.js`
// Dependencies: npm i express ws

const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");
const express = require("express");

// ==== CONFIG ====
const ASSET_IDS = [6004, 6005, 6010, 6003, 6011, 6009, 6059, 6068, 6001, 6066, 6006, 6002, 6000, 5010, 5000, 5002, 5013, 5011, 5012, 5001, 5501, 5500, 0, 1, 10, 14, 5, 3, 15, 16, 90, 2];
const TIMEFRAMES = [
  { label: "15m", interval: 900,   weight: 1 },
  { label: "1h",  interval: 3600,  weight: 2 },
  { label: "1d",  interval: 86400, weight: 3 },
];
const BASE = "https://chart.brokex.trade/history?pair={PAIR}&interval={INTERVAL}";

const DATA_DIR = path.join(__dirname, "data");
const ANALYSES_FILE = path.join(DATA_DIR, "analyses.jsonl");
const OUTCOMES_FILE = path.join(DATA_DIR, "outcomes.jsonl");
fs.mkdirSync(DATA_DIR, { recursive: true });

// ===== WSS PRICE FEED =====
const WSS_URL = "wss://wss.brokex.trade:8443";
// stock live { [assetId:number]: { price:number, ts:number, pair?:string } }
const livePrices = Object.create(null);
// cache mémoire (structure interne complète)
const analysisCache = Object.create(null);

let reconnectAttempts = 0;
let loggedSampleOnce = false;

function startWss() {
  const ws = new WebSocket(WSS_URL);
  ws.on("open", () => {
    reconnectAttempts = 0;
    console.log("[WSS] connected");
  });
  ws.on("message", (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      if (!loggedSampleOnce) {
        const keys = Object.keys(data);
        console.log("[WSS sample keys]", keys.slice(0, 5));
        loggedSampleOnce = true;
      }
      Object.entries(data).forEach(([pairKey, payload]) => {
        const item = payload?.instruments?.[0] ?? payload?.data?.instruments?.[0];
        if (!item) return;
        const id = Object.prototype.hasOwnProperty.call(payload, "id")
          ? Number(payload.id)
          : (Number(item?.id) || undefined);
        const price = parseFloat(item.currentPrice);
        const ts = Number(item.timestamp ?? Date.now());
        const pairName = item.tradingPair?.toUpperCase?.() ?? String(pairKey);
        if (Number.isFinite(id) && Number.isFinite(price)) {
          livePrices[id] = { price, ts, pair: pairName };
        }
      });
    } catch (e) {
      console.error("[WSS] parse error:", e.message);
    }
  });
  ws.on("close", (code) => {
    console.warn("[WSS] closed:", code);
    const delay = Math.min(30000, 1000 * 2 ** Math.min(reconnectAttempts, 5));
    reconnectAttempts++;
    console.warn(`[WSS] retrying in ${delay}ms`);
    setTimeout(startWss, delay);
  });
  ws.on("error", (err) => {
    console.error("[WSS] error:", err.message);
    try { ws.close(); } catch (_) {}
  });
}
startWss();

// ====== HELPERS (math & utils) ======
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const toNum = (x) => (typeof x === "number" ? x : parseFloat(x));
const last = (arr) => arr?.length ? arr[arr.length - 1] : null;

function SMA(arr, p) {
  if (arr.length < p) return null;
  let s = 0;
  for (let i = arr.length - p; i < arr.length; i++) s += arr[i];
  return s / p;
}
function EMA(arr, p) {
  if (arr.length < p) return null;
  const k = 2 / (p + 1);
  let emaPrev = SMA(arr.slice(0, p), p);
  for (let i = p; i < arr.length; i++) emaPrev = arr[i] * k + emaPrev * (1 - k);
  return emaPrev;
}
function stddev(arr, p) {
  if (arr.length < p) return null;
  const slice = arr.slice(-p);
  const mean = slice.reduce((a, b) => a + b, 0) / p;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / p;
  return Math.sqrt(variance);
}

// ====== INDICATEURS ======
function RSI(closes, p = 14) {
  if (closes.length < p + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= p; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / p, avgLoss = losses / p;
  for (let i = p + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (p - 1) + gain) / p;
    avgLoss = (avgLoss * (p - 1) + loss) / p;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function MACD(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal) return null;
  const kF = 2 / (fast + 1), kS = 2 / (slow + 1);
  let emaF = SMA(closes.slice(0, fast), fast);
  let emaS = SMA(closes.slice(0, slow), slow);
  const macdSeries = [];
  for (let i = Math.max(fast, slow); i < closes.length; i++) {
    if (i >= fast) emaF = closes[i] * kF + emaF * (1 - kF);
    if (i >= slow) emaS = closes[i] * kS + emaS * (1 - kS);
    macdSeries.push(emaF - emaS);
  }
  const macdVal = last(macdSeries);
  const signalVal = EMA(macdSeries, signal);
  const hist = macdVal - signalVal;
  const prevSeries = macdSeries.slice(0, -1);
  const prevSignal = prevSeries.length ? EMA(prevSeries, signal) : null;
  const prevMacd = prevSeries.length ? last(prevSeries) : null;
  const prevHist = (prevMacd != null && prevSignal != null) ? (prevMacd - prevSignal) : null;
  return { macd: macdVal, signal: signalVal, hist, prevHist };
}

function Bollinger(closes, p = 20, mult = 2) {
  if (closes.length < p) return null;
  const mid = SMA(closes, p);
  const sd = stddev(closes, p);
  return { mid, upper: mid + mult * sd, lower: mid - mult * sd };
}

function Stoch(highs, lows, closes, kP = 14, dP = 3, smoothK = 3) {
  if (closes.length < kP + dP) return null;
  const kArr = [];
  for (let i = kP - 1; i < closes.length; i++) {
    const hh = Math.max(...highs.slice(i - kP + 1, i + 1));
    const ll = Math.min(...lows.slice(i - kP + 1, i + 1));
    const k = ((closes[i] - ll) / (hh - ll)) * 100;
    kArr.push(k);
  }
  const smooth = (arr, p) => {
    const out = [];
    for (let i = p - 1; i < arr.length; i++) out.push(SMA(arr.slice(0, i + 1), p));
    return out;
  };
  const kSm = smooth(kArr, smoothK);
  const dArr = [];
  for (let i = dP - 1; i < kSm.length; i++) dArr.push(SMA(kSm.slice(0, i + 1), dP));
  const K = last(kSm), D = last(dArr);
  const prevK = kSm.at(-2) ?? null;
  const prevD = dArr.at(-2) ?? null;
  return { K, D, prevK, prevD };
}

function CCI(highs, lows, closes, p = 20) {
  if (closes.length < p) return null;
  const tp = closes.map((c, i) => (highs[i] + lows[i] + closes[i]) / 3);
  const lastTP = last(tp);
  const sma = SMA(tp, p);
  const slice = tp.slice(-p);
  const meanDev = slice.reduce((a, v) => a + Math.abs(v - sma), 0) / p;
  return (lastTP - sma) / (0.015 * meanDev);
}

function ADX(highs, lows, closes, p = 14) {
  if (closes.length < p + 1) return null;
  const tr = [], plusDM = [], minusDM = [];
  for (let i = 1; i < highs.length; i++) {
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    tr.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
  }
  const wSmooth = (arr, p) => {
    let prev = arr.slice(0, p).reduce((a, b) => a + b, 0);
    const out = [prev];
    for (let i = p; i < arr.length; i++) { prev = prev - prev / p + arr[i]; out.push(prev); }
    return out;
  };
  const tr14 = wSmooth(tr, p);
  const plusDM14 = wSmooth(plusDM, p);
  const minusDM14 = wSmooth(minusDM, p);
  const plusDI = plusDM14.map((v, i) => 100 * (v / tr14[i]));
  const minusDI = minusDM14.map((v, i) => 100 * (v / tr14[i]));
  const dx = plusDI.map((v, i) => 100 * Math.abs(v - minusDI[i]) / (v + minusDI[i]));
  let adx = dx.slice(0, p).reduce((a, b) => a + b, 0) / p;
  for (let i = p; i < dx.length; i++) adx = (adx * (p - 1) + dx[i]) / p;
  return { adx, plusDI: last(plusDI), minusDI: last(minusDI) };
}

function ATR(highs, lows, closes, p = 14) {
  if (closes.length < p + 1) return null;
  const tr = [];
  for (let i = 1; i < highs.length; i++) {
    const a = highs[i] - lows[i];
    const b = Math.abs(highs[i] - closes[i - 1]);
    const c = Math.abs(lows[i] - closes[i - 1]);
    tr.push(Math.max(a, b, c));
  }
  let atr = tr.slice(0, p).reduce((a, b) => a + b, 0) / p;
  for (let i = p; i < tr.length; i++) atr = (atr * (p - 1) + tr[i]) / p;
  return atr;
}

function Donchian(highs, lows, p = 20) {
  if (highs.length < p || lows.length < p) return null;
  const sliceH = highs.slice(-p);
  const sliceL = lows.slice(-p);
  return { high: Math.max(...sliceH), low: Math.min(...sliceL) };
}

function Keltner(closes, highs, lows, emaPeriod = 20, atrMult = 1.5) {
  const mid = EMA(closes, emaPeriod);
  const atr = ATR(highs, lows, closes, 14);
  if (mid == null || atr == null) return null;
  return { mid, upper: mid + atrMult * atr, lower: mid - atrMult * atr, atr };
}

function Supertrend(highs, lows, closes, period = 10, mult = 3) {
  if (closes.length < period + 2) return null;
  const atr = ATR(highs, lows, closes, period);
  if (atr == null) return null;
  const hl2 = closes.map((c, i) => (highs[i] + lows[i]) / 2);
  const basicUpper = hl2.map(x => x + mult * atr);
  const basicLower = hl2.map(x => x - mult * atr);
  const finalUpper = [...basicUpper];
  const finalLower = [...basicLower];
  for (let i = 1; i < finalUpper.length; i++) {
    finalUpper[i] = (closes[i - 1] <= finalUpper[i - 1]) ? Math.min(basicUpper[i], finalUpper[i - 1]) : basicUpper[i];
    finalLower[i] = (closes[i - 1] >= finalLower[i - 1]) ? Math.max(basicLower[i], finalLower[i - 1]) : basicLower[i];
  }
  let trend = 1;
  const st = new Array(closes.length).fill(null);
  st[0] = finalLower[0];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > finalUpper[i - 1]) trend = 1;
    else if (closes[i] < finalLower[i - 1]) trend = -1;
    st[i] = (trend === 1) ? finalLower[i] : finalUpper[i];
  }
  return { trend, value: last(st) };
}

function ROC(closes, lookback) {
  if (closes.length < lookback + 1) return null;
  const lastClose = last(closes);
  const prev = closes[closes.length - 1 - lookback];
  return ((lastClose - prev) / prev) * 100;
}

// ====== FETCH & ANALYSE ======
async function fetchWithTimeout(url, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return res;
  } finally {
    clearTimeout(t);
  }
}
async function fetchOHLC(pair, interval) {
  const url = BASE.replace("{PAIR}", pair).replace("{INTERVAL}", interval);
  const res = await fetchWithTimeout(url, 15000);
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
  return res.json();
}

// --- Scoring helpers [-100, 100] ---
function scoreRSI(rsi) {
  if (rsi == null) return null;
  const d = rsi - 50; // -50..+50
  return clamp(d * 2, -100, +100);
}
function scoreMACD(hist, prevHist) {
  if (hist == null) return null;
  const base = clamp(Math.tanh(hist) * 80, -80, 80);
  const mom = (prevHist == null) ? 0 : clamp((hist - prevHist) * 40, -20, 20);
  return clamp(base + mom, -100, 100);
}
function scoreBollingerPos(close, bb) {
  if (!bb || bb.upper === bb.lower) return null;
  const pos = (close - bb.lower) / (bb.upper - bb.lower); // 0..1
  const s = (0.5 - pos) * 200; // 0=+100 ; 1=-100
  return clamp(s, -100, 100);
}
function scoreADX(adx, plusDI, minusDI) {
  if (adx == null || plusDI == null || minusDI == null) return null;
  const dir = Math.sign(plusDI - minusDI);
  const strength = clamp((adx - 20) * 3, 0, 100);
  return clamp(dir * strength, -100, 100);
}
function scoreATRpct(atrPct) {
  if (atrPct == null) return null;
  const center = 1.0; // 1% pivot
  const diff = atrPct - center;
  return clamp(-diff * 50, -100, 100);
}
function scoreDonchianBreak(close, don) {
  if (!don) return null;
  if (close > don.high) return +100;
  if (close < don.low)  return -100;
  const pos = (close - don.low) / (don.high - don.low);
  return clamp((pos - 0.5) * 80, -40, 40);
}
function scoreKeltner(close, kel, bb) {
  if (!kel) return null;
  let squeeze = null;
  if (bb) {
    const bbw = bb.upper - bb.lower;
    const kw = kel.upper - kel.lower;
    if (kw > 0) squeeze = clamp(((kw - bbw) / kw) * 100, -100, 100);
  }
  const dir = close >= kel.mid ? 1 : -1;
  const dist = Math.abs((close - kel.mid) / (kel.upper - kel.lower + 1e-9));
  const dirScore = clamp(dir * dist * 100, -100, 100);
  return { dirScore, squeezeScore: squeeze };
}
function scoreSupertrend(close, st) {
  if (!st) return null;
  return st.trend > 0 ? +60 : -60;
}
function scoreEmaTrend(ema20, ema50, ema200) {
  if (!ema20 || !ema50 || !ema200) return null;
  let s = 0;
  if (ema20 > ema50) s += 30; else s -= 30;
  if (ema50 > ema200) s += 40; else s -= 40;
  const distPct = ((ema50 - ema200) / ema200) * 100;
  s += clamp(distPct * 2, -30, 30);
  return clamp(s, -100, 100);
}
function scoreDistEMA200(close, ema200) {
  if (!ema200) return null;
  const distPct = ((close - ema200) / ema200) * 100;
  return clamp(distPct * 3, -100, 100);
}
function scoreRangePos(close, hi, lo) {
  if (hi == null || lo == null || hi === lo) return null;
  const pos = (close - lo) / (hi - lo);
  return clamp((pos - 0.5) * 200, -100, 100);
}
function scoreROC(pct) {
  if (pct == null) return null;
  return clamp(pct * 5, -100, 100);
}

// ---- analyse d'un timeframe ----
async function analyzeOneTF(assetId, label, interval) {
  const rows = await fetchOHLC(assetId, interval);
  const closes = rows.map(r => toNum(r.close));
  const highs  = rows.map(r => toNum(r.high));
  const lows   = rows.map(r => toNum(r.low));
  const close  = last(closes);

  const ema20 = EMA(closes, 20);
  const ema50 = EMA(closes, 50);
  const ema200 = EMA(closes, 200);
  const rsi = RSI(closes, 14);
  const macd = MACD(closes, 12, 26, 9);
  const bb = Bollinger(closes, 20, 2);
  const adx = ADX(highs, lows, closes, 14);
  const cci = CCI(highs, lows, closes, 20);
  const atr = ATR(highs, lows, closes, 14);
  const atrPct = atr != null ? (atr / close) * 100 : null;

  const don20 = Donchian(highs, lows, 20);
  const don55 = Donchian(highs, lows, 55);
  const kel = Keltner(closes, highs, lows, 20, 1.5);
  const st = Supertrend(highs, lows, closes, 10, 3);

  const rp20 = don20 ? scoreRangePos(close, don20.high, don20.low) : null;
  const rp55 = don55 ? scoreRangePos(close, don55.high, don55.low) : null;

  const roc24 = ROC(closes, Math.round(86400 / interval));
  const roc7d = ROC(closes, Math.round(7 * 86400 / interval));

  const sRSI = scoreRSI(rsi);
  const sMACD = macd ? scoreMACD(macd.hist, macd.prevHist) : null;
  const sBB = bb ? scoreBollingerPos(close, bb) : null;
  const sADX = adx ? scoreADX(adx.adx, adx.plusDI, adx.minusDI) : null;
  const sATR = scoreATRpct(atrPct);
  const sDon20 = scoreDonchianBreak(close, don20);
  const sDon55 = scoreDonchianBreak(close, don55);
  const kScores = kel ? scoreKeltner(close, kel, bb) : null;
  const sKelDir = kScores ? kScores.dirScore : null;
  const sST = scoreSupertrend(close, st);
  const sEmaTrend = scoreEmaTrend(ema20, ema50, ema200);
  const sDist200 = scoreDistEMA200(close, ema200);
  const sRP20 = rp20;
  const sRP55 = rp55;
  const sROC24 = scoreROC(roc24);
  const sROC7d = scoreROC(roc7d);

  const tfScores = {
    rsi14: sRSI,
    macd_hist: sMACD,
    bb_pos: sBB,
    adx: sADX,
    atr_score: sATR,
    donchian20: sDon20,
    donchian55: sDon55,
    keltner_dir: sKelDir,
    supertrend: sST,
    ema_trend: sEmaTrend,
    dist_ema200: sDist200,
    rangepos20: sRP20,
    rangepos55: sRP55,
    roc_24h: sROC24,
    roc_7d: sROC7d,
    // agrégat par TF (directionnel)
    tf_aggregate: clamp(
      (sEmaTrend ?? 0) * 0.25 +
      (sMACD ?? 0)     * 0.20 +
      (sADX ?? 0)      * 0.15 +
      (sBB ?? 0)       * 0.10 +
      (sDon20 ?? 0)    * 0.10 +
      (sDon55 ?? 0)    * 0.10 +
      (sST ?? 0)       * 0.10 +
      (sDist200 ?? 0)  * 0.05, -100, 100
    )
  };

  const features = {
    close,
    ema20, ema50, ema200,
    rsi14: rsi,
    macd_hist: macd?.hist ?? null,
    macd_prevHist: macd?.prevHist ?? null,
    bb_upper: bb?.upper ?? null,
    bb_lower: bb?.lower ?? null,
    adx: adx?.adx ?? null, plusDI: adx?.plusDI ?? null, minusDI: adx?.minusDI ?? null,
    atr, atr_pct: atrPct,
    don20_high: don20?.high ?? null, don20_low: don20?.low ?? null,
    don55_high: don55?.high ?? null, don55_low: don55?.low ?? null,
    kel_mid: kel?.mid ?? null, kel_upper: kel?.upper ?? null, kel_lower: kel?.lower ?? null,
    st_trend: st?.trend ?? null, st_value: st?.value ?? null,
    rp20_raw: don20 ? (close - don20.low) / (don20.high - don20.low) : null,
    rp55_raw: don55 ? (close - don55.low) / (don55.high - don55.low) : null,
    roc_24h_raw: roc24,
    roc_7d_raw: roc7d
  };

  return { label, interval, scores: tfScores, features };
}

async function analyzeAsset(assetId) {
  const perTF = [];
  for (const tf of TIMEFRAMES) {
    const r = await analyzeOneTF(assetId, tf.label, tf.interval);
    perTF.push({ ...r, weight: tf.weight });
  }
  const totalW = TIMEFRAMES.reduce((a, b) => a + b.weight, 0);
  const weightedScore = clamp(
    perTF.reduce((a, r) => a + (r.scores.tf_aggregate ?? 0) * r.weight, 0) / totalW,
    -100, 100
  );

  const live = livePrices[assetId];
  const spot = live?.price ?? null;
  const pairName = live?.pair ?? null;

  const now = new Date();
  const record = {
    t: now.toISOString(),
    epoch: Math.floor(now.getTime() / 1000),
    assetId,
    pair: pairName,
    spotAtAnalysis: spot,
    weightedScore,
    perTF // contient scores & features par TF (15m / 1h / 1d)
  };

  // persist minimal
  appendJsonLine(ANALYSES_FILE, {
    t: record.t, assetId, pair: pairName, spotAtAnalysis: spot, weightedScore
  });

  // outcome après 1h (pour métriques internes)
  setTimeout(() => {
    const live2 = livePrices[assetId];
    const spotLater = live2?.price ?? null;
    const predSign = Math.sign(weightedScore);
    const movedUp = (spot != null && spotLater != null) ? (spotLater > spot) : null;
    let correct = null;
    if (movedUp !== null) {
      if (predSign > 0) correct = movedUp === true;
      else if (predSign < 0) correct = movedUp === false;
      else correct = null;
    }
    appendJsonLine(OUTCOMES_FILE, {
      tCheck: new Date().toISOString(),
      assetId, pair: pairName,
      spotAtT: spot, spotAtTplus1h: spotLater,
      delta: (spot != null && spotLater != null) ? +(spotLater - spot).toFixed(6) : null,
      predictedSign: predSign, wasCorrect: correct
    });
  }, 60 * 60 * 1000);

  // cache
  analysisCache[assetId] = record;

  console.log(`[ANALYZE] id=${assetId} (${pairName ?? "?"}) wScore=${record.weightedScore} spot=${spot ?? "NA"}`);
  return record;
}

function appendJsonLine(file, obj) {
  fs.appendFile(file, JSON.stringify(obj) + "\n", (err) => {
    if (err) console.error("append error", file, err.message);
  });
}

// ====== Compact output builder ======
const INDICATORS_KEYS = [
  "rsi14","macd_hist","bb_pos","adx","atr_score",
  "donchian20","donchian55","keltner_dir","supertrend",
  "ema_trend","dist_ema200","rangepos20","rangepos55",
  "roc_24h","roc_7d"
];

// renvoie { short, mid, long, bull, bear } borné [-100,100], + méta
function buildCompact(record) {
  const perTF = record.perTF || [];
  const tf = Object.fromEntries(perTF.map(t => [t.label, t.scores?.tf_aggregate ?? null]));

  const s15 = tf["15m"];
  const s1h = tf["1h"];
  const s1d = tf["1d"];

  const short = clamp(((s15 ?? 0)*0.6 + (s1h ?? 0)*0.4), -100, 100);
  const mid   = clamp(((s1h ?? 0)*0.3 + (s1d ?? 0)*0.7), -100, 100);
  const long  = clamp((s1d ?? 0), -100, 100);

  // compter signaux bullish/bearish (on ignore |x|<=10)
  const TH_POS = 10, TH_NEG = -10;
  let bull = 0, bear = 0;
  for (const tfRec of perTF) {
    const s = tfRec.scores || {};
    for (const k of INDICATORS_KEYS) {
      const v = s[k];
      if (v == null) continue;
      if (v > TH_POS) bull++;
      else if (v < TH_NEG) bear++;
    }
  }

  return {
    t: record.t,
    pair: record.pair ?? null,
    spot: record.spotAtAnalysis ?? null,
    short, mid, long,
    bull, bear
  };
}

// ====== SCHEDULER HEUREL ======
async function runAllAssets() {
  for (const id of ASSET_IDS) {
    try {
      await analyzeAsset(id);
    } catch (e) {
      console.error(`[ERR] analyze asset ${id}:`, e.message);
    }
  }
}
function msToNextHour() {
  const now = Date.now();
  const next = Math.ceil(now / 3600000) * 3600000;
  return next - now;
}
async function waitForLive(ids, timeoutMs = 30000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const iv = setInterval(() => {
      const haveAll = ids.every(id => livePrices[id]?.price != null);
      if (haveAll) {
        clearInterval(iv);
        resolve(true);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(iv);
        reject(new Error("Timeout waiting for live prices"));
      }
    }, 250);
  });
}

// ===== HTTP API =====
const app = express();

// CORS permissif
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.json());

// GET compact snapshot (un id ou plusieurs)
// /api/scores?ids=0,1  |  /api/scores?ids=all
app.get("/api/scores", (req, res) => {
  const idsParam = (req.query.ids || "").trim();
  const list = (!idsParam || idsParam.toLowerCase() === "all")
    ? ASSET_IDS.slice()
    : idsParam.split(",").map(x => +x).filter(Number.isFinite);

  const out = {};
  for (const id of list) {
    const rec = analysisCache[id];
    if (rec) out[id] = buildCompact(rec);
  }
  return res.json({ ok: true, assets: out });
});

// Force recalcul puis retourne compact
// /api/refresh?ids=0,1  |  /api/refresh?ids=all
app.get("/api/refresh", async (req, res) => {
  const idsParam = (req.query.ids || "").trim();
  const list = (!idsParam || idsParam.toLowerCase() === "all")
    ? ASSET_IDS.slice()
    : idsParam.split(",").map(x => +x).filter(Number.isFinite);

  if (!list.length) return res.status(400).json({ ok: false, error: "No valid ids" });

  const results = {};
  for (const id of list) {
    try {
      const r = await analyzeAsset(id);
      results[id] = buildCompact(r);
    } catch (e) {
      results[id] = { error: e.message };
    }
  }
  res.json({ ok: true, assets: results });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`HTTP up on :${PORT}`));

// ==== BOOTSTRAP ====
(async () => {
  console.log("Brokex hourly analyzer started. Watching assets:", ASSET_IDS.join(", "));
  try {
    await waitForLive(ASSET_IDS, 30000);
    console.log("[BOOT] Live prices ready, starting first analysis.");
  } catch (e) {
    console.warn("[BOOT] Live prices not fully ready (timeout). Starting anyway.");
  }
  setTimeout(() => {
    runAllAssets();
    setInterval(runAllAssets, 60 * 60 * 1000);
  }, Math.min(msToNextHour(), 15_000));
})();

