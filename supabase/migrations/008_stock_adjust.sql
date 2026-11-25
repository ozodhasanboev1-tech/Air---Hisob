-- Hand corrections of the warehouse stock (owner, 25.11.2026): kind 'adjust', items [{sku, qty}]
-- where qty is signed (+ adds boxes, − takes them away). Each correction is its own row, so the
-- history stays visible instead of the opening stock being overwritten.
alter table stock_docs drop constraint if exists stock_docs_kind_check;
alter table stock_docs add constraint stock_docs_kind_check check (kind in ('opening', 'out', 'in', 'return', 'adjust'));
