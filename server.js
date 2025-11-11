// 启动入口
const { createServer } = require('./src/http');
const { bootstrap } = require('./src/services/binance');
const marketcap = require('./src/services/marketcap');

const server = createServer();
const PORT = process.env.PORT || 8787;
server.listen(PORT, async ()=>{
  console.log('[HTTP] http://localhost:'+PORT);
  // 启动数据源
  await bootstrap().catch(err=> console.error('[INIT ERROR]', err));
  // 启动市值刷新（独立于币安）
  try { marketcap.start(); } catch(e){ console.error('[MCAP]', e?.message||e); }
});
