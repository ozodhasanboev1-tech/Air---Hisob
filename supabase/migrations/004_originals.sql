-- The original Telegram post behind each shipment: its text, or the photo stored in the private
-- "originals" bucket ({text, photo, from, at}). Shown in the app as «Asli».
alter table entries add column if not exists original jsonb;

insert into storage.buckets (id, name, public)
values ('originals', 'originals', false)
on conflict (id) do nothing;
