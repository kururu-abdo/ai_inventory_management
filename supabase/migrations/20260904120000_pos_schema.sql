-- Run with the Supabase CLI. UUIDs are generated client-side for offline safety.
create extension if not exists pgcrypto;

create type public.sync_status as enum ('synced', 'pending_insert', 'pending_update');
create type public.payment_method as enum ('cash', 'card', 'bank_transfer', 'credit');
create type public.license_status as enum ('active', 'expired');

create table public.stores (
  id uuid primary key,
  owner_id uuid not null references auth.users(id),
  name text not null,
  hardware_id_hash text not null unique,
  license_status public.license_status not null default 'expired',
  license_expiry_date timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);




create table public.products (
  id uuid primary key,
  store_id uuid not null references public.stores(id) on delete cascade,
  barcode text,
  image_url text,
  name text not null,
  cost_price numeric(14,2) not null check (cost_price >= 0),
  sale_price numeric(14,2) not null check (sale_price >= 0),
  stock_quantity numeric(14,3) not null default 0,
  min_stock_level numeric(14,3) not null default 0,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  sync_status public.sync_status not null default 'synced',
  unique(store_id, barcode)
);
create unique index products_store_barcode_unique on public.products(store_id, barcode) where barcode is not null;

create table public.sales_invoices (
  id uuid primary key,
  store_id uuid not null references public.stores(id) on delete cascade,
  invoice_number text not null,
  total_amount numeric(14,2) not null check (total_amount >= 0),
  discount numeric(14,2) not null default 0 check (discount >= 0),
  final_amount numeric(14,2) not null check (final_amount >= 0),
  payment_method public.payment_method not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  sync_status public.sync_status not null default 'synced',
  unique(store_id, invoice_number)
);

create table public.invoice_items (
  id uuid primary key,
  store_id uuid not null references public.stores(id) on delete cascade,
  invoice_id uuid not null references public.sales_invoices(id) on delete cascade,
  product_id uuid not null references public.products(id),
  quantity numeric(14,3) not null check (quantity > 0),
  unit_price numeric(14,2) not null check (unit_price >= 0),
  sub_total numeric(14,2) not null check (sub_total >= 0),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  sync_status public.sync_status not null default 'synced'
);

-- Mirrored shape only. The desktop client never syncs its hardware-bound key.
create table public.app_settings (
  id uuid primary key,
  store_id uuid not null unique references public.stores(id) on delete cascade,
  merchant_openai_key text,
  license_key text,
  license_expiry_date timestamptz,
  license_status public.license_status not null default 'expired',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.lww_updated_at_guard() returns trigger language plpgsql as $$
begin
  if new.updated_at < old.updated_at then return old; end if;
  return new;
end; $$;
create trigger products_lww before update on public.products for each row execute function public.lww_updated_at_guard();
create trigger sales_invoices_lww before update on public.sales_invoices for each row execute function public.lww_updated_at_guard();
create trigger invoice_items_lww before update on public.invoice_items for each row execute function public.lww_updated_at_guard();

alter table public.stores enable row level security;
alter table public.products enable row level security;
alter table public.sales_invoices enable row level security;
alter table public.invoice_items enable row level security;
alter table public.app_settings enable row level security;

create policy "stores: owner reads" on public.stores for select using (owner_id = auth.uid());
create policy "products: store owner" on public.products for all using (exists (select 1 from public.stores s where s.id = store_id and s.owner_id = auth.uid())) with check (exists (select 1 from public.stores s where s.id = store_id and s.owner_id = auth.uid()));
create policy "sales: store owner" on public.sales_invoices for all using (exists (select 1 from public.stores s where s.id = store_id and s.owner_id = auth.uid())) with check (exists (select 1 from public.stores s where s.id = store_id and s.owner_id = auth.uid()));
create policy "items: store owner" on public.invoice_items for all using (exists (select 1 from public.stores s where s.id = store_id and s.owner_id = auth.uid())) with check (exists (select 1 from public.stores s where s.id = store_id and s.owner_id = auth.uid()));
create policy "settings: store owner" on public.app_settings for all using (exists (select 1 from public.stores s where s.id = store_id and s.owner_id = auth.uid())) with check (exists (select 1 from public.stores s where s.id = store_id and s.owner_id = auth.uid()));

-- Never put a service-role key in Electron or the React renderer. Admin license
-- operations are implemented by the server-side Edge Function below.
