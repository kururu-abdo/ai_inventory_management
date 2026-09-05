import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import { inflateRawSync } from "node:zlib";
import type { Product } from "../database/models.js";
import type { SqlitePosRepository } from "../database/sqlite-pos.repository.js";

const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
const MAX_ZIP_ENTRY_BYTES = 12 * 1024 * 1024;

export interface ProductImportPreviewRow {
  rowNumber: number;
  name: string;
  barcode: string | null;
  costPrice: number;
  salePrice: number;
  stockQuantity: number;
  minStockLevel: number;
  action: "create" | "update";
  errors: string[];
}

export interface ProductImportPreview {
  fileName: string;
  rows: ProductImportPreviewRow[];
  validRows: number;
  invalidRows: number;
}

export interface ProductImportResult {
  created: number;
  updated: number;
}

type Field = "name" | "barcode" | "costPrice" | "salePrice" | "stockQuantity" | "minStockLevel";
type SheetRow = string[];

const HEADER_ALIASES: Record<Field, readonly string[]> = {
  name: ["name", "product name", "product", "item", "item name", "اسم المنتج", "اسم الصنف", "الصنف"],
  barcode: ["barcode", "bar code", "sku", "qr", "qr code", "باركود", "الباركود", "رمز المنتج"],
  costPrice: ["cost price", "cost", "purchase price", "سعر التكلفة", "تكلفة", "سعر الشراء"],
  salePrice: ["sale price", "selling price", "price", "retail price", "سعر البيع", "السعر"],
  stockQuantity: ["stock", "stock quantity", "quantity", "opening stock", "qty", "المخزون", "الكمية", "الرصيد"],
  minStockLevel: ["min stock", "minimum stock", "min stock level", "reorder level", "الحد الأدنى", "الحد الادنى", "حد إعادة الطلب"],
};

/**
 * Imports ordinary product sheets entirely in the Electron main process.
 * It intentionally accepts only .xlsx and .csv: legacy .xls requires an
 * external parser and should be converted to .xlsx first.
 */
export class ProductSpreadsheetImportService {
  public constructor(private readonly database: SqlitePosRepository) {}

  public preview(storeId: string, filePath: string): ProductImportPreview {
    const rawRows = readSpreadsheet(filePath);
    if (rawRows.length < 2) throw new Error("The spreadsheet must contain a header row and at least one product row.");

    const headers = rawRows[0] ?? [];
    const columns = resolveColumns(headers);
    if (columns.name === undefined || columns.salePrice === undefined) {
      throw new Error("Required columns: Product Name and Sale Price. Use the provided English or Arabic column names.");
    }

    const seenBarcodes = new Map<string, number>();
    const rows: ProductImportPreviewRow[] = [];
    for (let index = 1; index < rawRows.length; index += 1) {
      const source = rawRows[index] ?? [];
      if (source.every((cell) => !cell.trim())) continue;
      const row = toPreviewRow(index + 1, source, columns, storeId, this.database);
      if (row.barcode) {
        const prior = seenBarcodes.get(row.barcode);
        if (prior) row.errors.push(`Barcode is duplicated in this file (also row ${prior}).`);
        else seenBarcodes.set(row.barcode, row.rowNumber);
      }
      rows.push(row);
    }
    if (!rows.length) throw new Error("No product rows were found in the spreadsheet.");
    return { fileName: filePath.split(/[\\/]/).pop() ?? "products", rows, validRows: rows.filter((row) => !row.errors.length).length, invalidRows: rows.filter((row) => row.errors.length).length };
  }

  /** Re-reads the file and rejects the full import when even one row is invalid. */
  public import(storeId: string, filePath: string): ProductImportResult {
    const preview = this.preview(storeId, filePath);
    if (preview.invalidRows) throw new Error("Correct all invalid spreadsheet rows before importing. No products were changed.");

    let created = 0;
    let updated = 0;
    this.database.transaction(() => {
      for (const row of preview.rows) {
        const existing = row.barcode ? this.database.findProductByBarcode(storeId, row.barcode) : null;
        const now = new Date().toISOString();
        if (existing) {
          this.database.saveProduct({
            ...existing, name: row.name, costPrice: row.costPrice, salePrice: row.salePrice,
            stockQuantity: row.stockQuantity, minStockLevel: row.minStockLevel, updatedAt: now, syncStatus: "pending_update",
          });
          updated += 1;
        } else {
          const product: Product = {
            id: randomUUID(), storeId, name: row.name, barcode: row.barcode, imageUrl: null, costPrice: row.costPrice,
            salePrice: row.salePrice, stockQuantity: row.stockQuantity, minStockLevel: row.minStockLevel,
            createdAt: now, updatedAt: now, syncStatus: "pending_insert",
          };
          this.database.saveProduct(product);
          created += 1;
        }
      }
    });
    return { created, updated };
  }
}

function toPreviewRow(rowNumber: number, source: SheetRow, columns: Partial<Record<Field, number>>, storeId: string, database: SqlitePosRepository): ProductImportPreviewRow {
  const cell = (field: Field) => columns[field] === undefined ? "" : (source[columns[field]] ?? "").trim();
  const name = cell("name");
  const barcode = cell("barcode") || null;
  const errors: string[] = [];
  if (!name) errors.push("Product name is required.");
  const costPrice = parseNonNegative(cell("costPrice"), "Cost price", errors, 0);
  const salePrice = parseNonNegative(cell("salePrice"), "Sale price", errors);
  const stockQuantity = parseNonNegative(cell("stockQuantity"), "Stock quantity", errors, 0);
  const minStockLevel = parseNonNegative(cell("minStockLevel"), "Minimum stock", errors, 0);
  const action = barcode && database.findProductByBarcode(storeId, barcode) ? "update" : "create";
  return { rowNumber, name, barcode, costPrice, salePrice, stockQuantity, minStockLevel, action, errors };
}

