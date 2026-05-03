export type WatchlistTier = "large_cap" | "mid_cap";

export interface WatchlistEntry {
  symbol: string;
  name: string;
  tier: WatchlistTier;
}

export const LARGE_CAP_WATCHLIST: WatchlistEntry[] = [
  { symbol: "AAPL",  name: "Apple Inc.",                tier: "large_cap" },
  { symbol: "MSFT",  name: "Microsoft Corporation",     tier: "large_cap" },
  { symbol: "NVDA",  name: "NVIDIA Corporation",        tier: "large_cap" },
  { symbol: "AMZN",  name: "Amazon.com Inc.",           tier: "large_cap" },
  { symbol: "SPY",   name: "SPDR S&P 500 ETF Trust",   tier: "large_cap" },
  { symbol: "QQQ",   name: "Invesco QQQ Trust",         tier: "large_cap" },
  { symbol: "JPM",   name: "JPMorgan Chase & Co.",      tier: "large_cap" },
  { symbol: "TSLA",  name: "Tesla Inc.",                tier: "large_cap" },
];

// Mid-caps with historically elevated IV and less scanner coverage
export const MID_CAP_WATCHLIST: WatchlistEntry[] = [
  { symbol: "ROKU",  name: "Roku Inc.",                 tier: "mid_cap" },
  { symbol: "SNAP",  name: "Snap Inc.",                 tier: "mid_cap" },
  { symbol: "PLTR",  name: "Palantir Technologies",     tier: "mid_cap" },
  { symbol: "RBLX",  name: "Roblox Corporation",        tier: "mid_cap" },
  { symbol: "HOOD",  name: "Robinhood Markets",         tier: "mid_cap" },
  { symbol: "SOFI",  name: "SoFi Technologies",         tier: "mid_cap" },
  { symbol: "AFRM",  name: "Affirm Holdings",           tier: "mid_cap" },
  { symbol: "DKNG",  name: "DraftKings Inc.",           tier: "mid_cap" },
  { symbol: "PENN",  name: "PENN Entertainment",        tier: "mid_cap" },
  { symbol: "MARA",  name: "Marathon Digital Holdings", tier: "mid_cap" },
  { symbol: "RIOT",  name: "Riot Platforms",            tier: "mid_cap" },
  { symbol: "COIN",  name: "Coinbase Global",           tier: "mid_cap" },
  { symbol: "RIVN",  name: "Rivian Automotive",         tier: "mid_cap" },
  { symbol: "PATH",  name: "UiPath Inc.",               tier: "mid_cap" },
  { symbol: "U",     name: "Unity Software",            tier: "mid_cap" },
  { symbol: "CRWD",  name: "CrowdStrike Holdings",      tier: "mid_cap" },
  { symbol: "DDOG",  name: "Datadog Inc.",              tier: "mid_cap" },
  { symbol: "NET",   name: "Cloudflare Inc.",           tier: "mid_cap" },
  { symbol: "ZS",    name: "Zscaler Inc.",              tier: "mid_cap" },
  { symbol: "BILL",  name: "BILL Holdings",             tier: "mid_cap" },
  { symbol: "MDB",   name: "MongoDB Inc.",              tier: "mid_cap" },
  { symbol: "CFLT",  name: "Confluent Inc.",            tier: "mid_cap" },
  { symbol: "GTLB",  name: "GitLab Inc.",               tier: "mid_cap" },
  { symbol: "ESTC",  name: "Elastic N.V.",              tier: "mid_cap" },
  { symbol: "TER",   name: "Teradyne Inc.",             tier: "mid_cap" },
];

export const ALL_WATCHLIST = [...LARGE_CAP_WATCHLIST, ...MID_CAP_WATCHLIST];

export function getSymbolsByTier(tier: WatchlistTier | "all"): string[] {
  if (tier === "all") return ALL_WATCHLIST.map((e) => e.symbol);
  if (tier === "large_cap") return LARGE_CAP_WATCHLIST.map((e) => e.symbol);
  return MID_CAP_WATCHLIST.map((e) => e.symbol);
}

export function getTierForSymbol(symbol: string): WatchlistTier {
  const entry = ALL_WATCHLIST.find((e) => e.symbol === symbol.toUpperCase());
  return entry?.tier ?? "large_cap";
}
