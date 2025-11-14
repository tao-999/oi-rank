// src/services/binance.js
const fetch = global.fetch || require('node-fetch'); // Node18 内置 fetch；老版本兜底
const WebSocket = require('ws');
const { FAPI, ENDPT } = require('../config');
const {
  BOOK,
  SYMBOLS,
  setSYMBOLS,
  histPush,
  appendNDJSON,
  readHistoryMerged,
  BOOT_READY,
  setBOOT,
  OI_PROGRESS,
  setOISweep,
  now,
  appendTradeNDJSON,   // ✅ 启用成交 ndjson 写入
} = require('../store');

// 避免循环依赖：拿整个 ws 总线对象，不解构
const wsBus = require('../ws');

let wsBinance = null, wsMsgCount = 0, wsLastBeat = 0, reconnectDelay = 3000;

// ====== 成交 WS：单合约流 ======
let wsTrades = null;
let tradesLastBeat = 0;
let tradesReconnectDelay = 3000;
let tradesSymbol = null;

// 每个 symbol 在内存里保留最近 10 万条（给前端表格用）
const MAX_TRADES_PER_SYM = 100000;
const RECENT_TRADES = new Map(); // Map<symbol, Array<trade>>

function pushRecentTrade(sym, t) {
  let arr = RECENT_TRADES.get(sym);
  if (!arr) { arr = []; RECENT_TRADES.set(sym, arr); }
  arr.push(t);
  if (arr.length > MAX_TRADES_PER_SYM) {
    arr.splice(0, arr.length - MAX_TRADES_PER_SYM);
  }
}

function getRecentTrades(sym) {
  return RECENT_TRADES.get(sym) || [];
}

// ================== 通用 REST ==================
async function safeJSON(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.json();
}

async function listUSDTPerpSymbols() {
  try {
    const ex = await safeJSON(FAPI + ENDPT.exchangeInfo);
    const list = (ex.symbols || [])
      .filter(s => s.contractType === 'PERPETUAL')
      .filter(s => s.quoteAsset === 'USDT' && s.marginAsset === 'USDT')
      .filter(s => s.status === 'TRADING')
      .map(s => s.symbol);
    if (list.length) return list;
  } catch { }

  const arr = await safeJSON(FAPI + ENDPT.tickers);
  return arr.map(x => x.symbol).filter(s => !s.includes('_') && s.endsWith('USDT'));
}

async function refreshPremiumAll() {
  const arr = await safeJSON(FAPI + ENDPT.premiumAll);
  const t = now();
  for (const it of arr) {
    const sym = it.symbol;
    if (!sym || sym.includes('_') || !sym.endsWith('USDT')) continue;
    const mp = Number(it.markPrice); if (!Number.isFinite(mp)) continue;
    const fr = (it.lastFundingRate != null) ? Number(it.lastFundingRate) * 100 : null;
    const prev = BOOK.get(sym) || { symbol: sym, openInterest: NaN, fundingRate: null, markPrice: NaN, notionalUSD: NaN };
    const notional = Number.isFinite(prev.openInterest) ? prev.openInterest * mp : NaN;
    BOOK.set(sym, {
      symbol: sym,
      markPrice: mp,
      fundingRate: fr ?? prev.fundingRate,
      openInterest: prev.openInterest,
      notionalUSD: notional,
      time: prev.time || it.time || t,
      updatedAt: t
    });
  }
}

async function refreshOpenInterestAll({ conc = 8, sleepMs = 60, trackProgress = false } = {}) {
  const syms = SYMBOLS();
  if (!syms.length) return 0;
  let i = 0, ok = 0;
  if (trackProgress) { OI_PROGRESS.total = syms.length; OI_PROGRESS.done = 0; }

  async function worker() {
    while (i < syms.length) {
      const sym = syms[i++];
      try {
        const j = await safeJSON(FAPI + ENDPT.openInterest + encodeURIComponent(sym));
        const oi = Number(j.openInterest);
        const t = j.time || now();
        const prev = BOOK.get(sym) || { symbol: sym, markPrice: NaN, fundingRate: null };
        const mp = prev.markPrice;
        const notional = (Number.isFinite(oi) && Number.isFinite(mp)) ? oi * mp : NaN;

        const row = {
          symbol: sym,
          markPrice: mp,
          fundingRate: prev.fundingRate,
          openInterest: oi,
          notionalUSD: notional,
          time: t,
          updatedAt: now()
        };
        BOOK.set(sym, row); ok++;

        if (Number.isFinite(oi)) {
          const sample = {
            t,
            oi,
            mp: Number.isFinite(mp) ? mp : null,
            nu: Number.isFinite(notional) ? notional : null
          };
          histPush(sym, sample);
          appendNDJSON(sym, sample);
        }
      } catch { }
      if (trackProgress) OI_PROGRESS.done++;
      await new Promise(r => setTimeout(r, sleepMs + (Math.random() * 50 | 0)));
    }
  }

  await Promise.all(Array.from({ length: conc }, worker));
  return ok;
}

