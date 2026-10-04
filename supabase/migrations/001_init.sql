-- Air hisob-kitobi: ledger tables. Accessed only through edge functions (service role);
-- RLS is on with no policies, so the public anon key cannot read or write anything.

create table if not exists public.entries (
  id          text primary key,
  kind        text not null check (kind in ('shipment','payment')),
  date        date not null,
  note        text not null default '',
  -- shipment fields
  items       jsonb not null default '[]'::jsonb,   -- [{name, qty, price}] price = USD per karobka
  total       numeric not null default 0,           -- USD
  -- payment fields
  method      text check (method in ('naqd','perechisleniya')),
  amount      numeric not null default 0,           -- USD
  sum_uzs     numeric,                              -- original so'm amount, if paid in so'm
  rate        numeric,                              -- 1$ = rate so'm
  -- bookkeeping
  source      text not null default 'app',          -- app | telegram | migrated
  sender      text,
  created_at  bigint not null default (extract(epoch from now())*1000)::bigint,
  updated_at  timestamptz not null default now()
);
create index if not exists entries_date_idx on public.entries (date);

create table if not exists public.meta (
  key         text primary key,                     -- 'prices' | 'telegram'
  value       jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

alter table public.entries enable row level security;
alter table public.meta    enable row level security;
revoke all on public.entries, public.meta from anon, authenticated;
grant all on public.entries, public.meta to service_role;
