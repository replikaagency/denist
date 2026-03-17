// =============================================================================
// Simple in-memory rate limiter — suitable for single-process development.
//
// PRODUCTION WARNING: Vercel runs many isolated serverless instances. Each
// instance has its own Map, so limits are enforced per-instance, not globally.
// A determined client can exceed the intended limits by hitting different
// instances. For true global rate limiting, replace this with an Upstash Redis
// adapter (e.g. @upstash/ratelimit) and set UPSTASH_REDIS_REST_URL +
// UPSTASH_REDIS_REST_TOKEN in your Vercel environment.
// =============================================================================

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateLimitEntry>();

// Clean up expired entries periodically to prevent memory leaks
const CLEANUP_INTERVAL_MS = 60_000;
let lastCleanup = Date.now();

function cleanup() {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;

  for (const [key, entry] of store) {
    if (now > entry.resetAt) {
      store.delete(key);
    }
  }
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

/**
 * Check and consume a rate limit token.
 *
 * @param key Unique identifier (e.g. IP address, session token)
 * @param maxRequests Maximum number of requests in the window
 * @param windowMs Window duration in milliseconds
 */
/**
 * Extract the best available IP address from a Next.js request.
 * Vercel sets x-forwarded-for; falls back to a constant so the limiter
 * degrades gracefully rather than throwing when the header is absent.
 */
export function getClientIp(request: { headers: { get(name: string): string | null } }): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  const realIp = request.headers.get('x-real-ip');
  if (realIp) return realIp.trim();
  return 'unknown';
}

export function checkRateLimit(
  key: string,
  maxRequests: number,
  windowMs: number,
): RateLimitResult {
  cleanup();

  const now = Date.now();
  const entry = store.get(key);

  if (!entry || now > entry.resetAt) {
    // Start a new window
    store.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: maxRequests - 1, resetAt: now + windowMs };
  }

  if (entry.count >= maxRequests) {
    return { allowed: false, remaining: 0, resetAt: entry.resetAt };
  }

  entry.count++;
  return { allowed: true, remaining: maxRequests - entry.count, resetAt: entry.resetAt };
}
