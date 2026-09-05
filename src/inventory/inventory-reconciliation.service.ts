import { randomUUID } from "node:crypto";
import type { SqlitePosRepository } from "../database/sqlite-pos.repository.js";
import type { Product } from "../database/models.js";
import type { SupplierInvoiceParseResult } from "../invoice/ai-inventory-parser.service.js";

export interface ReconciliationResult {
  updatedProductIds: string[];
  pendingReviewIds: string[];
}

/** Applies only barcode-confirmed AI rows. Unmatched items are review-only. */
export class InventoryReconciliationService {
  public constructor(private readonly database: SqlitePosRepository) {}

  public reconcile(storeId: string, parsed: SupplierInvoiceParseResult, sourceInvoiceId: string | null = null): ReconciliationResult {
    const updatedProductIds: string[] = [];
    const pendingReviewIds: string[] = [];
    this.database.transaction(() => {
      for (const row of parsed.products) {
        const barcode = row.barcode.trim();
        const existing = barcode ? this.database.findProductByBarcode(storeId, barcode) : null;
        if (!existing) {
          const review = this.database.savePendingReview({
            storeId, productName: row.product_name, barcode: barcode || null, quantity: row.quantity,
            costPrice: row.cost_price, sourceInvoiceId,
          });
          pendingReviewIds.push(review.id);
          continue;
        }
        const now = new Date().toISOString();
        const product: Product = {
          ...existing,
          stockQuantity: existing.stockQuantity + row.quantity,
          costPrice: row.cost_price,
          updatedAt: now,
          syncStatus: "pending_update",
        };
        this.database.saveProduct(product);
        updatedProductIds.push(product.id);
      }
    });
    return { updatedProductIds, pendingReviewIds };
  }

  /** Use after a reviewer explicitly accepts a new product suggestion. */
  public createReviewedProduct(input: Omit<Product, "id" | "createdAt" | "updatedAt" | "syncStatus">): Product {
    const now = new Date().toISOString();
    const product: Product = { id: randomUUID(), ...input, createdAt: now, updatedAt: now, syncStatus: "pending_insert" };
    this.database.saveProduct(product);
    return product;
  }

  /** Accepts one AI suggestion only after the merchant sets a selling price. */
  public acceptPendingReview(input: { storeId: string; reviewId: string; salePrice: number; minStockLevel?: number }): Product {
    if (!Number.isFinite(input.salePrice) || input.salePrice < 0 || !Number.isFinite(input.minStockLevel ?? 0) || (input.minStockLevel ?? 0) < 0) throw new Error("Invalid review prices");
    return this.database.transaction(() => {
      const review = this.database.findPendingReview(input.storeId, input.reviewId);
      if (!review) throw new Error("Pending AI product review was not found");
      if (review.barcode && this.database.findProductByBarcode(input.storeId, review.barcode)) throw new Error("A product with this barcode already exists; refresh the inventory first");
      const product = this.createReviewedProduct({
        storeId: input.storeId, name: review.productName, barcode: review.barcode,
        imageUrl: null,
        costPrice: review.costPrice, salePrice: input.salePrice, stockQuantity: review.quantity,
        minStockLevel: input.minStockLevel ?? 0,
      });
      this.database.deletePendingReview(input.storeId, review.id);
      return product;
    });
  }

  public rejectPendingReview(storeId: string, reviewId: string): void {
    if (!this.database.deletePendingReview(storeId, reviewId)) throw new Error("Pending AI product review was not found");
  }
}
