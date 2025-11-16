// public/js/table.js
import { fmt, fmtM$, el, loadFavSet, toggleFav } from './utils.js';
import { humanWin } from './trend.js';

// —— 状态（由 app.js 注入 openDrawer / trendWins / trendMap）—— //
export const state = {
  sortKey   : 'notional', // notional | mcap | win:xxx | symbol
  sortDir   : 'asc',
  masterRows: [],
  viewRows  : [],
  trendWins : [],         // [ms, ms, ...]
  trendMap  : {},         // { [symbol]: { [ms]: { pct } } }
  activeSym : null,
  domIndex  : new Map(),
  openDrawer: () => {},
  _favBound : false,
  _copyBound: false
};

export function buildThead(){
  const thead = el('thead');

  // ✅ 顺序：# / 合约 / 名义持仓 / Δ列… / 资金费率 / 标记价 / 市值
  const baseCols = [
    { key:'rank',     label:'#',                         align:'left', w:50 },
    { key:'symbol',   label:'合约',                      align:'left', sortable:true, w:140 },
    { key:'notional', label:'名义持仓（USD，M）',         sortable:true, w:190 },
    { key:'fund',     label:'资金费率',                  w:120 },
    { key:'price',    label:'标记价',                    w:150 },
    { key:'mcap',     label:'市值（USD，B/M）',          sortable:true, w:180 }
  ];

  // 中间插入：根据 trendWins 动态生成 “Δ持仓 xx（%）”
  const trendCols = (state.trendWins || []).map(ms => ({
    key     : `win:${ms}`,
    label   : `Δ持仓 ${humanWin(ms)}（%）`,
    sortable: true,
    w       : 150
  }));

  const cols = [
    ...baseCols.slice(0, 3),   // #, 合约, 名义
    ...trendCols,              // Δ列
    ...baseCols.slice(3)       // 资金费率, 标记价, 市值
  ];

  let html = '<tr>';
  cols.forEach(c => {
    const sortable = !!c.sortable;
    const cls   = sortable ? ' class="sortable"' : '';
    const arrow = (sortable && state.sortKey === c.key)
      ? `<span class="arrow">${state.sortDir === 'asc' ? '↑' : '↓'}</span>` : '';
    const wStyle = c.w ? `;width:${c.w}px;min-width:${c.w}px` : '';
    html += `<th${cls} data-key="${c.key}" style="text-align:${c.align||'right'}${wStyle}">${c.label}${arrow}</th>`;
  });
  html += '</tr>';
  thead.innerHTML = html;

  thead.querySelectorAll('.sortable').forEach(th => {
    th.addEventListener('click', ()=>{
      const k = th.getAttribute('data-key');
      if (state.sortKey === k){
        state.sortDir = (state.sortDir === 'asc') ? 'desc' : 'asc';
      }else{
        state.sortKey = k;
        if (k === 'notional') state.sortDir = 'asc';
        else if (k === 'mcap') state.sortDir = 'desc';
        else if (k === 'symbol') state.sortDir = 'asc';
        else if (k.startsWith('win:')) state.sortDir = 'desc'; // 百分比默认从大到小
        else state.sortDir = 'asc';
      }
      buildThead();
      applyFiltersAndRender();
    });
  });
}

function renderMcapCell(v){
  if (!Number.isFinite(v)) return '—';
  if (v >= 1e9)  return '$'+(v/1e9).toFixed(2)+'B';
  if (v >= 1e6)  return '$'+(v/1e6).toFixed(2)+'M';
  return '$'+v.toFixed(0);
}

// —— 合约名过滤：解析 #symFilter，返回大写关键字数组 —— //
function parseSymFilter(){
  const raw = (el('symFilter')?.value || '').trim();
  if (!raw) return [];
  return raw.split(/[,，\s]+/).map(s=>s.trim().toUpperCase()).filter(Boolean);
}

