const fetch = global.fetch || require('node-fetch'); // Node18 内置 fetch；老版本兜底
const WebSocket = require('ws');
const { FAPI, ENDPT } = require('../config');
const { BOOK, SYMBOLS, setSYMBOLS, histPush, appendNDJSON, readHistoryMerged, BOOT_READY, setBOOT, OI_PROGRESS, setOISweep, now } = require('../store');
const { broadcastDelta } = require('../ws');

let wsBinance=null, wsMsgCount=0, wsLastBeat=0, reconnectDelay=3000;

async function safeJSON(url){
  const r = await fetch(url, { cache: 'no-store' });
  if(!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.json();
}
async function listUSDTPerpSymbols(){
  try{
    const ex = await safeJSON(FAPI + ENDPT.exchangeInfo);
    const list = (ex.symbols||[])
      .filter(s => s.contractType === 'PERPETUAL')
      .filter(s => s.quoteAsset === 'USDT' && s.marginAsset === 'USDT')
      .filter(s => s.status === 'TRADING')
      .map(s => s.symbol);
    if (list.length) return list;
  }catch{}
  const arr = await safeJSON(FAPI + ENDPT.tickers);
  return arr.map(x=>x.symbol).filter(s => !s.includes('_') && s.endsWith('USDT'));
}
async function refreshPremiumAll(){
  const arr = await safeJSON(FAPI + ENDPT.premiumAll);
  const t = now();
  for(const it of arr){
    const sym = it.symbol;
    if (!sym || sym.includes('_') || !sym.endsWith('USDT')) continue;
    const mp = Number(it.markPrice); if (!Number.isFinite(mp)) continue;
    const fr = (it.lastFundingRate!=null) ? Number(it.lastFundingRate)*100 : null;
    const prev = BOOK.get(sym) || { symbol: sym, openInterest: NaN, fundingRate: null, markPrice: NaN, notionalUSD: NaN };
    const notional = Number.isFinite(prev.openInterest) ? prev.openInterest * mp : NaN;
    BOOK.set(sym, { symbol:sym, markPrice:mp, fundingRate: fr ?? prev.fundingRate, openInterest: prev.openInterest, notionalUSD: notional, time: prev.time || it.time || t, updatedAt: t });
  }
}
async function refreshOpenInterestAll({ conc=8, sleepMs=60, trackProgress=false } = {}){
  const syms = SYMBOLS();
  if (!syms.length) return 0;
  let i = 0, ok = 0;
  if (trackProgress) { OI_PROGRESS.total = syms.length; OI_PROGRESS.done = 0; }
  async function worker(){
    while (i < syms.length){
      const sym = syms[i++];
      try{
        const j = await safeJSON(FAPI + ENDPT.openInterest + encodeURIComponent(sym));
        const oi = Number(j.openInterest);
        const t  = j.time || now();
        const prev = BOOK.get(sym) || { symbol: sym, markPrice: NaN, fundingRate: null };
        const mp   = prev.markPrice;
        const notional = (Number.isFinite(oi) && Number.isFinite(mp)) ? oi * mp : NaN;

        const row = { symbol:sym, markPrice:mp, fundingRate:prev.fundingRate, openInterest:oi, notionalUSD:notional, time:t, updatedAt:now() };
        BOOK.set(sym, row); ok++;

        if (Number.isFinite(oi)) {
          const sample = { t, oi, mp: Number.isFinite(mp)?mp:null, nu: Number.isFinite(notional)?notional:null };
          histPush(sym, sample);
          appendNDJSON(sym, sample);
        }
      }catch{}
      if (trackProgress) OI_PROGRESS.done++;
      await new Promise(r=> setTimeout(r, sleepMs + (Math.random()*50|0)));
    }
  }
  await Promise.all(Array.from({length: conc}, worker));
  return ok;
}
function startBinanceWS(){
  try{ if(wsBinance) wsBinance.close(); }catch{}
  const url = 'wss://fstream.binance.com/stream?streams=!markPrice@arr@1s';
  wsBinance = new (require('ws'))(url, { perMessageDeflate:false });

  wsBinance.on('open', ()=>{
    console.log('[WS] connected:', url);
    wsMsgCount = 0; wsLastBeat = now(); reconnectDelay = 3000;
    wsBinance._pingTimer = setInterval(()=>{ try{ wsBinance.ping(); }catch{} }, 15000);
    wsBinance._statTimer = setInterval(()=>{ console.log(`[WS] alive; msgs=${wsMsgCount} (+)`); wsMsgCount=0; }, 10000);
  });
  wsBinance.on('pong', ()=> wsLastBeat = now());
  wsBinance.on('message', (buf)=>{
    wsMsgCount++; wsLastBeat = now();
    try{
      const obj = JSON.parse(buf.toString());
      const arr = obj && obj.data; if(!Array.isArray(arr)) return;
      const t = now(); const changed=[];
      for(const it of arr){
        const sym = it.s; if(!BOOK.has(sym)) continue;
        const mp = Number(it.p); if(!Number.isFinite(mp)) continue;
        const fr = (it.r!=null) ? Number(it.r)*100 : undefined;
        const prev = BOOK.get(sym);
        const notional = Number.isFinite(prev.openInterest) ? prev.openInterest * mp : prev.notionalUSD;
        const next = { ...prev, markPrice:mp, fundingRate:(fr!==undefined?fr:prev.fundingRate), notionalUSD:notional, updatedAt:t };
        BOOK.set(sym, next);
        changed.push({ s:sym, p:next.markPrice, r:next.fundingRate, u:next.updatedAt });
      }
      if (changed.length) broadcastDelta(changed);
    }catch{}
  });
  wsBinance.on('close', ()=>{
    clearInterval(wsBinance._pingTimer); wsBinance._pingTimer=null;
    clearInterval(wsBinance._statTimer); wsBinance._statTimer=null;
    console.log('[WS] closed, retry in', reconnectDelay, 'ms');
    setTimeout(startBinanceWS, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay*2, 30000);
  });
  wsBinance.on('error', (e)=>{ console.error('[WS] error:', e?.message||e); try{ wsBinance.close(); }catch{} });
  wsBinance._guard = setInterval(()=>{ if (now()-wsLastBeat > 45000) { try{ wsBinance.terminate(); }catch{} } }, 10000);
}

async function bootstrap(){
  console.log('[INIT] load symbols...');
  const list = await listUSDTPerpSymbols();
  setSYMBOLS(list);
  console.log('[INIT] USDT perpetual symbols =', list.length);

  console.log('[INIT] prime premiumAll...');
  await refreshPremiumAll();

  console.log('[INIT] start WS ...');
  startBinanceWS();

  console.log('[INIT] prime OI (first sweep)...');
  setOISweep(true); setBOOT(false);
  await refreshOpenInterestAll({ conc: 8, sleepMs: 60, trackProgress: true }).catch(()=>{});
  setOISweep(false); setBOOT(true);
  console.log('[INIT] OI sweep done:', OI_PROGRESS.done);

  setInterval(async ()=>{
    try{
      setOISweep(true);
      OI_PROGRESS.total = (require('../store').SYMBOLS)().length;
      OI_PROGRESS.done  = 0;
      await refreshOpenInterestAll({ conc: 8, sleepMs: 60, trackProgress: true });
    } finally { setOISweep(false); }
  }, 180000);

  setInterval(()=>refreshPremiumAll().catch(()=>{}), 30000);
}

module.exports = { bootstrap, listUSDTPerpSymbols, refreshPremiumAll, refreshOpenInterestAll };
