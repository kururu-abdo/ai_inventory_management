import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_VENDOR_RULE_MATRIX,
  HardwareBoundCryptoService,
  HybridInvoiceParser,
  type AppSettingsRepository,
  type EncryptedApiKeyRecord,
  OpenAiInvoiceVisionService,
  RuleBasedInvoiceParser,
} from "../src/index.js";

class MemorySettings implements AppSettingsRepository {
  public value: EncryptedApiKeyRecord | null = null;
  async getOpenAiApiKey() { return this.value; }
  async saveOpenAiApiKey(record: EncryptedApiKeyRecord) { this.value = record; }
  async deleteOpenAiApiKey() { this.value = null; }
}

function makeOcr(fullText: string) {
  return {
    async recognize() {
      return {
        fullText,
        blocks: fullText.split("\n").map((text, index) => ({
          text,
          boundingBox: { left: 10, top: index * 20, width: 400, height: 15 },
        })),
      };
    },
  };
}

test("uses a verified local rule and never asks for cloud", async () => {
  let cloudRequested = false;
  const vision = {} as unknown as OpenAiInvoiceVisionService; // It must not be used in this path.
  const parser = new HybridInvoiceParser(
    makeOcr("TAX INVOICE\nINVOICE NO: INV-42\nDATE: 2026-01-20\nRice Bags  2 10.50 21.00\nTOTAL: 21.00"),
    new RuleBasedInvoiceParser(DEFAULT_VENDOR_RULE_MATRIX),
    vision,
  );
  const result = await parser.parse(Buffer.from("unused"), {
    prompt: "Return JSON",
    requestCloudPermission: async () => {
      cloudRequested = true;
      return "ocr-text";
    },
  });
  assert.equal(result.status, "parsed-locally");
  assert.equal(cloudRequested, false);
  if (result.status === "parsed-locally") {
    assert.equal(result.match.invoice.invoiceNumber, "INV-42");
    assert.equal(result.match.invoice.items[0]?.total, 21);
  }
});

test("text fallback happens only after affirmative consent", async () => {
  const settings = new MemorySettings();
  const crypto = new HardwareBoundCryptoService(settings, { getMachineId: () => "test-machine" });
  await crypto.saveMerchantOpenAiApiKey("sk-1234567890abcdefghijklmnop");
  let cloudCalls = 0;
  const vision = new OpenAiInvoiceVisionService(crypto, undefined, async (_url, init) => {
    cloudCalls += 1;
    const request = JSON.parse(String(init.body)) as { input: Array<{ content: Array<{ type: string }> }> };
    assert.deepEqual(request.input[0]?.content.map((part) => part.type), ["input_text"]);
    return new Response(JSON.stringify({ output_text: '{"items":[]}' }), { status: 200 });
  });
  const parser = new HybridInvoiceParser(
    makeOcr("Unrecognized supplier receipt\nTotal 100"),
    new RuleBasedInvoiceParser(DEFAULT_VENDOR_RULE_MATRIX),
    vision,
  );
  const result = await parser.parse(Buffer.from("unused"), {
    prompt: "Return JSON",
    requestCloudPermission: async (request) => {
      assert.equal(request.recommendedChoice, "ocr-text");
      return "ocr-text";
    },
  });
  assert.equal(result.status, "parsed-by-cloud");
  assert.equal(cloudCalls, 1);
});

test("a denied fallback produces no cloud request", async () => {
  let cloudCalls = 0;
  const vision = {
    async parseExtractedText() { cloudCalls += 1; },
    async parseInvoice() { cloudCalls += 1; },
  } as unknown as OpenAiInvoiceVisionService;
  const parser = new HybridInvoiceParser(
    makeOcr("Unknown invoice"),
    new RuleBasedInvoiceParser(DEFAULT_VENDOR_RULE_MATRIX),
    vision,
  );
  const result = await parser.parse(Buffer.from("unused"), {
    prompt: "Return JSON",
    requestCloudPermission: async () => "deny",
  });
  assert.equal(result.status, "cloud-consent-required");
  assert.equal(cloudCalls, 0);
});
