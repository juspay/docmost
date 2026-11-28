-- The Supabase objects mindspace's migrations need, for a plain PostgreSQL
-- scratch database. Apply this, then mindspace's supabase/migrations in order.
-- Only for tests and rehearsals; never for a real Supabase project.

create extension if not exists pgcrypto;

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  -- read by the import: an unconfirmed sign-up is ignored
  email_confirmed_at timestamptz
);

create or replace function auth.uid() returns uuid
  language sql stable as $$ select null::uuid $$;

create or replace function auth.jwt() returns jsonb
  language sql stable as $$ select null::jsonb $$;

-- 0002 uses auth.email() before 0007 replaces it with auth.jwt()
create or replace function auth.email() returns text
  language sql stable as $$ select null::text $$;
