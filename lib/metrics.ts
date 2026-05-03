import type { TradierOptionContract, OptionsChain } from "./types";

// ─── IV Rank ──────────────────────────────────────────────────────────────────

/**
 * IVR = (currentIV - 52w low IV) / (52w high IV - 52w low IV) × 100
 *
 * @param currentIV  Current 30-day implied volatility (decimal, e.g. 0.35)
 * @param iv52wHigh  52-week high IV (decimal)
 * @param iv52wLow   52-week low IV (decimal)
 * @returns          IVR 0-100; returns 0 when the range collapses
 */
export function calculateIVR(
  currentIV: number,
  iv52wHigh: number,
  iv52wLow: number
): number {
  const range = iv52wHigh - iv52wLow;
  if (range <= 0) return 0;
  const ivr = ((currentIV - iv52wLow) / range) * 100;
  return Math.min(100, Math.max(0, ivr));
}

// ─── Implied Move ─────────────────────────────────────────────────────────────

/**
 * Market-implied ±move to expiry, expressed as a fraction (e.g. 0.05 = ±5%).
 *
 * Uses the classic 1-standard-deviation approximation:
 *   move ≈ ATM straddle mid-price / underlying price
 *
 * Falls back to the Black-Scholes approximation when a clean straddle is unavailable:
 *   move ≈ IV × √(DTE / 365)
 */
export function calculateImpliedMove(
  chain: OptionsChain
): number {
  const { underlyingPrice, options, daysToExpiry } = chain;

  // Find the ATM call and put closest to the current price
  const calls = options.filter((o) => o.option_type === "call");
  const puts  = options.filter((o) => o.option_type === "put");

  const atmCall = findATM(calls, underlyingPrice);
  const atmPut  = findATM(puts,  underlyingPrice);

  if (atmCall && atmPut) {
    const callMid = (atmCall.bid + atmCall.ask) / 2;
    const putMid  = (atmPut.bid  + atmPut.ask)  / 2;
    const straddlePrice = callMid + putMid;
    if (straddlePrice > 0 && underlyingPrice > 0) {
      return straddlePrice / underlyingPrice;
    }
  }

  // Fallback: IV-based approximation
  const atmIV = atmCall?.greeks?.mid_iv ?? atmPut?.greeks?.mid_iv ?? 0;
  if (atmIV > 0 && daysToExpiry > 0) {
    return atmIV * Math.sqrt(daysToExpiry / 365);
  }

  return 0;
}

function findATM(
  contracts: TradierOptionContract[],
  underlyingPrice: number
): TradierOptionContract | null {
  if (contracts.length === 0) return null;
  return contracts.reduce((best, c) =>
    Math.abs(c.strike - underlyingPrice) < Math.abs(best.strike - underlyingPrice)
      ? c
      : best
  );
}

// ─── Probability of Profit ────────────────────────────────────────────────────

/**
 * PoP for common premium-selling structures, expressed as 0-100.
 *
 * - short_strangle / iron_condor:  avg(1-|Δ call|, 1-|Δ put|) for short strikes
 * - cash_secured_put / covered_call: 1-|Δ| for the single short strike
 *
 * Falls back to a credit-based approximation when Greeks are absent.
 */
export function calculatePoP(
  strategy: "short_strangle" | "iron_condor" | "cash_secured_put" | "covered_call",
  shortPut: TradierOptionContract | null,
  shortCall: TradierOptionContract | null
): number {
  switch (strategy) {
    case "short_strangle":
    case "iron_condor": {
      const putPoP  = popFromContract(shortPut);
      const callPoP = popFromContract(shortCall);
      if (putPoP !== null && callPoP !== null) {
        return (putPoP + callPoP) / 2;
      }
      return putPoP ?? callPoP ?? 50;
    }
    case "cash_secured_put":
      return popFromContract(shortPut) ?? 50;
    case "covered_call":
      return popFromContract(shortCall) ?? 50;
  }
}

function popFromContract(contract: TradierOptionContract | null): number | null {
  if (!contract) return null;

  const delta = contract.greeks?.delta;
  if (delta != null) {
    // For a short put:  PoP ≈ 1 - |Δ|  (complement of assignment probability)
    // For a short call: PoP ≈ 1 - |Δ|
    return Math.max(0, Math.min(100, (1 - Math.abs(delta)) * 100));
  }

  // Credit-based fallback: PoP ≈ 1 - (mid / strike)
  const mid = (contract.bid + contract.ask) / 2;
  if (mid > 0 && contract.strike > 0) {
    return Math.max(0, Math.min(100, (1 - mid / contract.strike) * 100));
  }

  return null;
}