export function applyFiltersAndRender(){
  const minStrEl = el('minUSD');
  const maxStrEl = el('maxUSD');

  const minStr  = minStrEl ? minStrEl.value : '';
  const maxStr  = maxStrEl ? maxStrEl.value : '';
  const onlyFav = !!(el('onlyFav') && el('onlyFav').checked);
  const favSet  = loadFavSet();
  const tokens  = parseSymFilter();

  // ✅ 默认都是“不限”
  let minUSD = -Infinity;
  let maxUSD =  Infinity;

  if (minStr !== ''){
    const v = Number(minStr);
    if (Number.isFinite(v)) minUSD = v;
  }
  if (maxStr !== ''){
    const v = Number(maxStr);
    if (Number.isFinite(v)) maxUSD = v;
  }

  const base = (state.masterRows || []).filter(r=>{
    if (!r || !r.symbol) return false;

    if (onlyFav && !favSet.has(String(r.symbol).toUpperCase())) return false;

    // 名义区间过滤
    const v = Number(r.notionalUSD);
    if (!Number.isFinite(v) || v < minUSD || v > maxUSD) return false;

    // 合约名过滤
    if (tokens.length){
      const sym = String(r.symbol).toUpperCase();
      let hit = false;
      for (const tk of tokens){
        if (sym.includes(tk)) { hit = true; break; }
      }
      if (!hit) return false;
    }

    return true;
  });

  const rows = base.slice();
  rows.sort((a,b)=>{
    const dir = state.sortDir === 'asc' ? 1 : -1;

    if (state.sortKey === 'symbol'){
      const sa = String(a.symbol||'');
      const sb = String(b.symbol||'');
      return dir * sa.localeCompare(sb, 'en', { sensitivity:'base' });
    }

    if (state.sortKey === 'notional'){
      const va = Number.isFinite(a.notionalUSD)?a.notionalUSD:(state.sortDir==='asc'?+Infinity:-Infinity);
      const vb = Number.isFinite(b.notionalUSD)?b.notionalUSD:(state.sortDir==='asc'?+Infinity:-Infinity);
      return state.sortDir==='asc' ? (va-vb) : (vb-va);
    }

    if (state.sortKey === 'mcap'){
      const va = Number.isFinite(a.marketCapUSD)?a.marketCapUSD:(state.sortDir==='asc'?+Infinity:-Infinity);
      const vb = Number.isFinite(b.marketCapUSD)?b.marketCapUSD:(state.sortDir==='asc'?+Infinity:-Infinity);
      return state.sortDir==='asc' ? (va-vb) : (vb-va);
    }

    if (state.sortKey.startsWith('win:')){
      const keyMs = Number(state.sortKey.split(':')[1]);
      const ta    = state.trendMap[a.symbol]?.[keyMs]?.pct;
      const tb    = state.trendMap[b.symbol]?.[keyMs]?.pct;

      const va = Number.isFinite(ta) ? ta : (state.sortDir==='desc'?-Infinity:+Infinity);
      const vb = Number.isFinite(tb) ? tb : (state.sortDir==='desc'?-Infinity:+Infinity);

      return state.sortDir==='asc' ? (va-vb) : (vb-va);
    }

    return 0;
  });

  state.viewRows = rows;
  render();

  const tokText = tokens.length ? ` · 过滤：${tokens.join(' | ')}` : '';
  const total   = state.masterRows ? state.masterRows.length : 0;
  el('meta').textContent =
    `合约数：${state.viewRows.length} / ${total}`
    + ` · 排序：${state.sortKey} ${state.sortDir}`
    + ` · 趋势列：${(state.trendWins||[]).map(humanWin).join(', ')||'无'}`
    + (onlyFav?' · 仅显示关注':'')
    + tokText;
}

