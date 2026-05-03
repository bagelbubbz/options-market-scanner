import type { TradierHistoricalDay } from "./types";
import { computeHistoricalIV } from "./tiger";
import { calculateIVR } from "./metrics";

export type IVRBand = "30-50" | "50-70" | "70+";

export interface BacktestPeriod {
  entryDate: string;
  exitDate: string;
  entryPrice: number;
  exitPrice: number;
  ivrAtEntry: number;
  ivrBand: IVRBand;
  impliedMove: number;   // fraction: 1σ expected move
  actualMove: number;    // fraction: |exit/entry - 1|
  won: boolean;          // actual move stayed within implied move (premium seller wins)
  daysHeld: number;
}

export interface StrategyBacktestResult {
  symbol: string;
  ivrBand: IVRBand;
  winRate: number;        // 0-100
  avgImpliedMove: number; // fraction
  avgActualMove: number;  // fraction
  sampleSize: number;
  avgDte: number;
}

export interface BacktestDbRow {
  symbol: string;
  strategy: string;
  ivr_band: IVRBand;
  win_rate: number;
  avg_implied_move: number;
  avg_actual_move: number;
  sample_size: number;
  avg_dte: number;
  computed_at: string;
}

// ─── Simulation ───────────────────────────────────────────────────────────────

/**
 * Simulates rolling 30-45 DTE premium-selling entries over 1 year of daily data.
 *
 * Methodology:
 *   - Roll every 30 days.
 *   - At each entry date, compute the 30-day realised vol (as IV proxy).
 *   - Compute IVR from the 52-week rolling IV range.
 *   - Implied move = IV × √(DTE/365) for the holding period.
 *   - At exit (entry + 35 days), check if |exit/entry - 1| < implied_move.
 *   - Win = actual move stayed within the implied range.
 */
export function runBacktest(
  symbol: string,
  days: TradierHistoricalDay[],
  dte = 35
): BacktestPeriod[] {
  if (days.length < dte + 30) return [];

  // Precompute rolling 30-day IV
  const ivSeries = computeHistoricalIV(days, 30);
  const ivByDate = new Map(ivSeries.map((d) => [d.date, d.iv]));

  // Precompute 52-week (252-day) rolling IV range
  const periods: BacktestPeriod[] = [];

  for (let i = 30; i < days.length - dte; i += 30) {
    const entry = days[i];
    const exit  = days[Math.min(i + dte, days.length - 1)];

    const currentIV = ivByDate.get(entry.date) ?? 0;
    if (currentIV === 0) continue;

    // 252-day window ending at entry
    const windowStart = Math.max(0, i - 252);
    const windowIVs = days
      .slice(windowStart, i + 1)
      .map((d) => ivByDate.get(d.date))
      .filter((v): v is number => v != null);

    if (windowIVs.length < 10) continue;

    const iv52wHigh = Math.max(...windowIVs);
    const iv52wLow  = Math.min(...windowIVs);
    const ivrAtEntry = calculateIVR(currentIV, iv52wHigh, iv52wLow);

    const ivrBand = classifyIVRBand(ivrAtEntry);
    if (!ivrBand) continue; // below 30 — skip

    const impliedMove = currentIV * Math.sqrt(dte / 365);
    const actualMove = Math.abs(exit.close / entry.close - 1);

    periods.push({
      entryDate:  entry.date,
      exitDate:   exit.date,
      entryPrice: entry.close,
      exitPrice:  exit.close,
      ivrAtEntry,
      ivrBand,
      impliedMove,
      actualMove,
      won:        actualMove <= impliedMove,
      daysHeld:   dte,
    });
  }

  return periods;
}

// ─── Aggregation ──────────────────────────────────────────────────────────────

export function aggregateBacktest(
  symbol: string,
  periods: BacktestPeriod[]
): StrategyBacktestResult[] {
  const bands: IVRBand[] = ["30-50", "50-70", "70+"];

  return bands
    .map((band) => {
      const sub = periods.filter((p) => p.ivrBand === band);
      if (sub.length === 0) return null;

      const wins = sub.filter((p) => p.won).length;
      return {
        symbol,
        ivrBand:        band,
        winRate:        (wins / sub.length) * 100,
        avgImpliedMove: sub.reduce((s, p) => s + p.impliedMove, 0) / sub.length,
        avgActualMove:  sub.reduce((s, p) => s + p.actualMove,  0) / sub.length,
        sampleSize:     sub.length,
        avgDte:         sub.reduce((s, p) => s + p.daysHeld, 0) / sub.length,
      };
    })
    .filter((r): r is StrategyBacktestResult => r !== null);
}

// ─── DB row builder ───────────────────────────────────────────────────────────

export function toBacktestDbRows(
  results: StrategyBacktestResult[],
  strategy = "short_strangle"
): BacktestDbRow[] {
  return results.map((r) => ({
    symbol:           r.symbol,
    strategy,
    ivr_band:         r.ivrBand,
    win_rate:         r.winRate,
    avg_implied_move: r.avgImpliedMove,
    avg_actual_move:  r.avgActualMove,
    sample_size:      r.sampleSize,
    avg_dte:          r.avgDte,
    computed_at:      new Date().toISOString(),
  }));
}

/**
 * Returns the cached win rate for a symbol at its current IVR level.
 * Used to enrich scan result cards.
 */
export function getWinRateForIVR(
  results: StrategyBacktestResult[],
  currentIVR: number
): number | null {
  const band = classifyIVRBand(currentIVR);
  if (!band) return null;
  return results.find((r) => r.ivrBand === band)?.winRate ?? null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function classifyIVRBand(ivr: number): IVRBand | null {
  if (ivr >= 70) return "70+";
  if (ivr >= 50) return "50-70";
  if (ivr >= 30) return "30-50";
  return null;
}
