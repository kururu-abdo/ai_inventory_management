const { contextBridge, ipcRenderer } = require("electron");

// Intentionally narrow IPC surface. Do not expose filesystem, database, or API keys.
contextBridge.exposeInMainWorld("pos", {
  health: () => ipcRenderer.invoke("pos:health"),
  license: () => ipcRenderer.invoke("pos:license"),
  deviceId: () => ipcRenderer.invoke("pos:device-id"),
  installLicense: (token) => ipcRenderer.invoke("pos:install-license", token),
  installClientSetup: () => ipcRenderer.invoke("pos:install-client-setup"),
  merchantSignIn: (input) => ipcRenderer.invoke("pos:merchant-sign-in", input),
  merchantSignOut: () => ipcRenderer.invoke("pos:merchant-sign-out"),
  onAuthExpired: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("pos:auth-expired", listener);
    return () => ipcRenderer.removeListener("pos:auth-expired", listener);
  },
  products: () => ipcRenderer.invoke("pos:products"),
  addProduct: (input) => ipcRenderer.invoke("pos:add-product", input),
  selectProductImportFile: () => ipcRenderer.invoke("pos:select-product-import-file"),
  previewProductImport: (filePath) => ipcRenderer.invoke("pos:preview-product-import", filePath),
  importProducts: (filePath) => ipcRenderer.invoke("pos:import-products", filePath),
  createSale: (input) => ipcRenderer.invoke("pos:create-sale", input),
  selectInvoiceImage: () => ipcRenderer.invoke("pos:select-invoice-image"),
  parseSupplierInvoice: (filePath) => ipcRenderer.invoke("pos:parse-supplier-invoice", filePath),
  pendingProductReviews: () => ipcRenderer.invoke("pos:pending-product-reviews"),
  approveProductReview: (input) => ipcRenderer.invoke("pos:approve-product-review", input),
  rejectProductReview: (reviewId) => ipcRenderer.invoke("pos:reject-product-review", reviewId),
  saveOpenAiKey: (apiKey) => ipcRenderer.invoke("pos:save-openai-key", apiKey),
  syncNow: () => ipcRenderer.invoke("pos:sync-now"),
  appState: () => ipcRenderer.invoke("pos:app-state"),
});
