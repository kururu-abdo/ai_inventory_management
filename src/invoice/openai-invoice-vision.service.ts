import { HardwareBoundCryptoService } from "../security/hardware-crypto.service.js";
import { LocalInvoiceImageOptimizer, type ImageOptimizationOptions } from "./local-image-optimizer.service.js";

export interface InvoiceVisionOptions {
  model?: string;
  image?: ImageOptimizationOptions;
  signal?: AbortSignal;
}

export interface OpenAiResponsesSuccess {
  output_text?: string;
  output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
  error?: { message?: string };
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Sends only an optimized Data URL in the Responses request body. No image is
 * uploaded to Supabase Storage, OpenAI Files, or any intermediate cloud bucket.
 */
export class OpenAiInvoiceVisionService {
  public constructor(
    private readonly crypto: HardwareBoundCryptoService,
    private readonly optimizer = new LocalInvoiceImageOptimizer(),
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  public async parseInvoice(
    localImage: string | Buffer,
    prompt: string,
    options: InvoiceVisionOptions = {},
  ): Promise<unknown> {
    let optimizedDataUrl: string | undefined;
    try {
      const optimized = await this.optimizer.optimize(localImage, options.image);
      optimizedDataUrl = optimized.dataUrl;
      const model = options.model ?? "gpt-4o-mini";

      return await this.createResponse([
        { type: "input_text", text: prompt },
        { type: "input_image", image_url: optimizedDataUrl, detail: "high" },
      ], model, options.signal);
    } finally {
      // Do not cache or persist base64 invoice data; drop the application reference.
      optimizedDataUrl = undefined;
    }
  }

  /**
   * Cheapest fallback: sends local OCR text only, never the invoice image. The
   * caller must obtain the merchant's explicit cloud-consent first.
   */
  public async parseExtractedText(
    extractedText: string,
    prompt: string,
    options: Omit<InvoiceVisionOptions, "image"> = {},
  ): Promise<unknown> {
    const text = extractedText.trim();
    if (!text) throw new Error("Cannot use text-only fallback without local OCR text");
    return this.createResponse(
      [
        { type: "input_text", text: `${prompt}\n\nLOCAL OCR TEXT (untrusted):\n${text}` },
      ],
      options.model ?? "gpt-4o-mini",
      options.signal,
    );
  }

  private async createResponse(
    content: Array<Record<string, unknown>>,
    model: string,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    return this.crypto.withDecryptedMerchantOpenAiKey(async (apiKeyBuffer) => {
        // Decryption has just occurred. This string is scoped to this request only.
        let authorization = `Bearer ${apiKeyBuffer.toString("utf8")}`;
        try {
          const response = await this.fetchImpl("https://api.openai.com/v1/responses", {
            method: "POST",
            signal,
            headers: {
              "Content-Type": "application/json",
              Authorization: authorization,
            },
            body: JSON.stringify({
              model,
              store: false,
              input: [{
                role: "user",
                content,
              }],
            }),
          });
          const payload = await response.json() as OpenAiResponsesSuccess;
          if (!response.ok) {
            throw new Error(`OpenAI Vision request failed (${response.status}): ${payload.error?.message ?? "unknown error"}`);
          }
          const outputText = extractOutputText(payload);
          try {
            return JSON.parse(outputText);
          } catch {
            return outputText;
          }
        } finally {
          // JS strings cannot be deterministically overwritten; remove the only
          // application reference immediately. The backing Buffer is zeroed by
          // withDecryptedMerchantOpenAiKey's finally block.
          authorization = "";
        }
    });
  }
}

function extractOutputText(payload: OpenAiResponsesSuccess): string {
  if (payload.output_text) return payload.output_text;
  const text = payload.output
    ?.flatMap((item) => item.content ?? [])
    .find((content) => content.type === "output_text")?.text;
  if (!text) throw new Error("OpenAI returned no invoice text output");
  return text;
}
