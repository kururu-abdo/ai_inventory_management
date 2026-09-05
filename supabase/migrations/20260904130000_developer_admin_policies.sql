-- Developer accounts can inspect store subscriptions in the Admin dashboard.
-- The role is server-managed app_metadata, never user_metadata.
create policy "stores: developer reads all"
  on public.stores for select
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'developer');
