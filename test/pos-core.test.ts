import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DeveloperLicenseGenerator,
  InventoryReconciliationService,
  LocalLicenseVerifier,
  ProductSpreadsheetImportService,
  SqliteAppSettingsRepository,
  SqlitePosRepository,
  type Product,
} from "../src/index.js";

function makeDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "offline-pos-test-"));
  const database = new SqlitePosRepository(join(directory, "pos.sqlite"));
  database.migrate();
  return database;
}

test("a license works only on the licensed device and expires locally", async () => {
  const database = makeDatabase();
  const settings = new SqliteAppSettingsRepository(database.db);
  settings.migrate();
  const generator = new DeveloperLicenseGenerator();
  const token = generator.generate({ storeId: "store-1", deviceId: "device-a", expiresAt: "2030-01-01T00:00:00.000Z" });
  const verifier = new LocalLicenseVerifier({ getMachineId: () => "device-a" }, settings);
  const installed = await verifier.install(token);
  assert.equal(installed.valid, true);
  const wrongDevice = new LocalLicenseVerifier({ getMachineId: () => "device-b" }, settings);
  assert.equal((await wrongDevice.verify()).reason, "tampered");
  assert.equal((await verifier.verify(new Date("2031-01-01T00:00:00.000Z"))).reason, "expired");
});

test("barcode matches update stock locally and unknown AI products require review", () => {
  const database = makeDatabase();
  const now = new Date().toISOString();
  database.db.prepare("INSERT INTO stores (id,name,hardware_id_hash,created_at,updated_at,sync_status) VALUES (?,?,?,?,?,?)")
    .run("store-1", "Store", "hash", now, now, "synced");
  const existing: Product = {
    id: "product-1", storeId: "store-1", barcode: "123", imageUrl: null, name: "Rice", costPrice: 4,
    salePrice: 6, stockQuantity: 10, minStockLevel: 2, createdAt: now, updatedAt: now, syncStatus: "synced",
  };
  database.saveProduct(existing);
  const result = new InventoryReconciliationService(database).reconcile("store-1", {
    products: [
      { product_name: "Rice", barcode: "123", quantity: 5, cost_price: 4.5 },
      { product_name: "New Tea", barcode: "999", quantity: 2, cost_price: 3 },
    ],
  });
  assert.deepEqual(result.updatedProductIds, ["product-1"]);
  assert.equal(result.pendingReviewIds.length, 1);
  const product = database.findProductByBarcode("store-1", "123")!;
  assert.equal(product.stockQuantity, 15);
  assert.equal(product.costPrice, 4.5);
  assert.equal(product.syncStatus, "pending_update");
  const reviewCount = database.db.prepare("SELECT count(*) as count FROM pending_product_reviews").get() as { count: number };
  assert.equal(reviewCount.count, 1);
});

test("spreadsheet import previews errors and atomically updates matching barcodes", () => {
  const database = makeDatabase();
  const directory = mkdtempSync(join(tmpdir(), "offline-pos-import-"));
  const now = new Date().toISOString();
  database.db.prepare("INSERT INTO stores (id,name,hardware_id_hash,created_at,updated_at,sync_status) VALUES (?,?,?,?,?,?)")
    .run("store-import", "Store", "hash-import", now, now, "synced");
  database.saveProduct({ id: "existing-product", storeId: "store-import", barcode: "111", imageUrl: null, name: "Old", costPrice: 1, salePrice: 2, stockQuantity: 1, minStockLevel: 0, createdAt: now, updatedAt: now, syncStatus: "synced" });
  const spreadsheet = join(directory, "products.csv");
  writeFileSync(spreadsheet, "Product Name,Barcode,Cost Price,Sale Price,Stock Quantity,Minimum Stock\nRice,111,3,5,12,2\nTea,222,2,4,8,1\n");
  const importer = new ProductSpreadsheetImportService(database);
  const preview = importer.preview("store-import", spreadsheet);
  assert.equal(preview.invalidRows, 0);
  assert.equal(preview.rows[0]?.action, "update");
  assert.equal(preview.rows[1]?.action, "create");
  assert.deepEqual(importer.import("store-import", spreadsheet), { created: 1, updated: 1 });
  assert.equal(database.findProductByBarcode("store-import", "111")?.stockQuantity, 12);
  assert.equal(database.findProductByBarcode("store-import", "111")?.syncStatus, "pending_update");
  assert.equal(database.findProductByBarcode("store-import", "222")?.name, "Tea");
});

test("merchant approval turns an AI suggestion into a syncable product", () => {
  const database = makeDatabase();
  const now = new Date().toISOString();
  database.db.prepare("INSERT INTO stores (id,name,hardware_id_hash,created_at,updated_at,sync_status) VALUES (?,?,?,?,?,?)")
    .run("store-review", "Store", "hash-review", now, now, "synced");
  const review = database.savePendingReview({ storeId: "store-review", productName: "New Tea", barcode: "555", quantity: 4, costPrice: 3, sourceInvoiceId: null });
  const product = new InventoryReconciliationService(database).acceptPendingReview({ storeId: "store-review", reviewId: review.id, salePrice: 5, minStockLevel: 1 });
  assert.equal(product.name, "New Tea");
  assert.equal(product.stockQuantity, 4);
  assert.equal(product.syncStatus, "pending_insert");
  assert.equal(database.listPendingReviews("store-review").length, 0);
});
