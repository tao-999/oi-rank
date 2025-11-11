const WebSocket = require('ws');

let wss=null;
function attach(server){
  wss = new WebSocket.Server({ server, path: '/ws' });
  const { BOOK, now } = require('./store');
  wss.on('connection', (client)=>{
    const init = {};
    for (const [sym, r] of BOOK.entries()){
      init[sym] = { p: r.markPrice, r: r.fundingRate, u: r.updatedAt || r.time };
    }
    client.send(JSON.stringify({ t:'init', ts: now(), rows: init }));
  });
}
function broadcastDelta(changed){
  if (!wss) return;
  const { now } = require('./store');
  const msg = JSON.stringify({ t:'delta', ts: now(), rows: changed });
  wss.clients.forEach(c=>{ if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

module.exports = { attach, broadcastDelta };
