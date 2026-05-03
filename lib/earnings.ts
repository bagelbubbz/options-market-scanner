import type { TradierHistoricalDay } from "./types";

export type EarningsRecommendation =
  | "sell_premium"
  | "buy_premium"
  | "neutral"
  | "insufficient_data";

export interface EarningsSetup {
  symbol: string;
  nextEarningsDate: string | null;
  daysToEarnings: number | null;
  impliedMove: number;           // fraction from current front-month straddle
  historicalAvgMove: number;     // fraction — avg |actual move| over past N earnings
  historicalHitRate: number;     // 0-100: % of past earnings where actual < implied (seller wins)
  sampleSize: number;
  recommendation: EarningsRecommendation;
}

export interface EarningsHistoryRow {
  symbol: string;
  earnings_date: string;
  implied_move: number | null;
  actual_move: number | null;
  premium_seller_won: boolean | null;
}

// ─── Tradier fundamentals ────────────────────────────────────────────────────

interface TradierCalendar {
  date: string;
  description: string;
}

/**
 * Fetches the next earnings date from Tiger Brokers' financial calendar endpoint.
 * Returns null if unavailable — the price-gap heuristic is used as fallback.
 */
export async function getNextEarningsDate(symbol: string): Promise<string | null> {
  // Tiger financial calendar requires a separate subscription; most accounts
  // won't have access, so we gracefully return null and rely on the heuristic.
  try {
    const crypto = await import("crypto");
    const tigerId     = process.env.TIGER_ID ?? "";
    const privateKey  = (process.env.TIGER_PRIVATE_KEY ?? "").replace(/\\n/g, "\n");
    if (!tigerId || !privateKey) return null;

    const params: Record<string, string> = {
      tiger_id:    tigerId,
      sign_type:   "RSA",
      timestamp:   Date.now().toString(),
      charset:     "UTF-8",
      version:     "3.0",
      method:      "financial_calendar",
      biz_content: JSON.stringify({ symbol, market: "US", types: ["earnings"] }),
    };

    const payload = Object.keys(params).filter(k => params[k] !== "").sort()
      .map(k => `${k}=${params[k]}`).join("&");
    const signer = crypto.createSign("RSA-SHA256");
    signer.update(payload, "utf8");
    params.sign = signer.sign(privateKey, "base64");

    const res = await fetch("https://openapi.tigerbrokers.com/interface", {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:    new URLSearchParams(params).toString(),
      next:    { revalidate: 3600 },
    });

    if (!res.ok) return null;
    const json = await res.json();
    if (json.code !== 0) return null;

    const events: Array<{ date: string; type: string }> = json.data?.items ?? [];
    const now = new Date();
    const next = events
      .filter(e => e.type?.toLowerCase().includes("earn") && new Date(e.date) > now)
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())[0];

    return next?.date ?? null;
  } catch {
    return null;
  }
}

// ─── Historical move detection ────────────────────────────────────────────────

/**
 * Attempts to detect past earnings dates from price history by finding days
 * with unusually large gaps (open vs prior close), which are characteristic of
 * post-earnings moves. Uses a 2σ gap threshold.
 *
 * Returns up to `maxEvents` detected earnings-like events sorted newest first.
 */
export function detectEarningsDatesFromHistory(
  days: TradierHistoricalDay[],
  maxEvents = 8
): Array<{ date: string; gapPct: number }> {
  if (days.length < 10) return [];

  // Compute gap-open returns (open / prev close - 1)
  const gaps = days.slice(1).map((d, i) => ({
    date: d.date,
    gap: Math.abs(d.open / days[i].close - 1),
  }));

  const gapValues = gaps.map((g) => g.gap);
  const mean = gapValues.reduce((s, v) => s + v, 0) / gapValues.length;
  const std = Math.sqrt(
    gapValues.reduce((s, v) => s + (v - mean) ** 2, 0) / (gapValues.length - 1)
  );
  const threshold = mean + 2 * std;

  const events = gaps
    .filter((g) => g.gap > threshold)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, maxEvents);

  return events.map((e) => ({ date: e.date, gapPct: e.gap }));
}

/**
 * For each detected earnings date, calculate the actual day-over-day close move
 * (from prior day close to earnings day close).
 */
export function computeActualEarningsMoves(
  days: TradierHistoricalDay[],
  earningsDates: string[]
): Array<{ date: string; actualMove: number }> {
  const dateIndex = new Map(days.map((d, i) => [d.date, i]));

  return earningsDates
    .map((date) => {
      const idx = dateIndex.get(date);
      if (idx == null || idx === 0) return null;
      const prev = days[idx - 1];
      const curr = days[idx];
      const actualMove = Math.abs(curr.close / prev.close - 1);
      return { date, actualMove };
    })
    .filter((r): r is { date: string; actualMove: number } => r !== null);
}

// ─── Hit-rate calculation ─────────────────────────────────────────────────────

export function computeHitRate(
  events: Array<{ impliedMove: number; actualMove: number }>
): { hitRate: number; avgImplied: number; avgActual: number } {
  if (events.length === 0) {
    return { hitRate: 0, avgImplied: 0, avgActual: 0 };
  }

  const wins = events.filter((e) => e.actualMove < e.impliedMove).length;
  const hitRate = (wins / events.length) * 100;
  const avgImplied = events.reduce((s, e) => s + e.impliedMove, 0) / events.length;
  const avgActual  = events.reduce((s, e) => s + e.actualMove,  0) / events.length;

  return { hitRate, avgImplied, avgActual };
}

// ─── Recommendation ───────────────────────────────────────────────────────────

/**
 * If historical hit rate ≥ 65% AND implied move is ≥ 1.2× historical avg → sell premium.
 * If hit rate ≤ 35% → buy premium (straddle buy).
 * Otherwise neutral.
 */
export function deriveEarningsRecommendation(
  hitRate: number,
  sampleSize: number,
  impliedMove: number,
  historicalAvgMove: number
): EarningsRecommendation {
  if (sampleSize < 3) return "insufficient_data";

  const impliedPremium = historicalAvgMove > 0 ? impliedMove / historicalAvgMove : 1;

  if (hitRate >= 65 && impliedPremium >= 1.1) return "sell_premium";
  if (hitRate <= 35) return "buy_premium";
  return "neutral";
}

// ─── Full setup builder ───────────────────────────────────────────────────────

export function buildEarningsSetup(
  symbol: string,
  nextEarningsDate: string | null,
  impliedMove: number,
  historicalMoves: Array<{ impliedMove: number; actualMove: number }>
): EarningsSetup {
  const { hitRate, avgImplied, avgActual } = computeHitRate(historicalMoves);

  const recommendation = deriveEarningsRecommendation(
    hitRate,
    historicalMoves.length,
    impliedMove,
    avgActual
  );

  const daysToEarnings =
    nextEarningsDate
      ? Math.round(
          (new Date(nextEarningsDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
        )
      : null;

  return {
    symbol,
    nextEarningsDate,
    daysToEarnings,
    impliedMove,
    historicalAvgMove: avgActual,
    historicalHitRate: hitRate,
    sampleSize: historicalMoves.length,
    recommendation,
  };
}
