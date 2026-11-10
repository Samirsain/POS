-- POS Thermal Printing System - Full Database Schema
-- Run this in Supabase SQL Editor for fresh setup

create extension if not exists pgcrypto;

-- 1. Receipt sequence (6 plain digits: 000001, 000002, ...)
create sequence if not exists receipt_no_seq start with 1;

-- 2. Receipts table
create table if not exists receipts (
  id           uuid primary key default gen_random_uuid(),
  receipt_no   text not null unique default lpad(nextval('receipt_no_seq')::text, 6, '0'),
  data         jsonb not null,          -- runtime field values as entered
  amount_paise bigint not null check (amount_paise >= 0),
  created_at   timestamptz not null default now()
);

-- Sync sequence if a receipt number was provided manually
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

-- 3. Print jobs table
create table if not exists print_jobs (
  id              uuid primary key default gen_random_uuid(),
  receipt_id      uuid references receipts(id) on delete cascade,
  status          text not null default 'PENDING'
                    check (status in ('PENDING','PRINTING','SUCCESS','FAILED','CANCELLED')),
  idempotency_key text not null unique,
  payload         text not null,        -- finished ESC/POS bytes, base64
  attempts        int not null default 0,
  is_reprint      boolean not null default false,
  target          text not null default 'agent' check (target in ('agent', 'device')),
  error           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists print_jobs_pending_idx
  on print_jobs (created_at) where status = 'PENDING';
create index if not exists receipts_created_idx on receipts (created_at desc);

-- 4. Agent status table (connector heartbeat)
create table if not exists agent_status (
  id                text primary key default 'only' check (id = 'only'),
  last_seen         timestamptz not null default now(),
  printer_connected boolean not null default false,
  port              text,
  note              text
);

-- Insert default row if not exists
insert into agent_status (id, last_seen, printer_connected, port, note)
values ('only', now(), false, null, null)
on conflict (id) do nothing;

-- 5. Atomic Claim Job Function (used by connector)
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

-- 6. Row Level Security policies
alter table receipts     enable row level security;
alter table print_jobs   enable row level security;
alter table agent_status enable row level security;

drop policy if exists receipts_read     on receipts;
drop policy if exists print_jobs_read   on print_jobs;
drop policy if exists agent_status_read on agent_status;

create policy receipts_read     on receipts     for select to anon, authenticated using (true);
create policy print_jobs_read   on print_jobs   for select to anon, authenticated using (true);
create policy agent_status_read on agent_status for select to anon, authenticated using (true);

