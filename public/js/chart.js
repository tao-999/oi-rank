import { el } from './utils.js';

// —— resampleByPresetNU 内联实现 —— //
export function resampleByPresetNU(samples, presetKey){
  const PRESET_MS={
    '5m':300000,'15m':900000,'30m':1800000,'1h':3600000,'2h':7200000,
    '4h':14400000,'8h':28800000,'12h':43200000,'1d':86400000,'3d':259200000,'1w':604800000
  };
  const step = PRESET_MS[presetKey] || PRESET_MS['1h'];
  const map = new Map();
  for(const s of samples){
    if(!Number.isFinite(s.nu)) continue;
    const bucket=Math.floor(s.t/step)*step;
    map.set(bucket,s); // 取每桶最后一笔
  }
  const keys = Array.from(map.keys()).sort((a,b)=>a-b);
  return keys.map(k=>({ t:k, nu: map.get(k).nu }));
}

export function createChart(){
  const drawer = el('drawer');
  const drawerTitle=el('drawerTitle');
  const btnClose=el('btnClose');
  const aggSel=el('aggSel');
  const canvas=el('chart');
  const ctx2=canvas.getContext('2d'); const chartMeta=el('chartMeta');

  let curSymbol=null, curSamples=[], liveTail=[], autoHistTimer=null;
  let dragging=false,lastX=0, viewMin=0, viewMax=0;
  const PADL=14,PADR=64,PADT=14,PADB=28;

  btnClose.addEventListener('click', ()=>{
    drawer.classList.remove('open'); curSymbol=null;
    if(autoHistTimer){clearInterval(autoHistTimer); autoHistTimer=null;}
  });
  aggSel.addEventListener('change', ()=> drawChart());

  function getDataMinTime(){ const arr=curSamples.concat(liveTail); return arr.length?Math.min(...arr.map(s=>s.t)):Date.now()-3600e3; }
  function getDataMaxTime(){ const arr=curSamples.concat(liveTail); return arr.length?Math.max(...arr.map(s=>s.t)):Date.now(); }
  function getSpan(){ return Math.max(1000, viewMax-viewMin); }
  function clampView(){
    const dmin=getDataMinTime(), dmax=getDataMaxTime();
    const span=getSpan(), total=Math.max(1000,dmax-dmin);
    if(span>total){ viewMin=dmin; viewMax=dmax; return; }
    if(viewMin<dmin){ viewMin=dmin; viewMax=dmin+span; }
    if(viewMax>dmax){ viewMax=dmax; viewMin=dmax-span; }
  }

  canvas.addEventListener('mousedown',e=>{dragging=true; lastX=e.clientX;});
  canvas.addEventListener('mousemove',e=>{
    if(!dragging) return;
    const dx=e.clientX-lastX; lastX=e.clientX;
    const pxSpan=canvas.width-PADL-PADR; const tSpan=getSpan(); const dt=-dx*tSpan/pxSpan;
    viewMin+=dt; viewMax+=dt; clampView(); drawChart();
  });
  canvas.addEventListener('mouseup',()=>dragging=false);
  canvas.addEventListener('mouseleave',()=>dragging=false);
  canvas.addEventListener('wheel',e=>{
    e.preventDefault();
    const factor=e.deltaY<0?0.9:1.1;
    const rect=canvas.getBoundingClientRect(); const x=e.clientX-rect.left; const pxSpan=canvas.width-PADL-PADR;
    const ratio=Math.max(0,Math.min(1,(x-PADL)/pxSpan)); const center=viewMin+getSpan()*ratio;
    let newSpan=getSpan()*factor;
    newSpan=Math.max(60000,Math.min(newSpan,getDataMaxTime()-getDataMinTime()+60000));
    viewMin=center-newSpan*ratio; viewMax=center+newSpan*(1-ratio);
    clampView(); drawChart();
  }, {passive:false});

  function drawChart(){
    const ctx=ctx2, W=canvas.width,H=canvas.height;
    ctx.clearRect(0,0,W,H);
    const all=curSamples.concat(liveTail).filter(s=>Number.isFinite(s.nu));
    if(!all.length){ chartMeta.textContent='暂无历史样本'; return; }

    const margin=getSpan()*0.2;
    const subset=all.filter(s=>s.t>=(viewMin-margin)&&s.t<=(viewMax+margin));
    const preset=aggSel.value;
    const data=resampleByPresetNU(subset,preset).filter(d=>d.t>=viewMin&&d.t<=viewMax);
    if(data.length<2){ chartMeta.textContent='数据点不足'; return; }

    const xs=data.map(d=>d.t), ys=data.map(d=>d.nu);
    const xmin=Math.min(...xs), xmax=Math.max(...xs);
    const ymin=Math.min(...ys), ymax=Math.max(...ys);

    // 边框
    ctx.strokeStyle='#1f2a40'; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(14,14); ctx.lineTo(14,H-PADB); ctx.lineTo(W-PADR,H-PADB); ctx.moveTo(W-PADR,14); ctx.lineTo(W-PADR,H-PADB); ctx.stroke();

    // Y 轴网格/标注
    ctx.fillStyle='#9aa4b2'; ctx.font='12px system-ui';
    for(let i=0;i<=4;i++){
      const v=ymin+(ymax-ymin)*i/4; const y=mapY(v);
      ctx.strokeStyle='rgba(255,255,255,0.06)'; ctx.beginPath(); ctx.moveTo(14,y); ctx.lineTo(W-PADR,y); ctx.stroke();
      ctx.fillText((v/1e6).toFixed(2)+'M', W-PADR+6, y+4);
    }

    // X 轴刻度
    const PRESET_MS={'5m':300000,'15m':900000,'30m':1800000,'1h':3600000,'2h':7200000,'4h':14400000,'8h':28800000,'12h':43200000,'1d':86400000,'3d':259200000,'1w':604800000};
    const stepMs=PRESET_MS[preset]; const span=(viewMax-viewMin)||1;
    const approxTicks=Math.min(8,Math.max(3,Math.floor((W-14-PADR)/120)));
    const tickStep=Math.max(stepMs,Math.ceil(span/approxTicks/stepMs)*stepMs);
    const firstTick=Math.floor(viewMin/tickStep)*tickStep;
    for(let t=firstTick;t<=viewMax;t+=tickStep){
      const x=mapX(t);
      ctx.strokeStyle='rgba(255,255,255,0.04)'; ctx.beginPath(); ctx.moveTo(x,14); ctx.lineTo(x,H-PADB); ctx.stroke();
      ctx.fillText(formatTs(t,preset), x-32, H-PADB+18);
    }

    // 折线
    ctx.strokeStyle='#4da3ff'; ctx.lineWidth=2; ctx.beginPath();
    data.forEach((d,i)=>{ const x=mapX(d.t), y=mapY(d.nu); if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y); });
    ctx.stroke();

    // meta
    const delta=ys[ys.length-1]-ys[0];
    const durH=((viewMax-viewMin)/3600000).toFixed(1);
    const slopePerMin=delta/Math.max(1,(xmax-xmin)/60000);
    chartMeta.textContent = `点数：${data.length} · 粒度：${preset} · 窗口：${durH}h · Δ名义：$${(delta/1e6).toFixed(2)}M · 斜率：$${(slopePerMin/1e6).toFixed(2)}M/min`;

    function mapX(t){ return 14 + (W-14-PADR) * (t - viewMin) / (viewMax - viewMin || 1); }
    function mapY(v){ return H-PADB - (H-14-PADB) * (v - ymin) / (ymax - ymin || 1); }
    function formatTs(t, preset){
      const d = new Date(t);
      const M = String(d.getMonth()+1).padStart(2,'0');
      const D = String(d.getDate()).padStart(2,'0');
      const H = String(d.getHours()).padStart(2,'0');
      const m = String(d.getMinutes()).padStart(2,'0');

      // 总窗口跨度
      const span = viewMax - viewMin;

      if (preset === '1w' || preset === '3d' || preset === '1d') return `${M}/${D}`;
      if (preset.endsWith('h')) return `${M}/${D} ${H}:00`;

      // 分钟档：若跨天 (>24h) 则显示日期+时间，否则只显示时间
      return span > 86400000 ? `${M}/${D} ${H}:${m}` : `${H}:${m}`;
    }

  }

  return {
    async open(symbol, loader){
      if (!symbol) return;
      curSymbol=symbol;
      drawerTitle.textContent = symbol+' · 名义持仓（USD）历史';
      drawer.classList.add('open');
      const j = await loader(symbol);
      curSamples = (j.samples||[]).filter(s=>Number.isFinite(s.nu));
      const xs = curSamples.map(s=>s.t);
      viewMin = xs.length?Math.min(...xs):Date.now()-3600e3;
      viewMax = xs.length?Math.max(...xs):Date.now();
      liveTail=[]; drawChart();
      if (autoHistTimer) clearInterval(autoHistTimer);
      autoHistTimer=setInterval(async ()=>{
        const j2=await loader(symbol);
        curSamples=(j2.samples||[]).filter(s=>Number.isFinite(s.nu));
        drawChart();
      }, 180000);
    },
    pushLive(nu,t){
      if(!curSymbol) return;
      const tt=t||Date.now();
      const last=liveTail[liveTail.length-1];
      if(!last || last.t!==tt){
        liveTail.push({t:tt,nu});
        if(liveTail.length>500) liveTail.splice(0,liveTail.length-500);
        if(Math.abs(viewMax-tt)<2000){
          viewMax=tt; const span=Math.max(1000, viewMax-viewMin); viewMin=viewMax-span;
        }
        drawChart();
      }
    }
  };
}
