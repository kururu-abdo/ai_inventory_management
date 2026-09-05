import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import machineIdPackage from "node-machine-id";
import {
  OPENAI_API_KEY_SETTING,
  type AppSettingsRepository,
  type EncryptedApiKeyRecord,
} from "./app-settings.js";

const AES_256_GCM = "aes-256-gcm";
const IV_BYTES = 12; // 96 bits: the recommended GCM IV length

export interface HardwareIdProvider {
  getMachineId(): string;
}

/** node-machine-id resolves the OS-managed machine identifier, not a random app id. */
export class NodeMachineIdProvider implements HardwareIdProvider {
  public getMachineId(): string {
    // `true` asks node-machine-id for the underlying OS identifier rather than
    // its hashed convenience value (the package's current TypeScript signature).
    const machineId = machineIdPackage.machineIdSync(true).trim();
    if (!machineId) throw new Error("A stable hardware identifier is unavailable");
    return machineId;
  }
}

export class HardwareBoundCryptoService {
  public constructor(
    private readonly settings: AppSettingsRepository,
    private readonly hardwareId: HardwareIdProvider = new NodeMachineIdProvider(),
  ) {}

  /**
   * Derives exactly 32 bytes for AES-256. Domain separation prevents the same
   * hardware identifier being reused as a key by another feature.
   *
   * Never persist or send this key/fingerprint. If it changes (OS reinstall or
   * motherboard migration), existing ciphertext intentionally cannot decrypt.
   */
  private deriveHardwareKey(): Buffer {
    const machineId = this.hardwareId.getMachineId();
    return createHash("sha256")
      .update("offline-pos/openai-api-key/v1\0", "utf8")
      .update(machineId, "utf8")
      .digest();
  }

  /** Encrypts before persistence; plaintext never reaches SQLite. */
  public async saveMerchantOpenAiApiKey(apiKey: string): Promise<void> {
    if (!/^sk-[A-Za-z0-9_-]{16,}$/.test(apiKey.trim())) {
      throw new Error("The supplied OpenAI API key has an invalid format");
    }

    let hardwareKey: Buffer | undefined;
    let plaintext: Buffer | undefined;
    let ciphertext: Buffer | undefined;
    try {
      hardwareKey = this.deriveHardwareKey();
      plaintext = Buffer.from(apiKey.trim(), "utf8");
      const iv = randomBytes(IV_BYTES); // New IV for every encryption operation.
      const cipher = createCipheriv(AES_256_GCM, hardwareKey, iv);
      ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const now = new Date().toISOString();
      const existing = await this.settings.getOpenAiApiKey();
      const record: EncryptedApiKeyRecord = {
        id: existing?.id ?? randomUUID(), // UUIDv4 local primary key
        settingKey: OPENAI_API_KEY_SETTING,
        encryptedKey: ciphertext.toString("base64"),
        iv: iv.toString("base64"),
        authTag: cipher.getAuthTag().toString("base64"),
        algorithm: AES_256_GCM,
        keyVersion: 1,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      await this.settings.saveOpenAiApiKey(record);
      iv.fill(0);
    } finally {
      // Best-effort zeroization of mutable secret material held by Node.
      plaintext?.fill(0);
      ciphertext?.fill(0);
      hardwareKey?.fill(0);
    }
  }

  /**
   * Decrypts only for the duration of `action`; it deliberately does not return
   * a key that a caller could retain. AES-GCM authentication failure is treated
   * as a tampered record or a different machine.
   */
  public async withDecryptedMerchantOpenAiKey<T>(
    action: (apiKeyUtf8: Buffer) => Promise<T>,
  ): Promise<T> {
    const record = await this.settings.getOpenAiApiKey();
    if (!record) throw new Error("No merchant OpenAI API key is configured");

    let hardwareKey: Buffer | undefined;
    let iv: Buffer | undefined;
    let encrypted: Buffer | undefined;
    let authTag: Buffer | undefined;
    let plaintext: Buffer | undefined;
    try {
      hardwareKey = this.deriveHardwareKey();
      iv = Buffer.from(record.iv, "base64");
      encrypted = Buffer.from(record.encryptedKey, "base64");
      authTag = Buffer.from(record.authTag, "base64");
      if (iv.length !== IV_BYTES || authTag.length !== 16 || encrypted.length === 0) {
        throw new Error("Malformed encrypted API-key record");
      }
      const decipher = createDecipheriv(AES_256_GCM, hardwareKey, iv);
      decipher.setAuthTag(authTag);
      plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
      return await action(plaintext);
    } catch (error) {
      if (error instanceof Error && /authenticate|Unsupported state/i.test(error.message)) {
        throw new Error("Could not unlock API key: wrong hardware identity or tampered data");
      }
      throw error;
    } finally {
      // This runs on success, failure, or network cancellation: RAM is cleared.
      plaintext?.fill(0);
      authTag?.fill(0);
      encrypted?.fill(0);
      iv?.fill(0);
      hardwareKey?.fill(0);
    }
  }
}
