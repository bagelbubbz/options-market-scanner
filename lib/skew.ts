import type { OptionsChain, TradierOptionContract } from "./types";

export interface SkewReading {
  symbol: string;
  skew25d: number;       // put25dIV - call25dIV (positive = fear premium in puts)
  put25dIV: number;
  call25dIV: number;
  skewZScore: number;    // z-score vs 30-day rolling mean (populated after DB lookup)
  alertTriggered: boolean;
  timestamp: string;
}

export interface SkewSnapshot {
  id?: string;
  symbol: string;
  skew_25d: number;
  put_25d_iv: number;
  call_25d_iv: number;
  skew_z_score: number;
  alert_triggered: boolean;
  snapped_at: string;
}

// ─── Core calculation ─────────────────────────────────────────────────────────

/**
 * Extracts the 25-delta skew from an options chain.
 *
 * Skew = IV(25-delta put) - IV(25-delta call)
 * Positive value means puts are pricier (fear / downside hedging premium).
 * A spike signals institutional positioning or tail-risk concern.
 */
export function calculateSkew25d(chain: OptionsChain): {
  skew25d: number;
  put25dIV: number;
  call25dIV: number;
} {
  const puts  = chain.options.filter((o) => o.option_type === "put"  && o.greeks?.mid_iv);
  const calls = chain.options.filter((o) => o.option_type === "call" && o.greeks?.mid_iv);

  const put25  = findByTargetDelta(puts,  -0.25);
  const call25 = findByTargetDelta(calls,  0.25);

  const put25dIV  = put25?.greeks?.mid_iv  ?? 0;
  const call25dIV = call25?.greeks?.mid_iv ?? 0;

  return {
    skew25d:   put25dIV - call25dIV,
    put25dIV,
    call25dIV,
  };
}

function findByTargetDelta(
  contracts: TradierOptionContract[],
  targetDelta: number
): TradierOptionContract | null {
  if (contracts.length === 0) return null;
  return contracts.reduce((best, c) => {
    const dBest = Math.abs((best.greeks?.delta ?? 0) - targetDelta);
    const dCurr = Math.abs((c.greeks?.delta    ?? 0) - targetDelta);
    return dCurr < dBest ? c : best;
  });
}

// ─── Z-score against recent history ──────────────────────────────────────────

/**
 * Computes the z-score of a new skew reading against a series of prior readings.
 * A z-score > 2 means the current skew is unusually elevated (2σ above mean).
 */
export function computeSkewZScore(
  currentSkew: number,
  historicalSkews: number[]
): number {
  if (historicalSkews.length < 5) return 0;

  const mean =
    historicalSkews.reduce((s, v) => s + v, 0) / historicalSkews.length;

  const variance =
    historicalSkews.reduce((s, v) => s + (v - mean) ** 2, 0) /
    (historicalSkews.length - 1);

  const std = Math.sqrt(variance);
  if (std === 0) return 0;

  return (currentSkew - mean) / std;
}

// Z-score threshold above which an alert fires
export const SKEW_ALERT_THRESHOLD = 2.0;

export function shouldAlert(zScore: number): boolean {
  return Math.abs(zScore) >= SKEW_ALERT_THRESHOLD;
}

// ─── Snapshot builder ─────────────────────────────────────────────────────────

export function buildSkewSnapshot(
  symbol: string,
  skew25d: number,
  put25dIV: number,
  call25dIV: number,
  zScore: number
): SkewSnapshot {
  return {
    symbol,
    skew_25d:       skew25d,
    put_25d_iv:     put25dIV,
    call_25d_iv:    call25dIV,
    skew_z_score:   zScore,
    alert_triggered: shouldAlert(zScore),
    snapped_at:     new Date().toISOString(),
  };
}
