import type {
  OptionsChain,
  Strategy,
  Tier1FilterConfig,
  TickerMetrics,
  TradierOptionContract,
} from "./types";
import {
  calculateIVR,
  calculateImpliedMove,
  calculatePoP,
  calculateGammaThetaRatio,
  calculateScore,
  calculateLiquidityScore,
  extractATMIV,
} from "./metrics";

// ─── Defaults ─────────────────────────────────────────────────────────────────

export const DEFAULT_FILTER_CONFIG: Tier1FilterConfig = {
  minIVR: 30,
  minIV30: 0.20,        // 20% annualised IV
  minAvgDailyVolume: 500_000,
  minOptionOI: 100,
  minDaysToExpiry: 21,
  maxDaysToExpiry: 45,
};

// Looser thresholds for mid-cap / niche names with lower average daily volume
export const MID_CAP_FILTER_CONFIG: Tier1FilterConfig = {
  minIVR: 30,
  minIV30: 0.20,
  minAvgDailyVolume: 200_000,
  minOptionOI: 50,
  minDaysToExpiry: 21,
  maxDaysToExpiry: 45,
};

// ─── Tier-1 filters ───────────────────────────────────────────────────────────

export interface Tier1FilterResult {
  passed: boolean;
  reasons: string[];
}

/**
 * Hard gate: all conditions must pass for a symbol to proceed to scoring.
 */
export function applyTier1Filters(
  params: {
    ivRank: number;
    iv30: number;
    averageDailyVolume: number;
    maxOptionOI: number;
    daysToExpiry: number;
  },
  config: Tier1FilterConfig = DEFAULT_FILTER_CONFIG
): Tier1FilterResult {
  const reasons: string[] = [];

  if (params.ivRank < config.minIVR) {
    reasons.push(`IVR ${params.ivRank.toFixed(1)} < ${config.minIVR} (low premium environment)`);
  }

  if (params.iv30 < config.minIV30) {
    reasons.push(`IV30 ${(params.iv30 * 100).toFixed(1)}% < ${(config.minIV30 * 100).toFixed(0)}%`);
  }

  if (params.averageDailyVolume < config.minAvgDailyVolume) {
    reasons.push(
      `Avg vol ${params.averageDailyVolume.toLocaleString()} < ${config.minAvgDailyVolume.toLocaleString()}`
    );
  }

  if (params.maxOptionOI < config.minOptionOI) {
    reasons.push(`Max option OI ${params.maxOptionOI} < ${config.minOptionOI} (illiquid options)`);
  }

  if (params.daysToExpiry < config.minDaysToExpiry || params.daysToExpiry > config.maxDaysToExpiry) {
    reasons.push(
      `DTE ${params.daysToExpiry} outside window [${config.minDaysToExpiry}, ${config.maxDaysToExpiry}]`
    );
  }

  return { passed: reasons.length === 0, reasons };
}

// ─── Strategy selection ───────────────────────────────────────────────────────

export interface StrategySelection {
  strategy: Strategy;
  shortPut: TradierOptionContract | null;
  shortCall: TradierOptionContract | null;
  longPut: TradierOptionContract | null;
  longCall: TradierOptionContract | null;
  credit: number;
}

/**
 * Picks the most appropriate defined-risk strategy based on IVR + IV level.
 *
 * Decision tree:
 *   IVR ≥ 50 + IV30 ≥ 40%  →  short_strangle  (undefined risk, high premium)
 *   IVR ≥ 50               →  iron_condor      (defined risk)
 *   IVR ≥ 30 (mild bull)   →  cash_secured_put
 *   IVR ≥ 30 (neutral)     →  covered_call
 *   otherwise              →  skip
 */
