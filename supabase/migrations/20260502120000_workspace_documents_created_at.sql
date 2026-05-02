-- workspace_documents: created_at für Nachvollziehbarkeit / Spec (created_at + updated_at)

alter table public.workspace_documents
  add column if not exists created_at timestamptz;

update public.workspace_documents
set created_at = updated_at
where created_at is null;

alter table public.workspace_documents
  alter column created_at set default now(),
  alter column created_at set not null;
