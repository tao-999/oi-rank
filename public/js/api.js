// —— HTTP API 封装 —— //
export async function getProgress(){
  const r = await fetch('/api/progress',{cache:'no-store'}); return r.json();
}
export async function getSnapshot(){
  const r = await fetch('/api/oi-rank',{cache:'no-store'}); return r.json();
}
export async function getHistory(symbol, limit=20000){
  const u = new URL('/api/history', location.origin);
  u.searchParams.set('symbol', symbol); u.searchParams.set('limit', String(limit));
  const r = await fetch(u, {cache:'no-store'}); return r.json();
}
export async function getTrends(winLabelsCsv){
  const u = new URL('/api/trend', location.origin);
  u.searchParams.set('wins', winLabelsCsv);
  const r = await fetch(u, {cache:'no-store'}); return r.json();
}
