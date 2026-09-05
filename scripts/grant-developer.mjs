import { createClient } from "@supabase/supabase-js";

const position = process.argv.indexOf("--user");
const userId = position >= 0 ? process.argv[position + 1] : undefined;
const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceRoleKey || !userId) {
  console.error("Usage: SUPABASE_URL=https://... SUPABASE_SERVICE_ROLE_KEY=... npm run grant-developer -- --user <AUTH_USER_UUID>");
  process.exit(1);
}

// This runs only from the developer's trusted terminal; it is never bundled in
// the Electron client or Admin browser dashboard.
const supabase = createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
const { error } = await supabase.auth.admin.updateUserById(userId, {
  app_metadata: { role: "developer" },
});
if (error) throw error;
console.log(`Developer role granted to ${userId}.`);
