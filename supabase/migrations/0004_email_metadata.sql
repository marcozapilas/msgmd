-- M0: structured email metadata on conversions.
-- Additive only; conversions.markdown is immutable source data and is never
-- modified by any M0 statement. No RLS/grant changes required: existing
-- row-level policies and table-level grants automatically cover new columns.
alter table public.conversions
  add column if not exists sender_name  text,
  add column if not exists sender_email text,
  add column if not exists sent_at      timestamptz,
  add column if not exists recipients   jsonb;

create index if not exists conversions_user_sent_idx
  on public.conversions (user_id, sent_at);
