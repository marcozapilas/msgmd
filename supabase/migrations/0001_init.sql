-- msgmd web app schema: conversions table + private storage buckets, all
-- locked down with row-level security so a user only ever sees their own data.

-- ---------------------------------------------------------------------------
-- conversions
-- ---------------------------------------------------------------------------
create table if not exists public.conversions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  source_name  text not null,
  storage_path text not null,
  output_path  text,
  status       text not null default 'pending' check (status in ('pending', 'done', 'error')),
  error        text,
  subject      text,
  markdown     text,
  size_bytes   integer,
  created_at   timestamptz not null default now()
);

create index if not exists conversions_user_created_idx
  on public.conversions (user_id, created_at desc);

alter table public.conversions enable row level security;

create policy "conversions_select_own"
  on public.conversions for select to authenticated
  using (auth.uid() = user_id);

create policy "conversions_insert_own"
  on public.conversions for insert to authenticated
  with check (auth.uid() = user_id);

create policy "conversions_update_own"
  on public.conversions for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "conversions_delete_own"
  on public.conversions for delete to authenticated
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- storage buckets (private)
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('msg-uploads', 'msg-uploads', false)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('md-outputs', 'md-outputs', false)
on conflict (id) do nothing;

-- Objects live under "<user_id>/<file>"; each user may only touch their folder.
create policy "msg_uploads_rw_own"
  on storage.objects for all to authenticated
  using (
    bucket_id = 'msg-uploads'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'msg-uploads'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "md_outputs_rw_own"
  on storage.objects for all to authenticated
  using (
    bucket_id = 'md-outputs'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'md-outputs'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
