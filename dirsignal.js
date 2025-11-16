// src/services/signal.js
// 方向判别器：用 Binance 全量指标 + 价/OI 变化做合成判断
// 依赖 config.js，不允许写死 URL

const { FAPI, ENDPT } = require('../config');

// 允许的 period 映射（尽量贴近你前端的粒度）
const PERIODS = ['5m','15m','30m','1h','2h','4h','8h','12h','1d'];

// 取最近 N 条窗口数据（覆盖窗口时长即可）
function chooseLimit(ms, period){
  const stepMs = (
    period.endsWith('m') ? Number(period.replace('m',''))*60_000 :
    period.endsWith('h') ? Number(period.replace('h',''))*3_600_000 :
    period === '1d'      ? 86_400_000 :
                           3_600_000
  );
  return Math.max(3, Math.min(500, Math.ceil(ms/stepMs) + 3));
}

// 取“最接近窗口”的 period
function pickPeriod(ms){
  const order = [
    ['5m',   5*60_000],
    ['15m', 15*60_000],
    ['30m', 30*60_000],
    ['1h',   3_600_000],
    ['2h',   7_200_000],
    ['4h',  14_400_000],
    ['8h',  28_800_000],
    ['12h', 43_200_000],
    ['1d',  86_400_000],
  ];

  let best = '1h';
  let diff = Number.MAX_VALUE;

  for (const [p,v] of order){
    const d = Math.abs(v - ms);
    if (d < diff){
      diff = d;
      best = p;
    }
  }
  return best;
}

// ========== 拉取 taker long/short ==========
async function fetchTakerRatio(symbol, period, limit){
  const url =
    `${FAPI}${ENDPT.takerRatio}?symbol=${symbol}&period=${period}&limit=${limit}`;

  const r = await fetch(url);
  if (!r.ok) throw new Error(`takerRatio ${r.status}`);
  return r.json();
}

// ========== 拉取全量账户 long/short ==========
async function fetchGlobalAcctRatio(symbol, period, limit){
  const url =
    `${FAPI}${ENDPT.globalAcct}?symbol=${symbol}&period=${period}&limit=${limit}`;

  const r = await fetch(url);
  if (!r.ok) throw new Error(`globalAcct ${r.status}`);
  return r.json();
}

// ========== 在窗口内聚合 ==========
function aggregateWithinWindow(arr, sinceTs, valueKey, timeKey){
  const win = arr.filter(x => Number(x[timeKey]) >= sinceTs);
  if (!win.length) return null;

  const last = Number(win[win.length - 1][valueKey]);
  const mean = win.reduce((s,x)=> s + Number(x[valueKey]), 0) / win.length;

  return { last, mean, n: win.length };
}

// ========== 方向规则 ==========
function decideDirection({ dPrice, dOI, taker, global }){
  let quad;

  if (dOI > 0 && dPrice >= 0) quad = '多开';
  else if (dOI > 0 && dPrice < 0) quad = '空开';
  else if (dOI <= 0 && dPrice >= 0) quad = '空回补';
  else quad = '多回补';

  const bias = (taker>1?1:-1) + (global>1?1:-1); // -2..+2

  let score = quad.endsWith('开') ? 0.55 : 0.5;

  if (quad==='多开' && dPrice>0) score+=0.05;
  if (quad==='空开' && dPrice<0) score+=0.05;
  if (quad==='空回补' && dPrice>0) score+=0.05;
  if (quad==='多回补' && dPrice<0) score+=0.05;

  score += (Math.abs(bias)/2)*0.2;

  if ((quad==='多开' || quad==='空回补') && bias<0) score -= 0.1;
  if ((quad==='空开' || quad==='多回补') && bias>0) score -= 0.1;

  return {
    label: quad,
    score: Math.max(0.05, Math.min(0.95, score))
  };
}

/**
 * 计算某 symbol 在窗口 ms 内的方向信号
 */
async function windowSignal(symbol, ms, baseLast){
  const period = pickPeriod(ms);
  const limit  = chooseLimit(ms, period);
  const since  = Date.now() - ms;

  let takerAgg=null, acctAgg=null;

  try{
    const tk = await fetchTakerRatio(symbol, period, limit);
    takerAgg = aggregateWithinWindow(tk, since, 'buySellRatio', 'time');
  }catch{}

  try{
    const ga = await fetchGlobalAcctRatio(symbol, period, limit);
    acctAgg = aggregateWithinWindow(ga, since, 'longShortRatio', 'timestamp');
  }catch{}

  const base = baseLast?.base;
  const last = baseLast?.last;

  if (!base || !last) {
    return { taker:null, global:null, decision:null };
  }

  const dPrice = last.mp - base.mp;
  const dOI    = last.oi - base.oi;

  const taker  = takerAgg?.last ?? takerAgg?.mean ?? null;
  const global = acctAgg?.last ?? acctAgg?.mean ?? null;

  let decision;
  if (taker!=null && global!=null){
    decision = decideDirection({ dPrice, dOI, taker:Number(taker), global:Number(global) });
  }else{
    decision = decideDirection({ dPrice, dOI, taker:1, global:1 });
    decision.score = 0.35;
  }

  return {
    taker: taker!=null ? Number(taker) : null,
    global: global!=null ? Number(global) : null,
    dPrice,
    dOI,
    decision
  };
}

module.exports = {
  windowSignal,
  pickPeriod
};
