// public/js/chart.js
import { el } from './utils.js';

/* ========= 统一按时间桶聚合：取每桶“最后一笔”作为 close ========= */
export function resampleBuckets(samples, presetKey){
  const PRESET_MS = {
    '5m':300000,'15m':900000,'30m':1800000,'1h':3600000,'2h':7200000,
    '4h':14400000,'8h':28800000,'12h':43200000,'1d':86400000,'3d':259200000,'1w':604800000
  };
  const step = PRESET_MS[presetKey] || PRESET_MS['1h'];
  const map = new Map(); // bucket -> last sample
  for(const s of samples){
    if (!s || (!Number.isFinite(s.nu) && !Number.isFinite(s.mp) && !Number.isFinite(s.oi))) continue;
    const bucket = Math.floor(s.t/step)*step;
    map.set(bucket, s); // 覆盖即取“最后一笔”
  }
  const keys = Array.from(map.keys()).sort((a,b)=>a-b);
  return keys.map(k=>{
    const s = map.get(k);
    const nu = Number.isFinite(s.nu)? s.nu : undefined;
    const mp = Number.isFinite(s.mp)? s.mp : undefined;
    let oi = Number.isFinite(s.oi)? s.oi : (Number.isFinite(nu)&&Number.isFinite(mp)&&mp!==0 ? (nu/mp) : undefined);
    return { t:k, nu, mp, oi };
  });
}

/* ========= 计算高周期偏置（7d / 30d），仅用价格（mp） ========= */
function computeHTFBias(allRaw, mode){
  if(mode === 'off') return { mode, dir: 'flat', dP: 0, from:null, to:null };

  const nowTs = Date.now();
  const lookMs = mode === '30d' ? 30*86400000 : 7*86400000;
  const fromTs = nowTs - lookMs;

  const win = allRaw.filter(s => Number.isFinite(s.t) && s.t >= fromTs);
  if(!win.length) return { mode, dir:'flat', dP:0, from:null, to:null };

  const dayStep = 86400000;
  const map = new Map(); // 日桶 -> 最后一笔
  for(const s of win){
    if(!Number.isFinite(s.mp)) continue;
    const bucket = Math.floor(s.t/dayStep)*dayStep;
    map.set(bucket, s);
  }
  const keys = Array.from(map.keys()).sort((a,b)=>a-b);
  if(keys.length < 2) return { mode, dir:'flat', dP:0, from:null, to:null };

  const first = map.get(keys[0]);
  const last  = map.get(keys[keys.length-1]);
  if(!Number.isFinite(first?.mp) || !Number.isFinite(last?.mp)) return { mode, dir:'flat', dP:0, from:null, to:null };

  const dP = first.mp !== 0 ? (last.mp/first.mp - 1) : 0;
  const TH = 0.01; // 1% 作为显著阈值

  let dir = 'flat';
  if (dP >  TH) dir = 'up';
  else if (dP < -TH) dir = 'down';

  return { mode, dir, dP, from: keys[0], to: keys[keys.length-1] };
}

