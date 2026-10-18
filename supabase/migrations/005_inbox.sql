-- Raw messages from groups the bot is in but that are not linked to a firm yet (e.g. a new firm
-- whose message format is still being studied). Nothing is booked from them.
create table if not exists inbox (
  id text primary key,            -- chat:message[:edit_date]
  chat_id bigint not null,
  chat_title text,
  message_id bigint not null,
  date timestamptz not null,
  from_id bigint,
  from_name text,
  text text,
  edited boolean not null default false,
  raw jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists inbox_chat_date on inbox (chat_id, date);
alter table inbox enable row level security;
grant all on table inbox to service_role;
