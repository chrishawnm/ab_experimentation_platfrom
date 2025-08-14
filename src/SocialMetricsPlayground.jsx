import React, { useMemo, useState, useEffect } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  LabelList,
  ReferenceArea,
} from "recharts";

// ===================== Helpers ===================== //
function createPRNG(seed) {
  let s = seed >>> 0;
  return function rand() {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5; // xorshift32
    return (s >>> 0) / 4294967295;
  };
}

function boxMuller(rand){
  // ~ N(0,1)
  let u = 0, v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function clamp(x, lo, hi){ return Math.max(lo, Math.min(hi, x)); }

function formatDateLabel(date) {
  const d = new Date(date);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// Standard normal CDF (Abramowitz & Stegun 7.1.26)
function stdNormCDF(x){
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x*x/2);
  const prob = 1 - d * t * (1.330274429 + t*(-1.821255978 + t*(1.781477937 + t*(-0.356563782 + t*0.319381530))));
  return x >= 0 ? prob : 1 - prob;
}

function twoTailedP(z){
  return 2 * (1 - stdNormCDF(Math.abs(z)));
}

// Inverse standard normal CDF (Acklam's approximation)
function invNorm(p){
  if (p <= 0 || p >= 1 || Number.isNaN(p)) return NaN;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.3577518672690, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const plow = 0.02425, phigh = 1 - plow;
  let q, r;
  if (p < plow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]*q + c[1])*q + c[2])*q + c[3])*q + c[4])*q + c[5]) /
           ((((d[0]*q + d[1])*q + d[2])*q + d[3])*q + 1);
  }
  if (p > phigh) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0]*q + c[1])*q + c[2])*q + c[3])*q + c[4])*q + c[5]) /
             ((((d[0]*q + d[1])*q + d[2])*q + d[3])*q + 1);
  }
  q = p - 0.5; r = q*q;
  return (((((a[0]*r + a[1])*r + a[2])*r + a[3])*r + a[4])*r + a[5]) * q /
         (((((b[0]*r + b[1])*r + b[2])*r + b[3])*r + b[4])*r + 1);
}

// Target n per arm for two-sample diff-in-means (z-approx, equal n)
function computeSampleSize({ sigma2, mdeAbs, alpha=0.05, power=0.8 }){
  const zAlpha = invNorm(1 - alpha/2);
  const zPower = invNorm(power);
  if (!Number.isNaN(zAlpha) && !Number.isNaN(zPower) && mdeAbs > 0 && sigma2 > 0) {
    const num = 2 * (zAlpha + zPower) * (zAlpha + zPower) * sigma2; // 2 groups
    const n = Math.ceil(num / (mdeAbs * mdeAbs));
    return Math.max(2, n);
  }
  return NaN;
}

function numberFmt(x, digits=2){
  return (Math.abs(x) >= 1000 ? Math.round(x).toString() : Number(x).toFixed(digits));
}

function percentFmt(x, digits=2){
  return `${(x*100).toFixed(digits)}%`;
}

function hashStr(s){
  let h = 0; for (let i=0;i<s.length;i++){ h = ((h<<5)-h) + s.charCodeAt(i); h|=0; }
  return h >>> 0;
}

// ===================== Data gen ===================== //
// Unified metrics list — includes success metrics so they appear on the main chart
const METRICS = [
  { key: "DAU", label: "DAU", color: "#2563eb" },
  { key: "WAU", label: "WAU", color: "#16a34a" },
  { key: "Sessions", label: "Sessions", color: "#9333ea" },
  { key: "Logins", label: "Logins", color: "#f59e0b" },
  { key: "Signups", label: "Signups", color: "#ef4444" },
  { key: "VideoViews", label: "Video Views", color: "#0ea5e9" },
  { key: "Shares", label: "Shares", color: "#22c55e" },
  { key: "Comments", label: "Comments", color: "#a855f7" },
  { key: "Likes", label: "Likes", color: "#f97316" },
];

const SUCCESS_KEYS = ["VideoViews", "Shares", "Comments", "Likes"];
const GUARDRAIL_KEYS = ["DAU", "WAU", "Sessions", "Logins", "Signups"];

