// =============================================================================
// Standard API response helpers
// All route handlers return these shapes so the frontend can rely on them.
// =============================================================================

import { NextResponse } from 'next/server';
import type { ZodIssue } from 'zod/v4';
import { AppError, isAppError } from './errors';

// ---------------------------------------------------------------------------
// Response envelope types
// ---------------------------------------------------------------------------

export interface ApiSuccess<T> {
  ok: true;
  data: T;
}

export interface ApiError {
  ok: false;
  error: {
    code: string;
    message: string;
    issues?: ZodIssue[];
  };
}

export type ApiResponse<T> = ApiSuccess<T> | ApiError;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function successResponse<T>(data: T, status = 200): NextResponse<ApiSuccess<T>> {
  return NextResponse.json({ ok: true, data }, { status });
}

export function errorResponse(
  code: string,
  message: string,
  status: number,
  issues?: ZodIssue[],
): NextResponse<ApiError> {
  return NextResponse.json(
    { ok: false, error: { code, message, ...(issues ? { issues } : {}) } },
    { status },
  );
}

/**
 * Central error handler for route handlers.
 * Converts AppError and unknown errors into consistent API responses.
 */
export function handleRouteError(err: unknown): NextResponse<ApiError> {
  if (isAppError(err)) {
    return errorResponse(err.code, err.message, err.statusCode);
  }

  // Supabase PostgREST errors arrive as plain objects
  if (typeof err === 'object' && err !== null && 'code' in err && 'message' in err) {
    const pgErr = err as { code: string; message: string };
    if (pgErr.code === '23505') {
      return errorResponse('CONFLICT', 'A record with these details already exists.', 409);
    }
    if (pgErr.code === '23503') {
      return errorResponse('VALIDATION_ERROR', 'Referenced record does not exist.', 400);
    }
    console.error('[DB]', pgErr);
    return errorResponse('DATABASE_ERROR', 'A database error occurred.', 500);
  }

  console.error('[Unhandled]', err);
  return errorResponse('INTERNAL_ERROR', 'An unexpected error occurred.', 500);
}
