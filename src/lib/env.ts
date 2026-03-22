// =============================================================================
// Fail-fast validation for production / Vercel deploys.
// Local `next dev` skips unless NODE_ENV=production (e.g. next build).
// Set SKIP_ENV_VALIDATION=1 to bypass checks (e.g. CI smoke without secrets).
// =============================================================================

const REQUIRED: readonly string[] = [
  'OPENAI_API_KEY',
  'SUPABASE_JWT_SECRET',
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
] as const;

function shouldValidate(): boolean {
  if (process.env.SKIP_ENV_VALIDATION === '1') return false;
  if (process.env.VERCEL === '1') return true;
  if (process.env.NODE_ENV === 'production') return true;
  return false;
}

/**
 * Throws if any required variable is missing or blank. Call from instrumentation
 * so misconfigured deploys fail at startup instead of at first request.
 */
export function assertServerEnv(): void {
  if (!shouldValidate()) return;

  const missing = REQUIRED.filter((key) => !process.env[key]?.trim());
  if (missing.length === 0) return;

  throw new Error(
    `[env] Missing required environment variables: ${missing.join(', ')}. ` +
      'See .env.example. Set SKIP_ENV_VALIDATION=1 only for local exceptions.',
  );
}
