-- ============================================================================
-- M0 Script B — post-backfill representative samples (read-only).
-- Run each query separately (or the whole file 4 times, one query at a time)
-- so you can copy each result set.
-- ============================================================================

-- B1) sent_at IS NULL rows (expected: empty)
select id, source_name,
       (regexp_match(markdown, '\n- \*\*Date:\*\* ([^\n]+)'))[1] as date_line
from public.conversions
where status = 'done' and markdown is not null and sent_at is null
limit 10;

-- B2) sender_email IS NULL rows (expected: DN / name-only senders)
select id, source_name,
       (regexp_match(markdown, '\n- \*\*From:\*\* ([^\n]+)'))[1] as from_line,
       sender_name
from public.conversions
where status = 'done' and markdown is not null and sender_email is null
limit 10;

-- B3) ambiguous recipients (expected: ~0 rows)
select id, source_name,
       (regexp_match(markdown, '\n- \*\*To:\*\* ([^\n]+)'))[1] as to_line,
       (regexp_match(markdown, '\n- \*\*Cc:\*\* ([^\n]+)'))[1] as cc_line,
       recipients
from public.conversions
where status = 'done' and markdown is not null
  and recipients->>'ambiguous' = 'true'
limit 10;

-- B4) five random populated rows: markdown vs columns side by side
select id, source_name,
       (regexp_match(markdown, '\n- \*\*From:\*\* ([^\n]+)'))[1] as from_line,
       sender_name, sender_email, sent_at,
       (regexp_match(markdown, '\n- \*\*To:\*\* ([^\n]+)'))[1]   as to_line,
       recipients
from public.conversions
where status = 'done' and markdown is not null
  and recipients is not null and sent_at is not null
order by random()
limit 5;
