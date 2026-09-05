import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import {
  HardwareBoundCryptoService,
  type AppSettingsRepository,
  type EncryptedApiKeyRecord,
  OpenAiInvoiceVisionService,
} from "../src/index.js";

class MemorySettings implements AppSettingsRepository {
  public value: EncryptedApiKeyRecord | null = null;
  async getOpenAiApiKey() { return this.value; }
  async saveOpenAiApiKey(record: EncryptedApiKeyRecord) { this.value = record; }
  async deleteOpenAiApiKey() { this.value = null; }
}

test("posts only an optimized inline image to Responses", async () => {
  const settings = new MemorySettings();
  const crypto = new HardwareBoundCryptoService(settings, { getMachineId: () => "test-machine" });
  await crypto.saveMerchantOpenAiApiKey("sk-1234567890abcdefghijklmnop");
  let requestedUrl = "";
  let request: Record<string, unknown> | undefined;
  const vision = new OpenAiInvoiceVisionService(
    crypto,
    undefined,
    async (url, init) => {
      requestedUrl = url;
      request = JSON.parse(String(init.body));
      assert.equal((init.headers as Record<string, string>).Authorization, "Bearer sk-1234567890abcdefghijklmnop");
      return new Response(JSON.stringify({ output_text: '{"invoiceNumber":"INV-1"}' }), { status: 200 });
    },
  );
  const image = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: "white" } })
    .png().toBuffer();
  const parsed = await vision.parseInvoice(image, "Return JSON only");

  assert.equal(requestedUrl, "https://api.openai.com/v1/responses");
  assert.equal(request?.store, false);
  const input = request?.input as Array<{ content: Array<{ image_url?: string }> }>;
  assert.match(input[0]!.content[1]!.image_url!, /^data:image\/jpeg;base64,/);
  assert.deepEqual(parsed, { invoiceNumber: "INV-1" });
});
