-- Conversion now happens in the browser, so the original .msg is no longer
-- uploaded to storage. Allow storage_path to be empty for these rows.
alter table public.conversions
  alter column storage_path drop not null;
