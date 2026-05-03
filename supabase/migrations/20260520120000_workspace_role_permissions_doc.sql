-- Zusätzlicher Dokumenttyp: org-weite Rollen-Berechtigungen (nur Admin schreibbar).

alter table public.workspace_documents
  drop constraint if exists workspace_documents_doc_type_check;

alter table public.workspace_documents
  add constraint workspace_documents_doc_type_check
  check (doc_type in ('slots', 'panels', 'ui', 'role_permissions'));

-- Planung darf role_permissions nicht anlegen/ändern (nur Kalender/Stammdaten/UI).
drop policy if exists "workspace_insert_admin_planung" on public.workspace_documents;
create policy "workspace_insert_admin_planung"
  on public.workspace_documents
  for insert
  to authenticated
  with check (
    doc_type in ('slots', 'panels', 'ui')
    and organization_id in (
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
    doc_type in ('slots', 'panels', 'ui')
    and organization_id in (
      select p.organization_id from public.profiles p
      where p.id = auth.uid() and p.role in ('admin', 'planung')
    )
  )
  with check (
    doc_type in ('slots', 'panels', 'ui')
    and organization_id in (
      select p.organization_id from public.profiles p
      where p.id = auth.uid() and p.role in ('admin', 'planung')
    )
  );

drop policy if exists "workspace_insert_admin_role_permissions" on public.workspace_documents;
create policy "workspace_insert_admin_role_permissions"
  on public.workspace_documents
  for insert
  to authenticated
  with check (
    doc_type = 'role_permissions'
    and public.profiles_me_is_admin_of_org(organization_id)
  );

drop policy if exists "workspace_update_admin_role_permissions" on public.workspace_documents;
create policy "workspace_update_admin_role_permissions"
  on public.workspace_documents
  for update
  to authenticated
  using (
    doc_type = 'role_permissions'
    and public.profiles_me_is_admin_of_org(organization_id)
  )
  with check (
    doc_type = 'role_permissions'
    and public.profiles_me_is_admin_of_org(organization_id)
  );

create or replace function public.apply_workspace_document_patch(
  p_organization_id uuid,
  p_doc_type text,
  p_body jsonb,
  p_expected_updated_at timestamptz
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  cur_updated timestamptz;
  new_ts timestamptz := now();
  v_ret timestamptz;
  exp_ts timestamptz;
begin
  if p_doc_type not in ('slots', 'panels', 'ui', 'role_permissions') then
    return jsonb_build_object('ok', false, 'error', 'invalid_doc_type');
  end if;

  select wd.updated_at into cur_updated
  from public.workspace_documents wd
  where wd.organization_id = p_organization_id
    and wd.doc_type = p_doc_type;

  if cur_updated is null then
    if p_expected_updated_at is not null then
      return jsonb_build_object(
        'ok', false,
        'error', 'conflict',
        'detail', 'row_created_meanwhile'
      );
    end if;
    begin
      insert into public.workspace_documents (
        organization_id, doc_type, body, updated_at
      )
      values (p_organization_id, p_doc_type, p_body, new_ts)
      returning updated_at into new_ts;
    exception
      when unique_violation then
        select wd.updated_at into cur_updated
        from public.workspace_documents wd
        where wd.organization_id = p_organization_id
          and wd.doc_type = p_doc_type;
        return jsonb_build_object(
          'ok', false,
          'error', 'conflict',
          'current_updated_at', cur_updated
        );
    end;
    return jsonb_build_object('ok', true, 'updated_at', new_ts);
  end if;

  if p_expected_updated_at is null then
    return jsonb_build_object(
      'ok', false,
      'error', 'conflict',
      'current_updated_at', cur_updated
    );
  end if;

  exp_ts := p_expected_updated_at::timestamptz;
  if abs(extract(epoch from cur_updated) - extract(epoch from exp_ts)) > 0.01 then
    return jsonb_build_object(
      'ok', false,
      'error', 'conflict',
      'current_updated_at', cur_updated
    );
  end if;

  update public.workspace_documents
  set body = p_body,
      updated_at = new_ts
  where organization_id = p_organization_id
    and doc_type = p_doc_type
    and abs(extract(epoch from updated_at) - extract(epoch from exp_ts)) <= 0.01
  returning updated_at into v_ret;

  if v_ret is null then
    select wd.updated_at into cur_updated
    from public.workspace_documents wd
    where wd.organization_id = p_organization_id
      and wd.doc_type = p_doc_type;
    return jsonb_build_object(
      'ok', false,
      'error', 'conflict',
      'current_updated_at', cur_updated
    );
  end if;

  return jsonb_build_object('ok', true, 'updated_at', v_ret);
end;
$$;
