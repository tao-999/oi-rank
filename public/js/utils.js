// ===== 工具函数（公共） =====
export const el = (id) => document.getElementById(id);
export const fmt = (n, d = 6) => Number(n).toLocaleString(undefined, { maximumFractionDigits: d });
export const fmtM$ = (usd) => Number.isFinite(usd) ? ('$' + (usd / 1e6).toFixed(2) + 'M') : '-';

// ===== 关注（收藏）持久化 =====
const FAV_KEY = 'favSymbolsV1';

function _loadFavArray() {
  try {
    const raw = localStorage.getItem(FAV_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function _saveFavArray(arr) {
  try { localStorage.setItem(FAV_KEY, JSON.stringify(arr)); } catch {}
}

export function loadFavSet() {
  return new Set(_loadFavArray().map(s => String(s).toUpperCase()));
}

export function toggleFav(sym) {
  const up = String(sym).toUpperCase();
  const set = loadFavSet();
  if (set.has(up)) set.delete(up); else set.add(up);
  _saveFavArray(Array.from(set));
  return set.has(up);
}

export function isFav(sym) {
  const set = loadFavSet();
  return set.has(String(sym).toUpperCase());
}
