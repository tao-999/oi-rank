// —— WS 客户端（初始化/增量）—— //
export function createWS(onInit, onDelta){
  let ws=null;
  function connect(){
    try{ if(ws) ws.close(); }catch{}
    const proto = location.protocol==='https:'?'wss:':'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws`);
    ws.onmessage = (ev)=>{
      try{
        const msg = JSON.parse(ev.data);
        if (msg.t==='init'){ onInit(msg.rows||{}); }
        else if (msg.t==='delta'){ onDelta(msg.rows||[]); }
      }catch{}
    };
    ws.onclose = ()=> setTimeout(connect, 1500);
  }
  connect();
}
