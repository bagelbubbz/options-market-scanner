import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import {
  getExpirations,
  selectExpiration,
  getOptionsChain,
  getYearPriceHistory,
  computeHistoricalIV,
  getQuote,
} from "@/lib/tiger";
import {
  buildTickerMetrics,
  DEFAULT_FILTER_CONFIG,
  MID_CAP_FILTER_CONFIG,
} from "@/lib/filters";
import {
  calculateSkew25d,
  computeSkewZScore,
  buildSkewSnapshot,
} from "@/lib/skew";
import { runBacktest, aggregateBacktest, getWinRateForIVR } from "@/lib/backtest";
import { getSymbolsByTier, getTierForSymbol } from "@/lib/watchlist";
import type { ScanResult, TickerMetrics, WatchlistTier } from "@/lib/types";

// ─── POST /api/scan ───────────────────────────────────────────────────────────

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const {
      symbols: overrideSymbols,
      tier = "large_cap",
    } = body as { symbols?: string[]; tier?: WatchlistTier | "all" };

    // 1. Resolve watchlist
    const symbols = await resolveWatchlist(overrideSymbols, tier);

    // 2. Scan each ticker in batches
    const results = await scanTickers(symbols, tier);

    // 3. Persist to Supabase
    const saved = await persistResults(results);

    // 4. Snapshot skew in the background (non-blocking)
    void snapshotSkewBatch(symbols).catch((e) =>
      console.warn("[scan] skew snapshot failed:", e)
    );

    return NextResponse.json({
      ok: true,
      scanned: symbols.length,
      passed: results.length,
      results: saved,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[scan] error:", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

// ─── GET /api/scan ────────────────────────────────────────────────────────────

export async function GET() {
  try {
    const db = createServiceClient();
    const { data, error } = await db
      .from("scan_results")
      .select("*")
      .order("scanned_at", { ascending: false })
      .limit(200);

    if (error) throw error;

    return NextResponse.json({ ok: true, results: dedupeBySymbol(data ?? []) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function resolveWatchlist(
  overrideSymbols?: string[],
  tier: WatchlistTier | "all" = "large_cap"
): Promise<string[]> {
  if (overrideSymbols && overrideSymbols.length > 0) {
    return overrideSymbols.map((s) => s.toUpperCase());
  }

  try {
    const db = createServiceClient();
    const query = db.from("tickers").select("symbol").eq("active", true);

    if (tier !== "all") {
      query.eq("watchlist_tier", tier);
    }

    const { data, error } = await query;
    if (error || !data || data.length === 0) {
      return getSymbolsByTier(tier);
    }

    return data.map((r: { symbol: string }) => r.symbol);
  } catch {
    return getSymbolsByTier(tier);
  }
}

async function scanTickers(
  symbols: string[],
  tier: WatchlistTier | "all" = "large_cap"
): Promise<ScanResult[]> {
  const CONCURRENCY = 3;
  const results: ScanResult[] = [];

  for (let i = 0; i < symbols.length; i += CONCURRENCY) {
    const batch = symbols.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.allSettled(
      batch.map((s) => scanOneTicker(s, tier))
    );

    for (const outcome of batchResults) {
      if (outcome.status === "fulfilled" && outcome.value) {
        results.push(outcome.value);
      } else if (outcome.status === "rejected") {
        console.warn("[scan] ticker failed:", outcome.reason);
      }
    }
  }

  return results;
}

async function scanOneTicker(
  symbol: string,
  tier: WatchlistTier | "all"
): Promise<ScanResult | null> {
  const filterConfig =
    tier === "mid_cap" ? MID_CAP_FILTER_CONFIG : DEFAULT_FILTER_CONFIG;

  const expirations = await getExpirations(symbol);
  const expiration = selectExpiration(
    expirations,
    filterConfig.minDaysToExpiry,
    filterConfig.maxDaysToExpiry
  );
  if (!expiration) return null;

  const [chain, priceHistory, quote] = await Promise.all([
    getOptionsChain(symbol, expiration),
    getYearPriceHistory(symbol),
    getQuote(symbol),
  ]);

  const ivSeries = computeHistoricalIV(priceHistory.days, 30);
  const ivValues = ivSeries.map((d) => d.iv);
  const iv52wHigh =
    ivValues.length > 0 ? Math.max(...ivValues) : chain.options[0]?.greeks?.mid_iv ?? 0;
  const iv52wLow = ivValues.length > 0 ? Math.min(...ivValues) : 0;

  const metrics = buildTickerMetrics(
    chain,
    iv52wHigh,
    iv52wLow,
    quote.average_volume,
    filterConfig
  );
  if (!metrics) return null;

  // Backtest win rate for this IVR level
  let backtestWinRate: number | undefined;
  try {
    const periods = runBacktest(symbol, priceHistory.days);
    const aggregated = aggregateBacktest(symbol, periods);
    const wr = getWinRateForIVR(aggregated, metrics.ivRank);
    if (wr != null) backtestWinRate = wr;
  } catch {
    // Non-critical — continue without backtest
  }

  // Skew
  let skew25d: number | undefined;
  let skewZScore: number | undefined;
  try {
    const { skew25d: s } = calculateSkew25d(chain);
    skew25d = s;
  } catch {
    // Non-critical
  }

  const tickerTier =
    tier === "all" ? getTierForSymbol(symbol) : (tier as WatchlistTier);

  return metricsToDbRow(metrics, tickerTier, backtestWinRate, skew25d, skewZScore);
}

function metricsToDbRow(
  m: TickerMetrics,
  tier: WatchlistTier,
  backtestWinRate?: number,
  skew25d?: number,
  skewZScore?: number
): ScanResult {
  return {
    symbol:              m.symbol,
    underlying_price:    m.underlyingPrice,
    iv30:                m.iv30,
    iv_rank:             m.ivRank,
    iv52w_high:          m.iv52wHigh,
    iv52w_low:           m.iv52wLow,
    pop:                 m.pop,
    score:               m.score,
    strategy:            m.strategy,
    implied_move:        m.impliedMove,
    gamma_theta_ratio:   m.gammaThetaRatio,
    expiration_date:     m.expirationDate,
    short_put_strike:    m.shortPutStrike,
    short_call_strike:   m.shortCallStrike,
    long_put_strike:     m.longPutStrike,
    long_call_strike:    m.longCallStrike,
    credit:              m.credit,
    watchlist_tier:      tier,
    backtest_win_rate:   backtestWinRate,
    skew_25d:            skew25d,
    skew_z_score:        skewZScore,
    scanned_at:          new Date().toISOString(),
  };
}

async function persistResults(rows: ScanResult[]): Promise<ScanResult[]> {
  if (rows.length === 0) return [];

  try {
    const db = createServiceClient();
    const { data, error } = await db
      .from("scan_results")
      .insert(rows)
      .select();

    if (error) throw error;
    return data ?? rows;
  } catch (err) {
    console.error("[scan] persist failed:", err);
    return rows;
  }
}

async function snapshotSkewBatch(symbols: string[]): Promise<void> {
  const db = createServiceClient();
  const CONCURRENCY = 3;

  for (let i = 0; i < symbols.length; i += CONCURRENCY) {
    const batch = symbols.slice(i, i + CONCURRENCY);
    await Promise.allSettled(
      batch.map(async (symbol) => {
        try {
          const expirations = await getExpirations(symbol);
          const expiration = selectExpiration(expirations, 21, 45);
          if (!expiration) return;

          const chain = await getOptionsChain(symbol, expiration);
          const { skew25d, put25dIV, call25dIV } = calculateSkew25d(chain);

          const cutoff = new Date(
            Date.now() - 30 * 24 * 60 * 60 * 1000
          ).toISOString();
          const { data: history } = await db
            .from("skew_snapshots")
            .select("skew_25d")
            .eq("symbol", symbol)
            .gte("snapped_at", cutoff)
            .order("snapped_at", { ascending: false })
            .limit(60);

          const historicalSkews = (history ?? []).map(
            (r: { skew_25d: number }) => r.skew_25d
          );
          const zScore = computeSkewZScore(skew25d, historicalSkews);
          const snapshot = buildSkewSnapshot(
            symbol,
            skew25d,
            put25dIV,
            call25dIV,
            zScore
          );

          await db.from("skew_snapshots").insert(snapshot);
        } catch {
          // Non-critical
        }
      })
    );
  }
}

function dedupeBySymbol(rows: ScanResult[]): ScanResult[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    if (seen.has(r.symbol)) return false;
    seen.add(r.symbol);
    return true;
  });
}
