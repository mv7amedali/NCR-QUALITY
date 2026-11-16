-- شغّل الملف ده مرة واحدة في Supabase > SQL Editor
create table if not exists public.records (
  kind text not null,
  id text not null,
  data jsonb not null,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (kind, id)
);
create index if not exists records_updated_idx on public.records (updated_at);

create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at := clock_timestamp(); return new; end $$;
drop trigger if exists records_touch on public.records;
create trigger records_touch before insert or update on public.records
for each row execute function public.touch_updated_at();

alter table public.records enable row level security;
drop policy if exists "app_select" on public.records;
drop policy if exists "app_insert" on public.records;
drop policy if exists "app_update" on public.records;
create policy "app_select" on public.records for select to anon, authenticated using (true);
create policy "app_insert" on public.records for insert to anon, authenticated with check (true);
create policy "app_update" on public.records for update to anon, authenticated using (true) with check (true);
