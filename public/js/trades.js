// public/js/trades.js
import { el } from './utils.js';

export function createTradesPanel() {
  const panel   = el('tradesPanel');
  const tbody   = el('tradesTbody');

  // 和你的 HTML 对齐：tradesQtyMin / tradesQtyMax
  const minEl   = el('tradesQtyMin');
  const maxEl   = el('tradesQtyMax');

  const btnReel = el('tradesRefresh'); // 现在只是“重渲染”，不发请求

  const MAX_TRADES = 20000; // ✅ 表格上限 2W 条
  let activeSym = null;
  let buf = []; // [{ s,p,q,nu,ts,m }, ...]

  function clearTable(text = '暂无成交') {
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="4">${text}</td></tr>`;
  }

  function setSymbol(sym) {
    activeSym = sym;
    buf = [];
    clearTable('等待成交…');
  }

  function render() {
    if (!tbody) return;
    if (!activeSym) {
      clearTable('未选择合约');
      return;
    }

    const minVal = Number(minEl?.value || '0') || 0;
    const maxValRaw = maxEl?.value;
    const maxVal = maxValRaw ? Number(maxValRaw) : 0;

    let list = buf;
    if (minVal > 0) {
      list = list.filter(t => Number(t.nu) >= minVal);
    }
    if (maxVal > 0) {
      list = list.filter(t => Number(t.nu) <= maxVal);
    }

    if (!list.length) {
      clearTable('暂无成交');
      return;
    }

    const rows = list
      .slice()
      .sort((a,b) => b.ts - a.ts)
      .map(t => {
        const d = new Date(t.ts);
        const hh = String(d.getHours()).padStart(2,'0');
        const mm = String(d.getMinutes()).padStart(2,'0');
        const ss = String(d.getSeconds()).padStart(2,'0');
        const timeStr = `${hh}:${mm}:${ss}`;
        const side = t.m ? '卖出' : '买入';
        const cls  = t.m ? 'sell' : 'buy';

        const nuStr = Number(t.nu).toLocaleString(undefined, {
          maximumFractionDigits: 2
        });

        return `
          <tr class="${cls}">
            <td>${timeStr}</td>
            <td>${t.p}</td>
            <td>${nuStr}</td>
            <td>${side}</td>
          </tr>
        `;
      })
      .join('');

    tbody.innerHTML = rows;
  }

  function pushTrades(rows) {
    if (!activeSym || !Array.isArray(rows) || !rows.length) return;

    let changed = false;
    for (const it of rows) {
      if (it.s !== activeSym) continue;
      const p  = Number(it.p);
      const q  = Number(it.q);
      const nu = Number(it.nu != null ? it.nu : (p * q));
      const ts = it.ts || Date.now();
      const m  = !!it.m;
      if (!Number.isFinite(p) || !Number.isFinite(q) || !Number.isFinite(nu)) continue;

      buf.push({ s: activeSym, p, q, nu, ts, m });
      changed = true;
    }

    if (changed) {
      if (buf.length > MAX_TRADES) {
        buf.splice(0, buf.length - MAX_TRADES);
      }
      render();
    }
  }

  if (minEl) {
    minEl.addEventListener('change', render);
  }
  if (maxEl) {
    maxEl.addEventListener('change', render);
  }
  if (btnReel) {
    btnReel.addEventListener('click', render);
  }

  if (!panel) {
    console.warn('[tradesPanel] #tradesPanel not found, but module loaded');
  }

  return {
    setSymbol,
    pushTrades,
  };
}
