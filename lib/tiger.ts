import crypto from "crypto";
import type {
  OptionsChain,
  PriceHistory,
  TradierHistoricalDay,
  TradierOptionContract,
  TradierGreeks,
  TradierQuote,
} from "./types";

// ─── Config ───────────────────────────────────────────────────────────────────

const TIGER_ID      = process.env.TIGER_ID ?? "";
const TIGER_BASE_URL = "https://openapi.tigerbrokers.com/interface";

// Private key is stored as a single line with literal \n in .env.local
const PRIVATE_KEY = (process.env.TIGER_PRIVATE_KEY ?? "").replace(/\\n/g, "\n");

// ─── RSA signing ─────────────────────────────────────────────────────────────

function signRequest(
  params: Record<string, string>,
  privateKey: string
): string {
  const payload = Object.keys(params)
    .filter((k) => k !== "sign" && params[k] !== "")
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");

  const signer = crypto.createSign("RSA-SHA256");
  signer.update(payload, "utf8");
  return signer.sign(privateKey, "base64");
}

// ─── Core request ─────────────────────────────────────────────────────────────

async function tigerPost<T>(method: string, bizContent: object): Promise<T> {
  const params: Record<string, string> = {
    tiger_id:    TIGER_ID,
    sign_type:   "RSA",
    timestamp:   Date.now().toString(),
    charset:     "UTF-8",
    version:     "3.0",
    method,
    biz_content: JSON.stringify(bizContent),
  };

  params.sign = signRequest(params, PRIVATE_KEY);

  const res = await fetch(TIGER_BASE_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    new URLSearchParams(params).toString(),
    next:    { revalidate: 0 },
  });

  if (!res.ok) {
    throw new Error(`Tiger ${method} → HTTP ${res.status}`);
  }

  const json = await res.json();

  if (json.code !== 0) {
    throw new Error(`Tiger ${method} → code ${json.code}: ${json.message}`);
  }

  return json.data as T;
}

// ─── Quote ────────────────────────────────────────────────────────────────────

interface TigerQuoteItem {
  symbol:          string;
  latest_price:    number;
  bid_price:       number;
  ask_price:       number;
  volume:          number;
  avg_volume:      number;
  high_52_weeks:   number;
  low_52_weeks:    number;
  change_ratio:    number;
}

export async function getQuote(symbol: string): Promise<TradierQuote> {
  const data = await tigerPost<{ items: TigerQuoteItem[] }>(
    "quote_stock_trade",
    { symbols: [symbol], fields: ["latest_price","bid_price","ask_price","volume","avg_volume","high_52_weeks","low_52_weeks","change_ratio"] }
  );

  const q = data.items[0];
  if (!q) throw new Error(`No quote for ${symbol}`);

  return {
    symbol,
    last:             q.latest_price,
    bid:              q.bid_price,
    ask:              q.ask_price,
    volume:           q.volume,
    average_volume:   q.avg_volume,
    week_52_high:     q.high_52_weeks,
    week_52_low:      q.low_52_weeks,
    change_percentage: q.change_ratio * 100,
  };
}

// ─── Option expirations ───────────────────────────────────────────────────────

interface TigerExpirationsData {
  expiration_dates?: string[];  // ["2024-01-19", ...]
}

export async function getExpirations(symbol: string): Promise<string[]> {
  const data = await tigerPost<TigerExpirationsData>(
    "option_expiration",
    { symbol, market: "US" }
  );
  return data.expiration_dates ?? [];
}

export function selectExpiration(
  expirations: string[],
  minDTE = 21,
  maxDTE = 45
): string | null {
  const now = Date.now();
  const candidates = expirations
    .map((d) => ({ date: d, dte: Math.round((new Date(d).getTime() - now) / 86_400_000) }))
    .filter(({ dte }) => dte >= minDTE && dte <= maxDTE)
    .sort((a, b) => a.dte - b.dte);
  return candidates[0]?.date ?? null;
}

// ─── Options chain ─────────────────────────────────────────────────────────────

interface TigerOptionItem {
  symbol:             string;
  expiry:             string;
  strike:             number;
  right:              "CALL" | "PUT" | "C" | "P";
  bid:                number;
  ask:                number;
  last:               number | null;
  volume:             number;
  open_interest:      number;
  implied_volatility: number;   // decimal e.g. 0.35
  delta:              number;
  gamma:              number;
  theta:              number;
  vega:               number;
  rho:                number;
}

