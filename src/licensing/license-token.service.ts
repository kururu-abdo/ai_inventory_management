import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import type { HardwareIdProvider } from "../security/hardware-crypto.service.js";
import type { LicenseSettingsRepository, LocalLicenseRecord } from "../security/app-settings.js";

const TOKEN_VERSION = 1;
const IV_BYTES = 12;

export interface LicenseClaims {
  version: 1;
  storeId: string;
  hardwareIdHash: string;
  expiresAt: string;
  issuedAt: string;
  nonce: string;
}

export interface LicenseVerification {
  valid: boolean;
  reason?: "missing" | "malformed" | "wrong_device" | "expired" | "tampered";
  expiresAt?: string;
}

/**
 * Developer-side generator. The raw device ID is provided by the registered
 * store; only its SHA-256 digest is embedded in the encrypted license payload.
 */
export class DeveloperLicenseGenerator {
  public generate(input: { storeId: string; deviceId: string; expiresAt: string }): string {
    const expiry = new Date(input.expiresAt);
    if (!input.storeId || !input.deviceId || Number.isNaN(expiry.valueOf()) || expiry <= new Date()) {
      throw new Error("Store ID, device ID, and a future expiry date are required");
    }
    const claims: LicenseClaims = {
      version: TOKEN_VERSION,
      storeId: input.storeId,
      hardwareIdHash: hashHardwareId(input.deviceId),
      expiresAt: expiry.toISOString(),
      issuedAt: new Date().toISOString(),
      nonce: randomUUID(),
    };
    const key = deriveLicenseKey(input.deviceId);
    const iv = randomBytes(IV_BYTES);
    let plaintext: Buffer | undefined;
    let encrypted: Buffer | undefined;
    try {
      plaintext = Buffer.from(JSON.stringify(claims), "utf8");
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      // Versioned dot format is easy to paste, does not reveal claims, and is authenticated.
      return [TOKEN_VERSION, toBase64Url(iv), toBase64Url(cipher.getAuthTag()), toBase64Url(encrypted)].join(".");
    } finally {
      key.fill(0); iv.fill(0); plaintext?.fill(0); encrypted?.fill(0);
    }
  }
}

/** Desktop-side verifier: all checks run locally and survive loss of internet. */
export class LocalLicenseVerifier {
  public constructor(
    private readonly hardwareId: HardwareIdProvider,
    private readonly settings: LicenseSettingsRepository,
  ) {}

  public async verify(now = new Date()): Promise<LicenseVerification> {
    const stored = await this.settings.getLicense();
    if (!stored.licenseKey) return this.persist({ valid: false, reason: "missing" });
    // A cloud-confirmed revocation is persisted locally and must win even when
    // the encrypted token itself has a future expiry date.
    if (stored.licenseStatus === "expired") return { valid: false, reason: "expired", expiresAt: stored.licenseExpiryDate ?? undefined };
    const deviceId = this.hardwareId.getMachineId();
    let key: Buffer | undefined;
    let iv: Buffer | undefined;
    let tag: Buffer | undefined;
    let encrypted: Buffer | undefined;
    let plaintext: Buffer | undefined;
    try {
      const [version, ivPart, tagPart, encryptedPart, extra] = stored.licenseKey.split(".");
      if (version !== String(TOKEN_VERSION) || !ivPart || !tagPart || !encryptedPart || extra) return this.persist({ valid: false, reason: "malformed" });
      key = deriveLicenseKey(deviceId);
      iv = fromBase64Url(ivPart); tag = fromBase64Url(tagPart); encrypted = fromBase64Url(encryptedPart);
      if (iv.length !== IV_BYTES || tag.length !== 16 || encrypted.length === 0) return this.persist({ valid: false, reason: "malformed" });
      const decipher = createDecipheriv("aes-256-gcm", key, iv); decipher.setAuthTag(tag);
      plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
      const claims = JSON.parse(plaintext.toString("utf8")) as LicenseClaims;
      if (claims.version !== TOKEN_VERSION || claims.hardwareIdHash !== hashHardwareId(deviceId)) {
        return this.persist({ valid: false, reason: "wrong_device" });
      }
      if (new Date(claims.expiresAt) <= now) return this.persist({ valid: false, reason: "expired", expiresAt: claims.expiresAt });
      return this.persist({ valid: true, expiresAt: claims.expiresAt });
    } catch {
      return this.persist({ valid: false, reason: "tampered" });
    } finally {
      key?.fill(0); iv?.fill(0); tag?.fill(0); encrypted?.fill(0); plaintext?.fill(0);
    }
  }

  public async install(token: string): Promise<LicenseVerification> {
    // `active` permits the first cryptographic validation; it becomes expired
    // only after verification failure, expiry, or an online revocation.
    await this.settings.saveLicense({ licenseKey: token.trim(), licenseExpiryDate: null, licenseStatus: "active" });
    return this.verify();
  }

  private async persist(result: LicenseVerification): Promise<LicenseVerification> {
    await this.settings.saveLicense({
      licenseKey: (await this.settings.getLicense()).licenseKey,
      licenseExpiryDate: result.expiresAt ?? null,
      licenseStatus: result.valid ? "active" : "expired",
    });
    return result;
  }
}

export function hashHardwareId(deviceId: string): string {
  return createHash("sha256").update("offline-pos/license-device/v1\0").update(deviceId.trim()).digest("hex");
}

function deriveLicenseKey(deviceId: string): Buffer {
  return createHash("sha256").update("offline-pos/license-key/v1\0").update(deviceId.trim()).digest();
}
function toBase64Url(value: Buffer): string { return value.toString("base64url"); }
function fromBase64Url(value: string): Buffer { return Buffer.from(value, "base64url"); }
