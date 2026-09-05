import { InvoiceLayoutComplexityScorer } from "./layout-complexity.service.js";
import { type LocalOcrEngine, type LocalOcrResult, readingOrderText } from "./local-ocr.types.js";
import { OpenAiInvoiceVisionService } from "./openai-invoice-vision.service.js";
import {
  RuleBasedInvoiceParser,
  type ParsedInvoice,
  type RuleParseMatch,
} from "./rule-based-invoice-parser.service.js";

export type CloudFallbackChoice = "ocr-text" | "optimized-image" | "deny";

export interface CloudFallbackRequest {
  reason: "no-local-template-match" | "complex-layout";
  layoutComplexity: number;
  localText: string;
  /** Text is recommended for bandwidth; image is reserved for difficult layouts. */
  recommendedChoice: Exclude<CloudFallbackChoice, "deny">;
}

export interface HybridInvoiceOptions {
  /**
   * This callback is the explicit UI consent gate. No cloud call happens until
   * it resolves to an affirmative choice; cancel/close the dialog as `deny`.
   */
  requestCloudPermission: (request: CloudFallbackRequest) => Promise<CloudFallbackChoice>;
  prompt: string;
  complexityThreshold?: number;
  model?: string;
}

export type HybridInvoiceResult =
  | { status: "parsed-locally"; layoutComplexity: number; match: RuleParseMatch }
  | { status: "cloud-consent-required"; layoutComplexity: number; request: CloudFallbackRequest }
  | { status: "parsed-by-cloud"; layoutComplexity: number; transport: "ocr-text" | "optimized-image"; invoice: unknown };

/**
 * Offline-first decision engine. Its only network dependency is the injected
 * Vision service and that can only be reached after UI consent.
 */
export class HybridInvoiceParser<ImageSource = string | Buffer> {
  public constructor(
    private readonly ocr: LocalOcrEngine<ImageSource>,
    private readonly rules: RuleBasedInvoiceParser,
    private readonly vision: OpenAiInvoiceVisionService,
    private readonly complexityScorer = new InvoiceLayoutComplexityScorer(),
  ) {}

  public async parse(
    optimizedLocalImage: ImageSource,
    options: HybridInvoiceOptions,
  ): Promise<HybridInvoiceResult> {
    // Step 1: ML Kit runs locally and yields blocks/coordinates; no cloud traffic.
    const ocr = await this.ocr.recognize(optimizedLocalImage);
    const orderedText = readingOrderText(ocr.blocks) || ocr.fullText;
    const normalizedOcr: LocalOcrResult = { ...ocr, fullText: orderedText };
    const layoutComplexity = this.complexityScorer.score(normalizedOcr);
    const threshold = options.complexityThreshold ?? 0.55;
    if (threshold < 0 || threshold > 1) throw new Error("complexityThreshold must be between 0 and 1");

    // Step 2: exact, local vendor rule match. Complex layouts deliberately do
    // not auto-accept a match, because columns can change the semantic meaning.
    const localMatch = this.rules.parse(normalizedOcr);
    if (localMatch && layoutComplexity < threshold) {
      return { status: "parsed-locally", layoutComplexity, match: localMatch };
    }

    const reason = layoutComplexity >= threshold ? "complex-layout" : "no-local-template-match";
    const request: CloudFallbackRequest = {
      reason,
      layoutComplexity,
      localText: orderedText,
      recommendedChoice: reason === "complex-layout" ? "optimized-image" : "ocr-text",
    };

    // Step 3: consent is mandatory, even if a merchant enabled an API key.
    const choice = await options.requestCloudPermission(request);
    if (choice === "deny") return { status: "cloud-consent-required", layoutComplexity, request };

    const invoice = choice === "ocr-text"
      ? await this.vision.parseExtractedText(orderedText, options.prompt, { model: options.model })
      : await this.vision.parseInvoice(optimizedLocalImage as string | Buffer, options.prompt, { model: options.model });
    return { status: "parsed-by-cloud", layoutComplexity, transport: choice, invoice };
  }
}

/** Helpful UI type guard for consuming locally structured results. */
export function isLocallyParsed(result: HybridInvoiceResult): result is {
  status: "parsed-locally";
  layoutComplexity: number;
  match: RuleParseMatch & { invoice: ParsedInvoice };
} {
  return result.status === "parsed-locally";
}
