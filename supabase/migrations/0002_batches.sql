-- Group conversions by the upload session ("batch") they came from, so the UI
-- can show each upload as its own folder and offer per-batch downloads.
alter table public.conversions
  add column if not exists batch_id uuid;

create index if not exists conversions_batch_idx
  on public.conversions (user_id, batch_id);
