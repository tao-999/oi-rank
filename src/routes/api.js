// src/routes/api.js
const {
  BOOK,
  SYMBOLS,
  OI_PROGRESS,
  BOOT_READY,
  now,
  getMCAP,
  getOIHist
} = require('../store');

const { normalizeBase } = require('../services/marketcap');
// 从 binance.js 引入两个函数
const {
  fetchOpenInterestHistory,
  fetchMarkPriceHistory
} = require('../services/binance');

// ========== 工具：symbol -> base ==========

function baseFromPerp(sym){
  if (!sym) return null;
  if (sym.endsWith('USDT')) return normalizeBase(sym.slice(0, -4));
  return normalizeBase(sym);
}

// ========== 解析 wins 字符串：30m,1h,4h,24h -> [ms, ms, ...] ==========

function parseWins(str){
  if (!str) return [];
  const out = [];
  const seen = new Set();

  for (const raw of str.split(/[,，\s]+/)){
    const s = raw.trim();
    if (!s) continue;
    const m = s.match(/^(\d+)([mhdw])$/i);
    if (!m) continue;
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n <= 0) continue;

    let ms = 0;
    const u = m[2].toLowerCase();
    if (u === 'm') ms = n * 60 * 1000;
    else if (u === 'h') ms = n * 60 * 60 * 1000;
    else if (u === 'd') ms = n * 24 * 60 * 60 * 1000;
    else if (u === 'w') ms = n * 7 * 24 * 60 * 60 * 1000;
    if (!ms) continue;

    if (!seen.has(ms)){
      seen.add(ms);
      out.push(ms);
    }
  }
  return out.slice(0, 6);
}

// ========== 计算某个窗口内的 OI 百分比增量 ==========

function calcWindowPct(samples, winMs){
  if (!Array.isArray(samples) || samples.length < 2) return null;

  const last = samples[samples.length - 1];
  if (!Number.isFinite(last.oi) || !Number.isFinite(last.t)) return null;

  const tEnd   = Number(last.t);
  const tStart = tEnd - winMs;

  let base = null;

  for (let i = samples.length - 1; i >= 0; i--){
    const s  = samples[i];
    const ts = Number(s.t);
    if (!Number.isFinite(ts) || !Number.isFinite(s.oi)) continue;

    if (ts <= tStart){
      base = s;
      break;
    }
    base = s;
  }

  if (!base || !Number.isFinite(base.oi) || base.oi === 0) return null;

  return (last.oi - base.oi) / base.oi;
}

// ========== /api/progress ==========

async function progress(req, res){
  const total = SYMBOLS().length || OI_PROGRESS.total || 0;
  const done  = OI_PROGRESS.done;

  const logicalBoot = BOOT_READY() || (total > 0 && done >= total);

  const ratio = total
    ? Math.min(done / total, 1)
    : (logicalBoot ? 1 : 0);

  res.writeHead(200, { 'Content-Type':'application/json' });
  res.end(JSON.stringify({
    ts       : now(),
    bootReady: logicalBoot,
    total,
    done,
    ratio
  }));
}

// ========== /api/oi-rank ==========

async function oiRank(req, res){
  const urlObj  = new URL(req.url, 'http://local');
  const winsRaw = urlObj.searchParams.get('wins') || '';
  let winsMs    = parseWins(winsRaw);

  if (!winsMs.length){
    winsMs = [
      1 * 60 * 60 * 1000,
      4 * 60 * 60 * 1000,
      24 * 60 * 60 * 1000
    ];
  }

  const mcap = getMCAP();

  const rows = SYMBOLS().map(sym => {
    const r = BOOK.get(sym) || {
      symbol      : sym,
      markPrice   : NaN,
      fundingRate : null,
      openInterest: NaN,
      notionalUSD : NaN,
      updatedAt   : null
    };

    const base = baseFromPerp(sym);
    const cap  = base ? mcap.get(base) : undefined;

    const hist  = getOIHist(sym) || [];
    const trend = {};

    for (const wMs of winsMs){
      const p = calcWindowPct(hist, wMs);
      if (p != null){
        trend[wMs] = { pct: p };
      }
    }

    return {
      ...r,
      marketCapUSD: Number.isFinite(cap) ? cap : undefined,
      trend
    };
  });

  res.writeHead(200, { 'Content-Type':'application/json' });
  res.end(JSON.stringify({
    ts    : now(),
    total : SYMBOLS().length,
    count : rows.length,
    winsMs: winsMs,
    rows
  }));
}