/* ========= 主图组件 ========= */
export function createChart(){
  const drawer      = el('drawer');
  const drawerTitle = el('drawerTitle');
  const btnClose    = el('btnClose');
  const aggSel      = el('aggSel');
  const canvas      = el('chart');
  const ctx2        = canvas.getContext('2d');
  const chartMeta   = el('chartMeta');
  const signalBox   = el('signalBox');
  const biasSel     = el('biasSel'); // 来自 HTML / 或你之前注入的选择器

  let curSymbol   = null;
  let curSamples  = [];
  let liveTail    = [];
  let autoHistTimer = null;
  let dragging    = false;
  let lastX       = 0;
  let viewMin     = 0;
  let viewMax     = 0;
  let followTail  = true;
  let lastSignalHTML = '';

  // 左轴（价格）要多留点空间
  const PADL=54,PADR=64,PADT=18,PADB=30;

  function getDataMinTime(){
    const arr = curSamples.concat(liveTail);
    return arr.length ? Math.min(...arr.map(s=>s.t)) : Date.now()-3600e3;
  }
  function getDataMaxTime(){
    const arr = curSamples.concat(liveTail);
    return arr.length ? Math.max(...arr.map(s=>s.t)) : Date.now();
  }
  function getSpan(){ return Math.max(1000, viewMax-viewMin); }
  function clampView(){
    const dmin=getDataMinTime(), dmax=getDataMaxTime();
    const span=getSpan(), total=Math.max(1000,dmax-dmin);
    if(span>total){ viewMin=dmin; viewMax=dmax; return; }
    if(viewMin<dmin){ viewMin=dmin; viewMax=dmin+span; }
    if(viewMax>dmax){ viewMax=dmax; viewMin=dmax-span; }
  }

  canvas.addEventListener('mousedown',e=>{
    dragging=true; lastX=e.clientX; followTail=false;
  });
  canvas.addEventListener('mousemove',e=>{
    if(!dragging) return;
    const dx=e.clientX-lastX; lastX=e.clientX;
    const pxSpan=canvas.width-PADL-PADR; const tSpan=getSpan(); const dt=-dx*tSpan/pxSpan;
    viewMin+=dt; viewMax+=dt; clampView(); drawChart();
  });
  canvas.addEventListener('mouseup',()=>dragging=false);
  canvas.addEventListener('mouseleave',()=>dragging=false);
  canvas.addEventListener('wheel',e=>{
    e.preventDefault(); followTail=false;
    const factor=e.deltaY<0?0.9:1.1;
    const rect=canvas.getBoundingClientRect(); const x=e.clientX-rect.left; const pxSpan=canvas.width-PADL-PADR;
    const ratio=Math.max(0,Math.min(1,(x-PADL)/pxSpan)); const center=viewMin+getSpan()*ratio;
    let newSpan=getSpan()*factor;
    newSpan=Math.max(60000,Math.min(newSpan,getDataMaxTime()-getDataMinTime()+60000));
    viewMin=center-newSpan*ratio; viewMax=center+newSpan*(1-ratio);
    clampView(); drawChart();
  }, {passive:false});
  canvas.addEventListener('dblclick', ()=>{
    viewMax = getDataMaxTime();
    const span = getSpan();
    viewMin = viewMax - span;
    followTail = true;
    drawChart();
  });

  btnClose.addEventListener('click', ()=>{
    drawer.classList.remove('open');
    curSymbol=null;
    if(autoHistTimer){clearInterval(autoHistTimer); autoHistTimer=null;}
    liveTail = [];
  });

  aggSel.addEventListener('change', ()=> drawChart());
  if (biasSel) {
    biasSel.addEventListener('change', ()=> drawChart());
  }

  function drawChart(){
    const ctx=ctx2, W=canvas.width,H=canvas.height;
    ctx.clearRect(0,0,W,H);

    const allRaw = curSamples.concat(liveTail).filter(s=>Number.isFinite(s.t));
    if(!allRaw.length){
      chartMeta.textContent='暂无历史样本';
      if(signalBox) signalBox.innerHTML='';
      return;
    }

    const margin=getSpan()*0.2;
    const windowRaw = allRaw.filter(s=>s.t>=(viewMin-margin)&&s.t<=(viewMax+margin));
    const preset=aggSel.value;

    const data = resampleBuckets(windowRaw, preset).filter(d=>d.t>=viewMin&&d.t<=viewMax);
    if(data.length<2){
      chartMeta.textContent='数据点不足';
      if(signalBox) signalBox.innerHTML='';
      return;
    }

    const xs=data.map(d=>d.t);
    const nuVals=data.map(d=>d.nu).filter(Number.isFinite);
    const mpVals=data.map(d=>d.mp).filter(Number.isFinite);

    const xmin=Math.min(...xs), xmax=Math.max(...xs);
    const nuMin=nuVals.length?Math.min(...nuVals):0, nuMax=nuVals.length?Math.max(...nuVals):1;
    const mpMin=mpVals.length?Math.min(...mpVals):0, mpMax=mpVals.length?Math.max(...mpVals):1;

    // 边框
    ctx.strokeStyle='#1f2a40'; ctx.lineWidth=1;
    ctx.beginPath();
    ctx.moveTo(PADL,PADT); ctx.lineTo(PADL,H-PADB); ctx.lineTo(W-PADR,H-PADB);
    ctx.moveTo(W-PADR,PADT); ctx.lineTo(W-PADR,H-PADB);
    ctx.stroke();

    // Y 轴网格/刻度（右轴=名义，左轴=价格）
    ctx.fillStyle='#9aa4b2'; ctx.font='12px system-ui';
    for(let i=0;i<=4;i++){
      const v=nuMin+(nuMax-nuMin)*i/4; 
      const y=mapYNu(v);
      // 网格
      ctx.strokeStyle='rgba(255,255,255,0.06)'; 
      ctx.beginPath(); ctx.moveTo(PADL,y); ctx.lineTo(W-PADR,y); ctx.stroke();
      // 右轴（名义）
      ctx.fillText((v/1e6).toFixed(2)+'M', W-PADR+6, y+4);
      // 左轴（价格）映射同一水平线
      if (mpVals.length){
        const pv = remap(v, nuMin, nuMax, mpMin, mpMax);
        ctx.textAlign='right';
        ctx.fillText(fmtPrice(pv), PADL-6, y+4);
        ctx.textAlign='start';
      }
    }

    // X 轴刻度
    const PRESET_MS={'5m':300000,'15m':900000,'30m':1800000,'1h':3600000,'2h':7200000,'4h':14400000,'8h':28800000,'12h':43200000,'1d':86400000,'3d':259200000,'1w':604800000};
    const stepMs=PRESET_MS[preset]; const span=(viewMax-viewMin)||1;
    const approxTicks=Math.min(8,Math.max(3,Math.floor((W-PADL-PADR)/120)));
    const tickStep=Math.max(stepMs,Math.ceil(span/approxTicks/stepMs)*stepMs);
    const firstTick=Math.floor(viewMin/tickStep)*tickStep;
    for(let t=firstTick;t<=viewMax;t+=tickStep){
      const x=mapX(t);
      ctx.strokeStyle='rgba(255,255,255,0.04)'; 
      ctx.beginPath(); ctx.moveTo(x,PADT); ctx.lineTo(x,H-PADB); ctx.stroke();
      ctx.fillText(formatTs(t,preset), x-32, H-PADB+18);
    }

    // 左轴：价格线
    if (mpVals.length){
      ctx.strokeStyle='#9be37d';
      ctx.lineWidth=1.8; 
      ctx.beginPath();
      let first=true;
      for(const d of data){
        if (!Number.isFinite(d.mp)) continue;
        const x=mapX(d.t), y=mapYPrice(d.mp);
        if(first){ ctx.moveTo(x,y); first=false; } else ctx.lineTo(x,y);
      }
      ctx.stroke();
    }

    // 右轴：名义线
    if (nuVals.length){
      ctx.strokeStyle='#4da3ff';
      ctx.lineWidth=2.2; 
      ctx.beginPath();
      let first=true;
      for(const d of data){
        if (!Number.isFinite(d.nu)) continue;
        const x=mapX(d.t), y=mapYNu(d.nu);
        if(first){ ctx.moveTo(x,y); first=false; } else ctx.lineTo(x,y);
      }
      ctx.stroke();
    }

    // 图例
    ctx.fillStyle='#9aa4b2';
    ctx.fillText('价格(左轴)', PADL, PADT-2);
    ctx.fillText('名义(右轴)', PADL+90, PADT-2);

    // meta
    const lastNu = nuVals.at(-1), firstNu = nuVals[0];
    const deltaNu = (Number.isFinite(lastNu)&&Number.isFinite(firstNu))? (lastNu-firstNu) : undefined;
    const slopePerMin = (Number.isFinite(deltaNu)) ? deltaNu/Math.max(1,(xmax-xmin)/60000) : undefined;
    const lastMp = mpVals.at(-1);
    chartMeta.textContent = [
      `点数：${data.length}`,
      `粒度：${preset}`,
      `窗口：${((viewMax-viewMin)/3600000).toFixed(1)}h`,
      Number.isFinite(deltaNu) ? `Δ名义：$${(deltaNu/1e6).toFixed(2)}M` : '',
      Number.isFinite(slopePerMin) ? `斜率：$${(slopePerMin/1e6).toFixed(2)}M/min` : '',
      Number.isFinite(lastMp) ? `价格：${fmtPrice(lastMp)}` : ''
    ].filter(Boolean).join(' · ');

    // —— HTF 偏置 & 信号 —— //
    const biasMode = biasSel ? (biasSel.value || 'off') : 'off';
    const bias = computeHTFBias(curSamples.concat(liveTail), biasMode);
    renderSignal(windowRaw, preset, bias);

    /* ———— 内部工具函数 ———— */
    function mapX(t){ return PADL + (W-PADL-PADR) * (t - viewMin) / (viewMax - viewMin || 1); }
    function mapYNu(v){ return H-PADB - (H-PADT-PADB) * (v - nuMin) / ((nuMax - nuMin) || 1); }
    function mapYPrice(v){ return H-PADB - (H-PADT-PADB) * (v - mpMin) / ((mpMax - mpMin) || 1); }
    function remap(v, a1,b1,a2,b2){ if(b1===a1) return a2; const t=(v-a1)/(b1-a1); return a2 + (b2-a2)*Math.max(0,Math.min(1,t)); }
    function fmtPrice(p){
      if (p>=1000) return '$'+p.toLocaleString(undefined,{maximumFractionDigits:2});
      if (p>=1)    return '$'+p.toLocaleString(undefined,{maximumFractionDigits:4});
      return '$'+p.toLocaleString(undefined,{maximumFractionDigits:6});
    }
    function formatTs(t, preset){
      const d = new Date(t);
      const M = String(d.getMonth()+1).padStart(2,'0');
      const D = String(d.getDate()).padStart(2,'0');
      const Hh = String(d.getHours()).padStart(2,'0');
      const Mi = String(d.getMinutes()).padStart(2,'0');
      const total = viewMax - viewMin;
      if (preset === '1w' || preset === '3d' || preset === '1d') return `${M}/${D}`;
      if (preset.endsWith('h')) return `${M}/${D} ${Hh}:00`;
      return total > 86400000 ? `${M}/${D} ${Hh}:${Mi}` : `${Hh}:${Mi}`;
    }
  }

  function renderSignal(windowRaw, preset, bias){
    if (!signalBox) return;

    const edge = (key)=>{
      let first, last;
      for (let i=0;i<windowRaw.length;i++){
        const v = windowRaw[i]?.[key];
        if (Number.isFinite(v)){ first = v; break; }
      }
      for (let i=windowRaw.length-1;i>=0;i--){
        const v = windowRaw[i]?.[key];
        if (Number.isFinite(v)){ last = v; break; }
      }
      return [first,last];
    };

    const [p0,p1] = edge('mp');
    const [o0,o1] = edge('oi');
    const [n0,n1] = edge('nu');

    const dP = (Number.isFinite(p0)&&Number.isFinite(p1)&&p0!==0) ? (p1/p0 - 1) : undefined;
    const dO = (Number.isFinite(o0)&&Number.isFinite(o1)&&o0!==0) ? (o1/o0 - 1) : undefined;
    const dN = (Number.isFinite(n0)&&Number.isFinite(n1)) ? (n1 - n0) : undefined;

    const TH_P = 0.002; // 0.2%
    const TH_O = 0.005; // 0.5%

    if (!Number.isFinite(dP) || !Number.isFinite(dO)){
      if (lastSignalHTML) signalBox.innerHTML = lastSignalHTML;
      return;
    }

    let label = '观望/震荡', score = 0, cls = 'sig-badge sig-weak';
    const upP = dP > TH_P, dnP = dP < -TH_P;
    const upO = dO > TH_O, dnO = dO < -TH_O;

    if (upP && upO){ label='顺势看多（延续）'; score=+2; cls='sig-badge sig-up'; }
    else if (dnP && upO){ label='偏空（下跌增仓）'; score=-2; cls='sig-badge sig-down'; }
    else if (upP && dnO){ label='多头回补/挤空'; score=+1; cls='sig-badge sig-up'; }
    else if (dnP && dnO){ label='去杠杆/谨慎'; score=-1; cls='sig-badge sig-down'; }

    let biasBadge = '';
    if (bias && bias.mode !== 'off'){
      const dirMap = { up:'多头偏置', down:'空头偏置', flat:'中性偏置' };
      const biasText = `${dirMap[bias.dir]||'中性偏置'} · ${bias.mode.toUpperCase()}`;
      biasBadge = `<span class="sig-badge">${biasText}（ΔP：${fmtPct(bias.dP)}）</span>`;

      const shortUp  = score > 0;
      const shortDown= score < 0;

      if (bias.dir === 'up' && shortDown){
        label = label.replace('偏空','逆势偏空').replace('谨慎','逆势谨慎');
        score = Math.min(0, score+1);
        cls = score<0 ? 'sig-badge sig-down' : 'sig-badge sig-weak';
      }else if (bias.dir === 'down' && shortUp){
        label = label.replace('看多','逆势看多').replace('挤空','逆势挤空');
        score = Math.max(0, score-1);
        cls = score>0 ? 'sig-badge sig-up' : 'sig-badge sig-weak';
      }else if (bias.dir === 'up' && shortUp){
        label = label.replace('顺势','顺势（HTF同向）');
      }else if (bias.dir === 'down' && shortDown){
        label = label.replace('谨慎','谨慎（HTF同向）').replace('偏空','偏空（HTF同向）');
      }
    }

    const durH=((viewMax-viewMin)/3600000).toFixed(1);
    const html = `
      <span class="${cls}">${label}</span>
      ${biasBadge}
      <span class="sig-badge">窗口：${durH}h · 粒度：${preset}</span>
      <span class="sig-badge">ΔPrice：${fmtPct(dP)}</span>
      <span class="sig-badge">ΔOI：${fmtPct(dO)}</span>
      <span class="sig-badge">Δ名义：${Number.isFinite(dN)? ('$'+(dN/1e6).toFixed(2)+'M') : '—'}</span>
      <span class="sig-badge sig-weak">分数：${score}</span>
    `;
    signalBox.innerHTML = html;
    lastSignalHTML = html;

    function fmtPct(x){
      if (!Number.isFinite(x)) return '—';
      const v = (x*100);
      const sign = v>0 ? '+' : '';
      return sign + v.toFixed(2) + '%';
    }
  }

  return {
    async open(symbol, loader){
      if (!symbol) return;
      curSymbol=symbol;
      drawerTitle.textContent = symbol+' · 名义持仓（USD）历史';
      drawer.classList.add('open');

      const j = await loader(symbol);
      curSamples = (j.samples||[]).filter(s=>Number.isFinite(s.nu) || Number.isFinite(s.mp) || Number.isFinite(s.oi));
      const xs = curSamples.map(s=>s.t);
      viewMin = xs.length?Math.min(...xs):Date.now()-3600e3;
      viewMax = xs.length?Math.max(...xs):Date.now();
      followTail = true;
      liveTail=[]; 
      lastSignalHTML = '';
      drawChart();

      if (autoHistTimer) clearInterval(autoHistTimer);
      autoHistTimer=setInterval(async ()=>{
        if (!curSymbol) return;
        const j2=await loader(curSymbol);
        curSamples=(j2.samples||[]).filter(s=>Number.isFinite(s.nu) || Number.isFinite(s.mp) || Number.isFinite(s.oi));
        drawChart();
      }, 180000);
    },
    // 实时只推名义；窗口信号会用“最近一次有 mp/oi 的点”计算
    pushLive(nu,t){
      if(!curSymbol || !Number.isFinite(nu)) return;
      const tt=t||Date.now();
      const last=liveTail[liveTail.length-1];
      if(!last || last.t!==tt){
        liveTail.push({t:tt,nu});
        if(liveTail.length>500) liveTail.splice(0,liveTail.length-500);
        if(followTail){
          viewMax=tt; const span=getSpan(); viewMin=viewMax-span;
        }
        drawChart();
      }
    }
  };
}