function parseNonNegative(value: string, label: string, errors: string[], fallback?: number): number {
  if (!value) {
    if (fallback !== undefined) return fallback;
    errors.push(`${label} is required.`);
    return 0;
  }
  const normalised = value.replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit))).replace(/,/g, "").trim();
  const number = Number(normalised);
  if (!Number.isFinite(number) || number < 0) {
    errors.push(`${label} must be a non-negative number.`);
    return 0;
  }
  return number;
}

function resolveColumns(headers: SheetRow): Partial<Record<Field, number>> {
  const result: Partial<Record<Field, number>> = {};
  headers.forEach((header, index) => {
    const normalised = normaliseHeader(header);
    (Object.keys(HEADER_ALIASES) as Field[]).forEach((field) => {
      if (result[field] === undefined && HEADER_ALIASES[field].some((alias) => normaliseHeader(alias) === normalised)) result[field] = index;
    });
  });
  return result;
}

function normaliseHeader(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[\s_\-]+/g, " ").replace(/[أإآ]/g, "ا").replace(/ة/g, "ه");
}

function readSpreadsheet(filePath: string): SheetRow[] {
  const extension = extname(filePath).toLowerCase();
  const stats = statSync(filePath);
  if (stats.size > MAX_IMPORT_BYTES) throw new Error("Spreadsheet is larger than 20 MB.");
  if (extension === ".csv") return parseCsv(readFileSync(filePath, "utf8"));
  if (extension === ".xlsx") return parseXlsx(readFileSync(filePath));
  throw new Error("Only .xlsx and .csv product files are supported. Convert legacy .xls files to .xlsx first.");
}

function parseCsv(value: string): SheetRow[] {
  const rows: SheetRow[] = [];
  let row: string[] = [], field = "", quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] ?? "";
    if (char === '"') {
      if (quoted && value[index + 1] === '"') { field += '"'; index += 1; } else quoted = !quoted;
    } else if (char === "," && !quoted) { row.push(field); field = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && value[index + 1] === "\n") index += 1;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** Small, bounded .xlsx reader for plain product worksheets; no native add-on required. */
function parseXlsx(buffer: Buffer): SheetRow[] {
  const entries = readZipEntries(buffer);
  const xml = (name: string) => entries.get(name)?.toString("utf8") ?? "";
  const sharedStrings = readXmlElements(xml("xl/sharedStrings.xml"), "si").map((item) => decodeXml(readXmlElements(item, "t").join("")));
  const workbook = xml("xl/workbook.xml");
  const relationshipId = /<sheet\b[^>]*\br:id="([^"]+)"[^>]*>/i.exec(workbook)?.[1];
  const relationships = xml("xl/_rels/workbook.xml.rels");
  const target = relationshipId ? new RegExp(`<Relationship\\b[^>]*\\bId="${escapeRegExp(relationshipId)}"[^>]*\\bTarget="([^"]+)"`, "i").exec(relationships)?.[1] : undefined;
  const sheetPath = target ? `xl/${target.replace(/^\/+/, "").replace(/^xl\//, "")}` : "xl/worksheets/sheet1.xml";
  const sheet = xml(sheetPath);
  if (!sheet) throw new Error("The .xlsx file does not contain a readable worksheet.");

  const rows: SheetRow[] = [];
  for (const rowXml of readXmlElements(sheet, "row")) {
    const row: string[] = [];
    for (const cellXml of readXmlElements(rowXml, "c")) {
      const reference = /\br="([A-Z]+)\d+"/i.exec(cellXml)?.[1] ?? "A";
      const index = columnIndex(reference);
      while (row.length <= index) row.push("");
      const type = /\bt="([^"]+)"/i.exec(cellXml)?.[1];
      const raw = readXmlElements(cellXml, "v")[0] ?? readXmlElements(cellXml, "t").join("");
      row[index] = type === "s" ? (sharedStrings[Number(raw)] ?? "") : decodeXml(raw);
    }
    rows.push(row);
  }
  return rows;
}

function readZipEntries(buffer: Buffer): Map<string, Buffer> {
  const end = findSignature(buffer, 0x06054b50, Math.max(0, buffer.length - 65_557));
  if (end < 0) throw new Error("Invalid .xlsx archive.");
  const total = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const entries = new Map<string, Buffer>();
  for (let count = 0; count < total; count += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("Invalid .xlsx directory.");
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (uncompressedSize > MAX_ZIP_ENTRY_BYTES || compressedSize > MAX_ZIP_ENTRY_BYTES) throw new Error("Spreadsheet contains an oversized worksheet.");
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("Invalid .xlsx file entry.");
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const data = buffer.subarray(localOffset + 30 + localNameLength + localExtraLength, localOffset + 30 + localNameLength + localExtraLength + compressedSize);
    entries.set(name, method === 0 ? data : method === 8 ? inflateRawSync(data) : (() => { throw new Error("Unsupported .xlsx compression."); })());
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function findSignature(buffer: Buffer, signature: number, start: number): number {
  for (let index = buffer.length - 4; index >= start; index -= 1) if (buffer.readUInt32LE(index) === signature) return index;
  return -1;
}
function readXmlElements(xml: string, tag: string): string[] { return [...xml.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>|<${tag}\\b[^>]*/>`, "gi"))].map((match) => match[1] ?? ""); }
function decodeXml(value: string): string { return value.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"); }
function columnIndex(reference: string): number { return reference.toUpperCase().split("").reduce((total, char) => total * 26 + char.charCodeAt(0) - 64, 0) - 1; }
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
