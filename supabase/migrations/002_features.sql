-- ─────────────────────────────────────────────────────────
-- Add watchlist_tier to tickers
-- ─────────────────────────────────────────────────────────
alter table public.tickers
  add column if not exists watchlist_tier text not null default 'large_cap'
    check (watchlist_tier in ('large_cap', 'mid_cap'));

-- Seed mid-cap watchlist (niche names most scanners ignore)
insert into public.tickers (symbol, name, watchlist_tier) values
  ('ROKU',  'Roku Inc.',                      'mid_cap'),
  ('SNAP',  'Snap Inc.',                      'mid_cap'),
  ('PLTR',  'Palantir Technologies',          'mid_cap'),
  ('RBLX',  'Roblox Corporation',             'mid_cap'),
  ('HOOD',  'Robinhood Markets',              'mid_cap'),
  ('SOFI',  'SoFi Technologies',              'mid_cap'),
  ('AFRM',  'Affirm Holdings',               'mid_cap'),
  ('DKNG',  'DraftKings Inc.',                'mid_cap'),
  ('PENN',  'PENN Entertainment',             'mid_cap'),
  ('MARA',  'Marathon Digital Holdings',      'mid_cap'),
  ('RIOT',  'Riot Platforms',                 'mid_cap'),
  ('COIN',  'Coinbase Global',                'mid_cap'),
  ('RIVN',  'Rivian Automotive',              'mid_cap'),
  ('PATH',  'UiPath Inc.',                    'mid_cap'),
  ('U',     'Unity Software',                'mid_cap'),
  ('CRWD',  'CrowdStrike Holdings',           'mid_cap'),
  ('DDOG',  'Datadog Inc.',                   'mid_cap'),
  ('NET',   'Cloudflare Inc.',                'mid_cap'),
  ('ZS',    'Zscaler Inc.',                   'mid_cap'),
  ('BILL',  'BILL Holdings',                  'mid_cap'),
  ('MDB',   'MongoDB Inc.',                   'mid_cap'),
  ('CFLT',  'Confluent Inc.',                 'mid_cap'),
  ('GTLB',  'GitLab Inc.',                    'mid_cap'),
  ('ESTC',  'Elastic N.V.',                   'mid_cap'),
  ('TER',   'Teradyne Inc.',                  'mid_cap')
on conflict (symbol) do update set watchlist_tier = excluded.watchlist_tier;

-- ─────────────────────────────────────────────────────────
-- skew_snapshots: 25-delta put/call IV skew over time
-- ─────────────────────────────────────────────────────────
create table if not exists public.skew_snapshots (
  id               uuid primary key default uuid_generate_v4(),
  symbol           text not null,
  skew_25d         numeric(8, 4) not null,   -- put25d_iv - call25d_iv (decimal)
  put_25d_iv       numeric(8, 4),
  call_25d_iv      numeric(8, 4),
  skew_z_score     numeric(8, 4),            -- z-score vs 30-day rolling mean
  alert_triggered  boolean not null default false,
  snapped_at       timestamptz not null default now()
);

create index if not exists idx_skew_symbol_snapped
  on public.skew_snapshots (symbol, snapped_at desc);

alter table public.skew_snapshots enable row level security;
create policy "public read skew_snapshots"
  on public.skew_snapshots for select using (true);
create policy "service insert skew_snapshots"
  on public.skew_snapshots for insert
  with check (auth.role() = 'service_role');

-- ─────────────────────────────────────────────────────────
-- earnings_history: historical earnings move data per ticker
-- ─────────────────────────────────────────────────────────
create table if not exists public.earnings_history (
  id                    uuid primary key default uuid_generate_v4(),
  symbol                text not null,
  earnings_date         date not null,
  implied_move          numeric(8, 4),   -- implied ±% on eve of earnings
  actual_move           numeric(8, 4),   -- realised ±% on earnings day
  premium_seller_won    boolean,         -- actual_move < implied_move
  fetched_at            timestamptz not null default now(),
  unique (symbol, earnings_date)
);

create index if not exists idx_earnings_symbol_date
  on public.earnings_history (symbol, earnings_date desc);

alter table public.earnings_history enable row level security;
create policy "public read earnings_history"
  on public.earnings_history for select using (true);
create policy "service write earnings_history"
  on public.earnings_history for insert
  with check (auth.role() = 'service_role');

-- ─────────────────────────────────────────────────────────
-- backtest_results: cached win-rate stats by symbol + IVR band
-- ─────────────────────────────────────────────────────────
create table if not exists public.backtest_results (
  id                uuid primary key default uuid_generate_v4(),
  symbol            text not null,
  strategy          text not null
                      check (strategy in (
                        'short_strangle','iron_condor',
                        'cash_secured_put','covered_call'
                      )),
  ivr_band          text not null
                      check (ivr_band in ('30-50','50-70','70+')),
  win_rate          numeric(6, 2) not null,  -- 0-100
  avg_implied_move  numeric(8, 4),
  avg_actual_move   numeric(8, 4),
  sample_size       integer not null,
  avg_dte           numeric(6, 1),
  computed_at       timestamptz not null default now(),
  unique (symbol, strategy, ivr_band)
);

alter table public.backtest_results enable row level security;
create policy "public read backtest_results"
  on public.backtest_results for select using (true);
create policy "service write backtest_results"
  on public.backtest_results for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- ─────────────────────────────────────────────────────────
-- Extend scan_results with new enrichment columns
-- ─────────────────────────────────────────────────────────
alter table public.scan_results
  add column if not exists skew_25d          numeric(8, 4),
  add column if not exists skew_z_score      numeric(8, 4),
  add column if not exists backtest_win_rate numeric(6, 2),
  add column if not exists watchlist_tier    text default 'large_cap';
