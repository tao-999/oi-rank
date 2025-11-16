// public/js/app.js
import { el } from './utils.js';
import { getProgress, getSnapshot } from './api.js';
import { state, buildThead, applyFiltersAndRender, setActiveRow } from './table.js';
import { createChart } from './chart.js';
import { createWS } from './ws.js';
import { createTradesPanel } from './trades.js';

let timer       = null;
let resortTimer = null;
let needResort  = false;

const chart        = createChart();
const tradesPanel  = createTradesPanel();
let   wsClient     = null;

// ===== 打开抽屉查看单个合约 =====
state.openDrawer = async (symbol)=>{
  setActiveRow(symbol);

  if (wsClient){
    wsClient.subTrades(symbol);
  }
  if (tradesPanel){
    tradesPanel.setSymbol(symbol);
  }

  await chart.open(symbol);
};

function setStatus(text){
  const s = el('state');
  if (s) s.innerHTML = text;
}

// ===== 启动：等后端完成 bootstrap =====
async function waitBootThenStart(){
  const overlay = el('overlay');
  const bar     = el('barFill');
  const ovText  = el('ovText');
  const ovPct   = el('ovPct');

  while (true){
    try{
      const j     = await getProgress();
      const total = Number(j.total || 0);
      const done  = Number(j.done  || 0);
      const ratio = total ? (done / total) : (j.bootReady ? 1 : 0);

      if (bar)   bar.style.width   = (ratio * 100).toFixed(0) + '%';
      if (ovPct) ovPct.textContent = (ratio * 100).toFixed(0) + '%';

      if (ovText){
        ovText.textContent = j.bootReady
          ? '完成，正在载入表格…'
          : `抓取合约数据：${done}/${total}`;
      }

      if (j.bootReady) break;
    }catch(e){
      if (ovText) ovText.textContent = '等待服务就绪…';
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  if (overlay) overlay.style.display = 'none';

  await refreshAllOnce();
  connectWS();

  if (timer) clearInterval(timer);
  timer = setInterval(refreshAllOnce, 1000 * 1000);
}

// ===== 快照刷新（含趋势窗口的增量） =====
async function refreshAllOnce(){
  setStatus('<span class="spin"></span> 加载快照…');

  const winsInput = el('wins');
  const winsStr   = winsInput ? winsInput.value.trim() : '';

  const snap = await getSnapshot(winsStr);

  state.masterRows = snap.rows || [];
  state.trendWins  = Array.isArray(snap.winsMs) ? snap.winsMs : [];
  state.trendMap   = {};

  for (const row of state.masterRows){
    if (!row || !row.symbol) continue;
    state.trendMap[row.symbol] = row.trend || {};
  }

  setStatus('完成');

  buildThead();
  applyFiltersAndRender();
}

// ===== WebSocket：实时价格 / 资金费率 / 名义 =====
function connectWS(){
  wsClient = createWS(
    // init 快照修正
    (map)=>{
      if (!Array.isArray(state.masterRows)) return;
      const by = new Map(state.masterRows.map(r => [r.symbol, r]));

      for (const sym in map){
        const row = by.get(sym);
        if (!row) continue;

        const p = map[sym];
        if (Number.isFinite(p.p)){
          row.markPrice = p.p;
          if (Number.isFinite(row.openInterest)){
            row.notionalUSD = row.openInterest * row.markPrice;
          }
        }
        if (p.r != null) row.fundingRate = p.r;
        row.updatedAt = p.u || row.updatedAt || row.time;
      }

      partialPriceRefresh(by);
    },

    // delta 增量
    (changed)=>{
      const by = new Map(state.masterRows.map(r => [r.symbol, r]));
      let touched = 0;

      for (const it of changed){
        const row = by.get(it.s);
        if (!row) continue;

        if (Number.isFinite(it.p)){
          row.markPrice = it.p;
          if (Number.isFinite(row.openInterest)){
            row.notionalUSD = row.openInterest * row.markPrice;
          }
          touched++;
        }
        if (it.r != null) row.fundingRate = it.r;
        row.updatedAt = it.u || row.updatedAt || row.time;

        // ✅ 当前激活合约：把名义 + 价格 + 时间喂给 chart（用于图 + 预测）
        if (
          row.symbol === state.activeSym &&
          Number.isFinite(row.notionalUSD) &&
          Number.isFinite(row.markPrice)
        ){
          chart.pushLive(row.notionalUSD, row.markPrice, row.updatedAt);
        }
      }

      if (touched){
        partialPriceRefresh(by);
        needResort = true;
        if (!resortTimer){
          resortTimer = setTimeout(()=>{
            if (needResort) applyFiltersAndRender();
            needResort  = false;
            resortTimer = null;
          }, 3000);
        }
      }
    },

    // trades
    (trades)=>{
      if (chart && typeof chart.pushTrades === 'function'){
        chart.pushTrades(trades);
      }
      if (tradesPanel){
        tradesPanel.pushTrades(trades);
      }
    }
  );
}

function partialPriceRefresh(by){
  by.forEach((row, sym)=>{
    const tr = state.domIndex.get(sym);
    if (!tr) return;

    const nTrend = (state.trendWins || []).length;

    // 当前行的列顺序：
    // 0:#  1:合约  2:名义  3..(2+nTrend): Δ列
    // 3+nTrend: 资金费率  4+nTrend: 标记价  5+nTrend: 市值
    const notionalIdx = 2;
    const priceIdx    = 4 + nTrend;

    const nc = tr.children[notionalIdx];
    const pc = tr.children[priceIdx];

    if (pc && Number.isFinite(row.markPrice)){
      pc.innerHTML = '$' + Number(row.markPrice)
        .toLocaleString(undefined, { maximumFractionDigits: 6 });
    }
    if (nc && Number.isFinite(row.notionalUSD)){
      nc.innerHTML = '<b>' + (row.notionalUSD / 1e6).toFixed(2) + 'M</b>';
    }
  });
}

// ===== 过滤 / 事件 =====
['minUSD','maxUSD'].forEach(id=>{
  const input = el(id);
  if (input) input.addEventListener('input', ()=> applyFiltersAndRender());
});

// “只看关注”
const onlyFavEl = el('onlyFav');
if (onlyFavEl){
  onlyFavEl.addEventListener('change', ()=> applyFiltersAndRender());
}

// 合约名过滤
const symFilterInput = el('symFilter');
if (symFilterInput){
  symFilterInput.addEventListener('input', ()=> applyFiltersAndRender());
}

// 趋势窗口变化：重新拉一次快照（带新的 wins）
const winsInput = el('wins');
if (winsInput){
  winsInput.addEventListener('change', ()=> refreshAllOnce());
}

window.addEventListener('DOMContentLoaded', waitBootThenStart);
