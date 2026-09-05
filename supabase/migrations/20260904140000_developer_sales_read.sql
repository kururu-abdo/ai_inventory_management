-- Developer-only, read-only dashboard visibility for commercial support.
-- Merchant owners retain their existing RLS permissions; this does not grant
-- the developer write access to business records.
create policy "products: developer reads all"
  on public.products for select
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'developer');

create policy "sales: developer reads all"
  on public.sales_invoices for select
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'developer');

create policy "items: developer reads all"
  on public.invoice_items for select
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'developer');
