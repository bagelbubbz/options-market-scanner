import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import {
  getExpirations,
  selectExpiration,
  getOptionsChain,
  getYearPriceHistory,
  computeHistoricalIV,
  getQuote,
} from "@/lib/tradier";
import { buildTickerMetrics, DEFAULT_FILTER_CONFIG } from "@/lib/filters";
import type { ScanResult, TickerMetrics } from "@/lib/types";

// Default watchlist used when DB is unavailable / empty
const DEFAULT_WATCHLIST = ["AAPL", "MSFT", "NVDA", "AMZN", "SPY", "QQQ", "JPM", "TSLA"];

// ─── POST /api/scan ───────────────────────────────────────────────────────────

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const { symbols: overrideSymbols } = body as { symbols?: string[] };

    // 1. Resolve watchlist (from DB or default)
    const symbols = await resolveWatchlist(overrideSymbols);

    // 2. Scan each ticker concurrently (limit concurrency to avoid rate limits)
    const results = await scanTickers(symbols);

    // 3. Persist to Supabase
    const saved = await persistResults(results);

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

// ─── GET /api/scan — return latest results ────────────────────────────────────

export async function GET() {
  try {
    const db = createServiceClient();
    const { data, error } = await db
      .from("scan_results")
      .select("*")
      .order("scanned_at", { ascending: false })
      .limit(100);

    if (error) throw error;

    // Return only the latest result per symbol
    const latest = dedupeBySymbol(data ?? []);

    return NextResponse.json({ ok: true, results: latest });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function resolveWatchlist(overrideSymbols?: string[]): Promise<string[]> {
  if (overrideSymbols && overrideSymbols.length > 0) {
    return overrideSymbols.map((s) => s.toUpperCase());
  }

  try {
    const db = createServiceClient();
    const { data, error } = await db
      .from("tickers")
      .select("symbol")
      .eq("active", true);

    if (error || !data || data.length === 0) {
      return DEFAULT_WATCHLIST;
    }

    return data.map((r: { symbol: string }) => r.symbol);
  } catch {
    return DEFAULT_WATCHLIST;
  }
}

async function scanTickers(symbols: string[]): Promise<ScanResult[]> {
  const CONCURRENCY = 3;
  const results: ScanResult[] = [];

  // Process in batches to stay within Tradier rate limits
  for (let i = 0; i < symbols.length; i += CONCURRENCY) {
    const batch = symbols.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.allSettled(batch.map(scanOneTicker));

    for (const outcome of batchResults) {
      if (outcome.status === "fulfilled" && outcome.value) {
        results.push(metricsToDbRow(outcome.value));
      } else if (outcome.status === "rejected") {
        console.warn("[scan] ticker failed:", outcome.reason);
      }
    }
  }

  return results;
}

async function scanOneTicker(symbol: string): Promise<TickerMetrics | null> {
  // a. Get expirations and pick the target one
  const expirations = await getExpirations(symbol);
  const expiration = selectExpiration(
    expirations,
    DEFAULT_FILTER_CONFIG.minDaysToExpiry,
    DEFAULT_FILTER_CONFIG.maxDaysToExpiry
  );
  if (!expiration) return null;

  // b. Fetch options chain + quote in parallel with price history
  const [chain, priceHistory, quote] = await Promise.all([
    getOptionsChain(symbol, expiration),
    getYearPriceHistory(symbol),
    getQuote(symbol),
  ]);

  // c. Compute historical IV series for IVR
  const ivSeries = computeHistoricalIV(priceHistory.days, 30);

  // Derive 52-week IV range from historical vol series
  const ivValues = ivSeries.map((d) => d.iv);
  const iv52wHigh = ivValues.length > 0 ? Math.max(...ivValues) : chain.options[0]?.greeks?.mid_iv ?? 0;
  const iv52wLow  = ivValues.length > 0 ? Math.min(...ivValues) : 0;

  // d. Run filters + score
  const metrics = buildTickerMetrics(
    chain,
    iv52wHigh,
    iv52wLow,
    quote.average_volume,
    DEFAULT_FILTER_CONFIG
  );

  return metrics;
}

function metricsToDbRow(m: TickerMetrics): ScanResult {
  return {
    symbol:             m.symbol,
    underlying_price:   m.underlyingPrice,
    iv30:               m.iv30,
    iv_rank:            m.ivRank,
    iv52w_high:         m.iv52wHigh,
    iv52w_low:          m.iv52wLow,
    pop:                m.pop,
    score:              m.score,
    strategy:           m.strategy,
    implied_move:       m.impliedMove,
    gamma_theta_ratio:  m.gammaThetaRatio,
    expiration_date:    m.expirationDate,
    short_put_strike:   m.shortPutStrike,
    short_call_strike:  m.shortCallStrike,
    long_put_strike:    m.longPutStrike,
    long_call_strike:   m.longCallStrike,
    credit:             m.credit,
    scanned_at:         new Date().toISOString(),
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
    // Return the in-memory rows so the response is still useful
    return rows;
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
