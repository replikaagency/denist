import { type NextRequest, NextResponse } from 'next/server';

export async function middleware(request: NextRequest) {
  return NextResponse.next();
}

export const config = {
  matcher: [
    // Match all routes except static files and API routes that handle their own auth
    '/((?!_next/static|_next/image|favicon.ico|api/chat).*)',
  ],
};
