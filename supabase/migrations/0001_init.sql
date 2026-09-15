-- Plot receipt printing — initial schema.
-- Spec §9 Option A: the receipt number comes from a Postgres sequence with a
-- UNIQUE constraint, so two staff printing at the same moment cannot collide.

create extension if not exists pgcrypto;

-- Receipt numbers are 4-digit zero-padded text: 0012, 0013, ...
-- Change `start with` before going live if you are continuing an existing book.
create sequence if not exists receipt_no_seq start with 12;

create table if not exists receipts (
  id           uuid primary key default gen_random_uuid(),
  receipt_no   text not null unique
                 default lpad(nextval('receipt_no_seq')::text, 4, '0'),
  data         jsonb not null,          -- runtime field values as entered
  amount_paise bigint not null check (amount_paise >= 0),
  created_at   timestamptz not null default now()
);

-- A manually entered receipt number must not leave the sequence behind it, or
-- the next automatic number collides and the insert fails. Bump it here rather
-- than making every caller remember.
create or replace function sync_receipt_no_seq() returns trigger
language plpgsql as $$
declare n bigint;
begin
  n := nullif(regexp_replace(new.receipt_no, '\D', '', 'g'), '')::bigint;
  if n is not null and n > (select last_value from receipt_no_seq) then
    perform setval('receipt_no_seq', n);
  end if;
  return new;
end $$;

drop trigger if exists receipts_sync_seq on receipts;
create trigger receipts_sync_seq after insert on receipts
  for each row execute function sync_receipt_no_seq();

create table if not exists print_jobs (
  id              uuid primary key default gen_random_uuid(),
  receipt_id      uuid not null references receipts(id) on delete cascade,
  status          text not null default 'PENDING'
                    check (status in ('PENDING','PRINTING','SUCCESS','FAILED','CANCELLED')),
  -- Rule 6: a retry must never be able to produce a second physical receipt.
  idempotency_key text not null unique,
  payload         text not null,        -- finished ESC/POS bytes, base64; the agent just writes them
  attempts        int not null default 0,
  is_reprint      boolean not null default false,
  error           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists print_jobs_pending_idx
  on print_jobs (created_at) where status = 'PENDING';
create index if not exists receipts_created_idx on receipts (created_at desc);

-- One row. The agent heartbeats into it; the UI reads it to show Agent:
-- Online/Offline. Printer status originates here and nowhere else (rule 4).
create table if not exists agent_status (
  id                text primary key default 'only' check (id = 'only'),
  last_seen         timestamptz not null default now(),
  printer_connected boolean not null default false,
  port              text,
  note              text
);

-- Claim exactly one pending job, atomically. Two agents, or one agent whose
-- poll overlaps itself, can never claim the same job.
create or replace function claim_print_job()
returns print_jobs language plpgsql as $$
declare job print_jobs;
begin
  update print_jobs p
     set status = 'PRINTING', attempts = p.attempts + 1, updated_at = now()
   where p.id = (
     select id from print_jobs
      where status = 'PENDING'
      order by created_at
      limit 1
      for update skip locked
   )
  returning p.* into job;
  return job;
end $$;

alter table receipts    enable row level security;
alter table print_jobs  enable row level security;
alter table agent_status enable row level security;

-- No authentication in this build, by decision. The anon key may read history
-- and agent status; it may NOT write. Every write goes through the Next.js
-- server with the service-role key, which never reaches the browser (rule 5).
-- Dropped first so this migration can be re-run against an existing database.
drop policy if exists receipts_read     on receipts;
drop policy if exists print_jobs_read   on print_jobs;
drop policy if exists agent_status_read on agent_status;

create policy receipts_read     on receipts     for select to anon, authenticated using (true);
create policy print_jobs_read   on print_jobs   for select to anon, authenticated using (true);
create policy agent_status_read on agent_status for select to anon, authenticated using (true);
