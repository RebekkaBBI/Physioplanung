-- Sicherheitsfix: RLS auch auf organizations aktivieren
-- (Supabase Security Advisor: rls_disabled_in_public)

alter table public.organizations enable row level security;

drop policy if exists "organizations_select_own_org" on public.organizations;
create policy "organizations_select_own_org"
  on public.organizations
  for select
  to authenticated
  using (
    id in (
      select p.organization_id
      from public.profiles p
      where p.id = auth.uid()
    )
  );

