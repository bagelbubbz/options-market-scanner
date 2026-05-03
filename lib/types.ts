// ─── Strategy types ────────────────────────────────────────────────────────────
export type Strategy =
  | "short_strangle"
  | "iron_condor"
  | "cash_secured_put"
  | "covered_call"
  | "skip";

// ─── Tradier API shapes ────────────────────────────────────────────────────────
export interface TradierQuote {
  symbol: string;
  last: number;
  bid: number;
  ask: number;
  volume: number;
  average_volume: number;
  week_52_high: number;
  week_52_low: number;
  change_percentage: number;
}

export interface TradierOptionContract {
  symbol: string;
  description: string;
  exch: string;
  type: string;
  last: number | null;
  change: number | null;
  volume: number;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  bid: number;
  ask: number;
  underlying: string;
  strike: number;
  change_percentage: number | null;
  average_volume: number;
  last_volume: number;
  trade_date: number;
  prevclose: number | null;
  week_52_high: number;
  week_52_low: number;
  bidsize: number;
  bidexch: string;
  bid_date: number;
  asksize: number;
  askexch: string;
  ask_date: number;
  open_interest: number;
  contract_size: number;
  expiration_date: string;
  expiration_type: string;
  option_type: "call" | "put";
  root_symbol: string;
  greeks?: TradierGreeks;
}

export interface TradierGreeks {
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  rho: number;
  phi: number;
  bid_iv: number;
  mid_iv: number;
  ask_iv: number;
  smv_vol: number;
  updated_at: string;
}

export interface TradierHistoricalDay {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface OptionsChain {
  underlyingPrice: number;
  symbol: string;
  expirationDate: string;
  daysToExpiry: number;
  options: TradierOptionContract[];
}

export interface PriceHistory {
  symbol: string;
  days: TradierHistoricalDay[];
}

// ─── Computed metrics ──────────────────────────────────────────────────────────
export interface TickerMetrics {
  symbol: string;
  underlyingPrice: number;
  iv30: number;
  iv52wHigh: number;
  iv52wLow: number;
  ivRank: number;
  pop: number;
  impliedMove: number;
  gammaThetaRatio: number;
  score: number;
  strategy: Strategy;
  expirationDate: string;
  daysToExpiry: number;
  shortPutStrike?: number;
  shortCallStrike?: number;
  longPutStrike?: number;
  longCallStrike?: number;
  credit: number;
  averageDailyVolume: number;
  optionLiquidity: number;
}

// ─── Scan result (DB row shape) ─────────────────────────────────────────────────
export interface ScanResult {
  id?: string;
  symbol: string;
  underlying_price: number;
  iv30: number;
  iv_rank: number;
  iv52w_high?: number;
  iv52w_low?: number;
  pop: number;
  score: number;
  strategy: Strategy;
  implied_move: number;
  gamma_theta_ratio?: number;
  expiration_date?: string;
  short_put_strike?: number;
  short_call_strike?: number;
  long_put_strike?: number;
  long_call_strike?: number;
  credit?: number;
  scanned_at: string;
}

// ─── Filter config ─────────────────────────────────────────────────────────────
export interface Tier1FilterConfig {
  minIVR: number;
  minIV30: number;
  minAvgDailyVolume: number;
  minOptionOI: number;
  maxDaysToExpiry: number;
  minDaysToExpiry: number;
}