// ─── Gamma / Theta ratio ──────────────────────────────────────────────────────

/**
 * For premium-selling we want low gamma risk relative to theta decay collected.
 * Ratio = |gamma| / |theta|; lower is better.
 *
 * Computes across the provided short-leg contracts and averages them.
 */
export function calculateGammaThetaRatio(
  contracts: (TradierOptionContract | null)[]
): number {
  const valid = contracts.filter((c): c is TradierOptionContract => {
    return (
      c !== null &&
      c.greeks != null &&
      c.greeks.gamma !== 0 &&
      c.greeks.theta !== 0
    );
  });

  if (valid.length === 0) return 0;

  const ratios = valid.map((c) =>
    Math.abs(c.greeks!.gamma) / Math.abs(c.greeks!.theta)
  );

  return ratios.reduce((s, r) => s + r, 0) / ratios.length;
}

// ─── Composite score ──────────────────────────────────────────────────────────

export interface ScoreInputs {
  ivRank: number;        // 0-100
  pop: number;           // 0-100
  impliedMove: number;   // fraction (e.g. 0.05)
  gammaThetaRatio: number;
  daysToExpiry: number;
  optionLiquidity: number; // avg bid-ask spread tightness 0-1 (1 = tightest)
}

/**
 * Composite score 0-100.
 *
 * Weights (sum to 1.0):
 *   IVR              0.35  — elevated premium environment
 *   PoP              0.30  — probability of full profit
 *   DTE window       0.15  — prefer 30-45 DTE; penalise extremes
 *   Liquidity        0.10  — tighter spreads = better fills
 *   Gamma/Theta      0.10  — lower ratio preferred; score inverted
 */
export function calculateScore(inputs: ScoreInputs): number {
  const { ivRank, pop, impliedMove, gammaThetaRatio, daysToExpiry, optionLiquidity } = inputs;

  // IVR component (already 0-100)
  const ivrScore = ivRank;

  // PoP component (already 0-100)
  const popScore = pop;

  // DTE component — peak score at 30-45 DTE, falls off outside that band
  const dtePeak = 37.5;
  const dteScore = Math.max(
    0,
    100 - Math.abs(daysToExpiry - dtePeak) * 3
  );

  // Liquidity component (0-100)
  const liquidityScore = Math.min(100, optionLiquidity * 100);

  // Gamma/Theta component — lower ratio is better; normalise by a "good" threshold of 0.05
  const gtScore = gammaThetaRatio > 0
    ? Math.max(0, 100 - (gammaThetaRatio / 0.05) * 50)
    : 50;

  const score =
    ivrScore      * 0.35 +
    popScore      * 0.30 +
    dteScore      * 0.15 +
    liquidityScore * 0.10 +
    gtScore       * 0.10;

  // Implied-move modifier: very high expected move inflates premium but also risk;
  // dampen score slightly above 8%
  const movePenalty = impliedMove > 0.08 ? (impliedMove - 0.08) * 200 : 0;

  return Math.min(100, Math.max(0, score - movePenalty));
}

// ─── Liquidity helper ─────────────────────────────────────────────────────────

/**
 * Returns a 0-1 liquidity score based on bid-ask spread relative to mid-price.
 * 1.0 = perfectly tight (spread ≤ $0.01); 0 = extremely wide (spread ≥ mid).
 */
export function calculateLiquidityScore(contracts: TradierOptionContract[]): number {
  if (contracts.length === 0) return 0;

  const scores = contracts
    .filter((c) => c.bid > 0 && c.ask > 0)
    .map((c) => {
      const mid = (c.bid + c.ask) / 2;
      const spread = c.ask - c.bid;
      const relSpread = spread / mid;
      return Math.max(0, 1 - relSpread);
    });

  if (scores.length === 0) return 0;
  return scores.reduce((s, v) => s + v, 0) / scores.length;
}

// ─── ATM IV extraction ────────────────────────────────────────────────────────

/**
 * Extracts the ATM 30-day IV proxy from a chain.
 * Uses the mid_iv from the nearest ATM call greek.
 */
export function extractATMIV(chain: OptionsChain): number {
  const calls = chain.options.filter(
    (o) => o.option_type === "call" && o.greeks?.mid_iv
  );
  if (calls.length === 0) return 0;

  const atm = calls.reduce((best, c) =>
    Math.abs(c.strike - chain.underlyingPrice) <
    Math.abs(best.strike - chain.underlyingPrice)
      ? c
      : best
  );

  return atm.greeks?.mid_iv ?? 0;
}
