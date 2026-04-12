-- Physioplanung: Organisation, Profile (Rolle), Workspace-Dokumente (JSONB), RLS

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Kern-Tabellen
-- ---------------------------------------------------------------------------

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  role text not null default 'therapie'
    check (role in ('admin', 'planung', 'therapie', 'viewer')),
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists profiles_organization_id_idx
  on public.profiles (organization_id);

create table if not exists public.workspace_documents (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  doc_type text not null check (doc_type in ('slots', 'panels', 'ui')),
  body jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (organization_id, doc_type)
);

-- ---------------------------------------------------------------------------
-- Seed: eine Standard-Organisation (neue Nutzer werden dieser zugeordnet)
-- ---------------------------------------------------------------------------

insert into public.organizations (name)
select 'Standard'
where not exists (select 1 from public.organizations limit 1);

-- ---------------------------------------------------------------------------
-- Auth: Profil bei Registrierung
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  org_id uuid;
begin
  select o.id into org_id
  from public.organizations o
  order by o.created_at asc
  limit 1;

  if org_id is null then
    raise exception 'Keine Organisation vorhanden (Seed fehlt).';
  end if;

  insert into public.profiles (id, organization_id, role, display_name)
  values (
    new.id,
    org_id,
    'therapie',
    coalesce(
      nullif(trim(new.raw_user_meta_data->>'display_name'), ''),
      split_part(new.email, '@', 1)
    )
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.workspace_documents enable row level security;

-- Profiles: eigenes Profil lesen
drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
  on public.profiles
  for select
  to authenticated
  using (id = auth.uid());

-- Workspace: lesen für alle Rollen derselben Organisation
drop policy if exists "workspace_select_org" on public.workspace_documents;
create policy "workspace_select_org"
  on public.workspace_documents
  for select
  to authenticated
  using (
    organization_id in (
      select p.organization_id from public.profiles p where p.id = auth.uid()
    )
  );

-- Admin / Planung: alle Dokumenttypen schreiben
drop policy if exists "workspace_insert_admin_planung" on public.workspace_documents;
create policy "workspace_insert_admin_planung"
  on public.workspace_documents
  for insert
  to authenticated
  with check (
    organization_id in (
      select p.organization_id from public.profiles p
      where p.id = auth.uid() and p.role in ('admin', 'planung')
    )
  );

drop policy if exists "workspace_update_admin_planung" on public.workspace_documents;
create policy "workspace_update_admin_planung"
  on public.workspace_documents
  for update
  to authenticated
  using (
    organization_id in (
      select p.organization_id from public.profiles p
      where p.id = auth.uid() and p.role in ('admin', 'planung')
    )
  )
  with check (
    organization_id in (
      select p.organization_id from public.profiles p
      where p.id = auth.uid() and p.role in ('admin', 'planung')
    )
  );

-- Therapie: Kalender, gemeinsame Stammdaten-JSON (z. B. Abwesenheiten) und UI-Zustand
drop policy if exists "workspace_insert_therapie_workspace_docs" on public.workspace_documents;
create policy "workspace_insert_therapie_workspace_docs"
  on public.workspace_documents
  for insert
  to authenticated
  with check (
    organization_id in (
      select p.organization_id from public.profiles p
      where p.id = auth.uid() and p.role = 'therapie'
    )
    and doc_type in ('slots', 'panels', 'ui')
  );

drop policy if exists "workspace_update_therapie_workspace_docs" on public.workspace_documents;
create policy "workspace_update_therapie_workspace_docs"
  on public.workspace_documents
  for update
  to authenticated
  using (
    organization_id in (
      select p.organization_id from public.profiles p
      where p.id = auth.uid() and p.role = 'therapie'
    )
    and doc_type in ('slots', 'panels', 'ui')
  )
  with check (
    organization_id in (
      select p.organization_id from public.profiles p
      where p.id = auth.uid() and p.role = 'therapie'
    )
    and doc_type in ('slots', 'panels', 'ui')
  );

-- Ersten Administrator setzen (id = UUID aus Supabase → Authentication → Users):
-- update public.profiles set role = 'admin' where id = '…';
