// public/js/predictor.js
// 盘口 / 成交 / OI 组合预测：是否存在拉盘 / 砸盘行为

const DEFAULT_OPTIONS = {
  // 统计窗口：最近 30 秒的行为来判断是否在拉 / 砸
  windowMs: 30_000,

  // 价格涨跌幅阈值
  priceStrongPump: 0.006,  // +0.6%
  priceWeakPump:   0.002,  // +0.2%

  // OI 变化阈值（相对变化）
  oiStrongUp:   0.01,   // +1%
  oiWeakUp:     0.003,  // +0.3%
  oiStrongDown: -0.01,  // -1%
};

/**
 * 创建一个拉盘/砸盘预测器实例。
 *
 * 用法：
 *  const predictor = createPredictor();
 *  predictor.pushSnapshot({ t: Date.now(), price, oi }); // oi 用名义持仓 USD
 *  predictor.pushTrade({ t: Date.now(), side:'buy', quote, price }); // quote 成交额 USDT
 *  const sig = predictor.getSignal();
 */
export function createPredictor(userOptions = {}) {
  const opt = { ...DEFAULT_OPTIONS, ...userOptions };

  let snapshots = []; // { t, price, oi }
  let trades    = []; // { t, side, quote, price }

  function trim(now) {
    const cutoff = now - opt.windowMs;
    snapshots = snapshots.filter(s => s && s.t >= cutoff);
    trades    = trades.filter(tr => tr && tr.t >= cutoff);
  }

  function pushSnapshot(s) {
    if (!s || !Number.isFinite(s.t)) return;
    const t = Number(s.t);
    snapshots.push({
      t,
      price: Number(s.price) || 0,
      oi   : Number(s.oi)    || 0      // oi = 名义持仓 USD
    });
    trim(t);
  }

  function pushTrade(tr) {
    if (!tr || !Number.isFinite(tr.t)) return;
    const t = Number(tr.t);
    trades.push({
      t,
      side : tr.side === 'sell' ? 'sell' : 'buy',
      quote: Number(tr.quote) || 0,    // 成交额 USDT
      price: Number(tr.price) || 0
    });
    trim(t);
  }

  function reset() {
    snapshots = [];
    trades    = [];
  }

  function getSignal() {
    if (snapshots.length < 2) {
      return {
        type: 'none',
        score: 0,
        label: '无明显信号',
        reasons: ['数据不足'],
        priceChangePct: 0,
        oiChangePct: 0,
        bigBuyCount: 0,
        bigSellCount: 0,
        windowMs: opt.windowMs,
        tEnd: snapshots[0]?.t ?? null,
        bigThreshold: null
      };
    }

    const snapsSorted = snapshots.slice().sort((a,b)=>a.t-b.t);
    const s0 = snapsSorted[0];
    const s1 = snapsSorted[snapsSorted.length-1];

    const price0 = s0.price || 0;
    const price1 = s1.price || 0;
    const oi0    = s0.oi    || 0;
    const oi1    = s1.oi    || 0;

    const priceChangePct = price0 > 0 ? (price1 - price0) / price0 : 0;
    const oiChangePct    = oi0    > 0 ? (oi1    - oi0)    / oi0    : 0;

    // ===== 大单阈值：按“当前持仓量档位”来定 =====
    // oiRef = 当前窗口末尾的持仓名义（USD）
    const oiRef = oi1 > 0 ? oi1 : Math.max(oi0, oi1);

    // 1 WU = 1,000,000 USDT
    // < 1e8       -> 1 WU+
    // 1e8~1e10    -> 5 WU+
    // >= 1e10     -> 20 WU+
    let bigThreshold;
    if (!Number.isFinite(oiRef) || oiRef <= 0) {
      bigThreshold = Infinity; // 没有参考持仓，等于关掉“大单检测”
    } else if (oiRef < 1e8) {
      bigThreshold = 1e6;      // 1 WU
    } else if (oiRef < 1e10) {
      bigThreshold = 5e6;      // 5 WU
    } else {
      bigThreshold = 2e7;      // 20 WU
    }

    // 统计窗口内的大额成交（按成交额/名义成交 USDT）
    let bigBuyCount  = 0;
    let bigSellCount = 0;
    let bigTrades    = 0;

    if (Number.isFinite(bigThreshold) && bigThreshold > 0) {
      for (const tr of trades) {
        if (!tr) continue;
        if (!Number.isFinite(tr.quote)) continue;
        if (tr.quote >= bigThreshold) {
          bigTrades++;
          if (tr.side === 'buy') bigBuyCount++;
          else bigSellCount++;
        }
      }
    }

    const reasons = [];
    let type  = 'none';
    let score = 0;

    // ===== 上涨方向：拉盘类 =====

    // 1. 强力多头拉盘：价格强涨 + 多个大额买单 + OI 强烈上升
    if (
      priceChangePct >= opt.priceStrongPump &&
      bigBuyCount    >= 3 &&
      oiChangePct    >= opt.oiStrongUp
    ) {
      type  = 'strong_long';
      score = Math.min(
        100,
        70
        + Math.abs(priceChangePct) * 2000
        + Math.max(0, oiChangePct) * 1500
        + (bigBuyCount - 3) * 5
      );
      reasons.push(
        `价格在窗口内上涨 ${(priceChangePct*100).toFixed(2)}%`,
        `名义持仓在窗口内上涨 ${(oiChangePct*100).toFixed(2)}%`,
        `出现 ${bigBuyCount} 笔大额买单（≥ ${bigThreshold.toFixed(0)} USDT），疑似多头主动扫盘拉升`
      );
    }

    // 2. 爆仓拉升：价格强涨 + 大额买单 + OI 明显下降（空头被强平）
    else if (
      priceChangePct >= opt.priceStrongPump &&
      bigBuyCount    >= 3 &&
      oiChangePct    <= opt.oiStrongDown
    ) {
      type  = 'liq_pump';
      score = Math.min(
        100,
        60
        + Math.abs(priceChangePct) * 1500
        + Math.abs(oiChangePct)   * 1200
      );
      reasons.push(
        `价格在窗口内上涨 ${(priceChangePct*100).toFixed(2)}%`,
        `名义持仓在窗口内下降 ${(oiChangePct*100).toFixed(2)}%`,
        `出现 ${bigBuyCount} 笔大额买单（≥ ${bigThreshold.toFixed(0)} USDT），疑似空头爆仓导致的被动拉升`
      );
    }

    // 3. 对敲拉盘：价格上涨 + 大额成交很多 + OI 基本不变
    else if (
      priceChangePct >= opt.priceWeakPump &&
      bigTrades      >= 3 &&
      Math.abs(oiChangePct) < 0.002
    ) {
      type  = 'wash_pump';
      score = Math.min(
        100,
        50
        + Math.abs(priceChangePct) * 1000
        + bigTrades * 3
      );
      reasons.push(
        `价格在窗口内上涨 ${(priceChangePct*100).toFixed(2)}%`,
        `累计出现 ${bigTrades} 笔大额成交（≥ ${bigThreshold.toFixed(0)} USDT），但名义持仓变化仅 ${(oiChangePct*100).toFixed(3)}%`,
        `更像是对敲推价 / 挂图，而非真实新增仓位`
      );
    }

    // 4. 吸筹上升：价格小幅抬升 + OI 缓慢上涨 + 偶发大额买单
    else if (
      priceChangePct >= opt.priceWeakPump &&
      oiChangePct    >= opt.oiWeakUp &&
      (bigBuyCount   >= 1 || trades.length >= 5)
    ) {
      type  = 'accumulation';
      score = Math.min(
        100,
        40
        + Math.abs(priceChangePct) * 1200
        + Math.max(0, oiChangePct) * 1200
      );
      reasons.push(
        `价格在窗口内小幅上涨 ${(priceChangePct*100).toFixed(2)}%`,
        `名义持仓在窗口内上涨 ${(oiChangePct*100).toFixed(2)}%`,
        bigBuyCount >= 1
          ? `出现 ${bigBuyCount} 笔大额买单（≥ ${bigThreshold.toFixed(0)} USDT），疑似低位吸筹建仓`
          : `成交活跃但无明显巨单，多为空间内缓慢建仓`
      );
    }

    // ===== 下跌方向：砸盘类 =====

    // 5. 强力砸盘：价格强跌 + 多个大额卖单 + OI 强烈上升（主动建空）
    else if (
      priceChangePct <= -opt.priceStrongPump &&
      bigSellCount   >= 3 &&
      oiChangePct    >= opt.oiStrongUp
    ) {
      type  = 'strong_short';
      score = Math.min(
        100,
        70
        + Math.abs(priceChangePct) * 2000
        + Math.max(0, oiChangePct) * 1500
        + (bigSellCount - 3) * 5
      );
      reasons.push(
        `价格在窗口内下跌 ${(priceChangePct*100).toFixed(2)}%`,
        `名义持仓在窗口内上涨 ${(oiChangePct*100).toFixed(2)}%`,
        `出现 ${bigSellCount} 笔大额卖单（≥ ${bigThreshold.toFixed(0)} USDT），疑似主动砸盘+建空`
      );
    }

    // 6. 多头爆仓：价格强跌 + 大额卖单 + OI 明显下降
    else if (
      priceChangePct <= -opt.priceStrongPump &&
      bigSellCount   >= 3 &&
      oiChangePct    <= opt.oiStrongDown
    ) {
      type  = 'liq_dump';
      score = Math.min(
        100,
        60
        + Math.abs(priceChangePct) * 1500
        + Math.abs(oiChangePct)   * 1200
      );
      reasons.push(
        `价格在窗口内下跌 ${(priceChangePct*100).toFixed(2)}%`,
        `名义持仓在窗口内下降 ${(oiChangePct*100).toFixed(2)}%`,
        `出现 ${bigSellCount} 笔大额卖单（≥ ${bigThreshold.toFixed(0)} USDT），疑似多头爆仓引发踩踏`
      );
    }

    // 7. 对敲砸盘：价格下跌 + 大额成交很多 + OI 基本不变
    else if (
      priceChangePct <= -opt.priceWeakPump &&
      bigTrades      >= 3 &&
      Math.abs(oiChangePct) < 0.002
    ) {
      type  = 'wash_dump';
      score = Math.min(
        100,
        50
        + Math.abs(priceChangePct) * 1000
        + bigTrades * 3
      );
      reasons.push(
        `价格在窗口内下跌 ${(priceChangePct*100).toFixed(2)}%`,
        `累计出现 ${bigTrades} 笔大额成交（≥ ${bigThreshold.toFixed(0)} USDT），但名义持仓变化仅 ${(oiChangePct*100).toFixed(3)}%`,
        `更像是对敲砸价 / 挂图，而非真实减仓`
      );
    }

    // 8. 派发型下跌：价格小幅走弱 + OI 缓慢上升 + 卖单主导
    else if (
      priceChangePct <= -opt.priceWeakPump &&
      oiChangePct    >= opt.oiWeakUp &&
      (bigSellCount  >= 1 || trades.length >= 5)
    ) {
      type  = 'distribution';
      score = Math.min(
        100,
        40
        + Math.abs(priceChangePct) * 1200
        + Math.max(0, oiChangePct) * 1200
      );
      reasons.push(
        `价格在窗口内小幅下跌 ${(priceChangePct*100).toFixed(2)}%`,
        `名义持仓在窗口内上涨 ${(oiChangePct*100).toFixed(2)}%`,
        bigSellCount >= 1
          ? `出现 ${bigSellCount} 笔大额卖单（≥ ${bigThreshold.toFixed(0)} USDT），疑似高位派发 / 建空`
          : `成交活跃但由卖方主导，多为空间内缓慢派发`
      );
    }

    // 9. 无结构
    else {
      type  = 'none';
      score = 0;
      reasons.push(
        `价格变化 ${(priceChangePct*100).toFixed(2)}%，名义持仓变化 ${(oiChangePct*100).toFixed(2)}%，无明显大额单结构（阈值 ${Number.isFinite(bigThreshold)?bigThreshold.toFixed(0):'N/A'} USDT）`
      );
    }

    let label = '无明显信号';
    if (type === 'strong_long')   label = '强力多头拉盘';
    if (type === 'liq_pump')      label = '空头爆仓拉升';
    if (type === 'wash_pump')     label = '对敲式拉盘';
    if (type === 'accumulation')  label = '疑似吸筹阶段';
    if (type === 'strong_short')  label = '强力砸盘建空';
    if (type === 'liq_dump')      label = '多头爆仓下杀';
    if (type === 'wash_dump')     label = '对敲式砸盘';
    if (type === 'distribution')  label = '疑似派发阶段';

    return {
      type,
      score,
      label,
      reasons,
      priceChangePct,
      oiChangePct,
      bigBuyCount,
      bigSellCount,
      windowMs: opt.windowMs,
      tEnd: s1.t,
      bigThreshold
    };
  }

  return {
    pushSnapshot,
    pushTrade,
    getSignal,
    reset
  };
}
