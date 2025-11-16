// public/js/chart.js
import { el } from './utils.js';
import { getHistory } from './api.js';
import { createPredictor } from './predictor.js';

/* ========= 主图组件 ========= */
export function createChart(){
  const drawer      = el('drawer');
  const drawerTitle = el('drawerTitle');
  const btnClose    = el('btnClose');
  const aggSel      = el('aggSel');
  const canvas      = el('chart');
  const ctx         = canvas.getContext('2d');
  const chartMeta   = el('chartMeta');
  const signalBox   = el('signalBox');

  let curSymbol = null;
  let samples   = [];     // { t, nu, mp }
  let liveTail  = [];
  let autoTimer = null;

  // 画布内边距（底部加大，给 X 轴文字和 tooltip）
  const PADL=60, PADR=60, PADT=20, PADB=50;

  // 交互状态
  let lastBuckets = [];   // 最近一次聚合后的数据
  let hoverIndex  = null; // 当前选中的时间桶 index

  // 预测器：内部自己用 OI 的 0.1% 来判定大单
  const predictor = createPredictor({
    windowMs: 30_000
  });

  /* ============ 粒度 ============ */
  const PRESET_MS = {
    '5m' : 5 * 60 * 1000,
    '15m': 15 * 60 * 1000,
    '30m': 30 * 60 * 1000,
    '1h' : 60 * 60 * 1000,
    '2h' : 2  * 60 * 60 * 1000,
    '4h' : 4  * 60 * 60 * 1000,
    '6h' : 6  * 60 * 60 * 1000,
    '12h': 12 * 60 * 60 * 1000,
    '1d' : 24 * 60 * 60 * 1000
  };

  const PERIOD_FOR_API = {
    '5m' : '5m',
    '15m': '15m',
    '30m': '30m',
    '1h' : '1h',
    '2h' : '2h',
    '4h' : '4h',
    '6h' : '6h',
    '12h': '12h',
    '1d' : '1d'
  };

  /* ============ 时间聚合 ============ */
  function bucketize(arr, preset){
    const step = PRESET_MS[preset];
    const map  = new Map();

    for (const s of arr){
      if (!s) continue;
      const t = Number(s.t);
      if (!Number.isFinite(t)) continue;

      const b = Math.floor(t / step) * step;
      map.set(b, s);
    }

    return [...map.keys()].sort((a,b)=>a-b).map(k=>{
      const s = map.get(k);
      return {
        t  : k,
        nu : Number(s.nu)||0,
        mp : Number(s.mp) || null
      };
    });
  }

  /* ============ 格式化 ============ */
  function formatTimeLabel(ms, span){
    const d = new Date(ms);
    const h = String(d.getHours()).padStart(2,'0');
    const m = String(d.getMinutes()).padStart(2,'0');

    if (span > 2*86400000){
      const mon = String(d.getMonth()+1).padStart(2,'0');
      const day = String(d.getDate()).padStart(2,'0');
      return `${mon}-${day}\n${h}:${m}`;
    }
    return `${h}:${m}`;
  }

  // tooltip 用：YYYY-MM-DD HH:mm
  function formatTooltipTime(ms){
    const d = new Date(ms);
    const Y = d.getFullYear();
    const M = String(d.getMonth()+1).padStart(2,'0');
    const D = String(d.getDate()).padStart(2,'0');
    const h = String(d.getHours()).padStart(2,'0');
    const m = String(d.getMinutes()).padStart(2,'0');
    return `${Y}-${M}-${D} ${h}:${m}`;
  }

  function formatUSD(v){
    const abs = Math.abs(v);
    if (abs >= 1e9) return (v/1e9).toFixed(2)+'B';
    if (abs >= 1e6) return (v/1e6).toFixed(2)+'M';
    if (abs >= 1e3) return (v/1e3).toFixed(1)+'K';
    return v.toFixed(2);
  }

  /* ============ 预测 UI ============ */
  function renderSignal(){
    if (!signalBox) return;

    const sig = predictor.getSignal();
    const pc  = (sig.priceChangePct*100).toFixed(2);
    const oc  = (sig.oiChangePct*100).toFixed(2);

    let badgeCls = 'sig-weak';
    if (sig.type === 'strong_long' || sig.type === 'liq_pump') {
      badgeCls = 'sig-up';
    } else if (sig.type === 'accumulation' || sig.type === 'wash_pump') {
      badgeCls = 'sig-up sig-weak';
    } else if (sig.type === 'strong_short' || sig.type === 'liq_dump') {
      badgeCls = 'sig-down';
    } else if (sig.type === 'distribution' || sig.type === 'wash_dump') {
      badgeCls = 'sig-down sig-weak';
    }

    if (sig.type === 'none' || sig.score <= 0){
      signalBox.innerHTML = `
        <span class="small muted">
          预测：无明显拉盘 / 砸盘结构
          · Δ价 ${pc}%
          · Δ名义 ${oc}%
        </span>
      `;
      return;
    }

    signalBox.innerHTML = `
      <div class="small" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:4px">
        <span class="sig-badge ${badgeCls}">
          ${sig.label} · 评分 ${sig.score.toFixed(0)}
        </span>
        <span class="sig-badge sig-weak">
          Δ价 ${pc}%
        </span>
        <span class="sig-badge sig-weak">
          Δ名义 ${oc}%
        </span>
        <span class="sig-badge sig-weak">
          大额买 ${sig.bigBuyCount} · 卖 ${sig.bigSellCount}
        </span>
      </div>
      <div class="small muted">
        ${sig.reasons.map(r=>`<div>${r}</div>`).join('')}
      </div>
    `;
  }

  /* ============ 绘制图表 ============ */
  function drawChart(){
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0,0,W,H);

    const merged = samples.concat(liveTail)
      .map(s => ({ ...s, t:Number(s.t) }))
      .filter(s => Number.isFinite(s.t));

    if (!merged.length){
      chartMeta.textContent = '无数据';
      lastBuckets = [];
      hoverIndex  = null;
      if (signalBox) signalBox.innerHTML = '';
      return;
    }

    const preset = aggSel.value || '5m';
    const data   = bucketize(merged, preset);

    if (data.length < 2){
      chartMeta.textContent = '数据不足';
      lastBuckets = data;
      hoverIndex  = null;
      return;
    }

    lastBuckets = data;
    if (hoverIndex != null && (hoverIndex < 0 || hoverIndex >= data.length)){
      hoverIndex = null;
    }

    const xs    = data.map(d=>d.t);
    const nuArr = data.map(d=>d.nu);
    const mpArr = data.map(d=>d.mp).filter(v=>Number.isFinite(v));

    // 持仓量范围（右轴）
    const nuMin = Math.min(...nuArr);
    const nuMax = Math.max(...nuArr);

    // 价格范围（左轴，可能没有）
    const hasPrice = mpArr.length >= 2;
    const mpMin    = hasPrice ? Math.min(...mpArr) : 0;
    const mpMax    = hasPrice ? Math.max(...mpArr) : 1;

    const xmin = Math.min(...xs);
    const xmax = Math.max(...xs);
    const span = xmax - xmin || 1;

    const px = (t)=> PADL + (t-xmin)/span * (W-PADL-PADR);

    // Y 轴比例
    const nuSpan = (nuMax - nuMin) || 1;
    const pyNU   = (v)=> H-PADB - (v - nuMin)/nuSpan * (H-PADT-PADB);

    const mpSpan = (mpMax - mpMin) || 1;
    const pyMP   = (v)=> H-PADB - (v - mpMin)/mpSpan * (H-PADT-PADB);

    ctx.font = '12px system-ui';
    ctx.lineWidth = 1;

    /* ========= 左轴（价格） ========= */
    if (hasPrice){
      ctx.strokeStyle = 'rgba(255,255,255,0.1)';
      ctx.fillStyle   = '#4da3ff';     // 左轴文字：蓝色

      for(let i=0;i<=4;i++){
        const v = mpMin + (mpMax-mpMin)*i/4;
        const y = pyMP(v);

        ctx.beginPath();
        ctx.moveTo(PADL, y);
        ctx.lineTo(W-PADR, y);
        ctx.stroke();

        ctx.textAlign   = 'right';
        ctx.textBaseline= 'middle';
        ctx.fillText(v.toFixed(6), PADL-6, y);
      }
    }

    /* ========= 右轴（持仓量） ========= */
    ctx.fillStyle = '#9aa4b2';        // 右轴文字：灰色
    for(let i=0;i<=4;i++){
      const v = nuMin + (nuMax-nuMin)*i/4;
      const y = pyNU(v);

      ctx.textAlign   = 'left';
      ctx.textBaseline= 'middle';
      ctx.fillText(formatUSD(v), W-PADR+5, y);
    }

    /* ========= X 轴网格 ========= */
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    for(let i=0;i<=4;i++){
      const tx = xmin + span*i/4;
      const xx = px(tx);
      ctx.beginPath();
      ctx.moveTo(xx, PADT);
      ctx.lineTo(xx, H-PADB);
      ctx.stroke();

      ctx.fillStyle = '#9aa4b2';
      const label = formatTimeLabel(tx, span);
      label.split('\n').forEach((ln,idx)=>{
        ctx.textAlign   = 'center';
        ctx.textBaseline= 'top';
        ctx.fillText(ln, xx, H-PADB+6+idx*12);
      });
    }

    /* ========= 持仓量折线（右轴） ========= */
    ctx.strokeStyle = '#9aa4b2';      // 名义线颜色 = 右轴颜色
    ctx.lineWidth   = 1.3;
    ctx.beginPath();
    data.forEach((d,i)=>{
      const x = px(d.t), y = pyNU(d.nu);
      if (i===0) ctx.moveTo(x,y);
      else       ctx.lineTo(x,y);
    });
    ctx.stroke();

    /* ========= 价格折线（左轴） ========= */
    if (hasPrice){
      ctx.strokeStyle = '#4da3ff';    // 价格线颜色 = 左轴颜色
      ctx.lineWidth   = 1.3;
      ctx.beginPath();

      data.forEach((d,i)=>{
        if (!Number.isFinite(d.mp)) return;
        const x=px(d.t), y=pyMP(d.mp);
        if (i===0) ctx.moveTo(x,y);
        else       ctx.lineTo(x,y);
      });

      ctx.stroke();
    }

    /* ========= 选中点：灰色十字虚线 + 双水平线 + 气泡 ========= */
    if (hoverIndex != null && data[hoverIndex]){
      const d = data[hoverIndex];

      const xLine = px(d.t);              // 垂直线：当前时间桶
      const yNu   = pyNU(d.nu);           // 水平线 1：名义持仓
      const hasNu = Number.isFinite(d.nu);

      const hasMpThis = hasPrice && Number.isFinite(d.mp);
      const yMp       = hasMpThis ? pyMP(d.mp) : null; // 水平线 2：价格

      // 计算气泡的锚点 Y：两条线中间 / 单线位置
      let anchorY;
      if (hasNu && hasMpThis){
        anchorY = (yNu + yMp) / 2;
      }else if (hasNu){
        anchorY = yNu;
      }else if (hasMpThis){
        anchorY = yMp;
      }else{
        anchorY = (PADT + (H-PADB)) / 2;
      }

      // 十字虚线
      ctx.save();
      ctx.setLineDash([4,4]);
      ctx.strokeStyle = 'rgba(148,163,184,0.8)';
      ctx.lineWidth   = 1;

      // 水平线：名义
      if (hasNu){
        ctx.beginPath();
        ctx.moveTo(PADL, yNu);
        ctx.lineTo(W-PADR, yNu);
        ctx.stroke();
      }

      // 水平线：价格
      if (hasMpThis){
        ctx.beginPath();
        ctx.moveTo(PADL, yMp);
        ctx.lineTo(W-PADR, yMp);
        ctx.stroke();
      }

      // 垂直线
      ctx.beginPath();
      ctx.moveTo(xLine, PADT);
      ctx.lineTo(xLine, H-PADB);
      ctx.stroke();

      ctx.restore();

      // —— 气泡文本 —— //
      const timeText  = `时间 ${formatTooltipTime(d.t)}`;
      const priceText = `价格 ${hasMpThis ? d.mp.toFixed(6) : '-'}`;
      const nuText    = `名义 ${formatUSD(d.nu)} USDT`;
      const lines     = [timeText, priceText, nuText];

      ctx.font = '12px system-ui';
      let maxW = 0;
      for (const t of lines){
        const w = ctx.measureText(t).width;
        if (w > maxW) maxW = w;
      }
      const padX = 10, padY = 6, lh = 16;
      const boxW = maxW + padX*2;
      const boxH = lh*lines.length + padY*2;

      // 智能水平位置：优先垂直线右侧，放不下再挪左
      let boxX = xLine + 8;
      if (boxX + boxW > W - PADR - 4){
        boxX = xLine - 8 - boxW;
        if (boxX < PADL + 4){
          boxX = PADL + 4;
        }
      }

      // 垂直位置：以 anchorY 为基准上下避让
      let boxY = anchorY - boxH - 8;
      if (boxY < PADT + 4){
        boxY = anchorY + 8;
      }
      if (boxY + boxH > H - PADB - 4){
        boxY = H - PADB - boxH - 4;
      }

      // 气泡背景
      ctx.fillStyle   = 'rgba(15,23,42,0.96)';
      ctx.strokeStyle = 'rgba(55,65,81,1)';
      ctx.lineWidth   = 1;
      if (ctx.roundRect){
        ctx.beginPath();
        ctx.roundRect(boxX, boxY, boxW, boxH, 6);
        ctx.fill();
        ctx.stroke();
      }else{
        ctx.beginPath();
        ctx.rect(boxX, boxY, boxW, boxH);
        ctx.fill();
        ctx.stroke();
      }

      // 气泡文字
      ctx.fillStyle   = '#e5e7eb';
      ctx.textAlign   = 'left';
      ctx.textBaseline= 'top';
      lines.forEach((t,idx)=>{
        ctx.fillText(t, boxX + padX, boxY + padY + idx*lh);
      });
    }

    const d0 = data[0];
    const d1 = data[data.length-1];
    chartMeta.textContent =
      `点数 ${data.length} · 粒度 ${preset} · Δ名义 ${(d1.nu-d0.nu).toFixed(2)} USDT`;

    // 图重画完顺手刷新一下预测 UI
    renderSignal();
  }

  /* ============ 拉历史 ============ */
  async function reloadHistoryForCurrentSymbol(){
    if (!curSymbol) return;

    const preset    = aggSel.value || '5m';
    const apiPeriod = PERIOD_FOR_API[preset];

    const j = await getHistory(curSymbol, 500, apiPeriod);
    samples = (j.samples||[]).map(s=>({
      ...s,
      t : Number(s.t),
      nu: Number(s.nu ?? s.notionalUSD ?? s.oi ?? 0),
      mp: Number(s.mp) || null
    }));

    liveTail = [];
    predictor.reset();

    // 用最后一笔做个 baseline
    if (samples.length){
      const last = samples[samples.length-1];
      if (Number.isFinite(last.nu) && Number.isFinite(last.mp)){
        predictor.pushSnapshot({
          t    : last.t,
          price: last.mp,
          oi   : last.nu
        });
      }
    }

    drawChart();
  }

  /* ============ 关闭弹窗 ============ */
  if (btnClose){
    btnClose.addEventListener('click', () => {
      drawer.classList.remove('open');

      curSymbol = null;
      samples   = [];
      liveTail  = [];
      chartMeta.textContent = '—';
      lastBuckets = [];
      hoverIndex  = null;
      predictor.reset();
      if (signalBox) signalBox.innerHTML = '';

      if (autoTimer){
        clearInterval(autoTimer);
        autoTimer = null;
      }
    });
  }

  /* ============ 粒度切换 ============ */
  if (aggSel){
    aggSel.addEventListener('change', async ()=>{
      try{
        await reloadHistoryForCurrentSymbol();
      }catch(e){
        console.error('agg change reload failed', e);
      }
    });
  }

  /* ============ 点击交互：选择点 / 清除 ============ */
  canvas.addEventListener('click', (ev)=>{
    const rect   = canvas.getBoundingClientRect();
    const scaleX = canvas.width  / rect.width;
    const scaleY = canvas.height / rect.height;

    const cx = (ev.clientX - rect.left) * scaleX;
    const cy = (ev.clientY - rect.top)  * scaleY;

    if (!lastBuckets || lastBuckets.length === 0){
      hoverIndex = null;
      drawChart();
      return;
    }

    const W = canvas.width;
    const H = canvas.height;

    // 点击在主绘图区外：关闭
    if (cx < PADL || cx > W-PADR || cy < PADT || cy > H-PADB){
      hoverIndex = null;
      drawChart();
      return;
    }

    const data = lastBuckets;
    const xs   = data.map(d=>d.t);
    const xmin = Math.min(...xs);
    const xmax = Math.max(...xs);
    const span = xmax - xmin || 1;

    const tClick = xmin + (cx - PADL)/(W-PADL-PADR) * span;

    let bestIdx  = 0;
    let bestDist = Infinity;
    for (let i=0;i<data.length;i++){
      const dist = Math.abs(data[i].t - tClick);
      if (dist < bestDist){
        bestDist = dist;
        bestIdx  = i;
      }
    }

    hoverIndex = bestIdx;
    drawChart();
  });

  // 点击画布以外任意地方：关闭十字线和气泡
  document.addEventListener('click', (ev)=>{
    const path = ev.composedPath ? ev.composedPath() : [];
    if (path.includes(canvas)) return;

    if (hoverIndex != null){
      hoverIndex = null;
      drawChart();
    }
  });

  /* ============ 对外接口 ============ */
  return {
    async open(symbol){
      curSymbol  = symbol;
      liveTail   = [];
      hoverIndex = null;
      predictor.reset();

      drawerTitle.textContent = `${symbol} · 名义持仓（USDT）`;
      drawer.classList.add('open');

      await reloadHistoryForCurrentSymbol();

      if (autoTimer) clearInterval(autoTimer);
      autoTimer = setInterval(reloadHistoryForCurrentSymbol, 300000);
    },

    // pushLive：名义 + 价格 + 时间
    pushLive(nu, price, t){
      if (!curSymbol) return;
      const ts   = Number(t)    || Date.now();
      const nuN  = Number(nu)   || 0;
      const mpN  = Number(price);
      const mp   = Number.isFinite(mpN) ? mpN : null;

      liveTail.push({ t: ts, nu: nuN, mp });
      if (liveTail.length > 200) liveTail.shift();

      if (mp !== null){
        predictor.pushSnapshot({
          t    : ts,
          price: mp,
          oi   : nuN
        });
      }

      drawChart();
    },

    // WS 成交推给预测器
    pushTrades(rows){
      if (!curSymbol || !Array.isArray(rows)) return;

      let any = false;
      for (const it of rows){
        if (!it || it.s !== curSymbol) continue;
        const p  = Number(it.p);
        const q  = Number(it.q);
        const nu = Number(it.nu != null ? it.nu : (p * q));
        const ts = Number(it.ts) || Date.now();
        const m  = !!it.m; // true=卖出

        if (!Number.isFinite(p) || !Number.isFinite(q) || !Number.isFinite(nu)) continue;

        predictor.pushTrade({
          t    : ts,
          side : m ? 'sell' : 'buy',
          quote: nu,
          price: p
        });
        any = true;
      }

      if (any){
        renderSignal();
      }
    }
  };
}
