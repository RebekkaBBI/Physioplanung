-- Optimistic Locking: Schreiben nur, wenn updated_at noch dem vom Client bekannten Stand entspricht.
-- SECURITY INVOKER: RLS auf workspace_documents greift wie bei direktem INSERT/UPDATE.

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
begin
  if p_doc_type not in ('slots', 'panels', 'ui') then
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

  if p_expected_updated_at is null
     or cur_updated is distinct from p_expected_updated_at then
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
    and updated_at = p_expected_updated_at
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

revoke all on function public.apply_workspace_document_patch(uuid, text, jsonb, timestamptz) from public;
grant execute on function public.apply_workspace_document_patch(uuid, text, jsonb, timestamptz) to authenticated;