/** ================== markPrice/资金费率 WS（原有逻辑） ================== */
function startBinanceWS() {
  try { if (wsBinance) wsBinance.close(); } catch { }

  const url = 'wss://fstream.binance.com/stream?streams=!markPrice@arr@1s';
  wsBinance = new WebSocket(url, { perMessageDeflate: false });

  wsBinance.on('open', () => {
    console.log('[WS] connected:', url);
    wsMsgCount = 0; wsLastBeat = now(); reconnectDelay = 3000;
    wsBinance._pingTimer = setInterval(() => { try { wsBinance.ping(); } catch { } }, 15000);
    wsBinance._statTimer = setInterval(() => { console.log(`[WS] alive; msgs=${wsMsgCount} (+)`); wsMsgCount = 0; }, 10000);
  });

  wsBinance.on('pong', () => wsLastBeat = now());

  wsBinance.on('message', (buf) => {
    wsMsgCount++; wsLastBeat = now();
    try {
      const obj = JSON.parse(buf.toString());
      const arr = obj && obj.data; if (!Array.isArray(arr)) return;
      const t = now(); const changed = [];
      for (const it of arr) {
        const sym = it.s; if (!BOOK.has(sym)) continue;
        const mp = Number(it.p); if (!Number.isFinite(mp)) continue;
        const fr = (it.r != null) ? Number(it.r) * 100 : undefined;
        const prev = BOOK.get(sym);
        const notional = Number.isFinite(prev.openInterest) ? prev.openInterest * mp : prev.notionalUSD;
        const next = {
          ...prev,
          markPrice: mp,
          fundingRate: (fr !== undefined ? fr : prev.fundingRate),
          notionalUSD: notional,
          updatedAt: t
        };
        BOOK.set(sym, next);
        changed.push({ s: sym, p: next.markPrice, r: next.fundingRate, u: next.updatedAt });
      }
      if (changed.length) wsBus.broadcastDelta(changed);
    } catch { }
  });

  wsBinance.on('close', () => {
    clearInterval(wsBinance._pingTimer); wsBinance._pingTimer = null;
    clearInterval(wsBinance._statTimer); wsBinance._statTimer = null;
    console.log('[WS] closed, retry in', reconnectDelay, 'ms');
    setTimeout(startBinanceWS, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  });

  wsBinance.on('error', (e) => {
    console.error('[WS] error:', e?.message || e);
    try { wsBinance.close(); } catch { }
  });

  wsBinance._guard = setInterval(() => {
    if (now() - wsLastBeat > 45000) {
      try { wsBinance.terminate(); } catch { }
    }
  }, 10000);
}

/** ================== ✅ 单合约 aggTrade WS ================== */

// 前端每次发送 {t:'subTrades', symbol:'BTCUSDT'} 就会走到这里
function switchTradesSymbol(symRaw) {
  const sym = String(symRaw || '').toUpperCase().trim();
  if (!sym) return;
  if (!sym.endsWith('USDT')) return; // 只处理 USDT 永续

  if (tradesSymbol === sym && wsTrades && wsTrades.readyState === WebSocket.OPEN) {
    // 已经订阅同一个，就不用动了
    return;
  }

  tradesSymbol = sym;
  tradesLastBeat = 0;
  tradesReconnectDelay = 3000;

  try { if (wsTrades) wsTrades.close(); } catch { }
  wsTrades = null;

  const stream = sym.toLowerCase() + '@aggTrade';
  const url = `wss://fstream.binance.com/ws/${stream}`;
  console.log('[WS-trades] connect symbol =', sym, 'url =', url);
  wsTrades = new WebSocket(url, { perMessageDeflate: false });

  wsTrades.on('open', () => {
    console.log('[WS-trades] opened for', sym);
    tradesLastBeat = now();
    wsTrades._pingTimer = setInterval(() => {
      try { wsTrades.ping(); } catch { }
    }, 15000);
  });

  wsTrades.on('pong', () => { tradesLastBeat = now(); });

  wsTrades.on('message', (buf) => {
    tradesLastBeat = now();
    try {
      const d = JSON.parse(buf.toString());
      // futures aggTrade: {e, E, s, a, p, q, f, l, T, m, M}
      const s = d.s || sym;
      const p = Number(d.p);
      const q = Number(d.q);
      const ts = d.T || d.E || Date.now();
      const m = !!d.m;       // true => taker 是卖方

      if (!Number.isFinite(p) || !Number.isFinite(q)) return;
      const nu = p * q;      // 成交额（USDT）

      const t = { s, p, q, nu, ts, m };

      // 1. 内存缓存（给前端表格上限 10W 条用）
      pushRecentTrade(s, t);

      // 2. ✅ 写入本地 ndjson：<symbol>.trade.ndjson
      appendTradeNDJSON(s, { ts, p, q, nu, m });

      // 3. 直接推给前端
      wsBus.broadcastTrades([t]);  // { t:'trades', rows:[...] }
    } catch (e) {
      console.error('[WS-trades] msg error:', e?.message || e);
    }
  });

  wsTrades.on('close', () => {
    clearInterval(wsTrades._pingTimer); wsTrades._pingTimer = null;
    console.log('[WS-trades] closed for', tradesSymbol);
    // 简单重连一次（如果还在同一个 symbol 上）
    if (tradesSymbol === sym) {
      setTimeout(() => switchTradesSymbol(sym), tradesReconnectDelay);
      tradesReconnectDelay = Math.min(tradesReconnectDelay * 2, 30000);
    }
  });

  wsTrades.on('error', (e) => {
    console.error('[WS-trades] error:', e?.message || e);
    try { wsTrades.close(); } catch { }
  });

  wsTrades._guard = setInterval(() => {
    if (now() - tradesLastBeat > 45000) {
      try { wsTrades.terminate(); } catch { }
    }
  }, 10000);
}

// ==== REST 获取某个合约的 aggTrades（给 /api/trades 兜底用，可留着不用） ====
async function fetchAggTrades(symbol, limit = 100) {
  const sym = String(symbol || '').toUpperCase().trim();
  if (!sym) return [];
  const lim = Math.min(Number(limit) || 100, 1000);
  const url = `${FAPI}${ENDPT.aggTrades}${encodeURIComponent(sym)}&limit=${lim}`;
  const arr = await safeJSON(url);
  if (!Array.isArray(arr)) return [];
  return arr;
}

// ✅ 注册前端 WS 消息处理函数（由 wsBus 转发）
wsBus.setClientMsgHandler((msg) => {
  if (msg && msg.t === 'subTrades' && msg.symbol) {
    switchTradesSymbol(msg.symbol);
  }
});

async function bootstrap() {
  console.log('[INIT] load symbols...');
  const list = await listUSDTPerpSymbols();
  setSYMBOLS(list);
  console.log('[INIT] USDT perpetual symbols =', list.length);

  console.log('[INIT] prime premiumAll...');
  await refreshPremiumAll();

  console.log('[INIT] start WS ...');
  startBinanceWS();   // markPrice / funding
  // 成交流不自动起，等前端 subTrades 时再 switchTradesSymbol

  console.log('[INIT] prime OI (first sweep)...');
  setOISweep(true); setBOOT(false);
  await refreshOpenInterestAll({ conc: 8, sleepMs: 60, trackProgress: true }).catch(() => { });
  setOISweep(false); setBOOT(true);
  console.log('[INIT] OI sweep done:', OI_PROGRESS.done);

  setInterval(async () => {
    try {
      setOISweep(true);
      OI_PROGRESS.total = (require('../store').SYMBOLS)().length;
      OI_PROGRESS.done = 0;
      await refreshOpenInterestAll({ conc: 8, sleepMs: 60, trackProgress: true });
    } finally { setOISweep(false); }
  }, 180000);

  setInterval(() => refreshPremiumAll().catch(() => { }), 30000);
}

module.exports = {
  bootstrap,
  listUSDTPerpSymbols,
  refreshPremiumAll,
  refreshOpenInterestAll,
  fetchAggTrades,

  // 给其他模块用
  switchTradesSymbol,
  getRecentTrades,
};
