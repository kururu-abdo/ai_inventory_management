// Supabase Edge Function: deploy server-side only. Requires an authenticated
// JWT whose app_metadata.role is `developer`; never call this from anonymous UI.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type Input = {
  action?: "issue" | "cancel" | "provision";
  storeId?: string;
  deviceId?: string;
  expiresAt?: string;
  storeName?: string;
  merchantEmail?: string;
  merchantPassword?: string;
};

Deno.serve(async (request) => {
  const authorization = request.headers.get("Authorization");
  if (!authorization) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authorization } },
  });
  const { data: { user } } = await supabase.auth.getUser();
  if (user?.app_metadata?.role !== "developer") return Response.json({ error: "Forbidden" }, { status: 403 });
  const input = await request.json() as Input;
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  if (input.action === "provision") {
    if (!input.deviceId || !input.expiresAt || !input.storeName?.trim() || !input.merchantEmail?.trim() || !input.merchantPassword || input.storeName.trim().length > 120 || input.merchantPassword.length < 12 || Number.isNaN(Date.parse(input.expiresAt))) {
      return Response.json({ error: "Invalid merchant provisioning request" }, { status: 400 });
    }
    const { data: createdUser, error: userError } = await admin.auth.admin.createUser({
      email: input.merchantEmail.trim().toLowerCase(), password: input.merchantPassword, email_confirm: true,
    });
    if (userError || !createdUser.user) return Response.json({ error: userError?.message ?? "Could not create merchant user" }, { status: 409 });
    const storeId = crypto.randomUUID();
    const expiry = new Date(input.expiresAt).toISOString();
    const encoder = new TextEncoder();
    const digest = async (label: string, value: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(`${label}\0${value.trim()}`)));
    const hardwareHash = Array.from(await digest("offline-pos/license-device/v1", input.deviceId)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const key = await crypto.subtle.importKey("raw", await digest("offline-pos/license-key/v1", input.deviceId), "AES-GCM", false, ["encrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const claims = { version: 1, storeId, hardwareIdHash: hardwareHash, expiresAt: expiry, issuedAt: new Date().toISOString(), nonce: crypto.randomUUID() };
    const cipherText = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(JSON.stringify(claims))));
    const tag = cipherText.slice(-16); const encrypted = cipherText.slice(0, -16);
    const base64Url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    const licenseKey = `1.${base64Url(iv)}.${base64Url(tag)}.${base64Url(encrypted)}`;
    const now = new Date().toISOString();
    const { error: storeError } = await admin.from("stores").insert({ id: storeId, owner_id: createdUser.user.id, name: input.storeName.trim(), hardware_id_hash: hardwareHash, license_status: "active", license_expiry_date: expiry, created_at: now, updated_at: now });
    if (storeError) {
      await admin.auth.admin.deleteUser(createdUser.user.id);
      return Response.json({ error: storeError.message }, { status: 409 });
    }
    // No password, access token, refresh token, or service-role key is exported.
    return Response.json({
      store: { id: storeId, name: input.storeName.trim(), ownerId: createdUser.user.id },
      clientSetup: { version: 1, storeId, storeName: input.storeName.trim(), merchantEmail: input.merchantEmail.trim().toLowerCase(), supabaseUrl: Deno.env.get("SUPABASE_URL")!, supabasePublishableKey: Deno.env.get("SUPABASE_ANON_KEY")!, licenseKey },
    });
  }
  if (!input.storeId) return Response.json({ error: "Invalid license request" }, { status: 400 });
  if (input.action === "cancel") {
    // This records a revocation immediately. The desktop app applies it at its
    // next authenticated online refresh; an offline device cannot be revoked
    // until it reconnects by design.
    const { error } = await admin.from("stores").update({ license_status: "expired", license_expiry_date: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", input.storeId);
    if (error) return Response.json({ error: error.message }, { status: 500 });
    return Response.json({ cancelled: true });
  }
  if (!input.deviceId || !input.expiresAt || Number.isNaN(Date.parse(input.expiresAt))) {
    return Response.json({ error: "Invalid license request" }, { status: 400 });
  }

  // License encryption is intentionally performed only in this protected Edge
  // Function. It mirrors src/licensing/license-token.service.ts for the client.
  const encoder = new TextEncoder();
  const digest = async (label: string, value: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(`${label}\0${value.trim()}`)));
  const hardwareHash = Array.from(await digest("offline-pos/license-device/v1", input.deviceId)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const key = await crypto.subtle.importKey("raw", await digest("offline-pos/license-key/v1", input.deviceId), "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const claims = { version: 1, storeId: input.storeId, hardwareIdHash: hardwareHash, expiresAt: new Date(input.expiresAt).toISOString(), issuedAt: new Date().toISOString(), nonce: crypto.randomUUID() };
  const cipherText = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(JSON.stringify(claims))));
  const tag = cipherText.slice(-16); const encrypted = cipherText.slice(0, -16);
  const base64Url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  const token = `1.${base64Url(iv)}.${base64Url(tag)}.${base64Url(encrypted)}`;

  const { error } = await admin.from("stores").update({ license_status: "active", license_expiry_date: claims.expiresAt, updated_at: new Date().toISOString() }).eq("id", input.storeId);
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ licenseKey: token, expiresAt: claims.expiresAt });
});
