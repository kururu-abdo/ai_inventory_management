import type Database from "better-sqlite3";

export const CLIENT_SETUP_MIGRATION = `
CREATE TABLE IF NOT EXISTS client_setup (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  store_id TEXT NOT NULL,
  store_name TEXT NOT NULL,
  merchant_email TEXT,
  supabase_url TEXT NOT NULL,
  supabase_publishable_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);`;

export interface ClientSetup {
  version: 1;
  storeId: string;
  storeName: string;
  merchantEmail?: string;
  supabaseUrl: string;
  supabasePublishableKey: string;
  licenseKey: string;
}

export type SavedClientSetup = Omit<ClientSetup, "licenseKey">;

/** Public connection details only. Tokens, passwords, and service keys never enter this table. */
export class SqliteClientSetupRepository {
  public constructor(private readonly db: Database.Database) {}
  public migrate(): void { this.db.exec(CLIENT_SETUP_MIGRATION); }
  public get(): SavedClientSetup | null {
    const row = this.db.prepare("SELECT store_id,store_name,merchant_email,supabase_url,supabase_publishable_key FROM client_setup WHERE id = 1").get() as Record<string, unknown> | undefined;
    return row ? { version: 1, storeId: String(row.store_id), storeName: String(row.store_name), merchantEmail: row.merchant_email ? String(row.merchant_email) : undefined, supabaseUrl: String(row.supabase_url), supabasePublishableKey: String(row.supabase_publishable_key) } : null;
  }
  public save(setup: SavedClientSetup): void {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO client_setup (id,store_id,store_name,merchant_email,supabase_url,supabase_publishable_key,created_at,updated_at)
      VALUES (1,@storeId,@storeName,@merchantEmail,@supabaseUrl,@supabasePublishableKey,@createdAt,@updatedAt)
      ON CONFLICT(id) DO UPDATE SET store_id=excluded.store_id,store_name=excluded.store_name,merchant_email=excluded.merchant_email,supabase_url=excluded.supabase_url,supabase_publishable_key=excluded.supabase_publishable_key,updated_at=excluded.updated_at`)
      .run({ ...setup, merchantEmail: setup.merchantEmail ?? null, createdAt: now, updatedAt: now });
  }
}

export function validateClientSetup(value: unknown): ClientSetup {
  if (!value || typeof value !== "object") throw new Error("ملف إعداد التاجر غير صحيح");
  const setup = value as Partial<ClientSetup>;
  if (setup.version !== 1 || !isUuid(setup.storeId) || !validText(setup.storeName) || !validText(setup.licenseKey) || typeof setup.supabaseUrl !== "string" || !setup.supabaseUrl.startsWith("https://") || !validText(setup.supabasePublishableKey)) throw new Error("ملف إعداد التاجر ناقص أو غير صحيح");
  if (setup.merchantEmail !== undefined && (typeof setup.merchantEmail !== "string" || setup.merchantEmail.length > 320)) throw new Error("الإيميل في ملف الإعداد غير صحيح");
  return { version: 1, storeId: setup.storeId, storeName: setup.storeName.trim(), merchantEmail: setup.merchantEmail?.trim(), supabaseUrl: setup.supabaseUrl, supabasePublishableKey: setup.supabasePublishableKey, licenseKey: setup.licenseKey };
}
function validText(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 && value.length < 10_000; }
function isUuid(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
