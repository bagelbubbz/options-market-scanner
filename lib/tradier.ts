import type {
  OptionsChain,
  PriceHistory,
  TradierOptionContract,
  TradierHistoricalDay,
  TradierQuote,
} from "./types";

const BASE_URL = process.env.TRADIER_BASE_URL ?? "https://sandbox.tradier.com/v1";
const TOKEN = process.env.TRADIER_API_TOKEN ?? "";

const HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: "application/json",
};

// ─── Helpers ───────────────────────────────────────────────────────────────────

function daysUntil(dateStr: string): number {
  const now = new Date();
  const target = new Date(dateStr);
  return Math.round((target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}

async function tradierGet<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(`${BASE_URL}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const res = await fetch(url.toString(), {
    headers: HEADERS,
    next: { revalidate: 0 },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Tradier ${path} → ${res.status}: ${body}`);
  }

  return res.json() as Promise<T>;
}

// ─── Quote ────────────────────────────────────────────────────────────────────

export async function getQuote(symbol: string): Promise<TradierQuote> {
  const data = await tradierGet<{ quotes: { quote: TradierQuote | TradierQuote[] } }>(
    "/markets/quotes",
    { symbols: symbol, greeks: "false" }
  );
  const quote = data.quotes.quote;
  return Array.isArray(quote) ? quote[0] : quote;
}

// ─── Option expirations ───────────────────────────────────────────────────────

export async function getExpirations(symbol: string): Promise<string[]> {
  const data = await tradierGet<{ expirations: { date: string[] } | null }>(
    "/markets/options/expirations",
    { symbol, includeAllRoots: "true", strikes: "false" }
  );
  return data.expirations?.date ?? [];
}

/**
 * Returns the nearest monthly expiration that falls within the [minDTE, maxDTE] window.
 * Monthly expirations are the 3rd Friday of each month.
 */
export function selectExpiration(
  expirations: string[],
  minDTE = 21,
  maxDTE = 45
): string | null {
  const candidates = expirations
    .map((d) => ({ date: d, dte: daysUntil(d) }))
    .filter(({ dte }) => dte >= minDTE && dte <= maxDTE)
    .sort((a, b) => a.dte - b.dte);

  return candidates[0]?.date ?? null;
}

// ─── Options chain ─────────────────────────────────────────────────────────────

export async function getOptionsChain(
  symbol: string,
  expiration: string
): Promise<OptionsChain> {
  const quote = await getQuote(symbol);

  const data = await tradierGet<{
    options: { option: TradierOptionContract[] } | null;
  }>("/markets/options/chains", {
    symbol,
    expiration,
    greeks: "true",
  });

  const options = data.options?.option ?? [];

  return {
    symbol,
    underlyingPrice: quote.last ?? (quote.bid + quote.ask) / 2,
    expirationDate: expiration,
    daysToExpiry: daysUntil(expiration),
    options,
  };
}

// ─── Price / IV history ───────────────────────────────────────────────────────

export async function getPriceHistory(
  symbol: string,
  interval: "daily" | "weekly" | "monthly" = "daily",
  start?: string,
  end?: string
): Promise<PriceHistory> {
  const params: Record<string, string> = { symbol, interval };
  if (start) params.start = start;
  if (end) params.end = end;

  const data = await tradierGet<{
    history: { day: TradierHistoricalDay[] } | null;
  }>("/markets/history", params);

  return {
    symbol,
    days: data.history?.day ?? [],
  };
}

/**
 * Returns the last 252 trading days of price history (approx. 1 year).
 */
export async function getYearPriceHistory(symbol: string): Promise<PriceHistory> {
  const end = new Date();
  const start = new Date();
  start.setFullYear(start.getFullYear() - 1);

  return getPriceHistory(
    symbol,
    "daily",
    start.toISOString().slice(0, 10),
    end.toISOString().slice(0, 10)
  );
}

/**
 * Derives approximate historical IV from daily returns (annualised realised vol).
 * Returns an array of { date, iv } pairs aligned to the price-history dates,
 * using a 30-day rolling window.
 */
export function computeHistoricalIV(
  days: TradierHistoricalDay[],
  window = 30
): { date: string; iv: number }[] {
  if (days.length < window + 1) return [];

  const result: { date: string; iv: number }[] = [];

  for (let i = window; i < days.length; i++) {
    const slice = days.slice(i - window, i + 1);
    const logReturns = slice
      .slice(1)
      .map((d, idx) => Math.log(d.close / slice[idx].close));

    const mean = logReturns.reduce((s, r) => s + r, 0) / logReturns.length;
    const variance =
      logReturns.reduce((s, r) => s + (r - mean) ** 2, 0) /
      (logReturns.length - 1);
    const annualisedVol = Math.sqrt(variance * 252);

    result.push({ date: days[i].date, iv: annualisedVol });
  }

  return result;
}