function generateData({ days = 90, seed = 42, varBoost = 0.05 }) {
  const rand = createPRNG(seed);
  const today = new Date();
  const start = new Date(today);
  start.setDate(today.getDate() - (days - 1));

  const daily = [];

  let dau = 1000 + Math.floor(rand() * 500);
  let sessionsPerUser = 1.6 + rand() * 0.7;
  let loginRate = 0.65 + rand() * 0.2;

  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);

    // DAU random walk + weekly seasonality, inflated variance
    const drift = (rand() - 0.48) * (25 * (1 + varBoost));
    const season = 60 * Math.sin((2 * Math.PI * i) / 7);
    dau = Math.max(200, dau + drift + season * (0.2 + rand() * (0.1 + varBoost)));

    const sessions = Math.max(300, dau * (sessionsPerUser + (rand() - 0.5) * (0.3 + varBoost)));
    const logins = Math.max(150, dau * (loginRate + (rand() - 0.5) * (0.08 + varBoost)));
    const signups = Math.max(20, (dau * (0.04 + (rand() * (0.02 + varBoost/2)))) + (rand() * 15 * (1 + varBoost)));

    // Success metrics per-user rates with extra variance via Box–Muller noise
    const viewsPerUser    = 2.2  + 0.7  * rand() + 0.20 * boxMuller(rand) * (1 + varBoost);
    const sharesPerUser   = 0.12 + 0.06 * rand() + 0.02 * boxMuller(rand) * (1 + varBoost);
    const commentsPerUser = 0.18 + 0.08 * rand() + 0.025* boxMuller(rand) * (1 + varBoost);
    const likesPerUser    = 0.65 + 0.12 * rand() + 0.05 * boxMuller(rand) * (1 + varBoost);

    const VideoViews = Math.max(50, Math.round(dau * Math.max(0, viewsPerUser)));
    const Shares     = Math.max(5,  Math.round(dau * Math.max(0, sharesPerUser)));
    const Comments   = Math.max(8,  Math.round(dau * Math.max(0, commentsPerUser)));
    const Likes      = Math.max(20, Math.round(dau * Math.max(0, likesPerUser)));

    daily.push({
      date: d.toISOString().slice(0, 10),
      DAU: Math.round(dau),
      Sessions: Math.round(sessions),
      Logins: Math.round(logins),
      Signups: Math.round(signups),
      VideoViews, Shares, Comments, Likes,
    });
  }

  // WAU from 7-day rolling
  const rand2 = createPRNG(seed ^ 0x9e3779b9);
  const wauShrink = 0.55 + rand2() * 0.1;
  for (let i = 0; i < daily.length; i++) {
    const window = daily.slice(Math.max(0, i - 6), i + 1);
    const rollingSum = window.reduce((s, r) => s + r.DAU, 0);
    daily[i].WAU = Math.round(rollingSum * wauShrink);
  }

  return daily.map(row => ({ ...row, label: formatDateLabel(row.date) }));
}

// ===================== A/B Stats & Simulation ===================== //
const zCritical = 1.96; // 95% CI

function basePerUser(metricKey, data){
  const totals = data.reduce((acc, d)=>{ acc.metric += d[metricKey]; acc.users += d.DAU; return acc; }, {metric:0, users:0});
  return totals.users > 0 ? totals.metric / totals.users : 0;
}

function basePerUserUntil(metricKey, data, endIndex){
  const slice = data.slice(0, Math.max(0, endIndex));
  if (slice.length === 0) return basePerUser(metricKey, data);
  const totals = slice.reduce((acc, d)=>{ acc.metric += d[metricKey]; acc.users += d.DAU; return acc; }, {metric:0, users:0});
  return totals.users > 0 ? totals.metric / totals.users : basePerUser(metricKey, data);
}

function deriveDataDrivenLift(metricKey, data, seed){
  // Deterministic "random" lift driven by both seed and data totals — endless possibilities when data regenerates
  const sum = data.reduce((s,d)=> s + d[metricKey], 0);
  const mixedSeed = (seed ^ 0x9e3779b9) ^ (sum | 0);
  const r = createPRNG(mixedSeed);
  const lift = 0.10 + 0.10 * boxMuller(r); // ~N(0.10, 0.10)
  return clamp(lift, -0.5, 2.0);
}

function computeStats({ muC, liftPct, nC, nT, varBoost=0.05 }){
  const muT = muC * (1 + liftPct);
  const varC = muC * (1 + varBoost); // Poisson-ish variance inflated by +0.05
  const varT = muT * (1 + varBoost);
  const diff = muT - muC;
  const se = Math.sqrt(varT / nT + varC / nC);
  const z = diff / se;
  const p = twoTailedP(z);
  const ciLow = diff - zCritical * se;
  const ciHigh = diff + zCritical * se;
  return { muC, muT, diff, z, p, ciLow, ciHigh, lift: diff / muC };
}

function simulateAB(data, { seed, splitC, splitT, testLen, enforceNoDecline }){
  const len = data.length;
  const startIndex = Math.max(0, len - testLen);
  const out = data.map(row => ({ ...row }));
  const aggregates = {};

  METRICS.forEach(m => {
    const key = m.key;
    const muC_pre = basePerUserUntil(key, data, startIndex);
    let lift = deriveDataDrivenLift(key, data, seed);
    if (enforceNoDecline && GUARDRAIL_KEYS.includes(key)) lift = Math.max(0, lift);

    let sumC = 0, sumE = 0, NtotC = 0, NtotT = 0;

    for (let i = 0; i < len; i++) {
      out[i][`${key}_Control`] = null;
      out[i][`${key}_Experiment`] = null;
    }

    for (let i = startIndex; i < len; i++) {
      const r = createPRNG((seed ^ hashStr(key) ^ i) >>> 0);
      const dauDay = out[i].DAU;
      const nC_day = Math.max(0, Math.floor(dauDay * clamp(splitC, 0, 1)));
      const nT_day = Math.max(0, Math.floor(dauDay * clamp(splitT, 0, 1)));

      // Special-case DAU to be exactly the cohort sizes
      if (key === "DAU") {
        out[i][`${key}_Control`] = nC_day;
        out[i][`${key}_Experiment`] = nT_day;
        sumC += nC_day; sumE += nT_day; NtotC += nC_day; NtotT += nT_day;
        continue;
      }

      const varPerUserC = muC_pre * (1 + 0.05);
      const varPerUserE = muC_pre * (1 + lift) * (1 + 0.05);

      const meanC = muC_pre * nC_day;
      const meanE = muC_pre * (1 + lift) * nT_day;

      const sdC = Math.sqrt(Math.max(1e-9, varPerUserC * nC_day));
      const sdE = Math.sqrt(Math.max(1e-9, varPerUserE * nT_day));

      const sampleC = Math.max(0, Math.round(meanC + sdC * boxMuller(r)));
      const sampleE = Math.max(0, Math.round(meanE + sdE * boxMuller(r)));

      out[i][`${key}_Control`] = sampleC;
      out[i][`${key}_Experiment`] = sampleE;
      sumC += sampleC; sumE += sampleE; NtotC += nC_day; NtotT += nT_day;
    }

    const daysInTest = Math.max(1, len - startIndex);
    const muC_real = NtotC > 0 ? (sumC / NtotC) : 0;
    const muT_real = NtotT > 0 ? (sumE / NtotT) : 0;
    const lift_real = muC_real > 0 ? (muT_real / muC_real - 1) : 0;

    aggregates[key] = { muC: muC_real, muT: muT_real, liftPct: lift_real, startIndex, daysInTest, NtotC, NtotT };
  });

  return { simData: out, aggregates, startIndex };
}

