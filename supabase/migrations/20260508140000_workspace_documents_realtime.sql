-- Clients können per Supabase Realtime auf Änderungen an workspace_documents subscriben
-- (z. B. parallele Mitarbeiter). RLS gilt weiterhin für die Auslieferung.

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'workspace_documents'
  ) then
    alter publication supabase_realtime add table public.workspace_documents;
  end if;
end $$;
