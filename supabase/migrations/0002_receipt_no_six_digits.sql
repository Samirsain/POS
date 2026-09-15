-- Receipt numbers become six plain digits: 000001, 000002, ...
-- No prefix, no letters. The stored value and the printed value are now the
-- same string, so nothing has to reformat it on the way to the paper.

alter table receipts
  alter column receipt_no set default lpad(nextval('receipt_no_seq')::text, 6, '0');

-- Existing rows were four digits. Re-pad them so the column is consistent and
-- the history list sorts the way it reads.
update receipts set receipt_no = lpad(regexp_replace(receipt_no, '\D', '', 'g'), 6, '0')
 where receipt_no !~ '^\d{6}$';
