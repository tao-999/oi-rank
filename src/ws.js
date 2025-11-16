// src/ws.js
const WebSocket = require('ws');
const { BOOK } = require('./store');

let onClientMsg = null;
let wss = null;

// 初次连接快照
function buildInitSnapshot(){
  const map = {};
  for (const [sym, row] of BOOK.entries()){
    map[sym] = {
      p: row.markPrice,
      r: row.fundingRate,
      u: row.updatedAt || row.time
    };
  }
  return map;
}

function attach(server){
  wss = new WebSocket.Server({ server, path: '/ws' });

  wss.on('connection', (ws)=>{
    // 初次发快照
    ws.send(JSON.stringify({ t: 'init', rows: buildInitSnapshot() }));

    ws.on('message', buf=>{
      try{
        const msg = JSON.parse(buf.toString());
        if (onClientMsg) onClientMsg(msg, ws);
      }catch{}
    });

    // 防御性：避免某些 ws 错误把服务搞崩
    ws.on('error', err=>{
      console.warn('client ws error:', err && err.message);
    });
  });
}

// 广播通用
function broadcast(payload){
  if (!wss) return;
  const msg = JSON.stringify(payload);
  for (const c of wss.clients){
    if (c.readyState === WebSocket.OPEN){
      c.send(msg);
    }
  }
}

// 价格/资金费率增量
function broadcastDelta(rows){
  if (!rows || !rows.length) return;
  broadcast({ t: 'delta', rows });
}

// 成交单增量
function broadcastTrades(rows){
  if (!rows || !rows.length) return;
  broadcast({ t: 'trades', rows });
}

// 注册客户端消息处理（如 subTrades）
function setClientMsgHandler(fn){
  onClientMsg = (typeof fn === 'function') ? fn : null;
}

module.exports = {
  attach,
  broadcast,
  broadcastDelta,
  broadcastTrades,
  setClientMsgHandler
};
