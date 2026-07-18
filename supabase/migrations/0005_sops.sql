-- ============================================================================
-- M2: SOP entities — version-aware lifecycle, canonical JSONB content,
-- step-level citations, DB-enforced guarantees.
--
-- Protection model (decisive gates in order):
--   1) RLS ownership on every table (auth.uid() = user_id)
--   2) Column-level privileges: clients can neither UPDATE nor specify on
--      INSERT any protected sops column — every status change and every
--      version/family-bearing insert necessarily originates from a
--      SECURITY DEFINER RPC (table owner) or a DB administrator.
--   3) Trigger-enforced state matrix, immutability and approval
--      preconditions, applied uniformly to EVERY writer (no role-name or
--      session-marker inspection anywhere).
--   4) SECURITY DEFINER RPCs verify auth.uid() ownership in-body before any
--      write and serialize with FOR UPDATE family locks.
--
-- SYSTEM-COLUMN WRITE MODEL (deliberate, not incidental):
--   Column ACLs gate only columns REFERENCED BY CLIENT STATEMENTS (checked at
--   statement level). DEFAULT evaluation and BEFORE-trigger assignments to
--   NEW are below that layer by PostgreSQL design (same mechanism as the
--   standard moddatetime pattern). Single canonical writers:
--     family_id   -> BEFORE INSERT trigger (v1: := id) / create_new_version()
--     approved_at -> BEFORE UPDATE trigger, only on review_required->approved
--     updated_at  -> BEFORE INSERT + BEFORE UPDATE triggers (always stamped)
--     created_at  -> column DEFAULT, then identity-immutable
--     user_id     -> column DEFAULT auth.uid() on client paths;
--                    explicit verified auth.uid() in create_new_version()
--     snapshot_*  -> server-generated only (definer RPCs), never
--                    client-writable; new sources additionally require a
--                    live owned conversion (NULL live links can only be
--                    INHERITED within the same family — see sources guard)
--   No write path for these columns depends on client column privileges.
--
-- Additive only; no change to conversions or existing objects.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Tables
-- ----------------------------------------------------------------------------
create table public.sops (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid()
                 references auth.users (id) on delete cascade,
  family_id      uuid not null,   -- assigned by trigger for v1; NOT NULL is
                                  -- checked AFTER before-triggers run
  version        integer not null default 1 check (version >= 1),
  status         text not null default 'draft'
                 check (status in
                   ('draft','review_required','approved','superseded','archived')),
  title          text not null default 'Untitled SOP',
  goal           text,
  clarifications jsonb,
  content        jsonb not null
                 check (jsonb_typeof(content) = 'object'
                        and content->>'schema' = 'sop.v1'),
  markdown       text,             -- derived render cache, never canonical
  model          text,             -- M3 telemetry
  tokens_in      integer not null default 0,
  tokens_out     integer not null default 0,
  approved_at    timestamptz,
  superseded_by  uuid references public.sops (id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (family_id, version)
);

create table public.sop_sources (
  sop_id                 uuid not null references public.sops (id) on delete cascade,
  user_id                uuid not null default auth.uid(),
  label                  text not null,               -- 'E1'..'En'
  original_conversion_id uuid not null,               -- immutable identity
  conversion_id          uuid references public.conversions (id) on delete set null,
  ord                    integer not null,
  note                   text,
  snapshot_subject       text,
  snapshot_sender        text,
  snapshot_sent_at       timestamptz,
  snapshot_source_name   text,
  created_at             timestamptz not null default now(),
  primary key (sop_id, label),
  unique (sop_id, original_conversion_id)
);

create table public.sop_step_citations (
  sop_id     uuid not null references public.sops (id) on delete cascade,
  user_id    uuid not null default auth.uid(),
  step_id    text not null,                            -- logical sop.v1 step id
  label      text not null,
  quote      text not null,
  created_at timestamptz not null default now(),
  primary key (sop_id, step_id, label),
  foreign key (sop_id, label)
    references public.sop_sources (sop_id, label) on delete cascade
);

create index sops_user_family_idx    on public.sops (user_id, family_id, version desc);
create index sops_user_updated_idx   on public.sops (user_id, updated_at desc);
create index sops_superseded_by_idx  on public.sops (superseded_by);
create index sop_sources_sop_ord_idx on public.sop_sources (sop_id, ord);
create index sop_sources_conv_idx    on public.sop_sources (conversion_id);
create index sop_citations_step_idx  on public.sop_step_citations (sop_id, step_id);

-- ----------------------------------------------------------------------------
-- RLS
-- ----------------------------------------------------------------------------
alter table public.sops                enable row level security;
alter table public.sop_sources        enable row level security;
alter table public.sop_step_citations enable row level security;

create policy "sops_select_own" on public.sops
  for select to authenticated using (auth.uid() = user_id);
create policy "sops_insert_own" on public.sops
  for insert to authenticated with check (auth.uid() = user_id);
create policy "sops_update_own" on public.sops
  for update to authenticated using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create policy "sops_delete_own" on public.sops
  for delete to authenticated using (auth.uid() = user_id);

create policy "sop_sources_select_own" on public.sop_sources
  for select to authenticated using (auth.uid() = user_id);
create policy "sop_sources_insert_own" on public.sop_sources
  for insert to authenticated with check (auth.uid() = user_id);
create policy "sop_sources_update_own" on public.sop_sources
  for update to authenticated using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create policy "sop_sources_delete_own" on public.sop_sources
  for delete to authenticated using (auth.uid() = user_id);

create policy "sop_citations_select_own" on public.sop_step_citations
  for select to authenticated using (auth.uid() = user_id);
create policy "sop_citations_insert_own" on public.sop_step_citations
  for insert to authenticated with check (auth.uid() = user_id);
create policy "sop_citations_update_own" on public.sop_step_citations
  for update to authenticated using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create policy "sop_citations_delete_own" on public.sop_step_citations
  for delete to authenticated using (auth.uid() = user_id);

-- ----------------------------------------------------------------------------
-- Column-level privileges — the decisive gate for protected writes.
-- ACLs bind to columns referenced by client statements; system columns are
-- written below this layer by DEFAULTs and triggers (see header contract),
-- so granting nothing on them removes the client's ability to reference
-- them without affecting the system writers.
-- ----------------------------------------------------------------------------
revoke all on public.sops               from anon, authenticated;
revoke all on public.sop_sources        from anon, authenticated;
revoke all on public.sop_step_citations from anon, authenticated;

grant select, delete on public.sops to authenticated;
grant insert (title, goal, content, markdown, clarifications)
  on public.sops to authenticated;
grant update (title, goal, content, markdown, clarifications)
  on public.sops to authenticated;

grant select, delete on public.sop_sources to authenticated;
-- NO direct client INSERT on sop_sources at all: every source row is created
-- exclusively by the definer RPCs (create_sop_from_selection,
-- add_sop_source_from_conversion, create_new_version copies), which
-- guarantees server-generated provenance snapshots on EVERY row — a client
-- can never create a source with empty/forged snapshots. Clients keep
-- SELECT, DELETE (draft-state guarded by trigger) and UPDATE(note,
-- conversion_id) for the existing UX; privileges are not expanded.
grant update (note, conversion_id) on public.sop_sources to authenticated;

grant select, delete on public.sop_step_citations to authenticated;
grant insert (sop_id, step_id, label, quote)
  on public.sop_step_citations to authenticated;
-- no client UPDATE on citations in M2

-- ----------------------------------------------------------------------------
-- Helper: minimum non-blank rule for sop.v1
-- ----------------------------------------------------------------------------
create function public.sop_content_is_substantive(p jsonb) returns boolean
language sql immutable set search_path = pg_catalog, public as $$
  select p->>'schema' = 'sop.v1'
     and jsonb_typeof(p->'sections') = 'array'
     and exists (
       select 1 from jsonb_array_elements(p->'sections') s
       where length(btrim(coalesce(s->>'heading',''))) > 0)
     and exists (
       select 1
       from jsonb_array_elements(p->'sections') s
       cross join lateral jsonb_array_elements(
         case when jsonb_typeof(s->'steps') = 'array'
              then s->'steps' else '[]'::jsonb end) st
       where length(btrim(coalesce(st->>'title','')))       > 0
         and length(btrim(coalesce(st->>'instruction',''))) > 0)
$$;

-- ----------------------------------------------------------------------------
-- sops triggers — uniform for every writer; the ONLY writers of the
-- system columns family_id / approved_at / updated_at (ACL-independent
-- by design, per the header contract).
-- ----------------------------------------------------------------------------
create function public.sops_before_insert() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin
  -- Every row is born a draft (clients cannot even reference these columns;
  -- this is the uniform backstop for privileged writers too).
  if new.status <> 'draft' then
    raise exception 'SOPs must be created as drafts';
  end if;
  if new.approved_at is not null or new.superseded_by is not null then
    raise exception 'approved_at/superseded_by cannot be set on insert';
  end if;

  -- SYSTEM WRITE: family_id = id guarantee for v1 (DB-level, never
  -- frontend-dependent). create_new_version() supplies an existing family_id.
  new.family_id := coalesce(new.family_id, new.id);

  -- SYSTEM WRITE: updated_at is trigger-stamped on every path; any value a
  -- privileged writer might pass is deliberately overwritten (single writer).
  new.updated_at := now();
  return new;
end $$;

create function public.sops_before_update() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin
  -- Identity columns are immutable for everyone.
  if new.id is distinct from old.id
     or new.user_id is distinct from old.user_id
     or new.family_id is distinct from old.family_id
     or new.version is distinct from old.version
     or new.created_at is distinct from old.created_at then
    raise exception 'identity columns are immutable';
  end if;

  if old.status in ('approved','superseded','archived') then
    -- Frozen content: nothing but a legal transition may differ.
    if new.title is distinct from old.title
       or new.goal is distinct from old.goal
       or new.content is distinct from old.content
       or new.markdown is distinct from old.markdown
       or new.clarifications is distinct from old.clarifications
       or new.model is distinct from old.model
       or new.tokens_in is distinct from old.tokens_in
       or new.tokens_out is distinct from old.tokens_out then
      raise exception 'this SOP version is immutable';
    end if;
    if new.approved_at is distinct from old.approved_at then
      raise exception 'approved_at is protected';
    end if;

    if old.status = 'approved' and new.status = 'superseded' then
      if new.superseded_by is null then
        raise exception 'superseded requires superseded_by';
      end if;
      perform 1 from public.sops t
       where t.id = new.superseded_by
         and t.family_id = old.family_id
         and t.user_id  = old.user_id
         and t.version  > old.version;
      if not found then
        raise exception 'superseded_by must be a newer version of the same family';
      end if;
    elsif (old.status = 'approved'   and new.status = 'archived')
       or (old.status = 'superseded' and new.status = 'archived') then
      if new.superseded_by is distinct from old.superseded_by then
        raise exception 'superseded_by is protected';
      end if;
    else
      raise exception 'invalid status transition (% -> %)', old.status, new.status;
    end if;

  else  -- old.status in ('draft','review_required'): editable states
    if new.superseded_by is distinct from old.superseded_by then
      raise exception 'superseded_by is protected';
    end if;

    if new.status = old.status
       or (old.status = 'draft'           and new.status in ('review_required','archived'))
       or (old.status = 'review_required' and new.status in ('draft','archived')) then
      if new.approved_at is distinct from old.approved_at then
        raise exception 'approved_at is protected';
      end if;
    elsif old.status = 'review_required' and new.status = 'approved' then
      -- Approval preconditions, enforced for EVERY writer:
      if not exists (select 1 from public.sop_sources ss
                      where ss.sop_id = new.id) then
        raise exception 'SOP has no sources';
      end if;
      if length(btrim(new.title)) = 0 then
        raise exception 'title is empty';
      end if;
      if length(btrim(coalesce(new.goal, ''))) = 0 then
        raise exception 'goal is empty';
      end if;
      if not public.sop_content_is_substantive(new.content) then
        raise exception 'content has no substantive step';
      end if;
      -- SYSTEM WRITE: approved_at has exactly one writer — this branch.
      new.approved_at := now();
    else
      raise exception 'invalid status transition (% -> %)', old.status, new.status;
    end if;

    -- markdown is derived: may change only alongside content, or to fill
    -- an empty cache.
    if new.markdown is distinct from old.markdown
       and new.content is not distinct from old.content
       and old.markdown is not null then
      raise exception 'markdown is derived from content';
    end if;
  end if;

  -- SYSTEM WRITE: updated_at stamped on every successful update path.
  new.updated_at := now();
  return new;
end $$;

create function public.sops_before_delete() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin
  if old.status <> 'draft' then
    raise exception 'only draft SOPs can be deleted; archive instead';
  end if;
  return old;
end $$;

create trigger sops_bi before insert on public.sops
  for each row execute function public.sops_before_insert();
create trigger sops_bu before update on public.sops
  for each row execute function public.sops_before_update();
create trigger sops_bd before delete on public.sops
  for each row execute function public.sops_before_delete();

-- ----------------------------------------------------------------------------
-- Child guards (sources / citations)
-- ----------------------------------------------------------------------------
create function public.sop_sources_guard() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
declare
  v_parent record;
  v_sop_id uuid := coalesce(new.sop_id, old.sop_id);
begin
  -- The FK's ON DELETE SET NULL fires this trigger as an UPDATE that only
  -- drops the live link. That system action must succeed even on frozen
  -- versions (a Library deletion must never be blocked by an approved SOP).
  if tg_op = 'UPDATE'
     and new.conversion_id is null and old.conversion_id is not null
     and new.sop_id  is not distinct from old.sop_id
     and new.user_id is not distinct from old.user_id
     and new.label   is not distinct from old.label
     and new.original_conversion_id is not distinct from old.original_conversion_id
     and new.ord     is not distinct from old.ord
     and new.note    is not distinct from old.note
     and new.snapshot_subject     is not distinct from old.snapshot_subject
     and new.snapshot_sender      is not distinct from old.snapshot_sender
     and new.snapshot_sent_at     is not distinct from old.snapshot_sent_at
     and new.snapshot_source_name is not distinct from old.snapshot_source_name then
    return new;
  end if;

  select user_id, status into v_parent from public.sops where id = v_sop_id;

  if v_parent is null then
    if tg_op = 'DELETE' then return old; end if;  -- ON DELETE CASCADE path
    raise exception 'SOP not found or not yours';
  end if;

  if tg_op in ('INSERT','UPDATE') and new.user_id <> v_parent.user_id then
    raise exception 'source owner must match SOP owner';
  end if;
  if v_parent.status not in ('draft','review_required') then
    raise exception 'sources of a frozen SOP version cannot change';
  end if;

  if tg_op = 'INSERT' then
    -- PROVENANCE: every genuinely new source must be backed by a live,
    -- owned conversion. A NULL live link on INSERT is permitted ONLY as
    -- INHERITANCE: an identical-provenance source (same owner, same
    -- original_conversion_id) must already exist on another version of the
    -- SAME family — which is exactly the create_new_version() copy path for
    -- sources whose Library email was deleted after verification. Since the
    -- chain bottoms out in a live-verified insert, provenance can never be
    -- fabricated by any writer.
    if new.conversion_id is null then
      perform 1
        from public.sop_sources s0
        join public.sops p0 on p0.id = s0.sop_id
        join public.sops pn on pn.id = new.sop_id
       where s0.user_id = new.user_id
         and s0.original_conversion_id = new.original_conversion_id
         and p0.family_id = pn.family_id
         and s0.sop_id <> new.sop_id;
      if not found then
        raise exception 'a new source requires a live conversion link';
      end if;
    else
      if new.conversion_id <> new.original_conversion_id then
        raise exception 'live link must match original_conversion_id';
      end if;
      perform 1 from public.conversions c
        where c.id = new.original_conversion_id and c.user_id = new.user_id;
      if not found then
        raise exception 'conversion not found or not yours';
      end if;
    end if;
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if new.sop_id  is distinct from old.sop_id
       or new.user_id is distinct from old.user_id
       or new.label   is distinct from old.label
       or new.original_conversion_id is distinct from old.original_conversion_id then
      raise exception 'source identity fields are immutable';
    end if;
    if new.conversion_id is distinct from old.conversion_id then
      if new.conversion_id is null then
        null;  -- dropping the live link is allowed
      elsif new.conversion_id = new.original_conversion_id then
        perform 1 from public.conversions c
          where c.id = new.conversion_id and c.user_id = new.user_id;
        if not found then
          raise exception 'conversion not found or not yours';
        end if;
      else
        raise exception 'live link may only be original_conversion_id or null';
      end if;
    end if;
    return new;
  end if;

  return old;
end $$;

create function public.sop_citations_guard() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
declare
  v_parent record;
  v_sop_id uuid := coalesce(new.sop_id, old.sop_id);
begin
  select user_id, status into v_parent from public.sops where id = v_sop_id;

  if v_parent is null then
    if tg_op = 'DELETE' then return old; end if;  -- cascade path
    raise exception 'SOP not found or not yours';
  end if;

  if tg_op in ('INSERT','UPDATE') and new.user_id <> v_parent.user_id then
    raise exception 'citation owner must match SOP owner';
  end if;
  if v_parent.status not in ('draft','review_required') then
    raise exception 'citations of a frozen SOP version cannot change';
  end if;

  if tg_op = 'UPDATE' then
    if new.sop_id is distinct from old.sop_id
       or new.user_id is distinct from old.user_id
       or new.step_id is distinct from old.step_id
       or new.label   is distinct from old.label then
      raise exception 'citation identity fields are immutable';
    end if;
  end if;

  return coalesce(new, old);
end $$;

create trigger sop_sources_guard before insert or update or delete
  on public.sop_sources for each row execute function public.sop_sources_guard();
create trigger sop_citations_guard before insert or update or delete
  on public.sop_step_citations for each row execute function public.sop_citations_guard();

-- ----------------------------------------------------------------------------
-- RPCs
-- ----------------------------------------------------------------------------

-- Atomic draft creation. SECURITY DEFINER solely because the provenance
-- snapshot columns (snapshot_*) are deliberately not client-writable and can
-- only be produced server-side from the verified conversions rows — this
-- elevation exists for controlled snapshot creation and protected system
-- writes, NOT as a trust boundary: auth.uid() is explicitly verified and
-- every conversion is validated for ownership (user_id = caller) and
-- status='done' in-body before any write. user_id columns are still filled
-- by their DEFAULT auth.uid(). Input is de-duplicated; labels are assigned
-- only after the deterministic final ordering
-- (sent_at ASC NULLS LAST, created_at ASC, id ASC);
-- unique(sop_id, original_conversion_id) remains the last-resort enforcement.
create function public.create_sop_from_selection(
  p_title text, p_goal text, p_conversion_ids uuid[]
) returns public.sops
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_uid uuid := auth.uid();
  v_ids uuid[];
  v_cnt integer;
  v_sop public.sops;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if length(btrim(coalesce(p_title,''))) = 0 then
    raise exception 'title is required';
  end if;

  select array_agg(distinct x) into v_ids
    from unnest(coalesce(p_conversion_ids, '{}')) x where x is not null;
  if v_ids is null or array_length(v_ids, 1) < 1 then
    raise exception 'at least one source is required';
  end if;
  if array_length(v_ids, 1) > 50 then
    raise exception 'too many sources (max 50)';
  end if;

  select count(*) into v_cnt from public.conversions c
   where c.id = any (v_ids) and c.user_id = v_uid and c.status = 'done';
  if v_cnt <> array_length(v_ids, 1) then
    raise exception 'one or more sources were not found';
  end if;

  insert into public.sops (title, goal, content)
  values (
    btrim(p_title),
    nullif(btrim(coalesce(p_goal, '')), ''),
    jsonb_build_object(
      'schema','sop.v1',
      'metadata', jsonb_build_object(
        'purpose','', 'scope','', 'audience','', 'tags','[]'::jsonb),
      'roles','[]'::jsonb,
      'sections','[]'::jsonb,
      'open_questions','[]'::jsonb,
      'quality', jsonb_build_object(
        'confidence', null, 'gaps','[]'::jsonb, 'review_notes','[]'::jsonb)))
  returning * into v_sop;

  insert into public.sop_sources
    (sop_id, label, original_conversion_id, conversion_id, ord,
     snapshot_subject, snapshot_sender, snapshot_sent_at, snapshot_source_name)
  select v_sop.id, 'E' || rn, c.id, c.id, rn,
         c.subject, coalesce(c.sender_name, c.sender_email),
         c.sent_at, c.source_name
  from (
    select c.*,
           row_number() over
             (order by c.sent_at asc nulls last, c.created_at asc, c.id asc) rn
    from public.conversions c
    where c.id = any (v_ids) and c.user_id = v_uid and c.status = 'done'
  ) c;

  return v_sop;
end $$;

-- Adds one source to an editable SOP. SECURITY DEFINER solely because
-- provenance snapshots are server-generated (clients hold no INSERT on
-- sop_sources at all) — NOT a trust boundary: auth.uid() ownership of both
-- the SOP and the conversion is verified in-body, with row locks, before
-- any write. Snapshot values are copied only from the verified conversion.
create function public.add_sop_source_from_conversion(
  p_sop_id uuid, p_conversion_id uuid, p_note text default null
) returns public.sop_sources
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_uid  uuid := auth.uid();
  v_sop  public.sops;
  v_conv public.conversions;
  v_ord  integer;
  v_row  public.sop_sources;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;

  select * into v_sop from public.sops
   where id = p_sop_id and user_id = v_uid
   for update;
  if not found then raise exception 'SOP not found or not yours'; end if;
  if v_sop.status not in ('draft','review_required') then
    raise exception 'sources of a frozen SOP version cannot change';
  end if;

  select * into v_conv from public.conversions
   where id = p_conversion_id and user_id = v_uid and status = 'done'
   for update;
  if not found then raise exception 'conversion not found or not yours'; end if;

  if exists (select 1 from public.sop_sources
              where sop_id = v_sop.id
                and original_conversion_id = v_conv.id) then
    raise exception 'this email is already a source of this SOP';
  end if;

  -- Deterministic next position; the SOP row lock serializes concurrent adds.
  select coalesce(max(ord), 0) + 1 into v_ord
    from public.sop_sources where sop_id = v_sop.id;

  insert into public.sop_sources
    (sop_id, user_id, label, original_conversion_id, conversion_id, ord, note,
     snapshot_subject, snapshot_sender, snapshot_sent_at, snapshot_source_name)
  values
    (v_sop.id, v_uid, 'E' || v_ord, v_conv.id, v_conv.id, v_ord, p_note,
     v_conv.subject, coalesce(v_conv.sender_name, v_conv.sender_email),
     v_conv.sent_at, v_conv.source_name)
  returning * into v_row;

  return v_row;
end $$;

-- Simple lifecycle transitions (clients hold no UPDATE(status) privilege, so
-- even draft<->review_required and archiving go through this RPC). DEFINER
-- only to reach the status column — ownership is explicitly re-verified;
-- approval/supersession are refused here and exist only in
-- approve_sop_version(). The trigger matrix backstops every branch.
create function public.set_sop_status(p_sop_id uuid, p_status text)
returns public.sops
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_uid uuid := auth.uid();
  v_row public.sops;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if p_status not in ('draft','review_required','archived') then
    raise exception 'use approve_sop_version() for approval';
  end if;

  select * into v_row from public.sops
   where id = p_sop_id and user_id = v_uid
   for update;
  if not found then raise exception 'SOP not found or not yours'; end if;

  if not (   (v_row.status = 'draft'
              and p_status in ('review_required','archived'))
          or (v_row.status = 'review_required'
              and p_status in ('draft','archived'))
          or (v_row.status in ('approved','superseded')
              and p_status = 'archived') ) then
    raise exception 'invalid transition (% -> %)', v_row.status, p_status;
  end if;

  update public.sops set status = p_status
   where id = v_row.id
  returning * into v_row;
  return v_row;
end $$;

-- Atomic approval. DEFINER only to reach protected columns/transitions — NOT
-- a trust model: ownership is explicitly verified via auth.uid() before any
-- write, and the whole family is FOR UPDATE locked.
create function public.approve_sop_version(p_sop_id uuid)
returns public.sops
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_uid    uuid := auth.uid();
  v_target public.sops;
  v_prev   public.sops;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;

  select * into v_target from public.sops
   where id = p_sop_id and user_id = v_uid
   for update;
  if not found then raise exception 'SOP not found or not yours'; end if;

  perform 1 from public.sops
   where family_id = v_target.family_id and user_id = v_uid
   for update;  -- serialize approvals/versioning within the family

  if v_target.status <> 'review_required' then
    raise exception 'only review_required versions can be approved';
  end if;
  -- Preconditions also enforced writer-uniformly by the update trigger;
  -- checked here first for clear, atomic error reporting.
  if not exists (select 1 from public.sop_sources
                  where sop_id = v_target.id) then
    raise exception 'SOP has no sources';
  end if;
  if length(btrim(v_target.title)) = 0 then
    raise exception 'title is empty';
  end if;
  if length(btrim(coalesce(v_target.goal, ''))) = 0 then
    raise exception 'goal is empty';
  end if;
  if not public.sop_content_is_substantive(v_target.content) then
    raise exception 'content has no substantive step';
  end if;

  select * into v_prev from public.sops
   where family_id = v_target.family_id and user_id = v_uid
     and status = 'approved';

  update public.sops set status = 'approved'
   where id = v_target.id;

  if v_prev.id is not null then
    update public.sops
       set status = 'superseded', superseded_by = v_target.id
     where id = v_prev.id;
  end if;

  select * into v_target from public.sops where id = v_target.id;
  return v_target;
end $$;

-- Atomic new draft version: copies ONLY from the family's current approved
-- version (never from superseded ones), with its sources and citations.
-- Single open draft per family. Same definer caveats as above. user_id is
-- written explicitly as the verified auth.uid() (definer context has no
-- useful auth.uid()-default dependency to rely on implicitly).
create function public.create_new_version(p_family_id uuid)
returns public.sops
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_uid      uuid := auth.uid();
  v_approved public.sops;
  v_next     integer;
  v_new      public.sops;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;

  perform 1 from public.sops
   where family_id = p_family_id and user_id = v_uid
   for update;

  select * into v_approved from public.sops
   where family_id = p_family_id and user_id = v_uid and status = 'approved';
  if not found then
    raise exception 'no approved version to revise';
  end if;
  if exists (select 1 from public.sops
              where family_id = p_family_id and user_id = v_uid
                and status in ('draft','review_required')) then
    raise exception 'this SOP already has an open draft';
  end if;

  select max(version) + 1 into v_next from public.sops
   where family_id = p_family_id and user_id = v_uid;

  insert into public.sops (user_id, family_id, version, status,
                           title, goal, content, markdown, clarifications)
  values (v_uid, p_family_id, v_next, 'draft',
          v_approved.title, v_approved.goal, v_approved.content,
          v_approved.markdown, v_approved.clarifications)
  returning * into v_new;

  insert into public.sop_sources
    (sop_id, user_id, label, original_conversion_id, conversion_id, ord, note,
     snapshot_subject, snapshot_sender, snapshot_sent_at, snapshot_source_name)
  select v_new.id, user_id, label, original_conversion_id, conversion_id, ord, note,
         snapshot_subject, snapshot_sender, snapshot_sent_at, snapshot_source_name
    from public.sop_sources where sop_id = v_approved.id;

  insert into public.sop_step_citations (sop_id, user_id, step_id, label, quote)
  select v_new.id, user_id, step_id, label, quote
    from public.sop_step_citations where sop_id = v_approved.id;

  return v_new;
end $$;

revoke all on function public.create_sop_from_selection(text, text, uuid[]) from public;
revoke all on function public.add_sop_source_from_conversion(uuid, uuid, text) from public;
revoke all on function public.set_sop_status(uuid, text) from public;
revoke all on function public.approve_sop_version(uuid) from public;
revoke all on function public.create_new_version(uuid) from public;
grant execute on function public.create_sop_from_selection(text, text, uuid[]) to authenticated;
grant execute on function public.add_sop_source_from_conversion(uuid, uuid, text) to authenticated;
grant execute on function public.set_sop_status(uuid, text) to authenticated;
grant execute on function public.approve_sop_version(uuid) to authenticated;
grant execute on function public.create_new_version(uuid) to authenticated;
