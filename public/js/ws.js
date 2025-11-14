// public/js/ws.js

// —— WS 客户端（初始化 / 增量 / 成交单）—— //
export function createWS(onInit, onDelta, onTrades) {
  let ws = null;
  let pendingSymbol = null;   // 还没连上时记住要订阅的 symbol

  function sendSubTrades(symbol) {
    if (!symbol) return;
    pendingSymbol = symbol;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ t: 'subTrades', symbol }));
      } catch {}
    }
  }

  function connect() {
    try { if (ws) ws.close(); } catch {}

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws`);

    ws.onopen = () => {
      // 如果在没连上之前已经调用过 subTrades，这里补发一次
      if (pendingSymbol) {
        try {
          ws.send(JSON.stringify({ t: 'subTrades', symbol: pendingSymbol }));
        } catch {}
      }
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.t === 'init') {
          onInit && onInit(msg.rows || {});
        } else if (msg.t === 'delta') {
          onDelta && onDelta(msg.rows || []);
        } else if (msg.t === 'trades') {
          onTrades && onTrades(msg.rows || []);
        }
      } catch (e) {
        // ignore
      }
    };

    ws.onclose = () => {
      setTimeout(connect, 1500);
    };
  }

  connect();

  // 返回一个小对象，让外面可以调用 subTrades
  return {
    subTrades: sendSubTrades,
  };
}
