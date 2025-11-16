// src/store.js
const fs   = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');

// 保证 data 目录存在
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ========== 全局内存结构：当前快照 ==========

const BOOK = new Map();      // symbol -> { symbol, markPrice, fundingRate, openInterest, notionalUSD, updatedAt }
let   SYMBOLS = [];          // 永续合约列表

let  BOOT_READY   = false;
let  OI_PROGRESS  = { done: 0, total: 0 };

// ===== 市值 =====
let MCAP = new Map();
function setMCAP(m){ MCAP = m instanceof Map ? m : new Map(m || []); }
function getMCAP(){ return MCAP; }

// ========== 成交持久化（trade.ndjson） ==========

function tradeNdjsonPath(symbol){
  return path.join(DATA_DIR, symbol + '.trade.ndjson');
}

function appendTradeNDJSON(symbol, trade){
  const line = JSON.stringify(trade) + '\n';
  fs.appendFile(tradeNdjsonPath(symbol), line, ()=>{});
}

// ========== OI 历史：内存 + 文件 cache ==========

const OI_HIST      = new Map();   // symbol -> [{ t, oi, nu, mp }, ...]
const OI_DELTA     = new Map();   // symbol -> { symbol, dOi, dNu, from, to }
const OI_HIST_FILE = path.join(DATA_DIR, 'oi_hist.json');

// 统一规范一下传进来的数组
function normalizeSamples(arr){
  if (!Array.isArray(arr)) return [];
  return arr.map(x => ({
    t : Number(x.t),
    oi: x.oi != null ? Number(x.oi) : NaN,
    nu: x.nu != null ? Number(x.nu) : NaN,
    mp: x.mp != null ? Number(x.mp) : null
  })).filter(s => Number.isFinite(s.t));
}

// 写 OI 历史时，同时更新 OI_HIST + OI_DELTA
function setOIHist(sym, arr){
  if (!sym) return;
  const norm = normalizeSamples(arr);

  OI_HIST.set(sym, norm);

  if (norm.length >= 2){
    const first = norm[0];
    const last  = norm[norm.length - 1];

    const dOi = (Number.isFinite(last.oi) && Number.isFinite(first.oi))
      ? last.oi - first.oi
      : null;

    const dNu = (Number.isFinite(last.nu) && Number.isFinite(first.nu))
      ? last.nu - first.nu
      : null;

    OI_DELTA.set(sym, {
      symbol: sym,
      dOi,
      dNu,
      from: first.t,
      to  : last.t
    });
  }else{
    OI_DELTA.delete(sym);
  }
}

function getOIHist(sym){
  return OI_HIST.get(sym) || [];
}

function getAllOIHist(){
  return OI_HIST;
}

function getOIDelta(sym){
  return OI_DELTA.get(sym) || null;
}

function listOIDelta(){
  const rows = [];

  for (const [sym, d] of OI_DELTA.entries()){
    const book = BOOK.get(sym) || {};
    rows.push({
      symbol : sym,
      dOi    : d.dOi,
      dNu    : d.dNu,
      from   : d.from,
      to     : d.to,
      markPrice   : book.markPrice,
      fundingRate : book.fundingRate,
      openInterest: book.openInterest,
      notionalUSD : book.notionalUSD,
      updatedAt   : book.updatedAt
    });
  }

  rows.sort((a, b) => Math.abs(b.dNu || 0) - Math.abs(a.dNu || 0));

  return rows;
}

// 启动时尝试从文件恢复
(function loadOIHistFromFile(){
  try{
    if (!fs.existsSync(OI_HIST_FILE)) return;
    const raw = fs.readFileSync(OI_HIST_FILE, 'utf8');
    const obj = JSON.parse(raw);
    for (const sym of Object.keys(obj || {})){
      const arr = obj[sym];
      setOIHist(sym, arr);
    }
  }catch(e){
    // 读失败就当没有 cache
  }
})();

function saveOIHistToFile(){
  const out = {};
  for (const [sym, arr] of OI_HIST.entries()){
    out[sym] = arr;
  }
  fs.writeFile(OI_HIST_FILE, JSON.stringify(out), ()=>{});
}

// ========== now() ==========

function now(){ return Date.now(); }

// ========== 导出 ==========

module.exports = {
  // 当前快照
  BOOK,

  SYMBOLS : () => SYMBOLS,
  setSYMBOLS: v => SYMBOLS = v || [],

  BOOT_READY: () => BOOT_READY,
  setBOOT   : v => BOOT_READY = !!v,

  OI_PROGRESS,

  // 市值
  getMCAP,
  setMCAP,

  // 成交 ndjson
  appendTradeNDJSON,
  tradeNdjsonPath,

  // OI 历史
  getOIHist,
  setOIHist,
  getAllOIHist,
  saveOIHistToFile,

  // 增量
  getOIDelta,
  listOIDelta,

  // 工具
  now
};
