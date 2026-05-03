"use client";

import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import {
  RefreshCw,
  TrendingUp,
  Activity,
  Filter,
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Bell,
  BellOff,
  BarChart2,
  Calendar,
  Zap,
  ArrowUpRight,
  ArrowDownRight,
  Minus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { ScanResult, WatchlistTier } from "@/lib/types";
import type { EarningsSetup } from "@/lib/earnings";
import type { StrategyBacktestResult } from "@/lib/backtest";
import { LARGE_CAP_WATCHLIST, MID_CAP_WATCHLIST, ALL_WATCHLIST } from "@/lib/watchlist";

// ─── Strategy metadata ────────────────────────────────────────────────────────

const STRATEGY_META: Record<
  string,
  { label: string; color: string }
> = {
  short_strangle:   { label: "Short Strangle",  color: "bg-purple-500/20 text-purple-300 ring-1 ring-purple-500/30" },
  iron_condor:      { label: "Iron Condor",      color: "bg-blue-500/20 text-blue-300 ring-1 ring-blue-500/30" },
  cash_secured_put: { label: "CSP",              color: "bg-teal-500/20 text-teal-300 ring-1 ring-teal-500/30" },
  covered_call:     { label: "Covered Call",     color: "bg-orange-500/20 text-orange-300 ring-1 ring-orange-500/30" },
};

// ─── Format helpers ───────────────────────────────────────────────────────────

const fmt   = (n: number | undefined | null, d = 2) => n == null ? "—" : n.toFixed(d);
const fmtPct = (n: number | undefined | null, d = 1) => n == null ? "—" : `${(n * 100).toFixed(d)}%`;
const fmtCurrency = (n: number | undefined | null) => n == null ? "—" : `$${n.toFixed(2)}`;
const timeAgo = (iso: string) => {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
};

function scoreVariant(score: number): "score_high" | "score_mid" | "score_low" {
  if (score >= 65) return "score_high";
  if (score >= 40) return "score_mid";
  return "score_low";
}

function winRateColor(rate: number): string {
  if (rate >= 65) return "text-green-400";
  if (rate >= 50) return "text-yellow-400";
  return "text-gray-400";
}

// ─── Shared FilterPill ────────────────────────────────────────────────────────

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

// ─── Toast ────────────────────────────────────────────────────────────────────

interface ToastItem {
  id: number;
  symbol: string;
  message: string;
  type: "skew" | "info";
}

function ToastContainer({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: number) => void }) {
  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-xs">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="flex items-start gap-3 rounded-xl border border-yellow-500/30 bg-yellow-500/10 px-4 py-3 text-sm shadow-lg backdrop-blur-sm"
        >
          <Zap size={15} className="text-yellow-400 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <span className="font-semibold text-yellow-300">{t.symbol}</span>
            <span className="text-yellow-200/80 ml-1.5">{t.message}</span>
          </div>
          <button
            onClick={() => onDismiss(t.id)}
            className="text-yellow-400/60 hover:text-yellow-300 text-lg leading-none"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

// ─── Stat card ────────────────────────────────────────────────────────────────

function StatCard({
  label, value, icon, highlight,
}: {
  label: string; value: string | number; icon: React.ReactNode; highlight?: boolean;
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-card p-4">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">{icon}{label}</div>
      <div className={cn("text-2xl font-bold", highlight ? "text-green-400" : "text-foreground")}>{value}</div>
    </div>
  );
}

// ─── Result card ──────────────────────────────────────────────────────────────

function ResultCard({ result }: { result: ScanResult }) {
  const [expanded, setExpanded] = useState(false);
  const meta = STRATEGY_META[result.strategy];
  const hasSkewAlert = result.skew_z_score != null && Math.abs(result.skew_z_score) >= 2;

  const strikeDisplay = [
    result.long_put_strike    ? `$${result.long_put_strike}p`    : null,
    result.short_put_strike   ? `$${result.short_put_strike}p`   : null,
    result.short_call_strike  ? `$${result.short_call_strike}c`  : null,
    result.long_call_strike   ? `$${result.long_call_strike}c`   : null,
  ].filter(Boolean).join(" / ") || "—";

  return (
    <Card className={cn(
      "overflow-hidden border-border/60 hover:border-border transition-colors",
      hasSkewAlert && "ring-1 ring-yellow-500/30"
    )}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0 flex-wrap">
            <span className="text-xl font-bold text-foreground">{result.symbol}</span>
            {meta && (
              <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-semibold", meta.color)}>
                {meta.label}
              </span>
            )}
            {result.watchlist_tier === "mid_cap" && (
              <span className="rounded-full px-2 py-0.5 text-xs font-medium bg-indigo-500/20 text-indigo-300 ring-1 ring-indigo-500/30">
                Mid-Cap
              </span>
            )}
          </div>
          <Badge variant={scoreVariant(result.score)} className="text-sm font-bold px-3 py-1 shrink-0">
            {fmt(result.score, 0)}
          </Badge>
        </div>

        <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
          <span className="font-medium text-foreground/80">{fmtCurrency(result.underlying_price)}</span>
          <span>·</span>
          <span>{timeAgo(result.scanned_at)}</span>
          {result.expiration_date && (
            <><span>·</span><span>Exp {result.expiration_date}</span></>
          )}
        </div>
      </CardHeader>

      <CardContent className="pb-4">
        {/* Metrics grid */}
        <div className="grid grid-cols-3 gap-2 mb-3">
          <MetricCell label="IVR" value={`${fmt(result.iv_rank, 0)}%`} highlight={result.iv_rank >= 50} />
          <MetricCell label="IV30" value={fmtPct(result.iv30)} highlight={result.iv30 >= 0.4} />
          <MetricCell label="PoP" value={`${fmt(result.pop, 0)}%`} highlight={result.pop >= 70} />
        </div>

        {/* Win rate + skew row */}
        <div className="flex items-center justify-between text-xs mb-2 gap-2">
          {result.backtest_win_rate != null ? (
            <div className="flex items-center gap-1">
              <BarChart2 size={11} className="text-muted-foreground" />
              <span className="text-muted-foreground">Hist win:</span>
              <span className={cn("font-semibold", winRateColor(result.backtest_win_rate))}>
                {fmt(result.backtest_win_rate, 0)}%
              </span>
            </div>
          ) : <div />}

          {result.skew_25d != null && (
            <div className={cn("flex items-center gap-1", hasSkewAlert ? "text-yellow-400" : "text-muted-foreground")}>
              {result.skew_25d > 0 ? <ArrowUpRight size={11} /> : result.skew_25d < 0 ? <ArrowDownRight size={11} /> : <Minus size={11} />}
              <span>Skew {result.skew_25d > 0 ? "+" : ""}{fmt(result.skew_25d, 3)}</span>
              {hasSkewAlert && (
                <span className="rounded-full px-1.5 py-0.5 text-[10px] font-semibold bg-yellow-500/20 text-yellow-300 ml-0.5">
                  spike
                </span>
              )}
            </div>
          )}
        </div>

        {/* Strikes + credit */}
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground font-mono">{strikeDisplay}</span>
          {result.credit != null && result.credit > 0 && (
            <span className="text-green-400 font-semibold">+{fmtCurrency(result.credit)} cr</span>
          )}
        </div>

        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mt-3 transition-colors"
        >
          {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          {expanded ? "Less" : "Details"}
        </button>

        {expanded && (
          <div className="mt-3 pt-3 border-t border-border/50 grid grid-cols-2 gap-2 text-xs">
            <DetailRow label="Implied Move"  value={fmtPct(result.implied_move)} />
            <DetailRow label="Gamma/Theta"   value={result.gamma_theta_ratio != null ? fmt(result.gamma_theta_ratio, 4) : "—"} />
            <DetailRow label="52w IV High"   value={result.iv52w_high != null ? fmtPct(result.iv52w_high) : "—"} />
            <DetailRow label="52w IV Low"    value={result.iv52w_low  != null ? fmtPct(result.iv52w_low)  : "—"} />
            {result.skew_z_score != null && (
              <DetailRow label="Skew Z-Score" value={fmt(result.skew_z_score, 2)} />
            )}
            {result.short_put_strike  && <DetailRow label="Short Put"  value={fmtCurrency(result.short_put_strike)}  />}
            {result.short_call_strike && <DetailRow label="Short Call" value={fmtCurrency(result.short_call_strike)} />}
            {result.long_put_strike   && <DetailRow label="Long Put"   value={fmtCurrency(result.long_put_strike)}   />}
            {result.long_call_strike  && <DetailRow label="Long Call"  value={fmtCurrency(result.long_call_strike)}  />}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function MetricCell({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="rounded-lg bg-muted/50 px-2 py-2 text-center">
      <div className="text-xs text-muted-foreground mb-0.5">{label}</div>
      <div className={cn("text-sm font-semibold", highlight ? "text-green-400" : "text-foreground")}>{value}</div>
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

// ─── Earnings tab ─────────────────────────────────────────────────────────────

const EARNINGS_REC_META = {
  sell_premium:       { label: "Sell Premium", color: "bg-green-500/20 text-green-300 ring-1 ring-green-500/30" },
  buy_premium:        { label: "Buy Premium",  color: "bg-red-500/20 text-red-300 ring-1 ring-red-500/30" },
  neutral:            { label: "Neutral",      color: "bg-yellow-500/20 text-yellow-300 ring-1 ring-yellow-500/30" },
  insufficient_data:  { label: "No Data",      color: "bg-gray-500/20 text-gray-400" },
};

function EarningsCard({ setup }: { setup: EarningsSetup }) {
  const rec = EARNINGS_REC_META[setup.recommendation];
  const moveEdge =
    setup.historicalAvgMove > 0
      ? setup.impliedMove / setup.historicalAvgMove
      : null;

  return (
    <Card className="border-border/60 hover:border-border transition-colors">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <span className="text-xl font-bold text-foreground">{setup.symbol}</span>
          <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-semibold", rec.color)}>
            {rec.label}
          </span>
        </div>
        <div className="text-xs text-muted-foreground">
          {setup.nextEarningsDate
            ? `Earnings ${setup.nextEarningsDate} (${setup.daysToEarnings}d)`
            : "Earnings date unknown"}
        </div>
      </CardHeader>

      <CardContent className="pb-4">
        <div className="grid grid-cols-2 gap-2 text-xs mb-3">
          <div className="rounded-lg bg-muted/50 p-2 text-center">
            <div className="text-muted-foreground mb-0.5">Implied ±</div>
            <div className="font-semibold text-foreground">{fmtPct(setup.impliedMove)}</div>
          </div>
          <div className="rounded-lg bg-muted/50 p-2 text-center">
            <div className="text-muted-foreground mb-0.5">Hist Avg ±</div>
            <div className="font-semibold text-foreground">{fmtPct(setup.historicalAvgMove)}</div>
          </div>
        </div>

        <div className="flex items-center justify-between text-xs">
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground">Hit rate:</span>
            <span className={cn("font-semibold", winRateColor(setup.historicalHitRate))}>
              {setup.sampleSize >= 3
                ? `${fmt(setup.historicalHitRate, 0)}% (${setup.sampleSize})`
                : "—"}
            </span>
          </div>
          {moveEdge != null && (
            <div className="text-muted-foreground">
              IV/hist ratio:{" "}
              <span className={cn("font-medium", moveEdge > 1.1 ? "text-green-400" : "text-foreground/70")}>
                {moveEdge.toFixed(2)}×
              </span>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Backtest tab ─────────────────────────────────────────────────────────────

const IVR_BAND_COLOR: Record<string, string> = {
  "30-50": "bg-yellow-500/20 text-yellow-300",
  "50-70": "bg-orange-500/20 text-orange-300",
  "70+":   "bg-red-500/20 text-red-300",
};

function BacktestRow({ band }: { band: StrategyBacktestResult }) {
  const winColor =
    band.winRate >= 65 ? "text-green-400"
    : band.winRate >= 50 ? "text-yellow-400"
    : "text-gray-400";

  return (
    <div className="flex items-center justify-between rounded-lg bg-muted/40 px-3 py-2.5 text-sm">
      <div className="flex items-center gap-2">
        <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold", IVR_BAND_COLOR[band.ivrBand] ?? "")}>
          IVR {band.ivrBand}
        </span>
      </div>
      <div className="flex items-center gap-5 text-xs">
        <div className="text-center">
          <div className="text-muted-foreground">Win rate</div>
          <div className={cn("font-bold text-sm", winColor)}>{fmt(band.winRate, 0)}%</div>
        </div>
        <div className="text-center">
          <div className="text-muted-foreground">Implied ±</div>
          <div className="font-medium">{fmtPct(band.avgImpliedMove)}</div>
        </div>
        <div className="text-center">
          <div className="text-muted-foreground">Actual ±</div>
          <div className="font-medium">{fmtPct(band.avgActualMove)}</div>
        </div>
        <div className="text-center">
          <div className="text-muted-foreground">n</div>
          <div className="font-medium">{band.sampleSize}</div>
        </div>
      </div>
    </div>
  );
}

function BacktestPanel({ symbol }: { symbol: string }) {
  const [data, setData] = useState<StrategyBacktestResult[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/backtest?symbol=${symbol}`)
      .then((r) => r.json())
      .then((j) => setData(j.result?.bands ?? []))
      .catch(() => setData([]))
      .finally(() => setLoading(false));
  }, [symbol]);

  if (loading) return <div className="text-xs text-muted-foreground">Loading…</div>;
  if (!data || data.length === 0) return <div className="text-xs text-muted-foreground">Insufficient data</div>;

  return (
    <div className="flex flex-col gap-1.5">
      {data.map((b) => <BacktestRow key={b.ivrBand} band={b} />)}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

type Tab = "scan" | "earnings" | "backtest";
type StrategyFilter = "all" | "short_strangle" | "iron_condor" | "cash_secured_put" | "covered_call";
type ScoreFilter = "all" | "high" | "mid";

const STRATEGY_FILTERS: Array<{ key: StrategyFilter; label: string }> = [
  { key: "all",             label: "All" },
  { key: "iron_condor",     label: "Iron Condor" },
  { key: "short_strangle",  label: "Short Strangle" },
  { key: "cash_secured_put", label: "CSP" },
  { key: "covered_call",    label: "Covered Call" },
];

export default function ScannerPage() {
  const [activeTab, setActiveTab]     = useState<Tab>("scan");
  const [results, setResults]         = useState<ScanResult[]>([]);
  const [earnings, setEarnings]       = useState<EarningsSetup[]>([]);
  const [scanning, setScanning]       = useState(false);
  const [earningsLoading, setEarningsLoading] = useState(false);
  const [error, setError]             = useState<string | null>(null);
  const [lastScan, setLastScan]       = useState<Date | null>(null);
  const [tier, setTier]               = useState<WatchlistTier | "all">("large_cap");
  const [strategyFilter, setStrategyFilter] = useState<StrategyFilter>("all");
  const [scoreFilter, setScoreFilter] = useState<ScoreFilter>("all");
  const [sortBy, setSortBy]           = useState<"score" | "ivr" | "pop">("score");
  const [notifEnabled, setNotifEnabled] = useState(false);
  const [toasts, setToasts]           = useState<ToastItem[]>([]);
  const toastIdRef                    = useRef(0);
  const [backtestSymbol, setBacktestSymbol] = useState<string | null>(null);

  // Earnings rec filter
  const [earningsRec, setEarningsRec] = useState<string>("all");

  const addToast = useCallback((symbol: string, message: string, type: ToastItem["type"] = "skew") => {
    const id = ++toastIdRef.current;
    setToasts((prev) => [...prev, { id, symbol, message, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 6000);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const requestNotifPermission = useCallback(async () => {
    if (!("Notification" in window)) return;
    const perm = await Notification.requestPermission();
    setNotifEnabled(perm === "granted");
  }, []);

  const fireBrowserNotif = useCallback((title: string, body: string) => {
    if (notifEnabled && "Notification" in window && Notification.permission === "granted") {
      new Notification(title, { body, icon: "/favicon.ico" });
    }
  }, [notifEnabled]);

  const runScan = useCallback(async () => {
    setScanning(true);
    setError(null);

    // Request notification permission on first scan if not already asked
    if (!notifEnabled && "Notification" in window && Notification.permission === "default") {
      void requestNotifPermission();
    }

    try {
      const res = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error ?? "Scan failed");

      const freshResults: ScanResult[] = json.results ?? [];
      setResults(freshResults);
      setLastScan(new Date());

      // Fire skew alerts
      const skewAlerts = freshResults.filter(
        (r) => r.skew_z_score != null && Math.abs(r.skew_z_score) >= 2
      );
      for (const r of skewAlerts) {
        const dir = (r.skew_25d ?? 0) > 0 ? "put-heavy" : "call-heavy";
        const msg = `Skew spike (z=${fmt(r.skew_z_score, 1)}, ${dir})`;
        addToast(r.symbol, msg, "skew");
        fireBrowserNotif(`${r.symbol} — Skew Alert`, msg);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unexpected error");
    } finally {
      setScanning(false);
    }
  }, [tier, notifEnabled, addToast, fireBrowserNotif, requestNotifPermission]);

  const loadEarnings = useCallback(async () => {
    setEarningsLoading(true);
    setError(null);
    try {
      const symbols =
        tier === "large_cap" ? LARGE_CAP_WATCHLIST.map((e) => e.symbol)
        : tier === "mid_cap"  ? MID_CAP_WATCHLIST.map((e) => e.symbol)
        : ALL_WATCHLIST.map((e) => e.symbol);

      const res = await fetch(`/api/earnings?symbols=${symbols.join(",")}`);
      const json = await res.json();
      if (!json.ok) throw new Error(json.error ?? "Earnings fetch failed");
      setEarnings(json.results ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unexpected error");
    } finally {
      setEarningsLoading(false);
    }
  }, [tier]);

  // Auto-load earnings tab on first visit
  useEffect(() => {
    if (activeTab === "earnings" && earnings.length === 0 && !earningsLoading) {
      loadEarnings();
    }
  }, [activeTab]); // eslint-disable-line react-hooks/exhaustive-deps

  const filteredResults = useMemo(() => {
    let out = results.filter((r) => r.strategy !== "skip");

    if (strategyFilter !== "all") out = out.filter((r) => r.strategy === strategyFilter);
    if (scoreFilter === "high")   out = out.filter((r) => r.score >= 65);
    if (scoreFilter === "mid")    out = out.filter((r) => r.score >= 40);

    return out.sort((a, b) => {
      if (sortBy === "score") return b.score   - a.score;
      if (sortBy === "ivr")   return b.iv_rank - a.iv_rank;
      if (sortBy === "pop")   return b.pop     - a.pop;
      return 0;
    });
  }, [results, strategyFilter, scoreFilter, sortBy]);

  const filteredEarnings = useMemo(() => {
    if (earningsRec === "all") return earnings;
    return earnings.filter((e) => e.recommendation === earningsRec);
  }, [earnings, earningsRec]);

  const counts = useMemo(() => {
    const out: Record<string, number> = { all: 0 };
    for (const r of results) {
      if (r.strategy === "skip") continue;
      out.all = (out.all ?? 0) + 1;
      out[r.strategy] = (out[r.strategy] ?? 0) + 1;
    }
    return out;
  }, [results]);

  const backtestSymbols = useMemo(
    () => [...new Set(results.map((r) => r.symbol))].sort(),
    [results]
  );

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border/50 bg-card/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 py-3">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-primary/20 flex items-center justify-center">
                <TrendingUp size={16} className="text-primary" />
              </div>
              <div>
                <h1 className="text-sm font-bold text-foreground leading-none">Options Scanner</h1>
                <p className="text-xs text-muted-foreground mt-0.5">Premium-selling edge</p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              {lastScan && (
                <span className="text-xs text-muted-foreground hidden sm:block">
                  {timeAgo(lastScan.toISOString())}
                </span>
              )}
              <button
                onClick={notifEnabled ? undefined : requestNotifPermission}
                className={cn(
                  "p-2 rounded-md transition-colors",
                  notifEnabled
                    ? "text-primary bg-primary/10"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted"
                )}
                title={notifEnabled ? "Notifications on" : "Enable notifications"}
              >
                {notifEnabled ? <Bell size={15} /> : <BellOff size={15} />}
              </button>
              {activeTab === "scan" && (
                <Button onClick={runScan} disabled={scanning} size="sm" className="gap-2">
                  <RefreshCw size={14} className={cn(scanning && "animate-spin")} />
                  {scanning ? "Scanning…" : "Scan Now"}
                </Button>
              )}
              {activeTab === "earnings" && (
                <Button onClick={loadEarnings} disabled={earningsLoading} size="sm" variant="secondary" className="gap-2">
                  <RefreshCw size={14} className={cn(earningsLoading && "animate-spin")} />
                  {earningsLoading ? "Loading…" : "Refresh"}
                </Button>
              )}
            </div>
          </div>

          {/* Tab bar */}
          <div className="flex gap-1 mt-3 -mb-px">
            {(
              [
                { key: "scan",     label: "Scanner",  icon: <Activity size={13} /> },
                { key: "earnings", label: "Earnings", icon: <Calendar size={13} /> },
                { key: "backtest", label: "Backtest", icon: <BarChart2 size={13} /> },
              ] as Array<{ key: Tab; label: string; icon: React.ReactNode }>
            ).map(({ key, label, icon }) => (
              <button
                key={key}
                onClick={() => setActiveTab(key)}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-t-md border-b-2 transition-colors",
                  activeTab === key
                    ? "border-primary text-primary bg-primary/5"
                    : "border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/50"
                )}
              >
                {icon}
                {label}
              </button>
            ))}
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-6">
        {error && (
          <div className="flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm mb-5">
            <AlertCircle size={15} className="text-red-400 shrink-0 mt-0.5" />
            <span className="text-red-300">{error}</span>
          </div>
        )}

        {/* ── SCAN TAB ───────────────────────────────────────────────── */}
        {activeTab === "scan" && (
          <>
            {/* Watchlist tier selector */}
            <div className="flex items-center gap-2 mb-4 flex-wrap">
              <span className="text-xs text-muted-foreground font-medium mr-1">Universe:</span>
              {([
                { key: "large_cap", label: `Large-Cap (${LARGE_CAP_WATCHLIST.length})` },
                { key: "mid_cap",   label: `Mid-Cap (${MID_CAP_WATCHLIST.length})` },
                { key: "all",       label: `All (${ALL_WATCHLIST.length})` },
              ] as Array<{ key: WatchlistTier | "all"; label: string }>).map(({ key, label }) => (
                <FilterPill
                  key={key}
                  label={label}
                  active={tier === key}
                  onClick={() => setTier(key)}
                  colorClass={
                    key === "mid_cap"
                      ? "bg-indigo-500/20 text-indigo-300 border-indigo-500/40"
                      : undefined
                  }
                />
              ))}
            </div>

            {results.length > 0 && (
              <>
                {/* Stats */}
                <div className="grid grid-cols-3 gap-3 mb-5">
                  <StatCard label="Opportunities" value={counts.all ?? 0} icon={<Activity size={14} />} />
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

                {/* Filters */}
                <div className="flex flex-wrap gap-2 mb-5 items-center">
                  <span className="text-xs text-muted-foreground font-medium mr-1">Strategy:</span>
                  {STRATEGY_FILTERS.map(({ key, label }) => (
                    <FilterPill
                      key={key}
                      label={key === "all" ? `${label} (${counts.all ?? 0})` : `${label}${counts[key] ? ` (${counts[key]})` : ""}`}
                      active={strategyFilter === key}
                      onClick={() => setStrategyFilter(key)}
                      colorClass={key !== "all" ? STRATEGY_META[key]?.color : undefined}
                    />
                  ))}

                  <span className="text-xs text-muted-foreground font-medium ml-3 mr-1">Score:</span>
                  {(["all", "high", "mid"] as ScoreFilter[]).map((k) => (
                    <FilterPill
                      key={k}
                      label={k === "all" ? "All" : k === "high" ? "High (65+)" : "Mid (40+)"}
                      active={scoreFilter === k}
                      onClick={() => setScoreFilter(k)}
                    />
                  ))}

                  <div className="ml-auto flex items-center gap-1.5">
                    <span className="text-xs text-muted-foreground">Sort:</span>
                    {(["score", "ivr", "pop"] as const).map((s) => (
                      <FilterPill key={s} label={s.toUpperCase()} active={sortBy === s} onClick={() => setSortBy(s)} />
                    ))}
                  </div>
                </div>
              </>
            )}

            {results.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-24 gap-4 text-center">
                <div className="w-16 h-16 rounded-2xl bg-muted/50 flex items-center justify-center">
                  <Activity size={28} className="text-muted-foreground" />
                </div>
                <div>
                  <p className="font-semibold text-lg">No results yet</p>
                  <p className="text-muted-foreground text-sm mt-1">
                    Select a universe and run the scanner
                  </p>
                </div>
                <Button onClick={runScan} size="sm">Run Scanner</Button>
              </div>
            ) : filteredResults.length === 0 ? (
              <p className="text-center py-16 text-muted-foreground text-sm">
                No results match the current filters.
              </p>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {filteredResults.map((r) => (
                  <ResultCard key={r.id ?? r.symbol} result={r} />
                ))}
              </div>
            )}
          </>
        )}

        {/* ── EARNINGS TAB ───────────────────────────────────────────── */}
        {activeTab === "earnings" && (
          <>
            <div className="flex items-center gap-2 mb-5 flex-wrap">
              <span className="text-xs text-muted-foreground font-medium mr-1">Recommendation:</span>
              {([
                { key: "all",              label: "All" },
                { key: "sell_premium",     label: "Sell" },
                { key: "buy_premium",      label: "Buy" },
                { key: "neutral",          label: "Neutral" },
                { key: "insufficient_data", label: "No Data" },
              ] as const).map(({ key, label }) => (
                <FilterPill
                  key={key}
                  label={label}
                  active={earningsRec === key}
                  onClick={() => setEarningsRec(key)}
                  colorClass={
                    key === "sell_premium" ? "bg-green-500/20 text-green-300 border-green-500/40"
                    : key === "buy_premium" ? "bg-red-500/20 text-red-300 border-red-500/40"
                    : undefined
                  }
                />
              ))}
            </div>

            {earningsLoading ? (
              <div className="flex items-center justify-center py-24 gap-3 text-muted-foreground">
                <RefreshCw size={20} className="animate-spin" />
                <span>Loading earnings data…</span>
              </div>
            ) : filteredEarnings.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-24 gap-4 text-center">
                <div className="w-16 h-16 rounded-2xl bg-muted/50 flex items-center justify-center">
                  <Calendar size={28} className="text-muted-foreground" />
                </div>
                <div>
                  <p className="font-semibold text-lg">No earnings data</p>
                  <p className="text-muted-foreground text-sm mt-1">
                    Click Refresh to load earnings setups
                  </p>
                </div>
                <Button onClick={loadEarnings} size="sm">Load Earnings</Button>
              </div>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {filteredEarnings.map((e) => (
                  <EarningsCard key={e.symbol} setup={e} />
                ))}
              </div>
            )}
          </>
        )}

        {/* ── BACKTEST TAB ───────────────────────────────────────────── */}
        {activeTab === "backtest" && (
          <>
            <div className="mb-2 text-xs text-muted-foreground">
              Win rate = % of rolling 35-day windows where underlying moved{" "}
              <em>less</em> than the 1σ implied move (realised-vol basis).{" "}
              Higher = better edge for premium sellers.
            </div>

            {backtestSymbols.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-24 gap-4 text-center">
                <div className="w-16 h-16 rounded-2xl bg-muted/50 flex items-center justify-center">
                  <BarChart2 size={28} className="text-muted-foreground" />
                </div>
                <div>
                  <p className="font-semibold text-lg">Run a scan first</p>
                  <p className="text-muted-foreground text-sm mt-1">
                    Backtest data is available for scanned symbols
                  </p>
                </div>
                <Button onClick={() => setActiveTab("scan")} size="sm" variant="secondary">
                  Go to Scanner
                </Button>
              </div>
            ) : (
              <div className="flex flex-col gap-6">
                {/* Symbol selector */}
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs text-muted-foreground font-medium">Symbol:</span>
                  {backtestSymbols.map((s) => (
                    <FilterPill
                      key={s}
                      label={s}
                      active={backtestSymbol === s}
                      onClick={() => setBacktestSymbol((prev) => (prev === s ? null : s))}
                    />
                  ))}
                </div>

                {backtestSymbol ? (
                  <div className="rounded-xl border border-border/60 bg-card p-5">
                    <h3 className="text-sm font-semibold mb-3 text-foreground">
                      {backtestSymbol} — Rolling 35-DTE Premium-Sell Simulation
                    </h3>
                    <BacktestPanel symbol={backtestSymbol} />
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Select a symbol above to view its backtest breakdown.
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </main>

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