export function selectStrategy(
  chain: OptionsChain,
  ivRank: number,
  iv30: number
): StrategySelection {
  const { options, underlyingPrice } = chain;

  const calls = options.filter((o) => o.option_type === "call");
  const puts  = options.filter((o) => o.option_type === "put");

  // Target ~16-delta short strikes (≈1σ OTM, PoP ~84%)
  const shortCall16 = findByTargetDelta(calls, 0.16);
  const shortPut16  = findByTargetDelta(puts,  -0.16);

  // Target ~30-delta for richer premium when IV is lower
  const shortCall30 = findByTargetDelta(calls, 0.30);
  const shortPut30  = findByTargetDelta(puts,  -0.30);

  if (ivRank >= 50 && iv30 >= 0.40) {
    // Short strangle — sell 16-delta strangle
    const sc = shortCall16;
    const sp = shortPut16;
    return {
      strategy: "short_strangle",
      shortCall: sc,
      shortPut: sp,
      longCall: null,
      longPut: null,
      credit: calcCredit([sc, sp]),
    };
  }

  if (ivRank >= 50) {
    // Iron condor — sell 16-delta, buy 5-delta for protection
    const sc = shortCall16;
    const sp = shortPut16;
    const lc = findByTargetDelta(calls, 0.05);
    const lp = findByTargetDelta(puts,  -0.05);
    return {
      strategy: "iron_condor",
      shortCall: sc,
      shortPut: sp,
      longCall: lc,
      longPut: lp,
      credit: calcCredit([sc, sp]) - calcDebit([lc, lp]),
    };
  }

  if (ivRank >= 30) {
    // Use 30-delta puts for better premium when IVR is moderate
    const sp = shortPut30;
    if (sp) {
      return {
        strategy: "cash_secured_put",
        shortPut: sp,
        shortCall: null,
        longPut: null,
        longCall: null,
        credit: calcCredit([sp]),
      };
    }

    const sc = shortCall30;
    if (sc) {
      return {
        strategy: "covered_call",
        shortCall: sc,
        shortPut: null,
        longPut: null,
        longCall: null,
        credit: calcCredit([sc]),
      };
    }
  }

  return {
    strategy: "skip",
    shortPut: null,
    shortCall: null,
    longPut: null,
    longCall: null,
    credit: 0,
  };
}

// ─── Full scanner pipeline for one ticker ────────────────────────────────────

export function buildTickerMetrics(
  chain: OptionsChain,
  iv52wHigh: number,
  iv52wLow: number,
  averageDailyVolume: number,
  config: Tier1FilterConfig = DEFAULT_FILTER_CONFIG
): TickerMetrics | null {
  const { symbol, underlyingPrice, daysToExpiry, expirationDate, options } = chain;

  const iv30 = extractATMIV(chain);
  const ivRank = calculateIVR(iv30, iv52wHigh, iv52wLow);

  const maxOptionOI = options.reduce((m, o) => Math.max(m, o.open_interest), 0);

  const filterResult = applyTier1Filters(
    { ivRank, iv30, averageDailyVolume, maxOptionOI, daysToExpiry },
    config
  );

  if (!filterResult.passed) return null;

  const { strategy, shortPut, shortCall, longPut, longCall, credit } =
    selectStrategy(chain, ivRank, iv30);

  if (strategy === "skip") return null;

  const pop = calculatePoP(
    strategy as Exclude<Strategy, "skip">,
    shortPut,
    shortCall
  );

  const gammaThetaRatio = calculateGammaThetaRatio([shortPut, shortCall]);

  const impliedMove = calculateImpliedMove(chain);

  const liquidityContracts = [shortPut, shortCall].filter(
    (c): c is TradierOptionContract => c !== null
  );
  const optionLiquidity = calculateLiquidityScore(liquidityContracts);

  const score = calculateScore({
    ivRank,
    pop,
    impliedMove,
    gammaThetaRatio,
    daysToExpiry,
    optionLiquidity,
  });

  return {
    symbol,
    underlyingPrice,
    iv30,
    iv52wHigh,
    iv52wLow,
    ivRank,
    pop,
    impliedMove,
    gammaThetaRatio,
    score,
    strategy,
    expirationDate,
    daysToExpiry,
    shortPutStrike: shortPut?.strike,
    shortCallStrike: shortCall?.strike,
    longPutStrike: longPut?.strike,
    longCallStrike: longCall?.strike,
    credit,
    averageDailyVolume,
    optionLiquidity,
  };
}

// ─── Private helpers ──────────────────────────────────────────────────────────

function findByTargetDelta(
  contracts: TradierOptionContract[],
  targetDelta: number
): TradierOptionContract | null {
  const withGreeks = contracts.filter((c) => c.greeks?.delta != null);
  if (withGreeks.length === 0) return null;

  return withGreeks.reduce((best, c) => {
    const dBest = Math.abs((best.greeks?.delta ?? 0) - targetDelta);
    const dCurr = Math.abs((c.greeks?.delta    ?? 0) - targetDelta);
    return dCurr < dBest ? c : best;
  });
}

function calcCredit(contracts: (TradierOptionContract | null)[]): number {
  return contracts.reduce((sum, c) => {
    if (!c) return sum;
    return sum + (c.bid + c.ask) / 2;
  }, 0);
}

function calcDebit(contracts: (TradierOptionContract | null)[]): number {
  return contracts.reduce((sum, c) => {
    if (!c) return sum;
    return sum + (c.bid + c.ask) / 2;
  }, 0);
}
