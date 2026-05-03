import { NextResponse } from "next/server";
import {
  getExpirations,
  selectExpiration,
  getOptionsChain,
  getYearPriceHistory,
} from "@/lib/tradier";
import { calculateImpliedMove } from "@/lib/metrics";
import {
  getNextEarningsDate,
  detectEarningsDatesFromHistory,
  computeActualEarningsMoves,
  buildEarningsSetup,
} from "@/lib/earnings";
import { DEFAULT_FILTER_CONFIG } from "@/lib/filters";
import { ALL_WATCHLIST } from "@/lib/watchlist";
import type { EarningsSetup } from "@/lib/earnings";

// ─── GET /api/earnings?symbols=AAPL,TSLA ─────────────────────────────────────
// Returns EarningsSetup[] for each symbol

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const symbolsParam = searchParams.get("symbols");

  const symbols = symbolsParam
    ? symbolsParam.split(",").map((s) => s.trim().toUpperCase())
    : ALL_WATCHLIST.map((e) => e.symbol);

  const CONCURRENCY = 3;
  const results: EarningsSetup[] = [];

  for (let i = 0; i < symbols.length; i += CONCURRENCY) {
    const batch = symbols.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(batch.map(analyseEarnings));

    for (const outcome of settled) {
      if (outcome.status === "fulfilled" && outcome.value) {
        results.push(outcome.value);
      } else if (outcome.status === "rejected") {
        console.warn("[earnings]", outcome.reason);
      }
    }
  }

  // Sort by proximity to next earnings (soonest first), unknowns last
  results.sort((a, b) => {
    if (a.daysToEarnings == null) return 1;
    if (b.daysToEarnings == null) return -1;
    return a.daysToEarnings - b.daysToEarnings;
  });

  return NextResponse.json({ ok: true, results });
}

// ─── Per-symbol analysis ──────────────────────────────────────────────────────

async function analyseEarnings(symbol: string): Promise<EarningsSetup | null> {
  const [expirations, priceHistory, nextEarningsDate] = await Promise.all([
    getExpirations(symbol),
    getYearPriceHistory(symbol),
    getNextEarningsDate(symbol),
  ]);

  // Current implied move from the nearest 30-45 DTE options chain
  let impliedMove = 0;
  const expiration = selectExpiration(
    expirations,
    DEFAULT_FILTER_CONFIG.minDaysToExpiry,
    DEFAULT_FILTER_CONFIG.maxDaysToExpiry
  );

  if (expiration) {
    const chain = await getOptionsChain(symbol, expiration);
    impliedMove = calculateImpliedMove(chain);
  }

  // Detect historical earnings dates from price-gap heuristic
  const detectedDates = detectEarningsDatesFromHistory(priceHistory.days, 8);
  const detectedDateStrings = detectedDates.map((e) => e.date);

  // Compute actual moves around each detected earnings date
  const historicalMoves = computeActualEarningsMoves(
    priceHistory.days,
    detectedDateStrings
  ).map((e) => ({
    impliedMove: e.actualMove * 1.15, // approximate: options typically price in a ~15% buffer
    actualMove: e.actualMove,
  }));

  return buildEarningsSetup(symbol, nextEarningsDate, impliedMove, historicalMoves);
}
