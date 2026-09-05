export type SyncStatus = "synced" | "pending_insert" | "pending_update";
export type PaymentMethod = "cash" | "card" | "bank_transfer" | "credit";

export interface AuditedRecord {
  id: string; // UUIDv4 generated on the client
  storeId: string;
  createdAt: string;
  updatedAt: string;
  syncStatus: SyncStatus;
}

export interface Product extends AuditedRecord {
  barcode: string | null;
  /** Reserved for a future Supabase Storage product image; currently nullable. */
  imageUrl: string | null;
  name: string;
  costPrice: number;
  salePrice: number;
  stockQuantity: number;
  minStockLevel: number;
}

export interface SalesInvoice extends AuditedRecord {
  invoiceNumber: string;
  totalAmount: number;
  discount: number;
  finalAmount: number;
  paymentMethod: PaymentMethod;
}

export interface InvoiceItem extends AuditedRecord {
  invoiceId: string;
  productId: string;
  quantity: number;
  unitPrice: number;
  subTotal: number;
}

export interface PendingProductReview {
  id: string;
  storeId: string;
  productName: string;
  barcode: string | null;
  quantity: number;
  costPrice: number;
  sourceInvoiceId: string | null;
  createdAt: string;
}

export interface SyncState {
  entity: "products" | "sales_invoices" | "invoice_items";
  lastPulledAt: string | null;
}
