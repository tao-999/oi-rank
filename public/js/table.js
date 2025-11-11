// public/js/table.js
import { fmt, fmtM$, el, loadFavSet, toggleFav } from './utils.js';
import { humanWin } from './trend.js';

// —— 状态（由 app.js 注入 openDrawer 等）—— //
export const state = {
  sortKey: 'notional', // notional | mcap | win:xxx | symbol
  sortDir: 'asc',
  masterRows: [],
  viewRows: [],
  trendWins: [],
  trendMap: null,
  activeSym: null,
  domIndex: new Map(),
  openDrawer: () => {},
  // ✅ 防重复绑定
  _favBound: false,
  _copyBound: false
};

export function buildThead(){
  const thead = el('thead');
  const cols = [
    { key:'rank',     label:'#',                 w:64,  align:'left' },
    { key:'symbol',   label:'合约',              w:128, align:'left', sortable:true },
    { key:'price',    label:'标记价',            w:160 },
    { key:'notional', label:'名义持仓（USD，M）', w:200, sortable:true },
    // 动态趋势列插在 notional 后
    { key:'fund',     label:'资金费率',          w:140 },
    { key:'mcap',     label:'市值（USD，B/M）',  w:200, sortable:true }
  ];
  const trendCols = (state.trendWins||[]).map(ms=>({
    key:`win:${ms}`, label:`Δ${humanWin(ms)}（M / %）`, w:180, sortable:true
  }));
  const all = [...cols.slice(0,4), ...trendCols, ...cols.slice(4)];

  let html = '<tr>';
  all.forEach(c=>{
    const cls = c.sortable ? ' class="sortable"' : '';
    const arrow = (c.sortable && state.sortKey===c.key) ? `<span class="arrow">${state.sortDir==='asc'?'↑':'↓'}</span>` : '';
    html += `<th${cls} data-key="${c.key}" style="text-align:${c.align||'right'}">${c.label}${arrow}</th>`;
  });
  html += '</tr>';
  thead.innerHTML = html;

  thead.querySelectorAll('.sortable').forEach(th=>{
    th.addEventListener('click', ()=>{
      const k = th.getAttribute('data-key');
      if (state.sortKey===k){
        state.sortDir = (state.sortDir==='asc')?'desc':'asc';
      }else{
        state.sortKey = k;
        if (k==='notional') state.sortDir='asc';
        else if (k==='mcap') state.sortDir='desc';
        else if (k.startsWith('win:')) state.sortDir='desc';
        else if (k==='symbol') state.sortDir='asc';
        else state.sortDir='asc';
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
  const minStr = el('minUSD').value;
  const maxStr = el('maxUSD').value;
  const onlyFav = !!(el('onlyFav') && el('onlyFav').checked);
  const favSet = loadFavSet();
  const tokens = parseSymFilter();
  const noRange = (minStr === '' && maxStr === '');
  const minUSD = noRange ? -Infinity : Number(minStr);
  const maxUSD = noRange ?  Infinity : Number(maxStr);

  // 基础过滤：关注/名义区间/合约名包含
  const base = (state.masterRows||[]).filter(r=>{
    if (!r || !r.symbol) return false;

    if (onlyFav && !favSet.has(String(r.symbol).toUpperCase())) return false;

    if (!noRange){
      const v = Number(r.notionalUSD);
      if (!Number.isFinite(v) || v < minUSD || v > maxUSD) return false;
    }

    if (tokens.length){
      const sym = String(r.symbol).toUpperCase();
      let hit = false;
      for (const tk of tokens){ if (sym.includes(tk)) { hit = true; break; } }
      if (!hit) return false;
    }

    return true;
  });

  // 排序
  const rows = base.slice();
  rows.sort((a,b)=>{
    const dir = state.sortDir==='asc' ? 1 : -1;

    if (state.sortKey==='symbol'){
      const sa = String(a.symbol||'');
      const sb = String(b.symbol||'');
      return dir * sa.localeCompare(sb, 'en', { sensitivity:'base' });
    }

    if (state.sortKey==='notional'){
      const va = Number.isFinite(a.notionalUSD)?a.notionalUSD:(state.sortDir==='asc'?+Infinity:-Infinity);
      const vb = Number.isFinite(b.notionalUSD)?b.notionalUSD:(state.sortDir==='asc'?+Infinity:-Infinity);
      return state.sortDir==='asc' ? (va-vb) : (vb-va);
    }

    if (state.sortKey==='mcap'){
      const va = Number.isFinite(a.marketCapUSD)?a.marketCapUSD:(state.sortDir==='asc'?+Infinity:-Infinity);
      const vb = Number.isFinite(b.marketCapUSD)?b.marketCapUSD:(state.sortDir==='asc'?+Infinity:-Infinity);
      return state.sortDir==='asc' ? (va-vb) : (vb-va);
    }

    if (state.sortKey.startsWith('win:') && state.trendMap){
      const key = Number(state.sortKey.split(':')[1]);
      const ta = state.trendMap[a.symbol]?.wins?.[key]?.delta ?? (state.sortDir==='desc'?-Infinity:+Infinity);
      const tb = state.trendMap[b.symbol]?.wins?.[key]?.delta ?? (state.sortDir==='desc'?-Infinity:+Infinity);
      return state.sortDir==='desc' ? (tb-ta) : (ta-tb);
    }
    return 0;
  });

  state.viewRows = rows;
  render();

  const tokText = tokens.length ? ` · 过滤：${tokens.join(' | ')}` : '';
  el('meta').textContent =
    `合约数：${state.viewRows.length} / ${state.masterRows.length} · 排序：${state.sortKey} ${state.sortDir} · 趋势列：${(state.trendWins||[]).map(humanWin).join(', ')||'无'}${onlyFav?' · 仅显示关注':''}${tokText}`;
}

export function render(){
  buildThead();

  // 重置 tbody 内容（不移除节点本身，保留一次性绑定的委托）
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

    let html = `
      <td class="num" style="text-align:left">${i+1}</td>
      <td style="text-align:left">
        <span class="sym-cell">
          ${star}
          <span class="badge copy" data-sym="${r.symbol}" title="点击复制">${r.symbol}</span>
        </span>
      </td>
      <td class="num">${Number.isFinite(r.markPrice)? '$'+fmt(r.markPrice): '-'}</td>
      <td class="num"><b>${fmtM$(r.notionalUSD)}</b></td>
    `;

    if (state.trendWins && state.trendMap){
      const trow = state.trendMap[r.symbol];
      for (const ms of state.trendWins){
        const w = trow?.wins?.[ms] || null;
        if (!w || !Number.isFinite(w.delta) || !Number.isFinite(w.pct)){
          html += `<td class="num muted">—</td>`;
        }else{
          const cls = w.delta>=0 ? 'delta-pos' : 'delta-neg';
          html += `<td class="num ${cls}">${(w.delta/1e6).toFixed(2)}M (${(w.pct*100).toFixed(2)}%)</td>`;
        }
      }
    }

    html += `
      <td class="num">${r.fundingRate==null?'-': (r.fundingRate>=0?'+':'')+Number(r.fundingRate).toLocaleString(undefined,{maximumFractionDigits:4})+'%'}</td>
      <td class="num">${renderMcapCell(r.marketCapUSD)}</td>
    `;
    tr.innerHTML = html;
    tbody.appendChild(tr);
    state.domIndex.set(r.symbol, tr);

    // 行点击：打开抽屉（避免与星标/复制点击冲突）
    tr.addEventListener('click', (ev)=>{
      if (ev.target.closest('.fav-btn') || ev.target.closest('.badge.copy')) return;
      state.openDrawer(r.symbol);
    });
  }

  // ✅ 复制委托：只绑定一次在 table 上
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

  // ✅ 星标委托：只绑定一次在 tbody 上
  if (!state._favBound) {
    el('tbody').addEventListener('click', (e)=>{
      const btn = e.target.closest('.fav-btn'); if(!btn) return;
      e.stopPropagation();
      const sym = btn.getAttribute('data-sym');
      const on = toggleFav(sym);
      btn.classList.toggle('active', on);
      btn.title = on ? '取消关注' : '关注';
      if (el('onlyFav')?.checked) applyFiltersAndRender();
    });
    state._favBound = true;
  }
}

export function setActiveRow(sym){
  state.activeSym=sym;
  document.querySelectorAll('#tbody tr.row-active').forEach(tr=>tr.classList.remove('row-active'));
  const tr=state.domIndex.get(sym); if(tr) tr.classList.add('row-active');
}
