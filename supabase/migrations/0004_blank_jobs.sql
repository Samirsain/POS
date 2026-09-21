-- Free-text prints from /blank are not receipts: no number, no amount, nothing
-- to reprint. Their jobs carry no receipt row, and the queue works the same.
alter table print_jobs alter column receipt_id drop not null;
