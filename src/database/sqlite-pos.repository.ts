import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { LOCAL_POS_SCHEMA } from "./local-schema.js";
import type { InvoiceItem, PendingProductReview, Product, SalesInvoice, SyncStatus } from "./models.js";

type EntityName = "products" | "sales_invoices" | "invoice_items";
type Row = Record<string, unknown>;

/** Main-process-only SQLite gateway. Never expose this object to the renderer. */
export class SqlitePosRepository {
  public readonly db: Database.Database;

  public constructor(filename: string) {
    this.db = new Database(filename);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
  }

  public migrate(): void {
    this.db.exec(LOCAL_POS_SCHEMA);
    // Existing offline installations predate product images. SQLite has no
    // portable ADD COLUMN IF NOT EXISTS, so inspect before altering.
    const columns = this.db.prepare("PRAGMA table_info(products)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "image_url")) this.db.exec("ALTER TABLE products ADD COLUMN image_url TEXT");
  }

  public listProducts(storeId: string): Product[] {
    const rows = this.db.prepare("SELECT * FROM products WHERE store_id = ? ORDER BY name COLLATE NOCASE")
      .all(storeId) as Row[];
    return rows.map(productFromRow);
  }

  public findProductByBarcode(storeId: string, barcode: string): Product | null {
    const row = this.db.prepare("SELECT * FROM products WHERE store_id = ? AND barcode = ?")
      .get(storeId, barcode) as Row | undefined;
    return row ? productFromRow(row) : null;
  }

  public saveProduct(product: Product): void {
    this.db.prepare(`
      INSERT INTO products (id, store_id, barcode, image_url, name, cost_price, sale_price, stock_quantity, min_stock_level, created_at, updated_at, sync_status)
      VALUES (@id, @storeId, @barcode, @imageUrl, @name, @costPrice, @salePrice, @stockQuantity, @minStockLevel, @createdAt, @updatedAt, @syncStatus)
      ON CONFLICT(id) DO UPDATE SET barcode=excluded.barcode, image_url=excluded.image_url, name=excluded.name, cost_price=excluded.cost_price,
        sale_price=excluded.sale_price, stock_quantity=excluded.stock_quantity, min_stock_level=excluded.min_stock_level,
        updated_at=excluded.updated_at, sync_status=excluded.sync_status
    `).run(product);
  }

  public savePendingReview(review: Omit<PendingProductReview, "id" | "createdAt">): PendingProductReview {
    const stored: PendingProductReview = { id: randomUUID(), createdAt: new Date().toISOString(), ...review };
    this.db.prepare(`INSERT INTO pending_product_reviews
      (id, store_id, product_name, barcode, quantity, cost_price, source_invoice_id, created_at)
      VALUES (@id,@storeId,@productName,@barcode,@quantity,@costPrice,@sourceInvoiceId,@createdAt)`).run(stored);
    return stored;
  }

  public listPendingReviews(storeId: string): PendingProductReview[] {
    const rows = this.db.prepare(`SELECT id,store_id,product_name,barcode,quantity,cost_price,source_invoice_id,created_at
      FROM pending_product_reviews WHERE store_id = ? ORDER BY created_at DESC`).all(storeId) as Row[];
    return rows.map((row) => ({
      id: String(row.id), storeId: String(row.store_id), productName: String(row.product_name),
      barcode: row.barcode === null ? null : String(row.barcode), quantity: Number(row.quantity),
      costPrice: Number(row.cost_price), sourceInvoiceId: row.source_invoice_id === null ? null : String(row.source_invoice_id), createdAt: String(row.created_at),
    }));
  }

  public findPendingReview(storeId: string, reviewId: string): PendingProductReview | null {
    return this.listPendingReviews(storeId).find((review) => review.id === reviewId) ?? null;
  }

  public deletePendingReview(storeId: string, reviewId: string): boolean {
    return this.db.prepare("DELETE FROM pending_product_reviews WHERE id = ? AND store_id = ?").run(reviewId, storeId).changes === 1;
  }

  public pendingRows(entity: EntityName, storeId: string): Row[] {
    return this.db.prepare(`SELECT * FROM ${entity} WHERE store_id = ? AND sync_status != 'synced' ORDER BY updated_at ASC`)
      .all(storeId) as Row[];
  }

  public markSynced(entity: EntityName, ids: readonly string[], expectedUpdatedAt: Map<string, string>): void {
    const update = this.db.prepare(`UPDATE ${entity} SET sync_status = 'synced' WHERE id = ? AND updated_at = ?`);
    const transaction = this.db.transaction(() => {
      for (const id of ids) update.run(id, expectedUpdatedAt.get(id));
    });
    transaction();
  }

  /** Applies cloud rows only if they win Last-Write-Wins; a local pending edit wins ties. */
  public applyRemote(entity: EntityName, records: readonly Row[]): void {
    const table = entity;
    const getLocal = this.db.prepare(`SELECT updated_at, sync_status FROM ${table} WHERE id = ?`);
    const transaction = this.db.transaction(() => {
      for (const record of records) {
        const local = getLocal.get(record.id) as { updated_at: string; sync_status: SyncStatus } | undefined;
        const remoteTime = String(record.updated_at);
        if (local && (local.updated_at > remoteTime || (local.updated_at === remoteTime && local.sync_status !== "synced"))) continue;
        this.upsertCloudRecord(entity, record);
      }
    });
    transaction();
  }

  public lastPulledAt(entity: EntityName): string | null {
    const row = this.db.prepare("SELECT last_pulled_at FROM sync_state WHERE entity = ?").get(entity) as { last_pulled_at: string | null };
    return row.last_pulled_at;
  }

  public setLastPulledAt(entity: EntityName, value: string): void {
    this.db.prepare("UPDATE sync_state SET last_pulled_at = ? WHERE entity = ?").run(value, entity);
  }

  public transaction<T>(operation: () => T): T {
    return this.db.transaction(operation)();
  }

  private upsertCloudRecord(entity: EntityName, record: Row): void {
    const columns = Object.keys(record).filter((key) => key !== "sync_status");
    const sqliteColumns = columns.map(toSnakeCase);
    const placeholders = columns.map((key) => `@${key}`);
    const updates = sqliteColumns.filter((column) => column !== "id").map((column) => `${column}=excluded.${column}`).join(", ");
    const statement = `INSERT INTO ${entity} (${sqliteColumns.join(",")},sync_status) VALUES (${placeholders.join(",")},'synced')
      ON CONFLICT(id) DO UPDATE SET ${updates}, sync_status='synced'`;
    this.db.prepare(statement).run(record);
  }
}

function productFromRow(row: Row): Product {
  return {
    id: String(row.id), storeId: String(row.store_id), barcode: row.barcode === null ? null : String(row.barcode), imageUrl: row.image_url === null || row.image_url === undefined ? null : String(row.image_url),
    name: String(row.name), costPrice: Number(row.cost_price), salePrice: Number(row.sale_price),
    stockQuantity: Number(row.stock_quantity), minStockLevel: Number(row.min_stock_level),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at), syncStatus: row.sync_status as SyncStatus,
  };
}

function toSnakeCase(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

export type { EntityName, Product, SalesInvoice, InvoiceItem };
