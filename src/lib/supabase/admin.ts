// =============================================================================
// Supabase admin client — uses the service-role key.
// NEVER expose to the browser. Only import from route handlers / server code.
// Bypasses Row Level Security — use intentionally and sparingly.
//
// NOTE: We intentionally omit the <Database> generic here because the hand-
// written Database type in src/types/database.ts doesn't satisfy the strict
// GenericSchema constraints of @supabase/postgrest-js v2.99.x.  Once the
// project is connected to Supabase, replace this file's client with the
// generated types: `supabase gen types typescript --linked`.
// DB helpers in src/lib/db/ apply explicit TypeScript casts on query results.
// =============================================================================

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let adminClient: SupabaseClient | null = null;

export function createSupabaseAdminClient(): SupabaseClient {
  if (adminClient) return adminClient;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    throw new Error(
      'Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables.',
    );
  }

  adminClient = createClient(url, serviceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  return adminClient;
}
