import { type NextRequest, NextResponse } from 'next/server';
import { updateSession } from '@/lib/supabase/middleware';

export async function middleware(request: NextRequest) {
  // Refresh the Supabase auth session and get the current user in one call.
  // updateSession returns { response, user } so we can gate /dashboard here
  // without an extra round-trip, and without relying on cookie-name heuristics
  // that break when the session is silently refreshed mid-flight.
  const { response, user } = await updateSession(request);

  const { pathname } = request.nextUrl;

  if (pathname.startsWith('/dashboard') && !user) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('redirect', pathname);
    return NextResponse.redirect(loginUrl);
  }

  return response;
}

export const config = {
  matcher: [
    // Match all routes except static files and API routes that handle their own auth
    '/((?!_next/static|_next/image|favicon.ico|api/chat).*)',
  ],
};
