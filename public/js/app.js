// public/js/app.js
import { el } from './utils.js';
import { getProgress, getSnapshot, getTrends, getHistory } from './api.js';
import { parseWins, humanWin } from './trend.js';
import { state, buildThead, applyFiltersAndRender, setActiveRow } from './table.js';
import { createChart } from './chart.js';
import { createWS } from './ws.js';
import { createTradesPanel } from './trades.js';   // ✅ 接入成交面板

let timer = null, resortTimer = null, needResort = false;

const chart = createChart();
const tradesPanel = createTradesPanel();
let wsClient = null;   // 保存 createWS 返回的对象

// 给 table 模块一个打开抽屉的方法
state.openDrawer = async (symbol) => {
  setActiveRow(symbol);

  // 告诉后端：当前我要看的成交是这个 symbol
  if (wsClient) {
    wsClient.subTrades(symbol);
  }

  // 告诉成交面板当前 symbol
  if (tradesPanel) {
    tradesPanel.setSymbol(symbol);
  }

  await chart.open(symbol, (s) => getHistory(s, 20000));
};

function setStatus(text){ el('state').innerHTML = text; }

async function waitBootThenStart(){
  const overlay = el('overlay');
  const bar = el('barFill');
  const ovText = el('ovText');
  const ovPct  = el('ovPct');

  while(true){
    try{
      const j = await getProgress();
      const total = Number(j.total||0), done = Number(j.done||0);
      const ratio = Math.max(0, Math.min(1, total ? done/total : (j.bootReady ? 1 : 0)));
      if (bar)   bar.style.width = (ratio*100).toFixed(0) + '%';
      if (ovPct) ovPct.textContent = (ratio*100).toFixed(0) + '%';
      if (ovText) {
        ovText.textContent = j.bootReady ? '完成，正在载入表格…' : `抓取合约数据：${done}/${total}`;
      }
      if (j.bootReady) break;
    }catch{
      if (ovText) ovText.textContent = '等待服务就绪…';
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  if (overlay) overlay.style.display = 'none';
  await refreshAllOnce();
  connectWS();
  if (timer) clearInterval(timer);
  timer = setInterval(refreshAllOnce, 1000*1000);
}

async function refreshAllOnce(){
  setStatus('<span class="spin"></span> 加载快照…');
  const snap = await getSnapshot();
  state.masterRows = snap.rows || [];
  setStatus('完成');
  await refreshTrendsFromInput();
  buildThead(); 
  applyFiltersAndRender();
}

async function refreshTrendsFromInput(){
  const winsInput = el('wins');
  state.trendWins = parseWins(winsInput ? winsInput.value : '');
  if (!state.trendWins.length){ state.trendMap = null; return; }
  const labels = state.trendWins.map(humanWin).join(',');
  const j = await getTrends(labels);
  state.trendMap = j.data || null;
}

function connectWS(){
  wsClient = createWS(
    // init：一次性快照
    (map)=>{
      if (!Array.isArray(state.masterRows)) return;
      const by = new Map(state.masterRows.map(r=>[r.symbol,r]));
      for (const sym in map){
        const row = by.get(sym); if (!row) continue;
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
      // 局部 DOM 刷新：只更新价格/名义
      partialPriceRefresh(by);
    },
    // delta：价格/资金费率增量
    (changed)=>{
      const by = new Map(state.masterRows.map(r=>[r.symbol,r])); let touched = 0;
      for (const it of changed){
        const row = by.get(it.s); if (!row) continue;
        if (Number.isFinite(it.p)){
          row.markPrice = it.p;
          if (Number.isFinite(row.openInterest)){
            row.notionalUSD = row.openInterest * row.markPrice;
          }
          touched++;
        }
        if (it.r != null) row.fundingRate = it.r;
        row.updatedAt = it.u || row.updatedAt || row.time;
        // 推一笔到图表（只有当前打开的才推进）
        if (row.symbol === state.activeSym && Number.isFinite(row.notionalUSD)) {
          chart.pushLive(row.notionalUSD, row.updatedAt);
        }
      }
      if (touched){
        partialPriceRefresh(by); needResort = true;
        if (!resortTimer){
          resortTimer = setTimeout(()=>{
            if (needResort) applyFiltersAndRender();
            needResort = false; resortTimer = null;
          }, 3000);
        }
      }
    },
    // trades：最新成交增量（从后端 /ws -> 图表 + 成交表）
    (trades)=>{
      // ✅ chart 模块没实现 pushTrades 也不会报错
      if (chart && typeof chart.pushTrades === 'function') {
        chart.pushTrades(trades);
      }
      if (tradesPanel) {
        tradesPanel.pushTrades(trades);
      }
    }
  );
}

function partialPriceRefresh(by){
  by.forEach((row,sym)=>{
    const tr = state.domIndex.get(sym); if(!tr) return;
    // 列：0序号 1合约 2标记价 3名义 4..趋势.. 末尾 资金/市值
    const pc = tr.children[2], nc = tr.children[3];
    if (pc && Number.isFinite(row.markPrice)) {
      pc.innerHTML = '$'+Number(row.markPrice).toLocaleString(undefined,{maximumFractionDigits:6});
    }
    if (nc && Number.isFinite(row.notionalUSD)) {
      nc.innerHTML = '<b>'+((row.notionalUSD/1e6).toFixed(2)+'M')+'</b>';
    }
  });
}

// ===== 事件 =====
['minUSD','maxUSD'].forEach(id=> {
  const input = el(id);
  if (input) input.addEventListener('input', ()=> applyFiltersAndRender());
});

const winsInput = el('wins');
if (winsInput) {
  winsInput.addEventListener('change', async ()=>{
    await refreshTrendsFromInput(); 
    buildThead(); 
    applyFiltersAndRender();
  });
}

// “只看关注”
const onlyFavEl = el('onlyFav');
if (onlyFavEl) {
  onlyFavEl.addEventListener('change', ()=> applyFiltersAndRender());
}

// 合约名过滤（即时过滤）
const symFilterInput = el('symFilter');
if (symFilterInput) {
  symFilterInput.addEventListener('input', ()=> applyFiltersAndRender());
}

// 启动
window.addEventListener('DOMContentLoaded', waitBootThenStart);
