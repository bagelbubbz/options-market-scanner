import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { getYearPriceHistory, computeHistoricalIV } from "@/lib/tradier";
import { runBacktest, aggregateBacktest, toBacktestDbRows } from "@/lib/backtest";
import { ALL_WATCHLIST } from "@/lib/watchlist";

// ─── GET /api/backtest?symbol=AAPL ───────────────────────────────────────────

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const symbol = searchParams.get("symbol")?.toUpperCase();

  if (!symbol) {
    return NextResponse.json({ ok: false, error: "symbol is required" }, { status: 400 });
  }

  try {
    const result = await getOrComputeBacktest(symbol);
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

// ─── POST /api/backtest ───────────────────────────────────────────────────────
// Body: { symbols?: string[] } — defaults to full watchlist

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const symbols: string[] =
    (body.symbols as string[] | undefined)?.map((s) => s.toUpperCase()) ??
    ALL_WATCHLIST.map((e) => e.symbol);

  const CONCURRENCY = 3;
  const results = [];

  for (let i = 0; i < symbols.length; i += CONCURRENCY) {
    const batch = symbols.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(batch.map(getOrComputeBacktest));
    for (const outcome of settled) {
      if (outcome.status === "fulfilled" && outcome.value) {
        results.push(outcome.value);
      }
    }
  }

  return NextResponse.json({ ok: true, results });
}

// ─── Core: cache-aware compute ────────────────────────────────────────────────

async function getOrComputeBacktest(symbol: string) {
  const db = createServiceClient();

  // Return cached result if computed within the last 24 hours
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: cached } = await db
    .from("backtest_results")
    .select("*")
    .eq("symbol", symbol)
    .gte("computed_at", cutoff)
    .limit(1);

  if (cached && cached.length > 0) {
    return normaliseDbRows(symbol, cached);
  }

  // Compute fresh
  const priceHistory = await getYearPriceHistory(symbol);
  if (priceHistory.days.length < 65) return null;

  const ivSeries = computeHistoricalIV(priceHistory.days, 30);
  const periods = runBacktest(symbol, priceHistory.days);
  const aggregated = aggregateBacktest(symbol, periods);

  if (aggregated.length === 0) return null;

  // Upsert by (symbol, strategy, ivr_band)
  const rows = toBacktestDbRows(aggregated, "short_strangle");
  await db
    .from("backtest_results")
    .upsert(rows, { onConflict: "symbol,strategy,ivr_band" });

  return { symbol, bands: aggregated };
}

function normaliseDbRows(symbol: string, rows: Record<string, unknown>[]) {
  return {
    symbol,
    bands: rows.map((r) => ({
      symbol,
      ivrBand:        r.ivr_band,
      winRate:        r.win_rate,
      avgImpliedMove: r.avg_implied_move,
      avgActualMove:  r.avg_actual_move,
      sampleSize:     r.sample_size,
      avgDte:         r.avg_dte,
    })),
  };
}