// ========== /api/history ==========
// 统一返回：samples: [{ t, oi, nu, mp }]

async function history(req, res, urlObj){
  const symRaw = (urlObj.searchParams.get('symbol') || '').toUpperCase().trim();
  const limitN = Number(urlObj.searchParams.get('limit') || 500);
  const limit  = Number.isFinite(limitN) ? Math.min(Math.max(limitN, 10), 5000) : 500;

  const period   = (urlObj.searchParams.get('period') || '').trim();
  const startStr = urlObj.searchParams.get('startTime');
  const endStr   = urlObj.searchParams.get('endTime');

  const startTime = startStr != null ? Number(startStr) : NaN;
  const endTime   = endStr   != null ? Number(endStr)   : NaN;

  if (!symRaw.endsWith('USDT')){
    res.writeHead(400, { 'Content-Type':'application/json' });
    return res.end(JSON.stringify({ error:'bad symbol' }));
  }

  let samples = [];

  try{
    const hasPeriod   = !!period;
    const hasTimeCond = Number.isFinite(startTime) || Number.isFinite(endTime);

    let oiList    = [];
    let priceList = [];

    if (!hasPeriod && !hasTimeCond){
      // ===== 默认：用本地 cache 的 5m OI，再按时间范围拉一份 5m 价格 =====
      const all = getOIHist(symRaw) || [];
      oiList = all.length > limit ? all.slice(-limit) : all;

      if (oiList.length){
        const st = Number(oiList[0].t);
        const et = Number(oiList[oiList.length - 1].t);
        priceList = await fetchMarkPriceHistory(symRaw, '5m', oiList.length, st, et);
      }
    }else{
      // ===== 带 period / 时间条件：OI & 价格都实时从 Binance 拉 =====
      const p  = period || '5m';
      const st = Number.isFinite(startTime) ? startTime : undefined;
      const et = Number.isFinite(endTime)   ? endTime   : undefined;
      const apiLimit = Math.min(limit, 500);

      oiList = await fetchOpenInterestHistory(symRaw, p, apiLimit, st, et);

      try{
        priceList = await fetchMarkPriceHistory(symRaw, p, apiLimit, st, et);
      }catch(e){
        // 价格失败就只返回 OI，mp=null，避免整个接口 500
        priceList = [];
      }
    }

    // ===== 按时间对齐：对每个 OI 点，用最近的 price.t <= oi.t =====
    oiList = (oiList || []).map(s => ({
      t : Number(s.t),
      oi: Number(s.oi),
      nu: s.nu != null ? Number(s.nu) : null
    })).sort((a,b)=>a.t-b.t);

    priceList = (priceList || []).map(p => ({
      t : Number(p.t),
      mp: Number(p.mp)
    })).filter(p => Number.isFinite(p.t) && Number.isFinite(p.mp))
      .sort((a,b)=>a.t-b.t);

    let pi = 0;
    samples = oiList.map(s => {
      const t = s.t;

      // 价格指针往前推进到 <= t 的最后一个
      while (pi + 1 < priceList.length && priceList[pi + 1].t <= t){
        pi++;
      }

      const mp = (priceList[pi] && priceList[pi].t <= t)
        ? priceList[pi].mp
        : null;

      return {
        t  : t,
        oi : s.oi,
        nu : s.nu,
        mp : Number.isFinite(mp) ? mp : null
      };
    });

  }catch(e){
    res.writeHead(500, { 'Content-Type':'application/json' });
    return res.end(JSON.stringify({
      error  : 'fetch history failed',
      message: String(e)
    }));
  }

  res.writeHead(200, { 'Content-Type':'application/json' });
  res.end(JSON.stringify({
    symbol : symRaw,
    count  : samples.length,
    samples
  }));
}


module.exports = {
  progress,
  oiRank,
  history
};
