// src/routes/api.js
const {
  BOOK,
  SYMBOLS,
  OI_PROGRESS,
  BOOT_READY,
  readHistoryMerged,
  now,
  getMCAP,
} = require('../store');
const { normalizeBase } = require('../services/marketcap');

function baseFromPerp(sym) {
  if (!sym) return null;
  if (sym.endsWith('USDT')) {
    const raw = sym.slice(0, -4);
    return normalizeBase(raw);
  }
  return normalizeBase(sym);
}

async function progress(req, res) {
  const total = (SYMBOLS().length) || OI_PROGRESS.total || 0;
  const done  = OI_PROGRESS.done;

  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({
    ts: now(),
    bootReady: BOOT_READY(),
    total,
    done,
    ratio: total ? done / total : (BOOT_READY() ? 1 : 0),
  }));
}

async function oiRank(req, res) {
  const mcap = getMCAP();

  const rows = SYMBOLS().map(sym => {
    const r = BOOK.get(sym) || {
      symbol: sym,
      markPrice: NaN,
      fundingRate: null,
      openInterest: NaN,
      notionalUSD: NaN,
      time: null,
      updatedAt: null,
    };
    const base = baseFromPerp(r.symbol);
    const cap  = base ? mcap.get(base) : undefined;
    return {
      ...r,
      marketCapUSD: Number.isFinite(cap) ? cap : undefined,
    };
  });

  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({
    ts: now(),
    total: SYMBOLS().length,
    count: rows.length,
    rows,
  }));
}

async function history(req, res, urlObj) {
  const sym = (urlObj.searchParams.get('symbol') || '').toUpperCase().trim();
  if (!sym) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'bad symbol' }));
  }

  const limit = Math.min(Number(urlObj.searchParams.get('limit') || 1200), 20000);
  const from  = Number(urlObj.searchParams.get('from') || 0);
  const to    = Number(urlObj.searchParams.get('to') || 0);

  let arr = await readHistoryMerged(sym);
  if (from || to) {
    arr = arr.filter(s =>
      (from ? s.t >= from : true) &&
      (to   ? s.t <= to   : true)
    );
  }
  if (arr.length > limit) {
    arr = arr.slice(arr.length - limit);
  }

  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({
    symbol: sym,
    count: arr.length,
    samples: arr,
  }));
}

async function trend(req, res, urlObj) {
  const winsStr = (urlObj.searchParams.get('wins') || '1h,4h,24h').trim();

  const parseWin = (w) => {
    const m = String(w).trim().match(/^(\d+)\s*(m|h|d|w)$/i);
    if (!m) return null;
    const n = Number(m[1]);
    const u = m[2].toLowerCase();
    const mult =
      u === 'm' ? 60000 :
      u === 'h' ? 3600000 :
      u === 'd' ? 86400000 :
      7 * 86400000;
    return n * mult;
  };

  const winList = winsStr
    .split(',')
    .map(s => s.trim())
    .map(parseWin)
    .filter(Boolean);

  const nowTs = now();
  const result = {};

  for (const sym of SYMBOLS()) {
    let arr = await readHistoryMerged(sym);
    if (!arr.length) continue;

    let last = null;
    for (let i = arr.length - 1; i >= 0; i--) {
      if (Number.isFinite(arr[i].nu)) { last = arr[i]; break; }
    }
    if (!last) continue;

    const winsObj = {};
    for (const w of winList) {
      const cut = nowTs - w;
      let base = null;
      for (let i = 0; i < arr.length; i++) {
        const s = arr[i];
        if (s.t >= cut && Number.isFinite(s.nu)) { base = s; break; }
      }
      if (!base) {
        winsObj[w] = null;
        continue;
      }
      const delta = last.nu - base.nu;
      const pct   = base.nu ? (delta / base.nu) : null;
      winsObj[w]  = { baseT: base.t, lastT: last.t, delta, pct };
    }

    result[sym] = { last: { t: last.t, nu: last.nu }, wins: winsObj };
  }

  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ts: nowTs, wins: winList, data: result }));
}

module.exports = {
  progress,
  oiRank,
  history,
  trend,
};
