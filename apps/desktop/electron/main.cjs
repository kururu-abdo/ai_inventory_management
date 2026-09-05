const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");

loadLocalEnvironment(path.join(__dirname, "../.env.local"));

let window;
let repository;
let licenseVerifier;
let hardwareIdProvider;
let syncWorker;
let licenseRefreshTimer;
let sessionRefreshTimer;
let core;
let settings;
let cryptoService;
let clientSetupRepository;
let clientSetup;
let storeId = process.env.POS_STORE_ID || "";
let accessToken = process.env.SUPABASE_ACCESS_TOKEN || "";
let refreshToken = "";
let authClient;

async function createWindow() {
  // Core code is bundled/compiled separately and executes only in Electron main.
  core = await import(pathToFileURL(path.join(__dirname, "../../../dist/index.js")).href);
  repository = new core.SqlitePosRepository(path.join(app.getPath("userData"), "pos.sqlite"));
  repository.migrate();
  hardwareIdProvider = new core.NodeMachineIdProvider();
  settings = new core.SqliteAppSettingsRepository(repository.db);
  settings.migrate();
  clientSetupRepository = new core.SqliteClientSetupRepository(repository.db);
  clientSetupRepository.migrate();
  clientSetup = clientSetupRepository.get();
  if (!clientSetup && storeId && process.env.SUPABASE_URL && process.env.SUPABASE_PUBLISHABLE_KEY) {
    clientSetup = { version: 1, storeId, storeName: process.env.POS_STORE_NAME || "Local Store", supabaseUrl: process.env.SUPABASE_URL, supabasePublishableKey: process.env.SUPABASE_PUBLISHABLE_KEY };
    clientSetupRepository.save(clientSetup);
  }
  if (clientSetup) storeId = clientSetup.storeId;
  ensureLocalStore();
  licenseVerifier = new core.LocalLicenseVerifier(hardwareIdProvider, settings);
  cryptoService = new core.HardwareBoundCryptoService(settings, hardwareIdProvider);
  startSyncIfConfigured();

  window = new BrowserWindow({
    width: 1360, height: 860, minWidth: 1024, minHeight: 700,
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) await window.loadURL(devUrl);
  else await window.loadFile(path.join(__dirname, "../renderer-dist/index.html"));
}

app.whenReady().then(async () => {
  ipcMain.handle("pos:license", async () => licenseVerifier.verify());
  ipcMain.handle("pos:device-id", async () => hardwareIdProvider.getMachineId());
  ipcMain.handle("pos:install-license", async (_event, token) => {
    if (typeof token !== "string" || token.length > 10_000) throw new Error("Invalid license token");
    return licenseVerifier.install(token);
  });
  ipcMain.handle("pos:install-client-setup", async () => {
    const selected = await dialog.showOpenDialog(window, { properties: ["openFile"], filters: [{ name: "POS setup", extensions: ["json"] }] });
    if (selected.canceled || !selected.filePaths[0]) return { installed: false };
    const input = JSON.parse(fs.readFileSync(selected.filePaths[0], "utf8"));
    const setup = core.validateClientSetup(input);
    const hardwareIdHash = core.hashHardwareId(hardwareIdProvider.getMachineId());
    const boundStore = repository.db.prepare("SELECT id FROM stores WHERE hardware_id_hash = ?").get(hardwareIdHash);
    if (boundStore && String(boundStore.id) !== setup.storeId) throw new Error("الجهاز ده مربوط بمتجر تاني. ما ممكن نركب إعداد تاجر جديد فوق بياناته.");
    const verification = await licenseVerifier.install(setup.licenseKey);
    if (!verification.valid) throw new Error("ملف الإعداد ما مربوط بالجهاز ده أو انتهت الرخصة");
    clientSetupRepository.save({ version: 1, storeId: setup.storeId, storeName: setup.storeName, merchantEmail: setup.merchantEmail, supabaseUrl: setup.supabaseUrl, supabasePublishableKey: setup.supabasePublishableKey });
    clientSetup = clientSetupRepository.get();
    storeId = setup.storeId;
    ensureLocalStore();
    restartSync();
    return { installed: true, license: verification, merchantEmail: setup.merchantEmail ?? null };
  });
  ipcMain.handle("pos:merchant-sign-in", async (_event, input) => {
    const email = typeof input?.email === "string" ? input.email.trim() : "";
    const password = typeof input?.password === "string" ? input.password : "";
    if (!email || !password) throw new Error("أدخل الإيميل وكلمة السر");
    const connection = publicConnection();
    if (!connection) throw new Error("ثبّت ملف إعداد المتجر أول");
    const { createClient } = await import("@supabase/supabase-js");
    authClient = createClient(connection.supabaseUrl, connection.supabasePublishableKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
    const { data, error } = await authClient.auth.signInWithPassword({ email, password });
    if (error || !data.session) throw new Error(error?.message || "تعذر تسجيل الدخول");
    accessToken = data.session.access_token;
    refreshToken = data.session.refresh_token;
    restartSync();
    return { signedIn: true, email: data.user?.email ?? email };
  });
  ipcMain.handle("pos:merchant-sign-out", async () => {
    // Credentials are never persisted. Clearing these values stops every
    // authenticated cloud request immediately; local offline data remains.
    await authClient?.auth.signOut();
    accessToken = "";
    refreshToken = "";
    authClient = undefined;
    restartSync();
    return { signedOut: true };
  });
  ipcMain.handle("pos:products", async () => storeId ? repository.listProducts(storeId) : []);
  ipcMain.handle("pos:add-product", async (_event, input) => {
    if (!storeId) throw new Error("POS_STORE_ID is not configured");
    const name = typeof input?.name === "string" ? input.name.trim() : "";
    const barcode = typeof input?.barcode === "string" ? input.barcode.trim() : "";
    const costPrice = Number(input?.costPrice);
    const salePrice = Number(input?.salePrice);
    const stockQuantity = Number(input?.stockQuantity);
    const minStockLevel = Number(input?.minStockLevel ?? 0);
    if (!name || [costPrice, salePrice, stockQuantity, minStockLevel].some((value) => !Number.isFinite(value) || value < 0)) throw new Error("Invalid product details");
    const product = new core.InventoryReconciliationService(repository).createReviewedProduct({
      storeId, name, barcode: barcode || null, imageUrl: null, costPrice, salePrice, stockQuantity, minStockLevel,
    });
    return product;
  });
  ipcMain.handle("pos:select-product-import-file", async () => {
    const result = await dialog.showOpenDialog(window, {
      properties: ["openFile"],
      filters: [{ name: "Product spreadsheets", extensions: ["xlsx", "csv"] }],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle("pos:preview-product-import", async (_event, filePath) => {
    if (!storeId || typeof filePath !== "string" || !filePath) throw new Error("Choose a product spreadsheet first");
    return new core.ProductSpreadsheetImportService(repository).preview(storeId, filePath);
  });
  ipcMain.handle("pos:import-products", async (_event, filePath) => {
    if (!storeId || typeof filePath !== "string" || !filePath) throw new Error("Choose a product spreadsheet first");
    return new core.ProductSpreadsheetImportService(repository).import(storeId, filePath);
  });
  ipcMain.handle("pos:create-sale", async (_event, input) => {
    if (!storeId) throw new Error("POS_STORE_ID is not configured");
    const paymentMethod = ["cash", "card", "bank_transfer", "credit"].includes(input?.paymentMethod) ? input.paymentMethod : "cash";
    const lines = Array.isArray(input?.lines) ? input.lines.map((line) => ({ productId: String(line?.productId ?? ""), quantity: Number(line?.quantity), unitPrice: line?.unitPrice === undefined ? undefined : Number(line.unitPrice) })) : [];
    return new core.PosSalesService(repository).createSale({
      storeId, invoiceNumber: `POS-${Date.now()}`, paymentMethod, discount: Number(input?.discount ?? 0), lines,
    });
  });
  ipcMain.handle("pos:select-invoice-image", async () => {
    const result = await dialog.showOpenDialog(window, { properties: ["openFile"], filters: [{ name: "Invoice images", extensions: ["jpg", "jpeg", "png", "webp"] }] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle("pos:parse-supplier-invoice", async (_event, filePath) => {
    if (!storeId || typeof filePath !== "string") throw new Error("Choose an invoice image first");
    const parsed = await new core.AiInventoryParserService(cryptoService).parseSupplierInvoice(filePath);
    const reconciliation = new core.InventoryReconciliationService(repository).reconcile(storeId, parsed);
    return { parsedProducts: parsed.products.length, ...reconciliation };
  });
  ipcMain.handle("pos:pending-product-reviews", async () => storeId ? repository.listPendingReviews(storeId) : []);
  ipcMain.handle("pos:approve-product-review", async (_event, input) => {
    if (!storeId || typeof input?.reviewId !== "string") throw new Error("مراجعة الصنف غير صحيحة");
    return new core.InventoryReconciliationService(repository).acceptPendingReview({
      storeId, reviewId: input.reviewId, salePrice: Number(input.salePrice), minStockLevel: Number(input.minStockLevel ?? 0),
    });
  });
  ipcMain.handle("pos:reject-product-review", async (_event, reviewId) => {
    if (!storeId || typeof reviewId !== "string") throw new Error("مراجعة الصنف غير صحيحة");
    new core.InventoryReconciliationService(repository).rejectPendingReview(storeId, reviewId);
    return { rejected: true };
  });
  ipcMain.handle("pos:save-openai-key", async (_event, apiKey) => {
    if (typeof apiKey !== "string") throw new Error("Invalid API key");
    await cryptoService.saveMerchantOpenAiApiKey(apiKey);
    return { saved: true };
  });
  ipcMain.handle("pos:sync-now", async () => {
    await refreshMerchantSession();
    if (!syncWorker) restartSync();
    if (!syncWorker) return { skippedOffline: true, pulled: 0, pushed: 0, errors: [`Supabase sync is not configured. Missing: ${missingSyncConfiguration().join(", ")}`] };
    return syncWorker.syncNow();
  });
  ipcMain.handle("pos:app-state", async () => ({
    storeId: storeId || null,
    setupInstalled: Boolean(clientSetup),
    merchantEmail: clientSetup?.merchantEmail ?? null,
    authenticated: Boolean(accessToken),
    syncConfigured: Boolean(syncWorker),
    license: await licenseVerifier.verify(),
  }));
  ipcMain.handle("pos:health", async () => ({ storeConfigured: Boolean(storeId), database: "ready" }));
  await createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
}).catch((error) => {
  console.error("Electron startup failed:", error);
  dialog.showErrorBox("Unable to start Offline POS", error instanceof Error ? error.message : String(error));
  app.quit();
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => { syncWorker?.stop(); if (licenseRefreshTimer) clearInterval(licenseRefreshTimer); if (sessionRefreshTimer) clearInterval(sessionRefreshTimer); });

function ensureLocalStore() {
  if (!storeId) return;
  const hardwareIdHash = core.hashHardwareId(hardwareIdProvider.getMachineId());
  const existing = repository.db.prepare("SELECT id FROM stores WHERE id = ?").get(storeId);
  if (existing) return;
  const deviceStore = repository.db.prepare("SELECT id FROM stores WHERE hardware_id_hash = ?").get(hardwareIdHash);
  if (deviceStore) {
    // A device can have only one local POS identity. Reusing its existing store
    // preserves foreign-keyed sales/products and avoids unsafe data migration.
    storeId = String(deviceStore.id);
    console.warn(`POS_STORE_ID differs from the local device binding; using existing store ${storeId}.`);
    return;
  }
  const now = new Date().toISOString();
  repository.db.prepare("INSERT INTO stores (id,name,hardware_id_hash,created_at,updated_at,sync_status) VALUES (?,?,?,?,?,?)")
    .run(storeId, clientSetup?.storeName || process.env.POS_STORE_NAME || "Local Store", hardwareIdHash, now, now, "pending_insert");
}

function startSyncIfConfigured() {
  const connection = syncConnection();
  if (!connection) return;
  syncWorker = core.createSupabaseSyncWorker({ database: repository, storeId, ...connection });
  syncWorker.start();
  void refreshLicenseFromCloud();
  licenseRefreshTimer = setInterval(() => void refreshLicenseFromCloud(), 30_000);
  if (authClient && refreshToken) sessionRefreshTimer = setInterval(() => void refreshSessionInBackground(), 30 * 60_000);
}
function restartSync() {
  syncWorker?.stop(); syncWorker = undefined;
  if (licenseRefreshTimer) clearInterval(licenseRefreshTimer);
  if (sessionRefreshTimer) clearInterval(sessionRefreshTimer);
  licenseRefreshTimer = undefined;
  sessionRefreshTimer = undefined;
  startSyncIfConfigured();
}
function syncConnection() {
  const publicConfig = publicConnection();
  return storeId && publicConfig && accessToken ? { ...publicConfig, accessToken } : null;
}
function publicConnection() {
  const supabaseUrl = clientSetup?.supabaseUrl || process.env.SUPABASE_URL;
  const supabasePublishableKey = clientSetup?.supabasePublishableKey || process.env.SUPABASE_PUBLISHABLE_KEY;
  return supabaseUrl && supabasePublishableKey ? { supabaseUrl, supabasePublishableKey } : null;
}
async function refreshMerchantSession() {
  if (!authClient || !refreshToken) return;
  const { data, error } = await authClient.auth.refreshSession({ refresh_token: refreshToken });
  if (error || !data.session) { accessToken = ""; refreshToken = ""; restartSync(); throw new Error("انتهت جلسة الدخول. سجّل دخول التاجر من الإعدادات."); }
  accessToken = data.session.access_token;
  refreshToken = data.session.refresh_token;
}
async function refreshSessionInBackground() {
  try {
    await refreshMerchantSession();
    // The worker has a static Authorization header, so replace it after refresh.
    restartSync();
  } catch {
    // Only an expiry signal crosses IPC; no credential is exposed to the UI.
    window?.webContents.send("pos:auth-expired");
  }
}

async function refreshLicenseFromCloud() {
  const connection = syncConnection();
  if (!connection) return;
  const result = await core.refreshRemoteLicenseStatus(settings, {
    storeId, supabaseUrl: connection.supabaseUrl,
    publishableKey: connection.supabasePublishableKey, accessToken: connection.accessToken,
  });
  if (result.revoked && window && !window.isDestroyed()) window.reload();
}

function missingSyncConfiguration() {
  const missing = [];
  if (!(clientSetup?.supabaseUrl || process.env.SUPABASE_URL)) missing.push("SUPABASE_URL");
  if (!(clientSetup?.supabasePublishableKey || process.env.SUPABASE_PUBLISHABLE_KEY)) missing.push("SUPABASE_PUBLISHABLE_KEY");
  if (!accessToken) missing.push("تسجيل دخول التاجر");
  return missing;
}

/** Minimal local .env reader: environment variables passed by the OS always win. */
function loadLocalEnvironment(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (!/^[A-Z0-9_]+$/.test(key) || process.env[key]) continue;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[key] = value;
  }
}
