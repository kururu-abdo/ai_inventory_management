/**
 * Compile-time fallback for constrained build environments where npm packages
 * are not yet installed. Production installs use @supabase/supabase-js from
 * package.json; this declaration deliberately exposes only the API used here.
 */
declare module "@supabase/supabase-js" {
  export type SupabaseClient = any;
  export function createClient(url: string, key: string, options?: unknown): SupabaseClient;
}
