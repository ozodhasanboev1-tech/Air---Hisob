-- Warehouse firms (SA Turkmenistan): stock in boxes per SKU, no money.
-- firms.kind = 'sklad' sends the group's posts here instead of to entries.
alter table firms add column if not exists kind text not null default 'ledger';

create table if not exists stock_docs (
  id text primary key,            -- tg-<chat>-<msg>-<n>, or <firm>-opening
  firm text not null references firms(id),
  kind text not null check (kind in ('opening', 'out', 'in', 'return')),
  date date not null,
  party text not null default '',
  items jsonb not null default '[]',   -- [{sku, qty, doubt?}]
  source text,
  sender text,
  original jsonb,
  created_at bigint not null,
  updated_at timestamptz not null default now()
);
create index if not exists stock_docs_firm_date on stock_docs (firm, date);
alter table stock_docs enable row level security;

insert into firms (id, name, kind, poster_name, prices, sort)
values ('sa', 'SA', 'sklad', 'izzat|иззат|alisher|алишер', '{}', 2)
on conflict (id) do update set kind = 'sklad', poster_name = excluded.poster_name;
grant all on table stock_docs to service_role;
