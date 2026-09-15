-- Where a receipt was printed.
--
--   'agent'  the office connector claims it from the queue and prints it
--   'device' the phone printed it itself over Bluetooth, through RawBT
--
-- Device jobs are inserted already finished, so claim_print_job() — which only
-- ever takes PENDING rows — can never hand one to the office printer as well.
-- That is what stops a receipt coming out twice in two places.

alter table print_jobs
  add column if not exists target text not null default 'agent'
    check (target in ('agent', 'device'));

comment on column print_jobs.target is
  'agent = printed by the office connector; device = printed by the phone over Bluetooth';