// Small right-edge label for a single series point (used on Experiment lines)
function RightEdgeNameLabel({ x, y, index, value, lastIndex, text, color }){
  if (index !== lastIndex || value == null) return null;
  const tx = (x || 0) + 6; // nudge right of the last point
  const ty = (y || 0);
  return (
    <g>
      {/* halo for legibility */}
      <text x={tx} y={ty} dy={4} fontSize={12} stroke="#fff" strokeWidth={3} paintOrder="stroke" fill="#fff">{text}</text>
      <text x={tx} y={ty} dy={4} fontSize={12} fill={color}>{text}</text>
    </g>
  );
}

// ===================== Component ===================== //
export default function SocialMetricsPlayground() {
  const [days, setDays] = useState(90);
  const [seed, setSeed] = useState(42);
  const [selected, setSelected] = useState(new Set(METRICS.map(m=>m.key)));

  // Traffic split mode (per-day cohorts are split of DAU)
  const [splitC, setSplitC] = useState(0.5); // 50% control
  const [splitT, setSplitT] = useState(0.5); // 50% experiment

  // Test window & behavior
  const [testLen, setTestLen] = useState(14);
  const [enforceNoDecline, setEnforceNoDecline] = useState(true);

  const data = useMemo(() => generateData({ days, seed, varBoost: 0.05 }), [days, seed]);

  const { simData, aggregates, startIndex } = useMemo(() =>
    simulateAB(data, { seed, splitC, splitT, testLen: clamp(testLen, 1, data.length), enforceNoDecline })
  , [data, seed, splitC, splitT, testLen, enforceNoDecline]);

  // sum of baseline DAU over test window — used to translate sample-size n to split %
  const { sumDAUWindow, daysInTest } = useMemo(() => {
    const slice = simData.slice(startIndex);
    const sumDAU = slice.reduce((s,r)=> s + (r.DAU || 0), 0);
    return { sumDAUWindow: sumDAU, daysInTest: slice.length };
  }, [simData, startIndex]);

  function toggleMetric(key) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  function randomize() { setSeed(Math.floor(Math.random() * 1e9)); }

  // Computed groups for the dropdowns
  const guardrailMetrics = METRICS.filter(m => GUARDRAIL_KEYS.includes(m.key));
  const successMetrics = METRICS.filter(m => SUCCESS_KEYS.includes(m.key));

  function setGroup(keys, checked){
    setSelected(prev => {
      const next = new Set(prev);
      keys.forEach(k => checked ? next.add(k) : next.delete(k));
      return next;
    });
  }

  // Helper to safely set splits and keep total <= 98% (leave small remainder)
  function setSplitPair(c, t){
    let c0 = clamp(Number(c) || 0, 0, 1);
    let t0 = clamp(Number(t) || 0, 0, 1);
    const tot = c0 + t0;
    if (tot > 0.98) { // keep slight headroom
      c0 = (c0 / tot) * 0.98;
      t0 = (t0 / tot) * 0.98;
    }
    setSplitC(c0);
    setSplitT(t0);
  }

  // --- sanity tests (dev only; no user impact) ---
  useEffect(() => {
    try {
      console.assert(Array.isArray(data) && data.length > 0, "Data should be non-empty");
      const mu = basePerUser("VideoViews", data);
      console.assert(Number.isFinite(mu) && mu > 0, "Base per-user mean should be positive");
      const metricKeys = new Set(METRICS.map(m=>m.key));
      [...SUCCESS_KEYS, ...GUARDRAIL_KEYS].forEach(k => console.assert(metricKeys.has(k), `Unknown metric key: ${k}`));
      console.assert(Math.abs(invNorm(0.975) - 1.95996) < 0.02, "invNorm sanity");
      const sigma2 = mu*(1+0.05);
      const n1 = computeSampleSize({ sigma2, mdeAbs: mu*0.1, alpha: 0.05, power: 0.8 });
      const n2 = computeSampleSize({ sigma2, mdeAbs: mu*0.2, alpha: 0.05, power: 0.8 });
      console.assert(n2 <= n1, "Larger MDE should reduce required n");
    } catch {}
  }, [data]);

  // ===== AB table keys based on selection =====
  const selectedGuardrails = GUARDRAIL_KEYS.filter(k => selected.has(k));
  const selectedSuccess = SUCCESS_KEYS.filter(k => selected.has(k));

  const testStartLabel = simData[startIndex]?.label;
  const testEndLabel = simData[simData.length - 1]?.label;

  const lastIndex = simData.length - 1;

  // Estimated total n in window from splits
  const NtotC_est = Math.round(sumDAUWindow * splitC);
  const NtotT_est = Math.round(sumDAUWindow * splitT);
  const remainderPct = Math.max(0, 1 - splitC - splitT);

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <div className="max-w-6xl mx-auto p-6">
        <header className="mb-6">
          <h1 className="text-2xl md:text-3xl font-semibold">Social Metrics Playground</h1>
          <p className="text-gray-600 mt-1">Traffic‑split mode: each day, Control/Experiment get a % of that day's DAU. Random data drives both guardrails and success metrics; variance inflated by +0.05.</p>
        </header>

        {/* SECTION: Chart + Right Panel */}
        <section className="grid lg:grid-cols-3 gap-4 mb-4">
          <div className="bg-white rounded-2xl shadow p-4 lg:col-span-2">
            <div className="flex flex-wrap items-center gap-3 mb-2">
              <label className="text-sm font-medium">Days</label>
              <input
                type="number"
                min={7}
                max={365}
                value={days}
                onChange={e => setDays(Number(e.target.value) || 7)}
                className="w-24 rounded-xl border border-gray-300 px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              <button onClick={randomize} className="rounded-xl px-3 py-1.5 bg-indigo-600 text-white hover:bg-indigo-700 transition shadow" title="Regenerate data with a new seed">
                Regenerate Data
              </button>
              <div className="text-xs text-gray-500">Seed: <span className="font-mono">{seed}</span></div>
            </div>

            {/* Tiny cohort style key (legend) */}
            <div className="flex items-center gap-4 text-xs text-gray-600 mb-2">
              <span className="inline-flex items-center gap-2"><span className="inline-block w-6 h-[2px] bg-gray-700 opacity-30"/> Baseline</span>
              <span className="inline-flex items-center gap-2"><span className="inline-block w-6 h-[2px] bg-gray-700"/> Control</span>
              <span className="inline-flex items-center gap-2"><span className="inline-block w-6 border-t border-gray-700 border-dashed"/> Experiment</span>
            </div>

            <div className="w-full h-[380px] md:h-[440px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={simData} margin={{ top: 8, right: 80, left: 0, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="label" interval="preserveStartEnd" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 12 }} allowDecimals={false} />
                  <Tooltip formatter={(value, name) => [new Intl.NumberFormat().format(value), name]} />

                  {/* Shaded test window */}
                  {testStartLabel && testEndLabel && (
                    <ReferenceArea x1={testStartLabel} x2={testEndLabel} strokeOpacity={0} fill="#6366f1" fillOpacity={0.08} />
                  )}

                  {/* Baseline lines (faint) + Cohort lines for selected metrics */}
                  {METRICS.filter(m => selected.has(m.key)).map((m) => (
                    <Line key={`${m.key}-base`} type="monotone" dataKey={m.key} name={`${m.label} — Baseline`} stroke={m.color} strokeOpacity={0.35} dot={false} strokeWidth={2} isAnimationActive={false} />
                  ))}
                  {METRICS.filter(m => selected.has(m.key)).map((m) => (
                    <Line key={`${m.key}-ctrl`} type="monotone" dataKey={`${m.key}_Control`} name={`${m.label} — Control`} stroke={m.color} dot={false} strokeWidth={2} isAnimationActive={false} />
                  ))}
                  {METRICS.filter(m => selected.has(m.key)).map((m) => (
                    <Line key={`${m.key}-exp`} type="monotone" dataKey={`${m.key}_Experiment`} name={`${m.label} — Experiment`} stroke={m.color} strokeDasharray="5 4" dot={false} strokeWidth={2} isAnimationActive={false}>
                      {/* right-edge metric labels on experiment lines */}
                      <LabelList dataKey={`${m.key}_Experiment`} content={(props)=> (
                        <RightEdgeNameLabel {...props} lastIndex={lastIndex} text={m.label} color={m.color} />
                      )} />
                    </Line>
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>

            <div className="mt-3 text-xs text-gray-600">Test window: <span className="font-mono">{testStartLabel}</span> → <span className="font-mono">{testEndLabel}</span></div>
          </div>

          <div className="bg-white rounded-2xl shadow p-4">
            <h2 className="text-lg font-semibold mb-3">Metrics</h2>
            <div className="space-y-4">
              {/* Guardrail dropdown */}
              <details className="group rounded-xl border border-gray-200">
                <summary className="list-none cursor-pointer select-none px-3 py-2 flex items-center justify-between">
                  <span className="font-medium">Guardrail Metrics</span>
                  <span className="text-gray-500 group-open:rotate-180 transition">▼</span>
                </summary>
                <div className="px-3 pb-3 space-y-2">
                  <div className="flex items-center gap-2 text-xs text-gray-600">
                    <button type="button" onClick={() => setGroup(GUARDRAIL_KEYS, true)} className="px-2 py-1 rounded bg-gray-100 hover:bg-gray-200">Select all</button>
                    <button type="button" onClick={() => setGroup(GUARDRAIL_KEYS, false)} className="px-2 py-1 rounded bg-gray-100 hover:bg-gray-200">Clear</button>
                  </div>
                  <div className="space-y-2 mt-1">
                    {guardrailMetrics.map((m) => (
                      <label key={m.key} className="flex items-center gap-3 cursor-pointer select-none">
                        <input type="checkbox" checked={selected.has(m.key)} onChange={() => toggleMetric(m.key)} className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500" />
                        <span className="inline-flex items-center gap-2">
                          <span className="inline-block h-2 w-6 rounded" style={{ background: m.color }} />
                          <span>{m.label}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              </details>

              {/* Success dropdown */}
              <details className="group rounded-xl border border-gray-200">
                <summary className="list-none cursor-pointer select-none px-3 py-2 flex items-center justify-between">
                  <span className="font-medium">Success Metrics</span>
                  <span className="text-gray-500 group-open:rotate-180 transition">▼</span>
                </summary>
                <div className="px-3 pb-3 space-y-2">
                  <div className="flex items-center gap-2 text-xs text-gray-600">
                    <button type="button" onClick={() => setGroup(SUCCESS_KEYS, true)} className="px-2 py-1 rounded bg-gray-100 hover:bg-gray-200">Select all</button>
                    <button type="button" onClick={() => setGroup(SUCCESS_KEYS, false)} className="px-2 py-1 rounded bg-gray-100 hover:bg-gray-200">Clear</button>
                  </div>
                  <div className="space-y-2 mt-1">
                    {successMetrics.map((m) => (
                      <label key={m.key} className="flex items-center gap-3 cursor-pointer select-none">
                        <input type="checkbox" checked={selected.has(m.key)} onChange={() => toggleMetric(m.key)} className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500" />
                        <span className="inline-flex items-center gap-2">
                          <span className="inline-block h-2 w-6 rounded" style={{ background: m.color }} />
                          <span>{m.label}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              </details>
            </div>
          </div>
        </section>

        {/* A/B Test Panel for Selected Metrics */}
        <section className="grid lg:grid-cols-3 gap-4 mt-4">
          <div className="bg-white rounded-2xl shadow p-4 lg:col-span-2">
            <h2 className="text-lg font-semibold mb-1">A/B Test — Selected Metrics</h2>
            <p className="text-xs text-gray-600 mb-4">Rows reflect the <b>simulated cohort results</b> over the shaded window (last {daysInTest} days). Stats use aggregated means with effective N equal to the sum of daily assigned users (from your traffic split).</p>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-600 border-b">
                    <th className="py-2 pr-4">Metric</th>
                    <th className="py-2 pr-4">Control Mean</th>
                    <th className="py-2 pr-4">Experiment Mean</th>
                    <th className="py-2 pr-4">Lift</th>
                    <th className="py-2 pr-4">Diff 95% CI</th>
                    <th className="py-2 pr-4">p-value</th>
                    <th className="py-2 pr-4">Z</th>
                  </tr>
                </thead>
                <tbody>
                  {/* Guardrails section (if any selected) */}
                  {selectedGuardrails.length > 0 && (
                    <tr className="bg-gray-50">
                      <td colSpan={7} className="py-2 px-2 font-semibold text-gray-700">Guardrail Metrics</td>
                    </tr>
                  )}
                  {selectedGuardrails.map(key => {
                    const label = METRICS.find(m=>m.key===key)?.label || key;
                    const agg = aggregates[key];
                    const muC = agg?.muC ?? basePerUser(key, data);
                    const muT = agg?.muT ?? muC * (1 + deriveDataDrivenLift(key, data, seed));
                    const liftPct = (muC > 0) ? (muT / muC - 1) : 0;
                    const nCtrl = agg?.NtotC || 1, nExp = agg?.NtotT || 1;
                    const s = computeStats({ muC, liftPct, nC: nCtrl, nT: nExp, varBoost: 0.05 });
                    return (
                      <tr key={key} className="border-b last:border-b-0">
                        <td className="py-2 pr-4 font-medium">{label}</td>
                        <td className="py-2 pr-4">{numberFmt(s.muC)}</td>
                        <td className="py-2 pr-4">{numberFmt(s.muT)}</td>
                        <td className="py-2 pr-4">{percentFmt(s.lift)}</td>
                        <td className="py-2 pr-4">[{numberFmt(s.ciLow)}, {numberFmt(s.ciHigh)}]</td>
                        <td className="py-2 pr-4">{s.p < 0.0001 ? '<0.0001' : s.p.toFixed(4)}</td>
                        <td className="py-2 pr-4">{s.z.toFixed(2)}</td>
                      </tr>
                    );
                  })}

                  {/* Success section (if any selected) */}
                  {selectedSuccess.length > 0 && (
                    <tr className="bg-gray-50">
                      <td colSpan={7} className="py-2 px-2 font-semibold text-gray-700">Success Metrics</td>
                    </tr>
                  )}
                  {selectedSuccess.map(key => {
                    const label = METRICS.find(m=>m.key===key)?.label || key;
                    const agg = aggregates[key];
                    const muC = agg?.muC ?? basePerUser(key, data);
                    const muT = agg?.muT ?? muC * (1 + deriveDataDrivenLift(key, data, seed));
                    const liftPct = (muC > 0) ? (muT / muC - 1) : 0;
                    const nCtrl = agg?.NtotC || 1, nExp = agg?.NtotT || 1;
                    const s = computeStats({ muC, liftPct, nC: nCtrl, nT: nExp, varBoost: 0.05 });
                    return (
                      <tr key={key} className="border-b last:border-b-0">
                        <td className="py-2 pr-4 font-medium">{label}</td>
                        <td className="py-2 pr-4">{numberFmt(s.muC)}</td>
                        <td className="py-2 pr-4">{numberFmt(s.muT)}</td>
                        <td className="py-2 pr-4">{percentFmt(s.lift)}</td>
                        <td className="py-2 pr-4">[{numberFmt(s.ciLow)}, {numberFmt(s.ciHigh)}]</td>
                        <td className="py-2 pr-4">{s.p < 0.0001 ? '<0.0001' : s.p.toFixed(4)}</td>
                        <td className="py-2 pr-4">{s.z.toFixed(2)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="bg-white rounded-2xl shadow p-4">
            <h3 className="text-base font-semibold mb-2">Experiment Controls</h3>
            <div className="space-y-3">
              {/* Traffic split inputs */}
              <div className="flex items-center justify-between gap-3">
                <label className="text-sm text-gray-700">Control split (% of DAU)</label>
                <input type="number" min={0} max={100} step={1} value={(splitC*100).toFixed(0)}
                  onChange={e=> setSplitPair(Number(e.target.value)/100, splitT)}
                  className="w-32 rounded-xl border border-gray-300 px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-500"/>
              </div>
              <div className="flex items-center justify-between gap-3">
                <label className="text-sm text-gray-700">Experiment split (% of DAU)</label>
                <input type="number" min={0} max={100} step={1} value={(splitT*100).toFixed(0)}
                  onChange={e=> setSplitPair(splitC, Number(e.target.value)/100)}
                  className="w-32 rounded-xl border border-gray-300 px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-500"/>
              </div>
              <div className="text-xs text-gray-600">Unassigned / other traffic: <b>{(remainderPct*100).toFixed(0)}%</b></div>

              {/* Test window settings */}
              <div className="flex items-center justify-between gap-3">
                <label className="text-sm text-gray-700">Test duration (days)</label>
                <input type="number" min={1} max={days} value={testLen}
                  onChange={e=>setTestLen(clamp(Number(e.target.value)||1, 1, days))}
                  className="w-32 rounded-xl border border-gray-300 px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-500"/>
              </div>
              <label className="flex items-center justify-between gap-3 text-sm text-gray-700">
                <span>Guardrails cannot decline</span>
                <input type="checkbox" checked={enforceNoDecline} onChange={(e)=>setEnforceNoDecline(e.target.checked)} className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500" />
              </label>

              {/* Decision Rule & Sizing */}
              <div className="mt-4 pt-3 border-t">
                <h4 className="text-sm font-semibold mb-2">Decision Rule & Sample Size</h4>
                <DecisionRuleSizer
                  data={data}
                  selectedSuccessKeys={selectedSuccess}
                  sumDAUWindow={sumDAUWindow}
                  applyToSplit={(n)=>{ if (Number.isFinite(n) && sumDAUWindow>0) { const frac = clamp(n / sumDAUWindow, 0, 0.98); setSplitPair(frac, frac); } }}
                />
              </div>

              {/* Ad‑hoc Single Metric Calculator (kept for exploration) */}
              <div className="mt-4 pt-3 border-t">
                <h4 className="text-sm font-semibold mb-2">Ad‑hoc Sample Size (single metric)</h4>
                <SampleSizeControls
                  data={data}
                  selectedKeys={[...selected]}
                  sumDAUWindow={sumDAUWindow}
                  applyToSplit={(n)=>{ if (Number.isFinite(n) && sumDAUWindow>0) { const frac = clamp(n / sumDAUWindow, 0, 0.98); setSplitPair(frac, frac); } }}
                />
              </div>

              <div className="text-xs text-gray-600">
                Estimated total N over window — Control: <b>{NtotC_est.toLocaleString()}</b>, Experiment: <b>{NtotT_est.toLocaleString()}</b>
              </div>

              <p className="text-xs text-gray-500 mt-1">SE uses Poisson-ish variance with +0.05 inflation. CI = diff ± 1.96·SE. Two‑tailed p from Z. Simulation assigns cohorts per day using your traffic split.</p>
            </div>
          </div>
        </section>

        <footer className="mt-6 text-xs text-gray-500">
          Built with <code className="font-mono">recharts</code> + React. No external data used.
        </footer>
      </div>
    </div>
  );
}

// === Decision Rule Sizer ===
function DecisionRuleSizer({ data, selectedSuccessKeys = [], sumDAUWindow = 0, applyToSplit }){
  const candidateKeys = (selectedSuccessKeys && selectedSuccessKeys.length ? selectedSuccessKeys : SUCCESS_KEYS);
  const [rule, setRule] = useState("PRIMARY"); // PRIMARY | CO_PRIMARY | ANY_OF
  const [primary, setPrimary] = useState(candidateKeys[0] || SUCCESS_KEYS[0]);
  const [alpha, setAlpha] = useState(0.05);
  const [power, setPower] = useState(0.8);
  const [mdePct, setMdePct] = useState(0.10);

  useEffect(() => {
    if (!candidateKeys.includes(primary)) setPrimary(candidateKeys[0] || SUCCESS_KEYS[0]);
  }, [candidateKeys.join("|")]);

  const rows = candidateKeys.map((k) => {
    const mu = basePerUser(k, data);
    const sigma2 = mu * (1 + 0.05);
    const mdeAbs = mu * Math.max(0, mdePct);
    const kCount = Math.max(1, candidateKeys.length);
    const alphaAdj = (rule === "PRIMARY") ? alpha : (alpha / kCount); // Bonferroni
    const n = computeSampleSize({ sigma2, mdeAbs, alpha: alphaAdj, power });
    return { key: k, label: METRICS.find(m=>m.key===k)?.label || k, mu, n, alphaAdj };
  });

  const primaryRow = rows.find(r => r.key === primary) || rows[0];
  const recommendedN = useMemo(() => {
    if (rule === "PRIMARY") return primaryRow?.n ?? NaN;
    if (rule === "CO_PRIMARY") return rows.reduce((m, r) => Math.max(m, r.n || 0), 0);
    // ANY_OF — conservative Bonferroni split, recommend min n
    return rows.reduce((m, r) => (m === 0 ? r.n || 0 : Math.min(m, r.n || 0)), 0);
  }, [rule, rows.map(r=>r.n).join(","), primaryRow?.n]);

  // Light sanity
  useEffect(()=>{
    try {
      if (rule === "CO_PRIMARY") {
        const maxN = rows.reduce((m,r)=>Math.max(m, r.n||0), 0);
        console.assert(recommendedN === maxN, "Co-primary recommended n should be max across metrics");
      }
    } catch {}
  }, [rule, rows, recommendedN]);

  const pctHint = (sumDAUWindow>0 && Number.isFinite(recommendedN)) ? `${percentFmt(recommendedN / sumDAUWindow, 1)} per group over window` : "–";

  return (
    <div className="space-y-2">
      {/* Rule selector */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-gray-700">Rule</span>
        {[
          {id:"PRIMARY", label:"Primary metric"},
          {id:"CO_PRIMARY", label:"Co‑primary (AND)"},
          {id:"ANY_OF", label:"Any‑of (OR)"},
        ].map(opt => (
          <label key={opt.id} className={`px-2 py-1 rounded-xl border text-sm cursor-pointer ${rule===opt.id?"bg-indigo-600 text-white border-indigo-600":"bg-white text-gray-700 border-gray-300"}`}>
            <input type="radio" name="rule" className="hidden" checked={rule===opt.id} onChange={()=>setRule(opt.id)} />
            {opt.label}
          </label>
        ))}
      </div>

      {/* Params */}
      <div className="grid grid-cols-2 gap-2">
        <label className="flex items-center justify-between gap-2 text-sm text-gray-700 col-span-2 sm:col-span-1">
          <span>MDE (% of control)</span>
          <input type="number" step={0.01} min={0} value={mdePct}
            onChange={(e)=>setMdePct(Number(e.target.value)||0)}
            className="w-28 rounded-xl border border-gray-300 px-2 py-1 focus:outline-none focus:ring-2 focus:ring-indigo-500"/>
        </label>
        <label className="flex items-center justify-between gap-2 text-sm text-gray-700 col-span-2 sm:col-span-1">
          <span>Power</span>
          <input type="number" step={0.01} min={0.5} max={0.999} value={power}
            onChange={(e)=>setPower(Number(e.target.value)||0.8)}
            className="w-28 rounded-xl border border-gray-300 px-2 py-1 focus:outline-none focus:ring-2 focus:ring-indigo-500"/>
        </label>
        <label className="flex items-center justify-between gap-2 text-sm text-gray-700 col-span-2 sm:col-span-1">
          <span>Alpha</span>
          <input type="number" step={0.001} min={0.0001} max={0.5} value={alpha}
            onChange={(e)=>setAlpha(Number(e.target.value)||0.05)}
            className="w-28 rounded-xl border border-gray-300 px-2 py-1 focus:outline-none focus:ring-2 focus:ring-indigo-500"/>
        </label>
        {rule === "PRIMARY" && (
          <label className="flex items-center justify-between gap-2 text-sm text-gray-700 col-span-2 sm:col-span-1">
            <span>Primary metric</span>
            <select value={primary} onChange={(e)=>setPrimary(e.target.value)}
              className="w-44 rounded-xl border border-gray-300 px-2 py-1 focus:outline-none focus:ring-2 focus:ring-indigo-500">
              {candidateKeys.map(k => (
                <option key={k} value={k}>{METRICS.find(m=>m.key===k)?.label||k}</option>
              ))}
            </select>
          </label>
        )}
      </div>

      {/* Table for co/any-of */}
      {(rule !== "PRIMARY") && (
        <div className="overflow-x-auto mt-1">
          <table className="min-w-full text-xs">
            <thead>
              <tr className="text-left text-gray-600 border-b">
                <th className="py-1 pr-3">Metric</th>
                <th className="py-1 pr-3">μ (per user)</th>
                <th className="py-1 pr-3">α used</th>
                <th className="py-1 pr-3">Target n</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.key} className="border-b last:border-b-0">
                  <td className="py-1 pr-3">{r.label}</td>
                  <td className="py-1 pr-3">{numberFmt(r.mu)}</td>
                  <td className="py-1 pr-3">{r.alphaAdj?.toFixed(4)}</td>
                  <td className="py-1 pr-3">{Number.isFinite(r.n)? r.n.toLocaleString():"–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Primary row summary */}
      {rule === "PRIMARY" && (
        <div className="flex items-center justify-between text-sm mt-1">
          <div>Target n for <b>{primaryRow?.label}</b></div>
          <div className="font-medium">{Number.isFinite(primaryRow?.n) ? primaryRow.n.toLocaleString() : "–"}</div>
        </div>
      )}

      <div className="flex items-center justify-between text-sm mt-2">
        <div><b>Recommended n</b> (per group)</div>
        <div className="font-semibold">{Number.isFinite(recommendedN) ? recommendedN.toLocaleString() : "–"}</div>
      </div>

      <div className="flex items-center justify-between text-xs text-gray-600">
        <div>≈ {pctHint}</div>
        <button type="button" onClick={()=> applyToSplit(Number(recommendedN))} className="px-3 py-1.5 rounded-xl bg-indigo-600 text-white hover:bg-indigo-700">Apply as split</button>
      </div>

      <p className="text-[11px] text-gray-500 mt-1">
        PRIMARY sizes for a single metric. CO‑PRIMARY (AND) uses Bonferroni α/k and recommends the max n across metrics. ANY‑OF (OR) uses Bonferroni α/k and recommends the min n (conservative). Applying will set Control/Experiment to equal traffic shares that achieve the target N over the test window.
      </p>
    </div>
  );
}

// === Sample Size Controls (reusable) ===
function SampleSizeControls({ data, selectedKeys = [], sumDAUWindow = 0, applyToSplit }){
  const allKeys = METRICS.map(m=>m.key);
  const options = (selectedKeys.length ? allKeys.filter(k => selectedKeys.includes(k)) : allKeys)
    .filter(k => SUCCESS_KEYS.includes(k) || GUARDRAIL_KEYS.includes(k));
  const defaultKey = options[0] || SUCCESS_KEYS[0];

  const [metric, setMetric] = useState(defaultKey);
  const [alpha, setAlpha] = useState(0.05);
  const [power, setPower] = useState(0.8);
  const [mdePct, setMdePct] = useState(0.10); // 10%
  const [varOverride, setVarOverride] = useState("");

  useEffect(()=>{ if (!options.includes(metric)) setMetric(defaultKey); }, [selectedKeys.join("|")]);

  const muC = useMemo(()=> basePerUser(metric, data), [metric, data]);
  const sigma2Default = muC * (1 + 0.05);
  const sigma2 = varOverride === "" ? sigma2Default : Math.max(1e-12, Number(varOverride));
  const mdeAbs = muC * Math.max(0, mdePct);
  const targetN = useMemo(()=> computeSampleSize({ sigma2, mdeAbs, alpha, power }), [sigma2, mdeAbs, alpha, power]);

  useEffect(() => {
    try {
      console.assert(Math.abs(invNorm(0.975) - 1.95996) < 0.02, "invNorm sanity");
      const biggerMDE = computeSampleSize({ sigma2, mdeAbs: mdeAbs*2, alpha, power });
      console.assert(Number.isFinite(targetN) && biggerMDE <= targetN, "Larger MDE should reduce n");
    } catch {}
  }, [sigma2, mdeAbs, alpha, power, targetN]);

  const pctHint = (sumDAUWindow>0 && Number.isFinite(targetN)) ? `${percentFmt(targetN / sumDAUWindow, 1)} per group over window` : "–";

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <label className="text-sm text-gray-700">Metric</label>
        <select
          className="w-48 rounded-xl border border-gray-300 px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          value={metric}
          onChange={(e)=>setMetric(e.target.value)}
        >
          {options.map(k => (
            <option key={k} value={k}>{METRICS.find(m=>m.key===k)?.label||k}</option>
          ))}
        </select>
      </div>
      <div className="flex items-center justify-between gap-3">
        <label className="text-sm text-gray-700">Control mean (per user)</label>
        <div className="w-48 text-right text-sm">{numberFmt(muC)}</div>
      </div>
      <div className="flex items-center justify-between gap-3">
        <label className="text-sm text-gray-700">Variance (σ²)</label>
        <input type="number" step={0.01} value={varOverride}
          placeholder={String(numberFmt(sigma2Default))}
          onChange={(e)=>setVarOverride(e.target.value)}
          className="w-48 rounded-xl border border-gray-300 px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-500"/>
      </div>
      <div className="flex items-center justify-between gap-3">
        <label className="text-sm text-gray-700">MDE (% of control mean)</label>
        <input type="number" step={0.01} min={0} value={mdePct}
          onChange={(e)=>setMdePct(Number(e.target.value) || 0)}
          className="w-48 rounded-xl border border-gray-300 px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-500"/>
      </div>
      <div className="flex items-center justify-between gap-3">
        <label className="text-sm text-gray-700">Alpha (two‑tailed)</label>
        <input type="number" step={0.001} min={0.0001} max={0.5} value={alpha}
          onChange={(e)=>setAlpha(Number(e.target.value) || 0.05)}
          className="w-48 rounded-xl border border-gray-300 px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-500"/>
      </div>
      <div className="flex items-center justify-between gap-3">
        <label className="text-sm text-gray-700">Power</label>
        <input type="number" step={0.01} min={0.5} max={0.999} value={power}
          onChange={(e)=>setPower(Number(e.target.value) || 0.8)}
          className="w-48 rounded-xl border border-gray-300 px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-500"/>
      </div>

      <div className="flex items-center justify-between gap-3 pt-2">
        <div className="text-sm text-gray-700">Target n per group</div>
        <div className="w-48 text-right font-medium">{Number.isFinite(targetN) ? targetN.toLocaleString() : "–"}</div>
      </div>

      <div className="flex items-center justify-between text-xs text-gray-600">
        <div>≈ {pctHint}</div>
        <button type="button" onClick={()=> applyToSplit(Number(targetN))} className="px-3 py-1.5 rounded-xl bg-indigo-600 text-white hover:bg-indigo-700">Apply as split</button>
      </div>

      <p className="text-xs text-gray-500">Formula: n = 2 · (z<sub>1-α/2</sub> + z<sub>power</sub>)² · σ² / (MDE<sub>abs</sub>)². Applying will set equal Control/Experiment traffic shares to hit this n over the current test window.</p>
    </div>
  );
}
