# Offline POS & AI Inventory System

Electron + React/Tailwind desktop POS with SQLite as its offline source of truth, optional Supabase sync, locally encrypted merchant OpenAI keys, and offline-first invoice extraction.

## Start locally

```bash
npm install
npm run build
POS_STORE_ID=<store UUID> npm start
```

For a development renderer, start `npm run dev:renderer` with `VITE_DEV_SERVER_URL` pointed at its URL, then run Electron. The Electron main process is the only process that opens SQLite or decrypts keys; the React renderer sees only three explicit IPC methods.

For Supabase sync during desktop development, copy `apps/desktop/.env.example` to `apps/desktop/.env.local` and fill its three `SUPABASE_*` fields. This file is loaded only by Electron's main process and must never be committed.

## Local database and POS behavior

`src/database/local-schema.ts` defines UUIDv4 SQLite tables for products, invoices, invoice items, stores, review queue, and durable sync state. `SqlitePosRepository` enables WAL mode and `PosSalesService` creates a sale, items, and stock decrement in one transaction. Every local mutation is immediately usable offline and marked pending for later sync.

`app_settings` holds AES-GCM ciphertext in `merchant_openai_key`, plus IV/tag and license fields. The encrypted merchant key is deliberately not synced to Supabase.

## Supabase setup

1. Apply [001_pos_schema.sql](supabase/migrations/001_pos_schema.sql) with the Supabase CLI.
2. Authenticate the store user using Supabase Auth; give it access only to its `stores` row.
3. Start Electron with `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_ACCESS_TOKEN`, and `POS_STORE_ID`.

`SupabaseSyncWorker` pulls first, applies Last Write Wins locally by `updated_at`, then bulk `.upsert(..., { onConflict: 'id' })` pushes products, invoices, and items in foreign-key order. The database trigger independently rejects an older concurrent writer. Rows are marked synced only when Supabase returns the same `updated_at`. The publishable key is safe to distribute only because the supplied RLS policies are enabled; never put `SUPABASE_SERVICE_ROLE_KEY` in Electron.

## Invoice intake

`AiInventoryParserService` optimizes an image locally, decrypts the merchant BYO key only around an OpenAI Responses request, requests strict JSON-schema output, validates it, and clears mutable key buffers. `InventoryReconciliationService` increments stock and updates cost only for known barcodes. Unknown/missing barcodes become local review records and are never silently created.

## Hybrid offline OCR flow

`HybridInvoiceParser` is offline-first: an injected local OCR engine produces text blocks and coordinates, then `RuleBasedInvoiceParser` attempts a conservative vendor template match. A successful low-complexity match ends locally. Otherwise, the required `requestCloudPermission` callback must return `ocr-text` or `optimized-image`; `deny` returns without a cloud call. Text-only is the default low-bandwidth fallback and the image route still uses the local optimizer plus the hardware-decrypted API key.

For Flutter, see [flutter/README.md](flutter/README.md) for the Google ML Kit adapter and its local preprocessing flow. Add verified supplier templates to `DEFAULT_VENDOR_RULE_MATRIX` rather than weakening the sample generic rules.

## Cash subscriptions

`DeveloperLicenseGenerator` creates an AES-256-GCM, hardware-bound token from a registered device ID and expiry. `LocalLicenseVerifier` validates it entirely offline and persists active/expired state. The Electron renderer locks with **“Subscription Expired. Please contact support to renew via Cash.”** when validation fails. Use [admin-license Edge Function](supabase/functions/admin-license/index.ts) from a developer-only dashboard/API; it checks a server-authenticated `app_metadata.role = developer` before issuing a token.

### Developer dashboard

The protected browser dashboard is in `apps/admin`. Apply both Supabase migrations, copy `apps/admin/.env.example` to `apps/admin/.env.local`, add the project URL and publishable key, then run `npm run dev:admin`. A developer can sign in, inspect stores, select a store, paste the Device ID from the desktop client, choose an expiry date, and issue a copyable hardware-bound license. It never receives a Supabase secret key or merchant OpenAI ciphertext.

## Verification

`npm run build` builds the core and Electron renderer. `npm test` verifies image optimization, key encryption, hybrid consent, local reconciliation, and hardware-bound licensing.
# ai_inventory_management
