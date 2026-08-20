-- Fix 403 on /rest/v1/users from the PastQ frontend (anon key + user JWT).
-- Run in Supabase SQL Editor: https://supabase.com/dashboard → SQL → New query

-- Ensure RLS is on
alter table public.users enable row level security;

-- Drop old policies if re-running
drop policy if exists "users_select_own" on public.users;
drop policy if exists "users_insert_own" on public.users;
drop policy if exists "users_update_own" on public.users;

-- Authenticated users can read/insert/update only their own row
create policy "users_select_own"
  on public.users for select
  to authenticated
  using (auth.uid() = id);

create policy "users_insert_own"
  on public.users for insert
  to authenticated
  with check (auth.uid() = id);

create policy "users_update_own"
  on public.users for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);
