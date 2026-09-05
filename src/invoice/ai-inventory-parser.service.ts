import { HardwareBoundCryptoService } from "../security/hardware-crypto.service.js";
import { LocalInvoiceImageOptimizer } from "./local-image-optimizer.service.js";
import type { FetchLike, OpenAiResponsesSuccess } from "./openai-invoice-vision.service.js";

export interface SupplierInvoiceProduct {
  product_name: string;
  barcode: string;
  quantity: number;
  cost_price: number;
}

export interface SupplierInvoiceParseResult {
  products: SupplierInvoiceProduct[];
}

const SUPPLIER_INVOICE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["products"],
  properties: {
    products: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["product_name", "barcode", "quantity", "cost_price"],
        properties: {
          product_name: { type: "string" },
          barcode: { type: "string", description: "Empty string if absent or unreadable" },
          quantity: { type: "integer", minimum: 1 },
          cost_price: { type: "number", minimum: 0 },
        },
      },
    },
  },
} as const;

/**
 * BYO-key supplier parser. It sends only the already-compressed local image and
 * invokes OpenAI only after the caller has completed its consent policy.
 */
export class AiInventoryParserService {
  public constructor(
    private readonly crypto: HardwareBoundCryptoService,
    private readonly optimizer = new LocalInvoiceImageOptimizer(),
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  public async parseSupplierInvoice(
    localImage: string | Buffer,
    options: { model?: "gpt-4o-mini" | "gpt-4o"; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<SupplierInvoiceParseResult> {
    const optimized = await this.optimizer.optimize(localImage);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("OpenAI request timed out")), options.timeoutMs ?? 30_000);
    const forwardAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", forwardAbort, { once: true });

    try {
      return await this.crypto.withDecryptedMerchantOpenAiKey(async (apiKeyBuffer) => {
        let authorization = `Bearer ${apiKeyBuffer.toString("utf8")}`;
        try {
          const response = await this.fetchImpl("https://api.openai.com/v1/responses", {
            method: "POST",
            signal: controller.signal,
            headers: { "Content-Type": "application/json", Authorization: authorization },
            body: JSON.stringify({
              model: options.model ?? "gpt-4o-mini",
              store: false,
              input: [{
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text: "Extract supplier-invoice products. Return every distinct line item. Never invent a barcode; use an empty string when missing. Return only the requested structured JSON.",
                  },
                  { type: "input_image", image_url: optimized.dataUrl, detail: "high" },
                ],
              }],
              text: {
                format: {
                  type: "json_schema",
                  name: "supplier_inventory",
                  strict: true,
                  schema: SUPPLIER_INVOICE_SCHEMA,
                },
              },
            }),
          });
          const payload = await response.json() as OpenAiResponsesSuccess;
          if (!response.ok) {
            if (response.status === 401) throw new Error("OpenAI rejected the merchant API key");
            throw new Error(`OpenAI supplier parse failed (${response.status}): ${payload.error?.message ?? "unknown error"}`);
          }
          const output = getOutputText(payload);
          return validateSupplierProducts(JSON.parse(output));
        } catch (error) {
          if (controller.signal.aborted) throw new Error("OpenAI supplier parse timed out or was cancelled");
          if (error instanceof SyntaxError) throw new Error("OpenAI returned invalid structured invoice data");
          throw error;
        } finally {
          authorization = ""; // Buffer is zeroized by HardwareBoundCryptoService.
        }
      });
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", forwardAbort);
      // `optimized.dataUrl` is intentionally not cached or persisted.
    }
  }
}

function getOutputText(payload: OpenAiResponsesSuccess): string {
  if (payload.output_text) return payload.output_text;
  const output = payload.output?.flatMap((item) => item.content ?? [])
    .find((content) => content.type === "output_text")?.text;
  if (!output) throw new Error("OpenAI returned no structured supplier data");
  return output;
}

function validateSupplierProducts(value: unknown): SupplierInvoiceParseResult {
  if (!value || typeof value !== "object" || !Array.isArray((value as { products?: unknown }).products)) {
    throw new Error("OpenAI response does not contain a products array");
  }
  const products = (value as { products: unknown[] }).products.map((item) => {
    const product = item as Partial<SupplierInvoiceProduct>;
    const quantity = product?.quantity;
    if (!product || typeof product.product_name !== "string" || typeof product.barcode !== "string" ||
      typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1 ||
      typeof product.cost_price !== "number" || !Number.isFinite(product.cost_price) || product.cost_price < 0) {
      throw new Error("OpenAI response has an invalid product row");
    }
    return { product_name: product.product_name.trim(), barcode: product.barcode.trim(), quantity, cost_price: product.cost_price };
  });
  return { products };
}
