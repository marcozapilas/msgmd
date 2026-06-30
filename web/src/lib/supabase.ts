import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  // Fail loudly during development rather than producing confusing auth errors.
  throw new Error(
    "Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. Copy web/.env.example to web/.env.local and fill them in.",
  );
}

export const supabase = createClient(url, anonKey, {
  auth: { persistSession: true, autoRefreshToken: true },
});

export const MSG_BUCKET = "msg-uploads";
export const MD_BUCKET = "md-outputs";

// Name of the deployed Edge Function. Supabase's dashboard auto-generated the
// name "clever-worker" instead of "convert-msg", so we match it here. Override
// via VITE_CONVERT_FUNCTION if you deploy it under a different name.
export const CONVERT_FUNCTION =
  import.meta.env.VITE_CONVERT_FUNCTION || "clever-worker";