interface TigerChainData {
  items: TigerOptionItem[];
}

export async function getOptionsChain(
  symbol: string,
  expiration: string
): Promise<OptionsChain> {
  const quote = await getQuote(symbol);

  const data = await tigerPost<TigerChainData>(
    "option_chain",
    { symbol, expiry: expiration, market: "US" }
  );

  const dte = Math.round(
    (new Date(expiration).getTime() - Date.now()) / 86_400_000
  );

  const options: TradierOptionContract[] = (data.items ?? []).map((item) => {
    const isCall =
      item.right === "CALL" || item.right === "C";

    const greeks: TradierGreeks = {
      delta:      item.delta,
      gamma:      item.gamma,
      theta:      item.theta,
      vega:       item.vega,
      rho:        item.rho ?? 0,
      phi:        0,
      bid_iv:     item.implied_volatility,
      mid_iv:     item.implied_volatility,
      ask_iv:     item.implied_volatility,
      smv_vol:    item.implied_volatility,
      updated_at: new Date().toISOString(),
    };

    return {
      symbol:            item.symbol,
      description:       `${symbol} ${expiration} ${item.strike} ${isCall ? "Call" : "Put"}`,
      exch:              "US",
      type:              "option",
      last:              item.last,
      change:            null,
      volume:            item.volume,
      open:              null,
      high:              null,
      low:               null,
      close:             null,
      bid:               item.bid,
      ask:               item.ask,
      underlying:        symbol,
      strike:            item.strike,
      change_percentage: null,
      average_volume:    0,
      last_volume:       item.volume,
      trade_date:        Date.now(),
      prevclose:         null,
      week_52_high:      0,
      week_52_low:       0,
      bidsize:           0,
      bidexch:           "",
      bid_date:          Date.now(),
      asksize:           0,
      askexch:           "",
      ask_date:          Date.now(),
      open_interest:     item.open_interest,
      contract_size:     100,
      expiration_date:   expiration,
      expiration_type:   "standard",
      option_type:       isCall ? "call" : "put",
      root_symbol:       symbol,
      greeks,
    };
  });

  return {
    symbol,
    underlyingPrice: quote.last,
    expirationDate:  expiration,
    daysToExpiry:    dte,
    options,
  };
}

// ─── Price history ────────────────────────────────────────────────────────────

interface TigerBarItem {
  time:   number;   // unix ms
  open:   number;
  high:   number;
  low:    number;
  close:  number;
  volume: number;
}

interface TigerBarsData {
  bars?: TigerBarItem[];
  items?: TigerBarItem[];
}

export async function getPriceHistory(
  symbol:   string,
  _interval = "daily",
  start?:   string,
  end?:     string
): Promise<PriceHistory> {
  const bizContent: Record<string, unknown> = {
    symbol,
    period:     "day",
    market:     "US",
    limit:      252,
  };
  if (start) bizContent.begin_time = new Date(start).getTime();
  if (end)   bizContent.end_time   = new Date(end).getTime();

  const data = await tigerPost<TigerBarsData>("history_bar", bizContent);

  const raw = data.bars ?? data.items ?? [];

  const days: TradierHistoricalDay[] = raw
    .map((b) => ({
      date:   new Date(b.time).toISOString().slice(0, 10),
      open:   b.open,
      high:   b.high,
      low:    b.low,
      close:  b.close,
      volume: b.volume,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return { symbol, days };
}

export async function getYearPriceHistory(symbol: string): Promise<PriceHistory> {
  const end   = new Date();
  const start = new Date();
  start.setFullYear(start.getFullYear() - 1);
  return getPriceHistory(
    symbol,
    "daily",
    start.toISOString().slice(0, 10),
    end.toISOString().slice(0, 10)
  );
}

// ─── Historical IV (pure computation — unchanged from original) ───────────────

export function computeHistoricalIV(
  days: TradierHistoricalDay[],
  window = 30
): { date: string; iv: number }[] {
  if (days.length < window + 1) return [];

  const result: { date: string; iv: number }[] = [];

  for (let i = window; i < days.length; i++) {
    const slice      = days.slice(i - window, i + 1);
    const logReturns = slice
      .slice(1)
      .map((d, idx) => Math.log(d.close / slice[idx].close));

    const mean     = logReturns.reduce((s, r) => s + r, 0) / logReturns.length;
    const variance = logReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (logReturns.length - 1);

    result.push({ date: days[i].date, iv: Math.sqrt(variance * 252) });
  }

  return result;
}
