import type { LocalOcrResult } from "./local-ocr.types.js";

export interface InvoiceLineItem {
  description: string;
  quantity: number;
  unitPrice?: number;
  total: number;
}

export interface ParsedInvoice {
  vendorName?: string;
  invoiceNumber?: string;
  invoiceDate?: string;
  currency?: string;
  total?: number;
  items: InvoiceLineItem[];
  source: "local-rule-matrix" | "openai";
}

export interface VendorInvoiceTemplate {
  id: string;
  vendorName: string;
  /** Every marker must occur for a trusted local template match. */
  requiredMarkers: RegExp[];
  invoiceNumberPatterns?: RegExp[];
  datePatterns?: RegExp[];
  totalPatterns?: RegExp[];
  /** Use named groups: description, quantity, unitPrice (optional), total. */
  lineItemPattern: RegExp;
  currency?: string;
  minItems?: number;
}

export interface RuleParseMatch {
  templateId: string;
  confidence: number;
  invoice: ParsedInvoice;
}

/**
 * Vendor-specific rules live locally and are versioned with the app. Add one
 * template per supplier from verified sample invoices; do not relax markers to
 * make a rule match an unknown layout.
 */
export class RuleBasedInvoiceParser {
  public constructor(private readonly templates: readonly VendorInvoiceTemplate[]) {}

  public parse(ocr: LocalOcrResult): RuleParseMatch | null {
    const text = ocr.fullText || ocr.blocks.map((block) => block.text).join("\n");
    for (const template of this.templates) {
      if (!template.requiredMarkers.every((marker) => test(marker, text))) continue;

      const items = extractItems(template.lineItemPattern, text);
      const minimumItems = template.minItems ?? 1;
      if (items.length < minimumItems) continue;

      const markerConfidence = template.requiredMarkers.length === 0
        ? 0.6
        : 1;
      const itemConfidence = Math.min(1, items.length / Math.max(minimumItems, 2));
      const confidence = Number((markerConfidence * 0.75 + itemConfidence * 0.25).toFixed(2));
      return {
        templateId: template.id,
        confidence,
        invoice: {
          vendorName: template.vendorName,
          invoiceNumber: firstCapture(template.invoiceNumberPatterns, text),
          invoiceDate: firstCapture(template.datePatterns, text),
          total: toAmount(firstCapture(template.totalPatterns, text)),
          currency: template.currency,
          items,
          source: "local-rule-matrix",
        },
      };
    }
    return null;
  }
}

/** A conservative starter matrix. Replace marker strings with real supplier IDs. */
export const DEFAULT_VENDOR_RULE_MATRIX: readonly VendorInvoiceTemplate[] = [
  {
    id: "generic-english-tax-invoice-v1",
    vendorName: "Local English Tax Invoice",
    requiredMarkers: [/\bTAX\s+INVOICE\b/i, /\bINVOICE\s*(?:NO|#)\b/i],
    invoiceNumberPatterns: [/\bINVOICE\s*(?:NO|#)\s*[:.-]?\s*([A-Z0-9/-]+)/i],
    datePatterns: [/\bDATE\s*[:.-]?\s*(\d{1,4}[/-]\d{1,2}[/-]\d{1,4})/i],
    totalPatterns: [/\b(?:GRAND\s+)?TOTAL\s*[:.-]?\s*(?:SDG|USD|£)?\s*([\d,.]+)/i],
    // The required two+ spaces reduce false positives from prose lines.
    lineItemPattern: /^(?<description>[A-Za-z][A-Za-z0-9 .,&()/+-]{2,}?)\s{2,}(?<quantity>\d+(?:\.\d+)?)\s+(?<unitPrice>[\d,.]+)\s+(?<total>[\d,.]+)$/gim,
    currency: "SDG",
  },
  {
    id: "generic-arabic-invoice-v1",
    vendorName: "Local Arabic Invoice",
    requiredMarkers: [/فاتورة/, /(?:رقم\s*الفاتورة|رقم\s*فاتورة)/],
    invoiceNumberPatterns: [/(?:رقم\s*الفاتورة|رقم\s*فاتورة)\s*[:.-]?\s*([A-Z0-9٠-٩/-]+)/i],
    totalPatterns: [/(?:الإجمالي|الاجمالي|المجموع)\s*[:.-]?\s*([\d,٫.٠-٩]+)/i],
    lineItemPattern: /^(?<description>[\u0600-\u06FF][\u0600-\u06FF\w .،()/-]{2,}?)\s{2,}(?<quantity>[\d٠-٩]+(?:[.,٫][\d٠-٩]+)?)\s+(?<unitPrice>[\d,٫.٠-٩]+)\s+(?<total>[\d,٫.٠-٩]+)$/gim,
    currency: "SDG",
  },
];

function test(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(value);
}

function firstCapture(patterns: readonly RegExp[] | undefined, text: string): string | undefined {
  for (const pattern of patterns ?? []) {
    pattern.lastIndex = 0;
    const match = pattern.exec(text);
    if (match?.[1]) return match[1].trim();
  }
  return undefined;
}

function extractItems(pattern: RegExp, text: string): InvoiceLineItem[] {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const globalPattern = new RegExp(pattern.source, flags);
  return Array.from(text.matchAll(globalPattern)).flatMap((match) => {
    const groups = match.groups;
    const quantity = toAmount(groups?.quantity);
    const total = toAmount(groups?.total);
    if (!groups?.description || quantity === undefined || total === undefined) return [];
    return [{
      description: groups.description.trim(),
      quantity,
      unitPrice: toAmount(groups.unitPrice),
      total,
    }];
  });
}

function toAmount(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const westernDigits = value.replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)));
  const source = westernDigits.replace(/\s/g, "").replace(/٫/g, ".");
  const lastDot = source.lastIndexOf(".");
  const lastComma = source.lastIndexOf(",");
  let normalized: string;
  if (lastDot >= 0 && lastComma >= 0) {
    // The final separator is the decimal separator; the other is a grouping mark.
    const decimalIndex = Math.max(lastDot, lastComma);
    normalized = `${source.slice(0, decimalIndex).replace(/[.,]/g, "")}.${source.slice(decimalIndex + 1).replace(/[.,]/g, "")}`;
  } else if (lastComma >= 0 && source.length - lastComma - 1 <= 2) {
    normalized = source.replace(",", ".");
  } else {
    normalized = source.replace(/,/g, "");
  }
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : undefined;
}
