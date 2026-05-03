-- Admins: alle Profile derselben Organisation lesen (Rollenübersicht in der App).
drop policy if exists "profiles_select_org_admin" on public.profiles;
create policy "profiles_select_org_admin"
  on public.profiles
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.profiles me
      where me.id = auth.uid()
        and me.role = 'admin'
        and me.organization_id = profiles.organization_id
    )
  );
