import { randomUUID } from "node:crypto";
import type { SqlitePosRepository } from "../database/sqlite-pos.repository.js";
import type { InvoiceItem, PaymentMethod, Product, SalesInvoice } from "../database/models.js";

export interface SaleLineInput { productId: string; quantity: number; unitPrice?: number; }
export interface CreateSaleInput { storeId: string; invoiceNumber: string; discount?: number; paymentMethod: PaymentMethod; lines: SaleLineInput[]; }

/** Creates a sale entirely in one local SQLite transaction; sync happens later. */
export class PosSalesService {
  public constructor(private readonly database: SqlitePosRepository) {}

  public createSale(input: CreateSaleInput): { invoice: SalesInvoice; items: InvoiceItem[] } {
    if (!input.invoiceNumber.trim() || input.lines.length === 0) throw new Error("Invoice number and at least one line are required");
    return this.database.transaction(() => {
      const now = new Date().toISOString();
      const items: InvoiceItem[] = [];
      let totalAmount = 0;
      for (const line of input.lines) {
        if (!Number.isFinite(line.quantity) || line.quantity <= 0) throw new Error("Sale quantity must be greater than zero");
        const product = this.database.db.prepare("SELECT * FROM products WHERE id = ? AND store_id = ?")
          .get(line.productId, input.storeId) as Record<string, unknown> | undefined;
        if (!product) throw new Error("Product was not found in this store");
        const available = Number(product.stock_quantity);
        if (available < line.quantity) throw new Error(`Insufficient stock for ${String(product.name)}`);
        const unitPrice = line.unitPrice ?? Number(product.sale_price);
        const subTotal = unitPrice * line.quantity;
        totalAmount += subTotal;
        this.database.db.prepare("UPDATE products SET stock_quantity = ?, updated_at = ?, sync_status = 'pending_update' WHERE id = ?")
          .run(available - line.quantity, now, line.productId);
        items.push({
          id: randomUUID(), storeId: input.storeId, invoiceId: "", productId: line.productId,
          quantity: line.quantity, unitPrice, subTotal, createdAt: now, updatedAt: now, syncStatus: "pending_insert",
        });
      }
      const discount = input.discount ?? 0;
      if (!Number.isFinite(discount) || discount < 0 || discount > totalAmount) throw new Error("Discount is invalid");
      const invoice: SalesInvoice = {
        id: randomUUID(), storeId: input.storeId, invoiceNumber: input.invoiceNumber.trim(), totalAmount,
        discount, finalAmount: totalAmount - discount, paymentMethod: input.paymentMethod,
        createdAt: now, updatedAt: now, syncStatus: "pending_insert",
      };
      this.database.db.prepare(`INSERT INTO sales_invoices
        (id,store_id,invoice_number,total_amount,discount,final_amount,payment_method,created_at,updated_at,sync_status)
        VALUES (@id,@storeId,@invoiceNumber,@totalAmount,@discount,@finalAmount,@paymentMethod,@createdAt,@updatedAt,@syncStatus)`).run(invoice);
      const insertItem = this.database.db.prepare(`INSERT INTO invoice_items
        (id,store_id,invoice_id,product_id,quantity,unit_price,sub_total,created_at,updated_at,sync_status)
        VALUES (@id,@storeId,@invoiceId,@productId,@quantity,@unitPrice,@subTotal,@createdAt,@updatedAt,@syncStatus)`);
      for (const item of items) {
        item.invoiceId = invoice.id;
        insertItem.run(item);
      }
      return { invoice, items };
    });
  }
}
