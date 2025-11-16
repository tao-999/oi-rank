// public/js/api.js

// —— 初始化进度 —— //
export async function getProgress(){
  const r = await fetch('/api/progress', { cache:'no-store' });
  return r.json();
}

// —— 当前快照：table 用 —— //
// 支持可选 wins 参数：'30m,1h,4h,24h'
export async function getSnapshot(wins){
  const u = new URL('/api/oi-rank', location.origin);
  if (wins && typeof wins === 'string' && wins.trim()){
    u.searchParams.set('wins', wins.trim());
  }
  const r = await fetch(u, { cache:'no-store' });
  return r.json();
}

// —— OI 历史：折线图用 —— //
// GET /api/history?symbol=BTCUSDT&limit=500[&period=5m]
export async function getHistory(symbol, limit = 500, period){
  const u = new URL('/api/history', location.origin);
  u.searchParams.set('symbol', symbol);
  u.searchParams.set('limit', String(limit));
  if (period && typeof period === 'string' && period.trim()){
    u.searchParams.set('period', period.trim());
  }
  const r = await fetch(u, { cache:'no-store' });
  return r.json();
}
