import type { LicenseSettingsRepository } from "../security/app-settings.js";

export interface RemoteLicenseRefreshInput {
  supabaseUrl: string;
  publishableKey: string;
  accessToken: string;
  storeId: string;
}

/** Pulls revocation status only when online; failures deliberately preserve offline access. */
export async function refreshRemoteLicenseStatus(
  settings: LicenseSettingsRepository,
  input: RemoteLicenseRefreshInput,
  fetchImpl: typeof fetch = fetch,
): Promise<{ revoked: boolean }> {
  const url = new URL("/rest/v1/stores", input.supabaseUrl);
  url.searchParams.set("id", `eq.${input.storeId}`);
  url.searchParams.set("select", "license_status,license_expiry_date");
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { apikey: input.publishableKey, Authorization: `Bearer ${input.accessToken}` },
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    return { revoked: false };
  }
  if (!response.ok) return { revoked: false };
  const rows = await response.json() as Array<{ license_status: "active" | "expired"; license_expiry_date: string | null }>;
  const remote = rows[0];
  if (!remote || remote.license_status !== "expired") return { revoked: false };
  const current = await settings.getLicense();
  await settings.saveLicense({ licenseKey: current.licenseKey, licenseExpiryDate: remote.license_expiry_date, licenseStatus: "expired" });
  return { revoked: true };
}
