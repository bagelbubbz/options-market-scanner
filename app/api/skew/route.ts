import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import {
  getExpirations,
  selectExpiration,
  getOptionsChain,
} from "@/lib/tiger";
import {
  calculateSkew25d,
  computeSkewZScore,
  buildSkewSnapshot,
  SKEW_ALERT_THRESHOLD,
} from "@/lib/skew";
import { DEFAULT_FILTER_CONFIG } from "@/lib/filters";

// ─── POST /api/skew ───────────────────────────────────────────────────────────
// Body: { symbols: string[] }
// Snaps current 25-delta skew for each symbol, computes z-score, fires alerts.

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const symbols: string[] = (body.symbols ?? []).map((s: string) =>
    s.toUpperCase()
  );

  if (symbols.length === 0) {
    return NextResponse.json({ ok: true, snapshots: [], alerts: [] });
  }

  const CONCURRENCY = 3;
  const snapshots = [];
  const alerts = [];

  for (let i = 0; i < symbols.length; i += CONCURRENCY) {
    const batch = symbols.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(batch.map(snapshotSkewForSymbol));

    for (const outcome of settled) {
      if (outcome.status === "fulfilled" && outcome.value) {
        snapshots.push(outcome.value);
        if (outcome.value.alert_triggered) {
          alerts.push({
            symbol: outcome.value.symbol,
            skew25d: outcome.value.skew_25d,
            zScore: outcome.value.skew_z_score,
          });
        }
      }
    }
  }

  return NextResponse.json({ ok: true, snapshots, alerts });
}

// ─── GET /api/skew?symbol=AAPL ────────────────────────────────────────────────
// Returns last 30 skew snapshots + current z-score for sparkline / history.

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const symbol = searchParams.get("symbol")?.toUpperCase();

  if (!symbol) {
    return NextResponse.json({ ok: false, error: "symbol is required" }, { status: 400 });
  }

  const db = createServiceClient();
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await db
    .from("skew_snapshots")
    .select("*")
    .eq("symbol", symbol)
    .gte("snapped_at", cutoff)
    .order("snapped_at", { ascending: false })
    .limit(100);

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, symbol, snapshots: data ?? [] });
}

// ─── Per-symbol snapshot ──────────────────────────────────────────────────────

async function snapshotSkewForSymbol(symbol: string) {
  const expirations = await getExpirations(symbol);
  const expiration = selectExpiration(
    expirations,
    DEFAULT_FILTER_CONFIG.minDaysToExpiry,
    DEFAULT_FILTER_CONFIG.maxDaysToExpiry
  );
  if (!expiration) return null;

  const chain = await getOptionsChain(symbol, expiration);
  const { skew25d, put25dIV, call25dIV } = calculateSkew25d(chain);

  // Fetch last 30 days of snapshots for z-score
  const db = createServiceClient();
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data: history } = await db
    .from("skew_snapshots")
    .select("skew_25d")
    .eq("symbol", symbol)
    .gte("snapped_at", cutoff)
    .order("snapped_at", { ascending: false })
    .limit(100);

  const historicalSkews = (history ?? []).map(
    (r: { skew_25d: number }) => r.skew_25d
  );
  const zScore = computeSkewZScore(skew25d, historicalSkews);

  const snapshot = buildSkewSnapshot(symbol, skew25d, put25dIV, call25dIV, zScore);

  // Persist
  await db.from("skew_snapshots").insert(snapshot);

  return snapshot;
}
