-- Rolle "viewer": nur Lesen (keine Schreib-Policies für workspace_documents)

alter table public.profiles
  drop constraint if exists profiles_role_check;

alter table public.profiles
  add constraint profiles_role_check
  check (role in ('admin', 'planung', 'therapie', 'viewer'));
