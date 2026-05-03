"use client";

import { useState, useCallback, useMemo } from "react";
import {
  RefreshCw,
  TrendingUp,
  Activity,
  Filter,
  AlertCircle,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { ScanResult, Strategy } from "@/lib/types";

// ─── Strategy metadata ────────────────────────────────────────────────────────

const STRATEGY_META: Record<
  Strategy,
  { label: string; color: string; description: string }
> = {
  short_strangle: {
    label: "Short Strangle",
    color: "bg-purple-500/20 text-purple-300 ring-1 ring-purple-500/30",
    description: "Sell OTM call + put",
  },
  iron_condor: {
    label: "Iron Condor",
    color: "bg-blue-500/20 text-blue-300 ring-1 ring-blue-500/30",
    description: "Defined-risk range trade",
  },
  cash_secured_put: {
    label: "CSP",
    color: "bg-teal-500/20 text-teal-300 ring-1 ring-teal-500/30",
    description: "Cash-secured put",
  },
  covered_call: {
    label: "Covered Call",
    color: "bg-orange-500/20 text-orange-300 ring-1 ring-orange-500/30",
    description: "Covered call on long stock",
  },
  skip: {
    label: "Skip",
    color: "bg-gray-500/20 text-gray-400",
    description: "Below filter threshold",
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function scoreVariant(
  score: number
): "score_high" | "score_mid" | "score_low" {
  if (score >= 65) return "score_high";
  if (score >= 40) return "score_mid";
  return "score_low";
}

function fmt(n: number | undefined | null, decimals = 2): string {
  if (n == null) return "—";
  return n.toFixed(decimals);
}

function fmtPct(n: number | undefined | null, decimals = 1): string {
  if (n == null) return "—";
  return `${(n * 100).toFixed(decimals)}%`;
}

function fmtCurrency(n: number | undefined | null): string {
  if (n == null) return "—";
  return `$${n.toFixed(2)}`;
}

function timeAgo(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ago`;
}

// ─── Filter pill ──────────────────────────────────────────────────────────────

function FilterPill({
  label,
  active,
  onClick,
  colorClass,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  colorClass?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "rounded-full px-3 py-1 text-xs font-medium transition-all border",
        active
          ? colorClass ?? "bg-primary/20 text-primary border-primary/40"
          : "bg-muted/50 text-muted-foreground border-border hover:bg-muted"
      )}
    >
      {label}
    </button>
  );
}

// ─── Result card ──────────────────────────────────────────────────────────────

function ResultCard({ result }: { result: ScanResult }) {
  const [expanded, setExpanded] = useState(false);
  const meta = STRATEGY_META[result.strategy];
  const variant = scoreVariant(result.score);

  const strikeDisplay = buildStrikeDisplay(result);

  return (
    <Card className="overflow-hidden border-border/60 hover:border-border transition-colors">
      {/* Header row */}
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            {/* Symbol */}
            <span className="text-xl font-bold tracking-tight text-foreground">
              {result.symbol}
            </span>

            {/* Strategy pill */}
            <span
              className={cn(
                "rounded-full px-2.5 py-0.5 text-xs font-semibold",
                meta.color
              )}
            >
              {meta.label}
            </span>
          </div>

          {/* Score badge */}
          <Badge variant={variant} className="text-sm font-bold px-3 py-1 shrink-0">
            {fmt(result.score, 0)}
          </Badge>
        </div>

        {/* Price + time */}
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <span className="font-medium text-foreground/80">
            {fmtCurrency(result.underlying_price)}
          </span>
          <span>·</span>
          <span>{timeAgo(result.scanned_at)}</span>
          {result.expiration_date && (
            <>
              <span>·</span>
              <span>Exp {result.expiration_date}</span>
            </>
          )}
        </div>
      </CardHeader>

      <CardContent className="pb-4">
        {/* Key metrics grid */}
        <div className="grid grid-cols-3 gap-3 mb-3">
          <MetricCell
            label="IVR"
            value={`${fmt(result.iv_rank, 0)}%`}
            highlight={result.iv_rank >= 50}
          />
          <MetricCell
            label="IV30"
            value={fmtPct(result.iv30)}
            highlight={result.iv30 >= 0.4}
          />
          <MetricCell
            label="PoP"
            value={`${fmt(result.pop, 0)}%`}
            highlight={result.pop >= 70}
          />
        </div>

        {/* Strikes + credit */}
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground font-mono text-xs">
            {strikeDisplay}
          </span>
          {result.credit != null && result.credit > 0 && (
            <span className="text-green-400 font-semibold text-xs">
              +{fmtCurrency(result.credit)} credit
            </span>
          )}
        </div>

        {/* Expand / collapse */}
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mt-3 transition-colors"
        >
          {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          {expanded ? "Less" : "More details"}
        </button>

        {/* Expanded metrics */}
        {expanded && (
          <div className="mt-3 pt-3 border-t border-border/50 grid grid-cols-2 gap-2 text-xs">
            <DetailRow label="Implied Move" value={fmtPct(result.implied_move)} />
            <DetailRow
              label="Gamma/Theta"
              value={result.gamma_theta_ratio != null ? fmt(result.gamma_theta_ratio, 4) : "—"}
            />
            <DetailRow
              label="52w IV High"
              value={result.iv52w_high != null ? fmtPct(result.iv52w_high) : "—"}
            />
            <DetailRow
              label="52w IV Low"
              value={result.iv52w_low != null ? fmtPct(result.iv52w_low) : "—"}
            />
            {result.short_put_strike && (
              <DetailRow label="Short Put" value={fmtCurrency(result.short_put_strike)} />
            )}
            {result.short_call_strike && (
              <DetailRow label="Short Call" value={fmtCurrency(result.short_call_strike)} />
            )}
            {result.long_put_strike && (
              <DetailRow label="Long Put" value={fmtCurrency(result.long_put_strike)} />
            )}
            {result.long_call_strike && (
              <DetailRow label="Long Call" value={fmtCurrency(result.long_call_strike)} />
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function MetricCell({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className="rounded-lg bg-muted/50 px-3 py-2 text-center">
      <div className="text-xs text-muted-foreground mb-0.5">{label}</div>
      <div
        className={cn(
          "text-sm font-semibold",
          highlight ? "text-green-400" : "text-foreground"
        )}
      >
        {value}
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-foreground/90 font-mono">{value}</span>
    </div>
  );
}

function buildStrikeDisplay(result: ScanResult): string {
  const parts: string[] = [];
  if (result.long_put_strike)   parts.push(`$${result.long_put_strike}p`);
  if (result.short_put_strike)  parts.push(`$${result.short_put_strike}p`);
  if (result.short_call_strike) parts.push(`$${result.short_call_strike}c`);
  if (result.long_call_strike)  parts.push(`$${result.long_call_strike}c`);
  return parts.join(" / ") || "—";
}

// ─── Empty / loading states ────────────────────────────────────────────────────

function EmptyState({ onScan }: { onScan: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center gap-4">
      <div className="w-16 h-16 rounded-2xl bg-muted/50 flex items-center justify-center">
        <Activity size={28} className="text-muted-foreground" />
      </div>
      <div>
        <p className="text-foreground font-semibold text-lg">No results yet</p>
        <p className="text-muted-foreground text-sm mt-1">
          Run a scan to find premium-selling opportunities
        </p>
      </div>
      <Button onClick={onScan} size="sm">
        Run Scanner
      </Button>
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive-foreground mb-6">
      <AlertCircle size={16} className="shrink-0 mt-0.5 text-red-400" />
      <span className="text-red-300">{message}</span>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

const STRATEGY_FILTERS: Array<{ key: Strategy | "all"; label: string }> = [
  { key: "all",            label: "All" },
  { key: "iron_condor",    label: "Iron Condor" },
  { key: "short_strangle", label: "Short Strangle" },
  { key: "cash_secured_put", label: "CSP" },
  { key: "covered_call",   label: "Covered Call" },
];

const SCORE_FILTERS: Array<{ key: string; label: string; min: number }> = [
  { key: "all",  label: "All Scores", min: 0 },
  { key: "high", label: "High (65+)",  min: 65 },
  { key: "mid",  label: "Mid (40+)",   min: 40 },
];

export default function ScannerPage() {
  const [results, setResults] = useState<ScanResult[]>([]);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastScan, setLastScan] = useState<Date | null>(null);
  const [strategyFilter, setStrategyFilter] = useState<Strategy | "all">("all");
  const [scoreFilter, setScoreFilter] = useState("all");
  const [sortBy, setSortBy] = useState<"score" | "ivr" | "pop">("score");

  const runScan = useCallback(async () => {
    setScanning(true);
    setError(null);
    try {
      const res = await fetch("/api/scan", { method: "POST" });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error ?? "Scan failed");
      setResults(json.results ?? []);
      setLastScan(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unexpected error");
    } finally {
      setScanning(false);
    }
  }, []);

  const filtered = useMemo(() => {
    let out = results.filter((r) => r.strategy !== "skip");

    if (strategyFilter !== "all") {
      out = out.filter((r) => r.strategy === strategyFilter);
    }

    const minScore = SCORE_FILTERS.find((f) => f.key === scoreFilter)?.min ?? 0;
    if (minScore > 0) {
      out = out.filter((r) => r.score >= minScore);
    }

    return out.sort((a, b) => {
      if (sortBy === "score") return b.score - a.score;
      if (sortBy === "ivr")   return b.iv_rank - a.iv_rank;
      if (sortBy === "pop")   return b.pop - a.pop;
      return 0;
    });
  }, [results, strategyFilter, scoreFilter, sortBy]);

  const counts = useMemo(() => {
    const out: Record<string, number> = { all: 0 };
    for (const r of results) {
      if (r.strategy === "skip") continue;
      out.all = (out.all ?? 0) + 1;
      out[r.strategy] = (out[r.strategy] ?? 0) + 1;
    }
    return out;
  }, [results]);

  return (
    <div className="min-h-screen bg-background">
      {/* Top nav */}
      <header className="border-b border-border/50 bg-card/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-primary/20 flex items-center justify-center">
              <TrendingUp size={16} className="text-primary" />
            </div>
            <div>
              <h1 className="text-sm font-bold text-foreground leading-none">
                Options Scanner
              </h1>
              <p className="text-xs text-muted-foreground mt-0.5">
                Premium-selling opportunities
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {lastScan && (
              <span className="text-xs text-muted-foreground hidden sm:block">
                Last scan {timeAgo(lastScan.toISOString())}
              </span>
            )}
            <Button
              onClick={runScan}
              disabled={scanning}
              size="sm"
              className="gap-2"
            >
              <RefreshCw size={14} className={cn(scanning && "animate-spin")} />
              {scanning ? "Scanning…" : "Scan Now"}
            </Button>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-6">
        {/* Stats bar */}
        {results.length > 0 && (
          <div className="grid grid-cols-3 gap-3 mb-6">
            <StatCard
              label="Opportunities"
              value={counts.all ?? 0}
              icon={<Activity size={14} />}
            />
            <StatCard
              label="High Score (65+)"
              value={results.filter((r) => r.score >= 65).length}
              icon={<TrendingUp size={14} />}
              highlight
            />
            <StatCard
              label="Avg IVR"
              value={
                results.length
                  ? `${(results.reduce((s, r) => s + r.iv_rank, 0) / results.length).toFixed(0)}%`
                  : "—"
              }
              icon={<Filter size={14} />}
            />
          </div>
        )}

        {error && <ErrorBanner message={error} />}

        {/* Filters + sort */}
        {results.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-5 items-center">
            <span className="text-xs text-muted-foreground font-medium mr-1">
              Strategy:
            </span>
            {STRATEGY_FILTERS.map(({ key, label }) => (
              <FilterPill
                key={key}
                label={
                  key === "all"
                    ? `${label} (${counts.all ?? 0})`
                    : `${label}${counts[key] ? ` (${counts[key]})` : ""}`
                }
                active={strategyFilter === key}
                onClick={() => setStrategyFilter(key as Strategy | "all")}
                colorClass={
                  key !== "all"
                    ? STRATEGY_META[key as Strategy]?.color
                    : undefined
                }
              />
            ))}

            <span className="text-xs text-muted-foreground font-medium ml-3 mr-1">
              Score:
            </span>
            {SCORE_FILTERS.map(({ key, label }) => (
              <FilterPill
                key={key}
                label={label}
                active={scoreFilter === key}
                onClick={() => setScoreFilter(key)}
              />
            ))}

            <div className="ml-auto flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground">Sort:</span>
              {(["score", "ivr", "pop"] as const).map((s) => (
                <FilterPill
                  key={s}
                  label={s.toUpperCase()}
                  active={sortBy === s}
                  onClick={() => setSortBy(s)}
                />
              ))}
            </div>
          </div>
        )}

        {/* Results */}
        {results.length === 0 ? (
          <EmptyState onScan={runScan} />
        ) : filtered.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground text-sm">
            No results match the current filters.
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((r) => (
              <ResultCard key={r.id ?? r.symbol} result={r} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

function StatCard({
  label,
  value,
  icon,
  highlight,
}: {
  label: string;
  value: string | number;
  icon: React.ReactNode;
  highlight?: boolean;
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-card p-4">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
        {icon}
        {label}
      </div>
      <div
        className={cn(
          "text-2xl font-bold",
          highlight ? "text-green-400" : "text-foreground"
        )}
      >
        {value}
      </div>
    </div>
  );
}
