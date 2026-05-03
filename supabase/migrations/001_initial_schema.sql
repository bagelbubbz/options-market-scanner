-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- ─────────────────────────────────────────────────────────
-- tickers: the watchlist of underlyings to scan
-- ─────────────────────────────────────────────────────────
create table if not exists public.tickers (
  id           uuid primary key default uuid_generate_v4(),
  symbol       text not null unique,
  name         text,
  active       boolean not null default true,
  min_volume   bigint not null default 500000,   -- avg daily share volume threshold
  min_oi       integer not null default 500,      -- min option open interest
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Seed the default watchlist
insert into public.tickers (symbol, name) values
  ('AAPL',  'Apple Inc.'),
  ('MSFT',  'Microsoft Corporation'),
  ('NVDA',  'NVIDIA Corporation'),
  ('AMZN',  'Amazon.com Inc.'),
  ('SPY',   'SPDR S&P 500 ETF Trust'),
  ('QQQ',   'Invesco QQQ Trust'),
  ('JPM',   'JPMorgan Chase & Co.'),
  ('TSLA',  'Tesla Inc.')
on conflict (symbol) do nothing;

-- ─────────────────────────────────────────────────────────
-- scan_results: persisted output of each scanner run
-- ─────────────────────────────────────────────────────────
create table if not exists public.scan_results (
  id                  uuid primary key default uuid_generate_v4(),
  symbol              text not null,
  underlying_price    numeric(12, 4) not null,
  iv30                numeric(8, 4) not null,       -- current 30-day IV (decimal, e.g. 0.35)
  iv_rank             numeric(6, 2) not null,        -- IVR 0-100
  iv52w_high          numeric(8, 4),
  iv52w_low           numeric(8, 4),
  pop                 numeric(6, 2) not null,        -- probability of profit 0-100
  score               numeric(6, 2) not null,        -- composite score 0-100
  strategy            text not null
                        check (strategy in (
                          'short_strangle',
                          'iron_condor',
                          'cash_secured_put',
                          'covered_call',
                          'skip'
                        )),
  implied_move        numeric(8, 4) not null,        -- expected ±% move to expiry
  gamma_theta_ratio   numeric(10, 4),
  expiration_date     date,
  short_put_strike    numeric(10, 2),
  short_call_strike   numeric(10, 2),
  long_put_strike     numeric(10, 2),
  long_call_strike    numeric(10, 2),
  credit              numeric(10, 4),                -- premium collected per share
  scanned_at          timestamptz not null default now(),

  -- keep a full history; index the common query patterns
  constraint scan_results_score_check check (score between 0 and 100),
  constraint scan_results_ivr_check   check (iv_rank between 0 and 100)
);

create index if not exists idx_scan_results_scanned_at
  on public.scan_results (scanned_at desc);

create index if not exists idx_scan_results_symbol_scanned_at
  on public.scan_results (symbol, scanned_at desc);

create index if not exists idx_scan_results_strategy
  on public.scan_results (strategy);

create index if not exists idx_scan_results_score
  on public.scan_results (score desc);

-- ─────────────────────────────────────────────────────────
-- updated_at trigger for tickers
-- ─────────────────────────────────────────────────────────
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger tickers_set_updated_at
  before update on public.tickers
  for each row execute function public.set_updated_at();

-- ─────────────────────────────────────────────────────────
-- Row-level security (enable; default deny; service role bypasses)
-- ─────────────────────────────────────────────────────────
alter table public.tickers      enable row level security;
alter table public.scan_results enable row level security;

-- Allow anon/authenticated reads for the UI
create policy "public read tickers"
  on public.tickers for select using (true);

create policy "public read scan_results"
  on public.scan_results for select using (true);

-- Only service role (API route) can write
create policy "service insert scan_results"
  on public.scan_results for insert
  with check (auth.role() = 'service_role');

create policy "service write tickers"
  on public.tickers for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
