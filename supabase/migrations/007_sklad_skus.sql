-- The firm's SKU catalogue (warehouse firms): {"<name>": {"code": "00001", "aliases": ["5л"]}}.
alter table firms add column if not exists skus jsonb not null default '{}'::jsonb;
