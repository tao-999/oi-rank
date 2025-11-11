// —— 趋势窗口解析 / 文案 —— //
export function humanWin(ms){
  const m = Number(ms);
  if (m%604800000===0) return (m/604800000)+'w';
  if (m%86400000===0)  return (m/86400000)+'d';
  if (m%3600000===0)   return (m/3600000)+'h';
  if (m%60000===0)     return (m/60000)+'m';
  return (m/60000)+'m';
}
export function parseWins(inputValue){
  const raw = String(inputValue||'').split(',').map(s=>s.trim()).filter(Boolean);
  const toMs = (w)=>{
    const m = w.match(/^(\d+)\s*(m|h|d|w)$/i);
    if(!m) return null;
    const n=Number(m[1]); const u=m[2].toLowerCase();
    return n*(u==='m'?60000: u==='h'?3600000: u==='d'?86400000: 7*86400000);
  };
  const arr = raw.map(toMs).filter(Boolean);
  return Array.from(new Set(arr)).sort((a,b)=>a-b);
}
