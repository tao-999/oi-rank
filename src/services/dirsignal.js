// 方向判别器：用 Binance 全量指标 + 价/OI 变化做合成判断
// 依赖：Node18+ 原生 fetch；否则 npm i node-fetch 并换成 require('node-fetch')

const FAPI = 'https://fapi.binance.com';

// 允许的 period 映射（尽量贴近你前端的粒度）
const PERIODS = ['5m','15m','30m','1h','2h','4h','8h','12h','1d'];

// 取最近 N 条窗口数据（覆盖窗口时长即可）
function chooseLimit(ms, period){
  const stepMs = (
    period.endsWith('m') ? Number(period.replace('m',''))*60_000 :
    period.endsWith('h') ? Number(period.replace('h',''))*3_600_000 :
    period==='1d' ? 86_400_000 : 3_600_000
  );
  // 至少 3 条，至多 500（接口上限）
  return Math.max(3, Math.min(500, Math.ceil(ms/stepMs)+3));
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
  let best='1h', diff=Number.MAX_VALUE;
  for (const [p,v] of order){
    const d = Math.abs(v-ms);
    if (d < diff){ diff = d; best = p; }
  }
  return best;
}

// 拉取全量：主动成交方向 & 全量账户多空比
async function fetchTakerRatio(symbol, period, limit){
  const url = `${FAPI}/futures/data/takerlongshortRatio?symbol=${symbol}&period=${period}&limit=${limit}`;
  const r = await fetch(url, { headers: { 'accept':'application/json' }});
  if (!r.ok) throw new Error(`takerRatio ${r.status}`);
  return r.json(); // [{buySellRatio, time, ...}]
}
async function fetchGlobalAcctRatio(symbol, period, limit){
  const url = `${FAPI}/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=${period}&limit=${limit}`;
  const r = await fetch(url, { headers: { 'accept':'application/json' }});
  if (!r.ok) throw new Error(`globalAcct ${r.status}`);
  return r.json(); // [{longAccount, shortAccount, longShortRatio, timestamp}]
}

// 在时间窗内做简单聚合（末值或均值都可以；这里取窗内**加权末值为主，均值为辅**）
function aggregateWithinWindow(arr, sinceTs, valueKey, timeKey){
  const win = arr.filter(x => Number(x[timeKey]) >= sinceTs);
  if (!win.length) return null;
  // 末值
  const last = Number(win[win.length-1][valueKey]);
  // 简单均值（防止尖峰）
  const mean = win.reduce((s,x)=> s + Number(x[valueKey]), 0) / win.length;
  return { last, mean, n: win.length };
}

// —— 方向规则 —— //
// priceΔ 与 OIΔ 的象限给出“开/回补”的骨架；taker 与 global 两个全量指标给“多/空”权重
function decideDirection({ dPrice, dOI, taker, global }){
  // 基础象限标签
  let quad;
  if (dOI > 0 && dPrice >= 0) quad = '多开';
  else if (dOI > 0 && dPrice < 0) quad = '空开';
  else if (dOI <= 0 && dPrice >= 0) quad = '空回补';
  else quad = '多回补';

  // 指标倾向：>1 看多，<1 看空
  const bias = (taker>1?1:-1) + (global>1?1:-1); // -2..+2
  // 初始置信度：开仓类较强，回补类稍弱
  let score = (quad.endsWith('开') ? 0.55 : 0.5);
  // 与价格方向一致的再加点分
  if (quad==='多开' && dPrice>0) score+=0.05;
  if (quad==='空开' && dPrice<0) score+=0.05;
  if (quad==='空回补' && dPrice>0) score+=0.05;
  if (quad==='多回补' && dPrice<0) score+=0.05;

  // 指标加权：两个指标越一致，置信度越高
  score += (Math.abs(bias)/2)*0.2; // +0~0.2
  // 如果指标方向与象限强烈冲突，稍微降权
  if ((quad==='多开' || quad==='空回补') && bias<0) score -= 0.1;
  if ((quad==='空开' || quad==='多回补') && bias>0) score -= 0.1;

  // clamp
  score = Math.max(0.05, Math.min(0.95, score));
  return { label: quad, score };
}

/**
 * 计算某 symbol 在窗口 ms 内的方向信号
 * @param {string} symbol  如 'BTCUSDT'
 * @param {number} ms      窗口毫秒
 * @param {object} baseLast { base:{t,oi,mp,nu}, last:{t,oi,mp,nu} }
 */
async function windowSignal(symbol, ms, baseLast){
  const period = pickPeriod(ms);
  const limit  = chooseLimit(ms, period);
  const since  = Date.now() - ms;

  // 拉两条全量指标（容错返回 null）
  let takerAgg=null, acctAgg=null;
  try{
    const tk = await fetchTakerRatio(symbol, period, limit);
    takerAgg = aggregateWithinWindow(tk, since, 'buySellRatio', 'time');
  }catch{}
  try{
    const ga = await fetchGlobalAcctRatio(symbol, period, limit);
    acctAgg = aggregateWithinWindow(ga, since, 'longShortRatio', 'timestamp');
  }catch{}

  // 如果历史样本不全，直接返回空
  const base = baseLast?.base, last = baseLast?.last;
  if (!base || !last || !Number.isFinite(base.oi) || !Number.isFinite(last.oi) || !Number.isFinite(base.mp) || !Number.isFinite(last.mp)){
    return { taker:null, global:null, decision:null };
  }

  const dPrice = last.mp - base.mp;
  const dOI    = last.oi - base.oi;

  const taker  = takerAgg?.last ?? takerAgg?.mean ?? null;
  const global = acctAgg?.last ?? acctAgg?.mean ?? null;

  let decision = null;
  if (taker!=null && global!=null){
    decision = decideDirection({ dPrice, dOI, taker:Number(taker), global:Number(global) });
  }else{
    // 没拿到指标就仅靠象限
    decision = decideDirection({ dPrice, dOI, taker:1, global:1 });
    decision.score = 0.35; // 降级
  }

  return {
    taker: taker!=null ? Number(taker) : null,
    global: global!=null ? Number(global) : null,
    dPrice, dOI,
    decision
  };
}

module.exports = { windowSignal, pickPeriod };
