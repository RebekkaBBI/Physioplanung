-- profiles_select_org_admin referenced public.profiles inside its USING clause,
-- which re-evaluated RLS on profiles → infinite recursion.
-- SECURITY DEFINER: read own row without going through RLS policies on profiles.

create or replace function public.profiles_me_is_admin_of_org(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.organization_id = p_organization_id
      and p.role = 'admin'
  );
$$;

comment on function public.profiles_me_is_admin_of_org(uuid) is
  'RLS helper: true if the current user is an admin of the given organization (avoids recursive profiles policies).';

revoke all on function public.profiles_me_is_admin_of_org(uuid) from public;
grant execute on function public.profiles_me_is_admin_of_org(uuid) to authenticated;

drop policy if exists "profiles_select_org_admin" on public.profiles;

create policy "profiles_select_org_admin"
  on public.profiles
  for select
  to authenticated
  using (public.profiles_me_is_admin_of_org(organization_id));
