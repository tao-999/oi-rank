// src/http.js
const http = require('http');
const fs   = require('fs').promises;
const path = require('path');
const { PUBLIC_DIR } = require('./config');

const { progress, oiRank, history } = require('./routes/api');

require('./ws'); // 初始化 WS server holder

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js'  : 'application/javascript; charset=utf-8',
  '.css' : 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png' : 'image/png',
  '.svg' : 'image/svg+xml'
};

function serveStatic(res, filePath){
  fs.readFile(filePath).then(buf=>{
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
    });
    res.end(buf);
  }).catch(()=>{
    res.writeHead(404, { 'Content-Type':'text/plain; charset=utf-8' });
    res.end('Not Found');
  });
}

function createServer(){
  const server = http.createServer(async (req, res)=>{
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS'){
      res.writeHead(204);
      return res.end();
    }

    const urlObj   = new URL(req.url, `http://${req.headers.host}`);
    const pathname = urlObj.pathname;

    // ===== API 路由 =====
    if (pathname === '/api/progress') return progress(req, res);
    if (pathname === '/api/oi-rank')  return oiRank(req, res);
    if (pathname === '/api/history')  return history(req, res, urlObj);

    // ===== health check =====
    if (pathname === '/health'){
      res.writeHead(200, { 'Content-Type':'text/plain' });
      return res.end('ok');
    }

    // ===== 静态文件 =====
    if (pathname === '/' || pathname === ''){
      return serveStatic(res, path.join(PUBLIC_DIR, 'index.html'));
    }
    return serveStatic(res, path.join(PUBLIC_DIR, pathname.replace(/^\/+/, '')));
  });

  // 供 ws.js 注入 server（不要动）
  require('./ws').attach(server);

  return server;
}

module.exports = { createServer };
