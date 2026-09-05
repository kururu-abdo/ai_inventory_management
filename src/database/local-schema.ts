/**
 * SQLite is the source of truth while offline. All application records use
 * client-generated UUIDv4 values; SQLite never invents syncable identifiers.
 */
export const LOCAL_POS_SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS stores (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  hardware_id_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sync_status TEXT NOT NULL CHECK(sync_status IN ('synced','pending_insert','pending_update'))
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY NOT NULL,
  store_id TEXT NOT NULL REFERENCES stores(id),
  barcode TEXT,
  image_url TEXT,
  name TEXT NOT NULL,
  cost_price REAL NOT NULL CHECK(cost_price >= 0),
  sale_price REAL NOT NULL CHECK(sale_price >= 0),
  stock_quantity REAL NOT NULL DEFAULT 0,
  min_stock_level REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sync_status TEXT NOT NULL CHECK(sync_status IN ('synced','pending_insert','pending_update'))
);
CREATE UNIQUE INDEX IF NOT EXISTS products_store_barcode_unique
  ON products(store_id, barcode) WHERE barcode IS NOT NULL;
CREATE INDEX IF NOT EXISTS products_sync_index ON products(sync_status, updated_at);

CREATE TABLE IF NOT EXISTS sales_invoices (
  id TEXT PRIMARY KEY NOT NULL,
  store_id TEXT NOT NULL REFERENCES stores(id),
  invoice_number TEXT NOT NULL,
  total_amount REAL NOT NULL CHECK(total_amount >= 0),
  discount REAL NOT NULL DEFAULT 0 CHECK(discount >= 0),
  final_amount REAL NOT NULL CHECK(final_amount >= 0),
  payment_method TEXT NOT NULL CHECK(payment_method IN ('cash','card','bank_transfer','credit')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sync_status TEXT NOT NULL CHECK(sync_status IN ('synced','pending_insert','pending_update')),
  UNIQUE(store_id, invoice_number)
);
CREATE INDEX IF NOT EXISTS sales_invoices_sync_index ON sales_invoices(sync_status, updated_at);

CREATE TABLE IF NOT EXISTS invoice_items (
  id TEXT PRIMARY KEY NOT NULL,
  store_id TEXT NOT NULL REFERENCES stores(id),
  invoice_id TEXT NOT NULL REFERENCES sales_invoices(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  quantity REAL NOT NULL CHECK(quantity > 0),
  unit_price REAL NOT NULL CHECK(unit_price >= 0),
  sub_total REAL NOT NULL CHECK(sub_total >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sync_status TEXT NOT NULL CHECK(sync_status IN ('synced','pending_insert','pending_update'))
);
CREATE INDEX IF NOT EXISTS invoice_items_sync_index ON invoice_items(sync_status, updated_at);

-- Review records are intentionally local; unaccepted AI suggestions never sync.
CREATE TABLE IF NOT EXISTS pending_product_reviews (
  id TEXT PRIMARY KEY NOT NULL,
  store_id TEXT NOT NULL REFERENCES stores(id),
  product_name TEXT NOT NULL,
  barcode TEXT,
  quantity REAL NOT NULL CHECK(quantity > 0),
  cost_price REAL NOT NULL CHECK(cost_price >= 0),
  source_invoice_id TEXT,
  created_at TEXT NOT NULL
);

-- Durable sync metadata/outbox. The entity rows remain the actual payload.
CREATE TABLE IF NOT EXISTS sync_state (
  entity TEXT PRIMARY KEY NOT NULL CHECK(entity IN ('products','sales_invoices','invoice_items')),
  last_pulled_at TEXT
);
INSERT OR IGNORE INTO sync_state(entity, last_pulled_at)
VALUES ('products', NULL), ('sales_invoices', NULL), ('invoice_items', NULL);
`;
