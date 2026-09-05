-- The developer dashboard must see commercial health, not merchant invoice
-- details. Remove the broad read policies introduced for the temporary sales
-- list and expose only aggregated daily KPIs.
drop policy if exists "products: developer reads all" on public.products;
drop policy if exists "sales: developer reads all" on public.sales_invoices;
drop policy if exists "items: developer reads all" on public.invoice_items;

create or replace function public.developer_sales_overview(
  p_from timestamptz default (now() - interval '30 days')
)
returns table (
  sale_day date,
  invoices_count bigint,
  gross_amount numeric,
  discount_amount numeric,
  net_amount numeric
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'developer' then
    raise exception 'Developer role required';
  end if;

  return query
  select
    (s.created_at at time zone 'UTC')::date as sale_day,
    count(*)::bigint as invoices_count,
    coalesce(sum(s.total_amount), 0)::numeric as gross_amount,
    coalesce(sum(s.discount), 0)::numeric as discount_amount,
    coalesce(sum(s.final_amount), 0)::numeric as net_amount
  from public.sales_invoices s
  where s.created_at >= p_from
  group by (s.created_at at time zone 'UTC')::date
  order by sale_day;
end;
$$;

revoke all on function public.developer_sales_overview(timestamptz) from public;
grant execute on function public.developer_sales_overview(timestamptz) to authenticated;
