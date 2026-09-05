import assert from "node:assert/strict";
import test from "node:test";
import {
  HardwareBoundCryptoService,
  type AppSettingsRepository,
  type EncryptedApiKeyRecord,
} from "../src/index.js";

class MemorySettings implements AppSettingsRepository {
  public value: EncryptedApiKeyRecord | null = null;
  async getOpenAiApiKey() { return this.value; }
  async saveOpenAiApiKey(record: EncryptedApiKeyRecord) { this.value = record; }
  async deleteOpenAiApiKey() { this.value = null; }
}

test("persists ciphertext and decrypts only inside callback", async () => {
  const store = new MemorySettings();
  const service = new HardwareBoundCryptoService(store, { getMachineId: () => "test-machine" });
  await service.saveMerchantOpenAiApiKey("sk-1234567890abcdefghijklmnop");
  assert.ok(store.value?.encryptedKey);
  assert.notEqual(store.value?.encryptedKey, "sk-1234567890abcdefghijklmnop");
  const key = await service.withDecryptedMerchantOpenAiKey(async (value) => value.toString("utf8"));
  assert.equal(key, "sk-1234567890abcdefghijklmnop");
});

test("rejects ciphertext copied to a different hardware identity", async () => {
  const store = new MemorySettings();
  const first = new HardwareBoundCryptoService(store, { getMachineId: () => "machine-a" });
  await first.saveMerchantOpenAiApiKey("sk-1234567890abcdefghijklmnop");
  const second = new HardwareBoundCryptoService(store, { getMachineId: () => "machine-b" });
  await assert.rejects(second.withDecryptedMerchantOpenAiKey(async () => undefined));
});
