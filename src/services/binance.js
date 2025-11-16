// src/services/binance.js
const fetch     = global.fetch || require('node-fetch');
const WebSocket = require('ws');

const { FAPI, ENDPT } = require('../config');
const {
  BOOK,
  SYMBOLS,
  setSYMBOLS,
  appendTradeNDJSON,
  now,
  OI_PROGRESS,
  setBOOT,
  setOIHist,
  saveOIHistToFile
} = require('../store');

const wsBus = require('../ws');

// ========== 通用安全请求 ==========

async function safeJSON(url){
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

// ========== 拉 USDT 永续列表 ==========

async function listUSDTPerpSymbols(){
  const ex = await safeJSON(FAPI + ENDPT.exchangeInfo);
  return (ex.symbols || [])
    .filter(s => s.contractType === 'PERPETUAL')
    .filter(s => s.quoteAsset   === 'USDT')
    .filter(s => s.marginAsset  === 'USDT')
    .filter(s => s.status       === 'TRADING')
    .map(s => s.symbol);
}

// ========== premiumAll：价格 + 资金费率快照 ==========

async function refreshPremiumAll(){
  const arr = await safeJSON(FAPI + ENDPT.premiumAll);
  const t   = now();

  for (const it of arr){
    const sym = it.symbol;
    if (!sym.endsWith('USDT')) continue;

    const mp = Number(it.markPrice);
    if (!Number.isFinite(mp)) continue;

    const fr   = it.lastFundingRate != null ? Number(it.lastFundingRate) * 100 : null;
    const prev = BOOK.get(sym) || {};
    const oi   = prev.openInterest;

    const notional = (Number.isFinite(oi) && Number.isFinite(mp)) ? oi * mp : NaN;

    BOOK.set(sym, {
      symbol      : sym,
      markPrice   : mp,
      fundingRate : fr ?? prev.fundingRate,
      openInterest: oi,
      notionalUSD : notional,
      updatedAt   : t
    });
  }
}

// ========== 实时 openInterest：只保留当前值，不落盘 ==========

async function refreshOpenInterestAll(){
  const syms = SYMBOLS();
  OI_PROGRESS.total = syms.length;
  OI_PROGRESS.done  = 0;

  for (const sym of syms){
    try{
      const j  = await safeJSON(FAPI + ENDPT.openInterest + encodeURIComponent(sym));
      const oi = Number(j.openInterest);
      const prev = BOOK.get(sym) || {};
      const mp   = prev.markPrice;

      BOOK.set(sym, {
        symbol      : sym,
        markPrice   : mp,
        fundingRate : prev.fundingRate,
        openInterest: oi,
        notionalUSD : (Number.isFinite(oi) && Number.isFinite(mp)) ? oi * mp : NaN,
        updatedAt   : now()
      });
    }catch(e){
      // 忽略单个失败
    }
    OI_PROGRESS.done++;
  }
}

// ========== markPrice WS ==========

function startBinanceWS(){
  const url = 'wss://fstream.binance.com/stream?streams=!markPrice@arr@1s';
  const ws  = new WebSocket(url);

  // 防止 markPrice 流异常把进程干掉
  ws.on('error', err=>{
    console.warn('binance markPrice ws error:', err && err.message);
  });

  ws.on('message', buf=>{
    try{
      const obj = JSON.parse(buf.toString());
      const arr = obj.data;
      if (!Array.isArray(arr)) return;

      const t = now();
      const changed = [];

      for (const it of arr){
        const sym = it.s;
        if (!BOOK.has(sym)) continue;

        const mp = Number(it.p);
        if (!Number.isFinite(mp)) continue;

        const fr   = it.r != null ? Number(it.r) * 100 : null;
        const prev = BOOK.get(sym);

        const notional = Number.isFinite(prev.openInterest)
          ? mp * prev.openInterest
          : NaN;

        const next = {
          ...prev,
          markPrice   : mp,
          fundingRate : fr ?? prev.fundingRate,
          notionalUSD : notional,
          updatedAt   : t
        };

        BOOK.set(sym, next);
        changed.push({ s: sym, p: mp, r: next.fundingRate, u: t });
      }

      if (changed.length) wsBus.broadcastDelta(changed);
    }catch(e){}
  });
}

// ========== 成交 WS（单合约流） ==========

let wsTrades = null;

// 单独封装一个安全关闭
function safeCloseTradesWS(){
  if (!wsTrades) return;
  try{
    wsTrades.removeAllListeners('message');
    wsTrades.removeAllListeners('error');
    wsTrades.close();
  }catch(e){}
  wsTrades = null;
}

function switchTradesSymbol(symRaw){
  const sym = String(symRaw).toUpperCase().trim();
  if (!sym.endsWith('USDT')) return;

  // 先安全关掉旧 ws，吞掉它在关闭时抛的错误
  safeCloseTradesWS();

  const url = `wss://fstream.binance.com/ws/${sym.toLowerCase()}@aggTrade`;
  const ws  = new WebSocket(url);
  wsTrades  = ws;

  // ⭐ 一定要监听 error，防止 “closed before established” 这类错误把进程炸掉
  ws.on('error', err=>{
    console.warn('trades ws error:', err && err.message);
  });

  ws.on('message', buf=>{
    try{
      const d = JSON.parse(buf.toString());
      const p = Number(d.p);
      const q = Number(d.q);
      if (!Number.isFinite(p) || !Number.isFinite(q)) return;

      const ts = d.T || d.E || Date.now();
      const nu = p * q;
      const m  = !!d.m;

      const t = { s: sym, p, q, nu, ts, m };

      appendTradeNDJSON(sym, t);
      wsBus.broadcastTrades([t]);
    }catch(e){}
  });
}

wsBus.setClientMsgHandler((msg)=>{
  if (msg.t === 'subTrades') switchTradesSymbol(msg.symbol);
});

// ========== openInterestHist：Binance 原始 OI 历史 ==========
// period: '5m','15m','30m','1h','2h','4h','6h','12h','1d'
// limit:  最大 500
// startTime / endTime: 可选时间区间（毫秒）

async function fetchOpenInterestHistory(symbol, period='5m', limit=500, startTime, endTime){
  const qs = new URLSearchParams();
  qs.set('symbol', symbol);
  qs.set('period', period);
  qs.set('limit', String(limit));
  if (Number.isFinite(startTime)) qs.set('startTime', String(startTime));
  if (Number.isFinite(endTime))   qs.set('endTime',   String(endTime));

  const url = `${FAPI}${ENDPT.openInterestHist}?${qs.toString()}`;
  const arr = await safeJSON(url);

  return arr.map(x => ({
    t : Number(x.timestamp),
    oi: Number(x.sumOpenInterest),
    // openInterestHist 的 price 基本是 null，这里统一置 null
    mp: null,
    nu: x.sumOpenInterestValue != null ? Number(x.sumOpenInterestValue) : null
  }));
}

// ========== k 线拿价格历史（收盘价） ==========
// interval: '5m','15m','30m','1h','2h','4h','6h','12h','1d'

async function fetchMarkPriceHistory(symbol, interval='5m', limit=500, startTime, endTime){
  const qs = new URLSearchParams();
  qs.set('symbol', symbol);
  qs.set('interval', interval);
  qs.set('limit', String(Math.min(limit, 1500)));
  if (Number.isFinite(startTime)) qs.set('startTime', String(startTime));
  if (Number.isFinite(endTime))   qs.set('endTime',   String(endTime));

  const url = `${FAPI}/fapi/v1/klines?${qs.toString()}`;
  const arr = await safeJSON(url);

  // kline: [openTime, open, high, low, close, volume, closeTime, ...]
  return arr.map(k => ({
    t  : Number(k[0]),   // openTime
    mp : Number(k[4])    // close
  }));
}

// ========== 刷新所有合约的 OI 历史，写入内存 + 文件 cache ==========

async function refreshAllOIHistory(){
  const syms   = SYMBOLS();
  const period = '5m';
  const limit  = 500;

  for (const sym of syms){
    try{
      const samples = await fetchOpenInterestHistory(sym, period, limit);
      setOIHist(sym, samples);
    }catch(e){
      // 某个 symbol 异常直接跳过
    }
  }

  // 写到 data/oi_hist.json
  saveOIHistToFile();
}

// ========== 启动 ==========

async function bootstrap(){
  const list = await listUSDTPerpSymbols();
  setSYMBOLS(list);

  // 价格 / FR
  await refreshPremiumAll();
  startBinanceWS();

  // 当前 OI 快照（用于 table）
  await refreshOpenInterestAll();

  // 初始化拉一轮 OI 历史，用来画图
  await refreshAllOIHistory();

  // 标记启动完成，前端 progress 就会放行
  setBOOT(true);

  // 定时刷新：快照
  setInterval(refreshOpenInterestAll, 180000);  // 3min
  setInterval(refreshPremiumAll,      30000);   // 30s

  // 定时刷新：OI 历史 cache（全量覆盖）
  setInterval(refreshAllOIHistory, 5 * 60 * 1000); // 5min
}

module.exports = {
  bootstrap,
  switchTradesSymbol,
  fetchOpenInterestHistory,
  fetchMarkPriceHistory
};
