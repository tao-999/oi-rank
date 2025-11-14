// src/ws.js
const WebSocket = require('ws');
const { BOOK } = require('./store');

// 由外部（比如 binance.js）注册，用来处理前端发来的控制消息
let onClientMsg = null;

let wss = null;

function buildInitSnapshot() {
  const map = {};
  for (const [sym, row] of BOOK.entries()) {
    map[sym] = {
      p: row.markPrice,
      r: row.fundingRate,
      u: row.updatedAt || row.time
    };
  }
  return map;
}

function attach(server) {
  wss = new WebSocket.Server({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    // 初次连接：推一份价格/资金费率快照
    ws.send(JSON.stringify({ t: 'init', rows: buildInitSnapshot() }));

    // 接收前端控制消息（如 subTrades）
    ws.on('message', (buf) => {
      try {
        const msg = JSON.parse(buf.toString());
        if (onClientMsg) {
          onClientMsg(msg, ws);
        }
      } catch {
        // ignore
      }
    });
  });
}

function broadcast(payload) {
  if (!wss) return;
  const msg = JSON.stringify(payload);
  for (const c of wss.clients) {
    if (c.readyState === WebSocket.OPEN) {
      c.send(msg);
    }
  }
}

// 价格/资金费率增量
function broadcastDelta(rows) {
  if (!rows || !rows.length) return;
  broadcast({ t: 'delta', rows });
}

// 成交单增量
function broadcastTrades(rows) {
  if (!rows || !rows.length) return;
  broadcast({ t: 'trades', rows });
}

// 由业务模块注册客户端消息处理函数
function setClientMsgHandler(fn) {
  onClientMsg = (typeof fn === 'function') ? fn : null;
}

module.exports = {
  attach,
  broadcastDelta,
  broadcastTrades,
  setClientMsgHandler,
};
