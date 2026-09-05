import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

/**
 * Keep this migration local. Do not mirror encrypted credentials to Supabase:
 * a hardware-bound cipher text is not useful off-device and expands its attack
 * surface. Sync business data through the outbox only.
 */
export const APP_SETTINGS_MIGRATION = `
CREATE TABLE IF NOT EXISTS app_settings (
  id TEXT PRIMARY KEY NOT NULL,
  setting_key TEXT NOT NULL UNIQUE,
  -- merchant_openai_key is AES-GCM ciphertext, never plaintext.
  merchant_openai_key TEXT,
  iv TEXT,
  auth_tag TEXT,
  algorithm TEXT NOT NULL DEFAULT 'aes-256-gcm',
  key_version INTEGER NOT NULL DEFAULT 1,
  license_key TEXT,
  license_expiry_date TEXT,
  license_status TEXT NOT NULL DEFAULT 'expired' CHECK(license_status IN ('active','expired')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export const OPENAI_API_KEY_SETTING = "merchant_openai_api_key";

export interface EncryptedApiKeyRecord {
  id: string;
  settingKey: typeof OPENAI_API_KEY_SETTING;
  encryptedKey: string; // base64 ciphertext, never plaintext
  iv: string; // base64 96-bit IV
  authTag: string; // base64 128-bit GCM authentication tag
  algorithm: "aes-256-gcm";
  keyVersion: 1;
  createdAt: string;
  updatedAt: string;
}

export interface AppSettingsRepository {
  getOpenAiApiKey(): Promise<EncryptedApiKeyRecord | null>;
  saveOpenAiApiKey(record: EncryptedApiKeyRecord): Promise<void>;
  deleteOpenAiApiKey(): Promise<void>;
}

export interface LocalLicenseRecord {
  licenseKey: string | null;
  licenseExpiryDate: string | null;
  licenseStatus: "active" | "expired";
}

export interface LicenseSettingsRepository {
  getLicense(): Promise<LocalLicenseRecord>;
  saveLicense(license: LocalLicenseRecord): Promise<void>;
}

/** A concrete SQLite adapter. Construct it only in Electron's main process. */
export class SqliteAppSettingsRepository implements AppSettingsRepository, LicenseSettingsRepository {
  public constructor(private readonly db: Database.Database) {}

  public migrate(): void {
    this.db.exec(APP_SETTINGS_MIGRATION);
  }

  public async getOpenAiApiKey(): Promise<EncryptedApiKeyRecord | null> {
    const row = this.db.prepare(`
      SELECT id, setting_key, merchant_openai_key, iv, auth_tag, algorithm,
             key_version, created_at, updated_at
      FROM app_settings WHERE setting_key = ? AND merchant_openai_key IS NOT NULL
    `).get(OPENAI_API_KEY_SETTING) as Record<string, unknown> | undefined;

    if (!row) return null;
    if (row.algorithm !== "aes-256-gcm" || row.key_version !== 1) {
      throw new Error("Unsupported stored API-key encryption format");
    }
    return {
      id: String(row.id),
      settingKey: OPENAI_API_KEY_SETTING,
      encryptedKey: String(row.merchant_openai_key),
      iv: String(row.iv),
      authTag: String(row.auth_tag),
      algorithm: "aes-256-gcm",
      keyVersion: 1,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  public async saveOpenAiApiKey(record: EncryptedApiKeyRecord): Promise<void> {
    this.db.prepare(`
      INSERT INTO app_settings (
        id, setting_key, merchant_openai_key, iv, auth_tag, algorithm, key_version,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(setting_key) DO UPDATE SET
        merchant_openai_key = excluded.merchant_openai_key, iv = excluded.iv,
        auth_tag = excluded.auth_tag, algorithm = excluded.algorithm,
        key_version = excluded.key_version, updated_at = excluded.updated_at
    `).run(
      record.id, record.settingKey, record.encryptedKey, record.iv,
      record.authTag, record.algorithm, record.keyVersion,
      record.createdAt, record.updatedAt,
    );
  }

  public async deleteOpenAiApiKey(): Promise<void> {
    this.db.prepare("UPDATE app_settings SET merchant_openai_key = NULL, iv = NULL, auth_tag = NULL, updated_at = ? WHERE setting_key = ?")
      .run(new Date().toISOString(), OPENAI_API_KEY_SETTING);
  }

  public async getLicense(): Promise<LocalLicenseRecord> {
    const row = this.db.prepare("SELECT license_key, license_expiry_date, license_status FROM app_settings WHERE setting_key = ?")
      .get(OPENAI_API_KEY_SETTING) as { license_key: string | null; license_expiry_date: string | null; license_status: "active" | "expired" } | undefined;
    return row
      ? { licenseKey: row.license_key, licenseExpiryDate: row.license_expiry_date, licenseStatus: row.license_status }
      : { licenseKey: null, licenseExpiryDate: null, licenseStatus: "expired" };
  }

  public async saveLicense(license: LocalLicenseRecord): Promise<void> {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO app_settings (id, setting_key, license_key, license_expiry_date, license_status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(setting_key) DO UPDATE SET license_key=excluded.license_key,
        license_expiry_date=excluded.license_expiry_date, license_status=excluded.license_status, updated_at=excluded.updated_at
    `).run(randomUUID(), OPENAI_API_KEY_SETTING, license.licenseKey, license.licenseExpiryDate, license.licenseStatus, now, now);
  }
}
