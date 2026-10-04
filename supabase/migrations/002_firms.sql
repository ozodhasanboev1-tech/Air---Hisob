-- Several suppliers (Air, Doctor Fresh, Timson, ...), each with its own Telegram group and ledger.

create table if not exists public.firms (
  id          text primary key,                       -- slug: 'air', 'timson', ...
  name        text not null,                          -- shown in the app and bot: 'Air', 'Timson'
  chat_id     bigint unique,                          -- the firm's Telegram group
  poster_ids  bigint[] not null default '{}',         -- who posts shipment lists in that group
  poster_name text,                                   -- fallback name match while poster_ids is empty
  prices      jsonb not null default '{}'::jsonb,     -- {lowercased product: USD per karobka}
  sort        int not null default 0,
  created_at  timestamptz not null default now()
);
alter table public.firms enable row level security;
revoke all on public.firms from anon, authenticated;
grant all on public.firms to service_role;

insert into public.firms (id, name, chat_id, poster_name, prices, sort)
select 'air', 'Air', -251095155, 'бобур|bobur',
       coalesce((select value->'items' from public.meta where key = 'prices'), '{}'::jsonb), 0
on conflict (id) do nothing;

alter table public.entries add column if not exists firm text not null default 'air' references public.firms(id);
create index if not exists entries_firm_idx on public.entries (firm, date);
