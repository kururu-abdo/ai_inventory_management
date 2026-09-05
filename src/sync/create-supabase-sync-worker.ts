import { createClient } from "@supabase/supabase-js";
import type { SqlitePosRepository } from "../database/sqlite-pos.repository.js";
import { HttpNetworkStatus, SupabaseSyncWorker } from "./supabase-sync.worker.js";

/** Uses the Supabase publishable/anon key only; access is constrained by RLS. */
export function createSupabaseSyncWorker(input: {
  supabaseUrl: string;
  supabasePublishableKey: string;
  storeId: string;
  database: SqlitePosRepository;
  accessToken?: string;
}): SupabaseSyncWorker {
  if (!input.supabaseUrl.startsWith("https://")) throw new Error("SUPABASE_URL must use HTTPS");
  const client = createClient(input.supabaseUrl, input.supabasePublishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: input.accessToken ? { headers: { Authorization: `Bearer ${input.accessToken}` } } : undefined,
  });
  return new SupabaseSyncWorker(
    input.database,
    client,
    new HttpNetworkStatus(`${input.supabaseUrl}/auth/v1/health`),
    input.storeId,
  );
}