export function render(){
  buildThead();

  const tbody = el('tbody'); tbody.innerHTML='';
  state.domIndex = new Map();
  const favSet = loadFavSet();

  for (let i=0;i<state.viewRows.length;i++){
    const r = state.viewRows[i];
    const tr = document.createElement('tr');
    if (r.symbol===state.activeSym) tr.classList.add('row-active');

    const favActive = favSet.has(String(r.symbol).toUpperCase());
    const star = `
      <button class="fav-btn ${favActive?'active':''}" data-sym="${r.symbol}" title="${favActive?'取消关注':'关注'}" aria-label="favorite">
        <svg viewBox="0 0 24 24" width="16" height="16" class="star">
          <path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/>
        </svg>
      </button>`;

    // ✅ 行内顺序：# / 合约 / 名义 / Δ列… / 资金费率 / 标记价 / 市值
    let html = `
      <td class="num" style="text-align:left">${i+1}</td>
      <td style="text-align:left">
        <span class="sym-cell">
          ${star}
          <span class="badge copy" data-sym="${r.symbol}" title="点击复制">${r.symbol}</span>
        </span>
      </td>
      <td class="num"><b>${fmtM$(r.notionalUSD)}</b></td>
    `;

    // —— 动态窗口：每列只显示百分比 —— //
    const trendRow = state.trendMap[r.symbol] || {};
    for (const ms of state.trendWins || []){
      const info = trendRow[ms] || null;
      const pct  = info && Number.isFinite(info.pct) ? info.pct * 100 : NaN;
      if (!Number.isFinite(pct)){
        html += `<td class="num muted">—</td>`;
      }else{
        const cls = pct >= 0 ? 'delta-pos' : 'delta-neg';
        html += `<td class="num ${cls}">${pct.toFixed(2)}%</td>`;
      }
    }

    html += `
      <td class="num">${r.fundingRate==null
        ?'-'
        : (r.fundingRate>=0?'+':'')+Number(r.fundingRate).toLocaleString(undefined,{maximumFractionDigits:4})+'%'}</td>
      <td class="num">${Number.isFinite(r.markPrice)? '$'+fmt(r.markPrice): '-'}</td>
      <td class="num">${renderMcapCell(r.marketCapUSD)}</td>
    `;
    tr.innerHTML = html;
    tbody.appendChild(tr);
    state.domIndex.set(r.symbol, tr);

    // —— 行点击：打开抽屉；如果当前行对应的弹窗已经打开，就不再重复执行 —— //
    tr.addEventListener('click', (ev)=>{
      if (ev.target.closest('.fav-btn') || ev.target.closest('.badge.copy')) return;

      const drawer = el('drawer');
      if (state.activeSym === r.symbol && drawer?.classList.contains('open')){
        // 当前这行已经是激活合约，且抽屉是打开状态，不需要重复 openDrawer
        return;
      }

      state.openDrawer(r.symbol);
    });
  }

  // 复制委托：只绑定一次
  if (!state._copyBound) {
    document.querySelector('table').addEventListener('click', async (e)=>{
      const elBadge = e.target.closest('.badge.copy'); if(!elBadge) return;
      e.stopPropagation();
      const sym = elBadge.getAttribute('data-sym');
      try{
        if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(sym);
        else {
          const ta=document.createElement('textarea'); ta.value=sym;
          document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
        }
        const tip = document.querySelector('.copy-tip') || (()=>{ const d=document.createElement('div'); d.className='copy-tip'; d.textContent='已复制'; document.body.appendChild(d); return d; })();
        tip.style.left=(e.clientX||0)+'px'; tip.style.top=(e.clientY||0)+'px';
        tip.classList.add('show'); setTimeout(()=>tip.classList.remove('show'),700);
      }catch{}
    });
    state._copyBound = true;
  }

  // 星标委托：只绑定一次
  if (!state._favBound) {
    el('tbody').addEventListener('click', (e)=>{
      const btn = e.target.closest('.fav-btn'); if(!btn) return;
      e.stopPropagation();
      const sym = btn.getAttribute('data-sym');
      const on  = toggleFav(sym);
      btn.classList.toggle('active', on);
      btn.title = on ? '取消关注' : '关注';
      if (el('onlyFav')?.checked) applyFiltersAndRender();
    });
    state._favBound = true;
  }
}

export function setActiveRow(sym){
  state.activeSym = sym;
  document.querySelectorAll('#tbody tr.row-active').forEach(tr=>tr.classList.remove('row-active'));
  const tr = state.domIndex.get(sym); if (tr) tr.classList.add('row-active');
}
