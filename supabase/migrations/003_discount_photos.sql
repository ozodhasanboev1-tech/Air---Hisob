-- Per-firm discount (Doctor: 13% off each counterparty's shipment) and the original gross amount.
alter table public.firms   add column if not exists discount_pct numeric not null default 0;
alter table public.entries add column if not exists gross numeric;          -- before discount, USD
alter table public.entries add column if not exists discount_pct numeric;   -- discount applied, %
