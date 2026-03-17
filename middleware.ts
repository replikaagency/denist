import { type NextRequest, NextResponse } from 'next/server';
import { updateSession } from '@/lib/supabase/middleware';

export async function middleware(request: NextRequest) {
  // Always refresh the Supabase auth session
  const response = await updateSession(request);

  const { pathname } = request.nextUrl;

  // Protect /dashboard routes — redirect to /login if no session
  if (pathname.startsWith('/dashboard')) {
    const supabaseCookie = request.cookies.getAll().find(
      (c) => c.name.startsWith('sb-') && c.name.endsWith('-auth-token'),
    );

    // If no auth cookie at all, redirect immediately
    // The actual auth check happens server-side; this is a fast pre-check
    if (!supabaseCookie) {
      const loginUrl = new URL('/login', request.url);
      loginUrl.searchParams.set('redirect', pathname);
      return NextResponse.redirect(loginUrl);
    }
  }

  return response;
}

export const config = {
  matcher: [
    // Match all routes except static files and API routes that handle their own auth
    '/((?!_next/static|_next/image|favicon.ico|api/chat).*)',
  ],
};
