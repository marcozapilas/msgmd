-- ============================================================================
-- M0 backfill + reconciliation (rev. 4). Run AFTER 1-migration-0004.sql.
-- Run this WHOLE file in ONE execution in the Supabase SQL Editor.
--
-- rev. 4 note: the Supabase SQL Editor already wraps the whole script in a
-- single transaction (proven by error 25001 in rev. 3). Therefore the explicit
-- BEGIN/COMMIT were removed and the isolation level is set as the FIRST
-- statement. Everything below — helpers, pre-count, update, post-counts, and
-- the reconciliation report — runs in that one REPEATABLE READ transaction;
-- the editor commits only if the entire script succeeds, otherwise everything
-- rolls back with no partial writes.
--
-- All other guarantees unchanged from rev. 3:
--  * UPDATE fires only when at least one persisted field will actually change
--    => GET DIAGNOSTICS ROW_COUNT counts value-changing rows; reruns are clean.
--  * Field-level COALESCE — an existing value is never overwritten.
--  * conversions.markdown is NEVER in any SET list (immutable source data).
--  * recipients is NEVER NULL for an eligible done+markdown row:
--      '(none)' To / absent Cc -> [];
--      unparseable single value -> [{"name": "<raw value>", "email": null}];
--      a NULL from the address parser is skipped, never concatenated.
-- ============================================================================

set transaction isolation level repeatable read;

create temp table if not exists _m0_metrics (ord int, metric text, value bigint);
truncate _m0_metrics;

create or replace function pg_temp.m0_unescape(t text) returns text
language sql immutable as
$$ select regexp_replace(t, '\\([\\`*_<>])', '\1', 'g') $$;

create or replace function pg_temp.m0_addr(entry text) returns jsonb
language plpgsql immutable as $$
declare nm text; addr text; m text[];
begin
  entry := btrim(entry);
  if entry is null or entry = '' or entry = '(unknown)' then return null; end if;
  m := regexp_match(entry, '^(.*?)\s*<([^<>]+)>$');
  if m is not null then
    nm   := nullif(pg_temp.m0_unescape(m[1]), '');
    addr := pg_temp.m0_unescape(m[2]);
    if position('@' in addr) > 0 then
      return jsonb_build_object('name', nm, 'email', addr);
    else
      return jsonb_build_object('name', nm, 'email', null);
    end if;
  end if;
  entry := pg_temp.m0_unescape(entry);
  if entry ~ '^[^[:space:]]+@[^[:space:]]+\.[^[:space:]]+$' then
    return jsonb_build_object('name', null, 'email', entry);
  end if;
  return jsonb_build_object('name', entry, 'email', null);
end $$;

create or replace function pg_temp.m0_list(line text, out entries jsonb, out ambiguous boolean)
language plpgsql immutable as $$
declare seg text; acc text := ''; j jsonb;
begin
  ambiguous := false; entries := '[]'::jsonb;
  if line is null or line = '(none)' then return; end if;
  foreach seg in array string_to_array(line, ', ') loop
    acc := case when acc = '' then seg else acc || ', ' || seg end;
    if acc ~ '<[^<>]+>$' then
      j := pg_temp.m0_addr(acc);
      if j is not null then entries := entries || j; end if;
      acc := '';
    end if;
  end loop;
  if acc <> '' then
    ambiguous := (position(', ' in acc) > 0) or jsonb_array_length(entries) > 0;
    j := pg_temp.m0_addr(acc);
    if j is not null then entries := entries || j; end if;
  end if;
end $$;

do $$
begin
  if (select count(*) from information_schema.columns
      where table_schema = 'public' and table_name = 'conversions'
        and column_name in ('sender_name','sender_email','sent_at','recipients',
                            'markdown','status')) <> 6 then
    raise exception 'M0 assertion failed: run 0004_email_metadata.sql first';
  end if;
end $$;

insert into _m0_metrics
select 1, 'eligible_rows_before', count(*) from public.conversions
where status = 'done' and markdown is not null
  and (sender_name is null or sender_email is null
       or sent_at is null or recipients is null);

do $$
declare
  r record; v_from text; v_date text; v_to text; v_cc text;
  j_from jsonb; ts timestamptz;
  tolist jsonb; toamb boolean; cclist jsonb; ccamb boolean;
  rec jsonb; v_cnt bigint; n_upd bigint := 0;
begin
  for r in
    select id, markdown from public.conversions
    where status = 'done' and markdown is not null
      and (sender_name is null or sender_email is null
           or sent_at is null or recipients is null)
  loop
    v_from := (regexp_match(r.markdown, '\n- \*\*From:\*\* ([^\n]+)'))[1];
    v_date := (regexp_match(r.markdown, '\n- \*\*Date:\*\* ([^\n]+)'))[1];
    v_to   := (regexp_match(r.markdown, '\n- \*\*To:\*\* ([^\n]+)'))[1];
    v_cc   := (regexp_match(r.markdown, '\n- \*\*Cc:\*\* ([^\n]+)'))[1];

    j_from := pg_temp.m0_addr(v_from);
    ts := null;
    if v_date ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$'
      then ts := v_date::timestamptz; end if;

    select entries, ambiguous into tolist, toamb from pg_temp.m0_list(v_to);
    select entries, ambiguous into cclist, ccamb from pg_temp.m0_list(v_cc);
    rec := jsonb_build_object('to', coalesce(tolist, '[]'::jsonb),
                              'cc', coalesce(cclist, '[]'::jsonb));
    if toamb or ccamb then rec := rec || '{"ambiguous": true}'::jsonb; end if;

    update public.conversions set
      sender_name  = coalesce(sender_name,  j_from->>'name'),
      sender_email = coalesce(sender_email, j_from->>'email'),
      sent_at      = coalesce(sent_at, ts),
      recipients   = coalesce(recipients, rec)
    where id = r.id
      and (   (sender_name  is null and j_from->>'name'  is not null)
           or (sender_email is null and j_from->>'email' is not null)
           or (sent_at      is null and ts is not null)
           or (recipients   is null) );

    get diagnostics v_cnt = row_count;
    n_upd := n_upd + v_cnt;
  end loop;

  insert into _m0_metrics values (2, 'rows_updated_metadata (actual)', n_upd);
end $$;

do $$
declare u record;
begin
  select
    count(*) filter (where sender_name  is not null) as a,
    count(*) filter (where sender_email is not null) as b,
    count(*) filter (where sent_at      is not null) as c,
    count(*) filter (where recipients   is not null) as d,
    count(*) filter (where sender_name  is null)     as e,
    count(*) filter (where sender_email is null)     as f,
    count(*) filter (where sent_at      is null)     as g,
    count(*) filter (where recipients   is null)     as h,
    count(*) filter (where recipients->>'ambiguous' = 'true') as i
  into u
  from public.conversions
  where status = 'done' and markdown is not null;

  insert into _m0_metrics values
    (3,  'sender_name_populated',   u.a), (4,  'sender_email_populated', u.b),
    (5,  'sent_at_populated',       u.c), (6,  'recipients_populated',   u.d),
    (7,  'missing_sender_name',     u.e), (8,  'missing_sender_email',   u.f),
    (9,  'missing_sent_at',         u.g), (10, 'missing_recipients',     u.h),
    (11, 'recipients_ambiguous',    u.i);
end $$;

-- ======== RECONCILIATION REPORT (final statement; shown by the editor) ======
-- The editor commits only after the entire script, including this query,
-- has succeeded.
select metric, value from _m0_metrics order by ord;
