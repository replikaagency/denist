import { type NextRequest } from 'next/server';
import { SignJWT } from 'jose';
import { z } from 'zod/v4';
import { successResponse, handleRouteError, errorResponse } from '@/lib/response';
import { findContactBySessionToken } from '@/lib/db/contacts';
import { checkRateLimit, getClientIp } from '@/lib/rate-limit';
import { SessionTokenSchema } from '@/lib/schemas/session';

const RealtimeTokenSchema = z.object({
  session_token: SessionTokenSchema,
});

const TOKEN_TTL_SEC = 3600; // 1 hour

/**
 * POST /api/chat/realtime-token
 *
 * Returns a short-lived JWT for Supabase Realtime auth. The JWT embeds the
 * session_token as a custom claim so RLS policies can verify the patient
 * owns the conversation before delivering postgres_changes events.
 *
 * Requires SUPABASE_JWT_SECRET (Project Settings > API > JWT Secret).
 */
export async function POST(request: NextRequest) {
  try {
    const secret = process.env.SUPABASE_JWT_SECRET;
    if (!secret) {
      return errorResponse(
        'CONFIG_ERROR',
        'Realtime token issuance is not configured. Set SUPABASE_JWT_SECRET.',
        503,
      );
    }

    const body = await request.json();
    const parsed = RealtimeTokenSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse('VALIDATION_ERROR', 'Invalid request body', 400, parsed.error.issues);
    }

    const ip = getClientIp(request);
    const ipLimit = checkRateLimit(`realtime-token-ip:${ip}`, 60, 60_000);
    if (!ipLimit.allowed) {
      return errorResponse('RATE_LIMITED', 'Too many requests from this address.', 429);
    }
    const tokenLimit = checkRateLimit(
      `realtime-token:${parsed.data.session_token}`,
      20,
      60_000,
    );
    if (!tokenLimit.allowed) {
      return errorResponse('RATE_LIMITED', 'Too many requests. Please wait a moment.', 429);
    }

    const contact = await findContactBySessionToken(parsed.data.session_token);
    if (!contact) {
      return errorResponse('NOT_FOUND', 'Invalid session.', 404);
    }

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    if (!url) {
      return errorResponse('CONFIG_ERROR', 'Missing NEXT_PUBLIC_SUPABASE_URL.', 503);
    }

    const iss = `${url.replace(/\/$/, '')}/auth/v1`;
    const now = Math.floor(Date.now() / 1000);
    const exp = now + TOKEN_TTL_SEC;

    const token = await new SignJWT({
      role: 'anon',
      session_token: parsed.data.session_token,
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(iss)
      .setAudience('anon')
      .setSubject(contact.id)
      .setIssuedAt(now)
      .setExpirationTime(exp)
      .sign(new TextEncoder().encode(secret));

    return successResponse({ token, expires_at: exp }, 200);
  } catch (err) {
    return handleRouteError(err);
  }
}
