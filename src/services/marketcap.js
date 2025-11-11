// 免费主源：CoinPaprika；可选兜底：CoinGecko（需 COINGECKO_KEY）
// 用法：在 server.js 已调用 start() 定时刷新

const fetch = global.fetch || require('node-fetch');
const { setMCAP } = require('../store');

const CG_KEY = process.env.COINGECKO_KEY || '';

/** 归一化：把永续合约的 BASE 还原为常见现货符号
 *  - 去掉前缀倍数：1000PEPE → PEPE；100SATS → SATS
 *  - 去掉常见杠杆尾缀：BULL/BEAR/UP/DOWN（极少出现在 U 本位合约，但兜一层）
 *  - 全大写
*/
function normalizeBase(sym) {
  if (!sym) return null;
  let s = String(sym).toUpperCase().trim();
  // 去掉前导纯数字倍数（1000PEPE/100SATS/10LUNC）
  s = s.replace(/^\d+(?=[A-Z])/,'');
  // 去掉常见杠杆后缀
  s = s.replace(/(BULL|BEAR|UP|DOWN)$/,'');
  // 少数特殊别名收敛
  if (s === 'XBT') s = 'BTC';
  if (s === 'BCC') s = 'BCH';
  return s;
}

/** 从 CoinPaprika 拉全量 tickers（无需 key） */
async function fetchPaprikaMap() {
  const url = 'https://api.coinpaprika.com/v1/tickers';
  const r = await fetch(url, { headers: { 'accept': 'application/json' } });
  if (!r.ok) throw new Error('paprika HTTP ' + r.status);
  const arr = await r.json();
  // arr[i]: { symbol, quotes: { USD: { market_cap } } ... }
  const map = new Map(); // Map<SYM, capUSD>
  for (const it of arr) {
    const sym = normalizeBase(it.symbol);
    const cap = it?.quotes?.USD?.market_cap;
    if (!sym || !Number.isFinite(cap)) continue;
    const prev = map.get(sym);
    // 同名取更大的（规避同符号山寨）
    if (!Number.isFinite(prev) || cap > prev) map.set(sym, cap);
  }
  return map;
}

/** 可选：CoinGecko 兜底（需要 key） */
async function fetchCoingeckoMap() {
  if (!CG_KEY) return new Map();
  // 拉前几页（每页 250）
  const headers = { 'accept': 'application/json', 'x-cg-demo-api-key': CG_KEY };
  async function page(p){
    const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&per_page=250&page=${p}`;
    const r = await fetch(url, { headers });
    if (!r.ok) throw new Error('cg HTTP ' + r.status);
    return r.json();
  }
  const map = new Map();
  for (let p=1; p<=4; p++){
    try{
      const arr = await page(p);
      for (const it of arr){
        const sym = normalizeBase(it.symbol);
        const cap = it.market_cap;
        if (!sym || !Number.isFinite(cap)) continue;
        const prev = map.get(sym);
        if (!Number.isFinite(prev) || cap > prev) map.set(sym, cap);
      }
    }catch(e){
      // 某页失败就跳过
    }
  }
  return map;
}

async function refreshMarketCap() {
  let map = new Map();
  try {
    map = await fetchPaprikaMap();
  } catch (e) {
    console.error('[MCAP] paprika failed:', e?.message || e);
  }
  // 如果主源拿到的太少，用 coingecko 补齐
  if (map.size < 50) {
    try{
      const cg = await fetchCoingeckoMap();
      cg.forEach((v,k)=>{ if (!map.has(k)) map.set(k,v); });
    }catch(e){
      console.error('[MCAP] coingecko fallback failed:', e?.message || e);
    }
  }
  setMCAP(map);
  console.log('[MCAP] symbols=', map.size);
  return map.size;
}

function start(){
  // 先跑一次
  refreshMarketCap().catch(e=> console.error('[MCAP/init]', e?.message||e));
  // 每 5 分钟跑一次
  setInterval(()=> refreshMarketCap().catch(e=>console.error('[MCAP/tick]', e?.message||e)), 300000);
}

module.exports = { start, refreshMarketCap, normalizeBase };
