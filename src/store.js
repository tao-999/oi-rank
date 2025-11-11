const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const { DATA_DIR } = require('./config');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// —— 现有 —— //
const BOOK = new Map();      // Map<symbol, row>
let   SYMBOLS = [];          // symbols list

const HIST = new Map();      // Map<symbol, samples>
const HIST_MAX = 5000;

let BOOT_READY = false;
let OI_SWEEP_RUNNING = false;
let OI_PROGRESS = { done: 0, total: 0 };

// —— 新增：市值缓存（按基础币种 symbol）—— //
let MCAP = new Map();        // Map<BASE, marketCapUSD>

function setMCAP(map){ MCAP = map instanceof Map ? map : new Map(map||[]); }
function getMCAP(){ return MCAP; }

function ndjsonPath(symbol){ return path.join(DATA_DIR, symbol + '.ndjson'); }
function now(){ return Date.now(); }

function histPush(symbol, sample){
  let arr = HIST.get(symbol);
  if (!arr) { arr = []; HIST.set(symbol, arr); }
  arr.push(sample);
  if (arr.length > HIST_MAX) arr.splice(0, arr.length - HIST_MAX);
}
function appendNDJSON(symbol, sample){
  const line = JSON.stringify(sample) + '\n';
  fs.appendFile(ndjsonPath(symbol), line, err => { if (err) console.error('[NDJSON]', err.message); });
}

async function readHistoryMerged(symbol){
  let arr = (HIST.get(symbol)||[]).slice();
  if (fs.existsSync(ndjsonPath(symbol))){
    try{
      const text = await fsp.readFile(ndjsonPath(symbol), 'utf8');
      const lines = text.trim().split('\n').filter(Boolean);
      const parsed = lines.map(l=>{ try{ return JSON.parse(l); }catch{return null;} }).filter(Boolean);
      const merged = [...parsed, ...arr].sort((a,b)=> a.t - b.t);
      const uniq=[]; for(const s of merged){ if(!uniq.length || uniq[uniq.length-1].t !== s.t) uniq.push(s); }
      arr = uniq;
    }catch{}
  }
  return arr;
}

module.exports = {
  BOOK,
  SYMBOLS: ()=>SYMBOLS, setSYMBOLS: v=> (SYMBOLS=v),
  HIST, histPush, appendNDJSON, readHistoryMerged,
  BOOT_READY: ()=>BOOT_READY, setBOOT: v=> (BOOT_READY=v),
  OI_SWEEP_RUNNING: ()=>OI_SWEEP_RUNNING, setOISweep: v=> (OI_SWEEP_RUNNING=v),
  OI_PROGRESS, ndjsonPath, now,
  // 市值
  getMCAP, setMCAP
};
